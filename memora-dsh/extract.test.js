/**
 * P1.0 自测：extract.js + 空闲队列
 * 运行：node extract.test.js
 */
import fs from 'node:fs'
import {
  buildModelMessages,
  cleanClause,
  createExtractQueue,
  extractRules,
  extractWithModel,
  normalizeFact,
  parseModelOutput,
  splitClauses,
} from './extract.js'

const fixtures = JSON.parse(fs.readFileSync(new URL('../p1-extract-fixtures.json', import.meta.url), 'utf8'))

let pass = 0
let fail = 0
const rows = []
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++
  rows.push([ok ? 'PASS' : 'FAIL', name, detail])
}
const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
  a.every((x, i) => (Array.isArray(x) ? same(x, b[i]) : x === b[i]))
const LONG = '今天上班的时候老板又临时改需求搞得我整个下午都在返工真的烦死了'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 1. 拆句 / 清洗 ----
check('按中文标点拆句', same(splitClauses('甲，乙。丙；丁'), ['甲', '乙', '丙', '丁']))
check('不拆英文小数点', same(splitClauses('版本 3.5 发布了'), ['版本 3.5 发布了']))
check('剥第一人称和模糊时间', cleanClause('我最近在学做手冲咖啡') === '在学做手冲咖啡', cleanClause('我最近在学做手冲咖啡'))
check('"我们"不被剥成"们"', cleanClause('我们公司下周团建') === '我们公司下周团建', cleanClause('我们公司下周团建'))
check('"我家猫"保留主题', cleanClause('我家猫叫豆豆') === '猫叫豆豆', cleanClause('我家猫叫豆豆'))
check('纯语气清成空串', cleanClause('啊') === '' && cleanClause('哈哈') === '')
check('纯表情清成空串', cleanClause('😀😀') === '', cleanClause('😀😀'))
check('问句清成空串', cleanClause('你吃了吗') === '')

// ---- 2. 10 条标注（规则路径） ----
for (const c of fixtures.cases) {
  const r = extractRules(c.text)
  check(`标注 ${c.id}`, r.confident && same(r.facts, c.facts), JSON.stringify(r.facts))
}

// ---- 3. 负样本 ----
for (const n of fixtures.negatives) {
  const r = extractRules(n.text)
  check(`负样本 ${n.id}`, r.confident && r.facts.length === 0, JSON.stringify(r.facts))
}

// ---- 4. 兜底边界 ----
const long = extractRules(LONG)
check('太长 → 交模型', !long.confident && long.reason === 'too-long', JSON.stringify(long))
const pronoun = extractRules('我养了一只猫叫豆豆，它今年三岁')
check('第三人称指代 → 交模型', !pronoun.confident && pronoun.reason === 'pronoun', JSON.stringify(pronoun))
const noFact = extractRules('嗯嗯，好的')
check('寒暄 → 确信 0 条', noFact.confident && noFact.facts.length === 0, noFact.reason)
const three = extractRules('我下个月要考雅思，最近在备考，有点焦虑')
check('超过 2 条截断', same(three.facts, ['下个月要考雅思', '在备考']), JSON.stringify(three.facts))
check('每条 ≤20 字', fixtures.cases.every((c) => c.facts.every((f) => Array.from(f).length <= 20)))

// ---- 5. 事实清洗 ----
check('去掉编号', normalizeFact('1. 猫叫豆豆') === '猫叫豆豆', normalizeFact('1. 猫叫豆豆'))
check('去掉项目符号', normalizeFact('- 猫叫豆豆') === '猫叫豆豆', normalizeFact('- 猫叫豆豆'))
check('问句事实丢弃', normalizeFact('你吃了吗') === '')
check('第三人称指代事实丢弃', normalizeFact('它今年三岁') === '')
const cut = normalizeFact('今天上班的时候老板又临时改需求搞得我整个下午都在返工')
check('超长事实压到 20 字内', Array.from(cut).length <= 20, `${Array.from(cut).length}「${cut}」`)

