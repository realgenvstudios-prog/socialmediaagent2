import { supabase } from "@/lib/supabase"
import AutoRefresh from "@/components/AutoRefresh"

export const revalidate = 0

const PLATFORMS = ["all", "instagram", "tiktok", "youtube", "facebook"] as const
type Platform = (typeof PLATFORMS)[number]

const PERIODS = ["today", "week", "month", "all"] as const
type Period = (typeof PERIODS)[number]

const PERIOD_LABEL: Record<Period, string> = {
  today: "Today",
  week:  "7 Days",
  month: "30 Days",
  all:   "All Time",
}

const PERIOD_DESC: Record<Period, string> = {
  today: "engagement earned in the last 24h",
  week:  "engagement earned in the last 7 days",
  month: "engagement earned in the last 30 days",
  all:   "cumulative totals",
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

// ── Types ──────────────────────────────────────────────────────────────────────

interface Metrics {
  views:    number
  likes:    number
  comments: number
  shares:   number
  saves:    number
}

const ZERO: Metrics = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 }

interface ZernioAnalytics {
  views?:          number
  likes?:          number
  comments?:       number
  shares?:         number
  saves?:          number
  impressions?:    number
  reach?:          number
  engagementRate?: number
  lastUpdated?:    string | null
}

interface ZernioPost {
  _id:              string
  latePostId:       string
  status:           string
  syncStatus:       string
  content?:         string
  platformPostUrl?: string | null
  analytics?:       ZernioAnalytics
}

interface ClipRow {
  id:             string
  video_id:       string
  clip_index:     number
  platform:       string
  caption:        string | null
  posted_at:      string | null
  zernio_post_id: string | null
}

interface SnapshotRow {
  clip_queue_id: string
  views:         number
  likes:         number
  comments:      number
  shares:        number
  saves:         number
  measured_at:   string
}

type EnrichedPost = ClipRow & {
  zernio:      ZernioPost | null
  cumulative:  Metrics
  delta7d:     Metrics
  periodDelta: Metrics
}

// ── Data fetching ──────────────────────────────────────────────────────────────

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

async function fetchAllSnapshots(): Promise<SnapshotRow[]> {
  const all: SnapshotRow[] = []
  let from = 0
  while (true) {
    const { data } = await supabase
      .from("clip_performance")
      .select("clip_queue_id, views, likes, comments, shares, saves, measured_at")
      .order("measured_at", { ascending: false })
      .range(from, from + 999)
    if (!data || data.length === 0) break
    all.push(...(data as SnapshotRow[]))
    if (data.length < 1000) break
    from += 1000
  }
  return all
}

// ── Delta logic ────────────────────────────────────────────────────────────────

// snapshots must be ordered newest first (enforced by query)
function getBaselineMap(snapshots: SnapshotRow[], cutoffISO: string): Map<string, Metrics> {
  const map = new Map<string, Metrics>()
  for (const row of snapshots) {
    if (row.measured_at >= cutoffISO) continue   // skip snapshots after cutoff
    if (map.has(row.clip_queue_id))   continue   // already have most-recent for this clip
    map.set(row.clip_queue_id, {
      views:    row.views    || 0,
      likes:    row.likes    || 0,
      comments: row.comments || 0,
      shares:   row.shares   || 0,
      saves:    row.saves    || 0,
    })
  }
  return map
}

function computeDelta(
  current:   Metrics,
  baseline:  Metrics | undefined,
  postedAt:  string | null,
  cutoffISO: string,
): Metrics {
  // Treat all-zero baselines as missing — they're from a broken data period
  // where the tracker was saving 0s for everything.
  const validBaseline = baseline && (
    baseline.views > 0 || baseline.likes > 0 || baseline.comments > 0 ||
    baseline.shares > 0 || baseline.saves > 0
  )

  if (validBaseline) {
    return {
      views:    Math.max(0, current.views    - baseline.views),
      likes:    Math.max(0, current.likes    - baseline.likes),
      comments: Math.max(0, current.comments - baseline.comments),
      shares:   Math.max(0, current.shares   - baseline.shares),
      saves:    Math.max(0, current.saves    - baseline.saves),
    }
  }
  // Post was created within the period — all its stats were earned in this period
  if (postedAt && postedAt >= cutoffISO) return current
  // Old post with no valid baseline — delta unknown, show 0
  return ZERO
}

function hasDelta(m: Metrics): boolean {
  return m.views > 0 || m.likes > 0 || m.comments > 0 || m.shares > 0 || m.saves > 0
}

