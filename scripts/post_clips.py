"""
Posts the next pending clip from the queue to Instagram, TikTok, and YouTube Shorts via Zernio.
Run 3x per day via GitHub Actions (9am, 1pm, 6pm UTC).

For each platform, grabs the oldest pending clip and posts it.
Marks it as posted (or failed) and cleans up Supabase Storage when all platforms are done.
"""

import os
import sys
import requests
from dotenv import load_dotenv
from db import create_client

load_dotenv(override=True)
ZERNIO_API_KEY = os.environ["ZERNIO_API_KEY"]
ZERNIO_API_KEY_2 = os.environ["ZERNIO_API_KEY_2"]
INSTAGRAM_ACCOUNT_ID = os.environ["INSTAGRAM_ACCOUNT_ID"]
TIKTOK_ACCOUNT_ID = os.environ["TIKTOK_ACCOUNT_ID"]
YOUTUBE_ACCOUNT_ID = os.environ["YOUTUBE_ACCOUNT_ID"]
FACEBOOK_ACCOUNT_ID = os.environ["FACEBOOK_ACCOUNT_ID"]

ZERNIO_BASE = "https://zernio.com/api/v1"

ZERNIO_HEADERS_1 = {
    "Authorization": f"Bearer {ZERNIO_API_KEY}",
    "Content-Type": "application/json",
}
ZERNIO_HEADERS_2 = {
    "Authorization": f"Bearer {ZERNIO_API_KEY_2}",
    "Content-Type": "application/json",
}

PLATFORM_HEADERS = {
    "instagram": ZERNIO_HEADERS_1,
    "tiktok": ZERNIO_HEADERS_1,
    "youtube": ZERNIO_HEADERS_2,
    "facebook": ZERNIO_HEADERS_2,
}


