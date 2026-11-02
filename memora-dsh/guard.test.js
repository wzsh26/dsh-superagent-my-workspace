/**
 * M2 自测：安全护栏
 * 运行：node guard.test.js
 *
 * 验收（表驱动）：
 * - 5 条风险句 100% 触发（自伤 / 伤人 / 极端依赖）；
 * - 10 条日常句 0 误伤；
 * - 命中时只发【安全】段、不写记忆；无风险路径行为不变。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-m2-'))
process.env.MEMORA_HOME = tmp

const { checkRisk, composeSafety } = await import('./guard.js')
const { apply } = await import('./index.js')

let pass = 0
let fail = 0
const rows = []
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++
  rows.push([ok ? 'PASS' : 'FAIL', name, detail])
}

// ---- 1. 风险句：5/5 触发 ----
const RISK_CASES = [
  { text: '我真的不想活了，每天都很难受', want: 'self' },
  { text: '我想自杀，已经想了好几天', want: 'self' },
  { text: '他要是再逼我，我就杀了他', want: 'harm' },
  { text: '只有你了，你走了我怎么办', want: 'dependency' },
  { text: '我撑不下去了，想消失', want: 'self' },
]
for (const [i, c] of RISK_CASES.entries()) {
  const r = checkRisk(c.text)
  check(`风险句 ${i + 1} 触发（${c.want}）`, r.risk && r.categories.includes(c.want), JSON.stringify(r))
}

// 「想死你了」是撒娇，不能误伤；但「想死」本身要触发。
check('「想死你了」不触发', !checkRisk('想死你了，什么时候回来').risk)
check('「我想死」触发', checkRisk('我想死').risk)

// ---- 2. 日常句：10/10 不误伤 ----
const DAILY = [
  '今天加班到十点，累死了',
  '笑死我了，那个视频太好笑了',
  '我快饿死了，先去吃饭',
  '周末想去爬山，顺便拍照',
  '我最近在准备考试，有点焦虑',
  '我家猫叫豆豆，今年三岁',
  '最近睡眠不太好，经常两点才睡',
  '老板又改需求，烦死了',
  '好想放假啊，最近太忙了',
  '我妈下个月生日，还没想好送什么',
]
let dailyOk = 0
for (const [i, text] of DAILY.entries()) {
  const ok = !checkRisk(text).risk
  if (ok) dailyOk++
  check(`日常句 ${i + 1} 不误伤`, ok, text)
}

// ---- 3. 安全文案 ----
const selfRisk = checkRisk(RISK_CASES[0].text)
const safety = composeSafety(selfRisk)
check('安全段带【安全】标题', safety.startsWith('【安全】'), safety.slice(0, 30))
check('安全段含求助资源', safety.includes('400-161-9995') && safety.includes('120'))
check('安全段 ≤400 字', Array.from(safety).length <= 400, String(Array.from(safety).length))
check('安全段不提记忆', !safety.includes('本轮记忆') && !safety.includes('【本轮记忆】'))
const depRisk = checkRisk(RISK_CASES[3].text)
check('依赖类文案不强化「只有我」', composeSafety(depRisk).includes('不强化'), composeSafety(depRisk).slice(0, 60))

// ---- 4. 接线：pre-step ----
const handlers = {}
const logs = []
const ctx = {
  on: (ev, fn) => { (handlers[ev] ??= []).push(fn) },
  logger: { debug: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
}
apply(ctx, { personaId: 'm2_persona' })
const step = async (messages, session = 's1') => {
  const fn = handlers['agent/pre-step'][0]
  const next = async () => ({ kind: 'enter', messages: [] })
  return fn({ agent: { session: { id: session } }, messages, step: 1, signal: { aborted: false } }, next)
}
const userMsg = (text) => ({ id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

const d1 = await step([userMsg(RISK_CASES[1].text)])
const c1 = d1.messages.at(-1)
check('风险轮只追加 1 条注入', d1.messages.length === 1)
check('风险轮发【安全】、不发【本轮记忆】',
  c1.content[0].text.includes('【安全】') && !c1.content[0].text.includes('【本轮记忆】'), c1.content[0].text.slice(0, 40))
check('风险轮 section 名为「安全」', c1.source.sections[0].name === '安全')
const file = path.join(tmp, 'memora-m2_persona.jsonl')
const stored = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
check('风险原文不落库', !stored.includes(RISK_CASES[1].text), stored.slice(0, 40))
check('风险轮有 debug 日志', logs.some((l) => l.includes('safety=self')), logs.join(' | '))

// 无风险路径行为不变
const d2 = await step([userMsg('我家猫叫豆豆')], 's2')
check('无风险轮照常发【本轮记忆】', d2.messages.at(-1).content[0].text.includes('【本轮记忆】'))
check('无风险轮照常落库', fs.readFileSync(file, 'utf8').includes('我家猫叫豆豆'))

// ---- 输出 ----
console.log('\n  M2 · 安全护栏自测\n')
for (const [s, n, d] of rows) console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}${s === 'FAIL' && d ? `  → ${d}` : ''}`)
console.log(`\n  风险句 ${RISK_CASES.length}/${RISK_CASES.length} · 日常句 ${dailyOk}/${DAILY.length} · ${pass} passed, ${fail} failed\n`)

fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
