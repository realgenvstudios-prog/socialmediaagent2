"""
Full clip generation pipeline for a single YouTube video.

Efficient two-pass download strategy:
  Pass 1 — Audio only (~40MB): transcribe with faster-whisper, save transcript to disk
  Pass 2 — Per-clip sections only (~15MB each): download just the 30-90s needed per clip

Steps:
  1. Download audio only
  2. Transcribe locally with faster-whisper
  3. Claude reads transcript and picks 6 viral clip moments (with timestamps)
  4. For each clip: download just that section at 720p → crop 9:16 → upload → queue
  5. Mark video as processed

Usage:
  python scripts/process_video.py --video_id VIDEO_ID --url URL --title "Title"
"""

import os
import sys
import json
import argparse
import subprocess
import tempfile
from pathlib import Path

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

def download_audio_only(url, output_dir):
    """Download just the audio stream — ~40MB for a 40-min podcast."""
    output_path = os.path.join(output_dir, "audio.%(ext)s")
    subprocess.run(
        [
            "yt-dlp",
            "-f", "bestaudio[ext=m4a]/bestaudio",
            "--no-playlist",
            "-o", output_path,
            url,
        ],
        check=True,
    )
    matches = list(Path(output_dir).glob("audio.*"))
    if not matches:
        raise RuntimeError("yt-dlp audio download produced no output file")
    return str(matches[0])


def download_section(url, start_s, end_s, output_path):
    """
    Download only a specific time section at 720p.
    Adds a 3-second buffer on each side so FFmpeg can cut cleanly at a keyframe.
    Returns the in-file offset (seconds) where the actual clip starts.
    """
    buffer = 3
    sec_start = max(0, start_s - buffer)
    sec_end = end_s + buffer
    section_arg = f"*{to_hhmmss(sec_start)}-{to_hhmmss(sec_end)}"

    subprocess.run(
        [
            "yt-dlp",
            "-f", "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]",
            "--merge-output-format", "mp4",
            "--download-sections", section_arg,
            "--force-keyframes-at-cuts",
            "--no-playlist",
            "-o", output_path,
            url,
        ],
        check=True,
    )
    return start_s - sec_start  # offset within the downloaded section


# ── Transcription ──────────────────────────────────────────────────────────────

