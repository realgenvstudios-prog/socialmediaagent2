"""
Fetches YouTube Analytics + channel stats and stores in Neon.
Runs daily via GitHub Actions.
"""

import os
import json
import psycopg2
import requests
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv

load_dotenv(override=True)

CLIENT_ID     = os.environ["YOUTUBE_CLIENT_ID"]
CLIENT_SECRET = os.environ["YOUTUBE_CLIENT_SECRET"]
REFRESH_TOKEN = os.environ["YOUTUBE_REFRESH_TOKEN"]
DATABASE_URL  = os.environ["DATABASE_URL"]

ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports"
DATA_API  = "https://www.googleapis.com/youtube/v3"


def get_access_token() -> str:
    resp = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id":     CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "refresh_token": REFRESH_TOKEN,
        "grant_type":    "refresh_token",
    }, timeout=15)
    resp.raise_for_status()
    return resp.json()["access_token"]


def analytics(token: str, params: dict) -> dict:
    resp = requests.get(ANALYTICS, headers={"Authorization": f"Bearer {token}"},
                        params={"ids": "channel==MINE", **params}, timeout=30)
    resp.raise_for_status()
    return resp.json()


def rows_to_dicts(data: dict) -> list[dict]:
    cols = [h["name"] for h in data.get("columnHeaders", [])]
    return [dict(zip(cols, r)) for r in data.get("rows", [])]


