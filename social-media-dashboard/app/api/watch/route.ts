import { NextRequest, NextResponse } from "next/server"

const YT_PATTERN = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/

export async function POST(req: NextRequest) {
  const { url } = await req.json()

  if (!url || !YT_PATTERN.test(url)) {
    return NextResponse.json({ error: "Please provide a valid YouTube video URL." }, { status: 400 })
  }

  return NextResponse.json({ ok: true, url })
}
