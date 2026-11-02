/**
 * P1 自测：episode 双痕迹 + 海马绑定图 + 细节门控（纯函数；§5 才跑）
 * 运行：node episode.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-ep-'))
process.env.MEMORA_HOME = tmp

const {
  appendEpisode,
  listEpisodes,
  reloadEpisodes,
  buildGraph,
  neighborsOf,
  pickDetails,
  episodeStats,
  consolidate,
} = await import('./episode.js')

let pass = 0
let fail = 0
const rows = []
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++
  rows.push([ok ? 'PASS' : 'FAIL', name, detail])
}
const ties = (graph, a, b) => neighborsOf(graph, a).some((n) => n.id === String(b))

// ---- 1. 追加后 load 条数一致 ----
const p1 = 'ep_basic'
const a1 = appendEpisode({
  persona: p1, session: 's1', text: '我家猫叫豆豆，是领养的橘猫',
  createdAt: '2026-10-20T10:00:00+08:00', kws: ['豆豆', '橘猫'],
})
const a2 = appendEpisode({
  persona: p1, session: 's1', text: '豆豆是领养的，刚来才两个月',
  createdAt: '2026-10-20T10:10:00+08:00', kws: ['豆豆', '橘猫'],
})
check('追加返回递增 id', a1.id > 0 && a2.id === a1.id + 1, JSON.stringify([a1, a2]))
check('内存 2 条', episodeStats(p1).episodes === 2, JSON.stringify(episodeStats(p1)))
const reloaded = reloadEpisodes(p1)
check('重新载入仍是 2 条', reloaded.episodes.length === 2, JSON.stringify(listEpisodes(p1).map((e) => e.id)))

// ---- 2. 同 session 同文本去重 ----
const dup = appendEpisode({
  persona: p1, session: 's1', text: '我家猫叫豆豆，是领养的橘猫',
  createdAt: '2026-10-20T10:20:00+08:00', kws: ['豆豆'],
})
check('同文本重复返回 duplicate', dup.duplicate === true && dup.id === a1.id, JSON.stringify(dup))
check('去重后仍是 2 条', listEpisodes(p1).length === 2)

// ---- 3. 绑定图：同会话相邻 + 共享 kws 建边、边权 1+0.5×共享数 ----
const g1 = buildGraph(p1, [])
const edge12 = neighborsOf(g1, a1.id).find((n) => n.id === String(a2.id))
check('相邻同 kws 建边', Boolean(edge12), JSON.stringify(neighborsOf(g1, a1.id)))
check('边权 = 1 + 0.5×2', edge12?.w === 2, JSON.stringify(edge12))

// ---- 4. 间隔 >30 分钟且无共享 kws：不建边 ----
const a3 = appendEpisode({
  persona: p1, session: 's1', text: '我下个月要考雅思',
  createdAt: '2026-10-20T11:00:00+08:00', kws: ['雅思', '备考'],
})
const g2 = buildGraph(p1, [])
check('超时且无共享 kws 不建边', !ties(g2, a2.id, a3.id), JSON.stringify(neighborsOf(g2, a2.id)))

// ---- 5. 间隔 >30 分钟但共享 ≥2 kws：仍建边 ----
const a4 = appendEpisode({
  persona: p1, session: 's1', text: '雅思这次要考七分',
  createdAt: '2026-10-20T11:10:00+08:00', kws: ['雅思', '备考'],
})
const a5 = appendEpisode({
  persona: p1, session: 's1', text: '雅思报名费挺贵的',
  createdAt: '2026-10-20T12:10:00+08:00', kws: ['雅思', '备考'],
})
const g3 = buildGraph(p1, [])
check('超时但共享 kws 仍建边', ties(g3, a4.id, a5.id), JSON.stringify(neighborsOf(g3, a4.id)))

// ---- 6. episode → gist 反查 ----
const gists = [{ id: 900, source_episode_ids: [a1.id] }]
const g4 = buildGraph(p1, gists)
const l = buildGraph(p1, gists) // 缓存命中，不重复建
check('gist 反查到 episode', g4.gistsByEpisode.get(String(a1.id))?.includes('900'), JSON.stringify([...g4.gistsByEpisode]))
check('episode 反查到 gist', g4.episodesByGist.get('900')?.includes(String(a1.id)), JSON.stringify([...g4.episodesByGist.entries()]))
check('无 gist 链接的 episode 不在反查表', !l.gistsByEpisode.has(String(a2.id)))

// ---- 7. 细节门控命中：细节问法 + 至多 1 条 + 截 60 字 ----
const p2 = 'ep_gate_a'
const longText = '豆豆是领养的橘猫，刚来的时候才两个月大，特别怕生，躲在沙发底下好几天不肯出来，后来慢慢就好了'
const b1 = appendEpisode({
  persona: p2, session: 's2', text: longText,
  createdAt: '2026-10-20T10:00:00+08:00', kws: ['豆豆', '领养'],
})
const gists2 = [{ id: 901, source_episode_ids: [b1.id] }]
const hit = pickDetails('豆豆是怎么来的', [{ id: 901 }], { persona: p2, gists: gists2, topScore: 0.8 })
check('细节题命中 1 条', hit.length === 1, JSON.stringify(hit))
check('细节截 60 字', Array.from(hit[0]?.text ?? '').length === 60, String(Array.from(hit[0]?.text ?? '').length))
check('细节带日期', hit[0]?.date === '2026-10-20', JSON.stringify(hit[0]))

// ---- 8. 细节门控不命中：无细节词 + 高分 gist ----
const miss = pickDetails('今天天气不错', [{ id: 901 }], { persona: p2, gists: gists2, topScore: 0.8 })
check('普通问法不注细节', miss.length === 0, JSON.stringify(miss))

// ---- 9. 门控 B：kws 命中 ≥2 且 gist 最高分 <0.25 ----
const b2 = pickDetails('豆豆橘猫怎么样', [{ id: 1234 }], { persona: p2, gists: gists2, topScore: 0.1 })
check('低分 + kws 命中 ≥2 命中细节', b2.length === 1, JSON.stringify(b2))
const b3 = pickDetails('豆豆橘猫怎么样', [{ id: 1234 }], { persona: p2, gists: gists2, topScore: 0.6 })
check('高分时不走门控 B', b3.length === 0, JSON.stringify(b3))

// ---- 10. archived 的 episode 不进图、不被选中 ----
const p3 = 'ep_archived'
const c1 = appendEpisode({
  persona: p3, session: 's3', text: '豆豆是领养的橘猫',
  createdAt: '2026-10-20T10:00:00+08:00', kws: ['豆豆', '领养'],
})
const epFile = path.join(tmp, `memora-${p3}.episodes.jsonl`)
const patched = fs.readFileSync(epFile, 'utf8').split('\n').filter(Boolean)
  .map((line) => {
    const row = JSON.parse(line)
    if (row.id === c1.id) row.archived = true
    return JSON.stringify(row)
  }).join('\n') + '\n'
fs.writeFileSync(epFile, patched)
reloadEpisodes(p3)
const g5 = buildGraph(p3, [])
check('归档节点不进图', neighborsOf(g5, c1.id).length === 0 && g5.nodes === 0)
const arch = pickDetails('豆豆是怎么来的', [{ id: 902 }], {
  persona: p3, gists: [{ id: 902, source_episode_ids: [c1.id] }], topScore: 0.9,
})
check('归档不被选中', arch.length === 0, JSON.stringify(arch))

// ---- 11. P2 巩固：同文本 gist 合并（去标点/空白）----
const mem = await import('./memory.js')
const p4 = 'ep_consolidate'
mem.ingest({ persona: p4, session: 's1', text: '我家猫叫豆豆。', createdAt: '2026-10-20T10:00:00+08:00' })
mem.ingest({ persona: p4, session: 's2', text: '我家猫叫豆豆', createdAt: '2026-10-22T10:00:00+08:00' })
const sc = await consolidate(p4)
check('巩固合并同文本 gist', sc.merged === 1 && mem.list(p4).length === 1, JSON.stringify(sc))
check('合并保留最新 created_at', mem.list(p4)[0]?.created_at.slice(0, 10) === '2026-10-22', mem.list(p4)[0]?.created_at)

// ---- 12. P2 巩固：episode 复述 2 次 → 提炼 gist（挂 source_episode_ids）----
const p5 = 'ep_promote2'
const g5 = mem.ingest({ persona: p5, session: 's1', text: '我家猫叫豆豆，是领养的橘猫', createdAt: '2026-10-20T10:00:00+08:00' })
const e5 = appendEpisode({
  persona: p5, session: 's1', text: '我家猫叫豆豆，是领养的橘猫',
  createdAt: '2026-10-20T10:00:00+08:00', kws: ['豆豆', '领养'],
})
mem.replace({
  persona: p5, id: g5.id, facts: ['猫叫豆豆', '猫是领养的橘猫'],
  kws: [['豆豆'], ['领养', '橘猫']], episodeIds: [e5.id, e5.id],
})
const cands5 = mem.list(p5).map((x) => ({ id: x.id }))
pickDetails('豆豆是怎么来的', cands5, { persona: p5, gists: mem.list(p5), topScore: 0.9 })
pickDetails('豆豆是怎么来的', cands5, { persona: p5, gists: mem.list(p5), topScore: 0.9 })
const sp = await consolidate(p5)
const promoted5 = mem.list(p5).filter((x) => (x.source_episode_ids ?? []).map(String).includes(String(e5.id)))
check('复述 2 次提炼成 gist', sp.promoted === 1 && promoted5.length >= 1, JSON.stringify(sp))
check('提炼后 episode 置 promoted', listEpisodes(p5).find((e) => e.id === e5.id)?.promoted === true)

// ---- 13. P2 巩固：salience 每次衰减 ×0.98 ----
const p6 = 'ep_decay'
appendEpisode({ persona: p6, session: 's1', text: '豆豆是领养的', createdAt: '2026-10-20T10:00:00+08:00', kws: ['豆豆'] })
const salienceBefore = listEpisodes(p6)[0].salience
await consolidate(p6)
const salienceAfter = listEpisodes(p6)[0].salience
check('每次巩固 salience×0.98', Math.abs(salienceAfter - salienceBefore * 0.98) < 1e-6, JSON.stringify({ salienceBefore, salienceAfter }))

// ---- 输出 ----
console.log('\n  P1 · episode 自测\n')
for (const [s, n, d] of rows) console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}${s === 'FAIL' && d ? `  → ${d}` : ''}`)
console.log(`\n  ${pass} passed, ${fail} failed  (home: ${tmp})\n`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
