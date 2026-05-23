"use client"
import { useState, useEffect } from "react"

const ALL_TIMES = [
  "06:00","07:00","08:00","09:00","10:00","11:00",
  "12:00","13:00","14:00","15:00","16:00","17:00",
  "18:00","19:00","20:00","21:00","22:00","23:00",
]

export default function SchedulePage() {
  const [times, setTimes] = useState<string[]>(["09:00", "13:00", "18:00"])
  const [maxPerRun, setMaxPerRun] = useState(1)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch("/api/schedule")
      .then(r => r.json())
      .then(d => {
        setTimes(d.times ?? ["09:00", "13:00", "18:00"])
        setMaxPerRun(d.max_per_run ?? 1)
        setLoading(false)
      })
  }, [])

  function toggleTime(t: string) {
    setTimes(prev =>
      prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t].sort()
    )
    setSaved(false)
  }

  async function handleSave() {
    setSaving(true)
    await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ times, max_per_run: maxPerRun }),
    })
    setSaving(false)
    setSaved(true)
  }

  if (loading) return <div className="text-sm text-gray-400 pt-8">Loading…</div>

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Posting Schedule</h1>
        <p className="text-sm text-gray-500 mt-1">Choose which hours the agent posts each day (UTC)</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 max-w-xl space-y-6">

        {/* Time picker */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Posting times (UTC) — {times.length} selected
          </p>
          <div className="grid grid-cols-4 gap-2">
            {ALL_TIMES.map(t => (
              <button
                key={t}
                onClick={() => toggleTime(t)}
                className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  times.includes(t)
                    ? "bg-indigo-600 text-white border-indigo-600"
                    : "bg-white text-gray-600 border-gray-200 hover:border-indigo-300"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Posts per run */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Clips per posting run
          </p>
          <div className="flex gap-2">
            {[1, 2, 3].map(n => (
              <button
                key={n}
                onClick={() => { setMaxPerRun(n); setSaved(false) }}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                  maxPerRun === n
                    ? "bg-indigo-600 text-white border-indigo-600"
                    : "bg-white text-gray-600 border-gray-200 hover:border-indigo-300"
                }`}
              >
                {n} clip{n > 1 ? "s" : ""}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Each clip posts to all 4 platforms simultaneously.
          </p>
        </div>

        {/* Summary */}
        <div className="bg-gray-50 rounded-lg px-4 py-3 text-sm text-gray-600">
          <span className="font-medium">{times.length * maxPerRun * 4}</span> platform posts per day
          {" · "}
          <span className="font-medium">{times.length}</span> runs at {times.join(", ")} UTC
        </div>

        <button
          onClick={handleSave}
          disabled={saving || times.length === 0}
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? "Saving…" : saved ? "✓ Saved" : "Save Schedule"}
        </button>
      </div>
    </div>
  )
}
