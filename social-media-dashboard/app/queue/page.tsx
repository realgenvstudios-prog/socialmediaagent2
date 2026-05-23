import { supabase } from "@/lib/supabase"

export const revalidate = 30

const PLATFORMS = ["instagram", "tiktok", "youtube", "facebook"] as const
type Platform = (typeof PLATFORMS)[number]

const PLATFORM_COLOR: Record<Platform, string> = {
  instagram: "#e1306c",
  tiktok:    "#111111",
  youtube:   "#ff0000",
  facebook:  "#1877f2",
}

const PLATFORM_LABEL: Record<Platform, string> = {
  instagram: "IG",
  tiktok:    "TT",
  youtube:   "YT",
  facebook:  "FB",
}

type ClipEntry = {
  video_id: string
  clip_index: number
  caption: string
  created_at: string
  posted_at: string
  platforms: Record<string, string>
}

type Episode = {
  video_id: string
  title: string
  clips: ClipEntry[]
}

async function getEpisodes(): Promise<Episode[]> {
  const [{ data: queueData }, { data: videoData }] = await Promise.all([
    supabase
      .from("clip_queue")
      .select("video_id, clip_index, platform, status, caption, posted_at, created_at")
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("processed_videos")
      .select("video_id, video_title")
      .order("processed_at", { ascending: false }),
  ])

  const titles = Object.fromEntries((videoData ?? []).map(v => [v.video_id, v.video_title as string]))

  const clipMap = new Map<string, ClipEntry>()
  for (const row of (queueData ?? [])) {
    if (row.clip_index > 50) continue
    const key = `${row.video_id}-${row.clip_index}`
    if (!clipMap.has(key)) {
      clipMap.set(key, {
        video_id: row.video_id,
        clip_index: row.clip_index,
        caption: row.caption ?? "",
        created_at: row.created_at,
        posted_at: row.posted_at ?? "",
        platforms: {},
      })
    }
    const entry = clipMap.get(key)!
    const existing = entry.platforms[row.platform]
    if (!existing || (row.status === "posted" && existing !== "posted")) {
      entry.platforms[row.platform] = row.status
    }
  }

  // Group clips by video_id preserving order (most recent episode first)
  const episodeMap = new Map<string, Episode>()
  for (const clip of clipMap.values()) {
    if (!episodeMap.has(clip.video_id)) {
      episodeMap.set(clip.video_id, {
        video_id: clip.video_id,
        title: titles[clip.video_id] ?? clip.video_id,
        clips: [],
      })
    }
    episodeMap.get(clip.video_id)!.clips.push(clip)
  }

  return Array.from(episodeMap.values())
}

