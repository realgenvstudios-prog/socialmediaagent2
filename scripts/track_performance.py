"""
Daily performance tracking job.
Fetches engagement metrics from Zernio for every posted clip in the last 30 days.
Stores one snapshot per day per clip in clip_performance — builds a time-series
dataset that gets richer every week and feeds back into clip selection over time.

Runs daily via GitHub Actions (no YouTube access needed — Zernio only).
"""

import os
import sys
import requests
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv
from db import create_client

load_dotenv(override=True)

ZERNIO_API_KEY = os.environ["ZERNIO_API_KEY"]
ZERNIO_API_KEY_2 = os.environ["ZERNIO_API_KEY_2"]

ZERNIO_BASE = "https://zernio.com/api/v1"

# Match the same key used to post each platform
PLATFORM_KEY = {
    "instagram": ZERNIO_API_KEY,
    "tiktok":    ZERNIO_API_KEY,
    "youtube":   ZERNIO_API_KEY_2,
    "facebook":  ZERNIO_API_KEY_2,
}


SYNCING_STATUS = (202,)  # Zernio returns 202 while platform analytics are still syncing

def fetch_analytics(zernio_post_id, platform):
    resp = requests.get(
        f"{ZERNIO_BASE}/analytics",
        headers={"Authorization": f"Bearer {PLATFORM_KEY[platform]}"},
        params={"postId": zernio_post_id},
        timeout=30,
    )
    if resp.status_code == 200:
        return resp.json()
    if resp.status_code in SYNCING_STATUS:
        return "syncing"  # not an error — platform hasn't released data yet
    if resp.status_code == 424:
        return "failed"  # post failed to publish on the platform — expected, not our error
    print(f"    Zernio {resp.status_code} for {platform} post {zernio_post_id}: {resp.text[:120]}")
    return None


def extract_metrics(data):
    if not data:
        return None
    # Zernio per-post response nests all metrics under an "analytics" key
    analytics = data.get("analytics") or {}
    def g(key, alt=None):
        return analytics.get(key) or (analytics.get(alt) if alt else None) or 0
    return {
        "views":           g("views"),
        "impressions":     g("impressions"),
        "reach":           g("reach"),
        "likes":           g("likes"),
        "comments":        g("comments"),
        "shares":          g("shares"),
        "saves":           g("saves"),
        "clicks":          g("clicks"),
        "engagement_rate": g("engagementRate", "engagement_rate"),
    }


def already_tracked_today(supabase, clip_queue_id):
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    result = (
        supabase.table("clip_performance")
        .select("id", count="exact", head=True)
        .eq("clip_queue_id", clip_queue_id)
        .gte("measured_at", today.isoformat())
        .execute()
    )
    return (result.count or 0) > 0


def hours_since(posted_at_str):
    if not posted_at_str:
        return 0
    posted_at = datetime.fromisoformat(posted_at_str.replace("Z", "+00:00"))
    return int((datetime.now(timezone.utc) - posted_at).total_seconds() / 3600)


def main():
    supabase = create_client()

    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    result = (
        supabase.table("clip_queue")
        .select("id, video_id, clip_index, platform, zernio_post_id, posted_at, hook")
        .eq("status", "posted")
        .gte("posted_at", cutoff)
        .not_.is_("zernio_post_id", "null")
        .execute()
    )
    clips = result.data or []
    print(f"Found {len(clips)} posted clips to track (last 30 days)\n")

    tracked = skipped = failed = 0

    for clip in clips:
        label = f"{clip['platform']:10} | clip {clip['clip_index']} from {clip['video_id']}"

        if already_tracked_today(supabase, clip["id"]):
            skipped += 1
            continue

        data = fetch_analytics(clip["zernio_post_id"], clip["platform"])

        if data in ("syncing", "failed"):
            skipped += 1
            continue  # analytics not ready yet, or post failed to publish — not our error

        metrics = extract_metrics(data)

        if not metrics:
            print(f"  SKIP  {label} — no data returned")
            failed += 1
            continue

        age = hours_since(clip.get("posted_at"))

        supabase.table("clip_performance").insert({
            "clip_queue_id":    clip["id"],
            "video_id":         clip["video_id"],
            "clip_index":       clip["clip_index"],
            "zernio_post_id":   clip["zernio_post_id"],
            "platform":         clip["platform"],
            "hours_since_posted": age,
            **metrics,
        }).execute()

        tracked += 1
        print(
            f"  OK    {label} | "
            f"{age}h old | "
            f"views={metrics['views']} likes={metrics['likes']} "
            f"shares={metrics['shares']} saves={metrics['saves']} "
            f"comments={metrics['comments']}"
        )

    print(f"\n✓ Done — tracked: {tracked}  skipped (already today): {skipped}  failed: {failed}")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
