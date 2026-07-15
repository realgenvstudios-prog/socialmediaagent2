import sql from "@/lib/db"

export const revalidate = 300

const PLATFORMS = ["all", "instagram", "facebook"] as const
type Platform = (typeof PLATFORMS)[number]

const PLATFORM_COLOR: Record<string, string> = {
  instagram: "#e1306c",
  facebook:  "#1877f2",
  youtube:   "#ff0000",
}

const TRAFFIC_LABEL: Record<string, string> = {
  SEARCH:            "Search",
  BROWSE_FEATURES:   "Browse",
  RELATED_VIDEO:     "Suggested",
  EXT_URL:           "External",
  NO_LINK_EMBEDDED:  "Embedded",
  SHORTS:            "Shorts",
  SUBSCRIBER:        "Subscribers",
  PLAYLIST:          "Playlists",
  YT_CHANNEL:        "Channel page",
  NOTIFICATION:      "Notifications",
  NO_LINK_OTHER:     "Direct",
  ADVERTISING:       "Ads",
}

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtMs(ms: number) {
  if (!ms) return "—"
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function fmtSec(s: number) {
  if (!s) return "—"
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3_600_000)
  const d = Math.floor(diff / 86_400_000)
  if (h < 1)   return "just now"
  if (h < 24)  return `${h}h ago`
  if (d === 1) return "yesterday"
  if (d < 30)  return `${d}d ago`
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

type Post = {
  id: string
  platform: string
  caption: string | null
  permalink: string | null
  published_at: string | null
  video_id: string | null
  views: number
  reach: number
  likes: number
  comments: number
  shares: number
  saves: number
  avg_watch_time_ms: number
  total_watch_time_ms: number
}

type AccountRow = {
  followers: number
  media_count: number
  reach: number
  profile_views: number
  accounts_engaged: number
  total_interactions: number
  website_clicks: number
  prev_followers: number | null
}

type YoutubeChannel = {
  date: string
  subscribers: number
  subscribers_gained: number
  subscribers_lost: number
  views: number
  watch_minutes: number
  avg_view_duration_s: number
  avg_view_percentage: number
  traffic_sources: Record<string, number> | null
}

type YoutubeVideo = {
  video_id: string
  date: string
  title: string | null
  views: number
  likes: number
  comments: number
  shares: number
  watch_minutes: number
  avg_view_duration_s: number
  avg_view_percentage: number
}

async function getData(platform: Platform) {
  const [postsRaw, accountRaw, totalsRaw] = await Promise.all([
    sql.unsafe(
      `SELECT id, platform, caption, permalink, published_at, video_id,
              views, reach, likes, comments, shares, saves,
              avg_watch_time_ms, total_watch_time_ms
       FROM meta_posts
       ${platform !== "all" ? `WHERE platform = $1` : ""}
       ORDER BY COALESCE(views, 0) + COALESCE(reach, 0) DESC
       LIMIT 100`,
      platform !== "all" ? [platform] : []
    ),
    sql.unsafe(
      `SELECT
         today.followers, today.media_count, today.reach,
         today.profile_views, today.accounts_engaged,
         today.total_interactions, today.website_clicks,
         yesterday.followers AS prev_followers
       FROM meta_account_daily today
       LEFT JOIN meta_account_daily yesterday
         ON yesterday.platform = 'instagram'
        AND yesterday.date = today.date - INTERVAL '1 day'
       WHERE today.platform = 'instagram'
       ORDER BY today.date DESC LIMIT 1`,
      []
    ),
    sql.unsafe(
      `SELECT
         SUM(views)::int              AS total_views,
         SUM(reach)::int              AS total_reach,
         SUM(likes)::int              AS total_likes,
         SUM(comments)::int           AS total_comments,
         SUM(shares)::int             AS total_shares,
         SUM(saves)::int              AS total_saves,
         AVG(NULLIF(avg_watch_time_ms,0))::int AS avg_watch_ms,
         COUNT(*)::int                AS post_count
       FROM meta_posts
       ${platform !== "all" ? "WHERE platform = $1" : ""}`,
      platform !== "all" ? [platform] : []
    ),
  ])

  return {
    posts:   postsRaw as unknown as Post[],
    account: ((accountRaw as unknown as AccountRow[])[0] ?? {
      followers: 0, media_count: 0, reach: 0,
      profile_views: 0, accounts_engaged: 0,
      total_interactions: 0, website_clicks: 0,
      prev_followers: null,
    }) as AccountRow,
    totals:  (totalsRaw as unknown as Record<string, number>[])[0] ?? {},
  }
}

async function getYoutubeData() {
  const [channelRaw, videosRaw] = await Promise.all([
    sql.unsafe(
      `SELECT date, subscribers, subscribers_gained, subscribers_lost,
              views, watch_minutes, avg_view_duration_s, avg_view_percentage,
              traffic_sources
       FROM youtube_channel_daily
       ORDER BY date DESC LIMIT 1`,
      []
    ),
    sql.unsafe(
      `SELECT video_id, date, title, views, likes, comments, shares,
              watch_minutes, avg_view_duration_s, avg_view_percentage
       FROM youtube_video_stats
       WHERE date = (SELECT MAX(date) FROM youtube_video_stats)
       ORDER BY views DESC LIMIT 25`,
      []
    ),
  ])

  return {
    channel: (channelRaw as unknown as YoutubeChannel[])[0] ?? null,
    videos:  videosRaw as unknown as YoutubeVideo[],
  }
}

export default async function SocialPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string }>
}) {
  const { platform = "all" } = await searchParams
  const activePlatform: Platform = PLATFORMS.includes(platform as Platform)
    ? (platform as Platform)
    : "all"

  let posts: Post[] = []
  let account: AccountRow = {
    followers: 0, media_count: 0, reach: 0,
    profile_views: 0, accounts_engaged: 0,
    total_interactions: 0, website_clicks: 0,
    prev_followers: null,
  }
  let totals: Record<string, number> = {}
  let hasData = true

  let ytChannel: YoutubeChannel | null = null
  let ytVideos: YoutubeVideo[] = []

  try {
    const [d, yt] = await Promise.all([getData(activePlatform), getYoutubeData()])
    posts      = d.posts
    account    = d.account
    totals     = d.totals
    ytChannel  = yt.channel
    ytVideos   = yt.videos
  } catch {
    hasData = false
  }

  const t = totals as any

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: "2.5rem" }}>
        <h1 style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)", fontWeight: 300, letterSpacing: "-0.03em", color: "var(--text)", marginBottom: "0.5rem" }}>
          Social Analytics
        </h1>
        <p style={{ fontSize: "13px", color: "var(--muted)" }}>
          Meta Graph API · YouTube Analytics API
        </p>
      </div>

      {!hasData ? (
        <div style={{ padding: "5rem 0", textAlign: "center" }}>
          <p style={{ fontSize: "13px", color: "var(--faint)" }}>
            No data yet — run the fetch workflow or wait for the first scheduled run.
          </p>
        </div>
      ) : (
        <>
          {/* ── YouTube Section ─────────────────────────────────────── */}
          {ytChannel && (
            <div style={{ marginBottom: "3rem" }}>
              <div style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: PLATFORM_COLOR.youtube, marginBottom: "0.75rem", display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ display: "inline-block", width: "6px", height: "6px", borderRadius: "50%", background: PLATFORM_COLOR.youtube }} />
                YouTube Channel · Last 30 Days
              </div>

              {/* Channel stats grid */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1px", background: "var(--border)", border: "1px solid var(--border)", marginBottom: "1px" }}>
                {[
                  { label: "Subscribers",      value: fmt(ytChannel.subscribers),
                    sub: ytChannel.subscribers_gained > 0 ? `+${fmt(ytChannel.subscribers_gained)} gained` : null,
                    subColor: "var(--green)" },
                  { label: "Views (30d)",       value: fmt(ytChannel.views),           sub: null, subColor: "" },
                  { label: "Watch Hours (30d)", value: fmt(Math.round(ytChannel.watch_minutes / 60)), sub: `${fmt(ytChannel.watch_minutes)} minutes`, subColor: "var(--faint)" },
                  { label: "Avg View Duration", value: fmtSec(ytChannel.avg_view_duration_s), sub: null, subColor: "" },
                  { label: "Avg View %",        value: `${ytChannel.avg_view_percentage.toFixed(1)}%`, sub: null, subColor: "" },
                  { label: "Subs Lost (30d)",   value: fmt(ytChannel.subscribers_lost), sub: null, subColor: "" },
                ].map(s => (
                  <div key={s.label} style={{ background: "var(--bg)", padding: "1.25rem 1.5rem" }}>
                    <div style={{ fontSize: "1.5rem", fontWeight: 200, letterSpacing: "-0.04em", color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
                      {s.value}
                    </div>
                    <div style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--faint)", marginTop: "4px" }}>
                      {s.label}
                    </div>
                    {s.sub && (
                      <div style={{ fontSize: "11px", color: s.subColor, marginTop: "3px" }}>
                        {s.sub}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Traffic sources */}
              {ytChannel.traffic_sources && Object.keys(ytChannel.traffic_sources).length > 0 && (() => {
                const sources = Object.entries(ytChannel.traffic_sources!)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 6)
                const total = sources.reduce((s, [, v]) => s + v, 0)
                return (
                  <div style={{ border: "1px solid var(--border)", borderTop: "none", padding: "1.25rem 1.5rem", background: "var(--bg)", marginBottom: "1.5rem" }}>
                    <div style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: "1rem" }}>
                      Traffic Sources
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                      {sources.map(([key, views]) => {
                        const pct = total > 0 ? (views / total) * 100 : 0
                        return (
                          <div key={key}>
                            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                              <span style={{ fontSize: "12px", color: "var(--text)" }}>
                                {TRAFFIC_LABEL[key] ?? key}
                              </span>
                              <span style={{ fontSize: "12px", color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                                {fmt(views)} · {pct.toFixed(1)}%
                              </span>
                            </div>
                            <div style={{ height: "3px", background: "var(--border)", borderRadius: "2px" }}>
                              <div style={{ height: "100%", width: `${pct}%`, background: PLATFORM_COLOR.youtube, borderRadius: "2px", transition: "width 0.3s" }} />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}

              {/* Top YouTube videos */}
              {ytVideos.length > 0 && (
                <div>
                  <div style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: "0.5rem" }}>
                    Top Videos · {ytVideos[0]?.date ? new Date(ytVideos[0].date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "recent"}
                  </div>
                  <div style={{ borderTop: "1px solid var(--border)" }}>
                    {ytVideos.map((v, i) => (
                      <div key={v.video_id} style={{
                        borderBottom: "1px solid var(--border)", padding: "1rem 0",
                        display: "grid", gridTemplateColumns: "20px 64px 1fr auto", gap: "14px", alignItems: "center",
                      }}>
                        <div style={{ fontSize: "11px", color: "var(--faint)", fontVariantNumeric: "tabular-nums" }}>
                          {i + 1}
                        </div>
                        <div style={{ width: "64px", height: "36px", overflow: "hidden", background: "var(--surface)", borderRadius: "2px", flexShrink: 0 }}>
                          <img
                            src={`https://i.ytimg.com/vi/${v.video_id}/mqdefault.jpg`}
                            alt=""
                            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                          />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{
                            fontSize: "12px", color: "var(--text)", marginBottom: "6px",
                            overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis",
                          }}>
                            {v.title ?? v.video_id}
                          </div>
                          <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
                            {[
                              { label: "views",   value: fmt(v.views),      show: v.views > 0 },
                              { label: "likes",   value: fmt(v.likes),      show: v.likes > 0 },
                              { label: "comments",value: fmt(v.comments),   show: v.comments > 0 },
                              { label: "shares",  value: fmt(v.shares),     show: v.shares > 0 },
                              { label: "watch",   value: `${fmt(v.watch_minutes)}m`, show: v.watch_minutes > 0 },
                              { label: "avg view",value: `${v.avg_view_percentage.toFixed(1)}%`, show: v.avg_view_percentage > 0 },
                            ].filter(s => s.show).map(s => (
                              <div key={s.label} style={{ display: "flex", gap: "3px", alignItems: "baseline" }}>
                                <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{s.value}</span>
                                <span style={{ fontSize: "10px", color: "var(--faint)" }}>{s.label}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        <a
                          href={`https://www.youtube.com/watch?v=${v.video_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: "11px", color: "var(--muted)", textDecoration: "none", borderBottom: "1px solid var(--border)", flexShrink: 0 }}
                        >
                          View ↗
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Divider ─────────────────────────────────────────────── */}
          <div style={{ borderTop: "1px solid var(--border)", marginBottom: "2.5rem", paddingTop: "2.5rem" }}>
            <div style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: "0.75rem", display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ display: "inline-block", width: "6px", height: "6px", borderRadius: "50%", background: "#e1306c" }} />
              Meta · Instagram &amp; Facebook
            </div>
          </div>

          {/* Account snapshot — Instagram only */}
          {activePlatform !== "facebook" && (() => {
            const newFollowers = account.prev_followers != null
              ? account.followers - account.prev_followers
              : null
            const accountStats = [
              { label: "Followers",     value: fmt(account.followers),
                sub: newFollowers != null
                  ? (newFollowers >= 0 ? `+${newFollowers} today` : `${newFollowers} today`)
                  : null,
                subColor: newFollowers != null && newFollowers > 0 ? "var(--green)" : "var(--faint)" },
              { label: "Profile Visits",  value: fmt(account.profile_views),    sub: "today", subColor: "var(--faint)" },
              { label: "Daily Reach",     value: fmt(account.reach),             sub: "today", subColor: "var(--faint)" },
              { label: "Accounts Engaged",value: fmt(account.accounts_engaged),  sub: "today", subColor: "var(--faint)" },
              { label: "Interactions",    value: fmt(account.total_interactions), sub: "today", subColor: "var(--faint)" },
              { label: "Website Clicks",  value: fmt(account.website_clicks),    sub: "today", subColor: "var(--faint)" },
            ]
            return (
              <>
                <div style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: "0.75rem" }}>
                  Instagram Account · Today
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1px", background: "var(--border)", border: "1px solid var(--border)", marginBottom: "2.5rem" }}>
                  {accountStats.map(s => (
                    <div key={s.label} style={{ background: "var(--bg)", padding: "1.25rem 1.5rem" }}>
                      <div style={{ fontSize: "1.5rem", fontWeight: 200, letterSpacing: "-0.04em", color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
                        {s.value}
                      </div>
                      <div style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--faint)", marginTop: "4px" }}>
                        {s.label}
                      </div>
                      {s.sub && (
                        <div style={{ fontSize: "11px", color: s.subColor, marginTop: "3px" }}>
                          {s.sub}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )
          })()}

          {/* Aggregate stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "1px", background: "var(--border)", border: "1px solid var(--border)", marginBottom: "2.5rem" }}>
            {[
              { label: "Views",        value: fmt(t.total_views    ?? 0) },
              { label: "Reach",        value: fmt(t.total_reach    ?? 0) },
              { label: "Likes",        value: fmt(t.total_likes    ?? 0) },
              { label: "Saves",        value: fmt(t.total_saves    ?? 0) },
              { label: "Comments",     value: fmt(t.total_comments ?? 0) },
              { label: "Shares",       value: fmt(t.total_shares   ?? 0) },
              { label: "Avg Watch",    value: fmtMs(t.avg_watch_ms ?? 0) },
              { label: "Total Posts",  value: fmt(t.post_count     ?? 0) },
            ].map(s => (
              <div key={s.label} style={{ background: "var(--bg)", padding: "1.25rem 1.5rem" }}>
                <div style={{ fontSize: "1.5rem", fontWeight: 200, letterSpacing: "-0.04em", color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
                  {s.value}
                </div>
                <div style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--faint)", marginTop: "4px" }}>
                  {s.label}
                </div>
              </div>
            ))}
          </div>

          {/* Platform filter */}
          <div style={{ display: "flex", gap: "6px", marginBottom: "2.5rem", flexWrap: "wrap" }}>
            {PLATFORMS.map(p => {
              const isActive = activePlatform === p
              const color    = p === "all" ? "var(--text)" : PLATFORM_COLOR[p]
              return (
                <a key={p} href={p === "all" ? "/social" : `/social?platform=${p}`} style={{
                  fontSize: "12px", fontWeight: 500, padding: "6px 14px", borderRadius: "100px",
                  border: "1px solid",
                  borderColor: isActive ? color : "var(--border)",
                  color:       isActive ? color : "var(--muted)",
                  background:  isActive ? (p === "all" ? "var(--surface)" : `${color}10`) : "transparent",
                  textDecoration: "none", transition: "all 0.15s", textTransform: "capitalize",
                }}>
                  {p === "all" ? "All Platforms" : p === "instagram" ? "Instagram" : "Facebook"}
                </a>
              )
            })}
          </div>

          {/* Posts list */}
          {posts.length === 0 ? (
            <p style={{ padding: "4rem 0", textAlign: "center", color: "var(--faint)", fontSize: "13px" }}>
              No posts found.
            </p>
          ) : (
            <div style={{ borderTop: "1px solid var(--border)" }}>
              <p style={{ fontSize: "11px", color: "var(--faint)", padding: "0.75rem 0" }}>
                {posts.length} post{posts.length !== 1 ? "s" : ""} · sorted by views
              </p>

              {posts.map((post, i) => {
                const color = PLATFORM_COLOR[post.platform] ?? "var(--muted)"
                const rank  = i + 1
                const engagementRate = post.views > 0
                  ? (((post.likes + post.comments + post.shares + post.saves) / post.views) * 100).toFixed(1)
                  : null

                return (
                  <div key={post.id} style={{
                    borderBottom: "1px solid var(--border)", padding: "1.25rem 0",
                    display: "grid", gridTemplateColumns: "20px auto 1fr auto", gap: "14px", alignItems: "start",
                  }}>
                    <div style={{ fontSize: "11px", color: "var(--faint)", fontVariantNumeric: "tabular-nums", paddingTop: "2px" }}>
                      {rank}
                    </div>

                    <div style={{ width: "36px", height: "64px", overflow: "hidden", background: "var(--surface)", flexShrink: 0, borderRadius: "2px" }}>
                      {post.video_id ? (
                        <img
                          src={`https://img.youtube.com/vi/${post.video_id}/hqdefault.jpg`}
                          alt=""
                          style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center", display: "block" }}
                        />
                      ) : (
                        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <span style={{ fontSize: "16px", opacity: 0.3 }}>
                            {post.platform === "instagram" ? "📸" : "📘"}
                          </span>
                        </div>
                      )}
                    </div>

                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                        <span style={{ fontSize: "10px", fontWeight: 600, color, textTransform: "capitalize", letterSpacing: "0.04em" }}>
                          {post.platform === "instagram" ? "Instagram" : "Facebook"}
                        </span>
                        {post.published_at && (
                          <span style={{ fontSize: "10px", color: "var(--faint)" }}>
                            · {timeAgo(post.published_at)}
                          </span>
                        )}
                      </div>

                      <p style={{
                        fontSize: "12px", color: "var(--text)", lineHeight: 1.55, marginBottom: "10px",
                        overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical" as const,
                      }}>
                        {post.caption || <span style={{ color: "var(--faint)", fontStyle: "italic" }}>No caption</span>}
                      </p>

                      <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
                        {[
                          { label: "views",   value: fmt(post.views),    show: post.views > 0 },
                          { label: "reach",   value: fmt(post.reach),    show: post.reach > 0 },
                          { label: "likes",   value: fmt(post.likes),    show: true },
                          { label: "saves",   value: fmt(post.saves),    show: post.saves > 0 },
                          { label: "shares",  value: fmt(post.shares),   show: post.shares > 0 },
                          { label: "watch",   value: fmtMs(post.avg_watch_time_ms), show: post.avg_watch_time_ms > 0 },
                        ].filter(s => s.show).map(s => (
                          <div key={s.label} style={{ display: "flex", gap: "3px", alignItems: "baseline" }}>
                            <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
                              {s.value}
                            </span>
                            <span style={{ fontSize: "10px", color: "var(--faint)" }}>
                              {s.label}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      {engagementRate && (
                        <>
                          <div style={{ fontSize: "1.25rem", fontWeight: 200, letterSpacing: "-0.03em", color: "var(--text)" }}>
                            {engagementRate}%
                          </div>
                          <div style={{ fontSize: "10px", color: "var(--faint)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                            Eng. rate
                          </div>
                        </>
                      )}
                      {post.permalink && (
                        <a
                          href={post.permalink}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: "11px", color: "var(--muted)", textDecoration: "none",
                            display: "block", marginTop: "6px", borderBottom: "1px solid var(--border)" }}
                        >
                          View ↗
                        </a>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
