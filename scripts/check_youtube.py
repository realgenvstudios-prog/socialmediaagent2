"""
Checks the Konnected Minds YouTube channel for new videos.
If a new video is found that hasn't been processed yet, triggers process_video.py.
Run hourly via GitHub Actions or locally.
"""

import os
import sys
import subprocess
import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(override=True)

YOUTUBE_API_KEY = os.environ["YOUTUBE_API_KEY"]
CHANNEL_ID = os.environ["CHANNEL_ID"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]


def get_recent_long_videos(max_results=5):
    """Return up to max_results long-form videos (>20 min) ordered by date."""
    resp = requests.get(
        "https://www.googleapis.com/youtube/v3/search",
        params={
            "key": YOUTUBE_API_KEY,
            "channelId": CHANNEL_ID,
            "part": "id,snippet",
            "order": "date",
            "maxResults": max_results,
            "type": "video",
            "videoDuration": "long",  # only videos longer than 20 minutes
        },
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()

    videos = []
    for item in data.get("items", []):
        videos.append({
            "video_id": item["id"]["videoId"],
            "title": item["snippet"]["title"],
            "url": f"https://www.youtube.com/watch?v={item['id']['videoId']}",
        })
    return videos


def is_already_processed(supabase, video_id):
    result = (
        supabase.table("processed_videos")
        .select("video_id")
        .eq("video_id", video_id)
        .execute()
    )
    return len(result.data) > 0


def main():
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

    print("Checking for new Konnected Minds videos (long-form only)...")
    videos = get_recent_long_videos(max_results=5)

    if not videos:
        print("No long-form videos found on channel.")
        return

    new_videos = [v for v in videos if not is_already_processed(supabase, v["video_id"])]

    if not new_videos:
        print(f"All {len(videos)} recent videos already processed.")
        pending = (
            supabase.table("clip_queue")
            .select("id", count="exact")
            .eq("status", "pending")
            .execute()
        )
        print(f"Clips still in queue: {pending.count}")
        return

    print(f"{len(new_videos)} new video(s) found. Processing...")

    for video in new_videos:
        print(f"\nProcessing: {video['title']} ({video['video_id']})")
        result = subprocess.run(
            [
                sys.executable,
                "scripts/process_video.py",
                "--video_id", video["video_id"],
                "--url", video["url"],
                "--title", video["title"],
            ],
            check=False,
        )
        if result.returncode == 0:
            print(f"  Done: {video['video_id']}")
        else:
            print(f"  FAILED: {video['video_id']}", file=sys.stderr)


if __name__ == "__main__":
    main()
