/**
 * Memora v2/P1 · episode 模块（快痕迹 + 海马绑定图）
 *
 * 双痕迹（§2.1/§2.3）：
 * - gist 留在 `memora-<persona>.jsonl`（memory.js，慢痕迹、30 天半衰）；
 * - 原句细节留在这个新文件 `memora-<persona>.episodes.jsonl`（快痕迹、7–14 天）。
 *   老代码完全忽略它，回滚只删新文件，不动 gist。
 *
 * 一行 episode：
 *   { id, session_id, text, created_at, kws, salience, recall_count,
 *     promoted, archived }
 *
 * 海马绑定图（§2.2，纯内存、不落盘）：
 * - 同 session 按时间排序，相邻两条间隔 ≤30 分钟或共享 ≥2 个 kws 才建边；
 * - 边权 `1 + 0.5 × 共享 kws 数`，每个节点最多 8 个邻居；
 * - 反向表：episode → 由它提炼出的 gist（gist.source_episode_ids 的反查）。
 *
 * 细节门控（§2.3，代码判定，不让模型选）：
 * - 查询命中 `细节|具体|当时|原话|怎么来的|为什么|后来…`，或
 * - 查询与某 episode 的 kws 命中 ≥2 且 gist 最高分 <0.25；
 * - 命中后至多 1 条、截 60 字，只给「属于本次命中的 gist」的那些 episode
 *   （没有链接的 v1 旧数据按关键词兜底）。
 *
 * 注意：本文件不 import memory.js 的运行时状态，只借 `extractKeywords`
 * （函数声明，循环依赖安全）；图与计数都在内存，落盘留给 P2 巩固。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { extractKeywords } from './memory.js'

const MEMORA_HOME = process.env.MEMORA_HOME || path.join(os.homedir(), '.memora')
const MAX_EPISODES = Number(process.env.MEMORA_MAX_EPISODES) || 3000
const EDGE_GAP_MS = 30 * 60 * 1000
const EDGE_SHARED_KWS = 2
const MAX_NEIGHBORS = 8
const DETAIL_MAX_CHARS = 60
/** 巩固：超过 90 天且显著度 <0.3 的 episode 归档（不删行）。 */
const ARCHIVE_DAYS = 90
/** 每次巩固的 salience 衰减系数（§2.5）。 */
const DECAY = 0.98

/** 细节题判定：命中即允许注入 1 条原句（§2.3 步骤 3）。 */
export const DETAIL_GATE_RE = /细节|具体|当时|原话|怎么(来|认识|回事)|为什么|后来|然后呢/

/** persona -> { episodes, byId, seen, maxId, graph, graphKey } */
const stores = new Map()

