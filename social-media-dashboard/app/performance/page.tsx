import { supabase } from "@/lib/supabase"
import AutoRefresh from "@/components/AutoRefresh"

export const revalidate = 0

const PLATFORMS = ["all", "instagram", "tiktok", "youtube", "facebook"] as const
type Platform = (typeof PLATFORMS)[number]

const PLATFORM_COLOR: Record<string, string> = {
  instagram: "#e1306c",
  tiktok:    "#111111",
  youtube:   "#ff0000",
  facebook:  "#1877f2",
}

const PLATFORM_LABEL: Record<string, string> = {
  instagram: "Instagram",
  tiktok:    "TikTok",
  youtube:   "YouTube Shorts",
  facebook:  "Facebook Reels",
}

const ZERNIO_KEYS = [
  process.env.ZERNIO_API_KEY!,
  process.env.ZERNIO_API_KEY_2!,
]

interface ZernioAnalytics {
  views?: number
  likes?: number
  comments?: number
  shares?: number
  saves?: number
  impressions?: number
  reach?: number
  engagementRate?: number
  lastUpdated?: string | null
}

interface ZernioPost {
  _id: string
  latePostId: string
  status: string
  syncStatus: string
  content?: string
  platformPostUrl?: string | null
  analytics?: ZernioAnalytics
}

async function getPosts(platform: string) {
  let query = supabase
    .from("clip_queue")
    .select("id, video_id, clip_index, platform, caption, posted_at, zernio_post_id")
    .eq("status", "posted")
    .not("zernio_post_id", "is", null)
    .lt("clip_index", 50)
    .order("posted_at", { ascending: false })

  if (platform !== "all") query = query.eq("platform", platform)

  const { data } = await query
  return data ?? []
}

// Fetch all pages from the aggregate endpoint and build a latePostId → post map.
// This is the only endpoint that returns real synced analytics for all platforms.
async function fetchZernioAnalyticsMap(): Promise<Map<string, ZernioPost>> {
  const map = new Map<string, ZernioPost>()

  await Promise.all(ZERNIO_KEYS.map(async (key) => {
    let page = 1
    while (true) {
      try {
        const res = await fetch(`https://zernio.com/api/v1/analytics?page=${page}`, {
          headers: { Authorization: `Bearer ${key}` },
          next: { revalidate: 60 },
        })
        if (!res.ok) break
        const data = await res.json()
        const posts: ZernioPost[] = Array.isArray(data.posts) ? data.posts : []
        for (const post of posts) {
          if (post.latePostId) map.set(post.latePostId, post)
        }
        const pagination = data.pagination as { page: number; pages: number } | undefined
        if (!pagination || page >= pagination.pages) break
        page++
      } catch {
        break
      }
    }
  }))

  return map
}

