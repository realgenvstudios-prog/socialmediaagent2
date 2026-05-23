import { supabase } from "@/lib/supabase"
import { createClient } from "@supabase/supabase-js"
import PauseToggle from "@/components/PauseToggle"
import CountdownTimer from "@/components/CountdownTimer"

export const revalidate = 60

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
)

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

async function getData() {
  const weekAgo = new Date()
  weekAgo.setDate(weekAgo.getDate() - 7)

  const [postedRes, pendingRes, weekRes, platformRes, episodesRes, recentRes] = await Promise.all([
    supabase.from("clip_queue").select("id", { count: "exact", head: true }).eq("status", "posted"),
    supabase.from("clip_queue").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("clip_queue").select("id", { count: "exact", head: true }).eq("status", "posted").gte("posted_at", weekAgo.toISOString()),
    supabase.from("clip_queue").select("platform").eq("status", "posted"),
    supabase.from("processed_videos").select("video_id", { count: "exact", head: true }),
    supabase.from("clip_queue")
      .select("video_id, clip_index, platform, status, caption, posted_at")
      .eq("status", "posted")
      .order("posted_at", { ascending: false })
      .limit(60),
  ])

  const platformCounts = PLATFORMS.reduce((acc, p) => ({ ...acc, [p]: 0 }), {} as Record<Platform, number>)
  for (const row of (platformRes.data ?? [])) {
    if (row.platform in platformCounts) platformCounts[row.platform as Platform]++
  }
  const maxCount = Math.max(...Object.values(platformCounts), 1)

  // Group recent by (video_id, clip_index)
  type ClipEntry = { video_id: string; clip_index: number; caption: string; posted_at: string; platforms: Record<string, string> }
  const map = new Map<string, ClipEntry>()
  for (const row of (recentRes.data ?? [])) {
    if (row.clip_index > 50) continue // skip test clips
    const key = `${row.video_id}-${row.clip_index}`
    if (!map.has(key)) {
      map.set(key, { video_id: row.video_id, clip_index: row.clip_index, caption: row.caption ?? "", posted_at: row.posted_at ?? "", platforms: {} })
    }
    map.get(key)!.platforms[row.platform] = row.status
  }
  const recentClips = Array.from(map.values()).slice(0, 10)

  // Episode count fallback
  let episodes = episodesRes.count ?? 0
  if (episodes === 0) {
    const { data: vids } = await supabase.from("clip_queue").select("video_id")
    episodes = new Set((vids ?? []).map((r: any) => r.video_id)).size
  }

  return {
    totalPosted: postedRes.count ?? 0,
    pending: pendingRes.count ?? 0,
    thisWeek: weekRes.count ?? 0,
    episodes,
    platformCounts,
    maxCount,
    recentClips,
  }
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

export default async function OverviewPage() {
  const [
    { totalPosted, pending, thisWeek, episodes, platformCounts, maxCount, recentClips },
    pausedRes,
  ] = await Promise.all([
    getData(),
    admin.from("settings").select("value").eq("key", "paused").single(),
  ])

  const isPaused = Boolean(pausedRes.data?.value?.paused)
  const month = new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" })

  return (
    <div style={{ maxWidth: "720px" }}>

      <PauseToggle initialPaused={isPaused} />

      {/* Hero */}
      <section style={{ marginBottom: "4.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
          <p style={{ fontSize: "11px", fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--faint)" }}>
            {month}
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

      {/* Stats */}
      <section style={{ marginBottom: "4.5rem" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1px", background: "var(--border)", border: "1px solid var(--border)" }}>
          {[
            { label: "Posts Published", value: totalPosted },
            { label: "This Week",       value: thisWeek    },
            { label: "Episodes",        value: episodes    },
          ].map(s => (
            <div key={s.label} style={{ background: "var(--bg)", padding: "2rem 1.75rem" }}>
              <div style={{ fontSize: "2.75rem", fontWeight: 200, letterSpacing: "-0.04em", lineHeight: 1, color: "var(--text)", marginBottom: "0.6rem", fontVariantNumeric: "tabular-nums" }}>
                {s.value}
              </div>
              <div style={{ fontSize: "11px", fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)" }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Platform breakdown */}
      <section style={{ marginBottom: "4.5rem" }}>
        <p style={{ fontSize: "11px", fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--faint)", marginBottom: "1.75rem" }}>
          Reach by Platform
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {PLATFORMS.map(p => {
            const count = platformCounts[p]
            const pct = Math.round((count / maxCount) * 100)
            return (
              <div key={p} style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                <span style={{ width: "120px", fontSize: "12px", fontWeight: 500, color: "var(--text)", flexShrink: 0 }}>
                  {PLATFORM_LABEL[p]}
                </span>
                <div style={{ flex: 1, height: "2px", background: "var(--border)", borderRadius: "2px" }}>
                  <div style={{ height: "100%", width: `${pct}%`, minWidth: count > 0 ? "4px" : 0, background: PLATFORM_COLOR[p], borderRadius: "2px" }} />
                </div>
                <span style={{ width: "28px", textAlign: "right", fontSize: "12px", color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                  {count}
                </span>
              </div>
            )
          })}
        </div>
      </section>

      {/* Recent clips */}
      <section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
          <p style={{ fontSize: "11px", fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--faint)" }}>
            Recent Posts
          </p>
          <a href="/queue" style={{ fontSize: "12px", color: "var(--muted)" }}>
            View all →
          </a>
        </div>

        <div style={{ borderTop: "1px solid var(--border)" }}>
          {recentClips.length === 0 ? (
            <p style={{ padding: "3rem 0", color: "var(--faint)", fontSize: "13px", textAlign: "center" }}>
              No posts yet.
            </p>
          ) : recentClips.map(clip => (
            <div
              key={`${clip.video_id}-${clip.clip_index}`}
              style={{ padding: "1.125rem 0", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: "14px" }}
            >
              {/* Thumbnail */}
              <div style={{ flexShrink: 0, width: "38px", height: "68px", overflow: "hidden", background: "var(--surface)" }}>
                <img
                  src={`https://img.youtube.com/vi/${clip.video_id}/hqdefault.jpg`}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center", display: "block" }}
                />
              </div>

              {/* Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{
                  fontSize: "13px",
                  color: "var(--text)",
                  lineHeight: 1.55,
                  marginBottom: "8px",
                  overflow: "hidden",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical" as const,
                }}>
                  {clip.caption || <span style={{ color: "var(--faint)", fontStyle: "italic" }}>No caption</span>}
                </p>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ display: "flex", gap: "5px", alignItems: "center" }}>
                    {PLATFORMS.map(p => (
                      <span
                        key={p}
                        title={`${PLATFORM_LABEL[p]}: ${clip.platforms[p] ?? "not posted"}`}
                        style={{
                          display: "inline-block",
                          width: "6px",
                          height: "6px",
                          borderRadius: "50%",
                          background: clip.platforms[p] === "posted" ? PLATFORM_COLOR[p] : "var(--border)",
                        }}
                      />
                    ))}
                  </div>
                  <span style={{ fontSize: "11px", color: "var(--faint)" }}>
                    {timeAgo(clip.posted_at)}
                  </span>
                </div>
              </div>

              {/* Clip number */}
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
