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


# ── Helpers ────────────────────────────────────────────────────────────────────

def to_hhmmss(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


# ── Download ───────────────────────────────────────────────────────────────────

def _ydl_auth_args():
    """Return proxy or cookies args for yt-dlp authentication."""
    proxy = os.environ.get("YTDLP_PROXY")
    if proxy:
        return ["--proxy", proxy]
    cookies = os.environ.get("YOUTUBE_COOKIES_FILE")
    if cookies:
        return ["--cookies", cookies]
    return []


def download_audio_only(url, output_dir):
    """Download just the audio stream — ~40MB for a 40-min podcast."""
    output_path = os.path.join(output_dir, "audio.%(ext)s")
    subprocess.run(
        [
            "yt-dlp",
            "-f", "bestaudio[ext=m4a]/bestaudio/best",
            "--no-playlist",
            "--js-runtimes", "node",
            "--remote-components", "ejs:github",
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
    Download the full video using yt-dlp's own downloader.
    Format 22 = 720p progressive (single stream, no DASH merging).
    1080p DASH is blocked by YouTube from datacenter IPs even with PO tokens.
    """
    # Format 22 = 720p h264+aac progressive. Format 18 = 360p fallback.
    format_str = "22/18"
    cmd = [
        "yt-dlp",
        "-f", format_str,
        "--merge-output-format", "mp4",
        "--no-playlist",
        "--socket-timeout", "60",
        "--retries", "10",
        "--fragment-retries", "10",
        "--http-chunk-size", "10M",
        "--js-runtimes", "node",
        "--remote-components", "ejs:github",
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


def _log_clip_selections(supabase, video_id: str, clips: list, durations: dict | None = None) -> None:
    """Log Claude's clip selections with hook type and topic for future outcome tracking."""
    try:
        rows = []
        for i, clip in enumerate(clips):
            hook = clip.get("hook", "")
            duration = None
            if durations:
                duration = durations.get(i)
            elif clip.get("end_seconds") and clip.get("start_seconds"):
                duration = round(clip["end_seconds"] - clip["start_seconds"])
            rows.append({
                "video_id":       video_id,
                "clip_index":     i,
                "hook":           hook[:200],
                "duration_seconds": duration,
                "hook_type":      _classify_hook_type(hook),
                "topic_category": _classify_topic(hook),
            })
        supabase.table("clip_selection_log").upsert(rows, on_conflict="video_id,clip_index").execute()
        print(f"  [Memory] Logged {len(rows)} clip selections to learning DB.")
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
    if len(transcript_text) > 80000:
        transcript_text = transcript_text[:80000] + "\n...[truncated]"

    intelligence = _load_channel_intelligence(supabase) if supabase else ""
    intelligence_block = ""
    if intelligence:
        intelligence_block = f"""
━━━ CHANNEL PERFORMANCE INTELLIGENCE ━━━

This is real data from clips already posted on this channel. Use it to inform every decision you make below — hook style, topic selection, clip length, and platform captions.

{intelligence}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

"""
        print("  [Intelligence] Loaded channel performance brief into prompt.")
    else:
        print("  [Intelligence] No brief available yet — using base rules only.")

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

4. CONTENT COHESION — Each clip must contain ONE complete self-contained idea, story, or revelation. A viewer who has never heard of this podcast must instantly understand the context. Strongly prioritise moments that are:
  • A specific number, amount, or statistic that reveals something surprising
  • A personal failure, mistake, or lesson the speaker learned the hard way
  • A take that the Konnected Minds audience (Ghana/Africa, entrepreneurship, business, faith, ambition) will passionately agree or disagree with
  • A story with a clear arc that resolves within the clip
  • A revelation that reframes how the audience thinks about something they already believe

5. ALGORITHM SIGNALS — Pick moments that will drive measurable actions:
  • Comments: the audience needs to argue about it, share their own story, or tag someone
  • Shares: the clip must feel like "I need to send this to someone right now"
  • Saves: practical insight or a hard truth people want to return to
  • Replays: a punchline, a stat, or a twist delivered so well they want to hear it again

6. TIMESTAMP CONVERSION — Each transcript line shows [MM:SS-MM:SS] format. Convert the start time of your chosen clip to raw integer seconds for start_seconds, and the end time to raw integer seconds for end_seconds. Example: a clip starting at 02:05 and ending at 03:07 becomes start_seconds: 125, end_seconds: 187.

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

    for attempt in range(3):
        try:
            msg = anthropic_client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=6000,
                messages=[{"role": "user", "content": prompt}],
            )
            break
        except Exception as e:
            if attempt == 2:
                raise
            print(f"  Claude API attempt {attempt + 1} failed ({e}), retrying...")
            import time; time.sleep(10 * (attempt + 1))

    raw = msg.content[0].text.strip()
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

def _smart_crop_x(video_path, start_s, duration):
    """
    Detect the speaker's face using MediaPipe (deep learning, much more accurate
    than Haar cascades for real-world podcast footage). Falls back to Haar cascades
    if MediaPipe isn't available, then to pixel-variance side detection as a last resort.
    Returns (x_offset, crop_w, frame_h) or None to fall back to center crop.
    """
    try:
        import cv2
        import numpy as np

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return None

        frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        crop_w  = frame_h * 9 // 16

        face_centers: list[int] = []
        frames_sampled: list = []
        n = 20  # more samples → better coverage when camera cuts between speakers

        # ── Attempt 1: MediaPipe FaceDetection (deep learning, handles angles/lighting) ──
        mp_detector = None
        try:
            import mediapipe as mp
            mp_detector = mp.solutions.face_detection.FaceDetection(
                model_selection=1,       # optimised for faces up to 5m — good for wide podcast shots
                min_detection_confidence=0.3,  # lower threshold catches faces in wider shots
            )
        except Exception:
            pass

        for i in range(1, n + 1):
            cap.set(cv2.CAP_PROP_POS_MSEC, (start_s + duration * i / (n + 1)) * 1000)
            ret, frame = cap.read()
            if not ret:
                continue
            frames_sampled.append(frame)

            if mp_detector is not None:
                rgb     = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                results = mp_detector.process(rgb)
                if results.detections:
                    best = max(results.detections, key=lambda d: d.score[0])
                    bb   = best.location_data.relative_bounding_box
                    cx   = int((bb.xmin + bb.width / 2) * frame_w)
                    face_centers.append(cx)
            else:
                # ── Attempt 2: Haar cascades fallback ──
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                min_sz = max(20, frame_h // 10)
                for xml in ["haarcascade_frontalface_default.xml",
                            "haarcascade_frontalface_alt2.xml",
                            "haarcascade_profileface.xml"]:
                    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + xml)
                    faces = cascade.detectMultiScale(gray, 1.1, 2, minSize=(min_sz, min_sz))
                    if len(faces) > 0:
                        x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
                        face_centers.append(x + w // 2)
                        break

        if mp_detector is not None:
            mp_detector.close()
        cap.release()

        if face_centers:
            # When two speakers are far apart, pick the dominant cluster (most screen time)
            # rather than the median, which can land between them and show neither face.
            spread = max(face_centers) - min(face_centers)
            if spread > crop_w * 0.5 and len(face_centers) >= 4:
                mid = (max(face_centers) + min(face_centers)) / 2
                left_cluster  = [c for c in face_centers if c <= mid]
                right_cluster = [c for c in face_centers if c >  mid]
                dominant = left_cluster if len(left_cluster) >= len(right_cluster) else right_cluster
                avg_cx = int(sum(dominant) / len(dominant))
            else:
                avg_cx = sorted(face_centers)[len(face_centers) // 2]
            x_off = max(0, min(avg_cx - crop_w // 2, frame_w - crop_w))
            return x_off, crop_w, frame_h

        # ── Attempt 3: variance-based side detection ──
        # In a podcast the mic/table is dead-centre; the speakers are left or right.
        if frames_sampled:
            third     = frame_w // 3
            left_var  = float(np.var(np.array([f[:, :third]       for f in frames_sampled], dtype=np.float32)))
            right_var = float(np.var(np.array([f[:, 2 * third:]   for f in frames_sampled], dtype=np.float32)))
            cx    = third // 2 if left_var > right_var else 2 * third + third // 2
            x_off = max(0, min(cx - crop_w // 2, frame_w - crop_w))
            return x_off, crop_w, frame_h

        return None

    except Exception:
        return None



def cut_and_subtitle(section_path, offset_seconds, duration, words, output_path, clip_idx, tmpdir, chunk_size=3, hook=""):
    """
    Single encode pass: extract frames from section with crop/scale applied,
    paste subtitles with Pillow, then encode exactly once. Eliminates generational
    quality loss from double-encoding.
    """
    W, H = 720, 1280

    # Smart crop: center on detected face, fall back to dead-center if no face found
    face_result = _smart_crop_x(section_path, offset_seconds, duration)

    # Probe source FPS first — needed for Ken Burns frame-count expression
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

    # Ken Burns zoom-in using frame number `n` (not timestamp `t`).
    # `t` carries the source PTS which starts at offset_seconds, not 0 — so
    # min(t/duration,1) would equal 1 immediately for mid-video clips.
    # `n` always starts at 0 for the first frame regardless of source PTS.
    # At n=0:          crop=756x1344 (full oversized) → content at 1.0x
    # At n=total_frames: crop=720x1280 (tight center) → content at 1.05x
    N = max(1, int(duration * fps))
    ken_burns = (
        f"scale=756:1344:flags=lanczos,"
        f"crop='756-36*min(n/{N},1)':'1344-64*min(n/{N},1)':"
        f"'(756-ow)/2':'(1344-oh)/2',"
        f"scale=720:1280:flags=lanczos"
    )

    if face_result:
        x_off, crop_w, frame_h = face_result
        crop_scale = f"crop={crop_w}:{frame_h}:{x_off}:0,{ken_burns},unsharp=3:3:0.5:3:3:0.0"
    else:
        crop_scale = f"crop=ih*9/16:ih:(iw-ih*9/16)/2:0,{ken_burns},unsharp=3:3:0.5:3:3:0.0"

    # Audio enhancement: cut low rumble, boost voice presence, normalise to -14 LUFS
    audio_filter = (
        "highpass=f=80,"
        "equalizer=f=300:width_type=o:width=1:g=-3,"
        "equalizer=f=3000:width_type=o:width=1.5:g=3,"
        "loudnorm=I=-14:TP=-1:LRA=11"
    )

    # ── Fast path: no subtitle words → skip PIL frame extraction entirely ──────
    if not words:
        subprocess.run([
            "ffmpeg", "-ss", str(offset_seconds), "-i", section_path,
            "-t", str(duration), "-vf", crop_scale,
            "-c:v", "libx264", "-crf", "18", "-preset", "fast",
            "-af", audio_filter,
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
            "-pix_fmt", "yuv420p", output_path, "-y",
        ], check=True, capture_output=True)
        return

    # ── Step 1: Extract frames with crop/scale (decode only, no lossy encode) ──
    frames_dir = os.path.join(tmpdir, f"frames_{clip_idx}")
    os.makedirs(frames_dir, exist_ok=True)
    subprocess.run([
        "ffmpeg", "-ss", str(offset_seconds), "-i", section_path,
        "-t", str(duration), "-vf", crop_scale,
        os.path.join(frames_dir, "frame_%06d.png"), "-y",
    ], check=True, capture_output=True)

    # ── Step 2: Pre-render karaoke subtitles — one image per word ───────────
    # Active word = yellow, rest of chunk = white, no background box, thick stroke.
    # One subtitle_data entry per word so the highlight updates word-by-word.
    from PIL import Image, ImageDraw, ImageFont
    base_font_size = max(72, H // 11)
    font_candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/Library/Fonts/SF-Pro.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFNS.ttf",
    ]
    font_path = next((p for p in font_candidates if os.path.exists(p)), None)

    subtitle_data = []
    tmp_draw = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    max_text_w = int(W * 0.92)
    stroke_w   = 3
    # Position subtitle so its bottom edge is at ~65% from top.
    # Anything lower gets covered by platform UI (like/comment buttons, caption, gesture bar).
    max_sub_h  = base_font_size + 2 * (stroke_w + 6)
    sub_y      = int(H * 0.65) - max_sub_h

    for ci in range(0, len(words), chunk_size):
        chunk = words[ci:ci + chunk_size]
        if not chunk:
            continue

        chunk_texts = [wd["word"].strip().upper() for wd in chunk]
        full_text   = " ".join(chunk_texts)

        # Shrink font until the full chunk fits on one line
        size = base_font_size
        while size >= 32:
            try:
                font = ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default()
            except Exception:
                font = ImageFont.load_default()
            bb = tmp_draw.textbbox((0, 0), full_text, font=font)
            if bb[2] - bb[0] <= max_text_w:
                break
            size -= 4

        # Measure each word width and the space width
        sp_bb = tmp_draw.textbbox((0, 0), " ", font=font)
        sp_w  = max(sp_bb[2] - sp_bb[0], size // 5)
        word_dims = []
        for t in chunk_texts:
            bb = tmp_draw.textbbox((0, 0), t, font=font)
            word_dims.append((bb[2] - bb[0], bb[3] - bb[1]))

        total_w = sum(w for w, h in word_dims) + sp_w * max(0, len(chunk_texts) - 1)
        line_h  = max((h for w, h in word_dims), default=size)
        pad     = stroke_w + 6
        img_w   = int(total_w) + pad * 2
        img_h   = int(line_h)  + pad * 2

        # One image per word — highlight rotates through the chunk
        for wi, word_data in enumerate(chunk):
            img  = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
            draw = ImageDraw.Draw(img)
            x    = pad
            for wj, (text, (ww, wh)) in enumerate(zip(chunk_texts, word_dims)):
                color = (255, 226, 52, 255) if wj == wi else (255, 255, 255, 255)
                draw.text((x, pad), text, font=font, fill=color,
                          stroke_width=stroke_w, stroke_fill=(0, 0, 0, 255))
                x += ww + sp_w

            x_pos = max(10, (W - img_w) // 2)
            subtitle_data.append((word_data["start"], word_data["end"], img, x_pos, sub_y))

    # ── Step 3: Paste subtitles onto extracted frames ──────────
    frame_files = sorted(f for f in os.listdir(frames_dir) if f.endswith(".png"))
    for fi, fname in enumerate(frame_files):
        t = fi / fps
        fp = os.path.join(frames_dir, fname)

        for start, end, sub_img, x, y in subtitle_data:
            if start <= t < end:
                frame = Image.open(fp).convert("RGBA")
                frame.paste(sub_img, (x, y), sub_img)
                frame.convert("RGB").save(fp)
                break

    # ── Step 4: Single encode — frames + audio from section ───────────────────
    subprocess.run([
        "ffmpeg",
        "-framerate", str(fps),
        "-i", os.path.join(frames_dir, "frame_%06d.png"),
        "-ss", str(offset_seconds), "-t", str(duration), "-i", section_path,
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-af", audio_filter,
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-pix_fmt", "yuv420p", "-shortest",
        output_path, "-y",
    ], check=True, capture_output=True)


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
    for attempt in range(3):
        try:
            resp = requests.post(upload_url, data=data, headers=headers, timeout=300)
            break
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            if attempt == 2:
                raise
            import time; time.sleep(5 * (attempt + 1))
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"Upload failed ({resp.status_code}): {resp.text[:300]}")
    return supabase.storage.from_("clips").get_public_url(storage_path)


def queue_clip(supabase, video_id, clip_index, storage_path, public_url, caption, hook, platform):
    existing = supabase.table("clip_queue").select("id").eq("video_id", video_id).eq("clip_index", clip_index).eq("platform", platform).execute()
    if existing.data:
        return  # already queued, skip
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
            print(f"\n[CACHED] Transcript loaded locally — {len(cached['segments'])} segments")
            return cached["segments"], cached["words"]

    try:
        result = supabase_admin.table("video_transcripts").select("transcript").eq("video_id", video_id).execute()
        if result.data:
            cached = json.loads(result.data[0]["transcript"])
            segments, words = cached["segments"], cached.get("words", [])
            print(f"\n[SUPABASE] Transcript loaded — {len(segments)} segments")
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
    args = parser.parse_args()

    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    supabase_admin = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    anthropic_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    os.makedirs("transcripts", exist_ok=True)
    transcript_cache = f"transcripts/{args.video_id}.json"

    with tempfile.TemporaryDirectory() as tmpdir:

        # ── Check for resumable clip plan in Supabase ──────────────────────────
        pending_rows = supabase_admin.table("video_clip_plans") \
            .select("*").eq("video_id", args.video_id).neq("status", "done") \
            .order("clip_index").execute()

        if pending_rows.data:
            print(f"\n[RESUME] {len(pending_rows.data)} unfinished clips found — skipping audio/transcription/Claude")
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
            total_clips = supabase_admin.table("video_clip_plans") \
                .select("clip_index", count="exact").eq("video_id", args.video_id).execute()
            total = total_clips.count or len(clips_to_process)
        else:
            # ── PASS 1: Audio → Transcript ─────────────────────────────────────
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

            # ── Claude picks clips ─────────────────────────────────────────────
            print("\n[Claude] Selecting viral clips from transcript...")
            all_clips = select_clips(anthropic_client, segments, args.title, supabase_admin)
            print(f"  {len(all_clips)} clips selected")

            if not all_clips:
                print("No valid clips returned by Claude. Exiting.", file=sys.stderr)
                sys.exit(1)

            _save_clip_plan(supabase_admin, args.video_id, all_clips)
            _log_clip_selections(supabase_admin, args.video_id, all_clips)

            for i, clip in enumerate(all_clips):
                print(f"  [{i+1}] {to_hhmmss(clip['start_seconds'])} → {to_hhmmss(clip['end_seconds'])} | {clip['hook'][:65]}")

            clips_to_process = [{"clip_index": i, **clip} for i, clip in enumerate(all_clips)]
            total = len(all_clips)

        # ── PASS 2: Download full video once → cut each clip locally ────────────
        # Downloading sections via --download-sections causes ffmpeg to fetch CDN
        # URLs directly, which YouTube blocks with 403. Downloading the full video
        # uses yt-dlp's own downloader (which works), then we cut locally.
        full_video_path = os.path.join(tmpdir, f"{args.video_id}_full.mp4")
        print(f"\n[2/2 downloads] Downloading full video at 720p (this takes a few minutes)...")
        download_full_video(args.url, full_video_path)
        full_mb = os.path.getsize(full_video_path) / 1024 / 1024
        print(f"  Downloaded: {full_mb:.0f}MB → cutting {len(clips_to_process)} clips locally...")

        succeeded = 0
        for item in clips_to_process:
            i = item["clip_index"]
            start_s = item["start_seconds"]
            end_s = item["end_seconds"]
            duration = end_s - start_s

            clip_path = os.path.join(tmpdir, f"{args.video_id}_clip_{i}.mp4")
            storage_path = f"{args.video_id}/{args.video_id}_clip_{i}.mp4"

            print(f"\n  [{i+1}/{total}] {to_hhmmss(start_s)} → {to_hhmmss(end_s)} ({duration:.0f}s)")
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
                print(f"  ✗ Clip {i+1} failed: {e} — skipping, continuing...")
                supabase_admin.table("video_clip_plans").update({"status": "failed"}) \
                    .eq("video_id", args.video_id).eq("clip_index", i).execute()
                if os.path.exists(clip_path):
                    os.remove(clip_path)
                continue

        # ── Mark processed ─────────────────────────────────────────────────────
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
            print(f"\n✓ Done. {succeeded}/{total} clips queued — {succeeded * len(platforms)} posts scheduled.")
            if succeeded < total:
                print(f"  ⚠ {total - succeeded} clips failed. Re-run to retry — clip plan is saved in Supabase.")
        else:
            print(f"\n✗ All {total} clips failed.", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
