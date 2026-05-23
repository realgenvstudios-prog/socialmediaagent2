"use client"

import { useState, useTransition } from "react"

export default function PauseToggle({ initialPaused }: { initialPaused: boolean }) {
  const [paused, setPaused] = useState(initialPaused)
  const [pending, startTransition] = useTransition()

  function toggle() {
    startTransition(async () => {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !paused }),
      })
      if (res.ok) setPaused(p => !p)
    })
  }

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "1rem 1.25rem",
      border: "1px solid",
      borderColor: paused ? "rgba(220,38,38,0.25)" : "var(--border)",
      background: paused ? "rgba(220,38,38,0.04)" : "var(--bg)",
      marginBottom: "3rem",
      transition: "all 0.2s",
    }}>
      <div>
        <p style={{ fontSize: "13px", fontWeight: 500, color: paused ? "var(--red)" : "var(--text)", marginBottom: "2px" }}>
          {paused ? "Posting paused" : "Posting active"}
        </p>
        <p style={{ fontSize: "11px", color: "var(--faint)" }}>
          {paused
            ? "No clips will be posted until you resume."
            : "Clips are posting at 9am, 1pm and 6pm UTC."}
        </p>
      </div>

      <button
        onClick={toggle}
        disabled={pending}
        style={{
          fontSize: "12px",
          fontWeight: 600,
          padding: "7px 16px",
          border: "1px solid",
          borderColor: paused ? "var(--red)" : "var(--border)",
          color: paused ? "var(--red)" : "var(--muted)",
          background: "var(--bg)",
          cursor: pending ? "not-allowed" : "pointer",
          opacity: pending ? 0.5 : 1,
          transition: "all 0.15s",
          letterSpacing: "0.02em",
          flexShrink: 0,
        }}
      >
        {pending ? "Saving…" : paused ? "Resume posting" : "Pause posting"}
      </button>
    </div>
  )
}
