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
  const { url, title } = await req.json()

  const videoId = extractVideoId(url.trim())
  if (!videoId) {
    return NextResponse.json({ error: "Invalid YouTube URL" }, { status: 400 })
  }

  // Trigger the process_manual.yml workflow via GitHub API
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
          video_url:   url.trim(),
          video_title: title.trim() || videoId,
        },
      }),
    }
  )

  // GitHub returns 204 No Content on success
  if (res.status !== 204) {
    const body = await res.text()
    console.error("GitHub dispatch failed:", res.status, body)
    return NextResponse.json({ error: "Failed to trigger workflow" }, { status: 500 })
  }

  const actionsUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/process_manual.yml`

  return NextResponse.json({ ok: true, videoId, actionsUrl })
}
