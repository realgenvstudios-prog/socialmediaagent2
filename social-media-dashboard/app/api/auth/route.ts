import { NextRequest, NextResponse } from "next/server"
import { createHmac } from "crypto"

function sessionToken() {
  return createHmac("sha256", process.env.DASHBOARD_PASSWORD ?? "")
    .update("konnectedminds-session-v1")
    .digest("hex")
}

export async function POST(req: NextRequest) {
  const { password } = await req.json()
  if (password !== process.env.DASHBOARD_PASSWORD) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.set("session", sessionToken(), {
    httpOnly: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    sameSite: "lax",
  })
  return res
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  res.cookies.delete("session")
  return res
}

export function getExpectedToken() {
  return sessionToken()
}
