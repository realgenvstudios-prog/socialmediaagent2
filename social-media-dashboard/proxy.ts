import { NextRequest, NextResponse } from "next/server"
import { createHmac } from "crypto"

function expectedToken() {
  return createHmac("sha256", process.env.DASHBOARD_PASSWORD ?? "")
    .update("konnectedminds-session-v1")
    .digest("hex")
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (pathname.startsWith("/login") || pathname.startsWith("/api/auth") || pathname.startsWith("/api/cron")) {
    return NextResponse.next()
  }

  const session = req.cookies.get("session")?.value
  if (!session || session !== expectedToken()) {
    const loginUrl = req.nextUrl.clone()
    loginUrl.pathname = "/login"
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
