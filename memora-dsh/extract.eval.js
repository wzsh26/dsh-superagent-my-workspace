/**
 * P1.0 · 抽取准确率评测
 *
 * 默认只跑规则路径（不依赖 llama-server，可作为 verify.mjs 的固定项）。
 * 加 `--model` 会把「规则判不准 / 与标注不一致」的句子再问一次本地 3B，
 * 只做展示，不改变基线分数。
 *
 * 运行：node extract.eval.js [--model]
 */
import fs from 'node:fs'
import { extractRules, extractWithModel } from './extract.js'

const withModel = process.argv.includes('--model')
const fixtures = JSON.parse(fs.readFileSync(new URL('../p1-extract-fixtures.json', import.meta.url), 'utf8'))
const { match_min, total, negative_pass_min } = fixtures.thresholds

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const show = (a) => (a.length ? a.map((s) => `「${s}」`).join(' + ') : '（无）')
const cjk = (s) => Array.from(String(s)).length

let pass = 0
const rows = []

console.log('\n  P1.0 · 规则抽取 vs 人工标注\n')
for (const c of fixtures.cases) {
  const r = extractRules(c.text)
  const ok = r.confident && same(r.facts, c.facts)
  if (ok) pass++
  rows.push({ ...c, got: r, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${String(c.id).padStart(2)}. ${c.text}`)
  console.log(`       标注 ${show(c.facts)}`)
  if (!ok) console.log(`       实得 ${show(r.facts)}  (${r.confident ? r.reason : `不确信:${r.reason}`})`)
}

let negPass = 0
console.log('\n  负样本（不该产生事实）\n')
for (const n of fixtures.negatives) {
  const r = extractRules(n.text)
  const ok = r.confident && r.facts.length === 0
  if (ok) negPass++
  console.log(`  ${ok ? '✓' : '✗'} ${n.text}  → ${show(r.facts)}  ${n.why}`)
}

if (withModel) {
  const misses = rows.filter((r) => !r.ok).map((r) => r.text)
  if (misses.length) {
    console.log('\n  模型兜底（只展示，不计入基线）\n')
    const out = await extractWithModel(misses)
    if (!out.facts) {
      console.log(`  ✗ 模型不可用/解析失败：${out.error}  (${out.tookMs}ms)`)
    } else {
      misses.forEach((text, i) => {
        console.log(`  · ${text}`)
        console.log(`     模型 ${show(out.facts[i] ?? [])}`)
      })
      console.log(`     用时 ${out.tookMs}ms`)
    }
  }
}

const longest = Math.max(...rows.flatMap((r) => r.facts.map(cjk)), 0)
console.log(`\n  规则命中 ${pass}/${total}（线 ≥${match_min}）  ·  负样本 ${negPass}/${fixtures.negatives.length}（线 ≥${negative_pass_min}）  ·  最长事实 ${longest} 字\n`)

process.exit(pass >= match_min && negPass >= negative_pass_min ? 0 : 1)
