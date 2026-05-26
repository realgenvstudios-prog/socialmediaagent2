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
    Format priority: progressive MP4 (single stream, no DASH) → DASH h264 → anything.
    Progressive formats avoid the 403 issue where --download-sections makes ffmpeg
    fetch CDN URLs directly. With progressive, yt-dlp downloads the whole file itself.
    """
    # Format 22 = 720p h264+aac progressive (single stream, best quality, not always available).
    # Format 18 = 360p h264+aac progressive (always available, fallback).
    # Both avoid DASH section downloads which YouTube blocks from server IPs.
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

def select_clips(anthropic_client, segments, video_title):
    """Ask Claude to pick 10-12 viral moments from the transcript."""
    lines = []
    for seg in segments:
        sm, ss = int(seg["start"] // 60), int(seg["start"] % 60)
        em, es = int(seg["end"] // 60), int(seg["end"] % 60)
        lines.append(f"[{sm:02d}:{ss:02d}-{em:02d}:{es:02d}] {seg['text']}")

    transcript_text = "\n".join(lines)
    if len(transcript_text) > 80000:
        transcript_text = transcript_text[:80000] + "\n...[truncated]"

    prompt = f"""You are an expert viral short-form content strategist who deeply understands what makes people stop scrolling and watch a video clip all the way through to completion.

Your job: analyze the provided timestamped podcast transcript and identify the 10 to 12 best, most high-impact moments to clip for Instagram Reels, TikTok, YouTube Shorts, and Facebook Reels.

Video title: {video_title}

Transcript (with timestamps):
Each line shows [MM:SS-MM:SS] start-end time for that segment, followed by the spoken text.
{transcript_text}

━━━ CLIP SELECTION RULES ━━━

1. CHRONOLOGICAL SYSTEMATIC REVIEW — Read through the entire transcript from start to finish. Do not ignore the middle sections. Distribute your selections evenly across the entire runtime. Do not cluster clips in a single high-energy segment. IMPORTANT: The opening 2–3 minutes of a podcast is typically an intro montage — rapid jump cuts between unrelated moments designed to tease the full episode. These make no sense as standalone clips. Use your judgment to identify and skip this intro section; look for where the hosts settle into the actual conversation (usually when they introduce themselves or the guest properly) and start your selections from there.

2. TARGET LENGTH — Target 45 to 65 seconds per clip. This is the proven sweet spot for completion rate across all 4 platforms. Never go below 30 seconds or above 90 seconds. Tighter is better. The clip must start precisely on the opening word of the hook and end the moment the idea concludes — do not trail off into the next topic or filler.

3. THE HOOK (first 3 seconds) — This is the single most important part. The algorithm decides whether to push a clip based on how many people watch past 3 seconds. A good hook is one of:
  • A shocking or counterintuitive statement ("I made $0 from that viral video")
  • A question that creates instant curiosity ("Why did she never get paid?")
  • A cliffhanger opener ("What happened next changed everything")
  • A bold claim or confession ("I was wrong about this for 10 years")
  Never start a clip mid-thought, with filler words ("So...", "Um...", "Like I said"), or with slow context-setting.

4. CONTENT COHESION — Each clip must contain ONE complete self-contained idea, story, or revelation. A viewer who has never heard of this podcast must instantly understand the context. Prioritise moments that are:
  • Emotionally charged (anger, surprise, inspiration, heartbreak)
  • Story-driven with a clear arc (setup → tension → payoff)
  • Controversial or opinion-driven (sparks comments and shares)
  • Deeply relatable or universally human
  • Revealing something people didn't know or expect

5. ALGORITHM SIGNALS — Pick moments mathematically likely to drive:
  • Replays (a punchline, stat, or twist people want to hear again)
  • Shares (something so good people want to send it to a friend)
  • Saves (practical insight or advice people want to come back to)
  • Comments (a take that people agree or disagree with strongly)

6. TIMESTAMP CONVERSION — Each transcript line shows [MM:SS-MM:SS] format. Convert the start time of your chosen clip to raw integer seconds for start_seconds, and the end time to raw integer seconds for end_seconds. Example: a clip starting at 02:05 and ending at 03:07 becomes start_seconds: 125, end_seconds: 187.

━━━ CAPTION RULES ━━━

Write platform-specific captions for each clip:

