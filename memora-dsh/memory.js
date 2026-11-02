/**
 * Memora P0/P1.0 · memory module (in-process)
 *
 * 替代原计划的 FastAPI 引擎：分词、落盘、召回全部在插件进程内完成。
 *
 * 设计要点
 * - 存储：每个人格一个 JSONL（`~/.memora/memora-<persona>.jsonl`），追加写；
 *   persona 之间物理隔离，跨人格查询在代码层就不可能发生。
 * - 分词：中文 bigram + ASCII 词，零依赖（不引 jieba）。
 * - 召回：内存倒排索引，1k 条 < 5ms；打分 = 命中数 / sqrt(文档 token 数) × 时间衰减。
 * - 幂等：`(session_id, text)`，重复写入返回同一个 id。
 * - 容错：坏行跳过并备份到 `.bad`；超过 5k 条滚动截断最旧一半。
 * - P1.0：`replace` 把一条原句原子替换成 0–2 条事实（空闲时调用）。
 * - M1：每条记录带 1–5 个 `kws`（2–10 字的关键词），召回时
 *   0.6 × bigram 分 + 0.4 × kws 命中率；老记录没有 `kws` → 纯 bigram。
 * - v2/P0：本文件只存 gist（慢痕迹）。新写入带 `kind:'gist'`，老行无 `kind`
 *   按 gist 读；`replace` 可挂 `source_episode_ids`（对应 episode 的 id），
 *   另有 `salience` / `recall_count` / `last_recalled_at` / `superseded_by`
 *   等增量字段，一律原样保留，不做批量迁移。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { pickDetails } from './episode.js'

const MEMORA_HOME = process.env.MEMORA_HOME || path.join(os.homedir(), '.memora')
const MAX_RECORDS = Number(process.env.MEMORA_MAX_RECORDS) || 5000
const HALF_LIFE_DAYS = 30

/** bigram 停用词：高频、无区分度的词，宁少勿多。
 *  其中「喜欢/讨厌/要去/上次」这类谓词与时间词是负样本误召的主因
 *  （"我喜欢爬山" 会命中 "不太喜欢被追问"），必须在 P0 就压掉。 */
const STOPWORDS = new Set([
  '我们', '你们', '他们', '她们', '这个', '那个', '这些', '那些',
  '什么', '怎么', '怎样', '可以', '没有', '就是', '不是', '一个', '一些',
  '还有', '然后', '因为', '所以', '但是', '如果', '已经', '自己',
  '觉得', '知道', '时候', '现在', '今天', '明天', '昨天', '最近',
  '一下', '这样', '那样', '这么', '那么', '还是', '或者', '而且',
  '不过', '其实', '应该', '可能', '需要', '起来', '出来', '过来',
  '喜欢', '讨厌', '想要', '要去', '想说', '说过', '上次', '一般',
  '希望', '打算', '开心', '难过', '麻烦', '真的', '确实',
  'the', 'and', 'for', 'with', 'that', 'this', 'have', 'you', 'are',
])

/** 查询侧同义扩展：只补「问题问法 ≠ 原话用词」的常用缺口。
 *  M1 用关键词增强替代向量召回，这张表只保留演示里高频的几组。 */
const SYNONYMS = [
  ['周末', ['周六', '周日']],
  ['睡', ['睡眠', '睡觉']],
  ['上班', ['工作']],
  ['妈', ['妈妈']],
  ['考试', ['备考']],
  ['准备', ['备考']],
  ['电话', ['手机']],
  ['手机', ['电话']],
]

/** persona -> { records, index, seen, maxId } */
const stores = new Map()

/**
 * 问句判定：只认「问号结尾」和「吗 / 呢 结尾」。
 * 不用"什么/怎么"这类词判定——"还没想好送什么"是陈述句，误杀会丢事实。
 */
const QUESTION_TAIL = /([?？]|吗|呢)\s*$/

export function looksLikeQuestion(text) {
  return QUESTION_TAIL.test(String(text ?? '').trim())
}

