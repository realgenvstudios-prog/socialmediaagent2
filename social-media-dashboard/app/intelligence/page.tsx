import { supabase } from "@/lib/supabase"

export const revalidate = 0

interface SelectionRow {
  hook_type:        string | null
  topic_category:   string | null
  performance_tier: string | null
  views:            number | null
  engagement_rate:  number | null
}

interface RankItem {
  label:   string
  avg:     number
  top:     number
  mid:     number
  low:     number
  total:   number
}

function buildRankings(rows: SelectionRow[], key: "hook_type" | "topic_category"): RankItem[] {
  const map: Record<string, { views: number[]; top: number; mid: number; low: number }> = {}
  for (const r of rows) {
    const k = r[key] || "unknown"
    if (!map[k]) map[k] = { views: [], top: 0, mid: 0, low: 0 }
    if (r.performance_tier === "top") map[k].top++
    else if (r.performance_tier === "mid") map[k].mid++
    else if (r.performance_tier === "low") map[k].low++
    if (r.views) map[k].views.push(r.views)
  }
  return Object.entries(map)
    .map(([label, s]) => ({
      label,
      avg:   s.views.length ? Math.round(s.views.reduce((a, b) => a + b, 0) / s.views.length) : 0,
      top:   s.top,
      mid:   s.mid,
      low:   s.low,
      total: s.top + s.mid + s.low,
    }))
    .sort((a, b) => b.avg - a.avg)
}

