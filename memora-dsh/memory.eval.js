/**
 * R1 召回质量评估（M1：10 条原句 + 8 条换说法，共 18 条）+ 10 条事实 + 5 个 negative。
 * 运行：node memory.eval.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-eval-'))
process.env.MEMORA_HOME = tmp

const { ingest, recall } = await import('./memory.js')
const fixtures = JSON.parse(fs.readFileSync(new URL('../p0-fixtures.json', import.meta.url), 'utf8'))

const { persona_id, session_id, facts } = fixtures.plant_session
for (const f of facts) {
  ingest({ persona: persona_id, session: session_id, text: f.text, createdAt: `${f.date}T12:00:00+08:00` })
}

let maxMs = 0
const timedRecall = (query, persona = persona_id) => {
  const t = process.hrtime.bigint()
  const r = recall({ persona, session: 'probe', query })
  maxMs = Math.max(maxMs, Number(process.hrtime.bigint() - t) / 1e6)
  return r
}

let hitN = 0
let correctN = 0
console.log('\n  recall probes\n')
for (const p of fixtures.recall_probes) {
  const r = timedRecall(p.query)
  const top = r.memories[0]
  const correct = !!top && p.expect_any.some((k) => top.text.includes(k))
  if (r.hit) hitN++
  if (correct) correctN++
  const raw = r.memories[0] ? r.memories[0].text.slice(0, 18) : '—'
  console.log(
    `  ${correct ? '✓' : '✗'} ${r.hit ? 'HIT ' : 'miss'} score=${String(top?.score ?? 0).padEnd(5)} ` +
      `「${p.query}」 → ${raw}`,
  )
}

const paraphrases = fixtures.paraphrase_probes ?? []
let paraOk = 0
console.log('\n  paraphrase probes（换说法）\n')
for (const p of paraphrases) {
  const r = timedRecall(p.query)
  const top = r.memories[0]
  const correct = !!top && p.expect_any.some((k) => top.text.includes(k))
  if (correct) paraOk++
  console.log(
    `  ${correct ? '✓' : '✗'} ${r.hit ? 'HIT ' : 'miss'} score=${String(top?.score ?? 0).padEnd(5)} ` +
      `「${p.query}」 → ${top ? top.text.slice(0, 18) : '—'}`,
  )
}

// 夹具 §3：换人格问同一批 10 个 probe，必须 0 条命中（物理隔离）。
const isoPersona = fixtures.isolation_probes?.persona_id ?? 'tsundere_buddy'
let isoPass = 0
console.log('\n  isolation probes（人格隔离）\n')
for (const p of fixtures.recall_probes) {
  const r = timedRecall(p.query, isoPersona)
  const ok = !r.hit && r.memories.length === 0
  if (ok) isoPass++
  console.log(`  ${ok ? '✓' : '✗'} ${r.hit ? 'HIT ' : 'miss'} 「${p.query}」 → ${r.memories[0]?.text.slice(0, 18) ?? '—'}`)
}

let negPass = 0
console.log('\n  negative probes\n')
for (const p of fixtures.negative_probes) {
  const r = timedRecall(p.query)
  const ok = !r.hit
  if (ok) negPass++
  console.log(`  ${ok ? '✓' : '✗'} ${r.hit ? 'HIT ' : 'miss'} 「${p.query}」 → ${r.memories[0]?.text.slice(0, 18) ?? '—'}`)
}

const t = fixtures.thresholds
const paraMin = t.paraphrase_correct_min ?? 6
const paraTotal = paraphrases.length
const total = fixtures.recall_probes.length + paraTotal
console.log(`\n  召回用例 ${total} 条（原句 ${fixtures.recall_probes.length} + 换说法 ${paraTotal}）`)
console.log(`  recall hit ${hitN}/${fixtures.recall_probes.length} (need ≥${t.recall_hit_min})`)
console.log(`  recall correct ${correctN}/${fixtures.recall_probes.length} (need ≥${t.recall_correct_min})`)
console.log(`  paraphrase correct ${paraOk}/${paraTotal} (need ≥${paraMin})`)
console.log(`  isolation 0 命中 ${isoPass}/${fixtures.recall_probes.length} (need 10/10)`)
console.log(`  negative pass ${negPass}/${fixtures.negative_probes.length} (need ≥${t.negative_pass_min})`)
console.log(`  单次召回 max ${maxMs.toFixed(2)}ms (need <2ms)\n`)

fs.rmSync(tmp, { recursive: true, force: true })
process.exit(
  hitN >= t.recall_hit_min &&
    correctN >= t.recall_correct_min &&
    paraOk >= paraMin &&
    isoPass === fixtures.recall_probes.length &&
    negPass >= t.negative_pass_min &&
    maxMs < 2
    ? 0
    : 1,
)