function fileFor(persona) {
  const safe = String(persona || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(MEMORA_HOME, `memora-${safe}.jsonl`)
}

/**
 * 中文 bigram + ASCII 词。返回去重后的 token 数组。
 * 纯标点 / 空白返回 []。
 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  const out = new Set()
  const re = /[\u4e00-\u9fff]+|[a-z0-9_]+/g
  let m
  while ((m = re.exec(s)) !== null) {
    const run = m[0]
    if (/^[a-z0-9_]+$/.test(run)) {
      if (run.length >= 2 && !STOPWORDS.has(run)) out.add(run)
      continue
    }
    if (run.length === 1) continue // 单字噪声太大，丢弃
    for (let i = 0; i + 1 < run.length; i++) {
      const bg = run.slice(i, i + 2)
      if (!STOPWORDS.has(bg)) out.add(bg)
    }
  }
  return [...out]
}

// ── M1 · 关键词（kws）────────────────────────────────────
//
// 目标：给每条记忆留 1–5 个 2–10 字的「内容词」，让「考试准备得怎么样」这种
// 换说法查询能借同义词表命中「在备考」。不引分词器：按结构助词切段 →
// 剥功能词/口语前缀 → 长段按连接词再切 → 补两字前后缀，最后过滤噪声。

const MAX_KWS = 5
const KW_MAX_CHARS = 10

/** 结构助词 / 标点：切段后不会破坏词内部的语义。 */
const KW_SEP_RE = /[的了着过吗呢吧啊呀哦嘛啦哈嗯噢诶呗捏得、。，,;；!！?？\s"“”'‘’`~～…·\-—_/\\()（）\[\]【】:：]+/

/** 段内功能词（按长度降序切，保证「怎么样」先于「怎么」）。 */
const KW_FUNC_WORDS = [
  '我们', '你们', '他们', '她们', '它们', '大家', '自己',
  '这个', '那个', '这些', '那些', '这样', '那样', '这么', '那么',
  '我家', '你家', '他家', '她家', '那只', '这只', '哪种', '哪个', '哪家',
  '什么', '怎么', '怎样', '怎么样', '如何', '为什么', '哪里', '哪儿', '哪些', '多少', '几个', '是不是',
  '可以', '没有', '就是', '不是', '一个', '一些', '还有', '然后', '因为', '所以', '但是', '不过',
  '而且', '如果', '已经', '其实', '觉得', '知道', '时候', '现在', '最近', '今天', '明天', '昨天',
  '前段时间', '这两天', '这几天', '一直', '经常', '每天', '平时', '别人', '非常', '特别', '比较',
  '有点', '有些', '不太', '一点', '一下', '真的', '确实', '应该', '可能', '需要', '希望', '打算',
  '想要', '喜欢', '讨厌', '东西', '事情', '关于', '上次', '之前', '以后', '后来', '还是', '或者',
  '的话', '容易', '起来',
].sort((a, b) => Array.from(b).length - Array.from(a).length)

/** 段内连接词：只放几乎不会出现在名词内部的单字。 */
const KW_CONNECTOR_RE = /[叫是去来想要有在跟和与给对从到就才都也又还而并或]/

/** 段首功能词 / 代词，循环剥。 */
const KW_LEAD_RE = /^[我你他她它咱俺您这那哪谁们是不没别也都就才又还而且并或和与跟同给对把被从向在于有要会能可将让使很挺太更最极真已再刚正好]+/

/** 段尾语气词。 */
const KW_TAIL_RE = /[的了吗呢吧啊呀哦嘛啦着呢哈嗯噢呗捏]+$/

/** 多字动词前缀（"学做手冲咖啡" → "手冲咖啡"）。 */
const KW_VERB_PREFIX = ['学做', '学会', '想要', '打算', '开始', '继续', '坚持']

/** 段首单字动词（"看产品经理" → "产品经理"）；剥完至少剩 2 字。 */
const KW_VERB_LEAD_RE = /^(?:看|打|换|睡|吃|喝|玩|养|住|买|洗|练|做|学|写|读|听)(?=.)/

/** 两字前后缀里的噪声。 */
const KW_NOISE = new Set([
  '个月', '下个', '上个', '这个', '那个', '一个', '两个', '几个', '时候', '现在',
  '什么', '怎么', '如何', '今年', '那只', '这只', '哪家', '哪些', '觉得', '知道',
  '我们', '你们', '他们', '好送', '来着',
])

/** 前后缀候选里带这些字 → 是碎片（"猫今"「果吃」），不当作关键词。 */
const KW_NOISY_CHAR_RE = /[的了着过吗呢吧啊呀哦嘛啦哈嗯噢诶呗捏我你他她它咱您这那哪谁们是不没别也都就才又还而且并或和与跟同给对把被从向在于有要会能可将让使很挺太更最极真已再刚正今明昨前后吃喝看睡住考说做学打换买洗玩养读听写讲谈]/

const kwLen = (s) => Array.from(String(s ?? '')).length

function cleanKwPiece(piece) {
  let c = String(piece ?? '')
  for (let i = 0; i < 4; i++) {
    const before = c
    c = c.replace(KW_LEAD_RE, '').replace(KW_TAIL_RE, '')
    if (c === before) break
  }
  return c.trim()
}

/** 只保留 2–10 字、有实义、不重复的关键词，最多 5 个。 */
function sanitizeKws(list) {
  const out = []
  for (const v of Array.isArray(list) ? list : []) {
    const s = String(v ?? '').trim()
    const n = kwLen(s)
    if (n < 2 || n > KW_MAX_CHARS) continue
    if (!/[a-z\u4e00-\u9fff]/i.test(s)) continue
    if (STOPWORDS.has(s) || KW_NOISE.has(s)) continue
    if (out.includes(s)) continue
    out.push(s)
    if (out.length >= MAX_KWS) break
  }
  return out
}

/**
 * 从一句原话 / 一条事实里抽 1–5 个关键词（零依赖、纯同步）。
 * `ingest` 存原句时用它；`extract` 把事实替换进来时每条例事各调一次。
 */
export function extractKeywords(text) {
  const raw = String(text ?? '').toLowerCase()
  const out = []
  const push = (v) => {
    const s = String(v ?? '').trim()
    if (!s || out.length >= MAX_KWS) return
    if (!sanitizeKws([s]).length) return
    if (!out.includes(s)) out.push(s)
  }

  for (const run of raw.split(KW_SEP_RE)) {
    if (!run.trim()) continue
    // 先按多字功能词切（如 "考试准备得怎么样" → "考试准备"）。
    let parts = [run]
    for (const word of KW_FUNC_WORDS) {
      if (!parts.some((p) => p.includes(word))) continue
      const next = []
      for (const p of parts) next.push(...p.split(word))
      parts = next
    }
    for (const part of parts) {
      for (let sub of part.split(KW_CONNECTOR_RE)) {
        for (const vp of KW_VERB_PREFIX) {
          if (sub.startsWith(vp) && kwLen(sub) > kwLen(vp)) sub = sub.slice(vp.length)
        }
        let c = cleanKwPiece(sub)
        if (!c) continue
        const stripped = c.replace(KW_VERB_LEAD_RE, '')
        if (kwLen(stripped) >= 2) c = stripped
        const n = kwLen(c)
        if (n < 2) continue
        if (n > KW_MAX_CHARS) c = Array.from(c).slice(0, KW_MAX_CHARS).join('')
        push(c)
        const affix = (s) => {
          if (!KW_NOISY_CHAR_RE.test(s)) push(s)
        }
        if (n >= 3) affix(Array.from(c).slice(-2).join(''))
        if (n >= 4) affix(Array.from(c).slice(0, 2).join(''))
      }
    }
  }
  return out
}

// ── v2 增量字段（gist 行）────────────────────────────────
//
// `kind`：只有 'gist' / 缺省两种；episode 存在独立文件（episode.js），
//   本文件的记录一律按 gist 处理。
// `source_episode_ids`：这条 gist 由哪些 episode 提炼而来。
// `salience`：0–1 显著度，巩固时按批次衰减。
// `recall_count` / `last_recalled_at`：召回次数与最后召回时间。
// `superseded_by`：被哪条新 gist 取代（纠错只标不删）。

const GIST_IDS_MAX = 32

/** 归一化 id 列表：去空、转字符串、去重、截断。 */
function normalizeIds(list) {
  const out = []
  for (const v of Array.isArray(list) ? list : [list]) {
    const s = String(v ?? '').trim()
    if (!s || out.includes(s)) continue
    out.push(s)
    if (out.length >= GIST_IDS_MAX) break
  }
  return out
}

/** 记录上允许透传的 v2 增量字段（undefined 就不写）。 */
function v2Fields(r) {
  const out = {}
  if (Array.isArray(r.source_episode_ids)) {
    const ids = normalizeIds(r.source_episode_ids)
    if (ids.length) out.source_episode_ids = ids
  }
  if (Number.isFinite(r.salience)) out.salience = Math.max(0, Math.min(1, Number(r.salience)))
  if (Number.isFinite(r.recall_count) && r.recall_count > 0) out.recall_count = Math.floor(r.recall_count)
  if (typeof r.last_recalled_at === 'string' && r.last_recalled_at) out.last_recalled_at = r.last_recalled_at
  if (r.superseded_by != null && r.superseded_by !== '') out.superseded_by = Number(r.superseded_by) || String(r.superseded_by)
  return out
}

/** 记录落盘字段：老记录没有 kws 就不写，保证向后兼容。 */
function persistRecord(r) {
  const row = {
    id: r.id,
    session_id: r.session_id,
    text: r.text,
    created_at: r.created_at,
    kind: 'gist',
  }
  if (Array.isArray(r.kws) && r.kws.length) row.kws = r.kws
  Object.assign(row, v2Fields(r))
  return JSON.stringify(row)
}

function addRecord(st, rec) {
  const tokens = tokenize(rec.text)
  const tokenCount = tokens.length
  const idx = st.records.length
  const ts = Date.parse(rec.created_at) || Date.now()
  const row = { ...rec, kind: rec.kind === 'episode' ? 'episode' : 'gist', ts, tokenCount }
  const kws = sanitizeKws(rec.kws)
  if (kws.length) row.kws = kws
  else delete row.kws
  st.records.push(row)
  for (const tok of tokens) {
    let postings = st.index.get(tok)
    if (!postings) st.index.set(tok, (postings = []))
    postings.push(idx)
  }
  st.seen.set(`${rec.session_id}\u0000${rec.text}`, rec.id)
  if (rec.id > st.maxId) st.maxId = rec.id
}

/** 重建倒排索引 / seen / maxId。replace 删改记录后调用（空闲时，低频）。 */
function rebuild(st) {
  st.index = new Map()
  st.seen = new Map()
  let maxId = 0
  for (let i = 0; i < st.records.length; i++) {
    const rec = st.records[i]
    const tokens = tokenize(rec.text)
    rec.tokenCount = tokens.length
    rec.ts = Date.parse(rec.created_at) || Date.now()
    rec.kind = rec.kind === 'episode' ? 'episode' : 'gist'
    if (Array.isArray(rec.source_episode_ids)) rec.source_episode_ids = normalizeIds(rec.source_episode_ids)
    if (Array.isArray(rec.kws)) {
      const kws = sanitizeKws(rec.kws)
      if (kws.length) rec.kws = kws
      else delete rec.kws
    }
    for (const tok of tokens) {
      let postings = st.index.get(tok)
      if (!postings) st.index.set(tok, (postings = []))
      postings.push(i)
    }
    st.seen.set(`${rec.session_id}\u0000${rec.text}`, rec.id)
    if (rec.id > maxId) maxId = rec.id
  }
  st.maxId = maxId
}

function loadStore(persona) {
  const st = { records: [], index: new Map(), seen: new Map(), maxId: 0 }
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
    try {
      const rec = JSON.parse(line)
      if (!rec || typeof rec.text !== 'string' || !rec.text.trim()) continue
      addRecord(st, {
        id: Number(rec.id) || st.maxId + 1,
        session_id: String(rec.session_id ?? ''),
        text: rec.text,
        created_at: rec.created_at || new Date().toISOString(),
        // 老记录没有 kind：按 gist 读（v1 数据不迁移）。
        kind: rec.kind === 'episode' ? 'episode' : 'gist',
        // 老记录没有 kws：保持缺失 → 召回走纯 bigram（向后兼容）。
        ...(Array.isArray(rec.kws) ? { kws: rec.kws } : {}),
        ...v2Fields(rec),
      })
    } catch {
      bad.push(line)
    }
  }

  if (bad.length) {
    try {
      fs.appendFileSync(`${file}.bad`, bad.join('\n') + '\n')
      fs.writeFileSync(file, st.records.map(persistRecord).join('\n') + (st.records.length ? '\n' : ''))
    } catch { /* 备份失败不影响主流程 */ }
  }

  stores.set(persona, st)
  return st
}

function getStore(persona) {
  return stores.get(persona) || loadStore(persona)
}

function rewrite(st, persona) {
  const file = fileFor(persona)
  const tmp = `${file}.tmp`
  const body = st.records.map(persistRecord).join('\n')
  fs.writeFileSync(tmp, body + (body ? '\n' : ''))
  fs.renameSync(tmp, file)
  st.statsDirty = false // 召回计数随本次重写一起落盘
}

/**
 * 写入一条用户消息。重复（同 session + 同文本）返回 duplicate: true。
 * @returns {{ id: number|null, duplicate: boolean, skipped?: string }}
 */
export function ingest({ persona, session, text, createdAt } = {}) {
  const st = getStore(persona)
  const clean = String(text ?? '').trim()
  if (!clean) return { id: null, duplicate: false, skipped: 'empty' }
  if (clean.length > 2000) return { id: null, duplicate: false, skipped: 'too-long' }

  const key = `${String(session ?? '')}\u0000${clean}`
  if (st.seen.has(key)) return { id: st.seen.get(key), duplicate: true }

  // 问句不进记忆（见 looksLikeQuestion 注释）。
  if (looksLikeQuestion(clean)) return { id: null, duplicate: false, skipped: 'question' }

  const tokens = tokenize(clean)
  if (tokens.length === 0) return { id: null, duplicate: false, skipped: 'no-tokens' }

  const rec = {
    id: st.maxId + 1,
    session_id: String(session ?? ''),
    text: clean,
    created_at: createdAt || new Date().toISOString(),
    kind: 'gist',
    kws: extractKeywords(clean),
    salience: 1,
  }

  fs.mkdirSync(MEMORA_HOME, { recursive: true })
  fs.appendFileSync(fileFor(persona), persistRecord(rec) + '\n')
  addRecord(st, rec)

  if (st.records.length > MAX_RECORDS) {
    const keep = st.records.slice(-Math.floor(MAX_RECORDS / 2))
    stores.delete(persona)
    rewrite({ records: keep }, persona)
    loadStore(persona)
  }

  return { id: rec.id, duplicate: false }
}

/**
 * P1.0：用抽取出的原子事实替换一条原句（同一 session / created_at）。
 *
 * - `facts: []` 表示"确认不值得记"（寒暄、纯语气），会删掉原句；
 * - 抽取失败不要调用本函数，原句自动保留（P0 行为）；
 * - 只做内存更新 + 一次原子重写，调用方必须保证在空闲时调用（不是每轮）。
 * - `kws` 与 `facts` 下标对齐（抽取器一并产出）；缺省时按事实现算。
 * - v2：`episodeIds` 与 `facts` 下标对齐（每项是 id 或 id 数组），写进
 *   新 gist 的 `source_episode_ids`；单条事实与原句相同时只补这一字段，
 *   不算"未变化"，以免丢掉 episode 链接。
 *
 * @returns {{ ok: boolean, ids: number[], removed: number[], reason?: string, unchanged?: boolean }}
 */
export function replace(item = {}) {
  const st = getStore(item.persona)
  const res = applyReplace(st, item)
  if (res.changed) rewrite(st, item.persona)
  return res
}

/** 纯内存版 replace：不碰磁盘，供 replaceBatch 一次重写。 */
function applyReplace(st, { id, facts, kws, episodeIds } = {}) {
  const idx = st.records.findIndex((r) => r.id === id)
  if (idx < 0) return { ok: false, reason: 'not-found', ids: [], removed: [], changed: false }

  const rec = st.records[idx]
  const provided = Array.isArray(kws) ? kws : []
  const providedEpisodeIds = Array.isArray(episodeIds) ? episodeIds : []
  const items = []
  const seenText = new Set()
  const list = Array.isArray(facts) ? facts : []
  for (let i = 0; i < list.length; i++) {
    const text = String(list[i] ?? '').trim()
    if (!text || seenText.has(text)) continue
    seenText.add(text)
    const k = sanitizeKws(provided[i])
    const sourceIds = normalizeIds(providedEpisodeIds[i])
    items.push({
      text,
      kws: k.length ? k : extractKeywords(text),
      ...(sourceIds.length ? { source_episode_ids: sourceIds } : {}),
    })
  }

  // 单条事实与原句相同：除了补 episode 链接外不用重写。
  if (items.length === 1 && items[0].text === rec.text) {
    const link = items[0].source_episode_ids
    if (!link?.length) return { ok: true, unchanged: true, ids: [rec.id], removed: [], changed: false }
    rec.kind = 'gist'
    rec.source_episode_ids = normalizeIds([...(rec.source_episode_ids ?? []), ...link])
    if (!Number.isFinite(rec.salience)) rec.salience = 1
    return { ok: true, unchanged: true, ids: [rec.id], removed: [], changed: true }
  }

  st.records.splice(idx, 1)
  rebuild(st)
  st.maxId = Math.max(st.maxId, rec.id) // 保证 id 不回退，避免复用

  const ids = []
  for (const item of items) {
    const key = `${rec.session_id}\u0000${item.text}`
    if (st.seen.has(key)) continue // 同会话已有同文本（另一轮/旧句），不重复落库
    const next = {
      id: st.maxId + 1,
      session_id: rec.session_id,
      text: item.text,
      created_at: rec.created_at,
      kind: 'gist',
      kws: item.kws,
      salience: 1,
      ...(item.source_episode_ids ? { source_episode_ids: item.source_episode_ids } : {}),
    }
    addRecord(st, next)
    ids.push(next.id)
  }

  return { ok: true, ids, removed: [rec.id], count: ids.length, changed: true }
}

/**
 * v2/P2：批量替换（§2.5）。按人格分组，每组一次原子重写。
 * 单条失败（not-found / 异常）不影响其余条目：那一句原样保留。
 *
 * @param {Array<{persona:string,id:number,facts:string[],kws?:any[],episodeIds?:any[]}>} items
 * @returns {{ ok: boolean, results: Array<object> }} results 与 items 下标一一对应
 */
export function replaceBatch(items = []) {
  const list = Array.isArray(items) ? items : []
  const groups = new Map()
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (!item) continue
    let g = groups.get(item.persona)
    if (!g) groups.set(item.persona, (g = []))
    g.push(i)
  }

  const results = new Array(list.length)
  for (const [persona, indexList] of groups) {
    const st = getStore(persona)
    let changed = false
    for (const i of indexList) {
      try {
        const res = applyReplace(st, list[i])
        if (res.changed) changed = true
        results[i] = { ...res, persona }
      } catch (err) {
        results[i] = {
          ok: false, reason: 'error', error: String(err?.message ?? err),
          ids: [], removed: [], changed: false, persona,
        }
      }
    }
    // 一次原子重写；失败时异常上抛，调用方逐条降级（原句保留）。
    if (changed) rewrite(st, persona)
  }
  return { ok: true, results }
}

