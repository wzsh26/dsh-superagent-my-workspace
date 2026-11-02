/**
 * R4 自测：容错与滚动截断
 * 运行：node memory.robust.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-r4-'))
process.env.MEMORA_HOME = tmp
process.env.MEMORA_MAX_RECORDS = '10'

const { ingest, recall, stats } = await import('./memory.js')

let pass = 0
let fail = 0
const rows = []
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++
  rows.push([ok ? 'PASS' : 'FAIL', name, detail])
}

// ---- 1. 坏行容错 ----
const corrupt = path.join(tmp, 'memora-corrupt.jsonl')
fs.writeFileSync(
  corrupt,
  [
    JSON.stringify({ id: 1, session_id: 's', text: '我家猫叫豆豆，今年三岁', created_at: '2026-10-20T12:00:00Z' }),
    '{这不是 JSON',
    '',
    JSON.stringify({ id: 2, session_id: 's', text: '最近在学做手冲咖啡', created_at: '2026-10-21T12:00:00Z' }),
    JSON.stringify({ id: 3, session_id: 's', text: '   ', created_at: '2026-10-21T12:00:00Z' }),
  ].join('\n') + '\n',
)

const hit = recall({ persona: 'corrupt', session: 'x', query: '我家猫叫什么' })
check('坏行不影响其余记录', hit.hit && hit.memories[0]?.text.includes('豆豆'), hit.memories[0]?.text)
check('坏行备份到 .bad', fs.existsSync(`${corrupt}.bad`))
const kept = fs.readFileSync(corrupt, 'utf8').split('\n').filter(Boolean)
check('主文件只剩有效行', kept.length === 2, String(kept.length))
check('空白行被丢弃', stats('corrupt').messages === 2, JSON.stringify(stats('corrupt')))

// ---- 2. 滚动截断（上限 10，写第 11 条触发） ----
for (let i = 0; i < 11; i++) {
  ingest({ persona: 'cap', session: 's', text: `第${i}条记录，内容编号${i}` })
}
check('超过上限截断到一半', stats('cap').messages === 5, JSON.stringify(stats('cap')))
const capLines = fs.readFileSync(path.join(tmp, 'memora-cap.jsonl'), 'utf8').split('\n').filter(Boolean)
check('文件同步截断', capLines.length === 5, String(capLines.length))
check('保留的是最新一半', JSON.parse(capLines[0]).text.includes('第6条'), JSON.parse(capLines[0]).text)

ingest({ persona: 'cap', session: 's', text: '截断之后的新记录' })
check('截断后可继续写入', stats('cap').messages === 6, JSON.stringify(stats('cap')))
const after = recall({ persona: 'cap', session: 's', query: '截断之后的新记录' })
check('截断后仍可召回', after.hit && after.memories[0].text.includes('截断之后'), after.memories[0]?.text)

console.log('\n  R4 · 容错与截断自测\n')
for (const [s, n, d] of rows) console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}${s === 'FAIL' && d ? `  → ${d}` : ''}`)
console.log(`\n  ${pass} passed, ${fail} failed\n`)

fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
