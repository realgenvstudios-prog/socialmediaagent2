"""
One-time migration: imports CSV exports from old Supabase into Neon.
Auto-detects the 5 Supabase Snippet CSV files in ~/Downloads by their column headers.
Run:  python scripts/migrate_from_supabase.py
"""

import csv
import glob
import os
import psycopg2
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(override=True)

DATABASE_URL = os.environ["DATABASE_URL"]
DOWNLOADS = Path.home() / "Downloads"
PROJECT_DIR = Path(__file__).parent.parent  # solvingthisagent 2/

# Signature columns unique to each table — used to auto-detect which CSV is which
TABLE_SIGNATURES: dict[str, set[str]] = {
    "processed_videos":   {"video_title", "clip_count"},
    "clip_selection_log": {"hook_type", "clip_transcript", "analytics_updated_at"},
    "channel_intelligence": {"stats"},          # only table with a 'stats' JSONB column
    "clip_performance":   {"views", "likes", "shares"},
    "clip_queue":         {"caption", "hook", "platform", "status"},
}

def detect_table(path: Path) -> str | None:
    """Return the table name that best matches the CSV's column headers."""
    with open(path, newline="", encoding="utf-8") as f:
        headers = set(next(csv.reader(f)))
    best_table, best_score = None, 0
    for table, sig in TABLE_SIGNATURES.items():
        score = len(sig & headers)
        if score > best_score:
            best_score, best_table = score, table
    return best_table if best_score > 0 else None

def find_csvs() -> dict[str, Path]:
    """Find the 5 Supabase export CSVs and detect which table each belongs to."""
    known_names = [
        "Supabase Snippet Untitled query (1).csv",
        "Supabase Snippet Untitled query (2).csv",
        "Supabase Snippet Untitled query (3).csv",
        "Supabase Snippet Untitled query (4).csv",
        "Supabase Snippet Untitled query (5).csv",
    ]
    # Search project root first (easy to drop files there), then Downloads
    search_dirs = [PROJECT_DIR, DOWNLOADS]
    candidates = []
    for d in search_dirs:
        found = [d / name for name in known_names if (d / name).exists()]
        if found:
            candidates = found
            print(f"  Found {len(candidates)} file(s) in {d}")
            break
    if not candidates:
        print(f"  No files found in {PROJECT_DIR} or {DOWNLOADS}")
        print("  → Drag the 5 'Supabase Snippet Untitled query' CSVs into the solvingthisagent 2 folder and try again.")

    mapping: dict[str, Path] = {}
    for path in candidates:
        table = detect_table(path)
        if table and table not in mapping:
            mapping[table] = path
            print(f"  {path.name}  →  {table}")
        else:
            print(f"  {path.name}  →  could not detect table (headers: {open(path).readline().strip()})")
    return mapping


def orNone(val):
    if not val:
        return None
    s = val.strip()
    if not s or s.lower() == "null":
        return None
    return s

def orInt(val, default=0):
    if not val:
        return default
    s = val.strip()
    if not s or s.lower() == "null":
        return default
    try:
        return int(s)
    except ValueError:
        return default

def orFloat(val):
    try:
        return float(val) if val and val.strip() else None
    except ValueError:
        return None


def migrate_processed_videos(cur, path: Path):
    if not path:
        print("  SKIP: no matching CSV found")
        return
    count = 0
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            cur.execute("""
                INSERT INTO processed_videos
                  (id, video_id, video_title, channel_id, clip_count, processed_at)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (video_id) DO NOTHING
            """, (
                orNone(row.get("id")),
                orNone(row.get("video_id")),
                orNone(row.get("video_title")),
                orNone(row.get("channel_id")),
                orInt(row.get("clip_count")),
                orNone(row.get("processed_at")),
            ))
            count += 1
    print(f"  processed_videos: {count} rows → Neon")