/**
 * kws 命中率：命中关键词数 / 该条记录的关键词数。
 * - 老记录没有 kws → 返回 null（调用方走纯 bigram，向后兼容）；
 * - 允许双向包含：「手冲」命中「手冲咖啡」，抹平短语粒度差异。
 */
function kwHitRate(docKws, qKwSet, raw) {
  if (!Array.isArray(docKws) || docKws.length === 0) return null
  let matched = 0
  for (const kw of docKws) {
    if (qKwSet.has(kw) || raw.includes(kw)) {
      matched++
      continue
    }
    let hit = false
    for (const q of qKwSet) {
      if (kwLen(q) < 2 || kwLen(kw) < 2) continue
      if (kw.includes(q) || q.includes(kw)) {
        hit = true
        break
      }
    }
    if (hit) matched++
  }
  return matched / docKws.length
}

/**
 * 召回 top N。调用方必须在 ingest 当前句之前调用（否则当前句可能命中自己）。
 * @returns {{ hit: boolean, memories: Array<{date:string,text:string,score:number}>, debug: object }}
 */
export function recall({ persona, session, query, limit = 3 } = {}) {
  const t0 = process.hrtime.bigint()
  const st = getStore(persona)
  const raw = String(query ?? '').toLowerCase()
  const qKwSet = new Set(extractKeywords(raw))
  const qTokenSet = new Set(tokenize(raw))
  for (const [key, extra] of SYNONYMS) {
    if (!raw.includes(key)) continue
    for (const e of extra) {
      for (const t of tokenize(e)) qTokenSet.add(t)
      qKwSet.add(e) // 同义词也当查询关键词，配 kws 命中率打分
    }
  }
  // 查询关键词的 bigram 一并进检索：短语（"考试准备"）能借同义词表命中记忆里的说法。
  for (const kw of qKwSet) for (const t of tokenize(kw)) qTokenSet.add(t)
  const qTokens = [...qTokenSet]
  const qKws = [...qKwSet]
  const took = () => Number(process.hrtime.bigint() - t0) / 1e6

  if (qTokens.length === 0) {
    return { hit: false, memories: [], details: [], debug: { tokens: [], kws: qKws, details: 0, took_ms: 0 } }
  }

  const hits = new Map()
  for (const tok of qTokens) {
    const postings = st.index.get(tok)
    if (!postings) continue
    for (const idx of postings) hits.set(idx, (hits.get(idx) || 0) + 1)
  }

  const now = Date.now()
  const qLen = Math.sqrt(Math.max(1, qTokens.length))
  const scored = []
  for (const [idx, n] of hits) {
    const r = st.records[idx]
    if (!r) continue
    // §2.5 纠错：旧事实只标 superseded_by、不删，也不再参与召回打分。
    if (r.superseded_by) continue
    const days = Math.max(0, (now - r.ts) / 86_400_000)
    const decay = Math.pow(0.5, days / HALF_LIFE_DAYS)
    // bigram 分归一到 0–1，才能和 kws 命中率按 0.6/0.4 相加。
    const bm = Math.min(1, n / Math.sqrt(r.tokenCount || 1) / qLen)
    const kwHit = kwHitRate(r.kws, qKwSet, raw)
    const base = kwHit === null ? bm : 0.6 * bm + 0.4 * kwHit
    const score = base * decay
    scored.push({ id: r.id, idx, date: r.created_at.slice(0, 10), text: r.text, score, ts: r.ts })
  }

  scored.sort((a, b) => b.score - a.score || b.ts - a.ts || b.id - a.id)
  // 同一句话可能在多个会话里各存过一条，展示时按文本去重（留分高的那条）。
  const seenText = new Set()
  const unique = scored.filter((m) => {
    if (seenText.has(m.text)) return false
    seenText.add(m.text)
    return true
  })
  const chosen = unique.slice(0, limit)
  // §2.3：召回计数只改内存，由 idle 巩固统一落盘（flushStats）。
  for (const m of chosen) {
    const rec = st.records[m.idx]
    if (!rec) continue
    rec.recall_count = (rec.recall_count ?? 0) + 1
    rec.last_recalled_at = new Date().toISOString()
  }
  if (chosen.length) st.statsDirty = true

  const memories = chosen.map(({ id, date, text, score }) => ({
    id, date, text, score: Math.round(score * 1000) / 1000,
  }))

  // §2.3 细节门控：gist 照旧打分排序，细节只在这里补「至多 1 条」。
  // episode 模块出任何问题都只让细节为空，绝不拖垮 gist 召回。
  let details = []
  try {
    details = pickDetails(raw, chosen, {
      persona,
      gists: st.records,
      topScore: chosen[0]?.score ?? 0,
    })
  } catch {
    details = []
  }

  return {
    hit: memories.length > 0,
    memories,
    details,
    debug: {
      tokens: qTokens,
      kws: qKws,
      details: details.length,
      took_ms: Math.round(took() * 100) / 100,
      persona,
      session: session ?? null,
    },
  }
}

