import { useEffect, useState } from 'react'
import { api, type HistoryItem } from '../api/client'

export default function History() {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [author, setAuthor] = useState('')
  const [awemeType, setAwemeType] = useState('')
  const [error, setError] = useState<string | null>(null)
  const size = 20

  async function load() {
    try {
      const res = await api.history({
        page,
        size,
        author: author.trim() || undefined,
        aweme_type: awemeType || undefined,
      })
      setItems(res.items)
      setTotal(res.total)
      setError(null)
    } catch (err) {
      setError(String(err))
    }
  }

  useEffect(() => {
    load().catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, author, awemeType])

  const pages = Math.max(1, Math.ceil(total / size))

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">历史</h1>
      <div className="mb-3 flex gap-2">
        <input
          placeholder="按作者筛选"
          className="rounded-md border border-slate-300 px-3 py-1 text-sm"
          value={author}
          onChange={(e) => {
            setPage(1)
            setAuthor(e.target.value)
          }}
        />
        <select
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          value={awemeType}
          onChange={(e) => {
            setPage(1)
            setAwemeType(e.target.value)
          }}
        >
          <option value="">全部类型</option>
          <option value="video">视频</option>
          <option value="note">图文</option>
          <option value="mix">合集</option>
          <option value="music">音乐</option>
        </select>
      </div>
      {error && (
        <div className="mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-600">
            <tr>
              <th className="p-2">作者</th>
              <th className="p-2">标题</th>
              <th className="p-2">类型</th>
              <th className="p-2">发布时间</th>
              <th className="p-2">路径</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.aweme_id} className="border-t border-slate-100">
                <td className="p-2">{it.author_name}</td>
                <td className="p-2 max-w-[320px] truncate">
                  {it.title || '—'}
                </td>
                <td className="p-2">{it.aweme_type}</td>
                <td className="p-2">
                  {it.create_time
                    ? new Date(it.create_time * 1000).toLocaleDateString()
                    : '—'}
                </td>
                <td className="p-2 max-w-[260px] truncate text-xs text-slate-500">
                  {it.file_path}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-slate-400">
                  暂无记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
        <div>共 {total} 条</div>
        <div className="flex items-center gap-2">
          <button
            className="rounded-md border px-2 py-0.5 disabled:opacity-40"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </button>
          <div>
            {page} / {pages}
          </div>
          <button
            className="rounded-md border px-2 py-0.5 disabled:opacity-40"
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  )
}
