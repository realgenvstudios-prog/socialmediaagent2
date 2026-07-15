-- Run this in the Neon SQL editor to create all tables

CREATE TABLE IF NOT EXISTS clip_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id TEXT NOT NULL,
    clip_index INTEGER NOT NULL,
    platform TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    storage_path TEXT,
    public_url TEXT,
    caption TEXT,
    hook TEXT,
    zernio_post_id TEXT,
    posted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processed_videos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id TEXT UNIQUE NOT NULL,
    video_title TEXT,
    channel_id TEXT,
    clip_count INTEGER DEFAULT 0,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_clip_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id TEXT NOT NULL,
    clip_index INTEGER NOT NULL,
    start_seconds FLOAT,
    end_seconds FLOAT,
    caption TEXT,
    hook TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(video_id, clip_index)
);

CREATE TABLE IF NOT EXISTS video_transcripts (
    video_id TEXT PRIMARY KEY,
    transcript TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clip_selection_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id TEXT NOT NULL,
    clip_index INTEGER NOT NULL,
    hook_type TEXT,
    topic_category TEXT,
    performance_tier TEXT,
    views INTEGER,
    clip_transcript TEXT,
    selected_at TIMESTAMPTZ,
    analytics_updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(video_id, clip_index)
);

CREATE TABLE IF NOT EXISTS channel_intelligence (
    id TEXT PRIMARY KEY,
    summary TEXT,
    stats JSONB,
    updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value JSONB,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clip_performance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clip_queue_id UUID,
    video_id TEXT,
    clip_index INTEGER,
    platform TEXT,
    zernio_post_id TEXT,
    hours_since_posted INTEGER,
    views INTEGER DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    reach INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    shares INTEGER DEFAULT 0,
    saves INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    engagement_rate FLOAT,
    measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
