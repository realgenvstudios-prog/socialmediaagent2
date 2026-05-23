"""
Checks the Konnected Minds YouTube channel for new videos.
If a new long-form video is found that hasn't been processed yet,
triggers the process_manual.yml GitHub Actions workflow automatically.
Run hourly via GitHub Actions.
"""

import os
import re
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

MIN_DURATION_SECONDS = 20 * 60  # 20 minutes


def parse_iso8601_duration(duration: str) -> int:
    """Convert ISO 8601 duration (e.g. PT1H28M33S) to total seconds."""
    match = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', duration)
    if not match:
        return 0
    h = int(match.group(1) or 0)
    m = int(match.group(2) or 0)
    s = int(match.group(3) or 0)
    return h * 3600 + m * 60 + s


def _fetch_durations(video_ids: list) -> dict:
    """Batch-fetch durations for a list of video IDs. Returns {id: seconds}."""
    if not video_ids:
        return {}
    resp = requests.get(
        "https://www.googleapis.com/youtube/v3/videos",
        params={
            "key": YOUTUBE_API_KEY,
            "id": ",".join(video_ids),
            "part": "contentDetails,snippet",
        },
        timeout=10,
    )
    resp.raise_for_status()
    result = {}
    for item in resp.json().get("items", []):
        result[item["id"]] = {
            "duration": parse_iso8601_duration(item["contentDetails"]["duration"]),
            "title": item["snippet"]["title"],
            "channel_id": item["snippet"]["channelId"],
        }
    return result


def _get_from_uploads_playlist(max_results=5):
    """Primary source: uploads playlist. Instant — no indexing delay."""
    uploads_playlist_id = "UU" + CHANNEL_ID[2:]
    resp = requests.get(
        "https://www.googleapis.com/youtube/v3/playlistItems",
        params={
            "key": YOUTUBE_API_KEY,
            "playlistId": uploads_playlist_id,
            "part": "snippet",
            "maxResults": 30,
        },
        timeout=10,
    )
    resp.raise_for_status()
    items = resp.json().get("items", [])

    ordered_ids = []
    meta = {}
    for item in items:
        vid_id = item["snippet"]["resourceId"]["videoId"]
        ordered_ids.append(vid_id)
        meta[vid_id] = {
            "video_id": vid_id,
            "title": item["snippet"]["title"],
            "url": f"https://www.youtube.com/watch?v={vid_id}",
        }

    if not ordered_ids:
        return []

    details = _fetch_durations(ordered_ids)
    long_videos = []
    for vid_id in ordered_ids:
        if details.get(vid_id, {}).get("duration", 0) >= MIN_DURATION_SECONDS:
            long_videos.append(meta[vid_id])
        if len(long_videos) >= max_results:
            break
    return long_videos


def _get_from_search_fallback(seen_ids: set, max_results=5):
    """Fallback: search API catches collab videos and delayed-index uploads.
    Only returns videos NOT already in seen_ids to avoid duplicates.
    """
    resp = requests.get(
        "https://www.googleapis.com/youtube/v3/search",
        params={
            "key": YOUTUBE_API_KEY,
            "channelId": CHANNEL_ID,
            "part": "id,snippet",
            "order": "date",
            "maxResults": 15,
            "type": "video",
            "videoDuration": "long",
        },
        timeout=10,
    )
    resp.raise_for_status()

    candidate_ids = [
        item["id"]["videoId"]
        for item in resp.json().get("items", [])
        if item["id"]["videoId"] not in seen_ids
    ]

    if not candidate_ids:
        return []

    details = _fetch_durations(candidate_ids)
    long_videos = []
    for vid_id in candidate_ids:
        info = details.get(vid_id, {})
        if info.get("duration", 0) >= MIN_DURATION_SECONDS:
            long_videos.append({
                "video_id": vid_id,
                "title": info.get("title", ""),
                "url": f"https://www.youtube.com/watch?v={vid_id}",
            })
        if len(long_videos) >= max_results:
            break
    return long_videos


def get_recent_long_videos(max_results=5):
    """Return up to max_results long-form videos (>20 min) ordered by date.

    Hybrid: uploads playlist (instant) + search API fallback (catches collab
    videos and uploads that haven't propagated to the playlist yet).
    Results are deduplicated.
    """
    playlist_videos = _get_from_uploads_playlist(max_results)
    seen_ids = {v["video_id"] for v in playlist_videos}

    fallback_videos = _get_from_search_fallback(seen_ids, max_results)

    all_videos = playlist_videos + fallback_videos
    print(f"  Playlist: {len(playlist_videos)} long videos | Search fallback: {len(fallback_videos)} additional")
    return all_videos[:max_results * 2]  # cap to avoid triggering too many at once


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

    print(f"{len(new_videos)} unprocessed video(s) found:")
    for video in new_videos:
        print(f"  • {video['title']} ({video['video_id']})")

    # Only trigger the most recent one per run — prevents hammering GitHub Actions
    # with concurrent runs when multiple videos are unprocessed at once.
    video = new_videos[0]
    print(f"\nTriggering: {video['title']}")
    if not trigger_workflow(video):
        sys.exit(1)
    if len(new_videos) > 1:
        print(f"  ({len(new_videos) - 1} more unprocessed — will pick up on next run)")


if __name__ == "__main__":
    main()