function fmt(n: number) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000)    return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function timeAgo(dateStr: string) {
  if (!dateStr) return "—"
  const diff = Date.now() - new Date(dateStr).getTime()
  const h = Math.floor(diff / 3600000)
  const d = Math.floor(diff / 86400000)
  if (h < 1) return "just now"
  if (h < 24) return `${h}h ago`
  if (d === 1) return "yesterday"
  if (d < 30) return `${d}d ago`
  return new Date(dateStr).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string }>
}) {
  const { platform = "all" } = await searchParams
  const activePlatform = PLATFORMS.includes(platform as Platform) ? platform : "all"

  const [posts, zernioMap] = await Promise.all([
    getPosts(activePlatform),
    fetchZernioAnalyticsMap(),
  ])

  type EnrichedPost = (typeof posts)[number] & { zernio: ZernioPost | null }
  const enriched: EnrichedPost[] = posts.map(p => ({
    ...p,
    zernio: (p.zernio_post_id != null ? zernioMap.get(p.zernio_post_id) : undefined) ?? null,
  }))

  const totalViews    = enriched.reduce((s, p) => s + (p.zernio?.analytics?.views ?? 0), 0)
  const totalLikes    = enriched.reduce((s, p) => s + (p.zernio?.analytics?.likes ?? 0), 0)
  const totalComments = enriched.reduce((s, p) => s + (p.zernio?.analytics?.comments ?? 0), 0)
  const totalShares   = enriched.reduce((s, p) => s + (p.zernio?.analytics?.shares ?? 0), 0)
  const liveCount     = enriched.filter(p => p.zernio?.status === "published").length
  const failedCount   = enriched.filter(p => p.zernio?.status === "failed").length

  const bestPerformer = enriched
    .filter(p => (p.zernio?.analytics?.views ?? 0) > 0)
    .sort((a, b) => (b.zernio?.analytics?.views ?? 0) - (a.zernio?.analytics?.views ?? 0))[0] ?? null

  return (
    <div>
      <AutoRefresh intervalSeconds={60} />

      {/* Header */}
      <div style={{ marginBottom: "3rem" }}>
        <h1 style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)", fontWeight: 300, letterSpacing: "-0.03em", color: "var(--text)", marginBottom: "0.5rem" }}>
          Performance
        </h1>
        <p style={{ fontSize: "13px", color: "var(--muted)" }}>
          Live stats from Zernio · {enriched.length} posts · {liveCount} live
          {failedCount > 0 && ` · ${failedCount} failed`}
        </p>
      </div>

      {/* Platform filter tabs */}
      <div style={{ display: "flex", gap: "6px", marginBottom: "2.5rem", flexWrap: "wrap" }}>
        {PLATFORMS.map(p => {
          const isActive = activePlatform === p
          return (
            <a
              key={p}
              href={`/performance${p === "all" ? "" : `?platform=${p}`}`}
              style={{
                fontSize: "12px",
                fontWeight: 500,
                padding: "6px 14px",
                borderRadius: "100px",
                border: "1px solid",
                borderColor: isActive ? (p === "all" ? "var(--text)" : PLATFORM_COLOR[p]) : "var(--border)",
                color: isActive ? (p === "all" ? "var(--text)" : PLATFORM_COLOR[p]) : "var(--muted)",
                background: isActive ? (p === "all" ? "var(--surface)" : `${PLATFORM_COLOR[p]}0f`) : "transparent",
                textDecoration: "none",
                transition: "all 0.15s",
                textTransform: p === "all" ? "none" : "capitalize",
              }}
            >
              {p === "all" ? "All Platforms" : PLATFORM_LABEL[p]}
            </a>
          )
        })}
      </div>

      {/* Best performer */}
      {bestPerformer && (
        <div style={{ border: "1px solid var(--border)", marginBottom: "2rem", display: "grid", gridTemplateColumns: "auto 1fr", overflow: "hidden" }}>
          <div style={{ width: "72px", flexShrink: 0, background: "var(--surface)", overflow: "hidden" }}>
            <img
              src={`https://img.youtube.com/vi/${bestPerformer.video_id}/hqdefault.jpg`}
              alt=""
              style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center", display: "block" }}
            />
          </div>
          <div style={{ padding: "1.25rem 1.5rem" }}>
            <p style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--green)", marginBottom: "6px" }}>
              Top performer
            </p>
            <p style={{ fontSize: "13px", color: "var(--text)", lineHeight: 1.5, marginBottom: "10px",
              overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical" as const }}>
              {bestPerformer.caption}
            </p>
            <div style={{ display: "flex", gap: "16px" }}>
              {[
                { label: "views",  value: bestPerformer.zernio?.analytics?.views ?? 0 },
                { label: "likes",  value: bestPerformer.zernio?.analytics?.likes ?? 0 },
                { label: "eng.",   value: bestPerformer.zernio?.analytics?.engagementRate },
              ].map(m => (
                <div key={m.label} style={{ display: "flex", gap: "4px", alignItems: "baseline" }}>
                  <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
                    {m.label === "eng." ? (m.value ? `${Number(m.value).toFixed(1)}%` : "—") : fmt(Number(m.value))}
                  </span>
                  <span style={{ fontSize: "10px", color: "var(--faint)" }}>{m.label}</span>
                </div>
              ))}
              <span style={{ fontSize: "11px", color: PLATFORM_COLOR[bestPerformer.platform], fontWeight: 600 }}>
                {PLATFORM_LABEL[bestPerformer.platform]}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Summary stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "1px", background: "var(--border)", border: "1px solid var(--border)", marginBottom: "3rem" }}>
        {[
          { label: "Views",    value: fmt(totalViews) },
          { label: "Likes",    value: fmt(totalLikes) },
          { label: "Comments", value: fmt(totalComments) },
          { label: "Shares",   value: fmt(totalShares) },
        ].map(s => (
          <div key={s.label} style={{ background: "var(--bg)", padding: "1.5rem 1.5rem" }}>
            <div style={{ fontSize: "2rem", fontWeight: 200, letterSpacing: "-0.04em", lineHeight: 1, color: "var(--text)", marginBottom: "0.5rem", fontVariantNumeric: "tabular-nums" }}>
              {s.value}
            </div>
            <div style={{ fontSize: "11px", fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)" }}>
              {s.label}
            </div>
          </div>
        ))}
      </div>

      {/* Posts table */}
      <div style={{ borderTop: "1px solid var(--border)" }}>
        {enriched.length === 0 ? (
          <p style={{ padding: "4rem 0", textAlign: "center", color: "var(--faint)", fontSize: "13px" }}>
            No posts found.
          </p>
        ) : enriched.map(post => {
          const z = post.zernio
          const isLive    = z?.status === "published"
          const hasFailed = z?.status === "failed"
          const isSyncing = z?.syncStatus === "pending" && !z?.analytics?.lastUpdated
          const a = z?.analytics ?? {}

          return (
            <div
              key={post.id}
              style={{ borderBottom: "1px solid var(--border)", padding: "1.125rem 0", display: "grid", gridTemplateColumns: "auto 1fr auto", gap: "1rem", alignItems: "center" }}
            >
              {/* Thumbnail */}
              <div style={{ width: "36px", height: "64px", overflow: "hidden", background: "var(--surface)", flexShrink: 0 }}>
                <img
                  src={`https://img.youtube.com/vi/${post.video_id}/hqdefault.jpg`}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center", display: "block" }}
                />
              </div>

              <div style={{ minWidth: 0 }}>
                {/* Platform + status */}
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                  <span style={{ fontSize: "11px", fontWeight: 600, color: PLATFORM_COLOR[post.platform], letterSpacing: "0.02em" }}>
                    {PLATFORM_LABEL[post.platform] ?? post.platform}
                  </span>
                  <span style={{ fontSize: "10px", color: isLive ? "var(--green)" : hasFailed ? "var(--red)" : "var(--faint)" }}>
                    {isLive ? "● Live" : hasFailed ? "● Failed" : "● Pending"}
                  </span>
                  <span style={{ fontSize: "11px", color: "var(--faint)" }}>
                    · Clip {post.clip_index} · {timeAgo(post.posted_at)}
                  </span>
                </div>

                {/* Caption */}
                <p style={{
                  fontSize: "13px",
                  color: "var(--text)",
                  lineHeight: 1.5,
                  overflow: "hidden",
                  display: "-webkit-box",
                  WebkitLineClamp: 1,
                  WebkitBoxOrient: "vertical" as const,
                  marginBottom: "8px",
                }}>
                  {post.caption || <span style={{ color: "var(--faint)", fontStyle: "italic" }}>No caption</span>}
                </p>

                {/* Metrics */}
                {isSyncing ? (
                  <span style={{ fontSize: "11px", color: "var(--faint)", fontStyle: "italic" }}>
                    Analytics syncing — check back in a few hours
                  </span>
                ) : (
                  <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
                    {[
                      { label: "views",    value: a.views       ?? 0 },
                      { label: "likes",    value: a.likes       ?? 0 },
                      { label: "comments", value: a.comments    ?? 0 },
                      { label: "shares",   value: a.shares      ?? 0 },
                      { label: "saves",    value: a.saves       ?? 0 },
                    ].map(m => (
                      <div key={m.label} style={{ display: "flex", gap: "4px", alignItems: "baseline" }}>
                        <span style={{ fontSize: "13px", fontWeight: 500, color: m.value > 0 ? "var(--text)" : "var(--faint)", fontVariantNumeric: "tabular-nums" }}>
                          {fmt(m.value)}
                        </span>
                        <span style={{ fontSize: "10px", color: "var(--faint)", textTransform: "capitalize" }}>
                          {m.label}
                        </span>
                      </div>
                    ))}
                    {z?.platformPostUrl && (
                      <a
                        href={z.platformPostUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: "11px", color: "var(--muted)", textDecoration: "none", marginLeft: "4px", borderBottom: "1px solid var(--border)" }}
                      >
                        View post ↗
                      </a>
                    )}
                  </div>
                )}
              </div>

              {/* Engagement rate */}
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: "1.25rem", fontWeight: 200, letterSpacing: "-0.03em", color: "var(--text)" }}>
                  {isSyncing ? "—" : a.engagementRate ? `${Number(a.engagementRate).toFixed(1)}%` : "—"}
                </div>
                <div style={{ fontSize: "10px", color: "var(--faint)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                  Engagement
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
