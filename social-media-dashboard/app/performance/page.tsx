import { supabase } from "@/lib/supabase"
import AutoRefresh from "@/components/AutoRefresh"

export const revalidate = 0

const PLATFORMS = ["all", "instagram", "tiktok", "youtube", "facebook"] as const
type Platform = (typeof PLATFORMS)[number]

const PERIODS = ["today", "week", "month", "all"] as const
type Period = (typeof PERIODS)[number]

const PERIOD_LABEL: Record<Period, string> = {
  today: "Today",
  week:  "7 days",
  month: "30 days",
  all:   "All time",
}

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

interface ClipRow {
  id: string
  video_id: string
  clip_index: number
  platform: string
  caption: string | null
  posted_at: string | null
  zernio_post_id: string | null
}

async function getAllPosts(): Promise<ClipRow[]> {
  const PAGE = 1000
  const all: ClipRow[] = []
  let from = 0
  while (true) {
    const { data } = await supabase
      .from("clip_queue")
      .select("id, video_id, clip_index, platform, caption, posted_at, zernio_post_id")
      .eq("status", "posted")
      .not("zernio_post_id", "is", null)
      .lt("clip_index", 50)
      .order("posted_at", { ascending: false })
      .range(from, from + PAGE - 1)
    if (!data || data.length === 0) break
    all.push(...(data as ClipRow[]))
    if (data.length < PAGE) break
    from += PAGE
  }
  return all
}

