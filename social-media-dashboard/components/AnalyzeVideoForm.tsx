"use client"

import { useState } from "react"

export default function AnalyzeVideoForm() {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState("")
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle")
  const [message, setMessage] = useState("")

  async function submit() {
    if (!url.trim()) return
    setStatus("loading")
    setMessage("")
    const res = await fetch("/api/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.trim() }),
    })
    const data = await res.json()
    if (res.ok) {
      setStatus("done")
      setMessage("Queued! The agent will process this video within 5 minutes.")
      setUrl("")
      setTimeout(() => { setOpen(false); setStatus("idle"); setMessage("") }, 3000)
    } else {
      setStatus("error")
      setMessage(data.error ?? "Something went wrong.")
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg transition-colors shadow-sm"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 1v12M1 7h12" stroke="white" strokeWidth="2" strokeLinecap="round"/>
        </svg>
        Analyze Video
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <input
        autoFocus
        type="url"
        value={url}
        onChange={e => { setUrl(e.target.value); setStatus("idle"); setMessage("") }}
        onKeyDown={e => e.key === "Enter" && submit()}
        placeholder="https://youtube.com/watch?v=..."
        className="w-72 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
      />
      <button
        onClick={submit}
        disabled={status === "loading" || !url.trim()}
        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-semibold rounded-lg transition-colors shadow-sm whitespace-nowrap"
      >
        {status === "loading" ? "Queuing…" : "Submit"}
      </button>
      <button
        onClick={() => { setOpen(false); setStatus("idle"); setUrl(""); setMessage("") }}
        className="px-3 py-2 text-sm text-gray-400 hover:text-gray-600 transition-colors"
      >
        Cancel
      </button>
      {status === "done"  && <span className="text-xs font-medium text-emerald-600 whitespace-nowrap">{message}</span>}
      {status === "error" && <span className="text-xs font-medium text-red-500 whitespace-nowrap">{message}</span>}
    </div>
  )
}
