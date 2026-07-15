import Anthropic from "@anthropic-ai/sdk"
import PauseToggle from "@/components/PauseToggle"
import CountdownTimer from "@/components/CountdownTimer"
import Briefing from "@/components/Briefing"
import AnimatedStat from "@/components/AnimatedStat"
import sql from "@/lib/db"

export const revalidate = 60

const PLATFORMS = ["instagram", "tiktok", "youtube", "facebook"] as const
type Platform = (typeof PLATFORMS)[number]

const PLATFORM_COLOR: Record<Platform, string> = {
  instagram: "#e1306c",
  tiktok:    "#111111",
  youtube:   "#ff0000",
  facebook:  "#1877f2",
}

const PLATFORM_LABEL: Record<Platform, string> = {
  instagram: "Instagram",
  tiktok:    "TikTok",
  youtube:   "YouTube Shorts",
  facebook:  "Facebook Reels",
}

const ZERNIO_KEYS = [
  process.env.ZERNIO_API_KEY!,
  process.env.ZERNIO_API_KEY_2!,
]

async function fetchZernioMap(): Promise<Map<string, { views: number; engagementRate: number }>> {
  const map = new Map<string, { views: number; engagementRate: number }>()
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
        for (const post of (data.posts ?? [])) {
          if (post.latePostId) {
            map.set(post.latePostId, {
              views:          post.analytics?.views          ?? 0,
              engagementRate: post.analytics?.engagementRate ?? 0,
            })
          }
        }
        const pag = data.pagination
        if (!pag || page >= pag.pages) break
        page++
      } catch { break }
    }
  }))
  return map
}

// Inline SVG sparkline — posts published per day, oldest→newest left→right
function Sparkline({ values }: { values: number[] }) {
  const W = 120, H = 36, pad = 2
  const max = Math.max(...values, 1)
  const step = (W - pad * 2) / (values.length - 1)
  const pts = values.map((v, i) => {
    const x = pad + i * step
    const y = H - pad - (v / max) * (H - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(" ")

  // Area fill path
  const first = `${pad.toFixed(1)},${H - pad}`
  const last  = `${(pad + (values.length - 1) * step).toFixed(1)},${H - pad}`
  const area  = `M ${first} L ${pts.split(" ").map(p => `${p}`).join(" L ")} L ${last} Z`

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block", animation: "revealLeft 1.2s ease both", animationDelay: "0.4s" }}>
      <path d={area} fill="var(--text)" fillOpacity="0.06" />
      <polyline points={pts} fill="none" stroke="var(--text)" strokeWidth="1.5" strokeOpacity="0.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* Dot on last (today) point */}
      {(() => {
        const last = values[values.length - 1]
        const x = pad + (values.length - 1) * step
        const y = H - pad - (last / max) * (H - pad * 2)
        return <circle cx={x.toFixed(1)} cy={y.toFixed(1)} r="2.5" fill="var(--text)" fillOpacity="0.7" />
      })()}
    </svg>
  )
}

function timeAgo(dateStr: string) {
  if (!dateStr) return ""
  const diff = Date.now() - new Date(dateStr).getTime()
  const h = Math.floor(diff / 3600000)
  const d = Math.floor(diff / 86400000)
  if (h < 1) return "just now"
  if (h < 24) return `${h}h ago`
  if (d === 1) return "yesterday"
  if (d < 30) return `${d}d ago`
  return new Date(dateStr).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

function fmt(n: number) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000)    return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

async function generateBriefing(data: {
  totalPosted: number
  weekPostCount: number
  episodes: number
  pending: number
  bestThisWeek: { hook: string; views: number; platform: string } | null
  platformTrends: { platform: string; trend: string; weekAvg: number }[]
}): Promise<string> {
  const today = new Date().toISOString().slice(0, 10)

  const cachedRows = await sql`SELECT value FROM settings WHERE key = ${"briefing_" + today} LIMIT 1`
  if (cachedRows[0]?.value?.text) return cachedRows[0].value.text as string

  const platformLines = data.platformTrends
    .map(p => {
      const arrow = p.trend === "up" ? "↑" : p.trend === "down" ? "↓" : "→"
      return `${p.platform}: ${arrow}${p.weekAvg > 0 ? ` (avg ${Math.round(p.weekAvg)} views)` : ""}`
    })
    .join(", ")

  const bestLine = data.bestThisWeek
    ? `Best clip this week: "${data.bestThisWeek.hook}", ${data.bestThisWeek.views.toLocaleString()} views on ${data.bestThisWeek.platform}`
    : "No view data synced yet this week"

  const prompt = `You are the voice of Afropolitan Content Studio, a social media automation platform posting Afropolitan podcast clips to TikTok, Instagram, YouTube Shorts, and Facebook Reels.

Write a 2-3 sentence daily briefing. Be direct, sharp, slightly personal, like a smart analyst who knows the business well. Reference the real numbers naturally. No bullet points, no headers, no fluff, no greeting, no em dashes.

Data:
- Total posts published all-time: ${data.totalPosted}
- Posts this week: ${data.weekPostCount}
- Episodes processed: ${data.episodes}
- Clips queued to post next: ${data.pending}
- ${bestLine}
- Platform trends this week: ${platformLines}

Write the briefing:`

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 180,
      messages: [{ role: "user", content: prompt }],
    })
    const text = (message.content[0] as { type: string; text: string }).text.trim()

    const bk = "briefing_" + today
    const bv = JSON.stringify({ text, generated_at: new Date().toISOString() })
    await sql`INSERT INTO settings (key, value) VALUES (${bk}, ${bv}::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`

    return text
  } catch {
    return ""
  }
}

