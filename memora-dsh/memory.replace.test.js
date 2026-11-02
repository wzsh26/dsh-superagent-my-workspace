/**
 * P1.0 自测：memory.replace（原句 → 原子事实）
 * 运行：node memory.replace.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-p1-'))
process.env.MEMORA_HOME = tmp

const { ingest, recall, replace, stats } = await import('./memory.js')

let pass = 0
let fail = 0
const rows = []
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++
  rows.push([ok ? 'PASS' : 'FAIL', name, detail])
}
const readRows = (persona) =>
  fs.readFileSync(path.join(tmp, `memora-${persona}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

const p = 'replace_persona'
const raw1 = '我下个月要考雅思，最近在备考'
const r1 = ingest({ persona: p, session: 's1', text: raw1, createdAt: '2026-10-20T12:00:00+08:00' })
const raw2 = '我家猫叫豆豆，今年三岁'
const r2 = ingest({ persona: p, session: 's1', text: raw2, createdAt: '2026-10-21T12:00:00+08:00' })
const other = ingest({ persona: p, session: 's2', text: '周六要去杭州出差两天', createdAt: '2026-10-22T12:00:00+08:00' })

// ---- 1. 原句 → 2 条事实 ----
const done = replace({ persona: p, id: r1.id, facts: ['下个月要考雅思', '在备考'] })
check('replace 返回 ok', done.ok === true, JSON.stringify(done))
check('拆成 2 条新 id', done.ids.length === 2 && done.removed[0] === r1.id, JSON.stringify(done))
check('新 id 不复用旧 id', done.ids.every((id) => id > r1.id), JSON.stringify(done.ids))
check('stats 多 1 条（2 换 1）', stats(p).messages === 4, JSON.stringify(stats(p)))

let rowsOnDisk = readRows(p)
check('原句已从文件消失', !rowsOnDisk.some((r) => r.text === raw1), rowsOnDisk.map((r) => r.text).join(' | '))
check('两条事实落盘', ['下个月要考雅思', '在备考'].every((t) => rowsOnDisk.some((r) => r.text === t)))
check('created_at 继承原句', rowsOnDisk.filter((r) => r.text === '在备考').every((r) => r.created_at === '2026-10-20T12:00:00+08:00'))
check('session_id 继承原句', rowsOnDisk.filter((r) => ['下个月要考雅思', '在备考'].includes(r.text)).every((r) => r.session_id === 's1'))
check('JSONL 仍可逐行解析', rowsOnDisk.length === fs.readFileSync(path.join(tmp, `memora-${p}.jsonl`), 'utf8').split('\n').filter(Boolean).length)

// ---- 2. 召回索引已重建 ----
const hit = recall({ persona: p, session: 'probe', query: '我之前提过雅思的事吗' })
check('事实可召回', hit.hit && hit.memories.some((m) => m.text.includes('雅思')), JSON.stringify(hit.memories))
const old = recall({ persona: p, session: 'probe', query: '最近在备考' })
check('索引里没有旧原句', old.memories.every((m) => m.text !== raw1), JSON.stringify(old.memories))

// ---- 3. 其他记录不受影响 ----
check('同会话另一条原句还在', rowsOnDisk.some((r) => r.text === raw2))
check('跨会话记录还在', rowsOnDisk.some((r) => r.id === other.id && r.text === '周六要去杭州出差两天'))

// ---- 4. 空事实 = 删除（寒暄/纯语气） ----
const drop = replace({ persona: p, id: r2.id, facts: [] })
check('空事实删除原句', drop.ok === true && drop.ids.length === 0, JSON.stringify(drop))
rowsOnDisk = readRows(p)
check('删除后文件里没有原句', !rowsOnDisk.some((r) => r.text === raw2))

// ---- 5. 幂等 / 边界 ----
const sameText = ingest({ persona: p, session: 's3', text: '讨厌打电话' })
const noop = replace({ persona: p, id: sameText.id, facts: ['讨厌打电话'] })
check('单条与原句相同 → unchanged', noop.ok === true && noop.unchanged === true, JSON.stringify(noop))
check('not-found 不崩', replace({ persona: p, id: 99999, facts: ['x'] }).ok === false)
const dup = replace({ persona: p, id: sameText.id, facts: ['讨厌打电话', '讨厌打电话'] })
check('重复事实去重', dup.ok === true, JSON.stringify(dup))
check('去重后仍只有 1 条', readRows(p).filter((r) => r.text === '讨厌打电话').length === 1)

// 同会话已有同一事实：不重复落库
const a = ingest({ persona: p, session: 's4', text: '我最近睡得不太好' })
ingest({ persona: p, session: 's4', text: '我最近睡得不太好，经常两点才睡' })
const b = readRows(p).find((r) => r.text === '我最近睡得不太好，经常两点才睡')
const dedup = replace({ persona: p, id: b.id, facts: ['睡得不太好'] })
check('同会话重复事实不重复落库', dedup.ok === true && dedup.ids.length === 1, JSON.stringify(dedup))
const again = replace({ persona: p, id: dedup.ids[0], facts: ['睡得不太好'] })
check('同文本再替换为自身 → unchanged', again.unchanged === true, JSON.stringify(again))

// ---- 6. 写后仍可继续 ingest ----
const after = ingest({ persona: p, session: 's5', text: '我昨天看了场球赛' })
check('replace 后可继续写入', after.id > 0 && stats(p).messages >= 1, JSON.stringify(after))
check('文件以换行结尾', fs.readFileSync(path.join(tmp, `memora-${p}.jsonl`), 'utf8').endsWith('\n'))

// ---- 输出 ----
console.log('\n  P1.0 · memory.replace 自测\n')
for (const [s, n, d] of rows) console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}${s === 'FAIL' && d ? `  → ${d}` : ''}`)
console.log(`\n  ${pass} passed, ${fail} failed  (home: ${tmp})\n`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
