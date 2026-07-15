import sql from "@/lib/db"

export const revalidate = 300

const PLATFORMS = ["all", "instagram", "facebook"] as const
type Platform = (typeof PLATFORMS)[number]

const PLATFORM_COLOR: Record<string, string> = {
  instagram: "#e1306c",
  facebook:  "#1877f2",
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
    posts:   postsRaw as Post[],
    account: (accountRaw[0] ?? {
      followers: 0, media_count: 0, reach: 0,
      profile_views: 0, accounts_engaged: 0,
      total_interactions: 0, website_clicks: 0,
      prev_followers: null,
    }) as AccountRow,
    totals:  totalsRaw[0] as Record<string, number>,
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
  let account: AccountRow = { followers: 0, media_count: 0 }
  let totals: Record<string, number> = {}
  let hasData = true

  try {
    const d = await getData(activePlatform)
    posts   = d.posts
    account = d.account
    totals  = d.totals
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
          Live data from Meta Graph API · Instagram &amp; Facebook Reels
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
                    {/* Rank */}
                    <div style={{ fontSize: "11px", color: "var(--faint)", fontVariantNumeric: "tabular-nums", paddingTop: "2px" }}>
                      {rank}
                    </div>

                    {/* Thumbnail */}
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

                    {/* Caption + metrics */}
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

                    {/* Engagement rate + link */}
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
