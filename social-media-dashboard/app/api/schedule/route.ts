import { NextRequest, NextResponse } from "next/server"
import sql from "@/lib/db"

export async function GET() {
  const rows = await sql`SELECT value FROM settings WHERE key = 'schedule' LIMIT 1`
  return NextResponse.json(rows[0]?.value ?? { times: ["09:00", "13:00", "18:00"], max_per_run: 1 })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { times, max_per_run } = body

  if (!Array.isArray(times) || times.length === 0 || times.length > 6) {
    return NextResponse.json({ error: "times must be an array of 1 to 6 time strings" }, { status: 400 })
  }

  const value = { times, max_per_run: max_per_run ?? 1 }
  await sql`
    INSERT INTO settings (key, value) VALUES ('schedule', ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `
  return NextResponse.json({ ok: true })
}