def transcribe(audio_path):
    """Transcribe audio locally with faster-whisper. No API key, no size limit."""
    print(f"  Loading Whisper {WHISPER_MODEL} model...")
    model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    print("  Transcribing (takes a few minutes for long audio)...")
    raw_segments, info = model.transcribe(audio_path, beam_size=5)
    segments = [
        {"start": s.start, "end": s.end, "text": s.text.strip()}
        for s in raw_segments
    ]
    print(f"  Language: {info.language} ({info.language_probability:.0%} confidence)")
    return segments


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

    prompt = f"""You are an expert viral short-form content strategist who deeply understands what makes people stop scrolling and watch a clip all the way through.

Your job: find the 10 to 12 best moments in this podcast transcript to clip for Instagram Reels, TikTok, YouTube Shorts, and Facebook Reels.

Video title: {video_title}

Transcript (with timestamps):
{transcript_text}

━━━ CLIP SELECTION RULES ━━━

LENGTH — Target 45 to 65 seconds per clip. This is the proven sweet spot across all 4 platforms for completion rate. Never go below 30 seconds (too thin) or above 90 seconds (completion rate drops off sharply). Tighter is better — cut any dead air from the start or end.

THE HOOK (first 3 seconds) — This is the single most important part. The algorithm decides whether to push a clip based on how many people watch past 3 seconds. A good hook is one of:
  • A shocking or counterintuitive statement ("I made $0 from that viral video")
  • A question that creates instant curiosity ("Why did she never get paid?")
  • A cliffhanger opener ("What happened next changed everything")
  • A bold claim or confession ("I was wrong about this for 10 years")
  Never start a clip mid-thought, with filler words ("So...", "Um...", "Like I said"), or with slow context-setting.

CONTENT — Each clip must contain ONE complete self-contained idea, story, or revelation. No clip should feel like it was cut out of context. Prioritise moments that are:
  • Emotionally charged (anger, surprise, inspiration, heartbreak)
  • Story-driven with a clear arc (setup → tension → payoff)
  • Controversial or opinion-driven (sparks comments and shares)
  • Deeply relatable or universally human
  • Revealing something people didn't know or expect

ALGORITHM SIGNALS — Pick moments likely to drive:
  • Replays (a punchline, stat, or twist people want to hear again)
  • Shares (something so good people want to send it to a friend)
  • Saves (practical insight or advice people want to come back to)
  • Comments (a take that people agree or disagree with strongly)

VARIETY — Spread clips across the full video. Do not cluster them all in one section. Each clip must cover a different topic or story beat — no overlapping content.

━━━ CAPTION RULES ━━━

Write platform-specific captions for each clip:

instagram: 2–3 punchy sentences that expand on the hook and tease what they'll learn. End with 5–8 relevant hashtags on a new line. Tone: direct, energetic, slightly dramatic.

tiktok: 1–2 very casual sentences. Sounds like a person talking, not a brand. 3–5 hashtags maximum. Tone: conversational, raw, unpolished.

youtube: A standalone title that works as a YouTube Shorts title (max 80 characters). Must create curiosity or promise a specific payoff. No hashtags. Capitalise like a headline.

facebook: 2–3 sentences written for a slightly older, more conversational Facebook audience. More context than TikTok, less hype than Instagram. No hashtags.

━━━ OUTPUT FORMAT ━━━

Return ONLY a valid JSON array. No markdown, no explanation, no intro text — just the raw JSON starting with [ and ending with ].

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

    msg = anthropic_client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4000,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = msg.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    raw = raw.strip()

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

def cut_clip(section_path, offset_seconds, duration, output_path):
    """Cut from the downloaded section and crop to 9:16 vertical."""
    subprocess.run(
        [
            "ffmpeg",
            "-ss", str(offset_seconds),
            "-i", section_path,
            "-t", str(duration),
            "-vf", "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920",
            "-c:v", "libx264", "-crf", "23", "-preset", "fast",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            output_path, "-y",
        ],
        check=True,
        capture_output=True,
    )


def upload_clip(supabase, local_path, storage_path):
    """Upload to Supabase Storage public bucket, return public URL."""
    with open(local_path, "rb") as f:
        data = f.read()
    supabase.storage.from_("clips").upload(
        path=storage_path,
        file=data,
        file_options={"content-type": "video/mp4", "upsert": "true"},
    )
    return supabase.storage.from_("clips").get_public_url(storage_path)


def queue_clip(supabase, video_id, clip_index, storage_path, public_url, caption, hook, platform):
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

        # ── PASS 1: Audio → Transcript ─────────────────────────────────────────
        if os.path.exists(transcript_cache):
            print(f"\n[CACHED] Loading transcript from disk — skipping download + transcription")
            with open(transcript_cache) as f:
                segments = json.load(f)
            print(f"  {len(segments)} segments loaded")
        else:
            print(f"\n[1/2 downloads] Audio only from: {args.url}")
            audio_path = download_audio_only(args.url, tmpdir)
            size_mb = os.path.getsize(audio_path) / 1024 / 1024
            print(f"  Downloaded audio: {size_mb:.1f}MB")

            print("[Transcribing]")
            segments = transcribe(audio_path)
            print(f"  {len(segments)} transcript segments")

            with open(transcript_cache, "w") as f:
                json.dump(segments, f)
            print(f"  Transcript cached to {transcript_cache}")

        # ── Claude picks clips ─────────────────────────────────────────────────
        print("\n[Claude] Selecting viral clips from transcript...")
        clips = select_clips(anthropic_client, segments, args.title)
        print(f"  {len(clips)} clips selected\n")

        if not clips:
            print("No valid clips returned by Claude. Exiting.", file=sys.stderr)
            sys.exit(1)

        for i, clip in enumerate(clips):
            print(f"  Clip {i+1}: {to_hhmmss(clip['start_seconds'])} → {to_hhmmss(clip['end_seconds'])} | {clip['hook'][:65]}")

        # ── PASS 2: Download each clip section → cut → upload → queue ──────────
        print(f"\n[2/2 downloads] Downloading {len(clips)} clip sections at 720p...")
        for i, clip in enumerate(clips):
            start_s = clip["start_seconds"]
            end_s = clip["end_seconds"]
            duration = end_s - start_s

            section_path = os.path.join(tmpdir, f"section_{i}.mp4")
            clip_path = os.path.join(tmpdir, f"{args.video_id}_clip_{i}.mp4")
            storage_path = f"{args.video_id}/{args.video_id}_clip_{i}.mp4"

            print(f"\n  [{i+1}/{len(clips)}] {to_hhmmss(start_s)} → {to_hhmmss(end_s)} ({duration:.0f}s)")
            print(f"  Downloading section...")
            offset = download_section(args.url, start_s, end_s, section_path)

            print(f"  Cutting and cropping to 9:16...")
            cut_clip(section_path, offset, duration, clip_path)
            os.remove(section_path)  # free space immediately

            clip_mb = os.path.getsize(clip_path) / 1024 / 1024
            print(f"  Uploading ({clip_mb:.1f}MB)...")
            public_url = upload_clip(supabase_admin, clip_path, storage_path)

            captions = clip.get("captions", {})
            for platform in ["instagram", "tiktok", "youtube", "facebook"]:
                caption = captions.get(platform) or clip.get("caption", "")
                queue_clip(supabase_admin, args.video_id, i, storage_path, public_url, caption, clip.get("hook", ""), platform)

            print(f"  Queued: {public_url[:60]}...")

        # ── Mark processed ─────────────────────────────────────────────────────
        supabase_admin.table("processed_videos").insert({
            "video_id": args.video_id,
            "video_title": args.title,
            "channel_id": CHANNEL_ID,
            "clip_count": len(clips),
        }).execute()

        platforms = ["instagram", "tiktok", "youtube", "facebook"]
        total_posts = len(clips) * len(platforms)
        print(f"\n✓ Done. {len(clips)} clips queued — {total_posts} posts scheduled across {', '.join(p.capitalize() for p in platforms)}.")


if __name__ == "__main__":
    main()
