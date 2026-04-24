import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { SidecarInfo } from '../shared/types'

let child: ChildProcess | null = null
let info: SidecarInfo | null = null
const stderrRing: string[] = []
const STDERR_RING_SIZE = 200

const READY_RE = /^DOUYIN_SIDECAR_READY port=(\d+) pid=(\d+)$/

export function parseReadyMarker(line: string): SidecarInfo | null {
  const m = READY_RE.exec(line)
  if (!m) return null
  const port = Number(m[1])
  const pid = Number(m[2])
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null
  return { port, pid }
}

function sidecarBinaryPath(): string {
  const platform = process.platform // 'darwin' | 'win32'
  const arch = process.arch // 'x64' | 'arm64'
  const exe = platform === 'win32' ? 'douyin-dl-sidecar.exe' : 'douyin-dl-sidecar'
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'sidecar', `${platform}-${arch}`, exe)
  }
  return path.join(
    __dirname,
    '..',
    '..',
    'resources',
    'sidecar',
    `${platform}-${arch}`,
    exe,
  )
}

function runPythonFallback(): ChildProcess {
  // Dev fallback: run `python -m cli.main --serve` from repo root.
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const py = process.env.DOUYIN_PY || 'python3'
  return spawn(py, ['-m', 'cli.main', '--serve', '--serve-port', '0'], {
    cwd: repoRoot,
    env: { ...process.env, PYTHONPATH: repoRoot },
  })
}

export async function startSidecar(): Promise<SidecarInfo> {
  if (info) return info

  const bin = sidecarBinaryPath()
  const usePython =
    process.env.DOUYIN_USE_PY === '1' ||
    (!app.isPackaged && !fs.existsSync(bin))

  child = usePython ? runPythonFallback() : spawn(bin, ['--serve', '--serve-port', '0'], {})

  child.stderr?.on('data', (buf: Buffer) => {
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    for (const ln of lines) {
      stderrRing.push(ln)
      if (stderrRing.length > STDERR_RING_SIZE) stderrRing.shift()
    }
  })

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(
            `sidecar did not become ready in 30s; stderr:\n${stderrRing.slice(-10).join('\n')}`,
          ),
        ),
      30_000,
    )
  })

  const ready = new Promise<SidecarInfo>((resolve, reject) => {
    let buf = ''
    child!.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let idx: number
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        const parsed = parseReadyMarker(line)
        if (parsed) {
          resolve(parsed)
          return
        }
      }
    })
    child!.on('exit', (code) =>
      reject(
        new Error(
          `sidecar exited before ready (code=${code}); stderr:\n${stderrRing.slice(-10).join('\n')}`,
        ),
      ),
    )
  })

  info = await Promise.race([ready, timeout])
  return info
}

export async function stopSidecar(): Promise<void> {
  if (!child) return
  const c = child
  child = null
  info = null
  c.removeAllListeners()
  try {
    c.kill('SIGTERM')
    const t = setTimeout(() => c.kill('SIGKILL'), 3000)
    await new Promise<void>((r) =>
      c.once('exit', () => {
        clearTimeout(t)
        r()
      }),
    )
  } catch {
    /* already exited */
  }
}

export function getSidecarInfo(): SidecarInfo {
  if (!info) throw new Error('sidecar not started')
  return info
}
