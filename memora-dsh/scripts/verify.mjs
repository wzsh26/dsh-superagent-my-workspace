/**
 * R5 · 验收看板：一条命令输出 V0–V9 里可自动判定的部分。
 *
 * 用法：node scripts/verify.mjs
 * 判定基于：llama-server 进程/健康、记忆文件、最近的 Memora 会话日志。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = os.homedir()
const MEMORA = path.join(HOME, '.memora')
const SESSIONS = path.join(HOME, '.dsh', 'sessions')
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const out = []
const line = (s = '') => out.push(s)

function sh(cmd, args) {
  try { return execFileSync(cmd, args).toString().trim() } catch { return '' }
}
const mb = (kb) => (Number(kb) / 1024).toFixed(0)

// ── 1. 模型 ──────────────────────────────────────────────
const pid = sh('pgrep', ['-f', 'llama-server']).split('\n')[0]
const rss = pid ? mb(sh('ps', ['-o', 'rss=', '-p', pid])) : '—'
let health = 'down'
try {
  const r = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(2000) })
  health = (await r.json()).status
} catch {}

const bootAt = pid ? new Date(sh('ps', ['-o', 'lstart=', '-p', pid])).getTime() : Date.now()
let alias = '—'
let chatMs = '—'
try {
  const t = Date.now()
  const r = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen2.5-3b-instruct',
      messages: [{ role: 'user', content: '回一个字：好' }],
      max_tokens: 8,
    }),
    signal: AbortSignal.timeout(20000),
  })
  const j = await r.json()
  alias = j.model || '—'
  chatMs = `${Date.now() - t}ms`
} catch {}

const swap = (() => {
  const m = sh('sysctl', ['-n', 'vm.swapusage']).match(/used = ([\d.]+)M/)
  return m ? `${Number(m[1]).toFixed(0)}MB` : '—'
})()

// ── 2. 记忆文件 ──────────────────────────────────────────
const personaFiles = fs.existsSync(MEMORA)
  ? fs.readdirSync(MEMORA).filter((f) => /^memora-.*\.jsonl$/.test(f))
  : []
const memories = {}
let questionsStored = 0
for (const f of personaFiles) {
  const persona = f.slice('memora-'.length, -'.jsonl'.length)
  const rows = fs.readFileSync(path.join(MEMORA, f), 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
  memories[persona] = rows
  for (const r of rows) if (/([?？]|吗|呢)\s*$/.test(r.text.trim())) questionsStored++
}

// ── 3. 最近的 Memora 会话 ────────────────────────────────
const factTexts = (memories.gentle_senior ?? []).map((r) => r.text)
const sessions = []
if (fs.existsSync(SESSIONS)) {
  for (const ws of fs.readdirSync(SESSIONS)) {
    const wsDir = path.join(SESSIONS, ws)
    if (!fs.statSync(wsDir).isDirectory()) continue
    for (const id of fs.readdirSync(wsDir)) {
      const file = path.join(wsDir, id, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      sessions.push({ id, file, mtime: fs.statSync(file).mtimeMs })
    }
  }
}
sessions.sort((a, b) => b.mtime - a.mtime)

const recent = []
for (const s of sessions.slice(0, 12)) {
  let raw = ''
  try { raw = execFileSync('zstd', ['-dc', s.file]).toString('utf8') } catch { continue }
  let preset = ''
  let createdAt = 0
  const cs = []
  let users = 0
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue
    let e; try { e = JSON.parse(l) } catch { continue }
    if (e.type === 'session') createdAt = e.createdAt ?? 0
    if (e.type === 'agent-preset/selected') preset = e.data.agentPreset
    if (e.type === 'user/message' && e.data.source?.kind === 'user') users++
    if (e.type === 'user/message' && e.data.source?.kind === 'memora') cs.push(e.data.content[0].text)
  }
  if (!preset.startsWith('memora')) continue
  recent.push({ id: s.id.slice(8, 16), preset, turns: users, cs, createdAt })
  if (recent.length >= 6) break
}

// ── 4. 判定 ─────────────────────────────────────────────
const checks = []
const add = (name, ok, detail) => checks.push({ name, ok, detail })

add('V1 推理连通', health === 'ok' && alias !== '—', `health=${health} model=${alias} 首字 ${chatMs}`)
add('V2 插件与预设', recent.length > 0, `最近 ${recent.length} 个 Memora 会话`)
add('V3 落库', Object.values(memories).reduce((n, a) => n + a.length, 0) > 0,
  Object.entries(memories).map(([k, v]) => `${k}=${v.length}`).join(' '))
const hitSessions = recent.filter((s) => s.cs.some((c) => !c.includes('无相关记忆')))
add('V4 跨会话召回', hitSessions.length > 0, `${hitSessions.length}/${recent.length} 个会话有命中`)
const isoOk = recent.filter((s) => s.preset === 'memora-tsundere')
  .every((s) => s.cs.every((c) => !factTexts.some((f) => c.includes(f))))
add('V5 人格隔离', isoOk, '损友会话未出现学姐的事实')
const fresh = recent.filter((s) => s.createdAt >= bootAt)
const legacy = recent.filter((s) => s.createdAt < bootAt)
const questionInC = fresh.flatMap((s) => s.cs).filter((c) =>
  c.split('\n').some((l) => l.startsWith('- ') && /([?？]|吗|呢)\s*$/.test(l.trim())))
add('V6 注入干净', questionsStored === 0 && questionInC.length === 0,
  `问句入库 ${questionsStored} 条 / 重启后 C 层问句 ${questionInC.length} 条` +
    (legacy.length ? `（另有 ${legacy.length} 个修复前会话不计入）` : ''))
add('V7 资源', Number(rss) < 3500 && health === 'ok', `llama RSS ${rss}MB swap ${swap}`)

// V8 只跑规则抽取基线，不依赖 llama-server、不影响对话。
let extractOk = false
let extractDetail = ''
try {
  const raw = execFileSync(process.execPath, ['extract.eval.js'], { cwd: ROOT, timeout: 30_000 }).toString()
  const m = raw.match(/规则命中 (\d+\/\d+).*?负样本 (\d+\/\d+)/)
  extractOk = true
  extractDetail = m ? `${m[1]} · 负样本 ${m[2]}` : '通过'
} catch (err) {
  const raw = `${err?.stdout ?? ''}${err?.stderr ?? ''}`
  const m = raw.match(/规则命中 (\d+\/\d+).*?负样本 (\d+\/\d+)/)
  extractDetail = m ? `${m[1]} · 负样本 ${m[2]}（未达标）` : 'extract.eval.js 失败'
}
add('V8 抽取准确率', extractOk, extractDetail)

// ── 5. 输出 ─────────────────────────────────────────────
line()
line('  Memora 验收（P0 + P1.0）')
line('  ────────────────────────────────────────────────────────────')
for (const c of checks) line(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(14)} ${c.detail}`)
line('  ────────────────────────────────────────────────────────────')
line(`  记忆：${Object.entries(memories).map(([k, v]) => `${k} ${v.length} 条`).join(' · ') || '空'}`)
if (recent.length) {
  line()
  line('  最近会话')
  for (const s of recent) {
    const hits = s.cs.filter((c) => !c.includes('无相关记忆')).length
    line(`    ${s.id}  ${s.preset.padEnd(16)} ${s.turns} 轮  C=${s.cs.length}  命中=${hits}`)
  }
}
line()
console.log(out.join('\n'))
process.exit(checks.every((c) => c.ok) ? 0 : 1)
