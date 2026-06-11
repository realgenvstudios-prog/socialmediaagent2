"use client"

import { useEffect, useState } from "react"

export default function Briefing({ text }: { text: string }) {
  const [displayed, setDisplayed] = useState("")
  const [typing, setTyping] = useState(false)

  useEffect(() => {
    if (!text) return
    setDisplayed("")
    setTyping(true)
    let i = 0
    const timer = setInterval(() => {
      i++
      setDisplayed(text.slice(0, i))
      if (i >= text.length) {
        clearInterval(timer)
        setTyping(false)
      }
    }, 18)
    return () => clearInterval(timer)
  }, [text])

  return (
    <div style={{
      borderLeft: "2px solid var(--text)",
      paddingLeft: "1.25rem",
      marginBottom: "4rem",
      minHeight: "3rem",
    }}>
      <p style={{
        fontSize: "0.925rem",
        lineHeight: 1.8,
        color: "var(--muted)",
        letterSpacing: "-0.01em",
        margin: 0,
      }}>
        {displayed}
        {typing && (
          <span style={{
            display: "inline-block",
            width: "1.5px",
            height: "1em",
            background: "var(--text)",
            marginLeft: "2px",
            verticalAlign: "text-bottom",
            animation: "blink 0.65s step-end infinite",
          }} />
        )}
      </p>
    </div>
  )
}
