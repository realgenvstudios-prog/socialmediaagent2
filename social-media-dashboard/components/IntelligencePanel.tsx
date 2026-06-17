"use client"
import { useState } from "react"

type IntelligenceData = {
  summary: string
  updatedAt: string
  clipsAnalysed: number
  totalViews: number
  bestHook: string
  bestViews: number
}

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)    return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function timeAgo(dateStr: string) {
  if (!dateStr) return ""
  const diff = Date.now() - new Date(dateStr).getTime()
  const h = Math.floor(diff / 3_600_000)
  const d = Math.floor(diff / 86_400_000)
  if (h < 1)  return "just now"
  if (h < 24) return `${h}h ago`
  if (d === 1) return "yesterday"
  return `${d}d ago`
}

export default function IntelligencePanel({ data }: { data: IntelligenceData | null }) {
  const [open, setOpen] = useState(false)

  if (!data || !data.summary) return null

  return (
    <section style={{ marginBottom: "4rem" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: 0,
          background: "none",
          border: "none",
          cursor: "pointer",
          marginBottom: open ? "1.5rem" : 0,
        }}
      >
        <p style={{ fontSize: "11px", fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--faint)", margin: 0 }}>
          What the AI has learned
        </p>
        <span style={{ fontSize: "11px", color: "var(--faint)", flexShrink: 0, marginLeft: "1rem" }}>
          {open ? "hide" : "show"} · {data.clipsAnalysed} clips · {timeAgo(data.updatedAt)}
        </span>
      </button>

      {open && (
        <div style={{ animation: "fadeUp 0.35s ease both" }}>
          {/* Key stats */}
          <div style={{
            display: "flex",
            gap: "2.5rem",
            marginBottom: "1.75rem",
            paddingBottom: "1.75rem",
            borderBottom: "1px solid var(--border)",
          }}>
            <div>
              <p style={{ fontSize: "1.75rem", fontWeight: 200, letterSpacing: "-0.04em", color: "var(--text)", margin: 0, lineHeight: 1 }}>
                {data.clipsAnalysed}
              </p>
              <p style={{ fontSize: "11px", color: "var(--faint)", marginTop: "6px", margin: "6px 0 0" }}>clips analysed</p>
            </div>
            <div>
              <p style={{ fontSize: "1.75rem", fontWeight: 200, letterSpacing: "-0.04em", color: "var(--text)", margin: 0, lineHeight: 1 }}>
                {fmt(data.totalViews)}
              </p>
              <p style={{ fontSize: "11px", color: "var(--faint)", marginTop: "6px", margin: "6px 0 0" }}>total views tracked</p>
            </div>
          </div>

          {/* Best hook */}
          {data.bestHook && data.bestViews > 0 && (
            <div style={{ marginBottom: "1.75rem" }}>
              <p style={{ fontSize: "11px", color: "var(--faint)", marginBottom: "8px", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                best hook so far — {fmt(data.bestViews)} views
              </p>
              <p style={{ fontSize: "13px", color: "var(--muted)", fontStyle: "italic", lineHeight: 1.6, margin: 0 }}>
                "{data.bestHook}"
              </p>
            </div>
          )}

          {/* Full brief */}
          <div style={{ borderLeft: "2px solid var(--border)", paddingLeft: "1.25rem" }}>
            <p style={{ fontSize: "11px", color: "var(--faint)", marginBottom: "0.875rem", letterSpacing: "0.1em", textTransform: "uppercase" }}>
              Current rules the AI is following
            </p>
            <pre style={{
              fontSize: "12.5px",
              color: "var(--muted)",
              lineHeight: 1.85,
              whiteSpace: "pre-wrap",
              fontFamily: "inherit",
              margin: 0,
            }}>
              {data.summary}
            </pre>
          </div>

          <p style={{ fontSize: "11px", color: "var(--faint)", marginTop: "1.25rem", margin: "1.25rem 0 0" }}>
            Updated daily at 6am UTC from real analytics. Resets when 10+ new clips have data.
          </p>
        </div>
      )}
    </section>
  )
}
