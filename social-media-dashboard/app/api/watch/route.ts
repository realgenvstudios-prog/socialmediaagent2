import { supabase } from "@/lib/supabase"
import { NextRequest, NextResponse } from "next/server"

const YT_PATTERN = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/

export async function POST(req: NextRequest) {
  const { url } = await req.json()

  if (!url || !YT_PATTERN.test(url)) {
    return NextResponse.json({ error: "Please provide a valid YouTube video URL." }, { status: 400 })
  }

  // Get first active client
  const { data: clients } = await supabase.from("clients").select("id").eq("active", true).limit(1)
  if (!clients?.length) {
    return NextResponse.json({ error: "No active clients configured." }, { status: 500 })
  }

  // Check if a pending/running manual job for this URL already exists
  const { data: existing } = await supabase
    .from("jobs")
    .select("id, status")
    .eq("job_type", "watch_manual")
    .in("status", ["pending", "running"])

  const alreadyQueued = existing?.some(j => {
    try { return JSON.parse((j as any).payload ?? "{}").url === url } catch { return false }
  })

  if (alreadyQueued) {
    return NextResponse.json({ error: "This video is already queued for processing." }, { status: 409 })
  }

  const { error } = await supabase.from("jobs").insert({
    client_id: clients[0].id,
    job_type: "watch_manual",
    status: "pending",
    payload: JSON.stringify({ url }),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
