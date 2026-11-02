#!/usr/bin/env node
/**
 * Memora M3 · 记忆 CLI（替代管理 UI）
 *
 * 用法：
 *   node scripts/mem.js list <persona>
 *   node scripts/mem.js del <persona> <n>        # n = list 输出的序号（1 起）
 *   node scripts/mem.js export [file]            # 省略 file 则输出到 stdout
 *   node scripts/mem.js import <file>
 *   node scripts/mem.js stats [persona]
 *
 * 读写 ~/.memora（可用 MEMORA_HOME 覆盖）；零依赖。
 * 导入是「按人格替换」：只替换文件里出现的人格，版本不符则整体拒绝。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exportAll, importAll, list, listPersonas, remove, stats } from '../memory.js'
import { listEpisodes, removeEpisode } from '../episode.js'

const HOME = process.env.MEMORA_HOME || path.join(os.homedir(), '.memora')

/** list/del 共用的行：gist 在前、episode 在后，序号稳定（del 按序号删）。 */
function collectRows(persona) {
  const gists = list(persona).map((r) => ({ ...r, kind: 'gist' }))
  const episodes = listEpisodes(persona).map((e) => ({ ...e, kind: 'episode' }))
  return { gists, episodes, rows: [...gists, ...episodes] }
}

function usage() {
  console.error(
    [
      'Memora 记忆工具',
      '',
      '  node scripts/mem.js list <persona>',
      '  node scripts/mem.js del <persona> <n>       n = list 输出的序号',
      '  node scripts/mem.js export [file]',
      '  node scripts/mem.js import <file>',
      '  node scripts/mem.js stats [persona]',
      '',
      `  数据目录：${HOME}`,
    ].join('\n'),
  )
}

function fail(message, code = 1) {
  console.error(message)
  process.exit(code)
}

function needPersona(value, sub) {
  if (!value) fail(`缺少 persona。用法：node scripts/mem.js ${sub} <persona>`)
  return value
}

const [command, arg1, arg2] = process.argv.slice(2)

switch (command) {
  case 'list': {
    const persona = needPersona(arg1, 'list')
    const { gists, episodes, rows } = collectRows(persona)
    if (rows.length === 0) {
      console.log(`（${persona} 暂无记忆）`)
      break
    }
    console.log(`\n  ${persona} · ${gists.length} gist / ${episodes.length} episode\n`)
    rows.forEach((r, i) => {
      const tag = r.kind === 'gist' ? '[gist]' : '[原句]'
      const id = r.kind === 'gist' ? `#${r.id}` : `#e${r.id}`
      const kws = Array.isArray(r.kws) && r.kws.length ? `  [${r.kws.join('/')}]` : ''
      const flags = [
        r.superseded_by ? '已纠正' : '',
        r.promoted ? '已提炼' : '',
        r.archived ? '已归档' : '',
      ].filter(Boolean)
      const mark = flags.length ? `  （${flags.join('，')}）` : ''
      console.log(`  ${String(i + 1).padStart(3)}. ${id.padEnd(6)} ${tag}  ${r.created_at.slice(0, 10)}  ${r.text}${kws}${mark}`)
    })
    console.log()
    break
  }

  case 'del': {
    const persona = needPersona(arg1, 'del')
    const n = Number(arg2)
    const { rows } = collectRows(persona)
    if (!Number.isInteger(n) || n < 1 || n > rows.length) {
      fail(`序号无效：${arg2 ?? '（空）'}（当前共 ${rows.length} 条，序号从 1 开始）`)
    }
    const target = rows[n - 1]
    const res = target.kind === 'episode' ? removeEpisode(persona, target.id) : remove(persona, target.id)
    if (!res.ok) fail(`删除失败：${res.reason ?? 'unknown'}`)
    const label = target.kind === 'episode' ? `#e${res.removed.id}` : `#${res.removed.id}`
    console.log(`已删除 ${label}（${target.kind === 'episode' ? '原句' : 'gist'}）「${res.removed.text}」`)
    break
  }

  case 'export': {
    const data = exportAll()
    const json = JSON.stringify(data, null, 2)
    if (arg1) {
      fs.mkdirSync(path.dirname(path.resolve(arg1)), { recursive: true })
      fs.writeFileSync(arg1, json + '\n')
      console.error(`已导出 ${data.total} 条记忆到 ${arg1}`)
    } else {
      // 默认 stdout：方便 `> backup.json`；提示走 stderr，不污染 JSON。
      console.error(`已导出 ${data.total} 条记忆（stdout）`)
      console.log(json)
    }
    break
  }

  case 'import': {
    if (!arg1) fail('缺少文件。用法：node scripts/mem.js import <file>')
    let data
    try {
      data = JSON.parse(fs.readFileSync(arg1, 'utf8'))
    } catch (err) {
      fail(`导入失败：读不到或不是合法 JSON（${err?.message ?? err}）`, 2)
    }
    const res = importAll(data)
    if (!res.ok) {
      if (res.error === 'version') {
        fail(`导入失败：版本 ${res.version} 与当前支持的 ${res.expected} 不一致`, 2)
      }
      fail('导入失败：文件结构不合法（需要 version=1 + personas）', 2)
    }
    console.log(`已导入：${res.personas} 个人格 · ${res.records} 条记忆`)
    break
  }

  case 'stats': {
    const personas = arg1 ? [arg1] : listPersonas()
    if (personas.length === 0) {
      console.log('（暂无记忆）')
      break
    }
    let total = 0
    console.log()
    for (const p of personas) {
      const s = stats(p)
      total += s.messages
      console.log(`  ${p.padEnd(20)} ${String(s.messages).padStart(5)} 条 · ${s.sessions} 个会话`)
    }
    console.log(`\n  合计 ${total} 条 · 数据目录 ${HOME}\n`)
    break
  }

  default:
    usage()
    process.exit(command ? 1 : 0)
}
