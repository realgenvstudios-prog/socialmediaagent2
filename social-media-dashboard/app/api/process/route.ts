import { NextRequest, NextResponse } from "next/server"

const GITHUB_TOKEN = process.env.GITHUB_TOKEN!
const GITHUB_OWNER = process.env.GITHUB_OWNER!
const GITHUB_REPO  = process.env.GITHUB_REPO!

function extractVideoId(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === "youtu.be") return parsed.pathname.slice(1).split("?")[0] || null
    if (parsed.hostname.includes("youtube.com")) return parsed.searchParams.get("v")
  } catch {}
  return null
}

export async function POST(req: NextRequest) {
  const body = await req.json()

  // Accept either { videoId, title } directly or { url, title } for backwards compat
  let videoId: string | null = body.videoId ?? null
  const title: string = body.title?.trim() || videoId || ""

  if (!videoId && body.url) {
    videoId = extractVideoId(body.url.trim())
  }

  if (!videoId) {
    return NextResponse.json({ error: "Invalid YouTube URL or video ID" }, { status: 400 })
  }

  // YouTube video IDs are exactly 11 chars: alphanumeric, hyphen, underscore
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "Invalid video ID format" }, { status: 400 })
  }

  // Strip characters that could interfere with shell argument parsing
  const safeTitle = title.replace(/[^\w\s',.\-:!?()&]/g, " ").trim().slice(0, 200)

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/process_manual.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          video_id:    videoId,
          video_url:   `https://www.youtube.com/watch?v=${videoId}`,
          video_title: safeTitle || videoId,
        },
      }),
    }
  )

  if (res.status !== 204) {
    const body = await res.text()
    console.error("GitHub dispatch failed:", res.status, body)
    return NextResponse.json({ error: "Failed to trigger workflow" }, { status: 500 })
  }

  const actionsUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/process_manual.yml`
  return NextResponse.json({ ok: true, videoId, actionsUrl })
}