/** 清空某个人格的全部记忆；persona 省略时清空所有。返回删除条数。 */
export function reset(persona) {
  let deleted = 0
  const targets = []
  if (persona) {
    targets.push(persona)
  } else {
    try {
      for (const f of fs.readdirSync(MEMORA_HOME)) {
        if (/^memora-.*\.jsonl$/.test(f)) {
          targets.push(f.slice('memora-'.length, -'.jsonl'.length))
        }
      }
    } catch { /* 目录不存在即视为空 */ }
  }

  for (const p of targets) {
    const st = stores.get(p)
    if (st) deleted += st.records.length
    else {
      try {
        deleted += fs.readFileSync(fileFor(p), 'utf8').split('\n').filter((l) => l.trim()).length
      } catch { /* 无文件 */ }
    }
    stores.delete(p)
    try { fs.unlinkSync(fileFor(p)) } catch { /* 无文件 */ }
  }
  return { deleted, personas: targets }
}

/** 自检用：当前 stats。 */
export function stats(persona) {
  const st = getStore(persona)
  return { persona, messages: st.records.length, sessions: new Set(st.records.map((r) => r.session_id)).size }
}

// ── M3 · 记忆 CLI 支撑（list / del / export / import）──────────────

const EXPORT_VERSION = 1

/** 列出磁盘上 + 已加载的全部人格（文件名已净化）。 */
export function listPersonas() {
  const names = new Set(stores.keys())
  try {
    for (const f of fs.readdirSync(MEMORA_HOME)) {
      const m = /^memora-(.*)\.jsonl$/.exec(f)
      if (m) names.add(m[1])
    }
  } catch { /* 目录不存在即视为空 */ }
  return [...names].sort()
}

