"""
Checks the Konnected Minds YouTube channel for new videos.
If a new long-form video is found that hasn't been processed yet,
triggers the process_manual.yml GitHub Actions workflow automatically.
Run hourly via GitHub Actions.
"""

import os
import sys
import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(override=True)

YOUTUBE_API_KEY = os.environ["YOUTUBE_API_KEY"]
CHANNEL_ID = os.environ["CHANNEL_ID"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ["SUPABASE_KEY"]
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
GITHUB_OWNER = os.environ.get("GITHUB_OWNER")
GITHUB_REPO  = os.environ.get("GITHUB_REPO")


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


def trigger_workflow(video):
    """Dispatch process_manual.yml for this video via the GitHub API."""
    if not all([GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO]):
        print("  GitHub credentials not set — cannot auto-trigger workflow.")
        return False

    resp = requests.post(
        f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/actions/workflows/process_manual.yml/dispatches",
        headers={
            "Authorization": f"Bearer {GITHUB_TOKEN}",
            "Accept": "application/vnd.github+json",
        },
        json={
            "ref": "main",
            "inputs": {
                "video_id":    video["video_id"],
                "video_url":   video["url"],
                "video_title": video["title"],
            },
        },
        timeout=15,
    )
    if resp.status_code == 204:
        print(f"  Workflow triggered for: {video['title']}")
        return True
    else:
        print(f"  Failed to trigger workflow: {resp.status_code} {resp.text[:120]}")
        return False


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

    print(f"{len(new_videos)} new video(s) found:")
    for video in new_videos:
        print(f"  • {video['title']} ({video['video_id']})")

    print()
    triggered = 0
    for video in new_videos:
        if trigger_workflow(video):
            triggered += 1

    print(f"\nTriggered processing for {triggered}/{len(new_videos)} video(s).")
    if triggered < len(new_videos):
        sys.exit(1)


if __name__ == "__main__":
    main()
