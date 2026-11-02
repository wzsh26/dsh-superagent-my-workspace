/**
 * R2 自测：插件接线（不启动 DSH，直接模拟 pre-step  waterfall）
 * 运行：node index.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-r2-'))
process.env.MEMORA_HOME = tmp

const { apply, composeC } = await import('./index.js')

let pass = 0
let fail = 0
const rows = []
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++
  rows.push([ok ? 'PASS' : 'FAIL', name, detail])
}

function makeCtx(config) {
  const handlers = {}
  const logs = []
  const ctx = {
    on: (ev, fn) => { (handlers[ev] ??= []).push(fn) },
    logger: { debug: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
  }
  apply(ctx, config)
  return { ctx, handlers, logs }
}

const userMsg = (text) => ({ id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

async function step(handlers, messages, { session = 's1', stepNo = 1, decision } = {}) {
  const next = async () => decision ?? { kind: 'enter', messages: [] }
  const fn = handlers['agent/pre-step'][0]
  return fn({ agent: { session: { id: session } }, messages, step: stepNo, signal: { aborted: false } }, next)
}

const { handlers, logs } = makeCtx({ personaId: 'p_gentle' })

// ---- 1. 第一轮：无记忆 ----
const d1 = await step(handlers, [userMsg('我下个月要考雅思')])
const c1 = d1.messages.at(-1)
check('第一轮追加 1 条消息', d1.messages.length === 1)
check('无命中时发「无相关记忆」', c1.content[0].text.includes('无相关记忆'), c1.content[0].text.slice(0, 20))
check('source 是 snapshot', c1.source.kind === 'memora' && c1.source.form === 'snapshot')
check('sections 结构合法', Array.isArray(c1.source.sections) && c1.source.sections[0].name && typeof c1.source.sections[0].text === 'string')
check('消息 id 唯一', typeof c1.id === 'string' && c1.id.length > 10)

// ---- 2. 新会话：命中 ----
const d2 = await step(handlers, [userMsg('我之前提过考雅思的事吗')], { session: 's2' })
const c2 = d2.messages.at(-1).content[0].text
check('新会话命中旧事实', c2.includes('雅思'), c2.replace(/\n/g, ' | '))

// ---- 3. step !== 1 不注入 ----
const d3 = await step(handlers, [userMsg('再问一次')], { session: 's1', stepNo: 2 })
check('step 2 不注入', d3.messages.length === 0)

// ---- 4. reject 透传 ----
const d4 = await step(handlers, [userMsg('x')], { decision: { kind: 'reject' } })
check('reject 原样返回', d4.kind === 'reject')

// ---- 5. 只取用户原话，跳过上下文消息 ----
const ctxMsg = { id: 'c', role: 'user', content: [{ type: 'text', text: '技能目录：...' }], source: { kind: 'skill-catalog' } }
const d5 = await step(handlers, [ctxMsg, userMsg('我家猫叫豆豆')], { session: 's3' })
check('跳过上下文，取用户原话', d5.messages.at(-1).content[0].text.includes('无相关记忆'))
const d6 = await step(handlers, [userMsg('我家猫叫什么')], { session: 's4' })
check('用户原话被写入并可召回', d6.messages.at(-1).content[0].text.includes('豆豆'), d6.messages.at(-1).content[0].text.replace(/\n/g, ' | '))

// ---- 6. 人格隔离 ----
const { handlers: h2 } = makeCtx({ personaId: 'p_tsundere' })
const d7 = await step(h2, [userMsg('我之前提过考雅思的事吗')], { session: 's5' })
check('跨人格不命中', d7.messages.at(-1).content[0].text.includes('无相关记忆'))

// ---- 7. 降级：memory 抛错时不影响对话 ----
const bad = makeCtx({ personaId: 'p_bad' })
bad.handlers['agent/pre-step'][0] = null
const { handlers: h3 } = makeCtx({ personaId: '../../etc' })
const d8 = await step(h3, [userMsg('随便说点什么')])
check('异常人格名不崩', d8.messages.length === 1)

// ---- 8. 模板 ----
check('composeC 有命中格式', composeC({ hit: true, memories: [{ date: '2026-10-20', text: '考雅思' }] }).startsWith('【本轮记忆】\n- 2026-10-20：考雅思'))
check('composeC 无命中·问过去', composeC({ hit: false, memories: [] }, { isQuestion: true }).includes('只回：这对我还是新的'))
check('composeC 无命中·说新事', composeC({ hit: false, memories: [] }, { isQuestion: false }).includes('正常回应这件事'))
check('问句判定', /^.+[?？]$/.test('我家猫叫什么？') && !/^.+[?？]$/.test('我家猫叫豆豆'))

// ---- 9. P1.0 异步抽取接线 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const p1 = makeCtx({ personaId: 'p_extract', extract: { idleDelayMs: 5 } })
await step(p1.handlers, [userMsg('我下个月要考雅思，最近在备考')], { session: 'sx' })
const file9 = path.join(tmp, 'memora-p_extract.jsonl')
const rowsBefore = fs.readFileSync(file9, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
check('抽取不阻塞：step 返回时原句已落盘', rowsBefore.some((r) => r.text === '我下个月要考雅思，最近在备考'))
check('抽取没有在 step 内发生', !rowsBefore.some((r) => r.text === '下个月要考雅思'))
p1.handlers['agent/status'][0]({ status: 'idle' })
await sleep(150)
const rowsAfter = fs.readFileSync(file9, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
check('idle 后原句替换成 2 条事实', ['下个月要考雅思', '在备考'].every((t) => rowsAfter.some((r) => r.text === t)) && rowsAfter.length === 2, rowsAfter.map((r) => r.text).join(' | '))
check('替换后原句消失', !rowsAfter.some((r) => r.text === '我下个月要考雅思，最近在备考'))

const p2 = makeCtx({ personaId: 'p_noextract', extract: false })
await step(p2.handlers, [userMsg('我养了一只猫叫豆豆')], { session: 'sx' })
p2.handlers['agent/status'][0]({ status: 'idle' })
await sleep(80)
const rowsOff = fs.readFileSync(path.join(tmp, 'memora-p_noextract.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
check('extract:false 不动原句', rowsOff.length === 1 && rowsOff[0].text === '我养了一只猫叫豆豆', rowsOff.map((r) => r.text).join(' | '))

console.log('\n  R2 · 插件接线自测\n')
for (const [s, n, d] of rows) console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}${s === 'FAIL' && d ? `  → ${d}` : ''}`)
console.log(`\n  ${pass} passed, ${fail} failed`)
console.log(`  debug 日志示例：${logs[0] ?? '（无）'}\n`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