def migrate_clip_queue(cur, path: Path):
    if not path:
        print("  SKIP: no matching CSV found")
        return
    count = 0
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            cur.execute("""
                INSERT INTO clip_queue
                  (id, video_id, clip_index, platform, status,
                   storage_path, public_url, caption, hook,
                   zernio_post_id, posted_at, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO NOTHING
            """, (
                orNone(row.get("id")),
                orNone(row.get("video_id")),
                orInt(row.get("clip_index")),
                orNone(row.get("platform")),
                orNone(row.get("status")),
                orNone(row.get("storage_path")),
                orNone(row.get("public_url")),
                orNone(row.get("caption")),
                orNone(row.get("hook")),
                orNone(row.get("zernio_post_id")),
                orNone(row.get("posted_at")),
                orNone(row.get("created_at")),
            ))
            count += 1
    print(f"  clip_queue: {count} rows → Neon")


def migrate_channel_intelligence(cur, path: Path):
    if not path:
        print("  SKIP: no matching CSV found")
        return
    count = 0
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            cur.execute("""
                INSERT INTO channel_intelligence (id, summary, stats, updated_at)
                VALUES (%s, %s, %s::jsonb, %s)
                ON CONFLICT (id) DO UPDATE SET
                    summary    = EXCLUDED.summary,
                    stats      = EXCLUDED.stats,
                    updated_at = EXCLUDED.updated_at
            """, (
                orNone(row.get("id")),
                orNone(row.get("summary")),
                row.get("stats") or "{}",
                orNone(row.get("updated_at")),
            ))
            count += 1
    print(f"  channel_intelligence: {count} rows → Neon")


def migrate_clip_selection_log(cur, path: Path):
    if not path:
        print("  SKIP: no matching CSV found")
        return
    count = 0
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            cur.execute("""
                INSERT INTO clip_selection_log
                  (id, video_id, clip_index, hook_type, topic_category,
                   performance_tier, views, clip_transcript,
                   analytics_updated_at, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (video_id, clip_index) DO NOTHING
            """, (
                orNone(row.get("id")),
                orNone(row.get("video_id")),
                orInt(row.get("clip_index")),
                orNone(row.get("hook_type")),
                orNone(row.get("topic_category")),
                orNone(row.get("performance_tier")),
                orInt(row.get("views"), default=None),
                orNone(row.get("clip_transcript")),
                orNone(row.get("analytics_updated_at")),
                orNone(row.get("created_at")),
            ))
            count += 1
    print(f"  clip_selection_log: {count} rows → Neon")


def migrate_clip_performance(cur, path: Path):
    if not path:
        print("  SKIP: no matching CSV found")
        return
    count = 0
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            # Old schema had 'recorded_at' — map it to 'measured_at'
            measured_at = orNone(row.get("measured_at") or row.get("recorded_at"))
            cur.execute("""
                INSERT INTO clip_performance
                  (id, video_id, clip_index, platform, zernio_post_id,
                   views, likes, comments, shares, measured_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO NOTHING
            """, (
                orNone(row.get("id")),
                orNone(row.get("video_id")),
                orInt(row.get("clip_index"), default=None),
                orNone(row.get("platform")),
                orNone(row.get("zernio_post_id")),
                orInt(row.get("views")),
                orInt(row.get("likes")),
                orInt(row.get("comments")),
                orInt(row.get("shares")),
                measured_at,
            ))
            count += 1
    print(f"  clip_performance: {count} rows → Neon")


def main():
    print(f"Scanning {DOWNLOADS} for Supabase CSVs...")
    csv_map = find_csvs()
    if not csv_map:
        print("No CSV files could be matched to tables. Aborting.")
        return
    print(f"\nFound {len(csv_map)} table(s). Connecting to Neon...")

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    steps = [
        ("processed_videos",     migrate_processed_videos),
        ("clip_queue",           migrate_clip_queue),
        ("channel_intelligence", migrate_channel_intelligence),
        ("clip_selection_log",   migrate_clip_selection_log),
        ("clip_performance",     migrate_clip_performance),
    ]

    for name, fn in steps:
        path = csv_map.get(name)
        print(f"\nMigrating {name}..." + (f" ({path.name})" if path else ""))
        try:
            fn(cur, path)
            conn.commit()
            print(f"  ✓ committed")
        except Exception as e:
            conn.rollback()
            print(f"  ✗ ERROR: {e}")

    cur.close()
    conn.close()
    print("\n✓ Migration complete!")


if __name__ == "__main__":
    main()