function fileFor(persona) {
  const safe = String(persona || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(MEMORA_HOME, `memora-${safe}.episodes.jsonl`)
}

const charLen = (s) => Array.from(String(s ?? '')).length

function normalizeKws(list, text) {
  const src = Array.isArray(list) && list.length ? list : extractKeywords(text)
  const out = []
  for (const v of src) {
    const s = String(v ?? '').trim()
    if (charLen(s) < 2 || out.includes(s)) continue
    out.push(s)
    if (out.length >= 5) break
  }
  return out
}

/** 载入/规范化一行（磁盘行与内存行同一形态）。 */
function normalizeRow(raw, fallbackId) {
  const text = String(raw?.text ?? '').trim()
  if (!text) return null
  return {
    id: Number(raw?.id) || fallbackId,
    session_id: String(raw?.session_id ?? ''),
    text,
    created_at: raw?.created_at || new Date().toISOString(),
    kws: normalizeKws(raw?.kws, text),
    salience: Number.isFinite(raw?.salience) ? Math.max(0, Math.min(1, Number(raw.salience))) : 1,
    recall_count: Number.isFinite(raw?.recall_count) && raw.recall_count > 0 ? Math.floor(raw.recall_count) : 0,
    promoted: Boolean(raw?.promoted),
    archived: Boolean(raw?.archived),
    ...(typeof raw?.last_recalled_at === 'string' && raw.last_recalled_at
      ? { last_recalled_at: raw.last_recalled_at }
      : {}),
  }
}

function persistEpisode(e) {
  const row = {
    id: e.id,
    session_id: e.session_id,
    text: e.text,
    created_at: e.created_at,
    kws: e.kws,
    salience: e.salience,
    recall_count: e.recall_count,
    promoted: e.promoted,
    archived: e.archived,
  }
  if (e.last_recalled_at) row.last_recalled_at = e.last_recalled_at
  return JSON.stringify(row)
}

function loadStore(persona) {
  const st = { episodes: [], byId: new Map(), seen: new Map(), maxId: 0, graph: null, graphKey: '' }
  const file = fileFor(persona)
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    stores.set(persona, st)
    return st
  }

  const bad = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      bad.push(line)
      continue
    }
    const row = normalizeRow(parsed, st.maxId + 1)
    if (!row) {
      bad.push(line)
      continue
    }
    addEpisode(st, row)
  }

  if (bad.length) {
    // 坏行只备份，不重写文件：episode 也是 append-only，宁可留噪声。
    try { fs.appendFileSync(`${file}.bad`, bad.join('\n') + '\n') } catch { /* 备份失败不影响主流程 */ }
  }

  stores.set(persona, st)
  return st
}

function addEpisode(st, e) {
  const idx = st.episodes.length
  st.episodes.push(e)
  st.byId.set(String(e.id), e)
  st.seen.set(`${e.session_id}\u0000${e.text}`, e.id)
  if (e.id > st.maxId) st.maxId = e.id
  st.graph = null // 结构变了，图下次用到再重建
  return idx
}

function getStore(persona) {
  return stores.get(persona) || loadStore(persona)
}

/**
 * 追加一条 episode（原句 + 自算 kws）。同 session 同文本视为重复，返回已有 id。
 * 写失败直接抛给调用方；抽取队列会吞掉，原句仍按 v1 留在 gist。
 * @returns {{ id: number|null, duplicate: boolean, skipped?: string }}
 */
export function appendEpisode({ persona, session, text, createdAt, kws, salience } = {}) {
  const st = getStore(persona)
  const clean = String(text ?? '').trim()
  if (!clean) return { id: null, duplicate: false, skipped: 'empty' }
  if (charLen(clean) > 2000) return { id: null, duplicate: false, skipped: 'too-long' }

  const key = `${String(session ?? '')}\u0000${clean}`
  if (st.seen.has(key)) return { id: st.seen.get(key), duplicate: true }

  const ep = normalizeRow({
    id: st.maxId + 1,
    session_id: String(session ?? ''),
    text: clean,
    created_at: createdAt || new Date().toISOString(),
    kws,
    salience,
  }, st.maxId + 1)

  fs.mkdirSync(MEMORA_HOME, { recursive: true })
  fs.appendFileSync(fileFor(persona), persistEpisode(ep) + '\n')
  addEpisode(st, ep)
  return { id: ep.id, duplicate: false }
}

/** 全部 episode（按 id 升序；默认含已归档，CLI 用）。 */
export function listEpisodes(persona, { includeArchived = true } = {}) {
  return getStore(persona).episodes
    .filter((e) => includeArchived || !e.archived)
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((e) => ({ ...e, kws: e.kws.slice() }))
}

/** 自检/CLI 用的统计。 */
export function episodeStats(persona) {
  const st = getStore(persona)
  return {
    persona,
    episodes: st.episodes.length,
    archived: st.episodes.filter((e) => e.archived).length,
    promoted: st.episodes.filter((e) => e.promoted).length,
    sessions: new Set(st.episodes.map((e) => e.session_id)).size,
  }
}

