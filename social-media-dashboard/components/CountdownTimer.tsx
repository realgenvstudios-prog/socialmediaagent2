"use client"
import { useState, useEffect } from "react"

const POST_HOURS_UTC = [9, 13, 18]

function getNextPostMs(): number {
  const now = new Date()
  const todayBase = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  for (const h of POST_HOURS_UTC) {
    const t = todayBase + h * 3_600_000
    if (t > now.getTime()) return t
  }
  return todayBase + 24 * 3_600_000 + 9 * 3_600_000 // 9am tomorrow
}

function fmt(ms: number) {
  if (ms <= 0) return "now"
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export default function CountdownTimer() {
  const [ms, setMs] = useState<number | null>(null)

  useEffect(() => {
    const tick = () => setMs(getNextPostMs() - Date.now())
    tick()
    const id = setInterval(tick, 30_000)
    return () => clearInterval(id)
  }, [])

  if (ms === null) return null

  return (
    <span style={{ fontSize: "12px", color: "var(--faint)" }}>
      Next post in{" "}
      <span style={{ color: "var(--muted)", fontWeight: 500 }}>{fmt(ms)}</span>
    </span>
  )
}