function cumulativeFromZernio(z: ZernioPost | null): Metrics {
  const a = z?.analytics ?? {}
  return {
    views:    a.views    ?? 0,
    likes:    a.likes    ?? 0,
    comments: a.comments ?? 0,
    shares:   a.shares   ?? 0,
    saves:    a.saves    ?? 0,
  }
}

function sumMetrics(posts: EnrichedPost[], pick: (p: EnrichedPost) => Metrics) {
  return posts.reduce((acc, post) => {
    const m = pick(post)
    return {
      views:    acc.views    + m.views,
      likes:    acc.likes    + m.likes,
      comments: acc.comments + m.comments,
      shares:   acc.shares   + m.shares,
      saves:    acc.saves    + m.saves,
      count:    acc.count    + 1,
    }
  }, { ...ZERO, count: 0 })
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function cutoffForPeriod(period: Period): string {
  if (period === "today")  return new Date(Date.now() - 24  * 3600_000).toISOString()
  if (period === "week")   return new Date(Date.now() - 7   * 86400_000).toISOString()
  if (period === "month")  return new Date(Date.now() - 30  * 86400_000).toISOString()
  return new Date(0).toISOString()
}

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function timeAgo(dateStr: string) {
  if (!dateStr) return "—"
  const diff = Date.now() - new Date(dateStr).getTime()
  const h = Math.floor(diff / 3_600_000)
  const d = Math.floor(diff / 86_400_000)
  if (h < 1)  return "just now"
  if (h < 24) return `${h}h ago`
  if (d === 1) return "yesterday"
  if (d < 30)  return `${d}d ago`
  return new Date(dateStr).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

function buildHref(platform: string, period: string) {
  const p = new URLSearchParams()
  if (platform !== "all") p.set("platform", platform)
  if (period   !== "all") p.set("period",   period)
  const qs = p.toString()
  return `/performance${qs ? `?${qs}` : ""}`
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string; period?: string }>
}) {
  const { platform = "all", period = "all" } = await searchParams
  const activePlatform = PLATFORMS.includes(platform as Platform) ? (platform as Platform) : "all"
  const activePeriod   = PERIODS.includes(period as Period)       ? (period as Period)     : "all"

  const [allPosts, zernioMap, snapshots] = await Promise.all([
    getAllPosts(),
    fetchZernioAnalyticsMap(),
    fetchAllSnapshots(),
  ])

  const weekCutoff   = cutoffForPeriod("week")
  const periodCutoff = cutoffForPeriod(activePeriod)

  const weekBaselineMap   = getBaselineMap(snapshots, weekCutoff)
  const periodBaselineMap = activePeriod === "week"
    ? weekBaselineMap
    : getBaselineMap(snapshots, periodCutoff)

  const allEnriched: EnrichedPost[] = allPosts.map(post => {
    const zernio   = post.zernio_post_id ? (zernioMap.get(post.zernio_post_id) ?? null) : null
    const current  = cumulativeFromZernio(zernio)
    return {
      ...post,
      zernio,
      cumulative:  current,
      delta7d:     computeDelta(current, weekBaselineMap.get(post.id),   post.posted_at, weekCutoff),
      periodDelta: activePeriod === "all"
        ? current
        : computeDelta(current, periodBaselineMap.get(post.id), post.posted_at, periodCutoff),
    }
  })

  // Top panels — left is always All Time cumulative; right shows the active period
  // but when "All Time" is selected, right falls back to Last 7 Days to avoid
  // showing identical numbers in both panels.
  const allTimeStats      = sumMetrics(allEnriched, p => p.cumulative)
  const week7dStats       = sumMetrics(allEnriched, p => p.delta7d)
  const weekActiveCount   = allEnriched.filter(p => hasDelta(p.delta7d)).length
  const allPeriodStats    = activePeriod === "all" ? week7dStats    : sumMetrics(allEnriched, p => p.periodDelta)
  const periodActiveCount = activePeriod === "all" ? weekActiveCount : allEnriched.filter(p => hasDelta(p.periodDelta)).length
  const rightPanelLabel   = activePeriod === "all" ? "Last 7 Days"  : PERIOD_LABEL[activePeriod]

  const oldest = [...allEnriched]
    .filter(p => p.posted_at)
    .sort((a, b) => new Date(a.posted_at!).getTime() - new Date(b.posted_at!).getTime())[0]
  const daysActive  = oldest
    ? Math.max(1, Math.ceil((Date.now() - new Date(oldest.posted_at!).getTime()) / 86_400_000))
    : 0
  const viewsPerDay = daysActive > 0 ? Math.round(allTimeStats.views / daysActive) : 0

  // Filtered section — apply platform + period
  const enriched = allEnriched
    .filter(p => {
      const platformOk = activePlatform === "all" || p.platform === activePlatform
      const periodOk   = activePeriod === "all" || hasDelta(p.periodDelta)
      return platformOk && periodOk
    })
    .sort((a, b) =>
      activePeriod === "all"
        ? b.cumulative.views  - a.cumulative.views
        : b.periodDelta.views - a.periodDelta.views
    )

  const filteredStats = sumMetrics(enriched, p => p.periodDelta)
  const bestPerformer = enriched[0] ?? null
  const liveCount     = enriched.filter(p => p.zernio?.status === "published").length
  const failedCount   = enriched.filter(p => p.zernio?.status === "failed").length

  return (
    <div>
      <AutoRefresh intervalSeconds={60} />

      {/* Header */}
      <div style={{ marginBottom: "2.5rem" }}>
        <h1 style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)", fontWeight: 300, letterSpacing: "-0.03em", color: "var(--text)", marginBottom: "0.5rem" }}>
          Performance
        </h1>
        <p style={{ fontSize: "13px", color: "var(--muted)" }}>
          Live stats from socials
          {daysActive > 0 && ` · ${daysActive} days active · ${fmt(viewsPerDay)} views/day avg`}
        </p>
      </div>

      {/* Always-visible: All Time (cumulative) + Last 7 Days (delta) */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1px", background: "var(--border)", border: "1px solid var(--border)", marginBottom: "2.5rem" }}>
        {([
          { label: "All Time",               s: allTimeStats,   sub: `${allTimeStats.count} posts total` },
          { label: rightPanelLabel, s: allPeriodStats, sub: `${periodActiveCount} posts gained engagement` },
        ] as { label: string; s: typeof allTimeStats; sub: string }[]).map(({ label, s, sub }) => (
          <div key={label} style={{ background: "var(--bg)", padding: "1.5rem" }}>
            <div style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--faint)", marginBottom: "1rem" }}>
              {label}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem 1.5rem" }}>
              {([
                { key: "Views",    v: s.views },
                { key: "Likes",    v: s.likes },
                { key: "Comments", v: s.comments },
                { key: "Shares",   v: s.shares },
              ] as const).map(({ key, v }) => (
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
        <span style={{ fontSize: "11px", color: "var(--faint)", marginLeft: "4px" }}>
          {PERIOD_DESC[activePeriod]}
        </span>
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
                { label: "views", value: bestPerformer.periodDelta.views },
                { label: "likes", value: bestPerformer.periodDelta.likes },
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
        <p style={{ fontSize: "11px", color: "var(--faint)", padding: "0.75rem 0" }}>
          {enriched.length} post{enriched.length !== 1 ? "s" : ""} with engagement
          {activePlatform !== "all" && ` on ${PLATFORM_LABEL[activePlatform]}`}
          {liveCount > 0 && ` · ${liveCount} live`}
          {failedCount > 0 && ` · ${failedCount} failed`}
        </p>

        {enriched.length === 0 ? (
          <p style={{ padding: "4rem 0", textAlign: "center", color: "var(--faint)", fontSize: "13px" }}>
            {activePeriod === "all"
              ? "No posts yet."
              : `No engagement earned in this period yet. Analytics update once daily.`}
          </p>
        ) : enriched.map(post => {
          const z  = post.zernio
          const m  = post.periodDelta
          const isLive    = z?.status === "published"
          const hasFailed = z?.status === "failed"
          const isSyncing = z?.syncStatus === "pending" && !z?.analytics?.lastUpdated

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
                      { label: "views",    value: m.views },
                      { label: "likes",    value: m.likes },
                      { label: "comments", value: m.comments },
                      { label: "shares",   value: m.shares },
                      { label: "saves",    value: m.saves },
                    ].map(stat => (
                      <div key={stat.label} style={{ display: "flex", gap: "4px", alignItems: "baseline" }}>
                        <span style={{ fontSize: "13px", fontWeight: 500, color: stat.value > 0 ? "var(--text)" : "var(--faint)", fontVariantNumeric: "tabular-nums" }}>
                          {fmt(stat.value)}
                        </span>
                        <span style={{ fontSize: "10px", color: "var(--faint)", textTransform: "capitalize" }}>
                          {stat.label}
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
                  {isSyncing ? "—" : z?.analytics?.engagementRate ? `${Number(z.analytics.engagementRate).toFixed(1)}%` : "—"}
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
