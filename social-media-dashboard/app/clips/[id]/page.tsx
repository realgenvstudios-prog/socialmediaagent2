import sql from "@/lib/db"
import CaptionEditor from "@/components/CaptionEditor"
import Link from "next/link"
import { notFound } from "next/navigation"

export const revalidate = 0

const platformMeta: Record<string, { label: string; color: string }> = {
  instagram: { label: "Instagram", color: "text-pink-600  bg-pink-50  ring-pink-200"  },
  tiktok:    { label: "TikTok",    color: "text-gray-900  bg-gray-50  ring-gray-200"  },
  youtube:   { label: "YouTube",   color: "text-red-600   bg-red-50   ring-red-200"   },
  facebook:  { label: "Facebook",  color: "text-blue-600  bg-blue-50  ring-blue-200"  },
}

async function getClip(id: string) {
  const rows = await sql.unsafe(
    `SELECT cq.id, cq.video_id, cq.clip_index, cq.caption, cq.hook,
            cq.public_url, cq.platform, cq.status, cq.posted_at, cq.created_at,
            pv.video_title
     FROM clip_queue cq
     LEFT JOIN processed_videos pv ON pv.video_id = cq.video_id
     WHERE cq.id = $1::uuid`,
    [id],
  )
  return (rows as any[])[0] ?? null
}

async function getPlatformStatuses(videoId: string, clipIndex: number) {
  const rows = await sql.unsafe(
    `SELECT platform, status, posted_at, zernio_post_id
     FROM clip_queue
     WHERE video_id = $1 AND clip_index = $2
     ORDER BY platform`,
    [videoId, clipIndex],
  )
  return rows as any[]
}

export default async function ClipDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const clip = await getClip(id)
  if (!clip) notFound()

  const platformRows = await getPlatformStatuses(clip.video_id, clip.clip_index)

  return (
    <div className="space-y-6">

      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-gray-400">
        <Link href="/clips" className="hover:text-gray-700 transition-colors">Clips</Link>
        <span>/</span>
        <span className="text-gray-700 font-medium">Clip {clip.clip_index}</span>
      </nav>

      <div className="grid lg:grid-cols-5 gap-6">

        {/* LEFT — thumbnail + meta */}
        <div className="lg:col-span-2 space-y-4">

          {/* Thumbnail */}
          <div className="rounded-xl overflow-hidden aspect-video bg-gray-100 relative shadow-sm">
            <img
              src={`https://img.youtube.com/vi/${clip.video_id}/hqdefault.jpg`}
              alt=""
              className="w-full h-full object-cover"
            />
          </div>

          {/* Details card */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm divide-y divide-gray-100">
            <div className="px-4 py-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Clip Info</p>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-gray-400">Video</span>
                  <span className="text-gray-800 font-medium text-right truncate max-w-[180px]">
                    {clip.video_title ?? clip.video_id}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Clip #</span>
                  <span className="text-gray-800 font-medium">{clip.clip_index}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Platform</span>
                  <span className="text-gray-800 font-medium capitalize">{clip.platform}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Created</span>
                  <span className="text-gray-800 font-medium">
                    {new Date(clip.created_at).toLocaleDateString()}
                  </span>
                </div>
                {clip.posted_at && (
                  <div className="flex justify-between">
                    <span className="text-gray-400">Posted</span>
                    <span className="text-gray-800 font-medium">
                      {new Date(clip.posted_at).toLocaleDateString()}
                    </span>
                  </div>
                )}
              </div>
            </div>
            {clip.hook && (
              <div className="px-4 py-3">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Why this clip</p>
                <p className="text-sm text-gray-600 italic leading-relaxed">&ldquo;{clip.hook}&rdquo;</p>
              </div>
            )}
            {clip.public_url && (
              <div className="px-4 py-3">
                <a
                  href={clip.public_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
                >
                  View clip file ↗
                </a>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — caption editor + platform status */}
        <div className="lg:col-span-3 space-y-4">

          {/* Caption editor */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-4">Caption</p>
            <CaptionEditor clipId={clip.id} initialCaption={clip.caption ?? ""} />
          </div>

          {/* Platform status */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 border-b border-gray-100">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Platform Status</p>
            </div>
            <div className="divide-y divide-gray-100">
              {platformRows.map((row: any) => {
                const meta = platformMeta[row.platform] ?? { label: row.platform, color: "text-gray-600 bg-gray-50 ring-gray-200" }
                const posted = row.status === "posted"
                const failed = row.status === "failed"
                return (
                  <div key={row.platform} className="px-5 py-4 flex items-center gap-4">
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ring-1 ${meta.color}`}>
                      {meta.label}
                    </span>
                    <div className="flex-1">
                      {posted ? (
                        <span className="text-sm font-medium text-emerald-600">✓ Posted successfully</span>
                      ) : failed ? (
                        <span className="text-sm font-medium text-red-600">✗ Failed</span>
                      ) : (
                        <span className="text-sm text-amber-600 font-medium capitalize">{row.status}</span>
                      )}
                    </div>
                    {row.posted_at && (
                      <p className="text-xs text-gray-400 shrink-0">
                        {new Date(row.posted_at).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                )
              })}
              {platformRows.length === 0 && (
                <div className="px-5 py-4 text-sm text-gray-400">No platform rows found.</div>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