def get_failed_clips(supabase_admin, platform, max_age_hours=24):
    """Return failed clips from the last 24h that are worth retrying."""
    from datetime import datetime, timezone, timedelta
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=max_age_hours)).isoformat()
    result = (
        supabase_admin.table("clip_queue")
        .select("*")
        .eq("platform", platform)
        .eq("status", "failed")
        .gte("created_at", cutoff)
        .order("created_at")
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def reset_to_pending(supabase_admin, clip_id):
    supabase_admin.table("clip_queue").update({"status": "pending"}).eq("id", clip_id).execute()


def get_next_clip(supabase_admin, platform, video_id=None):
    q = (
        supabase_admin.table("clip_queue")
        .select("*")
        .eq("platform", platform)
        .eq("status", "pending")
    )
    if video_id:
        q = q.eq("video_id", video_id)
    result = q.order("created_at").limit(1).execute()
    return result.data[0] if result.data else None


def build_caption(clip, platform):
    base = clip["caption"] or ""
    vid = clip["video_id"]
    if platform in ("instagram", "tiktok"):
        link = f"\n\nWatch full episode → youtu.be/{vid}"
    else:
        link = f"\n\nFull episode: https://youtu.be/{vid}"
    return base + link


def build_payload(clip, platform):
    caption = build_caption(clip, platform)
    if platform == "instagram":
        return {
            "content": caption,
            "mediaItems": [{"type": "video", "url": clip["public_url"]}],
            "platforms": [{
                "platform": "instagram",
                "accountId": INSTAGRAM_ACCOUNT_ID,
                "platformSpecificData": {
                    "contentType": "reels",
                    "shareToFeed": True,
                },
            }],
            "publishNow": True,
        }
    elif platform == "tiktok":
        return {
            "content": caption,
            "mediaItems": [{"type": "video", "url": clip["public_url"]}],
            "platforms": [{
                "platform": "tiktok",
                "accountId": TIKTOK_ACCOUNT_ID,
                "tiktokSettings": {
                    "privacy_level": "PUBLIC_TO_EVERYONE",
                    "allow_comment": True,
                    "allow_duet": True,
                    "allow_stitch": True,
                    "content_preview_confirmed": True,
                    "express_consent_given": True,
                },
            }],
            "publishNow": True,
        }
    elif platform == "youtube":
        return {
            "content": caption,
            "mediaItems": [{"type": "video", "url": clip["public_url"]}],
            "platforms": [{
                "platform": "youtube",
                "accountId": YOUTUBE_ACCOUNT_ID,
                "youtubeSettings": {
                    "title": clip.get("hook", clip["caption"][:100]),
                    "privacyStatus": "public",
                    "isShort": True,
                },
            }],
            "publishNow": True,
        }
    elif platform == "facebook":
        return {
            "content": caption,
            "mediaItems": [{"type": "video", "url": clip["public_url"]}],
            "platforms": [{
                "platform": "facebook",
                "accountId": FACEBOOK_ACCOUNT_ID,
                "platformSpecificData": {
                    "contentType": "reels",
                },
            }],
            "publishNow": True,
        }


def post_to_zernio(payload, platform):
    resp = requests.post(
        f"{ZERNIO_BASE}/posts",
        headers=PLATFORM_HEADERS[platform],
        json=payload,
        timeout=300,
    )
    return resp.status_code, resp.json()


def mark_posted(supabase_admin, clip_id, zernio_post_id):
    from datetime import datetime, timezone
    supabase_admin.table("clip_queue").update({
        "status": "posted",
        "posted_at": datetime.now(timezone.utc).isoformat(),
        "zernio_post_id": str(zernio_post_id),
    }).eq("id", clip_id).execute()


def mark_failed(supabase_admin, clip_id):
    supabase_admin.table("clip_queue").update({"status": "failed"}).eq("id", clip_id).execute()


def cleanup_storage_if_done(supabase_admin, video_id, clip_index, storage_path):
    """No-op at post time — platforms download async. Cleanup runs via cleanup_old_clips()."""
    pass


def cleanup_old_clips(supabase_admin):
    """
    Delete video files from Supabase Storage for clips that:
    - Are posted on ALL 4 platforms
    - Were posted more than 48 hours ago (platforms have had time to download)
    Keeps storage_path in DB as None so we don't retry deleted files.
    """
    from datetime import datetime, timezone, timedelta
    from collections import defaultdict

    cutoff = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()

    result = (
        supabase_admin.table("clip_queue")
        .select("video_id, clip_index, platform, status, storage_path, posted_at")
        .eq("status", "posted")
        .lt("posted_at", cutoff)
        .not_.is_("storage_path", "null")
        .execute()
    )

    groups = defaultdict(list)
    for row in (result.data or []):
        groups[(row["video_id"], row["clip_index"])].append(row)

    deleted = 0
    REQUIRED = {"instagram", "tiktok", "youtube", "facebook"}
    for (video_id, clip_index), rows in groups.items():
        posted_platforms = {r["platform"] for r in rows}
        if not REQUIRED.issubset(posted_platforms):
            continue

        storage_path = rows[0].get("storage_path")
        if not storage_path:
            continue

        try:
            supabase_admin.storage.from_("clips").remove([storage_path])
            supabase_admin.table("clip_queue").update({"storage_path": None}).eq("video_id", video_id).eq("clip_index", clip_index).execute()
            deleted += 1
        except Exception as e:
            print(f"  Storage cleanup warning ({storage_path}): {e}")

    if deleted > 0:
        print(f"  Cleaned {deleted} old clip file(s) from storage.")


def is_paused(supabase_admin):
    """Return True if posting has been manually paused from the dashboard."""
    result = supabase_admin.table("settings").select("value").eq("key", "paused").execute()
    if not result.data:
        return False
    return bool(result.data[0]["value"].get("paused", False))


def is_posting_time(supabase_admin):
    """Check Supabase settings table to see if the current UTC hour should post."""
    from datetime import datetime, timezone
    result = supabase_admin.table("settings").select("value").eq("key", "schedule").execute()
    if not result.data:
        return True  # no settings row = always post (fallback)
    schedule = result.data[0]["value"]
    allowed_times = schedule.get("times", ["09:00", "13:00", "18:00"])
    current_hour = datetime.now(timezone.utc).strftime("%H:00")
    return current_hour in allowed_times


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="Post immediately, bypassing schedule check")
    parser.add_argument("--video_id", default=None, help="Only post clips from this specific video_id")
    args = parser.parse_args()

    supabase_admin = create_client()

    # Pause check always runs — not bypassed by --force
    if is_paused(supabase_admin):
        print("Posting is paused from the dashboard. Skipping.")
        return

    if not args.force and not is_posting_time(supabase_admin):
        from datetime import datetime, timezone
        print(f"Not a scheduled posting time ({datetime.now(timezone.utc).strftime('%H:00')} UTC). Skipping.")
        return

    posted_any = False

    for platform in ["instagram", "tiktok", "youtube", "facebook"]:
        clip = get_next_clip(supabase_admin, platform, video_id=args.video_id)

        if not clip:
            print(f"{platform}: no pending clips in queue.")
            continue

        print(f"\n{platform.upper()}: posting clip {clip['clip_index']} from video {clip['video_id']}")
        print(f"  Caption: {clip['caption'][:80]}...")

        payload = build_payload(clip, platform)
        status_code, response = post_to_zernio(payload, platform)

        post_obj = response.get("post", {})
        post_id = (
            response.get("id")
            or post_obj.get("id")
            or post_obj.get("_id")
            or response.get("_id")
        )

        # 409 = duplicate: already posted in the last 24h — treat as success
        if status_code == 409:
            existing_id = response.get("details", {}).get("existingPostId", "duplicate")
            mark_posted(supabase_admin, clip["id"], existing_id)
            print(f"  Already posted (duplicate). Marked as posted: {existing_id}")
            cleanup_storage_if_done(supabase_admin, clip["video_id"], clip["clip_index"], clip["storage_path"])
            posted_any = True
        elif status_code in (200, 201) and post_id:
            mark_posted(supabase_admin, clip["id"], post_id)
            print(f"  Posted! Zernio post ID: {post_id}")
            cleanup_storage_if_done(supabase_admin, clip["video_id"], clip["clip_index"], clip["storage_path"])
            posted_any = True
        else:
            mark_failed(supabase_admin, clip["id"])
            print(f"  FAILED (HTTP {status_code}): {response}", file=sys.stderr)

    # Always check for failed clips to retry — not just when nothing posted
    print("\nChecking for failed clips to retry...")
    retried = 0
    for platform in ["instagram", "tiktok", "youtube", "facebook"]:
        clip = get_failed_clips(supabase_admin, platform)
        if clip:
            print(f"  Retrying {platform} clip {clip['clip_index']} from {clip['video_id']}")
            reset_to_pending(supabase_admin, clip["id"])
            retried += 1
    if retried == 0:
        print("  No failed clips to retry.")

    remaining = (
        supabase_admin.table("clip_queue")
        .select("platform", count="exact")
        .eq("status", "pending")
        .execute()
    )
    print(f"\nClips remaining in queue: {remaining.count}")

    cleanup_old_clips(supabase_admin)


if __name__ == "__main__":
    main()
