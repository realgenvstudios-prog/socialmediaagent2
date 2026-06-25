"use client"
import { useState, useEffect } from "react"

type VideoItem = {
  videoId: string
  title: string
  thumbnail: string
  publishedAt: string
  duration: string
  processed: { clip_count: number; processed_at: string } | null
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const d = Math.floor(diff / 86400000)
  if (d === 0) return "today"
  if (d === 1) return "yesterday"
  if (d < 7)  return `${d}d ago`
  if (d < 30) return `${Math.floor(d / 7)}w ago`
  return `${Math.floor(d / 30)}mo ago`
}

function SkeletonCard() {
  return (
    <div style={{ border: "1px solid var(--border)" }}>
      <div style={{ paddingTop: "56.25%", background: "var(--surface)", position: "relative" }} />
      <div style={{ padding: "14px 16px 16px" }}>
        <div style={{ height: "12px", background: "var(--surface)", marginBottom: "8px", width: "90%" }} />
        <div style={{ height: "12px", background: "var(--surface)", width: "60%" }} />
      </div>
    </div>
  )
}

export default function ProcessPage() {
  const [videos, setVideos]       = useState<VideoItem[]>([])
  const [loading, setLoading]     = useState(true)
  const [selected, setSelected]   = useState<VideoItem | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState<Set<string>>(new Set())
  const [error, setError]         = useState("")

  useEffect(() => {
    fetch("/api/channel-videos")
      .then(r => r.json())
      .then(d => { setVideos(d.videos ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  async function handleProcess() {
    if (!selected || submitting) return
    setSubmitting(true)
    setError("")

    const res = await fetch("/api/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: selected.videoId, title: selected.title }),
    })

    if (res.ok) {
      setSubmitted(prev => new Set(prev).add(selected.videoId))
      setSelected(null)
    } else {
      const d = await res.json()
      setError(d.error ?? "Something went wrong")
    }
    setSubmitting(false)
  }

  const isSubmitted  = (id: string) => submitted.has(id)
  const isProcessed  = (v: VideoItem) => !!v.processed
  const isSelected   = (v: VideoItem) => selected?.videoId === v.videoId

  function selectCard(v: VideoItem) {
    setError("")
    setSelected(prev => prev?.videoId === v.videoId ? null : v)
  }

  return (
    <div style={{ maxWidth: "960px" }}>

      {/* Header */}
      <div style={{ marginBottom: "3rem" }}>
        <h1 style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)", fontWeight: 300, letterSpacing: "-0.03em", color: "var(--text)", marginBottom: "0.5rem" }}>
          Process
        </h1>
        <p style={{ fontSize: "13px", color: "var(--muted)" }}>
          Pick a video from the channel. The agent picks the clips, burns subtitles, and queues everything automatically.
        </p>
      </div>

      {/* Section label */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.25rem" }}>
        <span style={{ fontSize: "11px", fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)" }}>
          Channel Videos {!loading && videos.length > 0 && `· ${videos.length} videos`}
        </span>
        {!loading && (
          <button
            onClick={() => { setLoading(true); fetch("/api/channel-videos").then(r => r.json()).then(d => { setVideos(d.videos ?? []); setLoading(false) }) }}
            style={{ fontSize: "11px", color: "var(--muted)", background: "none", border: "none", padding: 0, cursor: "pointer", letterSpacing: "0.05em" }}
          >
            Refresh
          </button>
        )}
      </div>

      {/* Video grid */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: "1px",
        background: "var(--border)",
        border: "1px solid var(--border)",
        marginBottom: selected ? "0" : "4rem",
      }}>
        {loading
          ? Array.from({ length: 9 }).map((_, i) => (
              <div key={i} style={{ background: "var(--bg)" }}>
                <SkeletonCard />
              </div>
            ))
          : videos.map(v => {
              const done      = isProcessed(v)
              const queued    = isSubmitted(v.videoId)
              const sel       = isSelected(v)

              return (
                <div
                  key={v.videoId}
                  onClick={() => !queued && selectCard(v)}
                  style={{
                    background:  "var(--bg)",
                    cursor:      queued ? "default" : "pointer",
                    outline:     sel ? "2px solid var(--text)" : "none",
                    outlineOffset: "-1px",
                    position:    "relative",
                    transition:  "opacity 0.15s",
                    opacity:     queued ? 0.5 : 1,
                  }}
                >
                  {/* Thumbnail */}
                  <div style={{ position: "relative", paddingTop: "56.25%", background: "var(--surface)", overflow: "hidden" }}>
                    {v.thumbnail && (
                      <img
                        src={v.thumbnail}
                        alt=""
                        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    )}

                    {/* Duration — bottom right */}
                    {v.duration && (
                      <span style={{
                        position: "absolute", bottom: "7px", right: "7px",
                        fontSize: "11px", fontWeight: 600,
                        padding: "2px 6px", background: "rgba(0,0,0,0.75)",
                        color: "#fff", letterSpacing: "0.02em",
                      }}>
                        {v.duration}
                      </span>
                    )}

                    {/* Status badge — top left */}
                    {done && !queued && (
                      <span style={{
                        position: "absolute", top: "8px", left: "8px",
                        fontSize: "10px", fontWeight: 600, letterSpacing: "0.06em",
                        padding: "3px 8px", background: "rgba(0,0,0,0.72)",
                        color: "#4ade80", textTransform: "uppercase",
                      }}>
                        ● {v.processed!.clip_count} clips
                      </span>
                    )}
                    {queued && (
                      <span style={{
                        position: "absolute", top: "8px", left: "8px",
                        fontSize: "10px", fontWeight: 600, letterSpacing: "0.06em",
                        padding: "3px 8px", background: "rgba(0,0,0,0.72)",
                        color: "#a3a3a3", textTransform: "uppercase",
                      }}>
                        Queued
                      </span>
                    )}
                  </div>

                  {/* Info */}
                  <div style={{ padding: "12px 14px 14px" }}>
                    <p style={{
                      fontSize: "12px", fontWeight: 500, color: "var(--text)",
                      lineHeight: 1.45, marginBottom: "5px",
                      display: "-webkit-box", WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical", overflow: "hidden",
                    }}>
                      {v.title}
                    </p>
                    <p style={{ fontSize: "11px", color: "var(--faint)" }}>
                      {timeAgo(v.publishedAt)}
                      {done && !queued && (
                        <span style={{ color: "var(--faint)", marginLeft: "6px" }}>
                          · processed {timeAgo(v.processed!.processed_at)}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              )
            })
        }
      </div>

      {/* Confirmation bar — sticky bottom panel when a card is selected */}
      {selected && (
        <div style={{
          position: "sticky",
          bottom: 0,
          background: "rgba(255,255,255,0.96)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          borderTop: "1px solid var(--border)",
          padding: "1rem 1.5rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          marginBottom: "4rem",
          zIndex: 40,
        }}>
          <div style={{ minWidth: 0 }}>
            {selected.processed && (
              <p style={{ fontSize: "11px", color: "var(--amber)", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: "2px" }}>
                Already processed · {selected.processed.clip_count} clips generated
              </p>
            )}
            <p style={{ fontSize: "13px", color: "var(--text)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {selected.title}
            </p>
            {error && (
              <p style={{ fontSize: "11px", color: "var(--red)", marginTop: "4px" }}>{error}</p>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
            <button
              onClick={() => { setSelected(null); setError("") }}
              style={{ fontSize: "12px", color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              Cancel
            </button>
            <button
              onClick={handleProcess}
              disabled={submitting}
              style={{
                fontSize: "12px", fontWeight: 600, letterSpacing: "0.03em",
                padding: "9px 20px",
                background: submitting ? "var(--faint)" : "var(--text)",
                color: "#fff", border: "none",
                cursor: submitting ? "not-allowed" : "pointer",
                transition: "background 0.15s",
                whiteSpace: "nowrap",
              }}
            >
              {submitting ? "Starting…" : selected.processed ? "Process again →" : "Process video →"}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
