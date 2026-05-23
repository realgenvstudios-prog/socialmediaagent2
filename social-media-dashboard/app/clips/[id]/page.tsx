import { supabase } from "@/lib/supabase"
import CaptionEditor from "@/components/CaptionEditor"
import Link from "next/link"
import { notFound } from "next/navigation"

export const revalidate = 0

async function getClip(id: string) {
  const { data } = await supabase
    .from("clips")
    .select(`id, clip_index, caption, hook, duration_seconds, start_seconds, end_seconds, created_at,
      videos(title, thumbnail_url, url),
      posts(id, platform, status, post_url, error, created_at)`)
    .eq("id", id)
    .single()
  return data
}

const platformMeta: Record<string, { label: string; color: string }> = {
  tiktok:   { label: "TikTok",   color: "text-pink-600  bg-pink-50  ring-pink-200"   },
  youtube:  { label: "YouTube",  color: "text-red-600   bg-red-50   ring-red-200"    },
  facebook: { label: "Facebook", color: "text-blue-600  bg-blue-50  ring-blue-200"   },
}

export default async function ClipDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const clip = await getClip(id)
  if (!clip) notFound()
  const posts: any[] = (clip as any).posts ?? []

  return (
    <div className="space-y-6">

      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-gray-400">
        <Link href="/clips" className="hover:text-gray-700 transition-colors">Clips</Link>
        <span>/</span>
        <span className="text-gray-700 font-medium">Clip {(clip as any).clip_index}</span>
      </nav>

      <div className="grid lg:grid-cols-5 gap-6">

        {/* LEFT — clip preview + meta */}
        <div className="lg:col-span-2 space-y-4">

          {/* Thumbnail */}
          <div className="rounded-xl overflow-hidden aspect-video bg-gray-100 relative shadow-sm">
            {(clip as any).videos?.thumbnail_url ? (
              <img src={(clip as any).videos.thumbnail_url} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-4xl text-gray-300">🎬</div>
            )}
            <div className="absolute bottom-2 right-2 bg-black/60 text-white text-xs font-mono px-1.5 py-0.5 rounded">
              {(clip as any).duration_seconds?.toFixed(1)}s
            </div>
          </div>

          {/* Details card */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm divide-y divide-gray-100">
            <div className="px-4 py-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Clip Info</p>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-gray-400">Video</span>
                  <span className="text-gray-800 font-medium text-right truncate max-w-[180px]">{(clip as any).videos?.title ?? "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Clip #</span>
                  <span className="text-gray-800 font-medium">{(clip as any).clip_index}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Range</span>
                  <span className="text-gray-800 font-mono font-medium">{(clip as any).start_seconds?.toFixed(0)}s – {(clip as any).end_seconds?.toFixed(0)}s</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Created</span>
                  <span className="text-gray-800 font-medium">{new Date((clip as any).created_at).toLocaleDateString()}</span>
                </div>
              </div>
            </div>
            {(clip as any).hook && (
              <div className="px-4 py-3">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Why this clip</p>
                <p className="text-sm text-gray-600 italic leading-relaxed">"{(clip as any).hook}"</p>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — caption editor + platform status */}
        <div className="lg:col-span-3 space-y-4">

          {/* Caption editor */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-4">Caption</p>
            <CaptionEditor clipId={clip.id} initialCaption={(clip as any).caption ?? ""} />
          </div>

          {/* Platform status */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 border-b border-gray-100">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Platform Status</p>
            </div>
            <div className="divide-y divide-gray-100">
              {["tiktok", "youtube", "facebook"].map((platform) => {
                const post = posts.find((p) => p.platform === platform)
                const meta = platformMeta[platform]
                const posted = post?.status === "posted"
                const failed = post?.status === "failed"

                return (
                  <div key={platform} className="px-5 py-4 flex items-center gap-4">
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ring-1 ${meta.color}`}>
                      {meta.label}
                    </span>
                    <div className="flex-1">
                      {post ? (
                        posted ? (
                          <span className="text-sm font-medium text-emerald-600">✓ Posted successfully</span>
                        ) : failed ? (
                          <div>
                            <span className="text-sm font-medium text-red-600">✗ Failed</span>
                            {post.error && <p className="text-xs text-red-400 mt-0.5 truncate">{post.error}</p>}
                          </div>
                        ) : (
                          <span className="text-sm text-amber-600 font-medium capitalize">{post.status}</span>
                        )
                      ) : (
                        <span className="text-sm text-gray-400">Not posted yet</span>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      {post?.post_url && (
                        <a href={post.post_url} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-indigo-600 hover:text-indigo-700 font-medium">
                          View post ↗
                        </a>
                      )}
                      {post?.created_at && (
                        <p className="text-xs text-gray-400 mt-0.5">
                          {new Date(post.created_at).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