async function fetchZernioAnalyticsMap(): Promise<Map<string, ZernioPost>> {
  const map = new Map<string, ZernioPost>()
  await Promise.all(ZERNIO_KEYS.map(async (key) => {
    let page = 1
    while (true) {
      try {
        const res = await fetch(`https://zernio.com/api/v1/analytics?page=${page}`, {
          headers: { Authorization: `Bearer ${key}` },
          cache: "no-store",
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
      } catch { break }
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

type EnrichedPost = ClipRow & { zernio: ZernioPost | null }

function stats(posts: EnrichedPost[]) {
  return {
    views:    posts.reduce((s, p) => s + (p.zernio?.analytics?.views    ?? 0), 0),
    likes:    posts.reduce((s, p) => s + (p.zernio?.analytics?.likes    ?? 0), 0),
    comments: posts.reduce((s, p) => s + (p.zernio?.analytics?.comments ?? 0), 0),
    shares:   posts.reduce((s, p) => s + (p.zernio?.analytics?.shares   ?? 0), 0),
    count:    posts.length,
  }
}

function periodCutoff(period: Period): number {
  const now = Date.now()
  if (period === "today")  return now - 24  * 3600_000
  if (period === "week")   return now - 7   * 86400_000
  if (period === "month")  return now - 30  * 86400_000
  return 0
}

function buildHref(platform: string, period: string) {
  const p = new URLSearchParams()
  if (platform !== "all") p.set("platform", platform)
  if (period   !== "all") p.set("period",   period)
  const qs = p.toString()
  return `/performance${qs ? `?${qs}` : ""}`
}

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string; period?: string }>
}) {
  const { platform = "all", period = "all" } = await searchParams
  const activePlatform = PLATFORMS.includes(platform as Platform) ? (platform as Platform) : "all"
  const activePeriod   = PERIODS.includes(period as Period)       ? (period as Period)     : "all"

  const [allPosts, zernioMap] = await Promise.all([
    getAllPosts(),
    fetchZernioAnalyticsMap(),
  ])

  // Enrich every post with Zernio analytics
  const allEnriched: EnrichedPost[] = allPosts.map(p => ({
    ...p,
    zernio: (p.zernio_post_id ? zernioMap.get(p.zernio_post_id) : undefined) ?? null,
  }))

  // Always-visible panels: all-time and rolling 7-day (ignores platform filter)
  const weekCutoff  = Date.now() - 7 * 86400_000
  const allTimeStats = stats(allEnriched)
  const weekStats    = stats(allEnriched.filter(p =>
    p.posted_at && new Date(p.posted_at).getTime() >= weekCutoff
  ))

  // Days active + views/day
  const oldest = [...allEnriched].filter(p => p.posted_at).sort(
    (a, b) => new Date(a.posted_at!).getTime() - new Date(b.posted_at!).getTime()
  )[0]
  const daysActive  = oldest ? Math.max(1, Math.ceil((Date.now() - new Date(oldest.posted_at!).getTime()) / 86400_000)) : 0
  const viewsPerDay = daysActive > 0 ? Math.round(allTimeStats.views / daysActive) : 0

  // Detail section: apply platform + period filters
  const cutoff = periodCutoff(activePeriod)
  const enriched = allEnriched.filter(p => {
    const platformOk = activePlatform === "all" || p.platform === activePlatform
    const periodOk   = activePeriod   === "all" || (p.posted_at && new Date(p.posted_at).getTime() >= cutoff)
    return platformOk && periodOk
  })

  const filteredStats  = stats(enriched)
  const bestPerformer  = [...enriched]
    .filter(p => (p.zernio?.analytics?.views ?? 0) > 0)
    .sort((a, b) => (b.zernio?.analytics?.views ?? 0) - (a.zernio?.analytics?.views ?? 0))[0] ?? null
  const liveCount      = enriched.filter(p => p.zernio?.status === "published").length
  const failedCount    = enriched.filter(p => p.zernio?.status === "failed").length

  return (
    <div>
      <AutoRefresh intervalSeconds={60} />

      {/* Header */}
      <div style={{ marginBottom: "2.5rem" }}>
        <h1 style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)", fontWeight: 300, letterSpacing: "-0.03em", color: "var(--text)", marginBottom: "0.5rem" }}>
          Performance
        </h1>
        <p style={{ fontSize: "13px", color: "var(--muted)" }}>
          Live stats from Zernio
          {daysActive > 0 && ` · ${daysActive} days active · ${fmt(viewsPerDay)} views/day avg`}
        </p>
      </div>

      {/* Always-visible dual summary: All Time + This Week */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1px", background: "var(--border)", border: "1px solid var(--border)", marginBottom: "2.5rem" }}>
        {[
          { label: "All Time",      s: allTimeStats, sub: `${allTimeStats.count} posts` },
          { label: "Last 7 Days",   s: weekStats,    sub: `${weekStats.count} posts` },
        ].map(({ label, s, sub }) => (
          <div key={label} style={{ background: "var(--bg)", padding: "1.5rem" }}>
            <div style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--faint)", marginBottom: "1rem" }}>
              {label}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem 1.5rem" }}>
              {[
                { key: "Views",    v: s.views },
                { key: "Likes",    v: s.likes },
                { key: "Comments", v: s.comments },
                { key: "Shares",   v: s.shares },
              ].map(({ key, v }) => (
                <div key={key}>
                  <div style={{ fontSize: "1.5rem", fontWeight: 200, letterSpacing: "-0.04em", lineHeight: 1, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
                    {fmt(v)}
                  </div>
                  <div style={{ fontSize: "10px", color: "var(--faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginTop: "3px" }}>
                    {key}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: "11px", color: "var(--faint)", marginTop: "1rem" }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Platform filter */}
      <div style={{ display: "flex", gap: "6px", marginBottom: "0.75rem", flexWrap: "wrap" }}>
        {PLATFORMS.map(p => {
          const isActive = activePlatform === p
          return (
            <a key={p} href={buildHref(p, activePeriod)} style={{
              fontSize: "12px", fontWeight: 500, padding: "6px 14px", borderRadius: "100px",
              border: "1px solid",
              borderColor: isActive ? (p === "all" ? "var(--text)" : PLATFORM_COLOR[p]) : "var(--border)",
              color:       isActive ? (p === "all" ? "var(--text)" : PLATFORM_COLOR[p]) : "var(--muted)",
              background:  isActive ? (p === "all" ? "var(--surface)" : `${PLATFORM_COLOR[p]}0f`) : "transparent",
              textDecoration: "none", transition: "all 0.15s",
              textTransform: p === "all" ? "none" : "capitalize",
            }}>
              {p === "all" ? "All Platforms" : PLATFORM_LABEL[p]}
            </a>
          )
        })}
      </div>

      {/* Period filter */}
      <div style={{ display: "flex", gap: "6px", marginBottom: "2.5rem", flexWrap: "wrap", alignItems: "center" }}>
        {PERIODS.map(p => {
          const isActive = activePeriod === p
          return (
            <a key={p} href={buildHref(activePlatform, p)} style={{
              fontSize: "12px", fontWeight: 500, padding: "6px 14px", borderRadius: "100px",
              border: "1px solid",
              borderColor: isActive ? "var(--text)" : "var(--border)",
              color:       isActive ? "var(--text)" : "var(--muted)",
              background:  isActive ? "var(--surface)" : "transparent",
              textDecoration: "none", transition: "all 0.15s",
            }}>
              {PERIOD_LABEL[p]}
            </a>
          )
        })}
        {activePeriod === "today" && (
          <span style={{ fontSize: "11px", color: "var(--faint)", marginLeft: "4px" }}>
            Analytics sync every ~2h
          </span>
        )}
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
              Top performer · {PERIOD_LABEL[activePeriod]}
            </p>
            <p style={{ fontSize: "13px", color: "var(--text)", lineHeight: 1.5, marginBottom: "10px",
              overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical" as const }}>
              {bestPerformer.caption}
            </p>
            <div style={{ display: "flex", gap: "16px" }}>
              {[
                { label: "views", value: bestPerformer.zernio?.analytics?.views ?? 0 },
                { label: "likes", value: bestPerformer.zernio?.analytics?.likes ?? 0 },
                { label: "eng.",  value: bestPerformer.zernio?.analytics?.engagementRate },
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

      {/* Filtered summary stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "1px", background: "var(--border)", border: "1px solid var(--border)", marginBottom: "3rem" }}>
        {[
          { label: "Views",    value: fmt(filteredStats.views) },
          { label: "Likes",    value: fmt(filteredStats.likes) },
          { label: "Comments", value: fmt(filteredStats.comments) },
          { label: "Shares",   value: fmt(filteredStats.shares) },
        ].map(s => (
          <div key={s.label} style={{ background: "var(--bg)", padding: "1.5rem" }}>
            <div style={{ fontSize: "2rem", fontWeight: 200, letterSpacing: "-0.04em", lineHeight: 1, color: "var(--text)", marginBottom: "0.5rem", fontVariantNumeric: "tabular-nums" }}>
              {s.value}
            </div>
            <div style={{ fontSize: "11px", fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)" }}>
              {s.label}
            </div>
          </div>
        ))}
      </div>

      {/* Posts list */}
      <div style={{ borderTop: "1px solid var(--border)" }}>
        <p style={{ fontSize: "11px", color: "var(--faint)", padding: "0.75rem 0", marginBottom: "0" }}>
          {enriched.length} post{enriched.length !== 1 ? "s" : ""} · {liveCount} live{failedCount > 0 ? ` · ${failedCount} failed` : ""}
        </p>
        {enriched.length === 0 ? (
          <p style={{ padding: "4rem 0", textAlign: "center", color: "var(--faint)", fontSize: "13px" }}>
            No posts in this period.
          </p>
        ) : enriched.map(post => {
          const z = post.zernio
          const isLive    = z?.status === "published"
          const hasFailed = z?.status === "failed"
          const isSyncing = z?.syncStatus === "pending" && !z?.analytics?.lastUpdated
          const a = z?.analytics ?? {}

          return (
            <div key={post.id} style={{
              borderBottom: "1px solid var(--border)", padding: "1.125rem 0",
              display: "grid", gridTemplateColumns: "auto 1fr auto", gap: "1rem", alignItems: "center",
            }}>
              <div style={{ width: "36px", height: "64px", overflow: "hidden", background: "var(--surface)", flexShrink: 0 }}>
                <img
                  src={`https://img.youtube.com/vi/${post.video_id}/hqdefault.jpg`}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center", display: "block" }}
                />
              </div>

              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                  <span style={{ fontSize: "11px", fontWeight: 600, color: PLATFORM_COLOR[post.platform], letterSpacing: "0.02em" }}>
                    {PLATFORM_LABEL[post.platform] ?? post.platform}
                  </span>
                  <span style={{ fontSize: "10px", color: isLive ? "var(--green)" : hasFailed ? "var(--red)" : "var(--faint)" }}>
                    {isLive ? "● Live" : hasFailed ? "● Failed" : "● Pending"}
                  </span>
                  <span style={{ fontSize: "11px", color: "var(--faint)" }}>
                    · Clip {post.clip_index} · {timeAgo(post.posted_at ?? "")}
                  </span>
                </div>

                <p style={{
                  fontSize: "13px", color: "var(--text)", lineHeight: 1.5, marginBottom: "8px",
                  overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical" as const,
                }}>
                  {post.caption || <span style={{ color: "var(--faint)", fontStyle: "italic" }}>No caption</span>}
                </p>

                {isSyncing ? (
                  <span style={{ fontSize: "11px", color: "var(--faint)", fontStyle: "italic" }}>
                    Analytics syncing — check back in a few hours
                  </span>
                ) : (
                  <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
                    {[
                      { label: "views",    value: a.views    ?? 0 },
                      { label: "likes",    value: a.likes    ?? 0 },
                      { label: "comments", value: a.comments ?? 0 },
                      { label: "shares",   value: a.shares   ?? 0 },
                      { label: "saves",    value: a.saves    ?? 0 },
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
                      <a href={z.platformPostUrl} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: "11px", color: "var(--muted)", textDecoration: "none", marginLeft: "4px", borderBottom: "1px solid var(--border)" }}>
                        View post ↗
                      </a>
                    )}
                  </div>
                )}
              </div>

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
