let baseUrl: string | null = null

export async function getBaseUrl(): Promise<string> {
  if (baseUrl) return baseUrl
  const info = await window.api.getSidecarInfo()
  baseUrl = `http://127.0.0.1:${info.port}`
  return baseUrl
}

async function request<T>(pathname: string, init?: RequestInit): Promise<T> {
  const base = await getBaseUrl()
  const r = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!r.ok) {
    const body = await r.text()
    throw new Error(`${init?.method ?? 'GET'} ${pathname} → ${r.status}: ${body}`)
  }
  return (await r.json()) as T
}

export interface JobResponse {
  job_id: string
  status: string
  url: string
}
export interface JobDetail {
  job_id: string
  status: string
  url: string
  total: number
  success: number
  failed: number
  skipped: number
  error: string | null
}
export interface CookiesStatus {
  logged_in: boolean
  sec_uid?: string
}
export interface SettingsShape {
  path: string
  thread: number
  rate_limit: number
}
export interface HistoryItem {
  aweme_id: string
  aweme_type: string
  title: string
  author_id: string
  author_name: string
  create_time: number
  download_time: number
  file_path: string
}
export interface HistoryPage {
  total: number
  page: number
  size: number
  items: HistoryItem[]
}

export interface DownloadRequestBody {
  url: string
  mode?: Array<'post' | 'like' | 'mix' | 'music'>
  start_time?: string
  end_time?: string
  number?: { post?: number; like?: number; mix?: number; music?: number }
  increment?: boolean
  output_dir?: string
}

export const api = {
  health: () => request<{ status: string }>('/api/v1/health'),
  cookiesStatus: () => request<CookiesStatus>('/api/v1/cookies/status'),
  submitDownload: (body: DownloadRequestBody) =>
    request<JobResponse>('/api/v1/download', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getJob: (id: string) => request<JobDetail>(`/api/v1/jobs/${id}`),
  cancelJob: (id: string) =>
    request<{ ok: boolean }>(`/api/v1/jobs/${id}/cancel`, { method: 'POST' }),
  getSettings: () => request<SettingsShape>('/api/v1/settings'),
  patchSettings: (patch: Partial<SettingsShape>) =>
    request<SettingsShape>('/api/v1/settings', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  history: (params: {
    page?: number
    size?: number
    author?: string
    aweme_type?: string
  }) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v))
    }
    const q = qs.toString()
    return request<HistoryPage>(`/api/v1/history${q ? `?${q}` : ''}`)
  },
}
