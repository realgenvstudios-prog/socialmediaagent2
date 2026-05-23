"use client"
import { useState } from "react"

export default function ProcessPage() {
  const [url, setUrl]           = useState("")
  const [title, setTitle]       = useState("")
  const [status, setStatus]     = useState<"idle" | "loading" | "success" | "error">("idle")
  const [actionsUrl, setActionsUrl] = useState("")
  const [errorMsg, setErrorMsg] = useState("")

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    setStatus("loading")
    setErrorMsg("")

    const res = await fetch("/api/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.trim(), title: title.trim() }),
    })

    const data = await res.json()
    if (res.ok) {
      setStatus("success")
      setActionsUrl(data.actionsUrl)
    } else {
      setStatus("error")
      setErrorMsg(data.error ?? "Something went wrong")
    }
  }

  function reset() { setStatus("idle"); setUrl(""); setTitle(""); setErrorMsg("") }

  return (
    <div style={{ maxWidth: "560px" }}>

      {/* Header */}
      <div style={{ marginBottom: "3rem" }}>
        <h1 style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)", fontWeight: 300, letterSpacing: "-0.03em", color: "var(--text)", marginBottom: "0.5rem" }}>
          Process
        </h1>
        <p style={{ fontSize: "13px", color: "var(--muted)" }}>
          Submit a YouTube URL — Claude picks the clips, burns subtitles, and queues everything automatically.
        </p>
      </div>

      <div style={{ border: "1px solid var(--border)" }}>
        {status !== "success" ? (
          <form onSubmit={handleSubmit} style={{ padding: "2rem" }}>

            {/* URL field */}
            <div style={{ marginBottom: "1.25rem" }}>
              <label style={{ display: "block", fontSize: "11px", fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: "8px" }}>
                YouTube URL
              </label>
              <input
                type="url"
                placeholder="https://www.youtube.com/watch?v=..."
                value={url}
                onChange={e => setUrl(e.target.value)}
                required
                style={{
                  width: "100%", padding: "10px 14px", fontSize: "13px",
                  border: "1px solid var(--border)", background: "var(--bg)",
                  color: "var(--text)", outline: "none", boxSizing: "border-box",
                  transition: "border-color 0.15s",
                }}
                onFocus={e => (e.target.style.borderColor = "#999")}
                onBlur={e => (e.target.style.borderColor = "var(--border)")}
              />
            </div>

            {/* Title field */}
            <div style={{ marginBottom: "1.5rem" }}>
              <label style={{ display: "block", fontSize: "11px", fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: "8px" }}>
                Video Title{" "}
                <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: "var(--faint)" }}>
                  — optional, helps Claude pick better clips
                </span>
              </label>
              <input
                type="text"
                placeholder="e.g. She Built Two Businesses While Everyone Else Was Just Posting"
                value={title}
                onChange={e => setTitle(e.target.value)}
                style={{
                  width: "100%", padding: "10px 14px", fontSize: "13px",
                  border: "1px solid var(--border)", background: "var(--bg)",
                  color: "var(--text)", outline: "none", boxSizing: "border-box",
                  transition: "border-color 0.15s",
                }}
                onFocus={e => (e.target.style.borderColor = "#999")}
                onBlur={e => (e.target.style.borderColor = "var(--border)")}
              />
            </div>

            {/* Error */}
            {status === "error" && (
              <p style={{ fontSize: "12px", color: "var(--red)", marginBottom: "1rem" }}>
                {errorMsg || "Invalid YouTube URL — make sure it includes a video ID."}
              </p>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={status === "loading"}
              style={{
                width: "100%", padding: "10px 14px", fontSize: "13px",
                fontWeight: 600, letterSpacing: "0.02em", color: "#fff",
                background: status === "loading" ? "var(--faint)" : "var(--text)",
                border: "none", cursor: status === "loading" ? "not-allowed" : "pointer",
                transition: "background 0.15s",
              }}
            >
              {status === "loading" ? "Starting…" : "Process video"}
            </button>
          </form>

        ) : (
          <div style={{ padding: "2rem" }}>

            {/* Success */}
            <p style={{ fontSize: "12px", color: "var(--green)", fontWeight: 500, marginBottom: "1rem" }}>
              ● Processing started
            </p>
            <p style={{ fontSize: "13px", color: "var(--text)", lineHeight: 1.7, marginBottom: "1.5rem" }}>
              GitHub is now downloading the video, transcribing it, picking the best clips with Claude, burning subtitles and uploading everything.
              Takes <strong>30–60 minutes</strong>. Clips will appear in the queue automatically when done.
            </p>

            {/* Progress link */}
            <a
              href={actionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-block", fontSize: "12px", fontWeight: 600,
                padding: "8px 18px", border: "1px solid var(--border)",
                color: "var(--text)", textDecoration: "none", marginBottom: "1.75rem",
                letterSpacing: "0.02em", transition: "border-color 0.15s",
              }}
            >
              Watch progress on GitHub Actions ↗
            </a>

            <div>
              <button
                onClick={reset}
                style={{ fontSize: "12px", color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: 0, display: "block" }}
              >
                ← Process another video
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
