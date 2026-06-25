import { supabase } from "@/lib/supabase"
import Link from "next/link"
import AnalyzeVideoForm from "@/components/AnalyzeVideoForm"

export const revalidate = 60

async function getClips() {
  const { data } = await supabase
    .from("clips")
    .select(`id, clip_index, caption, duration_seconds, created_at,
      videos(title, thumbnail_url),
      posts(platform, status)`)
    .order("created_at", { ascending: false })
    .limit(60)
  return data ?? []
}

const PLATFORMS = ["tiktok", "youtube", "facebook"] as const

const platformLabel: Record<string, string> = { tiktok: "TT", youtube: "YT", facebook: "FB" }
const platformPosted: Record<string, string>  = {
  tiktok:   "bg-pink-500  text-white",
  youtube:  "bg-red-500   text-white",
  facebook: "bg-blue-600  text-white",
}

export default async function ClipsPage() {
  const clips = await getClips()
  const fullyPosted = clips.filter((c: any) =>
    PLATFORMS.every(p => (c.posts ?? []).some((post: any) => post.platform === p && post.status === "posted"))
  ).length

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Clips</h1>
          <p className="text-sm text-gray-500 mt-1">{clips.length} clips · {fullyPosted} fully posted</p>
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
            const posts: any[] = clip.posts ?? []
            const allPosted = PLATFORMS.every(p => posts.some((post: any) => post.platform === p && post.status === "posted"))

            return (
              <Link
                key={clip.id}
                href={`/clips/${clip.id}`}
                className="group bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md hover:border-indigo-200 transition-all overflow-hidden block"
              >
                {/* Thumbnail */}
                <div className="relative h-40 bg-gray-100 overflow-hidden">
                  {clip.videos?.thumbnail_url ? (
                    <img
                      src={clip.videos.thumbnail_url}
                      alt=""
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-3xl text-gray-300">🎬</div>
                  )}
                  <div className="absolute bottom-2 right-2 bg-black/60 text-white text-xs font-mono px-1.5 py-0.5 rounded">
                    {clip.duration_seconds?.toFixed(0)}s
                  </div>
                  {allPosted && (
                    <div className="absolute top-2 left-2 bg-emerald-500 text-white text-xs font-semibold px-2 py-0.5 rounded-full">
                      ✓ Posted
                    </div>
                  )}
                </div>

                {/* Body */}
                <div className="p-4">
                  <p className="text-xs text-gray-400 truncate mb-1">
                    {clip.videos?.title ?? "-"} · Clip {clip.clip_index}
                  </p>
                  <p className="text-sm text-gray-800 line-clamp-2 leading-relaxed min-h-[2.5rem]">
                    {clip.caption || <span className="text-gray-300 italic">No caption</span>}
                  </p>

                  {/* Platform status row */}
                  <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-1.5">
                    {PLATFORMS.map((platform) => {
                      const post = posts.find((p: any) => p.platform === platform)
                      const posted = post?.status === "posted"
                      const failed  = post?.status === "failed"
                      return (
                        <span
                          key={platform}
                          className={`text-xs font-bold px-2 py-0.5 rounded transition-colors ${
                            failed  ? "bg-red-100 text-red-500" :
                            posted  ? platformPosted[platform] :
                            "bg-gray-100 text-gray-400"
                          }`}
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
