#!/usr/bin/env python3
"""
Analyses historical clip performance and extracts actionable patterns
that Claude uses when selecting clips for future videos.

Runs daily via GitHub Actions. Reads Zernio analytics + Supabase clip
metadata, sends the data to Claude, and saves the resulting intelligence
summary back to Supabase so process_video.py can inject it into the
clip-selection prompt.
"""

import os
import json
import requests
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL       = os.environ["SUPABASE_URL"]
SUPABASE_KEY       = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ["SUPABASE_KEY"]
ANTHROPIC_API_KEY  = os.environ["ANTHROPIC_API_KEY"]
ZERNIO_KEY_1       = os.environ["ZERNIO_API_KEY"]       # instagram + tiktok
ZERNIO_KEY_2       = os.environ["ZERNIO_API_KEY_2"]     # youtube + facebook

import anthropic
from supabase import create_client

sb      = create_client(SUPABASE_URL, SUPABASE_KEY)
claude  = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


# ── Zernio helpers ────────────────────────────────────────────────────────────

def fetch_zernio_all_posts() -> dict[str, dict]:
    """
    Fetch all posts from both Zernio accounts (all pages).
    Returns a map of latePostId → post dict.
    """
    posts_map: dict[str, dict] = {}
    for key in [ZERNIO_KEY_1, ZERNIO_KEY_2]:
        page = 1
        while True:
            resp = requests.get(
                f"https://zernio.com/api/v1/analytics?page={page}",
                headers={"Authorization": f"Bearer {key}"},
                timeout=30,
            )
            if not resp.ok:
                break
            data = resp.json()
            for post in data.get("posts", []):
                if post.get("latePostId"):
                    posts_map[post["latePostId"]] = post
            pagination = data.get("pagination", {})
            if page >= pagination.get("pages", 1):
                break
            page += 1
    return posts_map


# ── Supabase helpers ──────────────────────────────────────────────────────────

def fetch_clip_metadata() -> list[dict]:
    """
    Pull posted clips with their hook text and duration from Supabase.
    Joins clip_queue with video_clip_plans for duration.
    """
    clips = (
        sb.table("clip_queue")
        .select("video_id, clip_index, platform, zernio_post_id, hook, caption, posted_at")
        .eq("status", "posted")
        .not_.is_("zernio_post_id", "null")
        .not_.is_("hook", "null")
        .order("posted_at", desc=True)
        .limit(500)
        .execute()
    ).data or []

    # Fetch durations from video_clip_plans
    plans_raw = (
        sb.table("video_clip_plans")
        .select("video_id, clip_index, start_seconds, end_seconds")
        .execute()
    ).data or []
    plans = {(p["video_id"], p["clip_index"]): p for p in plans_raw}

    for clip in clips:
        key = (clip["video_id"], clip["clip_index"])
        plan = plans.get(key)
        clip["duration_seconds"] = (
            round(plan["end_seconds"] - plan["start_seconds"])
            if plan else None
        )
        # Parse caption JSON if needed
        try:
            clip["captions"] = json.loads(clip["caption"]) if isinstance(clip["caption"], str) else clip["caption"]
        except Exception:
            clip["captions"] = {}

    return clips


def save_intelligence(summary: str, stats: dict) -> None:
    sb.table("channel_intelligence").upsert(
        {
            "id": "singleton",
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "summary": summary,
            "stats": stats,
        },
        on_conflict="id",
    ).execute()
    print("  Saved channel intelligence to Supabase.")


# ── Decision outcome tracking ─────────────────────────────────────────────────

