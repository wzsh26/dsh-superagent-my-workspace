/**
 * P1.0 真机 smoke：完整跑一遍 ingest → 入队 → 空闲抽取 → replace。
 *
 * 用临时 MEMORA_HOME，不碰真实的 ~/.memora；需要 llama-server 在 8080。
 * 用法：node scripts/extract-smoke.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-p1-smoke-'))
process.env.MEMORA_HOME = tmp

const { ingest, recall, replace } = await import('../memory.js')
const { createExtractQueue } = await import('../extract.js')

const PERSONA = 'smoke_persona'
const SESSION = 'smoke-session'
const CASES = [
  { tag: 'rules', text: '我下个月要考雅思，最近在备考' },
  { tag: 'model', text: '我养了一只猫叫豆豆，它今年三岁' },
  { tag: 'model', text: '今天上班的时候老板又临时改需求搞得我整个下午都在返工真的烦死了' },
]

const t0 = process.hrtime.bigint()
const ids = []
for (const c of CASES) {
  const r = ingest({ persona: PERSONA, session: SESSION, text: c.text })
  ids.push(r.id)
}
const enqueueMs = Number(process.hrtime.bigint() - t0) / 1e6

const queue = createExtractQueue({
  replace,
  idleDelayMs: 10,
  timeoutMs: 30_000,
  logger: { debug: (m) => console.log(`  · ${m}`), warn: (m) => console.log(`  ! ${m}`) },
})
CASES.forEach((c, i) => queue.enqueue({ persona: PERSONA, id: ids[i], session: SESSION, text: c.text }))
const tEnqueue = Number(process.hrtime.bigint() - t0) / 1e6

console.log(`\n  入队额外延迟 ${enqueueMs.toFixed(2)}ms（含 ${CASES.length} 次 ingest + enqueue）`)
console.log(`  入队完成 ${tEnqueue.toFixed(2)}ms，等待空闲抽取…\n`)

const started = Date.now()
queue.onIdle()
const drained = await queue.drain(45_000)
if (!drained) console.log('  ! 抽取队列在 45s 内没有跑完（模型超时？）')

const rows = fs
  .readFileSync(path.join(tmp, `memora-${PERSONA}.jsonl`), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))

console.log(`\n  抽取后 ${rows.length} 条（原句 3 条）用时 ${Date.now() - started}ms\n`)
for (const c of CASES) {
  const replaced = !rows.some((r) => r.text === c.text)
  console.log(`  ${replaced ? '✓' : '·'} [${c.tag}] ${c.text}`)
}
console.log('\n  最终事实：')
for (const r of rows) console.log(`    #${String(r.id).padStart(2)} ${r.text}`)

console.log('\n  抽完后召回（模拟下一轮）：')
for (const q of ['我之前提过雅思的事吗', '我家猫叫什么', '老板最近又改需求了吗']) {
  const r = recall({ persona: PERSONA, session: 'next-turn', query: q })
  console.log(`  ${r.hit ? '✓' : '✗'} 「${q}」 → ${r.memories[0]?.text ?? '（无）'}`)
}
console.log(`\n  临时目录：${tmp}\n`)

const left = queue.pending
queue.dispose()
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(left === 0 ? 0 : 1)
