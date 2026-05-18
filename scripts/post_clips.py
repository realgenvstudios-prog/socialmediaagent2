"""
Posts the next pending clip from the queue to Instagram and TikTok via Zernio.
Run 3x per day via GitHub Actions (9am, 1pm, 6pm UTC).

For each platform, grabs the oldest pending clip and posts it.
Marks it as posted (or failed) and cleans up Supabase Storage when both platforms are done.
"""

import os
import sys
import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(override=True)

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
ZERNIO_API_KEY = os.environ["ZERNIO_API_KEY"]
INSTAGRAM_ACCOUNT_ID = os.environ["INSTAGRAM_ACCOUNT_ID"]
TIKTOK_ACCOUNT_ID = os.environ["TIKTOK_ACCOUNT_ID"]

ZERNIO_BASE = "https://zernio.com/api/v1"
ZERNIO_HEADERS = {
    "Authorization": f"Bearer {ZERNIO_API_KEY}",
    "Content-Type": "application/json",
}


def get_next_clip(supabase_admin, platform):
    result = (
        supabase_admin.table("clip_queue")
        .select("*")
        .eq("platform", platform)
        .eq("status", "pending")
        .order("created_at")
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def build_instagram_payload(clip):
    return {
        "content": clip["caption"],
        "mediaItems": [{"type": "video", "url": clip["public_url"]}],
        "platforms": [
            {
                "platform": "instagram",
                "accountId": INSTAGRAM_ACCOUNT_ID,
                "platformSpecificData": {
                    "contentType": "reels",
                    "shareToFeed": True,
                },
            }
        ],
        "publishNow": True,
    }


def build_tiktok_payload(clip):
    return {
        "content": clip["caption"],
        "mediaItems": [{"type": "video", "url": clip["public_url"]}],
        "platforms": [
            {
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
            }
        ],
        "publishNow": True,
    }


def post_to_zernio(payload):
    resp = requests.post(
        f"{ZERNIO_BASE}/posts",
        headers=ZERNIO_HEADERS,
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
    """Delete clip from Supabase Storage once both platforms have posted it."""
    remaining = (
        supabase_admin.table("clip_queue")
        .select("id", count="exact")
        .eq("video_id", video_id)
        .eq("clip_index", clip_index)
        .eq("status", "pending")
        .execute()
    )
    if remaining.count == 0:
        try:
            supabase_admin.storage.from_("clips").remove([storage_path])
            print(f"  Deleted from storage: {storage_path}")
        except Exception as e:
            print(f"  Storage cleanup skipped: {e}")


def main():
    supabase_admin = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    posted_any = False

    for platform in ["instagram", "tiktok"]:
        clip = get_next_clip(supabase_admin, platform)

        if not clip:
            print(f"{platform}: no pending clips in queue.")
            continue

        print(f"\n{platform.upper()}: posting clip {clip['clip_index']} from video {clip['video_id']}")
        print(f"  Caption: {clip['caption'][:80]}...")

        if platform == "instagram":
            payload = build_instagram_payload(clip)
        else:
            payload = build_tiktok_payload(clip)

        status_code, response = post_to_zernio(payload)

        # Zernio returns the post object with an id on success
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

    if not posted_any:
        print("\nNo clips were posted this run.")

    # Summary of remaining queue
    remaining = (
        supabase_admin.table("clip_queue")
        .select("platform", count="exact")
        .eq("status", "pending")
        .execute()
    )
    print(f"\nClips remaining in queue: {remaining.count}")


if __name__ == "__main__":
    main()
