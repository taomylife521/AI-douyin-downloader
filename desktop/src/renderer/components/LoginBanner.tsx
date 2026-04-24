import { useEffect } from 'react'
import { api } from '../api/client'
import { useAppStore } from '../store'

export default function LoginBanner() {
  const loggedIn = useAppStore((s) => s.loggedIn)
  const setLoggedIn = useAppStore((s) => s.setLoggedIn)

  useEffect(() => {
    api
      .cookiesStatus()
      .then((s) => setLoggedIn(s.logged_in))
      .catch(() => {})
    const unsub = window.api.onCookiesChanged(async () => {
      try {
        const s = await api.cookiesStatus()
        setLoggedIn(s.logged_in)
      } catch {
        /* ignore */
      }
    })
    return () => unsub()
  }, [setLoggedIn])

  if (loggedIn) return null
  return (
    <div className="mb-4 flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
      <div className="text-sm text-amber-900">
        尚未登录抖音，部分功能（如用户批量下载）需要登录后才能使用。
      </div>
      <button
        className="rounded-md bg-amber-600 px-3 py-1 text-sm text-white hover:bg-amber-700"
        onClick={() => window.api.openLoginWindow()}
      >
        登录
      </button>
    </div>
  )
}
