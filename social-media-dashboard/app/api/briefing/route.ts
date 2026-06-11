import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import Anthropic from "@anthropic-ai/sdk"

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
)

export async function POST(req: NextRequest) {
  const today = new Date().toISOString().slice(0, 10)

  // Return today's cached briefing if it exists
  const { data: cached } = await admin
    .from("settings")
    .select("value")
    .eq("key", `briefing_${today}`)
    .single()

  if (cached?.value?.text) {
    return NextResponse.json({ text: cached.value.text })
  }

  const body = await req.json()
  const { totalPosted, weekPostCount, episodes, pending, bestThisWeek, platformTrends } = body

  const platformLines = (platformTrends as { platform: string; trend: string; weekAvg: number }[])
    .map(p => {
      const arrow = p.trend === "up" ? "↑" : p.trend === "down" ? "↓" : "→"
      return `${p.platform}: ${arrow}${p.weekAvg > 0 ? ` (avg ${Math.round(p.weekAvg)} views)` : ""}`
    })
    .join(", ")

  const bestLine = bestThisWeek
    ? `Best clip this week: "${bestThisWeek.hook}" — ${Number(bestThisWeek.views).toLocaleString()} views on ${bestThisWeek.platform}`
    : "No view data synced yet this week"

  const prompt = `You are the voice of KonnectedMinds Content Studio — a social media automation platform posting African entrepreneur podcast clips to TikTok, Instagram, YouTube Shorts, and Facebook Reels.

Write a 2-3 sentence daily briefing. Be direct, sharp, slightly personal — like a smart analyst who knows the business well. Reference the real numbers naturally. No bullet points, no headers, no fluff, no greeting.

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

  // Cache for today
  await admin
    .from("settings")
    .upsert(
      { key: `briefing_${today}`, value: { text, generated_at: new Date().toISOString() } },
      { onConflict: "key" },
    )

  return NextResponse.json({ text })
}