/** 按 id 升序列出一条人格的全部记忆（CLI list 用；不暴露内部索引）。 */
export function list(persona) {
  return getStore(persona).records
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((r) => ({
      id: r.id,
      session_id: r.session_id,
      text: r.text,
      created_at: r.created_at,
      kind: r.kind === 'episode' ? 'episode' : 'gist',
      ...(Array.isArray(r.kws) ? { kws: r.kws.slice() } : {}),
      ...v2Fields(r),
    }))
}

/** 放弃内存缓存，重新从磁盘加载（CLI 改过文件后 / 测试用）。 */
export function reload(persona) {
  stores.delete(persona)
  return getStore(persona)
}

/**
 * 删除一条记忆（按 id），原子重写文件。
 * @returns {{ok: boolean, reason?: string, removed?: {id:number,text:string}}}
 */
export function remove(persona, id) {
  const st = getStore(persona)
  const target = Number(id)
  const idx = st.records.findIndex((r) => r.id === target)
  if (idx < 0) return { ok: false, reason: 'not-found' }

  const [rec] = st.records.splice(idx, 1)
  rebuild(st)
  st.maxId = Math.max(st.maxId, rec.id) // id 不回退，避免复用
  rewrite(st, persona)
  return { ok: true, removed: { id: rec.id, text: rec.text } }
}

