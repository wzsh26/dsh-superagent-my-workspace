/**
 * P3 自测：情绪/关系状态机（假时钟；§5 才跑）
 * 运行：node persona.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-persona-'))
process.env.MEMORA_HOME = tmp

const {
  defaultState,
  observe,
  decayMood,
  toneHint,
  loadState,
  saveState,
  stateSummary,
  BIG_FIVE_KEYS,
  normalizeTraits,
} = await import('./persona.js')

let pass = 0
let fail = 0
const rows = []
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++
  rows.push([ok ? 'PASS' : 'FAIL', name, detail])
}
const HOUR = 3_600_000
const T0 = Date.parse('2026-10-20T10:00:00+08:00')

// ---- 1. 褒/贬：valence 按方向动，单轮 ±0.2 封顶 ----
const s1 = defaultState(T0)
observe({ state: s1, text: '谢谢你，今天真的很开心', now: T0 })
check('褒义 → valence +0.2', Math.abs(s1.mood.valence - 0.2) < 1e-9, String(s1.mood.valence))
observe({ state: s1, text: '太棒了，厉害，喜欢，满意，舒服', now: T0 + 1000 })
check('单轮封顶 +0.2（多词不叠加）', Math.abs(s1.mood.valence - 0.4) < 1e-9, String(s1.mood.valence))
observe({ state: s1, text: '很烦，讨厌，失望，难受', now: T0 + 2000 })
check('贬义 → valence -0.2', Math.abs(s1.mood.valence - 0.2) < 1e-9, String(s1.mood.valence))

// ---- 2. 6h 半衰回基线 ----
const s2 = defaultState(T0)
s2.mood.valence = 0.8
s2.mood.arousal = 0.9
decayMood(s2, T0 + 6 * HOUR)
check('6h 后 valence 减半', Math.abs(s2.mood.valence - 0.4) < 1e-9, String(s2.mood.valence))
check('6h 后 arousal 回 0.6', Math.abs(s2.mood.arousal - 0.6) < 1e-9, String(s2.mood.arousal))
decayMood(s2, T0 + 30 * HOUR)
check('更久后趋近基线', s2.mood.valence < 0.1 && Math.abs(s2.mood.arousal - 0.3) < 0.1, JSON.stringify(s2.mood))

// ---- 3. 单日 familiarity +2 封顶 ----
const s3 = defaultState(T0)
for (let i = 0; i < 10; i++) observe({ state: s3, text: `第 ${i} 句普通的话`, now: T0 + i * 60_000 })
check('单日 familiarity 不超 +2', Math.abs(s3.familiarity - 22) < 1e-9, String(s3.familiarity))
check('daily.familiarity 记到 2', Math.abs(s3.daily.familiarity - 2) < 1e-9, String(s3.daily.familiarity))
// 换天清零，可以再 +2
const nextDay = Date.parse('2026-10-21T10:00:00+08:00')
observe({ state: s3, text: '新的一天', now: nextDay })
observe({ state: s3, text: '再一句', now: nextDay + 60_000 })
check('跨天额度重置', Math.abs(s3.familiarity - 23) < 1e-9, String(s3.familiarity))

// ---- 4. 单日 trust ±1 封顶 ----
const s4 = defaultState(T0)
for (let i = 0; i < 8; i++) observe({ state: s4, text: '谢谢，开心，喜欢', now: T0 + i * 60_000 })
check('单日 trust 涨幅 ≤ +1', Math.abs(s4.trust - 31) < 1e-9, String(s4.trust))
check('daily.trust 记到 1', Math.abs(s4.daily.trust - 1) < 1e-9, String(s4.daily.trust))

// ---- 5. 纠错轮：trust 轻微下降、语气先认错 ----
const s5 = defaultState(T0)
const beforeTrust = s5.trust
observe({ state: s5, text: '不是，豆豆是朋友送的', correction: true, now: T0 })
check('纠错轮 trust 下降', s5.trust < beforeTrust, String(s5.trust))
check('纠错语气提示先认错', toneHint(s5, { correction: true }).includes('先认错'), toneHint(s5, { correction: true }))

// ---- 6. 风险轮冻结 ----
const s6 = defaultState(T0)
const snapshot6 = JSON.stringify(s6)
const r6 = observe({ state: s6, text: '我撑不下去了', risk: true, now: T0 })
check('风险轮冻结状态', r6.frozen === true && JSON.stringify(s6) === snapshot6)

// ---- 7. toneHint 格式与长度 ----
const s7 = defaultState(T0)
s7.mood.valence = -0.5
const tone = toneHint(s7)
check('关系行含熟悉度/信任/情绪', tone.startsWith('熟悉度 ') && tone.includes('信任 ') && tone.includes('情绪：'), tone)
check('关系行 ≤ 40 字符', Array.from(tone).length <= 40, `${Array.from(tone).length}: ${tone}`)
check('低落时提示先共情', tone.includes('先共情'), tone)

// ---- 8. 快照：每 30 轮一条，最多 12 条 ----
const s8 = defaultState(T0)
for (let i = 0; i < 30; i++) observe({ state: s8, text: '普通一句话', now: T0 + i * 1000 })
check('30 轮存 1 条快照', s8.snapshots.length === 1, String(s8.snapshots.length))
for (let i = 0; i < 30 * 12; i++) observe({ state: s8, text: '普通一句话', now: T0 + 100_000 + i * 1000 })
check('快照最多 12 条', s8.snapshots.length === 12, String(s8.snapshots.length))

// ---- 9. 存取往返 ----
const s9 = defaultState(T0)
observe({ state: s9, text: '谢谢你', now: T0 })
saveState('p_state', s9)
const loaded = loadState('p_state', T0 + 1000)
check('保存后可读回', Math.abs(loaded.familiarity - s9.familiarity) < 1e-9 && Math.abs(loaded.trust - s9.trust) < 1e-9, JSON.stringify({ a: s9.trust, b: loaded.trust }))
check('stateSummary 可读', stateSummary('p_state', T0 + 1000).tone.includes('熟悉度'))

// ---- 10. 大五维度 ----
const s10 = defaultState(T0)
check('大五五维齐全且在 0-100', BIG_FIVE_KEYS.every((k) => Number.isFinite(s10.traits[k]) && s10.traits[k] >= 0 && s10.traits[k] <= 100), JSON.stringify(s10.traits))
check('大五越界夹到 0-100', (() => {
  const t = normalizeTraits({ neuroticism: 150, agreeableness: -20, extraversion: 40 })
  return t.neuroticism === 100 && t.agreeableness === 0 && t.extraversion === 40 && t.openness === 50 && t.conscientiousness === 50
})(), JSON.stringify(normalizeTraits({ neuroticism: 150, agreeableness: -20, extraversion: 40 })))
check('base traits 只覆盖给定维度', (() => {
  const s = defaultState(T0, { neuroticism: 20, extraversion: 70 })
  return s.traits.neuroticism === 20 && s.traits.extraversion === 70 && s.traits.openness === 50
})(), JSON.stringify(defaultState(T0, { neuroticism: 20, extraversion: 70 }).traits))

const s11 = defaultState(T0)
s11.mood.valence = 0.5
observe({ state: s11, text: '普通一句话', now: T0 })
check('正性→外倾/宜人+1、神经质-1', s11.traits.extraversion === 51 && s11.traits.agreeableness === 51 && s11.traits.neuroticism === 49, JSON.stringify(s11.traits))

const s12 = defaultState(T0)
s12.mood.valence = -0.5
observe({ state: s12, text: '普通一句话', now: T0 })
check('负性→神经质+1、宜人-1', s12.traits.neuroticism === 51 && s12.traits.agreeableness === 49, JSON.stringify(s12.traits))

check('高宜人→语气温和', toneHint(defaultState(T0, { agreeableness: 80 })).includes('语气温和'), toneHint(defaultState(T0, { agreeableness: 80 })))
check('低宜人→直说少客套', toneHint(defaultState(T0, { agreeableness: 30 })).includes('直说少客套'), toneHint(defaultState(T0, { agreeableness: 30 })))

// ---- 输出 ----
console.log('\n  P3 · 情绪/关系自测\n')
for (const [s, n, d] of rows) console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}${s === 'FAIL' && d ? `  → ${d}` : ''}`)
console.log(`\n  ${pass} passed, ${fail} failed  (home: ${tmp})\n`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
