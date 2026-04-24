import { BrowserWindow, session } from 'electron'
import { getSidecarInfo } from './sidecar'

const DOUYIN_URL = 'https://www.douyin.com/'
const REQUIRED = ['sessionid_ss', 'ttwid', 'passport_csrf_token'] as const
const PARTITION = 'persist:douyin-login'

type ECookie = {
  name: string
  value: string
  domain?: string
  expirationDate?: number
}

export function mergeCookieArrays(...arrs: ECookie[][]): Record<string, string> {
  const best = new Map<string, ECookie>()
  for (const arr of arrs) {
    for (const c of arr) {
      const prev = best.get(c.name)
      if (!prev || (c.expirationDate ?? 0) >= (prev.expirationDate ?? 0)) {
        best.set(c.name, c)
      }
    }
  }
  const out: Record<string, string> = {}
  for (const [k, v] of best) out[k] = v.value
  return out
}

export function hasRequiredCookies(cookies: Record<string, string>): boolean {
  return REQUIRED.every((k) => !!cookies[k])
}

async function collectCookies(sess: Electron.Session): Promise<Record<string, string>> {
  const [a, b, c] = await Promise.all([
    sess.cookies.get({ domain: '.douyin.com' }),
    sess.cookies.get({ domain: '.iesdouyin.com' }),
    sess.cookies.get({ domain: 'www.douyin.com' }),
  ])
  return mergeCookieArrays(
    a as unknown as ECookie[],
    b as unknown as ECookie[],
    c as unknown as ECookie[],
  )
}

async function postCookiesToSidecar(cookies: Record<string, string>): Promise<void> {
  const { port } = getSidecarInfo()
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies }),
  })
  if (!r.ok) throw new Error(`POST /cookies failed: ${r.status}`)
}

export async function openLoginWindow(
  parent: BrowserWindow | undefined,
  onCookiesReady: () => void,
): Promise<void> {
  const sess = session.fromPartition(PARTITION)
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    parent,
    modal: false,
    title: '登录抖音',
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  await win.loadURL(DOUYIN_URL)

  let captured = false
  let inFlight: Promise<void> | null = null
  const listener = (): void => {
    if (captured || inFlight) return
    inFlight = (async () => {
      const cookies = await collectCookies(sess)
      if (captured || !hasRequiredCookies(cookies)) return
      captured = true
      try {
        await postCookiesToSidecar(cookies)
        onCookiesReady()
      } catch (err) {
        console.error('post cookies failed', err)
      }
      if (!win.isDestroyed()) win.close()
    })().finally(() => {
      inFlight = null
    })
  }
  sess.cookies.on('changed', listener)

  win.on('closed', () => {
    try {
      sess.cookies.off('changed', listener as never)
    } catch {
      /* ignore */
    }
  })
}
