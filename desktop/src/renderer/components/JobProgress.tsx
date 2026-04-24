import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { subscribeJobEvents, type JobEvent } from '../api/sse'

interface Props {
  jobId: string
  onDone?: () => void
}

export default function JobProgress({ jobId, onDone }: Props) {
  const [events, setEvents] = useState<JobEvent[]>([])
  const [totals, setTotals] = useState<{
    total: number
    success: number
    failed: number
    skipped: number
  } | null>(null)
  const [cancelled, setCancelled] = useState(false)

  useEffect(() => {
    let unsub: (() => void) | null = null
    subscribeJobEvents(jobId, (e) => {
      setEvents((prev) => [...prev.slice(-199), e])
      if (e.event === 'done') {
        setTotals(e.data)
        onDone?.()
      }
    })
      .then((u) => {
        unsub = u
      })
      .catch((err) => console.error('subscribe failed', err))
    return () => {
      unsub?.()
    }
  }, [jobId, onDone])

  const lastProgress = [...events].reverse().find(
    (e) => e.event === 'item-progress',
  ) as Extract<JobEvent, { event: 'item-progress' }> | undefined

  const pct =
    lastProgress && lastProgress.data.bytes_total
      ? Math.min(
          100,
          Math.round(
            (lastProgress.data.bytes_read / lastProgress.data.bytes_total) * 100,
          ),
        )
      : 0

  async function cancel() {
    setCancelled(true)
    try {
      await api.cancelJob(jobId)
    } catch (err) {
      console.warn('cancel failed', err)
    }
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-600">
          Job <code className="text-xs">{jobId}</code>
        </div>
        {!totals && (
          <button
            className="text-xs text-slate-500 hover:text-red-600 disabled:opacity-50"
            onClick={cancel}
            disabled={cancelled}
          >
            {cancelled ? '已请求取消' : '取消'}
          </button>
        )}
      </div>
      {totals ? (
        <div className="mt-2 text-sm">
          完成：{totals.success}/{totals.total}（失败 {totals.failed}，跳过{' '}
          {totals.skipped}）
        </div>
      ) : (
        <div className="mt-2">
          <div className="h-2 w-full overflow-hidden rounded bg-slate-100">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1 text-xs text-slate-500">{pct}%</div>
        </div>
      )}
      <div className="mt-3 max-h-40 overflow-auto font-mono text-[11px] text-slate-500">
        {events.slice(-20).map((e, i) => (
          <div key={i}>
            {e.event}: {JSON.stringify(e.data).slice(0, 120)}
          </div>
        ))}
      </div>
    </div>
  )
}
