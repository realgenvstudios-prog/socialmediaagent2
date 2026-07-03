"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

export default function LoginPage() {
  const [password, setPassword] = useState("")
  const [error, setError]       = useState("")
  const [loading, setLoading]   = useState(false)
  const router = useRouter()

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError("")
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        router.push("/")
        router.refresh()
      } else {
        setError("Incorrect password")
        setLoading(false)
      }
    } catch {
      setError("Network error — please try again")
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "var(--bg)",
      padding: "2rem",
    }}>
      <div style={{ width: "100%", maxWidth: "340px" }}>

        {/* Brand */}
        <div style={{ marginBottom: "3rem", textAlign: "center" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", marginBottom: "6px" }}>
            <span style={{
              display: "inline-block",
              width: "7px",
              height: "7px",
              borderRadius: "50%",
              background: "var(--green)",
              boxShadow: "0 0 0 2.5px rgba(22,163,74,0.18)",
            }} />
            <span style={{ fontSize: "14px", fontWeight: 600, letterSpacing: "-0.02em", color: "var(--text)" }}>
              Afropolitan
            </span>
          </div>
          <p style={{ fontSize: "12px", color: "var(--faint)", letterSpacing: "0.05em" }}>
            CONTENT STUDIO
          </p>
        </div>

        {/* Form */}
        <div style={{ border: "1px solid var(--border)", padding: "2.5rem 2rem", background: "var(--bg)" }}>
          <h1 style={{ fontSize: "1.125rem", fontWeight: 400, letterSpacing: "-0.02em", color: "var(--text)", marginBottom: "0.375rem" }}>
            Sign in
          </h1>
          <p style={{ fontSize: "13px", color: "var(--muted)", marginBottom: "2rem" }}>
            Enter your password to access the studio.
          </p>

          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoFocus
              style={{
                width: "100%",
                padding: "10px 14px",
                fontSize: "14px",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                outline: "none",
                color: "var(--text)",
                background: "var(--bg)",
                transition: "border-color 0.15s",
              }}
              onFocus={e => (e.target.style.borderColor = "#999")}
              onBlur={e => (e.target.style.borderColor = "var(--border)")}
            />

            {error && (
              <p style={{ fontSize: "12px", color: "var(--red)", margin: 0 }}>{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                width: "100%",
                padding: "10px 14px",
                fontSize: "13px",
                fontWeight: 600,
                letterSpacing: "0.02em",
                color: "#fff",
                background: loading ? "var(--faint)" : "var(--text)",
                border: "none",
                borderRadius: "6px",
                cursor: loading ? "not-allowed" : "pointer",
                transition: "background 0.15s",
              }}
            >
              {loading ? "Signing in…" : "Continue"}
            </button>
          </form>
        </div>

      </div>
    </div>
  )
}
