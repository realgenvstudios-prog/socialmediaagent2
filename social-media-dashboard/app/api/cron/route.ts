import { NextRequest, NextResponse } from "next/server"

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  // Fail closed: if CRON_SECRET is not configured, reject all requests
  // rather than accidentally accepting "Bearer undefined"
  if (!secret) {
    return NextResponse.json({ error: "Not configured" }, { status: 500 })
  }
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const res = await fetch(
    "https://api.github.com/repos/realgenvstudios-prog/socialmediaagent/actions/workflows/publish.yml/dispatches",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    }
  )

  if (res.status === 204) {
    console.log(`[cron] triggered post at ${new Date().toISOString()}`)
    return NextResponse.json({ ok: true, triggered: new Date().toISOString() })
  }

  const body = await res.text()
  console.error(`[cron] GitHub API error ${res.status}: ${body}`)
  return NextResponse.json({ ok: false, status: res.status }, { status: 500 })
}
