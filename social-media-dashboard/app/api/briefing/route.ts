import { NextRequest, NextResponse } from "next/server"
import Anthropic from "@anthropic-ai/sdk"
import sql from "@/lib/db"

export async function POST(req: NextRequest) {
  const today = new Date().toISOString().slice(0, 10)

  const cached = await sql`SELECT value FROM settings WHERE key = ${"briefing_" + today} LIMIT 1`
  if (cached[0]?.value?.text) {
    return NextResponse.json({ text: cached[0].value.text })
  }

  const body = await req.json()
  const { totalPosted, weekPostCount, episodes, pending, bestThisWeek, platformTrends } = body

  const safe = (v: unknown) => String(v ?? "").replace(/[\n\r`]/g, " ").slice(0, 300)

  const platformLines = (platformTrends as { platform: string; trend: string; weekAvg: number }[])
    .map(p => {
      const arrow = p.trend === "up" ? "↑" : p.trend === "down" ? "↓" : "→"
      return `${safe(p.platform)}: ${arrow}${p.weekAvg > 0 ? ` (avg ${Math.round(Number(p.weekAvg))} views)` : ""}`
    })
    .join(", ")

  const bestLine = bestThisWeek
    ? `Best clip this week: "${safe(bestThisWeek.hook)}", ${Number(bestThisWeek.views).toLocaleString()} views on ${safe(bestThisWeek.platform)}`
    : "No view data synced yet this week"

  const prompt = `You are the voice of Afropolitan Content Studio, a social media automation platform posting Afropolitan podcast clips to TikTok, Instagram, YouTube Shorts, and Facebook Reels.

Write a 2-3 sentence daily briefing. Be direct, sharp, slightly personal, like a smart analyst who knows the business well. Reference the real numbers naturally. No bullet points, no headers, no fluff, no greeting, no em dashes.

Data:
- Total posts published all-time: ${totalPosted}
- Posts this week: ${weekPostCount}
- Episodes processed: ${episodes}
- Clips queued to post next: ${pending}
- ${bestLine}
- Platform trends this week: ${platformLines}

Write the briefing:`

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 180,
    messages: [{ role: "user", content: prompt }],
  })

  const text = (message.content[0] as { type: string; text: string }).text.trim()

  const cacheKey = "briefing_" + today
  const cacheVal = JSON.stringify({ text, generated_at: new Date().toISOString() })
  await sql`
    INSERT INTO settings (key, value) VALUES (${cacheKey}, ${cacheVal}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `

  return NextResponse.json({ text })
}
