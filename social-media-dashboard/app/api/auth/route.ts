import { NextRequest, NextResponse } from "next/server"
import { createHmac } from "crypto"

function sessionToken() {
  const salt = process.env.SESSION_SALT ?? ""
  return createHmac("sha256", process.env.DASHBOARD_PASSWORD ?? "")
    .update(`konnectedminds-session-v1:${salt}`)
    .digest("hex")
}

// Simple in-memory rate limiter — 5 attempts per IP per 15 minutes
const loginAttempts = new Map<string, { count: number; resetAt: number }>()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const WINDOW = 15 * 60 * 1000
  const entry = loginAttempts.get(ip)
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW })
    return false
  }
  if (entry.count >= 5) return true
  entry.count++
  return false
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 })
  }

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
    secure: process.env.NODE_ENV === "production",
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