/** v2/P2：按 id 批量删除（巩固合并用），一次原子重写。 */
export function removeMany(persona, ids = []) {
  const st = getStore(persona)
  const targets = new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite))
  if (targets.size === 0) return { ok: true, removed: 0 }
  const keep = st.records.filter((r) => !targets.has(r.id))
  const removed = st.records.length - keep.length
  if (removed === 0) return { ok: true, removed: 0 }
  st.records = keep
  rebuild(st)
  st.maxId = Math.max(st.maxId, ...targets) // id 不回退，避免复用
  rewrite(st, persona)
  return { ok: true, removed }
}

/**
 * v2/P2：更新一条 gist 的增量字段（合并去重 / 提炼挂链接用）。
 * 只允许白名单字段；`kws` 走 sanitize，`source_episode_ids` 做并集。
 */
export function updateGist(persona, id, patch = {}) {
  const st = getStore(persona)
  const rec = st.records.find((r) => r.id === Number(id))
  if (!rec) return { ok: false, reason: 'not-found' }
  if (Array.isArray(patch.kws)) {
    const kws = sanitizeKws(patch.kws)
    if (kws.length) rec.kws = kws
    else delete rec.kws
  }
  if (Array.isArray(patch.source_episode_ids)) {
    const ids = normalizeIds([...(rec.source_episode_ids ?? []), ...patch.source_episode_ids])
    if (ids.length) rec.source_episode_ids = ids
  }
  if (Number.isFinite(patch.recall_count)) {
    rec.recall_count = Math.max(rec.recall_count ?? 0, Math.floor(patch.recall_count))
  }
  if (typeof patch.last_recalled_at === 'string' && patch.last_recalled_at) {
    rec.last_recalled_at = patch.last_recalled_at
  }
  if (Number.isFinite(patch.salience)) rec.salience = Math.max(0, Math.min(1, Number(patch.salience)))
  if ('superseded_by' in patch) {
    if (patch.superseded_by) rec.superseded_by = patch.superseded_by
    else delete rec.superseded_by
  }
  rewrite(st, persona)
  return { ok: true, id: rec.id }
}

