import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
)

export async function GET() {
  const { data } = await admin
    .from("settings")
    .select("value")
    .eq("key", "paused")
    .single()

  return NextResponse.json({ paused: data?.value?.paused ?? false })
}

export async function POST(req: NextRequest) {
  const { paused } = await req.json()

  await admin
    .from("settings")
    .upsert({ key: "paused", value: { paused: Boolean(paused) } }, { onConflict: "key" })

  return NextResponse.json({ ok: true, paused: Boolean(paused) })
}
