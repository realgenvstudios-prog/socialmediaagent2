import sql from "@/lib/db"
import Link from "next/link"
import AnalyzeVideoForm from "@/components/AnalyzeVideoForm"

export const revalidate = 60

const PLATFORMS = ["instagram", "tiktok", "youtube", "facebook"] as const

const platformLabel: Record<string, string> = {
  instagram: "IG",
  tiktok:    "TT",
  youtube:   "YT",
  facebook:  "FB",
}

const platformColor: Record<string, string> = {
  instagram: "#e1306c",
  tiktok:    "#111111",
  youtube:   "#ff0000",
  facebook:  "#1877f2",
}

async function getClips() {
  // One representative row per (video_id, clip_index), preferring 'posted' status
  const rows = await sql.unsafe(`
    SELECT sq.id, sq.video_id, sq.clip_index, sq.caption, sq.public_url,
           sq.created_at, sq.status, pv.video_title
    FROM (
      SELECT DISTINCT ON (video_id, clip_index)
        id, video_id, clip_index, caption, public_url, created_at, status
      FROM clip_queue
      WHERE clip_index < 50
      ORDER BY video_id, clip_index, status DESC
    ) sq
    LEFT JOIN processed_videos pv ON pv.video_id = sq.video_id
    ORDER BY sq.created_at DESC
    LIMIT 60
  `, [])

  const platformRows = await sql.unsafe(`
    SELECT video_id, clip_index, platform, status
    FROM clip_queue
    WHERE clip_index < 50
  `, [])

  const statusMap = new Map<string, Record<string, string>>()
  for (const r of platformRows as any[]) {
    const key = `${r.video_id}-${r.clip_index}`
    if (!statusMap.has(key)) statusMap.set(key, {})
    statusMap.get(key)![r.platform] = r.status
  }

  return (rows as any[]).map(r => ({
    ...r,
    platforms: statusMap.get(`${r.video_id}-${r.clip_index}`) ?? {},
  }))
}

export default async function ClipsPage() {
  const clips = await getClips()
  const fullyPosted = clips.filter(c =>
    PLATFORMS.every(p => c.platforms[p] === "posted")
  ).length

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Clips</h1>
          <p className="text-sm text-gray-500 mt-1">
            {clips.length} clips · {fullyPosted} fully posted
          </p>
        </div>
        <AnalyzeVideoForm />
      </div>

      {clips.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm py-20 text-center">
          <div className="w-10 h-10 bg-gray-100 rounded-xl mx-auto mb-3 flex items-center justify-center text-xl">✂️</div>
          <p className="text-sm font-medium text-gray-700">No clips yet</p>
          <p className="text-xs text-gray-400 mt-1">Clips appear here once the watcher and clipper have run.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {clips.map((clip: any) => {
            const platforms = clip.platforms as Record<string, string>
            const allPosted = PLATFORMS.every(p => platforms[p] === "posted")

            return (
              <Link
                key={clip.id}
                href={`/clips/${clip.id}`}
                className="group bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md hover:border-indigo-200 transition-all overflow-hidden block"
              >
                {/* Thumbnail */}
                <div className="relative h-40 bg-gray-100 overflow-hidden">
                  <img
                    src={`https://img.youtube.com/vi/${clip.video_id}/hqdefault.jpg`}
                    alt=""
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  />
                  {allPosted && (
                    <div className="absolute top-2 left-2 bg-emerald-500 text-white text-xs font-semibold px-2 py-0.5 rounded-full">
                      ✓ Posted
                    </div>
                  )}
                </div>

                {/* Body */}
                <div className="p-4">
                  <p className="text-xs text-gray-400 truncate mb-1">
                    {clip.video_title ?? clip.video_id} · Clip {clip.clip_index}
                  </p>
                  <p className="text-sm text-gray-800 line-clamp-2 leading-relaxed min-h-[2.5rem]">
                    {clip.caption || <span className="text-gray-300 italic">No caption</span>}
                  </p>

                  {/* Platform status row */}
                  <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-1.5">
                    {PLATFORMS.map((platform) => {
                      const pStatus = platforms[platform]
                      const posted = pStatus === "posted"
                      const failed = pStatus === "failed"
                      return (
                        <span
                          key={platform}
                          className="text-xs font-bold px-2 py-0.5 rounded transition-colors"
                          style={{
                            color: posted ? platformColor[platform] : failed ? "#dc2626" : "#9ca3af",
                            background: posted ? `${platformColor[platform]}15` : "transparent",
                          }}
                        >
                          {platformLabel[platform]}
                        </span>
                      )
                    })}
                    <span className="ml-auto text-xs text-gray-400 tabular-nums">
                      {new Date(clip.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                    </span>
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
