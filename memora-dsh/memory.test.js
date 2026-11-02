/**
 * R1 自测：memory.js
 * 运行：MEMORA_HOME=/tmp/xxx node memory.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-r1-'))
process.env.MEMORA_HOME = tmp

const { extractKeywords, tokenize, ingest, recall, replace, reset, stats } = await import('./memory.js')

let pass = 0
let fail = 0
const rows = []

function check(name, ok, detail = '') {
  if (ok) { pass++; rows.push(['PASS', name, detail]) }
  else { fail++; rows.push(['FAIL', name, detail]) }
}

// ---- 1. 分词 ----
const tk = tokenize('我下个月要考雅思，最近在备考')
check('分词含「雅思」', tk.includes('雅思'), tk.join(','))
check('分词含「备考」', tk.includes('备考'))
check('停用词被过滤', !tk.includes('我们') && !tk.includes('最近'), tk.filter((t) => ['我们', '最近'].includes(t)).join(','))

// ---- 2. 写入 / 幂等 ----
const p1 = 'gentle_senior'
const r1 = ingest({ persona: p1, session: 's1', text: '我下个月要考雅思，最近在备考' })
const r1b = ingest({ persona: p1, session: 's1', text: '我下个月要考雅思，最近在备考' })
const r2 = ingest({ persona: p1, session: 's1', text: '我养了一只猫叫团子' })
check('首次写入有新 id', Number.isInteger(r1.id) && r1.id > 0, String(r1.id))
check('重复写入标记 duplicate', r1b.duplicate === true && r1b.id === r1.id)
check('不同文本正常写入', r2.duplicate === false && r2.id !== r1.id)

// ---- 3. 召回 ----
const hit = recall({ persona: p1, session: 's2', query: '我之前提过备考的事吗' })
check('召回命中', hit.hit && hit.memories.length > 0, JSON.stringify(hit.memories))
check('命中正确的那条', hit.memories[0]?.text.includes('雅思'), hit.memories[0]?.text)
check('date 格式 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(hit.memories[0]?.date || ''))

const miss = recall({ persona: p1, session: 's2', query: '今天天气怎么样' })
check('无关问题不命中', miss.hit === false && miss.memories.length === 0, JSON.stringify(miss.debug.tokens))

// ---- 4. 隔离 ----
const other = recall({ persona: 'tsundere_buddy', session: 's2', query: '我之前提过备考的事吗' })
check('跨人格 0 条', other.hit === false && other.memories.length === 0)

// ---- 5. 边界 ----
check('空文本不写', ingest({ persona: p1, session: 's1', text: '   ' }).skipped === 'empty')
check('纯标点不写', ingest({ persona: p1, session: 's1', text: '？？！…' }).skipped === 'no-tokens')
check('超长文本不写', ingest({ persona: p1, session: 's1', text: 'a'.repeat(2001) }).skipped === 'too-long')
check('问句不写（问号结尾）', ingest({ persona: p1, session: 's1', text: '我之前说我要考什么来着？' }).skipped === 'question')
check('问句不写（疑问词结尾）', ingest({ persona: p1, session: 's1', text: '你现在在忙什么呢' }).skipped === 'question')
check('陈述句照常写入', ingest({ persona: p1, session: 's1', text: '我最近睡得不太好' }).duplicate === false)
check('以「什么」结尾的陈述句不误杀', ingest({ persona: p1, session: 's1', text: '妈妈下个月生日，还没想好送什么' }).duplicate === false)

// ---- 6. 持久化 ----
const file = path.join(tmp, 'memora-gentle_senior.jsonl')
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
check('落盘 4 行', lines.length === 4, String(lines.length))
check('JSONL 可解析', lines.every((l) => JSON.parse(l).text))

// ---- 7. 性能：1k 条 ----
const base = Date.now() - 10 * 86_400_000
for (let i = 0; i < 1000; i++) {
  ingest({
    persona: p1,
    session: `bulk-${i % 20}`,
    text: `第${i}条回忆：我在${i % 12}月去过城市${i % 30}，和同事聊了项目${i % 50}的事情`,
    createdAt: new Date(base + i * 60_000).toISOString(),
  })
}
recall({ persona: p1, session: 'warm', query: '项目' }) // 预热索引

const queries = ['项目', '城市旅行', '同事聊了什么', '12月去过哪', '备考', '猫叫什么', '项目50', '城市12', '同事', '回忆']
const times = []
for (let round = 0; round < 5; round++) {
  for (const q of queries) {
    const t = process.hrtime.bigint()
    recall({ persona: p1, session: 'perf', query: q })
    times.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
}
times.sort((a, b) => a - b)
const p95 = times[Math.floor(times.length * 0.95)]
const avg = times.reduce((a, b) => a + b, 0) / times.length
check('1k 条召回 p95 < 5ms', p95 < 5, `p95=${p95.toFixed(3)}ms avg=${avg.toFixed(3)}ms`)
check('stats 正确', stats(p1).messages === 1004, JSON.stringify(stats(p1)))

// ---- 8. reset ----
const before = stats('tsundere_buddy').messages
const del = reset('tsundere_buddy')
check('reset 清空', del.deleted === before && stats('tsundere_buddy').messages === 0, JSON.stringify(del))

// ---- 9. 隔离落盘（R3） ----
ingest({ persona: 'tsundere_buddy', session: 'x1', text: '我昨天看了场球赛' })
const files = fs.readdirSync(tmp).filter((f) => f.endsWith('.jsonl')).sort()
check('两人格两个文件', files.length === 2 && files.includes('memora-gentle_senior.jsonl') && files.includes('memora-tsundere_buddy.jsonl'), files.join(','))
check('同文本跨会话各自成条', ingest({ persona: p1, session: 'other-session', text: '我养了一只猫叫团子' }).duplicate === false)
const dup = recall({ persona: p1, session: 'x', query: '猫叫团子' })
check('同文本召回只出现一次', dup.memories.filter((m) => m.text.includes('团子')).length === 1, String(dup.memories.length))
const weird = ingest({ persona: '../../etc/passwd', session: 's', text: '路径穿越测试' })
const weirdFile = fs.readdirSync(tmp).find((f) => f.includes('etc'))
check('人格名被净化，无路径穿越', weird.duplicate === false && !!weirdFile && !weirdFile.includes('/'), weirdFile)

// ---- 10. M1 · 关键词（kws）----
const kwPersona = 'm1_keywords'
const kwRows = (persona) =>
  fs.readFileSync(path.join(tmp, `memora-${persona}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

const kw1 = extractKeywords('下个月要考雅思')
check('kws：抽到「雅思」', kw1.includes('雅思'), JSON.stringify(kw1))
const kw2 = extractKeywords('在备考')
check('kws：剥掉「在」只剩「备考」', kw2.length === 1 && kw2[0] === '备考', JSON.stringify(kw2))
const kw3 = extractKeywords('我不太喜欢别人一直追问我最近在备考雅思的事情，周末还要去杭州出差两天，顺便看产品经理的工作')
check('kws：最多 5 个', kw3.length > 0 && kw3.length <= 5, JSON.stringify(kw3))
check('kws：长度 2–10 字且去停用词',
  kw3.every((k) => Array.from(k).length >= 2 && Array.from(k).length <= 10) &&
    !kw3.some((k) => ['最近', '喜欢', '一直', '的事情'].includes(k)), JSON.stringify(kw3))
check('kws：寒暄抽不到关键词', extractKeywords('嗯嗯，好的').length === 0, JSON.stringify(extractKeywords('嗯嗯，好的')))

const kwIngest = ingest({ persona: kwPersona, session: 's1', text: '我下个月要考雅思，最近在备考', createdAt: '2026-10-20T12:00:00+08:00' })
const kwRow = kwRows(kwPersona).find((r) => r.id === kwIngest.id)
check('kws：ingest 落盘带 kws', Array.isArray(kwRow?.kws) && kwRow.kws.includes('雅思'), JSON.stringify(kwRow?.kws))

const catIngest = ingest({ persona: kwPersona, session: 's2', text: '我家猫叫豆豆，今年三岁', createdAt: '2026-10-21T12:00:00+08:00' })
const catDone = replace({ persona: kwPersona, id: catIngest.id, facts: ['猫叫豆豆', '猫今年三岁'] })
const catRows = kwRows(kwPersona).filter((r) => catDone.ids.includes(r.id))
check('kws：replace 为每条事实各存一份',
  catRows.length === 2 && catRows.every((r) => Array.isArray(r.kws) && r.kws.length > 0) &&
    catRows.some((r) => r.kws.includes('豆豆')) && catRows.some((r) => r.kws.includes('三岁')),
  JSON.stringify(catRows.map((r) => r.kws)))

const paraQuery = recall({ persona: kwPersona, session: 'probe', query: '我考试准备得怎么样' })
check('kws：换说法召回「备考」', paraQuery.hit && paraQuery.memories.some((m) => m.text.includes('备考')), JSON.stringify(paraQuery.memories))
check('debug 暴露查询关键词', paraQuery.debug.kws.includes('备考'), JSON.stringify(paraQuery.debug.kws))

const paraSleep = ingest({ persona: 'm1_para', session: 's', text: '睡眠不太好，经常两点才睡' })
const sleepHit = recall({ persona: 'm1_para', session: 'probe', query: '我平时几点睡觉' })
check('kws：睡眠/睡觉同义命中', sleepHit.hit && sleepHit.memories[0].text.includes('睡眠'), JSON.stringify(sleepHit.memories))

// 老记录没有 kws 字段：仍走纯 bigram（向后兼容），不炸、不改写格式。
const legacyPersona = 'm1_legacy'
fs.writeFileSync(
  path.join(tmp, `memora-${legacyPersona}.jsonl`),
  JSON.stringify({ id: 1, session_id: 's', text: '我每周三去游泳', created_at: '2026-10-01T12:00:00+08:00' }) + '\n',
)
const legacyHit = recall({ persona: legacyPersona, session: 'probe', query: '游泳安排在什么时候' })
check('kws：老记录无 kws 仍可召回', legacyHit.hit && legacyHit.memories[0].text.includes('游泳'), JSON.stringify(legacyHit.memories))
check('kws：老记录不会被补写 kws',
  !('kws' in JSON.parse(fs.readFileSync(path.join(tmp, `memora-${legacyPersona}.jsonl`), 'utf8').trim())))

// 1k 条带 kws 的性能：单次 recall < 2ms（p95）。
const kwTimes = []
for (let round = 0; round < 5; round++) {
  for (const q of queries) {
    const t = process.hrtime.bigint()
    recall({ persona: p1, session: 'perf-kws', query: q })
    kwTimes.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
}
kwTimes.sort((a, b) => a - b)
const kwP95 = kwTimes[Math.floor(kwTimes.length * 0.95)]
check('kws：1k 条单次召回 p95 < 2ms', kwP95 < 2, `p95=${kwP95.toFixed(3)}ms`)

// ---- 输出 ----
console.log('\n  R1 · memory.js 自测\n')
for (const [s, n, d] of rows) {
  console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}${d && s === 'FAIL' ? `  → ${d}` : ''}`)
}
console.log(`\n  ${pass} passed, ${fail} failed  (home: ${tmp})\n`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