function fmt(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

const TIER_COLOR = { top: "#16a34a", mid: "#d97706", low: "#dc2626" }
const TIER_BG    = { top: "rgba(22,163,74,0.08)", mid: "rgba(217,119,6,0.08)", low: "rgba(220,38,38,0.08)" }

export default async function IntelligencePage() {
  const [intelligenceRes, logRes] = await Promise.all([
    supabase.from("channel_intelligence").select("summary, stats, updated_at").eq("id", "singleton").single(),
    supabase.from("clip_selection_log").select("hook_type, topic_category, performance_tier, views, engagement_rate").not("performance_tier", "is", null),
  ])

  const intel   = intelligenceRes.data
  const stats   = (intel?.stats ?? {}) as Record<string, number | string>
  const rows    = (logRes.data ?? []) as SelectionRow[]

  const hookRankings  = buildRankings(rows, "hook_type")
  const topicRankings = buildRankings(rows, "topic_category")

  const maxHookAvg  = Math.max(...hookRankings.map(r => r.avg), 1)
  const maxTopicAvg = Math.max(...topicRankings.map(r => r.avg), 1)

  const tierCounts = rows.reduce((acc, r) => {
    if (r.performance_tier) acc[r.performance_tier] = (acc[r.performance_tier] || 0) + 1
    return acc
  }, {} as Record<string, number>)
  const totalTiered = rows.length

  const MEDAL = ["🥇", "🥈", "🥉"]

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: "2.5rem" }}>
        <h1 style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)", fontWeight: 300, letterSpacing: "-0.03em", color: "var(--text)", marginBottom: "0.5rem" }}>
          Agent Intelligence
        </h1>
        <p style={{ fontSize: "13px", color: "var(--muted)" }}>
          What the agent has learned from {rows.length} clips with performance data
          {intel?.updated_at && ` · Updated ${timeAgo(intel.updated_at)}`}
        </p>
      </div>

      {/* Top stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "1px", background: "var(--border)", borderRadius: "12px", overflow: "hidden", marginBottom: "2rem" }}>
        {[
          { label: "Total Views",      value: fmt(Number(stats.total_views  || 0)) },
          { label: "Avg Engagement",   value: `${Number(stats.avg_engagement || 0).toFixed(2)}%` },
          { label: "Best Clip",        value: `${fmt(Number(stats.best_views || 0))} views` },
          { label: "Clips Analysed",   value: String(stats.clips_analysed  || 0) },
        ].map(({ label, value }) => (
          <div key={label} style={{ background: "var(--bg)", padding: "1.25rem 1.5rem" }}>
            <div style={{ fontSize: "11px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.4rem" }}>{label}</div>
            <div style={{ fontSize: "1.6rem", fontWeight: 300, letterSpacing: "-0.03em", color: "var(--text)" }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Tier breakdown */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "12px", padding: "1.25rem 1.5rem", marginBottom: "2rem" }}>
        <div style={{ fontSize: "11px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "1rem" }}>Overall Performance Split</div>
        <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
          {(["top", "mid", "low"] as const).map(tier => {
            const count = tierCounts[tier] || 0
            const pct   = totalTiered ? Math.round((count / totalTiered) * 100) : 0
            return (
              <div key={tier} style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: TIER_COLOR[tier], flexShrink: 0 }} />
                <span style={{ fontSize: "13px", color: "var(--text)", fontWeight: 500, textTransform: "capitalize" }}>{tier}</span>
                <span style={{ fontSize: "13px", color: "var(--muted)" }}>{count} clips · {pct}%</span>
              </div>
            )
          })}
        </div>
        {/* Stacked bar */}
        <div style={{ display: "flex", height: "6px", borderRadius: "3px", overflow: "hidden", marginTop: "1rem", background: "var(--border)" }}>
          {(["top", "mid", "low"] as const).map(tier => {
            const pct = totalTiered ? (tierCounts[tier] || 0) / totalTiered * 100 : 0
            return <div key={tier} style={{ width: `${pct}%`, background: TIER_COLOR[tier], transition: "width 0.3s" }} />
          })}
        </div>
      </div>

      {/* Rankings grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", marginBottom: "2rem" }}>

        {/* Hook Type Rankings */}
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "12px", padding: "1.25rem 1.5rem" }}>
          <div style={{ fontSize: "11px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "1.25rem" }}>Hook Type Rankings</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {hookRankings.map((item, i) => (
              <div key={item.label}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.35rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    {i < 3 && <span style={{ fontSize: "12px" }}>{MEDAL[i]}</span>}
                    <span style={{ fontSize: "13px", color: "var(--text)", fontWeight: i < 3 ? 500 : 400, textTransform: "capitalize" }}>
                      {item.label}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                    <div style={{ display: "flex", gap: "4px" }}>
                      {(["top", "mid", "low"] as const).map(tier => item[tier] > 0 && (
                        <span key={tier} style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "4px", background: TIER_BG[tier], color: TIER_COLOR[tier], fontWeight: 500 }}>
                          {item[tier]}{tier[0].toUpperCase()}
                        </span>
                      ))}
                    </div>
                    <span style={{ fontSize: "12px", color: "var(--muted)", minWidth: "50px", textAlign: "right" }}>
                      {fmt(item.avg)} avg
                    </span>
                  </div>
                </div>
                <div style={{ height: "4px", borderRadius: "2px", background: "var(--border)", overflow: "hidden" }}>
                  <div style={{
                    height: "100%",
                    width: `${(item.avg / maxHookAvg) * 100}%`,
                    background: i === 0 ? "#16a34a" : i === 1 ? "#2563eb" : i === 2 ? "#7c3aed" : "var(--faint)",
                    borderRadius: "2px",
                    transition: "width 0.4s",
                  }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Topic Rankings */}
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "12px", padding: "1.25rem 1.5rem" }}>
          <div style={{ fontSize: "11px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "1.25rem" }}>Topic Rankings</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {topicRankings.map((item, i) => (
              <div key={item.label}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.35rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    {i < 3 && <span style={{ fontSize: "12px" }}>{MEDAL[i]}</span>}
                    <span style={{ fontSize: "13px", color: "var(--text)", fontWeight: i < 3 ? 500 : 400, textTransform: "capitalize" }}>
                      {item.label}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                    <div style={{ display: "flex", gap: "4px" }}>
                      {(["top", "mid", "low"] as const).map(tier => item[tier] > 0 && (
                        <span key={tier} style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "4px", background: TIER_BG[tier], color: TIER_COLOR[tier], fontWeight: 500 }}>
                          {item[tier]}{tier[0].toUpperCase()}
                        </span>
                      ))}
                    </div>
                    <span style={{ fontSize: "12px", color: "var(--muted)", minWidth: "50px", textAlign: "right" }}>
                      {fmt(item.avg)} avg
                    </span>
                  </div>
                </div>
                <div style={{ height: "4px", borderRadius: "2px", background: "var(--border)", overflow: "hidden" }}>
                  <div style={{
                    height: "100%",
                    width: `${(item.avg / maxTopicAvg) * 100}%`,
                    background: i === 0 ? "#16a34a" : i === 1 ? "#2563eb" : i === 2 ? "#7c3aed" : "var(--faint)",
                    borderRadius: "2px",
                    transition: "width 0.4s",
                  }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Best hook */}
      {stats.best_hook && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "12px", padding: "1.25rem 1.5rem", marginBottom: "2rem" }}>
          <div style={{ fontSize: "11px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.6rem" }}>
            Best Performing Hook · {fmt(Number(stats.best_views))} views
          </div>
          <p style={{ fontSize: "15px", color: "var(--text)", fontStyle: "italic", margin: 0, lineHeight: 1.6 }}>
            &ldquo;{String(stats.best_hook)}&rdquo;
          </p>
        </div>
      )}

      {/* Claude summary */}
      {intel?.summary && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "12px", padding: "1.25rem 1.5rem" }}>
          <div style={{ fontSize: "11px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.75rem" }}>Agent Analysis</div>
          <p style={{ fontSize: "14px", color: "var(--text)", lineHeight: 1.7, margin: 0, whiteSpace: "pre-wrap" }}>
            {intel.summary}
          </p>
        </div>
      )}
    </div>
  )
}
