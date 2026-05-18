-- Run this in your Supabase SQL Editor (supabase.com → your project → SQL Editor)

-- Table: tracks which YouTube videos have been processed
CREATE TABLE IF NOT EXISTS processed_videos (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    video_id TEXT UNIQUE NOT NULL,
    video_title TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    clip_count INTEGER DEFAULT 0,
    processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table: queue of clips ready to post
CREATE TABLE IF NOT EXISTS clip_queue (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    video_id TEXT NOT NULL,
    clip_index INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    public_url TEXT NOT NULL,
    caption TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('instagram', 'tiktok')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'failed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    posted_at TIMESTAMPTZ,
    zernio_post_id TEXT
);

-- Index for fast queue lookups (platform + status)
CREATE INDEX IF NOT EXISTS idx_clip_queue_pending
    ON clip_queue(platform, status, created_at);