def main():
    token = get_access_token()
    print("Access token obtained.")

    today      = datetime.now(timezone.utc).date()
    start_30   = (today - timedelta(days=30)).isoformat()
    end_today  = today.isoformat()

    # ── Channel-level stats (last 30 days aggregate) ──────────────────────────
    print("Fetching channel analytics...")
    ch = rows_to_dicts(analytics(token, {
        "startDate": start_30,
        "endDate":   end_today,
        "metrics":   "views,estimatedMinutesWatched,averageViewDuration,"
                     "averageViewPercentage,subscribersGained,subscribersLost",
    }))
    ch_row = ch[0] if ch else {}

    # ── Traffic sources ───────────────────────────────────────────────────────
    traffic_raw = rows_to_dicts(analytics(token, {
        "startDate":  start_30,
        "endDate":    end_today,
        "metrics":    "views",
        "dimensions": "insightTrafficSourceType",
        "sort":       "-views",
    }))
    traffic = {r["insightTrafficSourceType"]: int(r["views"]) for r in traffic_raw}

    # ── Per-video stats (top 25 by views) ────────────────────────────────────
    print("Fetching per-video analytics...")
    videos = rows_to_dicts(analytics(token, {
        "startDate":  start_30,
        "endDate":    end_today,
        "metrics":    "views,estimatedMinutesWatched,averageViewDuration,"
                      "averageViewPercentage,likes,comments,shares",
        "dimensions": "video",
        "sort":       "-views",
        "maxResults": 25,
    }))

    # ── Subscriber count from YouTube Data API ────────────────────────────────
    print("Fetching subscriber count...")
    ch_resp = requests.get(f"{DATA_API}/channels", headers={"Authorization": f"Bearer {token}"},
                           params={"part": "statistics", "mine": "true"}, timeout=15)
    ch_resp.raise_for_status()
    items = ch_resp.json().get("items", [])
    subscribers = int(items[0]["statistics"].get("subscriberCount", 0)) if items else 0

    # ── Video titles from YouTube Data API ───────────────────────────────────
    video_ids = [r["video"] for r in videos]
    title_map: dict[str, str] = {}
    if video_ids:
        for i in range(0, len(video_ids), 50):
            batch = video_ids[i:i+50]
            vr = requests.get(f"{DATA_API}/videos", headers={"Authorization": f"Bearer {token}"},
                              params={"part": "snippet", "id": ",".join(batch)}, timeout=15)
            if vr.ok:
                for item in vr.json().get("items", []):
                    title_map[item["id"]] = item["snippet"]["title"]

    # ── Store in Neon ─────────────────────────────────────────────────────────
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS youtube_channel_daily (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            date DATE NOT NULL DEFAULT CURRENT_DATE UNIQUE,
            subscribers INTEGER DEFAULT 0,
            subscribers_gained INTEGER DEFAULT 0,
            subscribers_lost INTEGER DEFAULT 0,
            views INTEGER DEFAULT 0,
            watch_minutes INTEGER DEFAULT 0,
            avg_view_duration_s INTEGER DEFAULT 0,
            avg_view_percentage FLOAT DEFAULT 0,
            traffic_sources JSONB
        );
        CREATE TABLE IF NOT EXISTS youtube_video_stats (
            video_id TEXT NOT NULL,
            date DATE NOT NULL DEFAULT CURRENT_DATE,
            title TEXT,
            views INTEGER DEFAULT 0,
            likes INTEGER DEFAULT 0,
            comments INTEGER DEFAULT 0,
            shares INTEGER DEFAULT 0,
            watch_minutes INTEGER DEFAULT 0,
            avg_view_duration_s INTEGER DEFAULT 0,
            avg_view_percentage FLOAT DEFAULT 0,
            fetched_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (video_id, date)
        );
    """)

    cur.execute("""
        INSERT INTO youtube_channel_daily
            (date, subscribers, subscribers_gained, subscribers_lost,
             views, watch_minutes, avg_view_duration_s, avg_view_percentage, traffic_sources)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (date) DO UPDATE SET
            subscribers         = EXCLUDED.subscribers,
            subscribers_gained  = EXCLUDED.subscribers_gained,
            subscribers_lost    = EXCLUDED.subscribers_lost,
            views               = EXCLUDED.views,
            watch_minutes       = EXCLUDED.watch_minutes,
            avg_view_duration_s = EXCLUDED.avg_view_duration_s,
            avg_view_percentage = EXCLUDED.avg_view_percentage,
            traffic_sources     = EXCLUDED.traffic_sources
    """, (
        end_today,
        subscribers,
        int(ch_row.get("subscribersGained", 0)),
        int(ch_row.get("subscribersLost", 0)),
        int(ch_row.get("views", 0)),
        int(ch_row.get("estimatedMinutesWatched", 0)),
        int(ch_row.get("averageViewDuration", 0)),
        float(ch_row.get("averageViewPercentage", 0)),
        json.dumps(traffic),
    ))
    print(f"  Channel: {subscribers} subscribers, {int(ch_row.get('views',0)):,} views (30d)")

    for v in videos:
        vid = v["video"]
        cur.execute("""
            INSERT INTO youtube_video_stats
                (video_id, date, title, views, likes, comments, shares,
                 watch_minutes, avg_view_duration_s, avg_view_percentage, fetched_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (video_id, date) DO UPDATE SET
                title               = EXCLUDED.title,
                views               = EXCLUDED.views,
                likes               = EXCLUDED.likes,
                comments            = EXCLUDED.comments,
                shares              = EXCLUDED.shares,
                watch_minutes       = EXCLUDED.watch_minutes,
                avg_view_duration_s = EXCLUDED.avg_view_duration_s,
                avg_view_percentage = EXCLUDED.avg_view_percentage,
                fetched_at          = NOW()
        """, (
            vid,
            end_today,
            title_map.get(vid),
            int(v.get("views", 0)),
            int(v.get("likes", 0)),
            int(v.get("comments", 0)),
            int(v.get("shares", 0)),
            int(v.get("estimatedMinutesWatched", 0)),
            int(v.get("averageViewDuration", 0)),
            float(v.get("averageViewPercentage", 0)),
        ))
    print(f"  Videos: {len(videos)} top videos stored")

    conn.commit()
    cur.close()
    conn.close()
    print("Done!")


if __name__ == "__main__":
    main()
