import { NextRequest, NextResponse } from "next/server"

async function expectedToken(): Promise<string> {
  const enc = new TextEncoder()
  const salt = process.env.SESSION_SALT ?? ""
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(process.env.DASHBOARD_PASSWORD ?? ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`afropolitan-session-v1:${salt}`))
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/cron")
  ) {
    return NextResponse.next()
  }

  const session = req.cookies.get("session")?.value
  if (!session || session !== (await expectedToken())) {
    const loginUrl = req.nextUrl.clone()
    loginUrl.pathname = "/login"
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