/** 放弃缓存重新读盘（测试 / CLI 改文件后）。 */
export function reloadEpisodes(persona) {
  stores.delete(persona)
  return getStore(persona)
}

/** 删除某人格的 episode 文件（回滚 / 清空；调用方负责确认）。 */
export function resetEpisodes(persona) {
  const st = getStore(persona)
  const deleted = st.episodes.length
  stores.delete(persona)
  try { fs.unlinkSync(fileFor(persona)) } catch { /* 无文件 */ }
  return { deleted }
}

/** 删除一条 episode（CLI del 用），原子重写整份 episode 文件。 */
export function removeEpisode(persona, id) {
  const st = getStore(persona)
  const target = Number(id)
  const idx = st.episodes.findIndex((e) => e.id === target)
  if (idx < 0) return { ok: false, reason: 'not-found' }
  const [ep] = st.episodes.splice(idx, 1)
  st.byId.delete(String(ep.id))
  st.seen = new Map(st.episodes.map((e) => [`${e.session_id}\u0000${e.text}`, e.id]))
  st.graph = null
  rewriteEpisodes(persona, st)
  return { ok: true, removed: { id: ep.id, text: ep.text } }
}

/** 整份 episode 文件原子重写（巩固改元数据时用；行本身不删）。 */
function rewriteEpisodes(persona, st) {
  const file = fileFor(persona)
  const tmp = `${file}.tmp`
  const body = st.episodes.map(persistEpisode).join('\n')
  fs.writeFileSync(tmp, body + (body ? '\n' : ''))
  fs.renameSync(tmp, file)
}

/** 归一化文本：去标点 / 空白 / 大小写，用于「完全相同」判定（§2.5 只合并同文本）。 */
export function normalizeGistText(text) {
  return String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 供 P2 巩固后手动失效图缓存。 */
export function invalidateGraph(persona) {
  const st = stores.get(persona)
  if (st) st.graph = null
}

const tsOf = (e) => Date.parse(e.created_at) || 0

/** 两条 episode 共享的关键词数（双向包含也算，抹平短语粒度差异）。 */
function sharedKws(a, b) {
  const sb = new Set(b)
  let n = 0
  for (const k of new Set(a)) if (sb.has(k)) n++
  return n
}

function pushEdge(adj, a, b, w) {
  let map = adj.get(a)
  if (!map) adj.set(a, (map = new Map()))
  map.set(b, Math.max(map.get(b) || 0, w))
}

/**
 * 重建绑定图（纯内存）。5k gist + 3k episode 目标 <50ms。
 * @param {string} persona
 * @param {Array<{id:number, source_episode_ids?:string[]}>} gists 用来建 episode→gist 反查
 */
export function buildGraph(persona, gists = []) {
  const st = getStore(persona)
  const active = st.episodes.filter((e) => !e.archived)
  const adj = new Map()

  // 同 session、按时间排序，只看相邻两条（§2.2）。
  const bySession = new Map()
  for (const e of active) {
    const key = e.session_id || ''
    let list = bySession.get(key)
    if (!list) bySession.set(key, (list = []))
    list.push(e)
  }
  let edges = 0
  for (const list of bySession.values()) {
    list.sort((a, b) => tsOf(a) - tsOf(b) || a.id - b.id)
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i]
      const b = list[i + 1]
      const gap = Math.abs(tsOf(b) - tsOf(a))
      const shared = sharedKws(a.kws, b.kws)
      if (gap > EDGE_GAP_MS && shared < EDGE_SHARED_KWS) continue
      const w = 1 + 0.5 * shared
      pushEdge(adj, String(a.id), String(b.id), w)
      pushEdge(adj, String(b.id), String(a.id), w)
      edges++
    }
  }

  // 每个节点最多 8 个邻居：按边权取前 8。
  const capped = new Map()
  for (const [id, map] of adj) {
    const list = [...map.entries()]
      .map(([nid, w]) => ({ id: nid, w }))
      .sort((x, y) => y.w - x.w || Number(y.id) - Number(x.id))
      .slice(0, MAX_NEIGHBORS)
    capped.set(id, list)
  }

  // 反向表：episode → gist，gist → episodes（gist 的 source_episode_ids 反查）。
  const gistsByEpisode = new Map()
  const episodesByGist = new Map()
  const activeIds = new Set(active.map((e) => String(e.id)))
  for (const g of Array.isArray(gists) ? gists : []) {
    const gid = String(g?.id ?? '')
    if (!gid) continue
    for (const raw of Array.isArray(g?.source_episode_ids) ? g.source_episode_ids : []) {
      const eid = String(raw ?? '').trim()
      if (!eid || !activeIds.has(eid)) continue
      let gs = gistsByEpisode.get(eid)
      if (!gs) gistsByEpisode.set(eid, (gs = []))
      if (!gs.includes(gid)) gs.push(gid)
      let es = episodesByGist.get(gid)
      if (!es) episodesByGist.set(gid, (es = []))
      if (!es.includes(eid)) es.push(eid)
    }
  }

  const graph = {
    adj: capped,
    gistsByEpisode,
    episodesByGist,
    nodes: active.length,
    edges,
    builtAt: new Date().toISOString(),
  }
  st.graph = graph
  st.graphKey = graphKey(active.length, st.maxId, gists)
  return graph
}

