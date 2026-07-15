import sql from "@/lib/db"

export const revalidate = 300

const PLATFORMS = ["all", "youtube", "instagram", "facebook"] as const
type Platform = (typeof PLATFORMS)[number]

const P = {
  youtube:   { color: "#ff0000", label: "YouTube" },
  instagram: { color: "#e1306c", label: "Instagram" },
  facebook:  { color: "#1877f2", label: "Facebook" },
}

const TRAFFIC_LABEL: Record<string, string> = {
  SEARCH:           "Search",
  BROWSE_FEATURES:  "Browse / Home",
  RELATED_VIDEO:    "Suggested videos",
  EXT_URL:          "External links",
  NO_LINK_EMBEDDED: "Embedded player",
  SHORTS:           "YouTube Shorts",
  SUBSCRIBER:       "Subscribers",
  PLAYLIST:         "Playlists",
  YT_CHANNEL:       "Channel page",
  NOTIFICATION:     "Notifications",
  NO_LINK_OTHER:    "Direct / Unknown",
  ADVERTISING:      "Ads",
}

function fmt(n: number | null | undefined) {
  if (!n) return "0"
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
  if (h < 1) return "just now"
  if (h < 24) return `${h}h ago`
  if (d === 1) return "yesterday"
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

// ── Types ──────────────────────────────────────────────────────────────────────

type YTChannel = {
  date: string; subscribers: number; subscribers_gained: number
  subscribers_lost: number; views: number; watch_minutes: number
  avg_view_duration_s: number; avg_view_percentage: number
  traffic_sources: Record<string, number> | null
}
type YTVideo = {
  video_id: string; title: string | null; views: number; likes: number
  comments: number; shares: number; watch_minutes: number
  avg_view_duration_s: number; avg_view_percentage: number
}
type MetaPost = {
  id: string; platform: string; caption: string | null; permalink: string | null
  published_at: string | null; video_id: string | null
  views: number; reach: number; likes: number; comments: number
  shares: number; saves: number; avg_watch_time_ms: number
}
type IGAccount = {
  followers: number; media_count: number; reach: number
  profile_views: number; accounts_engaged: number
  total_interactions: number; website_clicks: number
  prev_followers: number | null
}

// ── Data fetching ──────────────────────────────────────────────────────────────

async function getYoutubeData() {
  const [chRaw, vidRaw] = await Promise.all([
    sql.unsafe(`SELECT * FROM youtube_channel_daily ORDER BY date DESC LIMIT 1`, []),
    sql.unsafe(
      `SELECT video_id, title, views, likes, comments, shares, watch_minutes,
              avg_view_duration_s, avg_view_percentage
       FROM youtube_video_stats
       WHERE date = (SELECT MAX(date) FROM youtube_video_stats)
       ORDER BY views DESC LIMIT 25`, []
    ),
  ])
  return {
    channel: (chRaw as unknown as YTChannel[])[0] ?? null,
    videos:  vidRaw as unknown as YTVideo[],
  }
}

async function getMetaData(platform: "instagram" | "facebook" | "all") {
  const where = platform === "all" ? "" : `WHERE platform = '${platform}'`
  const [postsRaw, acctRaw, totRaw] = await Promise.all([
    sql.unsafe(
      `SELECT id, platform, caption, permalink, published_at, video_id,
              views, reach, likes, comments, shares, saves, avg_watch_time_ms
       FROM meta_posts ${where}
       ORDER BY COALESCE(views,0) + COALESCE(reach,0) DESC LIMIT 50`, []
    ),
    sql.unsafe(
      `SELECT today.followers, today.media_count, today.reach,
              today.profile_views, today.accounts_engaged,
              today.total_interactions, today.website_clicks,
              yesterday.followers AS prev_followers
       FROM meta_account_daily today
       LEFT JOIN meta_account_daily yesterday
         ON yesterday.platform = 'instagram'
        AND yesterday.date = today.date - INTERVAL '1 day'
       WHERE today.platform = 'instagram'
       ORDER BY today.date DESC LIMIT 1`, []
    ),
    sql.unsafe(
      `SELECT platform,
              SUM(views)::int AS total_views, SUM(reach)::int AS total_reach,
              SUM(likes)::int AS total_likes, SUM(comments)::int AS total_comments,
              SUM(shares)::int AS total_shares, SUM(saves)::int AS total_saves,
              AVG(NULLIF(avg_watch_time_ms,0))::int AS avg_watch_ms,
              COUNT(*)::int AS post_count
       FROM meta_posts ${where}
       GROUP BY platform`, []
    ),
  ])
  const totals = (totRaw as unknown as (Record<string,number> & {platform:string})[])
  const getTotals = (p: string) => totals.find(r => r.platform === p) ?? {}
  return {
    posts:   postsRaw as unknown as MetaPost[],
    account: ((acctRaw as unknown as IGAccount[])[0] ?? {
      followers: 0, media_count: 0, reach: 0,
      profile_views: 0, accounts_engaged: 0,
      total_interactions: 0, website_clicks: 0, prev_followers: null,
    }) as IGAccount,
    igTotals: getTotals("instagram") as Record<string,number>,
    fbTotals: getTotals("facebook")  as Record<string,number>,
  }
}

// ── Chart helpers ──────────────────────────────────────────────────────────────

function HBar({ value, max, color, height = 3 }: { value: number; max: number; color: string; height?: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div style={{ height: `${height}px`, background: "var(--border)", borderRadius: "99px", overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: "99px", minWidth: pct > 0 ? "3px" : 0 }} />
    </div>
  )
}

function StatCard({ label, value, sub, subColor, accent }:
  { label: string; value: string | number; sub?: string | null; subColor?: string; accent?: string }) {
  return (
    <div style={{ background: "var(--bg)", padding: "1.25rem 1.5rem", borderRight: "1px solid var(--border)" }}>
      {accent && <div style={{ width: "20px", height: "2px", background: accent, borderRadius: "1px", marginBottom: "12px" }} />}
      <div style={{ fontSize: "1.75rem", fontWeight: 200, letterSpacing: "-0.04em", color: "var(--text)", fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--faint)", marginTop: "6px" }}>
        {label}
      </div>
      {sub && <div style={{ fontSize: "11px", color: subColor ?? "var(--faint)", marginTop: "3px" }}>{sub}</div>}
    </div>
  )
}

function SectionHeader({ platform, children }: { platform: keyof typeof P; children: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "1.5rem" }}>
      <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: P[platform].color, flexShrink: 0 }} />
      <span style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text)" }}>
        {children}
      </span>
    </div>
  )
}

