import { useState } from 'react'
import { api } from '../api/client'
import LoginBanner from '../components/LoginBanner'
import JobProgress from '../components/JobProgress'

export default function Home() {
  const [url, setUrl] = useState('')
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setError(null)
    try {
      const res = await api.submitDownload({ url: url.trim() })
      setJobId(res.job_id)
    } catch (err) {
      setError(String(err))
    }
  }

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">下载</h1>
      <LoginBanner />
      <div className="mb-4 flex gap-2">
        <input
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
          placeholder="粘贴抖音链接（短链、视频、图文、合集都支持）"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && url.trim()) submit()
          }}
        />
        <button
          className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
          onClick={submit}
          disabled={!url.trim()}
        >
          下载
        </button>
      </div>
      {error && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {jobId && <JobProgress jobId={jobId} />}
    </div>
  )
}
