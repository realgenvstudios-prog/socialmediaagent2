"use client"

import { useState } from "react"

export default function CaptionEditor({ clipId, initialCaption }: { clipId: string; initialCaption: string }) {
  const [caption, setCaption] = useState(initialCaption)
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const dirty = caption !== initialCaption

  async function save() {
    setStatus("saving")
    const res = await fetch(`/api/clips/${clipId}/caption`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caption }),
    })
    setStatus(res.ok ? "saved" : "error")
    setTimeout(() => setStatus("idle"), 2500)
  }

  return (
    <div className="space-y-3">
      <textarea
        value={caption}
        onChange={(e) => { setCaption(e.target.value); setStatus("idle") }}
        rows={5}
        className="w-full rounded-lg border px-4 py-3 text-sm text-gray-800 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none transition-all"
        style={{ borderColor: dirty ? "#6366f1" : "#e5e7eb" }}
        placeholder="Write a caption with hashtags…"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={status === "saving" || !dirty}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-semibold rounded-lg transition-colors shadow-sm"
        >
          {status === "saving" ? "Saving…" : "Save Caption"}
        </button>
        {status === "saved" && <span className="text-xs font-medium text-emerald-600">✓ Saved</span>}
        {status === "error" && <span className="text-xs font-medium text-red-500">Failed to save</span>}
        {dirty && status === "idle" && <span className="text-xs text-gray-400">Unsaved changes</span>}
        <span className={`ml-auto text-xs tabular-nums ${caption.length > 480 ? "text-red-500 font-medium" : "text-gray-400"}`}>
          {caption.length} / 500
        </span>
      </div>
    </div>
  )
}
