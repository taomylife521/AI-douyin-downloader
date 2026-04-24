import { getBaseUrl } from './client'

export type JobEvent =
  | {
      event: 'job-start'
      data: { url: string; url_type: string; total: number | null }
    }
  | {
      event: 'item-start'
      data: { aweme_id: string; index: number; total: number; title: string }
    }
  | {
      event: 'item-progress'
      data: { aweme_id: string; bytes_read: number; bytes_total: number }
    }
  | {
      event: 'item-complete'
      data: {
        aweme_id: string
        status: 'ok' | 'failed' | 'skipped'
        file_paths: string[]
      }
    }
  // `type` is reserved for future use (e.g., 'auth-required', 'rate-limited').
  // MVP backend doesn't emit it.
  | { event: 'log'; data: { level: string; message: string; type?: string } }
  | {
      event: 'done'
      data: { total: number; success: number; failed: number; skipped: number }
    }
  | { event: 'error'; data: { message: string; fatal: boolean } }

export async function subscribeJobEvents(
  jobId: string,
  onEvent: (e: JobEvent) => void,
): Promise<() => void> {
  const base = await getBaseUrl()
  const es = new EventSource(`${base}/api/v1/jobs/${jobId}/events`)
  const names: JobEvent['event'][] = [
    'job-start',
    'item-start',
    'item-progress',
    'item-complete',
    'log',
    'done',
    'error',
  ]
  for (const name of names) {
    es.addEventListener(name, (msg) => {
      try {
        const parsed = JSON.parse((msg as MessageEvent).data)
        onEvent({ event: name, data: parsed } as JobEvent)
      } catch {
        /* malformed payload */
      }
    })
  }
  // MVP: don't rely on the native auto-reconnect — when the server sends
  // `_eof` the stream ends, readyState goes to CLOSED, but an error in
  // between (e.g., network blip) should NOT spawn ghost reconnects.
  es.addEventListener('error', () => {
    if (es.readyState === EventSource.CLOSED) return
    es.close()
  })
  return () => es.close()
}
