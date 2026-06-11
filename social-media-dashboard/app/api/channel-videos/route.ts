import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY!
const CHANNEL_ID      = process.env.CHANNEL_ID || "UCsvRFzTlxQ8QrrY-m2qbSNA"
const SUPABASE_URL    = process.env.SUPABASE_URL!
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY!

export const revalidate = 0

function parseIso8601Duration(d: string): string {
  const m = d.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!m) return ""
  const h = parseInt(m[1] || "0")
  const min = parseInt(m[2] || "0")
  const sec = parseInt(m[3] || "0")
  if (h > 0) return `${h}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
  return `${min}:${String(sec).padStart(2, "0")}`
}

async function fetchAllVideoIds(): Promise<{ videoId: string; title: string; thumbnail: string; publishedAt: string }[]> {
  const items: any[] = []
  let pageToken: string | undefined

  do {
    const params = new URLSearchParams({
      key: YOUTUBE_API_KEY,
      channelId: CHANNEL_ID,
      part: "snippet",
      type: "video",
      order: "date",
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    })
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, {
      next: { revalidate: 300 },
    })
    const data = await res.json()
    items.push(...(data.items ?? []))
    pageToken = data.nextPageToken
  } while (pageToken)

  return items.map((item: any) => ({
    videoId:     item.id.videoId,
    title:       item.snippet.title,
    thumbnail:   item.snippet.thumbnails.high?.url ?? item.snippet.thumbnails.medium?.url ?? "",
    publishedAt: item.snippet.publishedAt,
  }))
}

async function fetchDurations(videoIds: string[]): Promise<Record<string, string>> {
  const durations: Record<string, string> = {}
  // videos.list accepts up to 50 IDs per call
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50)
    const params = new URLSearchParams({
      key: YOUTUBE_API_KEY,
      id: batch.join(","),
      part: "contentDetails",
    })
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`, {
      next: { revalidate: 300 },
    })
    const data = await res.json()
    for (const item of data.items ?? []) {
      durations[item.id] = parseIso8601Duration(item.contentDetails.duration)
    }
  }
  return durations
}

export async function GET() {
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

  const [rawVideos, { data: processed }] = await Promise.all([
    fetchAllVideoIds(),
    sb.from("processed_videos").select("video_id, clip_count, processed_at, video_title"),
  ])

  const durations = await fetchDurations(rawVideos.map(v => v.videoId))

  const processedMap = Object.fromEntries(
    (processed ?? []).map((p: any) => [p.video_id, p])
  )

  const seen = new Set<string>()
  const videos = rawVideos
    .filter(v => {
      if (seen.has(v.videoId)) return false
      seen.add(v.videoId)
      return true
    })
    .map(v => ({
      ...v,
      duration:  durations[v.videoId] ?? "",
      processed: processedMap[v.videoId] ?? null,
    }))

  return NextResponse.json({ videos, total: videos.length })
}