/**
 * v2/P2：纠错标记（§2.5）。只标 `superseded_by`，不删、不改原文。
 * @returns {{ marked: number }}
 */
export function markSuperseded({ persona, ids = [], by = 'correction' } = {}) {
  const st = getStore(persona)
  const wanted = new Set((Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean))
  if (wanted.size === 0) return { marked: 0 }
  let marked = 0
  for (const rec of st.records) {
    if (!wanted.has(String(rec.id)) || rec.superseded_by) continue
    rec.superseded_by = by
    marked++
  }
  if (marked) rewrite(st, persona)
  return { marked }
}

/**
 * v2/P2：程序化追加一条 gist（巩固提炼用）。
 * 不走问句过滤/提取队列，但仍做去重、分词校验与上限滚动。
 */
export function appendGist({
  persona, session, text, createdAt, kws, sourceEpisodeIds, salience = 1,
} = {}) {
  const st = getStore(persona)
  const clean = String(text ?? '').trim()
  if (!clean) return { id: null, duplicate: false, skipped: 'empty' }
  if (clean.length > 2000) return { id: null, duplicate: false, skipped: 'too-long' }

  const key = `${String(session ?? '')}\u0000${clean}`
  if (st.seen.has(key)) return { id: st.seen.get(key), duplicate: true }

  const tokens = tokenize(clean)
  if (tokens.length === 0) return { id: null, duplicate: false, skipped: 'no-tokens' }

  const sourceIds = normalizeIds(sourceEpisodeIds)
  const k = sanitizeKws(kws)
  const rec = {
    id: st.maxId + 1,
    session_id: String(session ?? ''),
    text: clean,
    created_at: createdAt || new Date().toISOString(),
    kind: 'gist',
    kws: k.length ? k : extractKeywords(clean),
    salience: Number.isFinite(salience) ? Math.max(0, Math.min(1, Number(salience))) : 1,
    ...(sourceIds.length ? { source_episode_ids: sourceIds } : {}),
  }

  fs.mkdirSync(MEMORA_HOME, { recursive: true })
  fs.appendFileSync(fileFor(persona), persistRecord(rec) + '\n')
  addRecord(st, rec)

  if (st.records.length > MAX_RECORDS) {
    const keep = st.records.slice(-Math.floor(MAX_RECORDS / 2))
    stores.delete(persona)
    rewrite({ records: keep }, persona)
    loadStore(persona)
  }

  return { id: rec.id, duplicate: false }
}

