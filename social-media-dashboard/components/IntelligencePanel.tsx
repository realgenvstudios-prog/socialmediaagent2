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
  if (h < 1)   return "just now"
  if (h < 24)  return `${h}h ago`
  if (d === 1) return "yesterday"
  return `${d}d ago`
}

function stripMd(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")   // **bold** → plain
    .replace(/\*([^*]+)\*/g, "$1")        // *italic* → plain
    .replace(/`([^`]+)`/g, "$1")          // `code` → plain
    .replace(/—/g, ",")              // em dash
    .replace(/\s*--\s*/g, ", ")           // double hyphen
    .replace(/\bClaude\b/gi, "the AI")
    .replace(/\bZernio\b/gi, "the platform")
    .replace(/,\s*-\s*$/, "")             // trailing ", -" artifact
    .replace(/[,\s]+$/, "")              // trailing commas / whitespace
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

type Block =
  | { kind: "header";    text: string }
  | { kind: "subheader"; text: string }
  | { kind: "body";      text: string }
  | { kind: "bullet";    text: string }

function parseBlocks(raw: string): Block[] {
  const blocks: Block[] = []

  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t) continue

    // Markdown section header: ## or # prefix
    if (/^#{1,3}\s+/.test(t)) {
      const text = stripMd(t.replace(/^#{1,3}\s+/, "").replace(/^\d+\.\s+/, ""))
      // Drop the meta title line like "KONNECTED MINDS PODCAST · CHANNEL INTELLIGENCE BRIEF"
      if (/intelligence brief/i.test(text) || /podcast/i.test(text)) continue
      if (text) blocks.push({ kind: "header", text: text.replace(/[:\s]+$/, "") })
      continue
    }

    // Numbered ALL-CAPS section header without ##: "1. HOOK PATTERNS"
    if (/^\d+\.\s+[A-Z][A-Z\s\-&:\/()]+$/.test(t)) {
      const text = stripMd(t.replace(/^\d+\.\s+/, "").replace(/[:\s]+$/, ""))
      if (text) blocks.push({ kind: "header", text })
      continue
    }

    // Pure ALL-CAPS line (no lowercase): "HOOK PATTERNS"
    if (/^[A-Z][A-Z\s\-&:\/()]{2,}$/.test(t) && t.length < 65) {
      blocks.push({ kind: "header", text: stripMd(t).replace(/[:\s]+$/, "") })
      continue
    }

    // Standalone bold line = sub-header: **Avoid:** or **High-performing hooks:**
    if (/^\*\*[^*]+\*\*[:\s]*$/.test(t)) {
      const text = stripMd(t).replace(/[:\s]+$/, "")
      if (text) blocks.push({ kind: "subheader", text })
      continue
    }

    // Bullet: · - • *
    if (/^[·\-•*]\s+/.test(t)) {
      const text = stripMd(t.replace(/^[·\-•*]\s+/, ""))
      if (text) blocks.push({ kind: "bullet", text })
      continue
    }

    // Numbered bullet: "1. Always..." (lowercase/mixed after number = not a header)
    if (/^\d+[.)]\s+[a-zA-Z]/.test(t)) {
      const text = stripMd(t.replace(/^\d+[.)]\s+/, ""))
      if (text) blocks.push({ kind: "bullet", text })
      continue
    }

    // Body — merge consecutive lines into one paragraph
    const text = stripMd(t)
    if (!text) continue
    const prev = blocks[blocks.length - 1]
    if (prev?.kind === "body") {
      prev.text += " " + text
    } else {
      blocks.push({ kind: "body", text })
    }
  }

  return blocks
}

export default function IntelligencePanel({ data }: { data: IntelligenceData | null }) {
  const [open, setOpen] = useState(false)

  if (!data || !data.summary) return null

  const blocks = parseBlocks(data.summary)

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
          marginBottom: open ? "1.75rem" : 0,
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

          {/* Stats row */}
          <div style={{ display: "flex", gap: "2.5rem", marginBottom: "2rem", paddingBottom: "2rem", borderBottom: "1px solid var(--border)" }}>
            <div>
              <p style={{ fontSize: "1.75rem", fontWeight: 200, letterSpacing: "-0.04em", color: "var(--text)", margin: 0, lineHeight: 1 }}>
                {data.clipsAnalysed}
              </p>
              <p style={{ fontSize: "11px", color: "var(--faint)", margin: "6px 0 0" }}>clips analysed</p>
            </div>
            <div>
              <p style={{ fontSize: "1.75rem", fontWeight: 200, letterSpacing: "-0.04em", color: "var(--text)", margin: 0, lineHeight: 1 }}>
                {fmt(data.totalViews)}
              </p>
              <p style={{ fontSize: "11px", color: "var(--faint)", margin: "6px 0 0" }}>views tracked</p>
            </div>
          </div>

          {/* Best hook */}
          {data.bestHook && data.bestViews > 0 && (
            <div style={{ marginBottom: "2rem", paddingBottom: "2rem", borderBottom: "1px solid var(--border)" }}>
              <p style={{ fontSize: "11px", color: "var(--faint)", marginBottom: "8px", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                Best hook so far · {fmt(data.bestViews)} views
              </p>
              <p style={{ fontSize: "13px", color: "var(--muted)", fontStyle: "italic", lineHeight: 1.65, margin: 0 }}>
                "{stripMd(data.bestHook)}"
              </p>
            </div>
          )}

          {/* Parsed brief */}
          <div>
            {blocks.map((block, i) => {
              if (block.kind === "header") {
                return (
                  <p key={i} style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "var(--text)",
                    margin: i === 0 ? "0 0 0.75rem" : "2rem 0 0.75rem",
                  }}>
                    {block.text}
                  </p>
                )
              }

              if (block.kind === "subheader") {
                return (
                  <p key={i} style={{
                    fontSize: "11px",
                    fontWeight: 500,
                    color: "var(--muted)",
                    margin: "1.25rem 0 0.5rem",
                    letterSpacing: "0.02em",
                  }}>
                    {block.text}
                  </p>
                )
              }

              if (block.kind === "bullet") {
                return (
                  <div key={i} style={{ display: "flex", gap: "0.75rem", marginBottom: "0.5rem", alignItems: "flex-start" }}>
                    <span style={{ color: "var(--faint)", fontSize: "12px", lineHeight: "1.75", flexShrink: 0 }}>·</span>
                    <p style={{ fontSize: "13px", color: "var(--muted)", lineHeight: 1.75, margin: 0 }}>
                      {block.text}
                    </p>
                  </div>
                )
              }

              return (
                <p key={i} style={{ fontSize: "13px", color: "var(--muted)", lineHeight: 1.75, margin: "0 0 0.5rem" }}>
                  {block.text}
                </p>
              )
            })}
          </div>

          <p style={{ fontSize: "11px", color: "var(--faint)", margin: "2rem 0 0" }}>
            Refreshes daily from real analytics data.
          </p>
        </div>
      )}
    </section>
  )
}