function graphKey(epCount, maxId, gists) {
  let gMax = 0
  for (const g of Array.isArray(gists) ? gists : []) gMax = Math.max(gMax, Number(g.id) || 0)
  return `${epCount}:${maxId}:${Array.isArray(gists) ? gists.length : 0}:${gMax}`
}

/** 取图（按 episode 数/gist 数/maxId 缓存，变更后自动重建）。 */
export function getGraph(persona, gists = []) {
  const st = getStore(persona)
  const active = st.episodes.filter((e) => !e.archived)
  const key = graphKey(active.length, st.maxId, gists)
  if (st.graph && st.graphKey === key) return st.graph
  return buildGraph(persona, gists)
}

/** 某节点的邻居（1 跳），按边权降序。 */
export function neighborsOf(graph, id) {
  return graph?.adj?.get(String(id)) ?? []
}

/** 查询与 episode 的 kws 命中数（≥2 才够门控 B）。 */
function kwHits(docKws, qKws, raw) {
  const list = Array.isArray(docKws) ? docKws : []
  const qset = new Set(qKws)
  let n = 0
  for (const kw of list) {
    if (!kw) continue
    if (qset.has(kw) || raw.includes(kw)) {
      n++
      continue
    }
    let hit = false
    for (const q of qset) {
      if (charLen(q) < 2 || charLen(kw) < 2) continue
      if (kw.includes(q) || q.includes(kw)) {
        hit = true
        break
      }
    }
    if (hit) n++
  }
  return n
}

/**
 * §2.3 细节门控：是否值得给一条原句细节。
 *
 * @param {string} query 用户本轮原话
 * @param {Array<{id:number}>} gistCandidates 本轮召回的 gist（top3，带 id）
 * @param {{persona:string, gists?:Array, topScore?:number}} options
 *   topScore 是 gist 最高分；gists 用于 episode→gist 反查（memory 传入全量）。
 * @returns {Array<{id:number, date:string, text:string, score:number}>} 至多 1 条
 */
