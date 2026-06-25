import { supabase } from "@/lib/supabase"

export const revalidate = 30

async function getJobs() {
  const { data } = await supabase
    .from("jobs")
    .select("id, job_type, status, error, created_at, videos(title)")
    .order("created_at", { ascending: false })
    .limit(60)
  return data ?? []
}

const statusBadge: Record<string, string> = {
  pending: "bg-amber-50   text-amber-700  ring-1 ring-amber-200",
  running: "bg-blue-50    text-blue-700   ring-1 ring-blue-200",
  done:    "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  failed:  "bg-red-50     text-red-700    ring-1 ring-red-200",
}

const jobTypeBadge: Record<string, string> = {
  clip:   "bg-violet-50 text-violet-700 ring-1 ring-violet-200",
  post_a: "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200",
  post_b: "bg-sky-50    text-sky-700    ring-1 ring-sky-200",
}

export default async function JobsPage() {
  const jobs = await getJobs()

  const counts = jobs.reduce((acc: Record<string, number>, j: any) => {
    acc[j.status] = (acc[j.status] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Jobs</h1>
          <p className="text-sm text-gray-500 mt-1">Pipeline job queue · {jobs.length} total</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {Object.entries(counts).map(([status, count]) => (
            <span key={status} className={`text-xs font-semibold px-2.5 py-1 rounded-full capitalize ${statusBadge[status] ?? "bg-gray-100 text-gray-600"}`}>
              {count} {status}
            </span>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Status</th>
              <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Type</th>
              <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Video</th>
              <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Error</th>
              <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-16 text-center">
                  <div className="w-10 h-10 bg-gray-100 rounded-xl mx-auto mb-3 flex items-center justify-center text-xl">⚙️</div>
                  <p className="text-sm font-medium text-gray-700">No jobs yet</p>
                  <p className="text-xs text-gray-400 mt-1">Jobs appear here as the pipeline runs.</p>
                </td>
              </tr>
            ) : jobs.map((job: any) => (
              <tr key={job.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-5 py-3.5">
                  <span className={`text-xs font-semibold px-2.5 py-1 rounded-full capitalize ${statusBadge[job.status] ?? "bg-gray-100 text-gray-600"}`}>
                    {job.status}
                  </span>
                </td>
                <td className="px-5 py-3.5">
                  <span className={`text-xs font-semibold px-2.5 py-1 rounded-full font-mono ${jobTypeBadge[job.job_type] ?? "bg-gray-100 text-gray-600"}`}>
                    {job.job_type}
                  </span>
                </td>
                <td className="px-5 py-3.5 max-w-xs">
                  <p className="text-gray-800 font-medium truncate">{(job as any).videos?.title ?? <span className="text-gray-300">-</span>}</p>
                </td>
                <td className="px-5 py-3.5 max-w-xs">
                  {job.error
                    ? <p className="text-xs text-red-500 truncate">{job.error}</p>
                    : <span className="text-gray-300">-</span>
                  }
                </td>
                <td className="px-5 py-3.5 text-right text-xs text-gray-400 tabular-nums whitespace-nowrap">
                  {new Date(job.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  )
}
