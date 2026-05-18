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


def get_latest_video():
    resp = requests.get(
        "https://www.googleapis.com/youtube/v3/search",
        params={
            "key": YOUTUBE_API_KEY,
            "channelId": CHANNEL_ID,
            "part": "id,snippet",
            "order": "date",
            "maxResults": 1,
            "type": "video",
        },
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()

    if not data.get("items"):
        return None

    item = data["items"][0]
    return {
        "video_id": item["id"]["videoId"],
        "title": item["snippet"]["title"],
        "url": f"https://www.youtube.com/watch?v={item['id']['videoId']}",
    }


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

    print("Checking for new Konnected Minds videos...")
    video = get_latest_video()

    if not video:
        print("No videos found on channel.")
        return

    print(f"Latest video: {video['title']} ({video['video_id']})")

    if is_already_processed(supabase, video["video_id"]):
        print("Already processed. Nothing to do.")
        # Check if we still have clips queued
        pending = (
            supabase.table("clip_queue")
            .select("id", count="exact")
            .eq("status", "pending")
            .execute()
        )
        print(f"Clips still in queue: {pending.count}")
        return

    print(f"New video found! Starting processing pipeline...")
    result = subprocess.run(
        [
            sys.executable,
            "scripts/process_video.py",
            "--video_id", video["video_id"],
            "--url", video["url"],
            "--title", video["title"],
        ],
        check=True,
    )

    if result.returncode == 0:
        print("Processing complete.")
    else:
        print("Processing failed.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
