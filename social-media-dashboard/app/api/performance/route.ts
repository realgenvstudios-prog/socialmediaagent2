import { NextRequest, NextResponse } from "next/server"

const ZERNIO_BASE = "https://zernio.com/api/v1"

const PLATFORM_KEY: Record<string, string> = {
  instagram: process.env.ZERNIO_API_KEY!,
  tiktok:    process.env.ZERNIO_API_KEY!,
  youtube:   process.env.ZERNIO_API_KEY_2!,
  facebook:  process.env.ZERNIO_API_KEY_2!,
}

export async function GET(req: NextRequest) {
  const postId   = req.nextUrl.searchParams.get("postId")
  const platform = req.nextUrl.searchParams.get("platform")

  if (!postId || !platform) return NextResponse.json({ error: "missing params" }, { status: 400 })

  const key = PLATFORM_KEY[platform]
  if (!key) return NextResponse.json({ error: "unknown platform" }, { status: 400 })

  const res = await fetch(`${ZERNIO_BASE}/analytics?postId=${postId}`, {
    headers: { Authorization: `Bearer ${key}` },
    next: { revalidate: 0 },
  })

  const data = await res.json()
  return NextResponse.json(data)
}
