#!/usr/bin/env node
// Spawn Vite dev server + build Main + launch Electron, wired together.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(here, '..')

function run(cmd, args, opts = {}) {
  const c = spawn(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: desktopDir,
    ...opts,
  })
  c.on('exit', (code) => {
    if (code && code !== 0) process.exit(code)
  })
  return c
}

// 1. Start Vite dev server (non-blocking).
const vite = run('npx', ['vite'])

// 2. Give Vite a moment to bind 5173.
await new Promise((r) => setTimeout(r, 1500))

// 3. Start TSC in watch mode to compile Main / Preload.
run('npx', ['tsc', '-p', 'tsconfig.node.json', '--watch'])

// 4. After TSC produces initial output, launch Electron.
await new Promise((r) => setTimeout(r, 2500))
run('npx', ['electron', '.'])

process.on('SIGINT', () => {
  vite.kill()
  process.exit(0)
})
