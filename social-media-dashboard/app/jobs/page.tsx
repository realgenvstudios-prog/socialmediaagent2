import sql from "@/lib/db"

export const revalidate = 30

async function getEpisodes() {
  const rows = await sql`
    SELECT pv.video_id, pv.video_title, pv.clip_count, pv.processed_at,
           COUNT(cq.id)                                                    AS total_clips,
           COUNT(cq.id) FILTER (WHERE cq.status = 'posted')               AS posted_clips,
           COUNT(cq.id) FILTER (WHERE cq.status = 'pending')              AS pending_clips,
           COUNT(cq.id) FILTER (WHERE cq.status = 'failed')               AS failed_clips
    FROM processed_videos pv
    LEFT JOIN clip_queue cq ON cq.video_id = pv.video_id AND cq.clip_index < 50
    GROUP BY pv.video_id, pv.video_title, pv.clip_count, pv.processed_at
    ORDER BY pv.processed_at DESC
    LIMIT 60
  `
  return rows as any[]
}

function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export default async function JobsPage() {
  const episodes = await getEpisodes()

  return (
    <div className="space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Pipeline History</h1>
        <p className="text-sm text-gray-500 mt-1">Episodes processed by the agent · {episodes.length} total</p>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Episode</th>
              <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Clips</th>
              <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Status</th>
              <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Processed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {episodes.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-5 py-16 text-center">
                  <div className="w-10 h-10 bg-gray-100 rounded-xl mx-auto mb-3 flex items-center justify-center text-xl">⚙️</div>
                  <p className="text-sm font-medium text-gray-700">No episodes processed yet</p>
                  <p className="text-xs text-gray-400 mt-1">Episodes appear here after the pipeline runs on a new video.</p>
                </td>
              </tr>
            ) : episodes.map((ep: any) => {
              const posted  = Number(ep.posted_clips)
              const pending = Number(ep.pending_clips)
              const failed  = Number(ep.failed_clips)
              const total   = Number(ep.total_clips)
              const allDone = total > 0 && posted === total
              const hasFail = failed > 0

              return (
                <tr key={ep.video_id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3.5 max-w-xs">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-7 rounded overflow-hidden bg-gray-100 shrink-0">
                        <img
                          src={`https://img.youtube.com/vi/${ep.video_id}/default.jpg`}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <p className="text-gray-800 font-medium truncate max-w-[240px]">
                        {ep.video_title ?? ep.video_id}
                      </p>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-gray-600 tabular-nums">
                    {total}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {posted > 0 && (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
                          {posted} posted
                        </span>
                      )}
                      {pending > 0 && (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 ring-1 ring-amber-200">
                          {pending} pending
                        </span>
                      )}
                      {failed > 0 && (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-700 ring-1 ring-red-200">
                          {failed} failed
                        </span>
                      )}
                      {total === 0 && (
                        <span className="text-xs text-gray-400">No clips queued</span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-right text-xs text-gray-400 tabular-nums whitespace-nowrap">
                    {timeAgo(ep.processed_at)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

    </div>
  )
}
