"""
Fetches Instagram + Facebook analytics via Meta Graph API and upserts to Neon.
Runs on a schedule via GitHub Actions.
"""

import os
import psycopg2
import requests
from dotenv import load_dotenv

load_dotenv(override=True)

PAGE_TOKEN    = os.environ["META_PAGE_TOKEN"]
IG_ACCOUNT_ID = "17841418823462092"
FB_PAGE_ID    = "1097694643437148"
DATABASE_URL  = os.environ["DATABASE_URL"]

BASE = "https://graph.facebook.com/v20.0"


def api(path, params=None):
    p = dict(params or {})
    p["access_token"] = PAGE_TOKEN
    r = requests.get(f"{BASE}{path}", params=p, timeout=30)
    r.raise_for_status()
    return r.json()


def paginate(path, params=None, max_items=500):
    items = []
    data = api(path, params)
    while True:
        items.extend(data.get("data", []))
        nxt = data.get("paging", {}).get("next")
        if not nxt or len(items) >= max_items:
            break
        r = requests.get(nxt, timeout=30)
        r.raise_for_status()
        data = r.json()
    return items


def get_ig_insights(media_id):
    try:
        data = api(f"/{media_id}/insights", {
            "metric": "views,reach,likes,comments,shares,saved,"
                      "ig_reels_avg_watch_time,ig_reels_video_view_total_time"
        })
        out = {}
        for item in data.get("data", []):
            vals = item.get("values", [])
            out[item["name"]] = vals[0]["value"] if vals else 0
        return out
    except Exception as e:
        print(f"    insights error {media_id}: {e}")
        return {}


def caption_key(text):
    return (text or "").strip()[:100].lower()


