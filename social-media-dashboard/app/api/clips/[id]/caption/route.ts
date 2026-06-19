import { supabase } from "@/lib/supabase"
import { NextRequest, NextResponse } from "next/server"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 })
  }

  const { caption } = await req.json()

  if (typeof caption !== "string" || caption.length > 500) {
    return NextResponse.json({ error: "Caption must be a string under 500 characters" }, { status: 400 })
  }

  const { error } = await supabase.from("clips").update({ caption }).eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
