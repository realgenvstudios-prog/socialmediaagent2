import { NextRequest, NextResponse } from "next/server"
import sql from "@/lib/db"

export async function GET() {
  const rows = await sql`SELECT value FROM settings WHERE key = 'paused' LIMIT 1`
  return NextResponse.json({ paused: rows[0]?.value?.paused ?? false })
}

export async function POST(req: NextRequest) {
  const { paused } = await req.json()
  await sql`
    INSERT INTO settings (key, value) VALUES ('paused', ${JSON.stringify({ paused: Boolean(paused) })}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `
  return NextResponse.json({ ok: true, paused: Boolean(paused) })
}