def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    # Ensure tables exist (safe for re-runs)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS meta_posts (
            id TEXT PRIMARY KEY,
            platform TEXT NOT NULL,
            caption TEXT,
            permalink TEXT,
            published_at TIMESTAMPTZ,
            video_id TEXT,
            clip_index INTEGER,
            views INTEGER DEFAULT 0,
            reach INTEGER DEFAULT 0,
            likes INTEGER DEFAULT 0,
            comments INTEGER DEFAULT 0,
            shares INTEGER DEFAULT 0,
            saves INTEGER DEFAULT 0,
            avg_watch_time_ms INTEGER DEFAULT 0,
            total_watch_time_ms BIGINT DEFAULT 0,
            fetched_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS meta_account_daily (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            platform TEXT NOT NULL,
            date DATE NOT NULL DEFAULT CURRENT_DATE,
            followers INTEGER DEFAULT 0,
            media_count INTEGER DEFAULT 0,
            reach INTEGER DEFAULT 0,
            profile_views INTEGER DEFAULT 0,
            accounts_engaged INTEGER DEFAULT 0,
            total_interactions INTEGER DEFAULT 0,
            website_clicks INTEGER DEFAULT 0,
            UNIQUE(platform, date)
        );
        -- Add columns if upgrading from older schema
        ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS reach INTEGER DEFAULT 0;
        ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS profile_views INTEGER DEFAULT 0;
        ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS accounts_engaged INTEGER DEFAULT 0;
        ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS total_interactions INTEGER DEFAULT 0;
        ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS website_clicks INTEGER DEFAULT 0;
    """)
    conn.commit()

    # Build caption → clip mapping for matching
    cur.execute("""
        SELECT video_id, clip_index, caption
        FROM clip_queue
        WHERE status = 'posted' AND caption IS NOT NULL
    """)
    cap_to_clip: dict[str, tuple[str, int]] = {}
    for vid, idx, cap in cur.fetchall():
        k = caption_key(cap)
        if k:
            cap_to_clip[k] = (vid, idx)

    # ── Instagram ─────────────────────────────────────────────────────────────
    print("Fetching Instagram media...")
    media = paginate(f"/{IG_ACCOUNT_ID}/media", {
        "fields": "id,media_type,caption,timestamp,permalink,like_count,comments_count"
    })

    ig_n = 0
    for post in media:
        if post.get("media_type") not in ("VIDEO", "REEL"):
            continue
        insights = get_ig_insights(post["id"])
        match = cap_to_clip.get(caption_key(post.get("caption", "")))

        cur.execute("""
            INSERT INTO meta_posts (
                id, platform, caption, permalink, published_at,
                video_id, clip_index,
                views, reach, likes, comments, shares, saves,
                avg_watch_time_ms, total_watch_time_ms, fetched_at
            ) VALUES (%s,'instagram',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())
            ON CONFLICT (id) DO UPDATE SET
                views               = EXCLUDED.views,
                reach               = EXCLUDED.reach,
                likes               = EXCLUDED.likes,
                comments            = EXCLUDED.comments,
                shares              = EXCLUDED.shares,
                saves               = EXCLUDED.saves,
                avg_watch_time_ms   = EXCLUDED.avg_watch_time_ms,
                total_watch_time_ms = EXCLUDED.total_watch_time_ms,
                video_id            = COALESCE(meta_posts.video_id, EXCLUDED.video_id),
                clip_index          = COALESCE(meta_posts.clip_index, EXCLUDED.clip_index),
                fetched_at          = NOW()
        """, (
            post["id"],
            post.get("caption"), post.get("permalink"), post.get("timestamp"),
            match[0] if match else None, match[1] if match else None,
            insights.get("views", 0),
            insights.get("reach", 0),
            insights.get("likes", post.get("like_count", 0)),
            insights.get("comments", post.get("comments_count", 0)),
            insights.get("shares", 0),
            insights.get("saved", 0),
            insights.get("ig_reels_avg_watch_time", 0),
            insights.get("ig_reels_video_view_total_time", 0),
        ))
        ig_n += 1

    conn.commit()
    print(f"  Instagram: {ig_n} posts upserted")

    # ── Facebook ──────────────────────────────────────────────────────────────
    print("Fetching Facebook reels...")
    fb_reels = paginate(f"/{FB_PAGE_ID}/video_reels", {
        "fields": "id,description,created_time,likes.summary(true),comments.summary(true)"
    })

    fb_n = 0
    for post in fb_reels:
        match = cap_to_clip.get(caption_key(post.get("description", "")))
        likes    = post.get("likes",    {}).get("summary", {}).get("total_count", 0)
        comments = post.get("comments", {}).get("summary", {}).get("total_count", 0)

        cur.execute("""
            INSERT INTO meta_posts (
                id, platform, caption, published_at,
                video_id, clip_index, likes, comments, fetched_at
            ) VALUES (%s,'facebook',%s,%s,%s,%s,%s,%s,NOW())
            ON CONFLICT (id) DO UPDATE SET
                likes      = EXCLUDED.likes,
                comments   = EXCLUDED.comments,
                video_id   = COALESCE(meta_posts.video_id, EXCLUDED.video_id),
                clip_index = COALESCE(meta_posts.clip_index, EXCLUDED.clip_index),
                fetched_at = NOW()
        """, (
            post["id"],
            post.get("description"), post.get("created_time"),
            match[0] if match else None, match[1] if match else None,
            likes, comments,
        ))
        fb_n += 1

    conn.commit()
    print(f"  Facebook: {fb_n} reels upserted")

    # ── Account snapshot ──────────────────────────────────────────────────────
    print("Saving account snapshot...")
    profile = api(f"/{IG_ACCOUNT_ID}", {"fields": "followers_count,media_count"})

    # Metrics that use standard period (no metric_type)
    daily_std = api(f"/{IG_ACCOUNT_ID}/insights", {
        "metric": "reach",
        "period": "day",
    })
    reach_today = 0
    for item in daily_std.get("data", []):
        if item["name"] == "reach":
            vals = item.get("values", [])
            reach_today = vals[-1]["value"] if vals else 0

    # Metrics that require metric_type=total_value
    daily_tv = api(f"/{IG_ACCOUNT_ID}/insights", {
        "metric": "profile_views,total_interactions,accounts_engaged,website_clicks",
        "metric_type": "total_value",
        "period": "day",
    })
    tv_map: dict[str, int] = {}
    for item in daily_tv.get("data", []):
        tv_map[item["name"]] = item.get("total_value", {}).get("value", 0)

    cur.execute("""
        INSERT INTO meta_account_daily
            (platform, date, followers, media_count,
             reach, profile_views, accounts_engaged, total_interactions, website_clicks)
        VALUES ('instagram', CURRENT_DATE, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (platform, date) DO UPDATE SET
            followers          = EXCLUDED.followers,
            media_count        = EXCLUDED.media_count,
            reach              = EXCLUDED.reach,
            profile_views      = EXCLUDED.profile_views,
            accounts_engaged   = EXCLUDED.accounts_engaged,
            total_interactions = EXCLUDED.total_interactions,
            website_clicks     = EXCLUDED.website_clicks
    """, (
        profile.get("followers_count", 0),
        profile.get("media_count", 0),
        reach_today,
        tv_map.get("profile_views", 0),
        tv_map.get("accounts_engaged", 0),
        tv_map.get("total_interactions", 0),
        tv_map.get("website_clicks", 0),
    ))
    conn.commit()

    cur.close()
    conn.close()
    print("Done!")


if __name__ == "__main__":
    main()
