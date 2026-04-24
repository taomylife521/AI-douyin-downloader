import { useState } from 'react'
import { api, type DownloadRequestBody } from '../api/client'
import JobProgress from '../components/JobProgress'

const MODES: Array<'post' | 'like' | 'mix' | 'music'> = [
  'post',
  'like',
  'mix',
  'music',
]
const MODE_LABEL: Record<string, string> = {
  post: '作品',
  like: '喜欢',
  mix: '合集',
  music: '音乐',
}

export default function Batch() {
  const [url, setUrl] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set(['post']))
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [count, setCount] = useState('')
  const [increment, setIncrement] = useState(true)
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function toggle(m: string) {
    const next = new Set(selected)
    if (next.has(m)) next.delete(m)
    else next.add(m)
    setSelected(next)
  }

  async function submit() {
    setError(null)
    const body: DownloadRequestBody = {
      url: url.trim(),
      mode: Array.from(selected) as DownloadRequestBody['mode'],
      increment,
    }
    if (startTime) body.start_time = startTime
    if (endTime) body.end_time = endTime
    const n = Number(count)
    if (Number.isFinite(n) && n > 0) {
      body.number = { post: n, like: n, mix: n, music: n }
    }
    try {
      const res = await api.submitDownload(body)
      setJobId(res.job_id)
    } catch (err) {
      setError(String(err))
    }
  }

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">批量下载</h1>
      <div className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
        <label className="block text-sm">
          <span className="mb-1 block text-slate-700">用户主页链接</span>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="https://www.douyin.com/user/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>

        <div>
          <div className="mb-1 text-sm text-slate-700">下载模式</div>
          <div className="flex gap-4">
            {MODES.map((m) => (
              <label key={m} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={selected.has(m)}
                  onChange={() => toggle(m)}
                />{' '}
                {MODE_LABEL[m]}
              </label>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <label className="block text-sm">
            <span className="mb-1 block text-slate-700">起始日期</span>
            <input
              type="date"
              className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-700">结束日期</span>
            <input
              type="date"
              className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-700">数量上限</span>
            <input
              type="number"
              min={0}
              className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
              value={count}
              onChange={(e) => setCount(e.target.value)}
              placeholder="不填=全部"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={increment}
            onChange={(e) => setIncrement(e.target.checked)}
          />
          增量下载（跳过已下载作品）
        </label>

        <div className="flex justify-end">
          <button
            className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
            disabled={!url.trim() || selected.size === 0}
            onClick={submit}
          >
            开始批量下载
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {jobId && (
        <div className="mt-4">
          <JobProgress jobId={jobId} />
        </div>
      )}
    </div>
  )
}
