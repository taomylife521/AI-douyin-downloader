import { useEffect, useState } from 'react'
import { api, type SettingsShape } from '../api/client'

export default function Settings() {
  const [s, setS] = useState<SettingsShape | null>(null)
  const [version, setVersion] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    api.getSettings().then(setS).catch(console.error)
    window.api.getAppVersion().then(setVersion).catch(() => {})
  }, [])

  async function pick() {
    const p = await window.api.chooseDirectory()
    if (p && s) setS({ ...s, path: p })
  }

  async function save() {
    if (!s) return
    setSaving(true)
    setMsg(null)
    try {
      const next = await api.patchSettings({
        path: s.path,
        thread: s.thread,
        rate_limit: s.rate_limit,
      })
      setS(next)
      setMsg('已保存')
    } catch (e) {
      setMsg(String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!s) return <div>加载中...</div>
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">设置</h1>
      <div className="max-w-xl space-y-4 rounded-md border border-slate-200 bg-white p-5">
        <label className="block text-sm">
          <span className="mb-1 block text-slate-700">下载保存目录</span>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
              value={s.path}
              onChange={(e) => setS({ ...s, path: e.target.value })}
            />
            <button
              className="rounded-md border px-3 py-2 text-sm hover:bg-slate-50"
              onClick={pick}
            >
              选择...
            </button>
          </div>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-slate-700">并发下载数</span>
          <input
            type="number"
            min={1}
            max={32}
            className="w-32 rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={s.thread}
            onChange={(e) => setS({ ...s, thread: Number(e.target.value) })}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-slate-700">速率限制（请求/秒）</span>
          <input
            type="number"
            min={0}
            step="0.5"
            className="w-32 rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={s.rate_limit}
            onChange={(e) =>
              setS({ ...s, rate_limit: Number(e.target.value) })
            }
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
            disabled={saving}
            onClick={save}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          {msg && <span className="text-xs text-slate-500">{msg}</span>}
        </div>
      </div>
      <div className="mt-6 text-xs text-slate-400">版本 v{version || '?'}</div>
    </div>
  )
}