// ---- 6. 模型输出解析 ----
check('逐行解析', same(parseModelOutput('1. 猫叫豆豆|猫今年三岁', 1), [['猫叫豆豆', '猫今年三岁']]))
check('「无」解析为空', same(parseModelOutput('1. 无', 1), [[]]))
check('JSON 解析', same(parseModelOutput('[["猫叫豆豆","猫今年三岁"]]', 1), [['猫叫豆豆', '猫今年三岁']]))
check('JSON 对象解析', same(parseModelOutput('[{"facts":[{"text":"猫叫豆豆"}]}]', 1), [['猫叫豆豆']]))
check('JSON 条数不对 → null', parseModelOutput('[["猫叫豆豆"],["猫今年三岁"]]', 1) === null)
check('剔除复读的输入行', same(parseModelOutput('1. 我养了一只猫叫豆豆\n1. 猫叫豆豆', 1, ['我养了一只猫叫豆豆']), [['猫叫豆豆']]))
check('行数不够返回 null', parseModelOutput('1. 猫叫豆豆', 2) === null)
check('空输出返回 null', parseModelOutput('', 1) === null)
const msgs = buildModelMessages(['甲', '乙'])
check('模型 prompt 含句数与序号', msgs[1].content.includes('共 2 句') && msgs[1].content.includes('2. 乙'))
check('模型 prompt 要求 ≤20 字', msgs[0].content.includes('≤20'))

// ---- 7. extractWithModel（假 fetch，不联网） ----
const okFetch = async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: '1. 猫叫豆豆|猫今年三岁' } }] }),
})
let out = await extractWithModel(['我养了一只猫叫豆豆，它今年三岁'], { fetch: okFetch })
check('模型成功路径', same(out.facts?.[0] ?? [], ['猫叫豆豆', '猫今年三岁']) && !out.error, JSON.stringify(out))

const failFetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
out = await extractWithModel(['x'], { fetch: failFetch })
check('模型 HTTP 失败 → null', out.facts === null && out.error.includes('500'), JSON.stringify(out))

const badParseFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '我不知道' } }] }) })
out = await extractWithModel(['x'], { fetch: badParseFetch })
check('模型乱答 → null（保留原句）', out.facts === null && out.error === 'parse', JSON.stringify(out))

