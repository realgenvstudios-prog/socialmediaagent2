"""
Reburn subtitles on pending clips using the cached transcript.
Re-downloads each clip section from YouTube, burns subtitles with the fixed font,
uploads as clip_N_v2.mp4, and updates the public_url in clip_queue.

Usage:
  python scripts/reburn_clips.py --video_id xwLrHUwGtJM --url URL --title "Title"
"""

import os
import sys
import json
import argparse
import tempfile

from dotenv import load_dotenv
from supabase import create_client
import anthropic

load_dotenv(override=True)

sys.path.insert(0, os.path.dirname(__file__))
import importlib.util
spec = importlib.util.spec_from_file_location("pv", os.path.join(os.path.dirname(__file__), "process_video.py"))
pv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pv)

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video_id", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--title", required=True)
    args = parser.parse_args()

    supabase_admin = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    anthropic_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    # Find which clip indices are still pending
    pending_rows = supabase_admin.table("clip_queue").select("clip_index,platform,status").eq("video_id", args.video_id).eq("status", "pending").execute()
    pending_indices = sorted(set(r["clip_index"] for r in pending_rows.data))
    if not pending_indices:
        print("No pending clips found — nothing to do.")
        return
    print(f"Pending clip indices: {pending_indices}")

    # Load cached transcript
    transcript_cache = f"transcripts/{args.video_id}.json"
    if not os.path.exists(transcript_cache):
        print(f"No transcript cache at {transcript_cache} — run process_video.py first.", file=sys.stderr)
        sys.exit(1)

    with open(transcript_cache) as f:
        cached = json.load(f)
    segments = cached["segments"]
    words = cached["words"]
    print(f"Transcript loaded: {len(segments)} segments, {len(words)} words")

    # Re-run Claude clip selection to get timings
    print("\n[Claude] Re-selecting clips to get timings...")
    clips = pv.select_clips(anthropic_client, segments, args.title, supabase=supabase_admin)
    print(f"  {len(clips)} clips selected")
    for i, clip in enumerate(clips):
        print(f"  [{i}] {pv.to_hhmmss(clip['start_seconds'])} → {pv.to_hhmmss(clip['end_seconds'])} | {clip['hook'][:60]}")

    with tempfile.TemporaryDirectory() as tmpdir:
        for idx in pending_indices:
            if idx >= len(clips):
                print(f"\n  [SKIP] clip_index {idx} — Claude only returned {len(clips)} clips")
                continue

            clip = clips[idx]
            start_s = clip["start_seconds"]
            end_s = clip["end_seconds"]
            duration = end_s - start_s

            section_path = os.path.join(tmpdir, f"section_{idx}.mp4")
            clip_path = os.path.join(tmpdir, f"{args.video_id}_clip_{idx}.mp4")
            storage_path = f"{args.video_id}/{args.video_id}_clip_{idx}_v2.mp4"

            print(f"\n[{idx}] {pv.to_hhmmss(start_s)} → {pv.to_hhmmss(end_s)} ({duration:.0f}s)")
            print(f"  Downloading section...")
            offset = pv.download_section(args.url, start_s, end_s, section_path)

            clip_words = pv.words_for_clip(words, start_s, end_s)
            print(f"  Cutting, cropping, burning subtitles ({len(clip_words)} words)...")
            pv.cut_and_subtitle(section_path, offset, duration, clip_words, clip_path, idx, tmpdir)
            os.remove(section_path)

            clip_mb = os.path.getsize(clip_path) / 1024 / 1024
            print(f"  Uploading ({clip_mb:.1f}MB) as {storage_path}...")
            public_url = pv.upload_clip(supabase_admin, clip_path, storage_path)
            print(f"  Uploaded: {public_url[:70]}...")

            # Update all pending rows for this clip_index with the new URL
            supabase_admin.table("clip_queue").update({
                "public_url": public_url,
                "storage_path": storage_path,
            }).eq("video_id", args.video_id).eq("clip_index", idx).eq("status", "pending").execute()
            print(f"  DB updated for clip_index={idx}")

    print(f"\n✓ Done. Re-burned {len(pending_indices)} clips with fixed subtitles.")


if __name__ == "__main__":
    main()
