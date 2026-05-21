-- Run this in your Supabase SQL Editor
-- supabase.com → your project → SQL Editor → New query → paste → Run

-- Tracks which YouTube videos have been processed
CREATE TABLE IF NOT EXISTS processed_videos (
    id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    video_id     TEXT        UNIQUE NOT NULL,
    video_title  TEXT        NOT NULL,
    channel_id   TEXT        NOT NULL,
    clip_count   INTEGER     DEFAULT 0,
    processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Queue of clips waiting to be posted, one row per clip per platform
CREATE TABLE IF NOT EXISTS clip_queue (
    id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    video_id       TEXT        NOT NULL,
    clip_index     INTEGER     NOT NULL,
    storage_path   TEXT        NOT NULL,
    public_url     TEXT        NOT NULL,
    caption        TEXT        NOT NULL,
    hook           TEXT,
    platform       TEXT        NOT NULL CHECK (platform IN ('instagram', 'tiktok', 'youtube', 'facebook')),
    status         TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'failed')),
    zernio_post_id TEXT,
    posted_at      TIMESTAMPTZ,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Fast queue lookups (platform + status + order)
CREATE INDEX IF NOT EXISTS idx_clip_queue_pending
    ON clip_queue(platform, status, created_at);

-- Pipeline error log (written by GitHub Actions on workflow failure)
CREATE TABLE IF NOT EXISTS pipeline_errors (
    id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    workflow   TEXT        NOT NULL,
    run_url    TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Posting schedule config (optional — post_clips.py reads this)
-- Insert one row: { "times": ["09:00", "13:00", "18:00"] }
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO settings (key, value)
VALUES ('schedule', '{"times": ["09:00", "13:00", "18:00"]}')
ON CONFLICT (key) DO NOTHING;