def update_selection_outcomes(zernio_map: dict[str, dict]) -> None:
    """
    Match logged clip selections to their real analytics and fill in
    performance data. Assigns a performance tier (top / mid / low)
    based on views relative to the channel average.
    """
    try:
        # Get all selection log entries that haven't been updated yet
        pending = (
            sb.table("clip_selection_log")
            .select("id, video_id, clip_index")
            .is_("analytics_updated_at", "null")
            .execute()
        ).data or []

        if not pending:
            print("  No pending selection outcomes to update.")
            return

        # Get zernio_post_ids from clip_queue for matching
        video_clip_pairs = [(r["video_id"], r["clip_index"]) for r in pending]
        queue_rows = (
            sb.table("clip_queue")
            .select("video_id, clip_index, platform, zernio_post_id")
            .eq("status", "posted")
            .not_.is_("zernio_post_id", "null")
            .execute()
        ).data or []

        # Build lookup: (video_id, clip_index) → best available analytics
        best_analytics: dict[tuple, dict] = {}
        for row in queue_rows:
            key = (row["video_id"], row["clip_index"])
            zpost = zernio_map.get(row["zernio_post_id"] or "")
            analytics = (zpost or {}).get("analytics") or {}
            if not analytics.get("lastUpdated"):
                continue
            prev = best_analytics.get(key, {})
            if (analytics.get("views") or 0) >= (prev.get("views") or 0):
                best_analytics[key] = analytics

        # Compute channel average views for tier assignment
        all_views = [a.get("views") or 0 for a in best_analytics.values() if a.get("views")]
        avg_views = sum(all_views) / len(all_views) if all_views else 0

        updated = 0
        for rec in pending:
            key = (rec["video_id"], rec["clip_index"])
            a = best_analytics.get(key)
            if not a:
                continue
            views = a.get("views") or 0
            tier = "top" if views >= avg_views * 1.5 else ("low" if views < avg_views * 0.5 else "mid")
            sb.table("clip_selection_log").update({
                "views":               views,
                "likes":               a.get("likes") or 0,
                "engagement_rate":     round(a.get("engagementRate") or 0, 2),
                "performance_tier":    tier,
                "analytics_updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", rec["id"]).execute()
            updated += 1

        print(f"  Updated outcomes for {updated} clip selections.")
    except Exception as e:
        print(f"  Could not update selection outcomes: {e}")


def build_decision_history() -> str:
    """
    Build a summary of Claude's past clip selection decisions and their outcomes
    for injection into the intelligence brief.
    """
    try:
        rows = (
            sb.table("clip_selection_log")
            .select("hook_type, topic_category, duration_seconds, views, performance_tier")
            .not_.is_("performance_tier", "null")
            .execute()
        ).data or []

        if len(rows) < 10:
            return ""

        # Aggregate by hook_type
        from collections import defaultdict
        hook_stats: dict[str, list] = defaultdict(list)
        topic_stats: dict[str, list] = defaultdict(list)
        tier_counts: dict[str, int] = defaultdict(int)

        for r in rows:
            if r.get("views") is not None:
                hook_stats[r["hook_type"] or "unknown"].append(r["views"])
                topic_stats[r["topic_category"] or "unknown"].append(r["views"])
            tier_counts[r["performance_tier"] or "unknown"] += 1

        lines = [f"CLAUDE'S PAST CLIP SELECTION OUTCOMES ({len(rows)} clips with data):"]

        lines.append("\nBy hook type (avg views):")
        for ht, views_list in sorted(hook_stats.items(), key=lambda x: -sum(x[1])/len(x[1])):
            avg = round(sum(views_list) / len(views_list))
            lines.append(f"  {ht}: {avg} avg views ({len(views_list)} clips)")

        lines.append("\nBy topic (avg views):")
        for tc, views_list in sorted(topic_stats.items(), key=lambda x: -sum(x[1])/len(x[1])):
            avg = round(sum(views_list) / len(views_list))
            lines.append(f"  {tc}: {avg} avg views ({len(views_list)} clips)")

        total = sum(tier_counts.values())
        lines.append(f"\nOverall: {tier_counts.get('top', 0)} top ({round(tier_counts.get('top', 0)/total*100)}%), "
                     f"{tier_counts.get('mid', 0)} mid, {tier_counts.get('low', 0)} low performers")

        return "\n".join(lines)
    except Exception:
        return ""


# ── Analysis ──────────────────────────────────────────────────────────────────

def build_performance_dataset(clips: list[dict], zernio_map: dict[str, dict]) -> list[dict]:
    """Merge clip metadata with live analytics."""
    rows = []
    for clip in clips:
        zpost = zernio_map.get(clip["zernio_post_id"])
        if not zpost:
            continue
        analytics = zpost.get("analytics") or {}
        views       = analytics.get("views") or 0
        likes       = analytics.get("likes") or 0
        comments    = analytics.get("comments") or 0
        shares      = analytics.get("shares") or 0
        eng_rate    = analytics.get("engagementRate") or 0
        last_updated = analytics.get("lastUpdated")

        # Only include posts that have actually synced analytics
        if not last_updated or views == 0:
            continue

        rows.append({
            "platform":         clip["platform"],
            "hook":             (clip.get("hook") or "")[:120],
            "duration_seconds": clip.get("duration_seconds"),
            "views":            views,
            "likes":            likes,
            "comments":         comments,
            "shares":           shares,
            "engagement_rate":  round(eng_rate, 2),
            "posted_at":        clip.get("posted_at", "")[:10],
        })

    return sorted(rows, key=lambda r: r["views"], reverse=True)


def analyse_with_claude(rows: list[dict]) -> str:
    """
    Send performance data to Claude and ask it to extract actionable
    patterns for future clip selection.
    """
    if not rows:
        return "No synced performance data available yet."

    top     = rows[:20]
    bottom  = rows[-10:] if len(rows) >= 15 else []

    dataset_text = "TOP PERFORMING CLIPS:\n"
    for i, r in enumerate(top, 1):
        dataset_text += (
            f"{i}. [{r['platform'].upper()}] {r['views']} views | "
            f"{r['engagement_rate']}% eng | {r['duration_seconds']}s | "
            f"Hook: \"{r['hook']}\"\n"
        )

    if bottom:
        dataset_text += "\nLOWEST PERFORMING CLIPS:\n"
        for i, r in enumerate(bottom, 1):
            dataset_text += (
                f"{i}. [{r['platform'].upper()}] {r['views']} views | "
                f"{r['engagement_rate']}% eng | {r['duration_seconds']}s | "
                f"Hook: \"{r['hook']}\"\n"
            )

    platform_summary = {}
    for r in rows:
        p = r["platform"]
        if p not in platform_summary:
            platform_summary[p] = {"views": [], "engagement": []}
        platform_summary[p]["views"].append(r["views"])
        platform_summary[p]["engagement"].append(r["engagement_rate"])

    platform_text = "\nPLATFORM AVERAGES:\n"
    for p, d in platform_summary.items():
        avg_v = round(sum(d["views"]) / len(d["views"]))
        avg_e = round(sum(d["engagement"]) / len(d["engagement"]), 2)
        platform_text += f"  {p.upper()}: avg {avg_v} views, {avg_e}% engagement ({len(d['views'])} clips)\n"

    decision_history = build_decision_history()
    decision_block = f"\n{decision_history}\n" if decision_history else ""

    prompt = f"""You are a social media performance analyst for the Konnected Minds Podcast (Ghana-based business/entrepreneurship content).

Below is real performance data from clips already posted across Instagram, TikTok, YouTube Shorts, and Facebook Reels.

{dataset_text}
{platform_text}{decision_block}

Your task: write a concise CHANNEL INTELLIGENCE BRIEF that a clip selection AI will read before picking clips from a new episode. Focus on:

1. HOOK PATTERNS — What types of opening lines drive the most views? Quote specific examples from the top performers.
2. TOPIC PATTERNS — Which subject areas (money, business failure, personal story, relationships, hustle mindset, etc.) consistently perform well vs. poorly?
3. DURATION SWEET SPOT — What clip length works best for this channel based on the data?
4. PLATFORM DIFFERENCES — What works on TikTok vs Instagram vs YouTube vs Facebook for THIS channel?
5. WHAT TO AVOID — Common traits of the lowest performers.
6. ACTIONABLE RULES — 5 to 8 specific, concrete rules the clip selector should follow (e.g. "Always prioritise clips where the guest reveals a specific number or amount", "Avoid clips that start with generic advice").

Be specific and data-driven. Reference actual hook examples from the data. This brief will be injected directly into Claude's prompt so write it as clear, directive guidance — not a report."""

    # Haiku is used here intentionally — this is structured analytical work
    # (pattern extraction from a data table), not creative generation.
    # Sonnet is reserved for clip selection where output quality is critical.
    msg = claude.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1400,
        messages=[{"role": "user", "content": prompt}],
    )
    return msg.content[0].text


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("Fetching Zernio analytics...")
    zernio_map = fetch_zernio_all_posts()
    print(f"  {len(zernio_map)} posts fetched from Zernio.")

    print("Fetching clip metadata from Supabase...")
    clips = fetch_clip_metadata()
    print(f"  {len(clips)} posted clips with hooks found.")

    print("Updating clip selection outcomes...")
    update_selection_outcomes(zernio_map)

    print("Building performance dataset...")
    rows = build_performance_dataset(clips, zernio_map)
    print(f"  {len(rows)} clips with synced analytics.")

    if len(rows) < 5:
        print("  Not enough synced data yet — skipping Claude analysis.")
        return

    # Skip if brief is recent and dataset hasn't grown significantly
    try:
        existing = sb.table("channel_intelligence").select("stats,updated_at").eq("id", "singleton").maybe_single().execute()
        if existing.data:
            prev_count = (existing.data.get("stats") or {}).get("clips_analysed", 0)
            updated_at = existing.data.get("updated_at", "")
            if updated_at:
                age_days = (datetime.now(timezone.utc) - datetime.fromisoformat(updated_at.replace("Z", "+00:00"))).days
                new_clips = len(rows) - prev_count
                if age_days < 3 and new_clips < 10:
                    print(f"  Brief is {age_days}d old with only {new_clips} new clips — skipping to save credits.")
                    return
                print(f"  Brief is {age_days}d old, {new_clips} new clips since last run — regenerating.")
    except Exception:
        pass

    # Compute quick stats to save alongside the summary
    stats = {
        "clips_analysed": len(rows),
        "total_views": sum(r["views"] for r in rows),
        "avg_engagement": round(sum(r["engagement_rate"] for r in rows) / len(rows), 2),
        "best_hook": rows[0]["hook"] if rows else "",
        "best_views": rows[0]["views"] if rows else 0,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    print("Sending to Claude for pattern analysis...")
    summary = analyse_with_claude(rows)
    print("  Claude analysis complete.")
    print("\n--- INTELLIGENCE BRIEF PREVIEW ---")
    print(summary[:600] + ("..." if len(summary) > 600 else ""))
    print("---\n")

    save_intelligence(summary, stats)
    print(f"Done. {len(rows)} clips analysed, intelligence saved.")


if __name__ == "__main__":
    main()
