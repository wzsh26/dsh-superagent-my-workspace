/**
 * Memora runtime supervisor
 *
 * Mounted once at the profile (host) layer. On load it checks the local
 * llama.cpp server; if it is not running, it spawns it and waits for /health.
 * On dispose it stops only the process it spawned (an externally managed
 * server, e.g. a LaunchAgent, is left alone).
 */

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'memora-runtime'

const DEFAULTS = {
  autoStart: true,
  binary: '/opt/homebrew/bin/llama-server',
  modelPath: join(homedir(), '.memora', 'models', 'qwen2.5-3b-instruct-q4_k_m.gguf'),
  port: 8080,
  contextSize: 8192,
  alias: 'qwen2.5-3b-instruct',
  extraArgs: [],
}

async function healthy(port, timeoutMs = 800) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function spawnServer(cfg) {
  const logPath = join(homedir(), '.memora', 'llama.log')
  mkdirSync(dirname(logPath), { recursive: true })
  const fd = openSync(logPath, 'a')
  const args = [
    '-m', cfg.modelPath,
    '-c', String(cfg.contextSize),
    '-ngl', '99',
    '-fa',
    '--jinja',
    '--no-webui',
    '--host', '127.0.0.1',
    '--port', String(cfg.port),
    '--alias', cfg.alias,
    ...(Array.isArray(cfg.extraArgs) ? cfg.extraArgs : []),
  ]
  const child = spawn(cfg.binary, args, { stdio: ['ignore', fd, fd] })
  closeSync(fd)
  child.on('exit', (code, signal) => {
    console.log(`[memora-runtime] llama-server exited code=${code} signal=${signal}`)
  })
  child.on('error', (error) => {
    console.error(`[memora-runtime] spawn failed: ${error.message}`)
  })
  return child
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (!cfg.autoStart) {
    console.log('[memora-runtime] autoStart=false, skip')
    return
  }

  let child = null
  let disposed = false

  const start = async () => {
    if (await healthy(cfg.port)) {
      console.log(`[memora-runtime] already running on ${cfg.port}`)
      return
    }
    if (disposed) return
    console.log(`[memora-runtime] starting ${cfg.binary}`)
    child = spawnServer(cfg)
    const deadline = Date.now() + 30000
    while (!disposed && Date.now() < deadline) {
      if (await healthy(cfg.port)) {
        console.log(`[memora-runtime] ready on ${cfg.port}`)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (!disposed) console.error('[memora-runtime] health check timed out')
  }

  start()

  ctx.effect(() => () => {
    disposed = true
    if (child && !child.killed) {
      console.log('[memora-runtime] stopping llama-server')
      child.kill('SIGTERM')
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
      }, 5000)
    }
  }, 'memora.runtime')
}
