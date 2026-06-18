"""
Full clip generation pipeline for a single YouTube video.

Efficient two-pass download strategy:
  Pass 1 — Audio only (~40MB): transcribe with faster-whisper, save transcript to disk
  Pass 2 — Per-clip sections only (~15MB each): download just the 30-90s needed per clip

Steps:
  1. Download audio only
  2. Transcribe locally with faster-whisper
  3. Claude reads transcript and picks 10-12 viral clip moments (with timestamps)
  4. For each clip: download just that section at 720p → crop 9:16 → burn subtitles → upload → queue
  5. Mark video as processed

Usage:
  python scripts/process_video.py --video_id VIDEO_ID --url URL --title "Title"
"""

import os
import sys
import json
import time
import argparse
import subprocess
import tempfile
import shutil
from pathlib import Path

import requests
from dotenv import load_dotenv
from supabase import create_client
from faster_whisper import WhisperModel
import anthropic

load_dotenv(override=True)

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
CHANNEL_ID = os.environ["CHANNEL_ID"]

WHISPER_MODEL = "medium"

LOGO_PATH = str(Path(__file__).parent.parent / "logo.png")


# ── Helpers ────────────────────────────────────────────────────────────────────

def to_hhmmss(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


# ── Download ───────────────────────────────────────────────────────────────────

def _ydl_auth_args():
    args = []
    proxy = os.environ.get("YTDLP_PROXY")
    if proxy:
        args += ["--proxy", proxy]
    cookies = os.environ.get("YOUTUBE_COOKIES_FILE")
    if cookies and os.path.exists(cookies):
        args += ["--cookies", cookies]
    return args


def download_audio_only(url, output_dir):
    """Download just the audio stream — ~40MB for a 40-min podcast."""
    output_path = os.path.join(output_dir, "audio.%(ext)s")
    subprocess.run(
        [
            "yt-dlp",
            "-f", "bestaudio[ext=m4a]/bestaudio/best",
            "--no-playlist",
            "--extractor-args", "youtube:player_client=mweb",
            *_ydl_auth_args(),
            "-o", output_path,
            url,
        ],
        check=True,
    )
    matches = list(Path(output_dir).glob("audio.*"))
    if not matches:
        raise RuntimeError("yt-dlp audio download produced no output file")
    return str(matches[0])


def download_full_video(url, output_path):
    """
    Download the full video at the best available quality up to 1080p.
    Uses DASH (video+audio merged) when running locally — 1080p DASH is only
    blocked from datacenter/GitHub Actions IPs, not from a local machine.
    Falls back to 720p then 360p progressive if DASH is unavailable.
    """
    # 720p source is sufficient — ffmpeg scales up to 1080x1920 output.
    # Keeps download ~200MB vs 500MB+ for 1080p on long podcasts.
    format_str = (
        "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]"
        "/bestvideo[height<=720]+bestaudio"
        "/22/18"
    )
    cmd = [
        "yt-dlp",
        "-f", format_str,
        "--merge-output-format", "mp4",
        "--no-playlist",
        "--socket-timeout", "60",
        "--retries", "10",
        "--fragment-retries", "10",
        "--http-chunk-size", "10M",
        "--extractor-args", "youtube:player_client=web",
        "--js-runtimes", "node",
        *_ydl_auth_args(),
        "-o", output_path,
        url,
    ]
    for attempt in range(3):
        if os.path.exists(output_path):
            os.remove(output_path)
        try:
            subprocess.run(cmd, check=True)
        except subprocess.CalledProcessError:
            if attempt == 2:
                raise
            print(f"    Video download attempt {attempt + 1} failed, retrying in 30s...")
            time.sleep(30)
            continue
        if not os.path.exists(output_path) or os.path.getsize(output_path) < 100_000:
            if attempt == 2:
                raise RuntimeError(f"Full video download produced no usable file: {output_path}")
            time.sleep(30)
            continue
        break


# ── Transcription ──────────────────────────────────────────────────────────────

def transcribe(audio_path):
    """Transcribe audio locally with faster-whisper. Returns (segments, words) with word-level timestamps."""
    print(f"  Loading Whisper {WHISPER_MODEL} model...")
    model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    print("  Transcribing (takes a few minutes for long audio)...")
    raw_segments, info = model.transcribe(audio_path, beam_size=5, word_timestamps=True)
    segments = []
    words = []
    for s in raw_segments:
        segments.append({"start": s.start, "end": s.end, "text": s.text.strip()})
        if s.words:
            for w in s.words:
                words.append({"start": w.start, "end": w.end, "word": w.word})
    print(f"  Language: {info.language} ({info.language_probability:.0%} confidence)")
    return segments, words


# ── Claude clip selection ──────────────────────────────────────────────────────

def _classify_hook_type(hook: str) -> str:
    """Classify a hook into a type using simple heuristics (no API call)."""
    h = hook.lower().strip()
    if h.endswith("?"):
        return "question"
    if any(c in h for c in ["$", "¢", "£", "€", "%"]) or any(
        w in h for w in ["million", "thousand", "cedis", "dollars", "percent", "years", "months"]
    ):
        return "stat"
    if any(w in h for w in ["i was wrong", "i failed", "i lied", "i never", "i lost", "i made a mistake", "i regret"]):
        return "confession"
    if any(w in h for w in ["when i was", "the day i", "one day", "back when", "growing up", "i remember when"]):
        return "story"
    if any(w in h for w in ["stop ", "never ", "don't ", "you should", "you must", "the truth is", "nobody tells"]):
        return "advice"
    if any(w in h for w in ["god", "church", "jesus", "bible", "pastor", "prayer", "faith", "christian"]):
        return "controversy"
    if h.startswith("i ") or h.startswith("i'"):
        return "provocative"
    return "statement"


def _classify_topic(hook: str) -> str:
    """Classify a clip's topic from its hook using keyword matching."""
    h = hook.lower()
    if any(w in h for w in ["money", "rich", "broke", "income", "salary", "paid", "cedis", "invest", "wealth", "profit", "revenue", "afford"]):
        return "money"
    if any(w in h for w in ["business", "entrepreneur", "startup", "company", "brand", "client", "customer", "market", "product", "sell"]):
        return "business"
    if any(w in h for w in ["married", "wife", "husband", "relationship", "love", "date", "family", "children", "divorce", "partner"]):
        return "relationships"
    if any(w in h for w in ["god", "church", "jesus", "pray", "pastor", "faith", "christian", "gospel", "worship"]):
        return "faith"
    if any(w in h for w in ["school", "university", "degree", "education", "student", "teacher", "learn"]):
        return "education"
    if any(w in h for w in ["africa", "ghana", "nigerian", "kenyan", "continent", "accra", "lagos"]):
        return "africa"
    if any(w in h for w in ["discipline", "motivation", "success", "failure", "hustle", "grind", "mindset", "habit", "goal"]):
        return "mindset"
    return "personal"


def _extract_clip_transcript(segments: list, start_s: float, end_s: float) -> str:
    """Return the spoken text for transcript segments overlapping [start_s, end_s]."""
    parts = []
    for seg in segments:
        if seg.get("end", 0) > start_s and seg.get("start", 0) < end_s:
            parts.append(seg["text"].strip())
    return " ".join(parts)[:1200]


def _log_clip_selections(supabase, video_id: str, clips: list, segments: list | None = None) -> None:
    """Log clip selections with hook type, topic, and transcript text for content learning."""
    try:
        rows = []
        for i, clip in enumerate(clips):
            hook     = clip.get("hook", "")
            start_s  = clip.get("start_seconds") or 0
            end_s    = clip.get("end_seconds") or 0
            duration = round(end_s - start_s) if end_s > start_s else None
            transcript = _extract_clip_transcript(segments, start_s, end_s) if segments else None
            rows.append({
                "video_id":         video_id,
                "clip_index":       i,
                "hook":             hook[:200],
                "duration_seconds": duration,
                "hook_type":        _classify_hook_type(hook),
                "topic_category":   _classify_topic(hook),
                "clip_transcript":  transcript,
            })
        try:
            supabase.table("clip_selection_log").upsert(rows, on_conflict="video_id,clip_index").execute()
            print(f"  [Memory] Logged {len(rows)} clip selections (with transcripts).")
        except Exception:
            # clip_transcript column may not exist yet — retry without it
            rows_basic = [{k: v for k, v in r.items() if k != "clip_transcript"} for r in rows]
            supabase.table("clip_selection_log").upsert(rows_basic, on_conflict="video_id,clip_index").execute()
            print(f"  [Memory] Logged {len(rows)} clips (add clip_transcript TEXT column to enable content analysis).")
    except Exception as e:
        print(f"  [Memory] Could not log selections: {e}")


def _load_channel_intelligence(supabase) -> str:
    """Load the latest performance intelligence brief from Supabase, if available."""
    try:
        row = supabase.table("channel_intelligence").select("summary,stats").eq("id", "singleton").maybe_single().execute()
        if row.data and row.data.get("summary"):
            stats = row.data.get("stats") or {}
            header = (
                f"(Based on {stats.get('clips_analysed', '?')} clips — "
                f"{stats.get('total_views', '?')} total views — "
                f"updated {stats.get('generated_at', '?')[:10]})"
            )
            return f"{header}\n\n{row.data['summary']}"
    except Exception:
        pass
    return ""


def select_clips(anthropic_client, segments, video_title, supabase=None):
    """Ask Claude to pick 10-12 viral moments from the transcript."""
    lines = []
    for seg in segments:
        sm, ss = int(seg["start"] // 60), int(seg["start"] % 60)
        em, es = int(seg["end"] // 60), int(seg["end"] % 60)
        lines.append(f"[{sm:02d}:{ss:02d}-{em:02d}:{es:02d}] {seg['text']}")

    transcript_text = "\n".join(lines)
    if len(transcript_text) > 40000:
        transcript_text = transcript_text[:40000] + "\n...[truncated]"

    intelligence = _load_channel_intelligence(supabase) if supabase else ""
    intelligence_block = ""
    if intelligence:
        intelligence_block = f"""
━━━ CHANNEL PERFORMANCE INTELLIGENCE ━━━

This is real data from clips already posted on this channel. Use it to inform every decision you make below — hook style, topic selection, clip length, and platform captions.

{intelligence}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

"""
        print("  [Intelligence] Loaded channel performance brief into prompt.")
    else:
        print("  [Intelligence] No brief available yet -- using base rules only.")

    prompt = f"""You are an expert viral short-form content strategist who deeply understands what makes people stop scrolling and watch a video clip all the way through to completion.

Your job: analyze the provided timestamped podcast transcript and identify the 10 to 12 best, most high-impact moments to clip for Instagram Reels, TikTok, YouTube Shorts, and Facebook Reels.{intelligence_block}

Video title: {video_title}

Transcript (with timestamps):
Each line shows [MM:SS-MM:SS] start-end time for that segment, followed by the spoken text.
{transcript_text}

━━━ CLIP SELECTION RULES ━━━

1. CHRONOLOGICAL SYSTEMATIC REVIEW — Read through the entire transcript from start to finish. Do not ignore the middle sections. Distribute your selections evenly across the entire runtime. Do not cluster clips in a single high-energy segment. IMPORTANT: The opening 2–3 minutes of a podcast is typically an intro montage — rapid jump cuts between unrelated moments designed to tease the full episode. These make no sense as standalone clips. Use your judgment to identify and skip this intro section; look for where the hosts settle into the actual conversation (usually when they introduce themselves or the guest properly) and start your selections from there.

2. TARGET LENGTH — Target 45 to 65 seconds per clip. This is the proven sweet spot for completion rate across all 4 platforms. Never go below 30 seconds or above 90 seconds. Tighter is better. The clip must start precisely on the opening word of the hook and end the moment the idea concludes — do not trail off into the next topic or filler.

3. THE SCROLL-STOP TEST — Before selecting any clip, apply this test to its opening sentence: imagine someone in a noisy room, half-watching their phone, thumb already moving to swipe. Would they freeze on THIS specific sentence? If the answer is anything less than "yes, immediately" — reject it and find a better moment. Generic wisdom fails this test. Setup sentences fail this test. Anything that needs context to land fails this test.

  A hook that passes the test is one of these:
  • A specific number or amount that surprises ("She lost 300,000 cedis in one month")
  • A direct personal confession or failure ("I almost destroyed my own company doing this")
  • A statement that makes the audience choose a side ("Most African entrepreneurs will never scale and it is their own fault")
  • A counter-intuitive reversal of something everyone believes ("Working harder is exactly what keeps you broke")
  • A story opening with immediate tension ("The day I fired my best friend was the day the business started growing")
  • A question with an answer the viewer desperately wants ("Why do the most disciplined people still fail?")

  AUTOMATIC REJECTION — Never start a clip on:
  • Filler words: "So...", "Um...", "You know...", "Like I said...", "Basically..."
  • Slow context: "Today we're going to talk about...", "I want to tell you something about..."
  • Generic advice that could apply to anyone: "You need to believe in yourself", "Hard work pays off"
  • A mid-thought that requires the previous sentence to make sense
  • A compliment or pleasantry: "That's a great question", "Absolutely, I agree"

4. THE STRONG ENDING TEST — A clip is only as good as its ending. Before finalising any clip, apply this test to its closing moment: would a viewer who just finished watching feel satisfied, provoked, or compelled to rewatch?

  A strong ending is one of these:
  • A punchline or twist as a final statement — the idea lands and then stops
  • A direct challenge to the audience ("That is the truth and you know it")
  • A specific result revealed at the end ("...and we made 40,000 cedis that month")
  • A counter-intuitive conclusion that closes the thought completely
  • A quiet moment of silence after a hard truth — the clip ends right before the next breath

  A weak ending sounds like:
  • Trailing off: "...you know, it just kind of... yeah"
  • Bleeding into the next topic: "Anyway, what I was going to say about that is..."
  • Over-explaining: "...what I mean is basically what I was trying to say is..."
  • An incomplete sentence or half-finished thought

  Your end_seconds MUST land on the last word of the strong closing beat. Cut immediately after. Do not let the clip run into the next sentence or the speaker's next breath.

5. CONTENT COHESION — Each clip must contain ONE complete self-contained idea with a 3-part arc:
  • HOOK (0-5s): The opening line creates tension, curiosity, or surprise in the viewer's mind
  • DEVELOPMENT (middle): The speaker builds the idea — adds a specific detail, tells the story, or explains the stakes
  • PAYOFF (final 5-10s): The clip ends on a clear answer, revelation, punchline, or strong closing statement

  A clip missing the Payoff will not be rewatched or shared no matter how strong the hook is. Reject any clip where the idea is not fully resolved within the selected time range.

  Also prioritise moments that are:
  • A specific number, amount, or statistic that reveals something surprising
  • A personal failure, mistake, or lesson the speaker learned the hard way
  • A take that the Konnected Minds audience (Ghana/Africa, entrepreneurship, business, faith, ambition) will passionately agree or disagree with
  • A revelation that reframes how the audience thinks about something they already believe

6. ALGORITHM SIGNALS — Pick moments that will drive measurable actions:
  • Comments: the audience needs to argue about it, share their own story, or tag someone
  • Shares: the clip must feel like "I need to send this to someone right now"
  • Saves: practical insight or a hard truth people want to return to
  • Replays: a punchline, a stat, or a twist delivered so well they want to hear it again

7. TIMESTAMP CONVERSION — Each transcript line shows [MM:SS-MM:SS] format. Convert the start time of your chosen clip to raw integer seconds for start_seconds, and the end time to raw integer seconds for end_seconds. Example: a clip starting at 02:05 and ending at 03:07 becomes start_seconds: 125, end_seconds: 187.

━━━ CAPTION RULES ━━━

NEVER use em dashes (—) anywhere in any caption. Use a comma, a full stop, or rewrite the sentence instead.

Write platform-specific captions for each clip. They must sound like a real person wrote them, not a brand or marketing team. Avoid hype words like "game-changer", "powerful", "incredible". Write like you are texting a friend about something that genuinely surprised you.

instagram: 2–3 short sentences. Expand on the hook and make them want to watch. End with 5–8 relevant hashtags on a new line. Tone: direct and real, like a sharp comment not an ad.

tiktok: 1–2 very casual sentences. Sounds like someone who just watched this and had to share it. 3–5 hashtags max. Tone: off the cuff, human, slightly opinionated.

youtube: A standalone title that works as a YouTube Shorts title (max 80 characters). Create curiosity or promise a specific payoff. No hashtags. Capitalise like a headline but keep it plain spoken.

facebook: 2–3 sentences for a slightly older audience. More context, less hype. Write like you are sharing something interesting you came across. No hashtags.

━━━ OUTPUT FORMAT ━━━

CRITICAL: Output ONLY the raw JSON array. Do not include any introductory sentences, conversational text, markdown code fences, or concluding remarks. The response must start with [ and end with ] and be 100% pure parseable JSON.

[
  {{
    "start_seconds": 125,
    "end_seconds": 187,
    "hook": "The exact first sentence spoken that opens this clip",
    "captions": {{
      "instagram": "Caption text here.\\n\\n#hashtag1 #hashtag2 #hashtag3 #hashtag4 #hashtag5",
      "tiktok": "casual caption here #hashtag1 #hashtag2 #hashtag3",
      "youtube": "YouTube Shorts Title That Creates Curiosity",
      "facebook": "Facebook caption here that gives a bit more context."
    }}
  }}
]"""

    raw = ""
    for attempt in range(4):
        try:
            # Stream the response -- keeps connection alive on large prompts
            with anthropic_client.messages.stream(
                model="claude-sonnet-4-6",
                max_tokens=6000,
                messages=[{"role": "user", "content": prompt}],
            ) as stream:
                raw = stream.get_final_text()
            break
        except Exception as e:
            if attempt == 3:
                raise
            wait = 15 * (attempt + 1)
            print(f"  Claude API attempt {attempt + 1} failed ({e}), retrying in {wait}s...")
            import time; time.sleep(wait)

    raw = raw.strip()
    # Robust extraction: find the outermost JSON array regardless of any surrounding text
    start_idx = raw.find("[")
    end_idx = raw.rfind("]")
    if start_idx != -1 and end_idx != -1:
        raw = raw[start_idx:end_idx + 1]

    clips = json.loads(raw)
    valid = []
    for c in clips:
        duration = c["end_seconds"] - c["start_seconds"]
        if not (28 <= duration <= 95):
            continue
        if "caption" in c and "captions" not in c:
            c["captions"] = {p: c["caption"] for p in ["instagram", "tiktok", "youtube", "facebook"]}
        valid.append(c)
    return valid


# ── Video processing ───────────────────────────────────────────────────────────

def _compute_speaker_crop_path(video_path: str, start_s: float, duration: float, fps: float) -> list:
    """
    Compute a per-frame (x, y, crop_w, crop_h) path tracking the dominant speaker.

    Design:
    - Tight 9:16 crop: full source height, horizontal tracking only.
      For a 720p (1280x720) source this is 405x720 -- shows face + upper body,
      fills 1080x1920 with no wasted bars.
    - MediaPipe face detection every DETECT_EVERY output frames (~10fps at 30fps).
    - Linear interpolation between detections for sub-detection-interval smoothness.
    - EMA smoothing (alpha=0.08) makes the crop move like a deliberate camera
      operator, not an AI twitching every second.
    - Hard velocity cap (1.5% of frame width per frame) prevents jarring pans.
    - Haar cascade fallback if MediaPipe is unavailable.
    - Pixel-variance side fallback if zero faces are ever detected (B-roll, graphics).
    - All errors fall back silently to a static center crop -- never raises.
    """
    import cv2
    import numpy as np

    n_frames = max(1, int(round(duration * fps)))

    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise RuntimeError("Cannot open video")

        src_fps = cap.get(cv2.CAP_PROP_FPS) or fps
        frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        # 9:16 portrait crop -- full source height, partial width
        crop_h = frame_h
        crop_w = int(round(frame_h * 9 / 16))
        if crop_w > frame_w:          # ultra-wide or portrait source
            crop_w = frame_w
            crop_h = int(round(frame_w * 16 / 9))
        max_x = frame_w - crop_w
        y     = (frame_h - crop_h) // 2   # 0 for standard 16:9 sources

        # MediaPipe setup
        mp_detector = None
        try:
            import mediapipe as mp
            mp_detector = mp.solutions.face_detection.FaceDetection(
                model_selection=1,             # full-range model, handles far faces
                min_detection_confidence=0.25,
            )
        except Exception:
            pass

        # Haar cascade fallback setup (only when MediaPipe unavailable)
        haar_cascades = []
        if mp_detector is None:
            for xml in ["haarcascade_frontalface_default.xml",
                        "haarcascade_frontalface_alt2.xml"]:
                try:
                    c = cv2.CascadeClassifier(cv2.data.haarcascades + xml)
                    if not c.empty():
                        haar_cascades.append(c)
                except Exception:
                    pass

        # Detect every DETECT_EVERY output frames (~10fps at 30fps source)
        DETECT_EVERY = 3
        start_frame  = int(round(start_s * src_fps))
        detections   = {}   # output_frame_idx -> cx (face center x, source pixels)
        frames_for_variance = []

        for out_fi in range(0, n_frames, DETECT_EVERY):
            # Map output frame index to source frame (accounts for fps mismatch)
            src_fi = int(round(out_fi * src_fps / fps))
            cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame + src_fi)
            ret, frame = cap.read()
            if not ret:
                break

            frames_for_variance.append(frame)
            cx_best = None

            if mp_detector is not None:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                res = mp_detector.process(rgb)
                if res.detections:
                    # Dominant face: highest confidence x relative area product
                    best_score = -1.0
                    for det in res.detections:
                        bb    = det.location_data.relative_bounding_box
                        score = det.score[0] * bb.width * bb.height
                        if score > best_score:
                            best_score = score
                            cx_best    = int((bb.xmin + bb.width * 0.5) * frame_w)
            else:
                gray   = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                min_sz = max(30, frame_w // 15)
                for cascade in haar_cascades:
                    faces = cascade.detectMultiScale(gray, 1.1, 3,
                                                     minSize=(min_sz, min_sz))
                    if len(faces):
                        fx, fy, fw, fh = max(faces, key=lambda f: f[2] * f[3])
                        cx_best = fx + fw // 2
                        break

            if cx_best is not None:
                detections[out_fi] = cx_best

        if mp_detector:
            try:
                mp_detector.close()
            except Exception:
                pass
        cap.release()

        n_windows = max(1, n_frames // DETECT_EVERY)
        print(f"  [FaceTrack] {len(detections)}/{n_windows} windows have faces  "
              f"(crop {crop_w}x{crop_h} from {frame_w}x{frame_h})")

        # ── Cluster to dominant speaker ───────────────────────────────────────
        # In a two-person podcast MediaPipe alternates between left and right faces.
        # Split detections by which horizontal half they land in, pick the majority.
        # This locks the crop to ONE speaker for the whole clip.
        raw_cx = np.full(n_frames, float(frame_w // 2), dtype=np.float64)

        if detections:
            mid        = frame_w / 2
            left_dets  = {fi: cx for fi, cx in detections.items() if cx <  mid}
            right_dets = {fi: cx for fi, cx in detections.items() if cx >= mid}
            primary    = left_dets if len(left_dets) >= len(right_dets) else right_dets
            dom_side   = "left"    if len(left_dets) >= len(right_dets) else "right"
            print(f"  [FaceTrack] dominant speaker: {dom_side}  "
                  f"({len(primary)}/{len(detections)} detections kept)")

            if primary:
                # Forward-fill: hold each detection until the next one.
                # Never interpolate across a gap -- that would pan the camera.
                keys      = sorted(primary.keys())
                last_cx   = float(primary[keys[0]])
                det_map   = {fi: float(primary[fi]) for fi in keys}
                for f in range(n_frames):
                    if f in det_map:
                        last_cx = det_map[f]
                    raw_cx[f] = last_cx
                raw_cx[: keys[0]] = float(primary[keys[0]])

        elif frames_for_variance:
            # Zero face detections -- pixel-variance picks left vs right speaker
            third     = frame_w // 3
            left_var  = float(np.var(np.array(
                [f[:, :third] for f in frames_for_variance], dtype=np.float32)))
            right_var = float(np.var(np.array(
                [f[:, 2 * third:] for f in frames_for_variance], dtype=np.float32)))
            dom_cx    = third // 2 if left_var > right_var else 2 * third + third // 2
            raw_cx[:] = float(dom_cx)
            print(f"  [FaceTrack] no faces -- variance fallback -> "
                  f"{'left' if left_var > right_var else 'right'} side (cx={dom_cx})")

        # ── EMA smoothing: alpha=0.04 ~ 25-frame lag ──────────────────────────
        # Low alpha = locked/stable feel for static podcast shots.
        # The crop barely moves; only follows large, sustained head shifts.
        ALPHA     = 0.04
        smooth    = np.empty(n_frames, dtype=np.float64)
        smooth[0] = raw_cx[0]
        for f in range(1, n_frames):
            smooth[f] = ALPHA * raw_cx[f] + (1.0 - ALPHA) * smooth[f - 1]

        # ── Velocity cap: max 0.4% of frame width per frame ───────────────────
        # ~5px per frame at 1280px wide = very gentle drift, never a pan.
        max_vel = frame_w * 0.004
        for f in range(1, n_frames):
            delta = smooth[f] - smooth[f - 1]
            if abs(delta) > max_vel:
                smooth[f] = smooth[f - 1] + (max_vel if delta > 0 else -max_vel)

        # Convert smoothed center-x to crop boxes
        result = []
        for cx in smooth:
            x = int(round(float(cx))) - crop_w // 2
            x = max(0, min(x, max_x))
            result.append((x, y, crop_w, crop_h))
        return result

    except Exception as e:
        print(f"  [FaceTrack] error: {e} -- center-crop fallback")
        try:
            import cv2 as _cv2
            _cap = _cv2.VideoCapture(video_path)
            fw   = int(_cap.get(_cv2.CAP_PROP_FRAME_WIDTH))
            fh   = int(_cap.get(_cv2.CAP_PROP_FRAME_HEIGHT))
            _cap.release()
        except Exception:
            fw, fh = 1280, 720
        ch = fh
        cw = min(int(round(fh * 9 / 16)), fw)
        if cw == fw:
            ch = int(round(fw * 16 / 9))
        x = (fw - cw) // 2
        y = (fh - ch) // 2
        return [(x, y, cw, ch)] * n_frames


def cut_and_subtitle(section_path, offset_seconds, duration, words, output_path, clip_idx, tmpdir, chunk_size=3, hook=""):
    """
    Render a single clip with blur-background 9:16 framing.

    Pipeline:
      1. Extract raw frames from source via ffmpeg
      2. Per frame: scale source to cover 1080x1920 + blur (background),
         scale source to fit width (foreground), center fg on blurred bg
      3. Overlay logo and karaoke subtitles
      4. Encode frames + audio in a single pass
    """
    from PIL import Image, ImageDraw, ImageFont, ImageFilter

    W, H = 1080, 1920

    # Probe source FPS
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=avg_frame_rate", "-of", "csv=p=0", section_path],
        capture_output=True, text=True,
    )
    try:
        num, den = probe.stdout.strip().split("/")
        fps = float(num) / float(den)
    except Exception:
        fps = 30.0

    # Audio: cut low rumble, boost voice presence, normalise to -14 LUFS
    audio_filter = (
        "highpass=f=80,"
        "equalizer=f=300:width_type=o:width=1:g=-3,"
        "equalizer=f=3000:width_type=o:width=1.5:g=3,"
        "loudnorm=I=-14:TP=-1:LRA=11"
    )

    # ── 1. Extract raw frames ────────────────────────────────────────────────
    frames_dir = os.path.join(tmpdir, f"frames_{clip_idx}")
    os.makedirs(frames_dir, exist_ok=True)
    subprocess.run([
        "ffmpeg",
        "-ss", str(offset_seconds), "-i", section_path,
        "-t", str(duration),
        os.path.join(frames_dir, "frame_%06d.png"), "-y",
    ], check=True, capture_output=True)

    # ── 3. Pre-render subtitle images ────────────────────────────────────────
    subtitle_data = []   # list of (start_sec, end_sec, PIL Image, x, y)
    if words:
        base_font_size = max(52, H // 16)
        font_candidates = [
            "/Library/Fonts/SF-Pro-Display-Bold.otf",
            "/Library/Fonts/SF-Pro.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
            "/System/Library/Fonts/SFNS.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        ]
        font_path = next((p for p in font_candidates if os.path.exists(p)), None)

        tmp_draw   = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
        max_text_w = int(W * 0.82)
        pad_h, pad_v, radius = 22, 14, 10
        text_color = (15, 15, 15, 255)
        box_color  = (255, 255, 255, 235)
        max_sub_h  = base_font_size + 2 * pad_v
        sub_y      = int(H * 0.65) - max_sub_h

        for ci in range(0, len(words), chunk_size):
            chunk = words[ci:ci + chunk_size]
            if not chunk:
                continue

            chunk_texts = [wd["word"].strip() for wd in chunk]
            if chunk_texts:
                chunk_texts[0] = chunk_texts[0][:1].upper() + chunk_texts[0][1:]
            full_text = " ".join(chunk_texts)

            # Find the largest font size that fits the full chunk text
            size = base_font_size
            font = None
            while size >= 28:
                try:
                    font = ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default()
                except Exception:
                    font = ImageFont.load_default()
                bb = tmp_draw.textbbox((0, 0), full_text, font=font)
                if bb[2] - bb[0] <= max_text_w:
                    break
                size -= 4
            if font is None:
                font = ImageFont.load_default()

            bb     = tmp_draw.textbbox((0, 0), full_text, font=font)
            text_w = bb[2] - bb[0]
            text_h = bb[3] - bb[1]
            img_w  = text_w + 2 * pad_h
            img_h  = text_h + 2 * pad_v
            x_pos  = max(10, (W - img_w) // 2)

            # One subtitle image per word -- same white box, advances word by word
            for word in chunk:
                img  = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
                draw = ImageDraw.Draw(img)
                draw.rounded_rectangle([(0, 0), (img_w - 1, img_h - 1)],
                                       radius=radius, fill=box_color)
                draw.text((pad_h, pad_v - bb[1]), full_text, font=font, fill=text_color)
                subtitle_data.append((word["start"], word["end"], img, x_pos, sub_y))

    # ── 4. Load logo ──────────────────────────────────────────────────────────
    logo_img = None
    logo_w   = max(160, W // 4)
    try:
        logo_img = Image.open(LOGO_PATH).convert("RGBA")
        lh       = int(logo_img.height * logo_w / logo_img.width)
        logo_img = logo_img.resize((logo_w, lh), Image.LANCZOS)
    except Exception:
        pass

    # ── 5. Process each frame: blur-bg composite -> overlays ─────────────────
    frame_files = sorted(f for f in os.listdir(frames_dir) if f.endswith(".png"))
    for fi, fname in enumerate(frame_files):
        fp        = os.path.join(frames_dir, fname)
        frame_img = Image.open(fp).convert("RGB")
        fw, fh    = frame_img.size

        # Blurred background: scale to cover full 1080x1920 canvas, then blur
        bg_scale = max(W / fw, H / fh)
        bg = frame_img.resize((int(fw * bg_scale), int(fh * bg_scale)), Image.LANCZOS)
        bw, bh = bg.size
        bg = bg.crop(((bw - W) // 2, (bh - H) // 2, (bw - W) // 2 + W, (bh - H) // 2 + H))
        bg = bg.filter(ImageFilter.GaussianBlur(radius=25))

        # Foreground: scale to fill 50% of canvas height, center-crop to canvas width
        # Bars become ~25% each (down from ~34% with fit-width)
        fg_h = H // 2
        fg_w = int(fw * fg_h / fh)
        fg   = frame_img.resize((fg_w, fg_h), Image.LANCZOS)
        if fg_w > W:
            cx = (fg_w - W) // 2
            fg = fg.crop((cx, 0, cx + W, fg_h))
        fg = fg.filter(ImageFilter.UnsharpMask(radius=1.5, percent=80, threshold=3))

        # Center fg vertically on the blurred bg
        paste_y = (H - fg_h) // 2
        output  = bg.copy()
        output.paste(fg, (0, paste_y))

        # Convert to RGBA for alpha compositing
        output = output.convert("RGBA")

        # Paste logo (top-left area, well above subtitle zone)
        if logo_img is not None:
            output.paste(logo_img, (120, 160), logo_img)

        # Paste active subtitle
        t          = fi / fps
        active_sub = next(
            ((si, sx, sy) for s, e, si, sx, sy in subtitle_data if s <= t < e),
            None,
        )
        if active_sub is not None:
            sub_img, sx, sy = active_sub
            output.paste(sub_img, (sx, sy), sub_img)

        output.convert("RGB").save(fp)

    # ── 6. Single encode pass: frames + audio ─────────────────────────────────
    subprocess.run([
        "ffmpeg",
        "-framerate", str(fps),
        "-i", os.path.join(frames_dir, "frame_%06d.png"),
        "-ss", str(offset_seconds), "-t", str(duration), "-i", section_path,
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-crf", "23", "-preset", "fast",
        "-maxrate", "3500k", "-bufsize", "7000k",
        "-af", audio_filter,
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-pix_fmt", "yuv420p", "-shortest",
        output_path, "-y",
    ], check=True, capture_output=True)

    shutil.rmtree(frames_dir, ignore_errors=True)


# ── Subtitles ──────────────────────────────────────────────────────────────────

def words_for_clip(all_words, clip_start_s, clip_end_s):
    """Filter words that fall within the clip's time range and rebase to clip-relative seconds."""
    result = []
    for w in all_words:
        if w["end"] <= clip_start_s or w["start"] >= clip_end_s:
            continue
        result.append({
            "word": w["word"].strip(),
            "start": max(0.0, w["start"] - clip_start_s),
            "end": min(float(clip_end_s - clip_start_s), w["end"] - clip_start_s),
        })
    return result


def upload_clip(supabase, local_path, storage_path):
    """Upload to Supabase Storage public bucket, return public URL."""
    upload_url = f"{SUPABASE_URL}/storage/v1/object/clips/{storage_path}"
    with open(local_path, "rb") as f:
        data = f.read()
    headers = {
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "video/mp4",
        "x-upsert": "true",
    }
    for attempt in range(5):
        try:
            resp = requests.post(upload_url, data=data, headers=headers, timeout=300)
            break
        except Exception as e:
            if attempt == 4:
                raise
            wait = 15 * (attempt + 1)
            print(f"  Upload attempt {attempt+1} failed ({e.__class__.__name__}), retrying in {wait}s...")
            time.sleep(wait)
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"Upload failed ({resp.status_code}): {resp.text[:300]}")
    return supabase.storage.from_("clips").get_public_url(storage_path)


def queue_clip(supabase, video_id, clip_index, storage_path, public_url, caption, hook, platform):
    existing = supabase.table("clip_queue").select("id", "status").eq("video_id", video_id).eq("clip_index", clip_index).eq("platform", platform).execute()
    if existing.data:
        if existing.data[0]["status"] == "pending":
            # Update URL/caption in case clip was re-rendered
            supabase.table("clip_queue").update({
                "storage_path": storage_path,
                "public_url": public_url,
                "caption": caption,
                "hook": hook,
            }).eq("id", existing.data[0]["id"]).execute()
        return
    supabase.table("clip_queue").insert({
        "video_id": video_id,
        "clip_index": clip_index,
        "storage_path": storage_path,
        "public_url": public_url,
        "caption": caption,
        "hook": hook,
        "platform": platform,
        "status": "pending",
    }).execute()


# ── Transcript persistence ─────────────────────────────────────────────────────

def _load_transcript(supabase_admin, local_cache, video_id):
    """Load transcript from local cache or Supabase. Returns (segments, words) or (None, [])."""
    if os.path.exists(local_cache):
        with open(local_cache) as f:
            cached = json.load(f)
        if isinstance(cached, dict) and "words" in cached:
            print(f"\n[CACHED] Transcript loaded locally -- {len(cached['segments'])} segments")
            return cached["segments"], cached["words"]

    try:
        result = supabase_admin.table("video_transcripts").select("transcript").eq("video_id", video_id).execute()
        if result.data:
            cached = json.loads(result.data[0]["transcript"])
            segments, words = cached["segments"], cached.get("words", [])
            print(f"\n[SUPABASE] Transcript loaded -- {len(segments)} segments")
            with open(local_cache, "w") as f:
                json.dump(cached, f)
            return segments, words
    except Exception as e:
        print(f"  Warning: could not load transcript from Supabase: {e}")

    return None, []


def _save_transcript(supabase_admin, local_cache, video_id, segments, words):
    """Save transcript to local cache and Supabase."""
    data = {"segments": segments, "words": words}
    with open(local_cache, "w") as f:
        json.dump(data, f)
    try:
        supabase_admin.table("video_transcripts").upsert({
            "video_id": video_id,
            "transcript": json.dumps(data),
        }).execute()
        print(f"  Transcript saved to Supabase")
    except Exception as e:
        print(f"  Warning: could not save transcript to Supabase: {e}")


def _save_clip_plan(supabase_admin, video_id, clips):
    """Save Claude's clip selections to Supabase immediately after Claude responds."""
    rows = [{
        "video_id": video_id,
        "clip_index": i,
        "start_seconds": clip["start_seconds"],
        "end_seconds": clip["end_seconds"],
        "caption": json.dumps(clip.get("captions", {})),
        "hook": clip.get("hook", ""),
        "status": "pending",
    } for i, clip in enumerate(clips)]
    supabase_admin.table("video_clip_plans").upsert(rows, on_conflict="video_id,clip_index").execute()
    print(f"  Clip plan saved to Supabase ({len(rows)} clips)")


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video_id", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--max_clips", type=int, default=None, help="Limit number of clips (for testing)")
    args = parser.parse_args()

    # Retry initial Supabase connection -- DNS can flake briefly on this machine
    for _attempt in range(5):
        try:
            supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
            supabase_admin = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
            supabase_admin.table("video_clip_plans").select("video_id").limit(1).execute()
            break
        except Exception as _e:
            if _attempt == 4:
                raise
            print(f"  [Network] Supabase unreachable ({_e.__class__.__name__}), retrying in 15s...")
            time.sleep(15)

    anthropic_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    os.makedirs("transcripts", exist_ok=True)
    transcript_cache = f"transcripts/{args.video_id}.json"

    with tempfile.TemporaryDirectory() as tmpdir:

        # Check for resumable clip plan in Supabase
        pending_rows = supabase_admin.table("video_clip_plans") \
            .select("*").eq("video_id", args.video_id).neq("status", "done") \
            .order("clip_index").execute()

        if pending_rows.data:
            print(f"\n[RESUME] {len(pending_rows.data)} unfinished clips found -- skipping audio/transcription/Claude")
            segments, words = _load_transcript(supabase_admin, transcript_cache, args.video_id)
            clips_to_process = []
            for row in pending_rows.data:
                try:
                    captions = json.loads(row["caption"])
                except Exception:
                    captions = {p: row["caption"] for p in ["instagram", "tiktok", "youtube", "facebook"]}
                clips_to_process.append({
                    "clip_index": row["clip_index"],
                    "start_seconds": row["start_seconds"],
                    "end_seconds": row["end_seconds"],
                    "hook": row.get("hook", ""),
                    "captions": captions,
                })
            if args.max_clips:
                clips_to_process = clips_to_process[:args.max_clips]
            total_clips = supabase_admin.table("video_clip_plans") \
                .select("clip_index", count="exact").eq("video_id", args.video_id).execute()
            total = total_clips.count or len(clips_to_process)
        else:
            # PASS 1: Audio -> Transcript
            segments, words = _load_transcript(supabase_admin, transcript_cache, args.video_id)

            if segments is None:
                print(f"\n[1/2 downloads] Audio only from: {args.url}")
                audio_path = download_audio_only(args.url, tmpdir)
                size_mb = os.path.getsize(audio_path) / 1024 / 1024
                print(f"  Downloaded audio: {size_mb:.1f}MB")

                print("[Transcribing]")
                segments, words = transcribe(audio_path)
                print(f"  {len(segments)} transcript segments, {len(words)} words")
                _save_transcript(supabase_admin, transcript_cache, args.video_id, segments, words)

            # Claude picks clips
            print("\n[Claude] Selecting viral clips from transcript...")
            all_clips = select_clips(anthropic_client, segments, args.title, supabase_admin)
            print(f"  {len(all_clips)} clips selected")

            if not all_clips:
                print("No valid clips returned by Claude. Exiting.", file=sys.stderr)
                sys.exit(1)

            if args.max_clips:
                all_clips = all_clips[:args.max_clips]

            _save_clip_plan(supabase_admin, args.video_id, all_clips)
            _log_clip_selections(supabase_admin, args.video_id, all_clips, segments=segments)

            for i, clip in enumerate(all_clips):
                print(f"  [{i+1}] {to_hhmmss(clip['start_seconds'])} -> {to_hhmmss(clip['end_seconds'])} | {clip['hook'][:65]}")

            clips_to_process = [{"clip_index": i, **clip} for i, clip in enumerate(all_clips)]
            total = len(all_clips)

        # PASS 2: Download full video once -> cut each clip locally
        full_video_path = os.path.join(tmpdir, f"{args.video_id}_full.mp4")
        print(f"\n[2/2 downloads] Downloading full video at 720p (this takes a few minutes)...")
        download_full_video(args.url, full_video_path)
        full_mb = os.path.getsize(full_video_path) / 1024 / 1024
        print(f"  Downloaded: {full_mb:.0f}MB -> cutting {len(clips_to_process)} clips locally...")

        succeeded = 0
        for item in clips_to_process:
            i = item["clip_index"]
            start_s = item["start_seconds"]
            end_s = item["end_seconds"]
            duration = end_s - start_s

            clip_path = os.path.join(tmpdir, f"{args.video_id}_clip_{i}.mp4")
            storage_path = f"{args.video_id}/{args.video_id}_clip_{i}.mp4"

            print(f"\n  [{i+1}/{total}] {to_hhmmss(start_s)} -> {to_hhmmss(end_s)} ({duration:.0f}s)")
            try:
                clip_words = words_for_clip(words, start_s, end_s) if words else []
                print(f"  Cutting, cropping, burning subtitles ({len(clip_words)} words)...")
                clip_hook = item.get("hook", "")
                try:
                    cut_and_subtitle(full_video_path, start_s, duration, clip_words, clip_path, i, tmpdir, hook=clip_hook)
                except Exception as e:
                    print(f"  cut_and_subtitle failed ({e}), retrying without subtitles...")
                    cut_and_subtitle(full_video_path, start_s, duration, [], clip_path, i, tmpdir, hook=clip_hook)

                clip_mb = os.path.getsize(clip_path) / 1024 / 1024
                print(f"  Uploading ({clip_mb:.1f}MB)...")
                public_url = upload_clip(supabase_admin, clip_path, storage_path)

                captions = item.get("captions", {})
                for platform in ["instagram", "tiktok", "youtube", "facebook"]:
                    caption = captions.get(platform) or item.get("caption", "")
                    queue_clip(supabase_admin, args.video_id, i, storage_path, public_url, caption, item.get("hook", ""), platform)

                print(f"  Queued: {public_url[:60]}...")
                supabase_admin.table("video_clip_plans").update({"status": "done"}) \
                    .eq("video_id", args.video_id).eq("clip_index", i).execute()
                if os.path.exists(clip_path):
                    os.remove(clip_path)
                succeeded += 1

            except Exception as e:
                print(f"  x Clip {i+1} failed: {e} -- skipping, continuing...")
                supabase_admin.table("video_clip_plans").update({"status": "failed"}) \
                    .eq("video_id", args.video_id).eq("clip_index", i).execute()
                if os.path.exists(clip_path):
                    os.remove(clip_path)
                continue

        # Mark processed
        if succeeded > 0:
            existing = supabase_admin.table("processed_videos").select("id") \
                .eq("video_id", args.video_id).execute()
            if not existing.data:
                supabase_admin.table("processed_videos").insert({
                    "video_id": args.video_id,
                    "video_title": args.title,
                    "channel_id": CHANNEL_ID,
                    "clip_count": succeeded,
                }).execute()

            platforms = ["instagram", "tiktok", "youtube", "facebook"]
            print(f"\nDone. {succeeded}/{total} clips queued -- {succeeded * len(platforms)} posts scheduled.")
            if succeeded < total:
                print(f"  {total - succeeded} clips failed. Re-run to retry -- clip plan is saved in Supabase.")
        else:
            print(f"\nAll {total} clips failed.", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
