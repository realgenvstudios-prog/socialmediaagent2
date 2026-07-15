import { NextRequest, NextResponse } from "next/server"
import sql from "@/lib/db"

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

  await sql`UPDATE clip_queue SET caption = ${caption} WHERE id = ${id}::uuid`
  return NextResponse.json({ ok: true })
}
