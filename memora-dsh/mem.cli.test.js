/**
 * M3 自测：记忆 CLI（scripts/mem.js）
 * 运行：node mem.cli.test.js
 *
 * 验收：export → 清空 → import → stats 一致；del 后该条不再被召回；
 *       导入版本不符时拒绝并提示。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-m3-'))
process.env.MEMORA_HOME = tmp

const mem = await import('./memory.js')
const CLI = fileURLToPath(new URL('./scripts/mem.js', import.meta.url))

let pass = 0
let fail = 0
const rows = []
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++
  rows.push([ok ? 'PASS' : 'FAIL', name, detail])
}

const cli = (args) =>
  execFileSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, MEMORA_HOME: tmp },
    encoding: 'utf8',
  })
const cliFail = (args) => {
  try {
    return { status: 0, stdout: cli(args), stderr: '' }
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    }
  }
}

// ---- 1. 种数据 ----
mem.ingest({ persona: 'gentle_senior', session: 's1', text: '我家猫叫豆豆，今年三岁' })
mem.ingest({ persona: 'gentle_senior', session: 's1', text: '下个月要考雅思，最近在备考' })
mem.ingest({ persona: 'tsundere_buddy', session: 's2', text: '我周末要去杭州出差两天' })

const before = {
  gentle: mem.stats('gentle_senior').messages,
  tsundere: mem.stats('tsundere_buddy').messages,
}
check('种子数据 2 + 1 条', before.gentle === 2 && before.tsundere === 1, JSON.stringify(before))

// ---- 2. list ----
const listOut = cli(['list', 'gentle_senior'])
check('list 显示文本与关键词', listOut.includes('豆豆') && listOut.includes('雅思') && listOut.includes('['), listOut.slice(0, 120))

// ---- 3. export ----
const backup = path.join(tmp, 'backup.json')
cli(['export', backup])
const exported = JSON.parse(fs.readFileSync(backup, 'utf8'))
check('export 带版本号', exported.version === 1, String(exported.version))
check('export 含全部人格与条数', exported.total === 3 && exported.personas.gentle_senior.length === 2 &&
  exported.personas.tsundere_buddy.length === 1, JSON.stringify(Object.keys(exported.personas ?? {})))
check('export 保留 kws', Array.isArray(exported.personas.gentle_senior[0].kws) &&
  exported.personas.gentle_senior.some((r) => r.kws?.includes('备考')), JSON.stringify(exported.personas.gentle_senior[0].kws))

// ---- 4. 清空 → import → stats 一致 ----
const cleared = mem.reset()
check('清空前有 3 条', cleared.deleted === 3, JSON.stringify(cleared))
check('清空后 0 条', mem.stats('gentle_senior').messages === 0 && mem.stats('tsundere_buddy').messages === 0)

const importOut = cli(['import', backup])
check('import 成功提示', importOut.includes('2 个人格') && importOut.includes('3 条记忆'), importOut.trim())
// CLI 是独立进程，测试进程里的空缓存要丢掉再读磁盘。
mem.reload('gentle_senior')
mem.reload('tsundere_buddy')
check('import 后 stats 与原数据一致',
  mem.stats('gentle_senior').messages === before.gentle &&
    mem.stats('tsundere_buddy').messages === before.tsundere,
  JSON.stringify({ gentle: mem.stats('gentle_senior').messages, tsundere: mem.stats('tsundere_buddy').messages }))
const recallAfterImport = mem.recall({ persona: 'gentle_senior', session: 'probe', query: '我考试准备得怎么样' })
check('import 后仍可按关键词换说法召回', recallAfterImport.hit && recallAfterImport.memories[0].text.includes('备考'),
  JSON.stringify(recallAfterImport.memories))

// ---- 5. del ----
const beforeRows = mem.list('gentle_senior')
const delTarget = beforeRows[0]
const delOut = cli(['del', 'gentle_senior', '1'])
check('del 有删除提示', delOut.includes('已删除') && delOut.includes(delTarget.text), delOut.trim())
mem.reload('gentle_senior')
const afterRows = mem.list('gentle_senior')
check('del 后文件少 1 条', afterRows.length === beforeRows.length - 1, String(afterRows.length))
check('del 删的是选中的那条', !afterRows.some((r) => r.id === delTarget.id))
const goneQuery = delTarget.text.includes('豆豆') ? '我家猫叫什么' : '我考试准备得怎么样'
const gone = mem.recall({ persona: 'gentle_senior', session: 'probe', query: goneQuery })
check('del 后该条不再被召回',
  !gone.memories.some((m) => m.text === delTarget.text), JSON.stringify(gone.memories))
const still = mem.recall({ persona: 'gentle_senior', session: 'probe', query: '雅思' })
check('其余记录仍可召回', still.hit, JSON.stringify(still.memories))

const badDel = cliFail(['del', 'gentle_senior', '99'])
check('del 序号越界报错', badDel.status !== 0 && badDel.stderr.includes('序号无效'), badDel.stderr.trim())

// ---- 6. 版本不符 → 拒绝并提示 ----
const badFile = path.join(tmp, 'bad-version.json')
fs.writeFileSync(badFile, JSON.stringify({ version: 99, personas: { gentle_senior: [] } }))
const bad = cliFail(['import', badFile])
check('版本不符退出码 2', bad.status === 2, String(bad.status))
check('版本不符有明确提示', /版本 99.*支持的 1/.test(bad.stderr), bad.stderr.trim())
const afterBad = mem.list('gentle_senior')
check('导入失败不改动现有数据', afterBad.length === afterRows.length, String(afterBad.length))

const badJson = path.join(tmp, 'bad.json')
fs.writeFileSync(badJson, '{不是 JSON')
const bad2 = cliFail(['import', badJson])
check('坏 JSON 拒绝', bad2.status === 2 && bad2.stderr.includes('JSON'), bad2.stderr.trim())

// ---- 7. stats ----
const statsOut = cli(['stats'])
check('stats 列出人格与合计', statsOut.includes('gentle_senior') && statsOut.includes('合计'), statsOut.trim())

// ---- 输出 ----
console.log('\n  M3 · 记忆 CLI 自测\n')
for (const [s, n, d] of rows) console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}${s === 'FAIL' && d ? `  → ${d}` : ''}`)
console.log(`\n  ${pass} passed, ${fail} failed  (home: ${tmp})\n`)

fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
