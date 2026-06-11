"use client"

import { useEffect, useRef, useState } from "react"

export default function AnimatedStat({ value, label }: { value: number; label: string }) {
  const [display, setDisplay] = useState(0)
  const [pulsing, setPulsing] = useState(false)
  const raf = useRef<number | null>(null)

  useEffect(() => {
    const start = performance.now()
    const duration = 3500

    function easeOut(t: number) {
      return 1 - Math.pow(1 - t, 3)
    }

    function tick(now: number) {
      const t = Math.min((now - start) / duration, 1)
      setDisplay(Math.round(easeOut(t) * value))
      if (t < 1) {
        raf.current = requestAnimationFrame(tick)
      } else {
        setDisplay(value)
        setPulsing(true)
        setTimeout(() => setPulsing(false), 500)
      }
    }

    raf.current = requestAnimationFrame(tick)
    return () => { if (raf.current) cancelAnimationFrame(raf.current) }
  }, [value])

  return (
    <div style={{ background: "var(--bg)", padding: "2rem 1.75rem" }}>
      <div style={{
        fontSize: "2.75rem",
        fontWeight: 200,
        letterSpacing: "-0.04em",
        lineHeight: 1,
        color: "var(--text)",
        marginBottom: "0.6rem",
        fontVariantNumeric: "tabular-nums",
        animation: pulsing ? "statPulse 0.5s ease" : undefined,
      }}>
        {display}
      </div>
      <div style={{
        fontSize: "11px",
        fontWeight: 500,
        letterSpacing: "0.1em",
        textTransform: "uppercase" as const,
        color: "var(--faint)",
      }}>
        {label}
      </div>
    </div>
  )
}