// ---- 8. 空闲队列 ----
async function collectQueue(opts) {
  const calls = []
  const logs = []
  const queue = createExtractQueue({
    replace: (input) => {
      calls.push(input)
      return { ok: true }
    },
    logger: { debug: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
    ...opts,
  })
  return { queue, calls, logs }
}

// 8.1 规则能定的：直接 replace，不碰模型
{
  const modelCalls = []
  const { queue, calls, logs } = await collectQueue({
    extractBatch: async (texts) => {
      modelCalls.push(texts)
      return texts.map(() => null)
    },
  })
  queue.enqueue({ persona: 'p', id: 1, text: '我下个月要考雅思，最近在备考' })
  queue.enqueue({ persona: 'p', id: 2, text: '嗯嗯，好的' })
  await queue.flush()
  check('队列：规则替换 2 条', calls.length === 2, JSON.stringify(calls))
  check('队列：规则命中时不调模型', modelCalls.length === 0)
  check('队列：空闲后无残留', queue.pending === 0, logs[0])
  const first = calls.find((c) => c.id === 1)
  check('队列：事实正确', same(first.facts, ['下个月要考雅思', '在备考']), JSON.stringify(first))
  check('队列：规则路径同时传 kws（与事实对齐）',
    Array.isArray(first.kws) && first.kws.length === first.facts.length &&
      first.kws.every((k) => Array.isArray(k) && k.length > 0), JSON.stringify(first.kws))
  const drop = calls.find((c) => c.id === 2)
  check('队列：寒暄删除', same(drop.facts, []), JSON.stringify(drop))
}

// 8.2 规则不敢定的：批量问模型后替换
{
  const modelCalls = []
  const { queue, calls } = await collectQueue({
    extractBatch: async (texts) => {
      modelCalls.push(texts)
      return [['老板临时改需求', '我下午在返工']]
    },
  })
  queue.enqueue({
    persona: 'p',
    id: 3,
    text: LONG,
  })
  await queue.flush()
  check('队列：长句走模型', modelCalls.length === 1 && modelCalls[0].length === 1, JSON.stringify(modelCalls))
  check('队列：模型结果被替换', calls.length === 1 && same(calls[0].facts, ['老板临时改需求', '我下午在返工']), JSON.stringify(calls))
  check('队列：模型结果也在本地补 kws',
    Array.isArray(calls[0].kws) && calls[0].kws.length === calls[0].facts.length &&
      calls[0].kws.every((k) => Array.isArray(k) && k.length > 0), JSON.stringify(calls[0].kws))
}

// 8.3 模型失败：保留原句（不调用 replace）
{
  const { queue, calls, logs } = await collectQueue({
    extractBatch: async () => ({ facts: null, error: 'timeout' }),
  })
  queue.enqueue({ persona: 'p', id: 4, text: LONG })
  await queue.flush()
  check('队列：模型失败保留原句并重试一次', calls.length === 0 && queue.pending === 1, logs.join(' | '))
  await queue.flush()
  check('队列：重试仍失败则放弃（原句保留）', calls.length === 0 && queue.pending === 0, logs.join(' | '))
}

// 8.4 模型回 0 条：宁可保留原句
{
  const { queue, calls } = await collectQueue({ extractBatch: async (texts) => texts.map(() => []) })
  queue.enqueue({ persona: 'p', id: 5, text: LONG })
  await queue.flush()
  check('队列：模型回 0 条不删原句', calls.length === 0)
}

// 8.5 生成开始（busy）：abort 在途请求，任务留到下次空闲
{
  let started = false
  const { queue } = await collectQueue({
    extractBatch: (texts, { signal }) =>
      new Promise((_resolve, reject) => {
        started = true
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
  })
  queue.enqueue({ persona: 'p', id: 6, text: LONG })
  const flushing = queue.flush()
  await sleep(5)
  check('队列：模型请求已发出', started)
  queue.onBusy()
  await flushing
  check('队列：busy 时任务留下次', queue.pending === 1, String(queue.pending))
  queue.dispose()
}

// 8.6 关闭开关 / 去重 / 空 id
{
  const { queue, calls } = await collectQueue({ enabled: false })
  check('队列：关闭后不入队', queue.enqueue({ persona: 'p', id: 7, text: '随便' }) === false)
  await queue.flush()
  check('队列：关闭后不替换', calls.length === 0)
  const on = await collectQueue({})
  on.queue.enqueue({ persona: 'p', id: 8, text: '我养了一只猫' })
  on.queue.enqueue({ persona: 'p', id: 8, text: '我养了一只猫' })
  check('队列：同 id 去重', on.queue.pending === 1, String(on.queue.pending))
  await on.queue.flush()
  check('队列：空 id 忽略', on.queue.enqueue({ persona: 'p', id: null, text: 'x' }) === false)
}

// ---- 9. M1 · 抽取事实时同时产出 kws ----
const kwFacts = extractRules('我家猫叫豆豆，今年三岁')
check('kws：与事实下标对齐', Array.isArray(kwFacts.kws) && kwFacts.kws.length === kwFacts.facts.length,
  JSON.stringify(kwFacts.kws))
check('kws：含「豆豆」「三岁」',
  kwFacts.kws.flat().includes('豆豆') && kwFacts.kws.flat().includes('三岁'), JSON.stringify(kwFacts.kws))
const kwEmpty = extractRules('嗯嗯，好的')
check('kws：0 条事实时 kws 为空', Array.isArray(kwEmpty.kws) && kwEmpty.kws.length === 0, JSON.stringify(kwEmpty.kws))

// ---- 输出 ----
console.log('\n  P1.0 · extract.js 自测\n')
for (const [s, n, d] of rows) console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}${s === 'FAIL' && d ? `  → ${d}` : ''}`)
console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
