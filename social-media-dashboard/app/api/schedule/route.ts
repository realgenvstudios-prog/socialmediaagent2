import { NextRequest, NextResponse } from "next/server"
import { supabase } from "@/lib/supabase"

export async function GET() {
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "schedule")
    .single()
  return NextResponse.json(data?.value ?? { times: ["09:00", "13:00", "18:00"], max_per_run: 1 })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { times, max_per_run } = body

  if (!Array.isArray(times) || times.length === 0 || times.length > 6) {
    return NextResponse.json({ error: "times must be an array of 1 to 6 time strings" }, { status: 400 })
  }

  const { error } = await supabase
    .from("settings")
    .upsert({ key: "schedule", value: { times, max_per_run: max_per_run ?? 1 }, updated_at: new Date().toISOString() })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