// ── Platform views ─────────────────────────────────────────────────────────────

function YouTubeView({ channel, videos }: { channel: YTChannel | null; videos: YTVideo[] }) {
  if (!channel && videos.length === 0) {
    return <p style={{ color: "var(--faint)", fontSize: "13px", padding: "3rem 0" }}>No YouTube data yet.</p>
  }
  const maxViews = Math.max(...videos.map(v => v.views), 1)
  const sources = channel?.traffic_sources
    ? Object.entries(channel.traffic_sources).sort(([,a],[,b]) => b - a).slice(0, 8)
    : []
  const totalTraffic = sources.reduce((s, [,v]) => s + v, 0)

  return (
    <div>
      <SectionHeader platform="youtube">YouTube Channel · Last 30 Days</SectionHeader>

      {channel && (
        <>
          {/* Stats grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", border: "1px solid var(--border)", marginBottom: "2rem" }}>
            <StatCard label="Subscribers"      value={fmt(channel.subscribers)}
              sub={channel.subscribers_gained > 0 ? `+${channel.subscribers_gained} gained` : null}
              subColor="var(--green)" accent={P.youtube.color} />
            <StatCard label="Views (30d)"      value={fmt(channel.views)} accent={P.youtube.color} />
            <StatCard label="Watch Hours (30d)" value={fmt(Math.round(channel.watch_minutes / 60))}
              sub={`${fmt(channel.watch_minutes)} minutes total`} accent={P.youtube.color} />
            <StatCard label="Avg Viewed"       value={`${channel.avg_view_percentage.toFixed(1)}%`}
              sub={`Avg duration ${fmtSec(channel.avg_view_duration_s)}`} accent={P.youtube.color} />
          </div>

          {/* Traffic sources */}
          {sources.length > 0 && (
            <div style={{ border: "1px solid var(--border)", padding: "1.5rem", marginBottom: "2rem" }}>
              <div style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: "1.25rem" }}>
                Where viewers find your videos
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 2.5rem" }}>
                {sources.map(([key, views]) => {
                  const pct = totalTraffic > 0 ? (views / totalTraffic) * 100 : 0
                  return (
                    <div key={key} style={{ marginBottom: "1rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
                        <span style={{ fontSize: "12px", color: "var(--text)" }}>{TRAFFIC_LABEL[key] ?? key}</span>
                        <span style={{ fontSize: "12px", color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                          {fmt(views)} · <span style={{ color: P.youtube.color }}>{pct.toFixed(0)}%</span>
                        </span>
                      </div>
                      <HBar value={views} max={totalTraffic} color={P.youtube.color} height={3} />
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* Top videos */}
      {videos.length > 0 && (
        <div>
          <div style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: "0.75rem" }}>
            Top {videos.length} Videos by Views
          </div>
          <div style={{ border: "1px solid var(--border)" }}>
            {videos.map((v, i) => (
              <div key={v.video_id} style={{
                display: "grid", gridTemplateColumns: "28px 80px 1fr auto",
                gap: "14px", alignItems: "center",
                padding: "0.9rem 1rem",
                borderBottom: i < videos.length - 1 ? "1px solid var(--border)" : "none",
              }}>
                <span style={{ fontSize: "11px", color: "var(--faint)", fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
                  {i + 1}
                </span>
                <div style={{ width: "80px", height: "45px", background: "var(--surface)", borderRadius: "2px", overflow: "hidden", flexShrink: 0 }}>
                  <img src={`https://i.ytimg.com/vi/${v.video_id}/mqdefault.jpg`} alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "12px", color: "var(--text)", marginBottom: "8px",
                    overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                    {v.title ?? v.video_id}
                  </div>
                  <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", marginBottom: "8px" }}>
                    {[
                      { l: "views",    n: fmt(v.views),      show: v.views > 0 },
                      { l: "likes",    n: fmt(v.likes),      show: v.likes > 0 },
                      { l: "comments", n: fmt(v.comments),   show: v.comments > 0 },
                      { l: "watch",    n: `${fmt(v.watch_minutes)}m`, show: v.watch_minutes > 0 },
                      { l: "avg view", n: `${v.avg_view_percentage.toFixed(1)}%`, show: v.avg_view_percentage > 0 },
                    ].filter(s => s.show).map(s => (
                      <span key={s.l} style={{ fontSize: "11px", color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                        <span style={{ color: "var(--text)", fontWeight: 500 }}>{s.n}</span> {s.l}
                      </span>
                    ))}
                  </div>
                  <HBar value={v.views} max={maxViews} color={P.youtube.color} height={2} />
                </div>
                <a href={`https://www.youtube.com/watch?v=${v.video_id}`} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: "11px", color: "var(--muted)", textDecoration: "none",
                    borderBottom: "1px solid var(--border)", flexShrink: 0, paddingBottom: "1px" }}>
                  View ↗
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function MetaPostsList({ posts, color, maxViews }: { posts: MetaPost[]; color: string; maxViews: number }) {
  if (posts.length === 0) return (
    <p style={{ color: "var(--faint)", fontSize: "13px", padding: "3rem 0" }}>No posts found.</p>
  )
  return (
    <div style={{ border: "1px solid var(--border)" }}>
      {posts.map((post, i) => {
        const engRate = post.views > 0
          ? (((post.likes + post.comments + post.shares + post.saves) / post.views) * 100).toFixed(1)
          : null
        return (
          <div key={post.id} style={{
            display: "grid", gridTemplateColumns: "28px 36px 1fr auto",
            gap: "12px", alignItems: "center",
            padding: "0.9rem 1rem",
            borderBottom: i < posts.length - 1 ? "1px solid var(--border)" : "none",
          }}>
            <span style={{ fontSize: "11px", color: "var(--faint)", textAlign: "right" }}>{i + 1}</span>
            <div style={{ width: "36px", height: "64px", background: "var(--surface)", borderRadius: "2px", overflow: "hidden", flexShrink: 0 }}>
              {post.video_id
                ? <img src={`https://img.youtube.com/vi/${post.video_id}/hqdefault.jpg`} alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.25, fontSize: "18px" }}>
                    {post.platform === "instagram" ? "📸" : "📘"}
                  </div>
              }
            </div>
            <div style={{ minWidth: 0 }}>
              {post.published_at && (
                <div style={{ fontSize: "10px", color: "var(--faint)", marginBottom: "4px" }}>
                  {timeAgo(post.published_at)}
                </div>
              )}
              <p style={{ fontSize: "12px", color: "var(--text)", lineHeight: 1.5, marginBottom: "8px",
                overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>
                {post.caption || <em style={{ color: "var(--faint)" }}>No caption</em>}
              </p>
              <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", marginBottom: "8px" }}>
                {[
                  { l: "views",   n: fmt(post.views),   show: post.views > 0 },
                  { l: "reach",   n: fmt(post.reach),   show: post.reach > 0 },
                  { l: "likes",   n: fmt(post.likes),   show: post.likes > 0 },
                  { l: "saves",   n: fmt(post.saves),   show: post.saves > 0 },
                  { l: "shares",  n: fmt(post.shares),  show: post.shares > 0 },
                  { l: "watch",   n: fmtMs(post.avg_watch_time_ms), show: post.avg_watch_time_ms > 0 },
                ].filter(s => s.show).map(s => (
                  <span key={s.l} style={{ fontSize: "11px", color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                    <span style={{ color: "var(--text)", fontWeight: 500 }}>{s.n}</span> {s.l}
                  </span>
                ))}
              </div>
              <HBar value={post.views || post.reach} max={maxViews} color={color} height={2} />
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              {engRate && (
                <div style={{ marginBottom: "6px" }}>
                  <div style={{ fontSize: "1rem", fontWeight: 300, letterSpacing: "-0.03em", color: "var(--text)" }}>{engRate}%</div>
                  <div style={{ fontSize: "9px", color: "var(--faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>eng</div>
                </div>
              )}
              {post.permalink && (
                <a href={post.permalink} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: "11px", color: "var(--muted)", textDecoration: "none",
                    borderBottom: "1px solid var(--border)", paddingBottom: "1px" }}>
                  View ↗
                </a>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function InstagramView({ account, posts, totals }: { account: IGAccount; posts: MetaPost[]; totals: Record<string,number> }) {
  const newFollowers = account.prev_followers != null ? account.followers - account.prev_followers : null
  const maxViews = Math.max(...posts.map(p => p.views || p.reach), 1)
  const igPosts = posts.filter(p => p.platform === "instagram")

  return (
    <div>
      <SectionHeader platform="instagram">Instagram · Account Overview</SectionHeader>

      {/* Account snapshot */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", border: "1px solid var(--border)", marginBottom: "2rem" }}>
        <StatCard label="Followers" value={fmt(account.followers)}
          sub={newFollowers != null ? (newFollowers >= 0 ? `+${newFollowers} vs yesterday` : `${newFollowers} vs yesterday`) : null}
          subColor={newFollowers != null && newFollowers > 0 ? "var(--green)" : "var(--faint)"}
          accent={P.instagram.color} />
        <StatCard label="Profile Visits · Today" value={fmt(account.profile_views)} accent={P.instagram.color} />
        <StatCard label="Daily Reach"            value={fmt(account.reach)} accent={P.instagram.color} />
        <StatCard label="Accounts Engaged"       value={fmt(account.accounts_engaged)}
          sub="people who interacted today" accent={P.instagram.color} />
        <StatCard label="Total Interactions"     value={fmt(account.total_interactions)} accent={P.instagram.color} />
        <StatCard label="Website Clicks"         value={fmt(account.website_clicks)} accent={P.instagram.color} />
      </div>

      {/* Post totals */}
      <div style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: "0.75rem" }}>
        All-time post performance
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", border: "1px solid var(--border)", marginBottom: "2rem" }}>
        {[
          { l: "Total Views",    v: fmt(totals.total_views    ?? 0) },
          { l: "Total Reach",    v: fmt(totals.total_reach    ?? 0) },
          { l: "Total Likes",    v: fmt(totals.total_likes    ?? 0) },
          { l: "Total Saves",    v: fmt(totals.total_saves    ?? 0) },
          { l: "Total Comments", v: fmt(totals.total_comments ?? 0) },
          { l: "Total Shares",   v: fmt(totals.total_shares   ?? 0) },
          { l: "Avg Watch Time", v: fmtMs(totals.avg_watch_ms ?? 0) },
          { l: "Posts",          v: fmt(totals.post_count     ?? 0) },
        ].map(s => (
          <StatCard key={s.l} label={s.l} value={s.v} />
        ))}
      </div>

      {/* Posts ranked */}
      <div style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: "0.75rem" }}>
        Top posts · ranked by views
      </div>
      <MetaPostsList posts={igPosts} color={P.instagram.color} maxViews={maxViews} />
    </div>
  )
}

function FacebookView({ posts, totals }: { posts: MetaPost[]; totals: Record<string,number> }) {
  const fbPosts = posts.filter(p => p.platform === "facebook")
  const maxViews = Math.max(...fbPosts.map(p => p.views || p.reach), 1)
  return (
    <div>
      <SectionHeader platform="facebook">Facebook · Post Performance</SectionHeader>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", border: "1px solid var(--border)", marginBottom: "2rem" }}>
        {[
          { l: "Total Likes",    v: fmt(totals.total_likes    ?? 0) },
          { l: "Total Comments", v: fmt(totals.total_comments ?? 0) },
          { l: "Total Shares",   v: fmt(totals.total_shares   ?? 0) },
          { l: "Posts",          v: fmt(totals.post_count     ?? 0) },
        ].map(s => (
          <StatCard key={s.l} label={s.l} value={s.v} accent={P.facebook.color} />
        ))}
      </div>

      <div style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: "0.75rem" }}>
        Top posts · ranked by reach
      </div>
      <MetaPostsList posts={fbPosts} color={P.facebook.color} maxViews={maxViews} />
    </div>
  )
}

function AllView({
  channel, igAccount, igTotals, fbTotals,
}: {
  channel: YTChannel | null
  igAccount: IGAccount
  igTotals: Record<string,number>
  fbTotals: Record<string,number>
}) {
  const cards = [
    {
      platform: "youtube" as const,
      title: "YouTube",
      href: "/social?platform=youtube",
      stats: [
        { l: "Subscribers",   v: fmt(channel?.subscribers) },
        { l: "Views (30d)",   v: fmt(channel?.views) },
        { l: "Watch Hours",   v: fmt(Math.round((channel?.watch_minutes ?? 0) / 60)) },
        { l: "Avg View %",    v: `${(channel?.avg_view_percentage ?? 0).toFixed(1)}%` },
      ],
      empty: !channel,
    },
    {
      platform: "instagram" as const,
      title: "Instagram",
      href: "/social?platform=instagram",
      stats: [
        { l: "Followers",     v: fmt(igAccount.followers) },
        { l: "Daily Reach",   v: fmt(igAccount.reach) },
        { l: "Total Views",   v: fmt(igTotals.total_views) },
        { l: "Posts",         v: fmt(igTotals.post_count) },
      ],
      empty: false,
    },
    {
      platform: "facebook" as const,
      title: "Facebook",
      href: "/social?platform=facebook",
      stats: [
        { l: "Posts",         v: fmt(fbTotals.post_count) },
        { l: "Total Likes",   v: fmt(fbTotals.total_likes) },
        { l: "Total Comments",v: fmt(fbTotals.total_comments) },
        { l: "Total Shares",  v: fmt(fbTotals.total_shares) },
      ],
      empty: false,
    },
  ]

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1px", background: "var(--border)", border: "1px solid var(--border)" }}>
      {cards.map(card => (
        <div key={card.platform} style={{ background: "var(--bg)", padding: "1.5rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "1.25rem" }}>
            <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: P[card.platform].color }} />
            <span style={{ fontSize: "12px", fontWeight: 600, letterSpacing: "0.04em", color: "var(--text)" }}>
              {card.title}
            </span>
          </div>
          {card.empty ? (
            <p style={{ fontSize: "12px", color: "var(--faint)" }}>No data yet</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginBottom: "1.5rem" }}>
              {card.stats.map(s => (
                <div key={s.l}>
                  <div style={{ fontSize: "1.25rem", fontWeight: 200, letterSpacing: "-0.04em", color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
                    {s.v}
                  </div>
                  <div style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--faint)", marginTop: "2px" }}>
                    {s.l}
                  </div>
                </div>
              ))}
            </div>
          )}
          <a href={card.href} style={{
            fontSize: "11px", color: P[card.platform].color, textDecoration: "none",
            borderBottom: `1px solid ${P[card.platform].color}`, paddingBottom: "1px",
          }}>
            View details →
          </a>
        </div>
      ))}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default async function SocialPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string }>
}) {
  const { platform = "all" } = await searchParams
  const active: Platform = PLATFORMS.includes(platform as Platform) ? (platform as Platform) : "all"

  let yt = { channel: null as YTChannel | null, videos: [] as YTVideo[] }
  let meta = {
    posts: [] as MetaPost[],
    account: { followers: 0, media_count: 0, reach: 0, profile_views: 0, accounts_engaged: 0,
               total_interactions: 0, website_clicks: 0, prev_followers: null } as IGAccount,
    igTotals: {} as Record<string,number>,
    fbTotals: {} as Record<string,number>,
  }
  let error = false

  try {
    const [ytData, metaData] = await Promise.all([getYoutubeData(), getMetaData("all")])
    yt   = ytData
    meta = metaData
  } catch {
    error = true
  }

  const tabDefs: { id: Platform; label: string; color: string }[] = [
    { id: "all",       label: "Overview",  color: "var(--text)" },
    { id: "youtube",   label: "YouTube",   color: P.youtube.color },
    { id: "instagram", label: "Instagram", color: P.instagram.color },
    { id: "facebook",  label: "Facebook",  color: P.facebook.color },
  ]

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: "2rem" }}>
        <h1 style={{ fontSize: "clamp(1.4rem, 3vw, 1.9rem)", fontWeight: 300, letterSpacing: "-0.03em", color: "var(--text)", marginBottom: "0.4rem" }}>
          Social Analytics
        </h1>
        <p style={{ fontSize: "13px", color: "var(--muted)" }}>
          YouTube · Instagram · Facebook — updated every 6 hours
        </p>
      </div>

      {/* Platform filter */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "2.5rem", padding: "4px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "8px", width: "fit-content" }}>
        {tabDefs.map(tab => {
          const isActive = active === tab.id
          return (
            <a key={tab.id} href={tab.id === "all" ? "/social" : `/social?platform=${tab.id}`} style={{
              fontSize: "12px", fontWeight: isActive ? 600 : 400,
              padding: "6px 16px", borderRadius: "5px",
              color:      isActive ? (tab.id === "all" ? "var(--bg)" : tab.color) : "var(--muted)",
              background: isActive ? (tab.id === "all" ? "var(--text)" : `${tab.color}18`) : "transparent",
              border:     isActive && tab.id !== "all" ? `1px solid ${tab.color}40` : "1px solid transparent",
              textDecoration: "none", transition: "all 0.15s",
            }}>
              {tab.label}
            </a>
          )
        })}
      </div>

      {error ? (
        <div style={{ padding: "5rem 0", textAlign: "center" }}>
          <p style={{ fontSize: "13px", color: "var(--faint)" }}>
            No data yet — run the fetch workflow or wait for the next scheduled run.
          </p>
        </div>
      ) : (
        <>
          {active === "all" && (
            <AllView
              channel={yt.channel}
              igAccount={meta.account}
              igTotals={meta.igTotals}
              fbTotals={meta.fbTotals}
            />
          )}
          {active === "youtube" && (
            <YouTubeView channel={yt.channel} videos={yt.videos} />
          )}
          {active === "instagram" && (
            <InstagramView account={meta.account} posts={meta.posts} totals={meta.igTotals} />
          )}
          {active === "facebook" && (
            <FacebookView posts={meta.posts} totals={meta.fbTotals} />
          )}
        </>
      )}
    </div>
  )
}