/**
 * v2/P2：把内存里的召回计数落盘（§2.3：只在 idle 巩固时统一写一次）。
 * 没有变更就完全不碰磁盘。
 */
export function flushStats(persona) {
  const st = getStore(persona)
  if (!st.statsDirty) return { flushed: false }
  rewrite(st, persona)
  return { flushed: true }
}

/** 导出全部人格为单个 JSON（含 version，备份/恢复用）。 */
export function exportAll() {
  const personas = {}
  let total = 0
  for (const p of listPersonas()) {
    const rows = list(p)
    if (rows.length === 0) continue
    personas[p] = rows
    total += rows.length
  }
  return {
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    personas,
    total,
  }
}

/**
 * 导入 exportAll 产出的 JSON。仅替换文件里出现的人格，其余不动。
 * 版本不符 / 结构不对 → 不做任何写入，返回 { ok:false }。
 */
export function importAll(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'bad-format' }
  }
  if (Number(data.version) !== EXPORT_VERSION) {
    return { ok: false, error: 'version', version: data.version, expected: EXPORT_VERSION }
  }
  const personas = data.personas
  if (!personas || typeof personas !== 'object' || Array.isArray(personas)) {
    return { ok: false, error: 'bad-format' }
  }
  // 先全部校验，全部通过才动磁盘，避免导入一半。
  const prepared = []
  for (const [persona, rows] of Object.entries(personas)) {
    if (!Array.isArray(rows)) return { ok: false, error: 'bad-format' }
    const records = []
    for (const row of rows) {
      const text = String(row?.text ?? '').trim()
      if (!text) continue
      records.push({
        id: Number(row.id) || records.length + 1,
        session_id: String(row.session_id ?? ''),
        text: text.slice(0, 2000),
        created_at: row.created_at || new Date().toISOString(),
        kind: row.kind === 'episode' ? 'episode' : 'gist',
        ...(Array.isArray(row.kws) ? { kws: row.kws } : {}),
        ...v2Fields(row),
      })
    }
    prepared.push({ persona, records })
  }

  fs.mkdirSync(MEMORA_HOME, { recursive: true })
  let total = 0
  for (const { persona, records } of prepared) {
    const file = fileFor(persona)
    const tmp = `${file}.tmp`
    const body = records.map(persistRecord).join('\n')
    fs.writeFileSync(tmp, body + (records.length ? '\n' : ''))
    fs.renameSync(tmp, file)
    stores.delete(persona)
    total += records.length
  }
  return { ok: true, personas: prepared.length, records: total }
}