export function pickDetails(query, gistCandidates = [], { persona, gists = [], topScore = 0 } = {}) {
  const st = getStore(persona)
  const active = st.episodes.filter((e) => !e.archived)
  if (active.length === 0) return []

  const raw = String(query ?? '').toLowerCase()
  const qKws = extractKeywords(raw)
  const hitsOf = (e) => kwHits(e.kws, qKws, raw)

  // 门控：细节问法（代码判定）或「kws 命中 ≥2 且 gist 没高分」。
  const gateA = DETAIL_GATE_RE.test(raw)
  const gateB = Number(topScore) < 0.25 && active.some((e) => hitsOf(e) >= 2)
  if (!gateA && !gateB) return []

  const graph = getGraph(persona, gists)
  const candIds = new Set((Array.isArray(gistCandidates) ? gistCandidates : [])
    .map((c) => String(c?.id ?? ''))
    .filter(Boolean))
  const linked = candIds.size
    ? active.filter((e) => (graph.gistsByEpisode.get(String(e.id)) ?? []).some((g) => candIds.has(String(g))))
    : []

  // 没有链接（v1 旧数据 / 尚未提炼）：按关键词兜底，绝不把全部 gist 细节倒出来。
  const pool = linked.length ? linked : active.filter((e) => hitsOf(e) >= 2)
  if (pool.length === 0) return []

  pool.sort(
    (a, b) =>
      hitsOf(b) - hitsOf(a) ||
      (b.salience ?? 0) - (a.salience ?? 0) ||
      tsOf(b) - tsOf(a) ||
      b.id - a.id,
  )
  const best = pool[0]
  // §2.3：计数只改内存，P2 巩固时统一落盘。
  best.recall_count = (best.recall_count ?? 0) + 1
  best.last_recalled_at = new Date().toISOString()

  return [{
    id: best.id,
    date: String(best.created_at ?? '').slice(0, 10),
    text: Array.from(String(best.text ?? '')).slice(0, DETAIL_MAX_CHARS).join(''),
    score: Math.round(hitsOf(best) * 100) / 100,
  }]
}

/**
 * v2/P2 · 空闲巩固（全规则、零模型；§2.5）。
 *
 * 一次调用做四件事，全部有预算（默认 200ms，超时下次继续）：
 * 1. 去重合并：归一化文本完全相同的 gist 合成一条（保留最新 created_at，
 *    合并 kws / source_episode_ids / recall_count），旧行删除——这是唯一会
 *    删 gist 行的地方，且只删「同文本副本」。
 * 2. 提炼：episode `recall_count ≥ 2` 且未 promoted → 用 extractRules 生成 gist，
 *    挂 source_episode_ids；抽不出事实也标 promoted，避免每轮重试。
 * 3. 衰减 / 归档：每个 episode `salience ×= 0.98`；>90 天且 <0.3 → archived。
 * 4. 上限滚动：episode 超过 MEMORA_MAX_EPISODES 时归档最旧/最低显著的，绝不删行。
 *
 * 最后把内存里的召回计数统一落盘（flushStats）。调用方必须保证只在 idle 调。
 *
 * @returns {Promise<{merged:number,promoted:number,decayed:number,archived:number,
 *   truncated:number,flushed:boolean,timedOut:boolean,took_ms:number,skipped?:string}>}
 */