instagram: 2–3 punchy sentences that expand on the hook and tease what they'll learn. End with 5–8 relevant hashtags on a new line. Tone: direct, energetic, slightly dramatic.

tiktok: 1–2 very casual sentences. Sounds like a person talking, not a brand. 3–5 hashtags maximum. Tone: conversational, raw, unpolished.

youtube: A standalone title that works as a YouTube Shorts title (max 80 characters). Must create curiosity or promise a specific payoff. No hashtags. Capitalise like a headline.

facebook: 2–3 sentences written for a slightly older, more conversational Facebook audience. More context than TikTok, less hype than Instagram. No hashtags.

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

def cut_and_subtitle(section_path, offset_seconds, duration, words, output_path, clip_idx, tmpdir, chunk_size=3):
    """
    Single encode pass: extract frames from section with crop/scale applied,
    paste subtitles with Pillow, then encode exactly once. Eliminates generational
    quality loss from double-encoding.
    """
    W, H = 720, 1280
    crop_scale = "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=720:1280"

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

    # ── Fast path: no words, just encode directly ──────────────────────────────
    if not words:
        subprocess.run([
            "ffmpeg", "-ss", str(offset_seconds), "-i", section_path,
            "-t", str(duration), "-vf", crop_scale,
            "-c:v", "libx264", "-crf", "18", "-preset", "fast",
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

    # ── Step 2: Pre-render subtitle images ────────────────────────────────────
    from PIL import Image, ImageDraw, ImageFont
    font_size = max(60, H // 14)
    font_candidates = [
        "/Library/Fonts/SF-Pro.ttf",
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]
    font_path = next((p for p in font_candidates if os.path.exists(p)), None)

    chunks = [words[i:i + chunk_size] for i in range(0, len(words), chunk_size)]
    subtitle_data = []
    max_text_w = int(W * 0.78)

    for chunk in chunks:
        if not chunk:
            continue
        start = chunk[0]["start"]
        end = chunk[-1]["end"]
        text = " ".join(wd["word"] for wd in chunk).upper()

        size = font_size
        while size >= 30:
            try:
                font = ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default()
            except Exception:
                font = ImageFont.load_default()
            bbox = ImageDraw.Draw(Image.new("RGBA", (1, 1))).textbbox((0, 0), text, font=font)
            if bbox[2] - bbox[0] <= max_text_w:
                break
            size -= 4

        bbox = ImageDraw.Draw(Image.new("RGBA", (1, 1))).textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        pad_x = max(20, size // 4)
        pad_y = max(16, size // 5)
        radius = max(16, size // 4)
        img_w = tw + pad_x * 2
        img_h = th + pad_y * 2

        img = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.rounded_rectangle([0, 0, img_w - 1, img_h - 1], radius=radius, fill=(0, 0, 0, 255))
        # Subtract bbox origin so text is truly centered — textbbox origin can be non-zero
        draw.text((pad_x - bbox[0], pad_y - bbox[1]), text, font=font,
                  fill=(255, 255, 255, 255), stroke_width=1, stroke_fill=(0, 0, 0, 200))

        x_pos = max(10, (W - img_w) // 2)
        y_pos = H - img_h - int(H * 0.13)
        subtitle_data.append((start, end, img, x_pos, y_pos))

    # ── Step 3: Paste subtitles onto extracted frames ─────────────────────────
    frame_files = sorted(f for f in os.listdir(frames_dir) if f.endswith(".png"))
    for fi, fname in enumerate(frame_files):
        t = fi / fps
        for start, end, sub_img, x, y in subtitle_data:
            if start <= t < end:
                fp = os.path.join(frames_dir, fname)
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
    supabase_admin.table("video_clip_plans").upsert(rows).execute()
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
            all_clips = select_clips(anthropic_client, segments, args.title)
            print(f"  {len(all_clips)} clips selected")

            if not all_clips:
                print("No valid clips returned by Claude. Exiting.", file=sys.stderr)
                sys.exit(1)

            _save_clip_plan(supabase_admin, args.video_id, all_clips)

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
                try:
                    cut_and_subtitle(full_video_path, start_s, duration, clip_words, clip_path, i, tmpdir)
                except Exception as e:
                    print(f"  cut_and_subtitle failed ({e}), retrying without subtitles...")
                    cut_and_subtitle(full_video_path, start_s, duration, [], clip_path, i, tmpdir)

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