export default async function OverviewPage() {
  const now    = Date.now()
  const week   = new Date(now - 7  * 86400_000).toISOString()
  const month  = new Date(now - 14 * 86400_000).toISOString() // 14 days for health comparison

  const [
    { totalPosted, pending, episodes, platformCounts, recentClips, last14Posts },
    zernioMap,
    pausedRows,
  ] = await Promise.all([
    (async () => {
      const [postedRes, pendingRes, episodesRes, platformRes, recentRes, last14Res] = await Promise.all([
        sql`SELECT COUNT(*)::int AS cnt FROM clip_queue WHERE status = 'posted'`,
        sql`SELECT COUNT(*)::int AS cnt FROM clip_queue WHERE status = 'pending'`,
        sql`SELECT COUNT(*)::int AS cnt FROM processed_videos`,
        sql`SELECT platform FROM clip_queue WHERE status = 'posted'`,
        sql`SELECT video_id, clip_index, platform, status, caption, hook, posted_at, zernio_post_id
            FROM clip_queue WHERE status = 'posted' ORDER BY posted_at DESC LIMIT 60`,
        sql`SELECT platform, posted_at, zernio_post_id, hook, caption, video_id, clip_index
            FROM clip_queue WHERE status = 'posted' AND posted_at >= ${month}
            AND zernio_post_id IS NOT NULL ORDER BY posted_at DESC`,
      ])

      const platformCounts = PLATFORMS.reduce((acc, p) => ({ ...acc, [p]: 0 }), {} as Record<Platform, number>)
      for (const row of platformRes) {
        if (row.platform in platformCounts) platformCounts[row.platform as Platform]++
      }

      type ClipEntry = { video_id: string; clip_index: number; caption: string; hook: string; posted_at: string; platforms: Record<string, string>; zernio_post_id: string | null }
      const map = new Map<string, ClipEntry>()
      for (const row of recentRes) {
        if (row.clip_index > 50) continue
        const key = `${row.video_id}-${row.clip_index}`
        if (!map.has(key)) {
          map.set(key, { video_id: row.video_id, clip_index: row.clip_index, caption: row.caption ?? "", hook: row.hook ?? "", posted_at: row.posted_at ?? "", platforms: {}, zernio_post_id: row.zernio_post_id })
        }
        map.get(key)!.platforms[row.platform] = row.status
      }
      const recentClips = Array.from(map.values()).slice(0, 8)

      let episodeCount = Number(episodesRes[0]?.cnt ?? 0)
      if (episodeCount === 0) {
        const vids = await sql`SELECT DISTINCT video_id FROM clip_queue`
        episodeCount = vids.length
      }

      return {
        totalPosted: Number(postedRes[0]?.cnt ?? 0),
        pending: Number(pendingRes[0]?.cnt ?? 0),
        episodes: episodeCount,
        platformCounts,
        recentClips,
        last14Posts: last14Res as unknown as {
          platform: string
          posted_at: string | null
          zernio_post_id: string | null
          hook: string | null
          caption: string | null
          video_id: string
          clip_index: number
        }[],
      }
    })(),
    fetchZernioMap(),
    sql`SELECT value FROM settings WHERE key = 'paused' LIMIT 1`,
  ])

  const isPaused = Boolean(pausedRows[0]?.value?.paused)
  const monthLabel = new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" })

  // ── Sparkline: posts published per day, last 7 days ──────────────────────
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now - (6 - i) * 86400_000)
    return d.toISOString().slice(0, 10)
  })
  const postsByDay = new Map(days.map(d => [d, 0]))
  for (const row of last14Posts) {
    if (!row.posted_at) continue
    const day = row.posted_at.slice(0, 10)
    if (postsByDay.has(day)) postsByDay.set(day, (postsByDay.get(day) || 0) + 1)
  }
  const sparkValues = days.map(d => postsByDay.get(d) || 0)
  const weekPostCount = sparkValues.reduce((s, v) => s + v, 0)

  // ── Best clip this week ───────────────────────────────────────────────────
  type Post14 = typeof last14Posts[number]
  const weekPosts = last14Posts.filter((r: Post14) => r.posted_at && r.posted_at >= week)
  const bestThisWeek = weekPosts
    .map((r: Post14) => ({ ...r, views: zernioMap.get(r.zernio_post_id ?? "")?.views ?? 0 }))
    .sort((a, b) => b.views - a.views)[0] ?? null

  // ── Platform health: this week avg views vs all-time avg ─────────────────
  // Use all posted clips (platformCounts has total count), week posts for recent
  const allPostsWithViews = last14Posts.map((r: Post14) => ({
    ...r,
    views: zernioMap.get(r.zernio_post_id ?? "")?.views ?? 0,
  }))

  const platformHealth = PLATFORMS.map(p => {
    const allCount = platformCounts[p]
    // All posts this week (regardless of whether views have synced yet)
    const weekAll = allPostsWithViews.filter((r: Post14 & { views: number }) =>
      r.platform === p && r.posted_at && r.posted_at >= week
    )
    // Subset that has real view data — used for avg and trend only
    const weekWithViews = weekAll.filter((r: { views: number }) => r.views > 0)
    const prevWithViews = allPostsWithViews.filter((r: Post14 & { views: number }) =>
      r.platform === p && r.posted_at && r.posted_at < week && r.views > 0
    )

    const weekAvg = weekWithViews.length > 0
      ? weekWithViews.reduce((s: number, r: { views: number }) => s + r.views, 0) / weekWithViews.length
      : 0
    const prevAvg = prevWithViews.length > 0
      ? prevWithViews.reduce((s: number, r: { views: number }) => s + r.views, 0) / prevWithViews.length
      : 0

    // Only show trend arrow when both periods have enough synced data to compare
    let trend: "up" | "flat" | "down" = "flat"
    if (weekWithViews.length >= 2 && prevWithViews.length >= 2) {
      if (weekAvg >= prevAvg * 1.2) trend = "up"
      else if (weekAvg <= prevAvg * 0.8) trend = "down"
    }

    return {
      platform:    p,
      allCount,
      weekCount:   weekAll.length,       // total posts this week
      syncedCount: weekWithViews.length, // posts with view data
      weekAvg,
      trend,
    }
  })

  const maxCount = Math.max(...PLATFORMS.map(p => platformCounts[p]), 1)

  const briefingText = await generateBriefing({
    totalPosted,
    weekPostCount,
    episodes,
    pending,
    bestThisWeek: bestThisWeek ? { hook: bestThisWeek.hook ?? "", views: bestThisWeek.views, platform: bestThisWeek.platform } : null,
    platformTrends: platformHealth.map(p => ({ platform: p.platform, trend: p.trend, weekAvg: p.weekAvg })),
  })

  return (
    <div style={{ maxWidth: "720px" }}>
      <PauseToggle initialPaused={isPaused} />

      {/* Hero */}
      <section style={{ marginBottom: "4rem" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
          <p style={{ fontSize: "11px", fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--faint)" }}>
            {monthLabel}
          </p>
          <CountdownTimer />
        </div>
        <h1 style={{ fontSize: "clamp(2rem, 4vw, 2.75rem)", fontWeight: 300, lineHeight: 1.12, letterSpacing: "-0.035em", color: "var(--text)", marginBottom: "1.25rem" }}>
          Your content<br />is everywhere.
        </h1>
        <p style={{ fontSize: "1rem", color: "var(--muted)", lineHeight: 1.7, maxWidth: "480px" }}>
          {totalPosted > 0
            ? <>{totalPosted} posts published across Instagram, TikTok, YouTube Shorts and Facebook Reels.{pending > 0 ? ` ${pending} more queued and ready.` : " The pipeline is clear."}</>
            : "The pipeline is running. Posts will appear here once clips are processed and queued."
          }
        </p>
      </section>

      {/* AI Briefing */}
      {briefingText && <Briefing text={briefingText} />}

      {/* Stats + sparkline */}
      <section style={{ marginBottom: "4rem" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1px", background: "var(--border)", border: "1px solid var(--border)" }}>
          <AnimatedStat value={totalPosted}   label="Posts Published" />
          <AnimatedStat value={weekPostCount} label="This Week" />
          <AnimatedStat value={episodes}      label="Episodes" />
        </div>

        {/* Sparkline row */}
        <div style={{ border: "1px solid var(--border)", borderTop: "none", padding: "1rem 1.75rem", display: "flex", alignItems: "center", gap: "1.5rem", background: "var(--bg)" }}>
          <Sparkline values={sparkValues} />
          <div>
            <p style={{ fontSize: "12px", color: "var(--text)", fontWeight: 500, marginBottom: "2px" }}>
              {weekPostCount} posts in the last 7 days
            </p>
            <p style={{ fontSize: "11px", color: "var(--faint)" }}>
              {days.map((d, i) => {
                const label = i === 6 ? "today" : i === 5 ? "yesterday" : new Date(d).toLocaleDateString("en-GB", { weekday: "short" })
                return sparkValues[i] > 0 ? `${label}: ${sparkValues[i]}` : null
              }).filter(Boolean).slice(-3).join(" · ") || "No posts this week"}
            </p>
          </div>
        </div>
      </section>

      {/* Low-queue notice */}
      {pending < 12 && (
        <div style={{
          border: "1px solid var(--border)",
          borderLeft: "3px solid #f59e0b",
          padding: "0.875rem 1.25rem",
          marginBottom: "3rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          background: "var(--bg)",
        }}>
          <div>
            <p style={{ fontSize: "12px", fontWeight: 600, color: "var(--text)", marginBottom: "2px" }}>
              Queue is running low
            </p>
            <p style={{ fontSize: "11px", color: "var(--faint)" }}>
              {pending} clip{pending !== 1 ? "s" : ""} left, about {Math.floor(pending / 8)} day{Math.floor(pending / 8) !== 1 ? "s" : ""} at current pace. Process a new video to keep the pipeline full.
            </p>
          </div>
          <span style={{ fontSize: "18px", flexShrink: 0 }}>⚠</span>
        </div>
      )}

      {/* Best clip this week */}
      {bestThisWeek && bestThisWeek.views > 0 && (
        <section style={{ marginBottom: "4rem", animation: "fadeUp 0.6s ease both", animationDelay: "0.15s" }}>
          <p style={{ fontSize: "11px", fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--faint)", marginBottom: "1rem" }}>
            Best Clip This Week
          </p>
          <div style={{ border: "1px solid var(--border)", display: "grid", gridTemplateColumns: "auto 1fr", overflow: "hidden" }}>
            <div style={{ width: "64px", background: "var(--surface)", overflow: "hidden", flexShrink: 0 }}>
              <img
                src={`https://img.youtube.com/vi/${bestThisWeek.video_id}/hqdefault.jpg`}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center", display: "block" }}
              />
            </div>
            <div style={{ padding: "1.25rem 1.5rem" }}>
              {bestThisWeek.hook && (
                <p style={{ fontSize: "14px", fontWeight: 500, color: "var(--text)", lineHeight: 1.45, marginBottom: "10px",
                  overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>
                  "{bestThisWeek.hook}"
                </p>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                <span style={{ fontSize: "1.5rem", fontWeight: 200, letterSpacing: "-0.04em", color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
                  {fmt(bestThisWeek.views)}
                </span>
                <span style={{ fontSize: "11px", color: "var(--faint)" }}>views</span>
                <span style={{ fontSize: "11px", fontWeight: 600, color: PLATFORM_COLOR[bestThisWeek.platform as Platform] }}>
                  {PLATFORM_LABEL[bestThisWeek.platform as Platform] ?? bestThisWeek.platform}
                </span>
                <span style={{ fontSize: "11px", color: "var(--faint)" }}>
                  {timeAgo(bestThisWeek.posted_at ?? "")}
                </span>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Platform health */}
      <section style={{ marginBottom: "4rem" }}>
        <p style={{ fontSize: "11px", fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--faint)", marginBottom: "1.75rem" }}>
          Platform Health
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {platformHealth.map(({ platform, allCount, weekCount, syncedCount, weekAvg, trend }, barIdx) => {
            const p = platform as Platform
            const pct = Math.round((allCount / maxCount) * 100)
            const trendIcon = trend === "up" ? "↑" : trend === "down" ? "↓" : "→"
            const trendColor = trend === "up" ? "var(--green)" : trend === "down" ? "var(--red)" : "var(--faint)"
            const syncing = weekCount > 0 && syncedCount === 0
            return (
              <div key={p}>
                <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "5px" }}>
                  <span style={{ width: "120px", fontSize: "12px", fontWeight: 500, color: "var(--text)", flexShrink: 0 }}>
                    {PLATFORM_LABEL[p]}
                  </span>
                  <div style={{ flex: 1, height: "2px", background: "var(--border)", borderRadius: "2px" }}>
                    <div style={{ height: "100%", width: `${pct}%`, minWidth: allCount > 0 ? "4px" : 0, background: PLATFORM_COLOR[p], borderRadius: "2px", transformOrigin: "left center", animation: "barGrow 0.7s ease both", animationDelay: `${barIdx * 0.12}s` }} />
                  </div>
                  <span style={{ width: "28px", textAlign: "right", fontSize: "12px", color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                    {allCount}
                  </span>
                  <span style={{ fontSize: "13px", color: trendColor, fontWeight: 600, width: "16px", textAlign: "center" }}>
                    {weekCount > 0 ? trendIcon : ""}
                  </span>
                </div>
                {weekCount > 0 && (
                  <div style={{ paddingLeft: "136px", fontSize: "11px", color: "var(--faint)" }}>
                    {weekCount} post{weekCount !== 1 ? "s" : ""} this week
                    {syncing
                      ? " · analytics syncing…"
                      : weekAvg > 0 ? ` · avg ${fmt(Math.round(weekAvg))} views` : ""
                    }
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* Recent posts */}
      <section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
          <p style={{ fontSize: "11px", fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--faint)" }}>
            Recent Posts
          </p>
          <a href="/queue" style={{ fontSize: "12px", color: "var(--muted)", textDecoration: "none" }}>
            View all →
          </a>
        </div>

        <div style={{ borderTop: "1px solid var(--border)" }}>
          {recentClips.length === 0 ? (
            <p style={{ padding: "3rem 0", color: "var(--faint)", fontSize: "13px", textAlign: "center" }}>No posts yet.</p>
          ) : recentClips.map((clip, i) => (
            <div key={`${clip.video_id}-${clip.clip_index}`}
              style={{ padding: "1.125rem 0", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: "14px", animation: "fadeUp 0.5s ease both", animationDelay: `${i * 0.07}s` }}>
              <div style={{ flexShrink: 0, width: "38px", height: "68px", overflow: "hidden", background: "var(--surface)" }}>
                <img
                  src={`https://img.youtube.com/vi/${clip.video_id}/hqdefault.jpg`}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center", display: "block" }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: "13px", color: "var(--text)", lineHeight: 1.55, marginBottom: "8px",
                  overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>
                  {clip.caption || <span style={{ color: "var(--faint)", fontStyle: "italic" }}>No caption</span>}
                </p>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ display: "flex", gap: "5px", alignItems: "center" }}>
                    {PLATFORMS.map(p => (
                      <span key={p} title={`${PLATFORM_LABEL[p]}: ${clip.platforms[p] ?? "not posted"}`}
                        style={{ display: "inline-block", width: "6px", height: "6px", borderRadius: "50%",
                          background: clip.platforms[p] === "posted" ? PLATFORM_COLOR[p] : "var(--border)" }}
                      />
                    ))}
                  </div>
                  <span style={{ fontSize: "11px", color: "var(--faint)" }}>{timeAgo(clip.posted_at)}</span>
                </div>
              </div>
              <span style={{ fontSize: "10px", color: "var(--faint)", fontWeight: 600, flexShrink: 0 }}>
                #{clip.clip_index}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