export async function consolidate(persona, { budgetMs = 200, now = Date.now() } = {}) {
  if (process.env.MEMORA_CONSOLIDATE === '0') {
    return { merged: 0, promoted: 0, decayed: 0, archived: 0, truncated: 0, flushed: false, timedOut: false, took_ms: 0, skipped: 'disabled' }
  }
  const t0 = Date.now()
  const deadline = t0 + (Number(budgetMs) > 0 ? Number(budgetMs) : 200)
  const summary = {
    merged: 0, promoted: 0, decayed: 0, archived: 0, truncated: 0,
    flushed: false, timedOut: false, took_ms: 0,
  }
  const expired = () => Date.now() > deadline

  const memory = await import('./memory.js')
  const { extractRules } = await import('./extract.js')
  const st = getStore(persona)

  // ── 1. 去重合并（同文本副本）────────────────────────────
  const gists = memory.list(persona)
  const groups = new Map()
  for (const g of gists) {
    if (g.superseded_by) continue // 被纠正的旧事实不参与合并
    const key = normalizeGistText(g.text)
    if (!key) continue
    let arr = groups.get(key)
    if (!arr) groups.set(key, (arr = []))
    arr.push(g)
  }
  for (const arr of groups.values()) {
    if (arr.length < 2) continue
    if (expired()) { summary.timedOut = true; break }
    arr.sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) || b.id - a.id)
    const keep = arr[0]
    const drop = arr.slice(1).map((g) => g.id)
    const kws = []
    const srcIds = []
    let recallCount = 0
    let lastRecalled = ''
    for (const g of arr) {
      for (const k of g.kws ?? []) if (!kws.includes(k)) kws.push(k)
      for (const s of g.source_episode_ids ?? []) {
        const v = String(s)
        if (!srcIds.includes(v)) srcIds.push(v)
      }
      recallCount += Number(g.recall_count) || 0
      if (String(g.last_recalled_at ?? '') > lastRecalled) lastRecalled = String(g.last_recalled_at ?? '')
    }
    memory.updateGist(persona, keep.id, {
      kws,
      source_episode_ids: srcIds,
      recall_count: recallCount,
      ...(lastRecalled ? { last_recalled_at: lastRecalled } : {}),
    })
    memory.removeMany(persona, drop)
    summary.merged += drop.length
  }

  // ── 2. 提炼：被复述 ≥2 次的 episode 升成 gist ──────────────
  const candidates = st.episodes.filter(
    (e) => !e.archived && !e.promoted && (e.recall_count ?? 0) >= 2,
  )
  for (const e of candidates) {
    if (expired()) { summary.timedOut = true; break }
    let facts = []
    let kws = []
    try {
      const out = extractRules(e.text)
      facts = (Array.isArray(out?.facts) ? out.facts : []).filter(Boolean).slice(0, 2)
      kws = Array.isArray(out?.kws) ? out.kws : []
    } catch {
      facts = []
    }
    e.promoted = true // 即便抽不出事实也置位，避免每轮空转
    summary.promoted++
    for (let i = 0; i < facts.length; i++) {
      memory.appendGist({
        persona,
        session: `promote:${e.session_id}`,
        text: facts[i],
        createdAt: e.created_at,
        kws: kws[i],
        sourceEpisodeIds: [e.id],
        salience: Math.max(0.5, e.salience ?? 1),
      })
    }
  }

  // ── 3. 衰减 / 归档 ─────────────────────────────────────
  for (const e of st.episodes) {
    if (e.archived) continue
    if (expired()) { summary.timedOut = true; break }
    e.salience = Math.round(Math.max(0, Math.min(1, (e.salience ?? 1) * DECAY)) * 10000) / 10000
    summary.decayed++
    const ageDays = (now - (Date.parse(e.created_at) || now)) / 86_400_000
    if (ageDays > ARCHIVE_DAYS && e.salience < 0.3) {
      e.archived = true
      summary.archived++
    }
  }

  // ── 4. 上限滚动：只归档，不删行 ─────────────────────────
  const active = st.episodes.filter((e) => !e.archived)
  const excess = active.length - MAX_EPISODES
  if (excess > 0) {
    const victims = active.slice().sort(
      (a, b) =>
        (a.promoted ? 1 : 0) - (b.promoted ? 1 : 0) ||
        (a.salience ?? 1) - (b.salience ?? 1) ||
        tsOf(a) - tsOf(b),
    )
    for (let i = 0; i < excess; i++) {
      victims[i].archived = true
      summary.truncated++
    }
  }

  if (summary.promoted || summary.decayed || summary.archived || summary.truncated) {
    rewriteEpisodes(persona, st)
    st.graph = null
  }
  try { summary.flushed = Boolean(memory.flushStats(persona).flushed) } catch { /* 计数落盘失败不影响 */ }
  st.graph = null
  summary.took_ms = Date.now() - t0
  return summary
}