function getClipStatus(platforms: Record<string, string>): "live" | "partial" | "pending" | "failed" {
  const statuses = Object.values(platforms)
  if (statuses.every(s => s === "posted")) return "live"
  if (statuses.some(s => s === "posted")) return "partial"
  if (statuses.some(s => s === "failed")) return "failed"
  return "pending"
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

const STATUS_LABEL: Record<string, { label: string; color: string; bg: string }> = {
  live:    { label: "Live",    color: "#16a34a", bg: "rgba(22,163,74,0.08)"  },
  partial: { label: "Partial", color: "#d97706", bg: "rgba(217,119,6,0.08)"  },
  pending: { label: "Pending", color: "#999999", bg: "rgba(0,0,0,0.04)"      },
  failed:  { label: "Failed",  color: "#dc2626", bg: "rgba(220,38,38,0.08)"  },
}

const STATUS_FILTERS = ["all", "pending", "partial", "live", "failed"] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

const FILTER_COLOR: Record<StatusFilter, string> = {
  all:     "var(--text)",
  live:    "#16a34a",
  partial: "#d97706",
  pending: "#999999",
  failed:  "#dc2626",
}

export default async function ClipsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const { status = "all" } = await searchParams
  const activeFilter: StatusFilter = STATUS_FILTERS.includes(status as StatusFilter)
    ? (status as StatusFilter)
    : "all"

  const episodes = await getEpisodes()

  const allClips     = episodes.flatMap(e => e.clips)
  const liveCount    = allClips.filter(c => getClipStatus(c.platforms) === "live").length
  const pendingCount = allClips.filter(c => getClipStatus(c.platforms) === "pending").length

  // Apply filter — hide clips that don't match, hide episodes with no remaining clips
  const filteredEpisodes = episodes
    .map(ep => ({
      ...ep,
      clips: activeFilter === "all"
        ? ep.clips
        : ep.clips.filter(c => getClipStatus(c.platforms) === activeFilter),
    }))
    .filter(ep => ep.clips.length > 0)

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: "2.5rem" }}>
        <h1 style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)", fontWeight: 300, letterSpacing: "-0.03em", color: "var(--text)", marginBottom: "0.5rem" }}>
          Clips
        </h1>
        <p style={{ fontSize: "13px", color: "var(--muted)" }}>
          {allClips.length} clips across {episodes.length} episode{episodes.length !== 1 ? "s" : ""} · {liveCount} live
          {pendingCount > 0 && ` · ${pendingCount} pending`}
        </p>
      </div>

      {/* Status filter tabs */}
      <div style={{ display: "flex", gap: "6px", marginBottom: "2.5rem", flexWrap: "wrap" }}>
        {STATUS_FILTERS.map(f => {
          const isActive = activeFilter === f
          const color = FILTER_COLOR[f]
          return (
            <a
              key={f}
              href={f === "all" ? "/queue" : `/queue?status=${f}`}
              style={{
                fontSize: "12px",
                fontWeight: 500,
                padding: "6px 14px",
                borderRadius: "100px",
                border: "1px solid",
                borderColor: isActive ? (f === "all" ? "var(--text)" : color) : "var(--border)",
                color: isActive ? (f === "all" ? "var(--text)" : color) : "var(--muted)",
                background: isActive ? (f === "all" ? "var(--surface)" : `${color}12`) : "transparent",
                textDecoration: "none",
                textTransform: "capitalize",
                transition: "all 0.15s",
              }}
            >
              {f === "all" ? "All" : STATUS_LABEL[f].label}
            </a>
          )
        })}
      </div>

      {filteredEpisodes.length === 0 ? (
        <div style={{ padding: "5rem 0", textAlign: "center" }}>
          <p style={{ fontSize: "13px", color: "var(--faint)" }}>
            {activeFilter === "all" ? "No clips yet." : `No ${STATUS_LABEL[activeFilter].label.toLowerCase()} clips.`}
          </p>
        </div>
      ) : filteredEpisodes.map(episode => (
        <div key={episode.video_id} style={{ marginBottom: "3rem" }}>

          {/* Episode header */}
          <div style={{ display: "flex", alignItems: "center", gap: "14px", paddingBottom: "1rem", borderBottom: "1px solid var(--border)", marginBottom: "0" }}>
            <div style={{ width: "80px", height: "45px", overflow: "hidden", background: "var(--surface)", flexShrink: 0 }}>
              <img
                src={`https://img.youtube.com/vi/${episode.video_id}/hqdefault.jpg`}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center", display: "block" }}
              />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: "13px", fontWeight: 500, color: "var(--text)", marginBottom: "3px",
                overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical" as const }}>
                {episode.title}
              </p>
              <p style={{ fontSize: "11px", color: "var(--faint)" }}>
                {episode.clips.length} clip{episode.clips.length !== 1 ? "s" : ""}
              </p>
            </div>
          </div>

          {/* Clips under this episode */}
          {episode.clips.map((clip: ClipEntry) => {
            const overallStatus = getClipStatus(clip.platforms)
            const s = STATUS_LABEL[overallStatus]
            return (
              <div
                key={`${clip.video_id}-${clip.clip_index}`}
                style={{
                  borderBottom: "1px solid var(--border)",
                  padding: "1.25rem 0",
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto",
                  gap: "14px",
                  alignItems: "start",
                }}
              >
                {/* Clip thumbnail (portrait crop) */}
                <div style={{ width: "32px", height: "57px", overflow: "hidden", background: "var(--surface)", flexShrink: 0, marginTop: "2px" }}>
                  <img
                    src={`https://img.youtube.com/vi/${clip.video_id}/hqdefault.jpg`}
                    alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center", display: "block" }}
                  />
                </div>

                {/* Caption + platform badges */}
                <div style={{ minWidth: 0 }}>
                  <p style={{
                    fontSize: "13px", color: "var(--text)", lineHeight: 1.55, marginBottom: "10px",
                    overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const,
                  }}>
                    {clip.caption || <span style={{ color: "var(--faint)", fontStyle: "italic" }}>No caption</span>}
                  </p>
                  <div style={{ display: "flex", gap: "6px" }}>
                    {PLATFORMS.map(p => {
                      const pStatus = clip.platforms[p]
                      const posted = pStatus === "posted"
                      const failed = pStatus === "failed"
                      return (
                        <span key={p} title={`${PLATFORM_LABEL[p]}: ${pStatus ?? "not queued"}`} style={{
                          fontSize: "10px", fontWeight: 600, padding: "2px 7px", borderRadius: "4px", letterSpacing: "0.04em",
                          color: posted ? PLATFORM_COLOR[p] : failed ? "var(--red)" : "var(--faint)",
                          background: posted ? `${PLATFORM_COLOR[p]}12` : failed ? "rgba(220,38,38,0.07)" : "var(--surface)",
                          border: "1px solid", borderColor: posted ? `${PLATFORM_COLOR[p]}30` : "var(--border)",
                        }}>
                          {PLATFORM_LABEL[p]}
                        </span>
                      )
                    })}
                  </div>
                </div>

                {/* Status + time */}
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <span style={{
                    display: "inline-block", fontSize: "10px", fontWeight: 600, letterSpacing: "0.06em",
                    textTransform: "uppercase", color: s.color, background: s.bg,
                    padding: "3px 9px", borderRadius: "100px", marginBottom: "6px",
                  }}>
                    {s.label}
                  </span>
                  <p style={{ fontSize: "11px", color: "var(--faint)", fontVariantNumeric: "tabular-nums" }}>
                    {timeAgo(clip.posted_at || clip.created_at)}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
