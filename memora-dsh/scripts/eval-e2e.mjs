#!/usr/bin/env node
/**
 * Memora v2 · 端到端评测（P0 只写，§5 才跑）
 *
 * 做什么（纯本地、零依赖、不碰 `~/.memora`）：
 *   1. 在临时 MEMORA_HOME 里种 10 条事实（走真实 `ingest`）；
 *   2. 每题用真实 `recall` + `composeC` 拼出本轮 C（≤400 字符断言）；
 *   3. 把 C + 问题发给本地 llama-server（OpenAI 兼容 /v1/chat/completions）；
 *   4. 用规则（expect / forbid 正则）给回答判分，不调模型判分。
 *
 * 20 题 = 10 题细节召回 + 10 题纠错；§5 验收线：
 *   总 ≥16/20、细节 ≥8/10、纠错 ≥9/10。
 *
 * 用法：
 *   node scripts/eval-e2e.mjs             # 跑全部 20 题（§5 才跑）
 *   node scripts/eval-e2e.mjs --selftest  # 假 fetch 结构自检，不发网络请求
 *
 * 环境变量：
 *   MEMORA_LLM_URL   默认 http://127.0.0.1:8080/v1/chat/completions
 *   MEMORA_LLM_MODEL 默认 qwen2.5-3b-instruct
 *
 * 注意：纠错生效依赖 P2 的 `detectCorrection`/`applyCorrection`；P0/P1 阶段
 * 纠错题会按现状失败，这是基线，不是脚本 bug。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const URL_ = process.env.MEMORA_LLM_URL || 'http://127.0.0.1:8080/v1/chat/completions'
const MODEL = process.env.MEMORA_LLM_MODEL || 'qwen2.5-3b-instruct'
const TIMEOUT_MS = Number(process.env.MEMORA_E2E_TIMEOUT_MS) || 20_000
const MAX_C_CHARS = 400

/** 评测用固定人格提示：只考察记忆链路，人格措辞已由真实 preset 覆盖。 */
const SYSTEM_PROMPT = [
  '你是一个有长期记忆的对话伙伴。',
  '规则：只依据给定的【本轮记忆】回答事实问题；记忆里没有的，不要编造，',
  '直接说“这对我还是新的，你再跟我说说？”。',
  '用户纠正你时，接受新说法，不再复述旧说法。回答控制在 2 句以内。',
].join('')

/** 10 条种子事实（date + 原句；kws 由 ingest 自算，不手写）。 */
const FACTS = [
  { date: '2026-09-12', text: '我家猫叫豆豆，是领养的橘猫' },
  { date: '2026-09-15', text: '我下个月要考雅思，最近在备考' },
  { date: '2026-09-20', text: '我在一家做 B 端 SaaS 的公司做产品经理' },
  { date: '2026-09-26', text: '我周末喜欢去爬山，一般去香山' },
  { date: '2026-10-02', text: '我妹妹叫小雨，她在成都读大学' },
  { date: '2026-10-06', text: '我妈有高血压，我每周提醒她量血压' },
  { date: '2026-10-10', text: '我在学手冲咖啡，喜欢浅烘的豆子' },
  { date: '2026-10-14', text: '我上一份工作在北京，做数据标注平台' },
  { date: '2026-10-18', text: '我养了一盆龟背竹，放在阳台' },
  { date: '2026-10-22', text: '我讨厌别人追问我的收入' },
]

/**
 * 20 题。kind: 'detail' 细节召回 / 'correction' 纠错。
 * `correction`：先种事实，再说这句纠正，然后问 `query`。
 */
const CASES = [
  // ── 细节召回 10 题（≥8 过）──────────────────────────
  { id: 'd1', kind: 'detail', query: '豆豆是怎么来的', expect: [/领养/], forbid: [/朋友送|买来的/] },
  { id: 'd2', kind: 'detail', query: '豆豆是什么猫', expect: [/橘猫/], forbid: [] },
  { id: 'd3', kind: 'detail', query: '我妹妹在哪个城市上学', expect: [/成都/], forbid: [/西安|北京/] },
  { id: 'd4', kind: 'detail', query: '我妈身体上要注意什么', expect: [/血压|高血压/], forbid: [] },
  { id: 'd5', kind: 'detail', query: '我咖啡学到哪一步了', expect: [/手冲/], forbid: [] },
  { id: 'd6', kind: 'detail', query: '我家阳台上放了什么', expect: [/龟背竹/], forbid: [] },
  { id: 'd7', kind: 'detail', query: '我周末一般去哪儿', expect: [/香山|爬山/], forbid: [] },
  { id: 'd8', kind: 'detail', query: '我以前在哪个城市上班', expect: [/北京/], forbid: [/上海|成都/] },
  { id: 'd9', kind: 'detail', query: '我雅思准备得怎么样了', expect: [/雅思|备考/], forbid: [/托福/] },
  { id: 'd10', kind: 'detail', query: '我最近在学什么', expect: [/手冲|咖啡/], forbid: [] },

  // ── 纠错 10 题（≥9 过；依赖 P2）──────────────────────
  {
    id: 'c1', kind: 'correction', seed: '我家猫叫豆豆，是领养的橘猫',
    correction: '记错了，我家猫叫咪咪', query: '我家猫叫什么',
    expect: [/咪咪/], forbid: [/豆豆/],
  },
  {
    id: 'c2', kind: 'correction', seed: '我家猫叫豆豆，是领养的橘猫',
    correction: '不是领养的，是朋友送的', query: '豆豆是怎么来的',
    expect: [/朋友送/], forbid: [/领养/],
  },
  {
    id: 'c3', kind: 'correction', seed: '我妹妹叫小雨，她在成都读大学',
    correction: '不是成都，是西安', query: '我妹妹在哪个城市上学',
    expect: [/西安/], forbid: [/成都/],
  },
  {
    id: 'c4', kind: 'correction', seed: '我下个月要考雅思，最近在备考',
    correction: '不是雅思，是托福', query: '我准备考什么',
    expect: [/托福/], forbid: [/雅思/],
  },
  {
    id: 'c5', kind: 'correction', seed: '我在学手冲咖啡，喜欢浅烘的豆子',
    correction: '不是手冲，是拉花', query: '我最近在学什么',
    expect: [/拉花/], forbid: [/手冲/],
  },
  {
    id: 'c6', kind: 'correction', seed: '我妈有高血压，我每周提醒她量血压',
    correction: '不是高血压，是糖尿病', query: '我妈身体上要注意什么',
    expect: [/糖尿病/], forbid: [/高血压/],
  },
  {
    id: 'c7', kind: 'correction', seed: '我上一份工作在北京，做数据标注平台',
    correction: '不是北京，是上海', query: '我以前在哪个城市上班',
    expect: [/上海/], forbid: [/北京/],
  },
  {
    id: 'c8', kind: 'correction', seed: '我周末喜欢去爬山，一般去香山',
    correction: '不是香山，是八大处', query: '我周末一般去哪儿',
    expect: [/八大处/], forbid: [/香山/],
  },
  {
    id: 'c9', kind: 'correction', seed: '我在学手冲咖啡，喜欢浅烘的豆子',
    correction: '不是浅烘，是中烘', query: '我喜欢什么烘焙度的豆子',
    expect: [/中烘/], forbid: [/浅烘/],
  },
  {
    id: 'c10', kind: 'correction', seed: '我讨厌别人追问我的收入',
    correction: '不是讨厌，是不太想聊收入', query: '我愿意聊收入吗',
    expect: [/不想|不太|不喜欢/], forbid: [/很乐意|欢迎/],
  },
]

const THRESHOLDS = { total: 16, detail: 8, correction: 9 }

/**
 * 调 llama-server。`fetchImpl` 可注入（自检用假 fetch）。
 * @returns {Promise<{ok:boolean, text:string, error?:string}>}
 */
export async function askModel({ messages, fetchImpl = fetch, url = URL_, model = MODEL, timeoutMs = TIMEOUT_MS }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: 160,
        stream: false,
      }),
    })
    if (!res.ok) return { ok: false, text: '', error: `HTTP ${res.status}` }
    const body = await res.json()
    const text = String(body?.choices?.[0]?.message?.content ?? '').trim()
    return { ok: Boolean(text), text, ...(text ? {} : { error: 'empty' }) }
  } catch (err) {
    return { ok: false, text: '', error: err?.name === 'AbortError' ? 'timeout' : String(err?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}

/** 规则判分：expect 全中且 forbid 全不中才算过；回答为空直接不过。 */
export function scoreAnswer(text, { expect = [], forbid = [] } = {}) {
  const answer = String(text ?? '').trim()
  if (!answer) return { pass: false, reason: 'empty' }
  for (const re of forbid) if (re.test(answer)) return { pass: false, reason: `forbid:${re}` }
  for (const re of expect) if (!re.test(answer)) return { pass: false, reason: `missing:${re}` }
  return { pass: true, reason: 'ok' }
}

/** 组装发给模型的消息：C 作为 user 消息前缀，模拟插件的记忆注入。 */
export function buildMessages(question, cText) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${cText}\n\n${question}` },
  ]
}

/**
 * 共享运行时：一次运行只建一个临时 MEMORA_HOME（不碰用户真实数据）。
 * @returns {Promise<{mem: object, idx: object, home: string, cleanup: Function}>}
 */
export async function openRuntime() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-e2e-'))
  process.env.MEMORA_HOME = home
  const mem = await import('../memory.js')
  const idx = await import('../index.js')
  return {
    mem,
    idx,
    home,
    cleanup: () => {
      try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
    },
  }
}

/** 种下 10 条事实（每题独立人格，避免题间串味）。 */
function seedFacts(mem, persona, extra = []) {
  const now = Date.now()
  for (const f of [...FACTS, ...extra.map((text) => ({ text }))]) {
    mem.ingest({ persona, session: `seed-${persona}`, text: f.text, createdAt: f.date ? `${f.date}T10:00:00.000Z` : new Date(now).toISOString() })
  }
}

/**
 * 跑一题：种子事实 →（纠错题：先纠正）→ recall → composeC → 问模型 → 判分。
 * @returns {Promise<{id:string, kind:string, pass:boolean, reason:string, answer:string, c:string, cLen:number}>}
 */
export async function runCase(c, { mem, idx, fetchImpl = fetch } = {}) {
  const persona = `e2e_${c.id}`
  seedFacts(mem, persona, c.seed ? [c.seed] : [])
  const session = `s-${c.id}`
  const { recall, looksLikeQuestion } = mem
  const { composeC } = idx

  // 纠错轮：真实链路里由 index.js 在 ingest 前标记 superseded（P2）。
  // 这里若有 applyCorrection 就走一遍，否则只当普通一轮，按现状判分。
  if (c.kind === 'correction' && typeof idx.applyCorrection === 'function') {
    try { idx.applyCorrection({ persona, session, text: c.correction }) } catch { /* 基线不计错 */ }
  }
  if (c.kind === 'correction') {
    mem.ingest({ persona, session, text: c.correction })
  }

  const result = recall({ persona, session, query: c.query })
  const cText = composeC(result, { isQuestion: looksLikeQuestion(c.query) })
  const cLen = Array.from(cText).length
  if (cLen > MAX_C_CHARS) {
    return { id: c.id, kind: c.kind, pass: false, reason: `C 超预算 ${cLen}`, answer: '', c: cText, cLen }
  }

  const asked = await askModel({ messages: buildMessages(c.query, cText), fetchImpl })
  if (!asked.ok) {
    return { id: c.id, kind: c.kind, pass: false, reason: `llm:${asked.error}`, answer: '', c: cText, cLen }
  }
  const scored = scoreAnswer(asked.text, c)
  return { id: c.id, kind: c.kind, pass: scored.pass, reason: scored.reason, answer: asked.text, c: cText, cLen }
}

/** 汇总 + 按 §5 阈值给结论。 */
export function summarize(rows) {
  const tally = (kind) => {
    const list = rows.filter((r) => r.kind === kind)
    return `${list.filter((r) => r.pass).length}/${list.length}`
  }
  const total = rows.filter((r) => r.pass).length
  const detail = rows.filter((r) => r.kind === 'detail' && r.pass).length
  const correction = rows.filter((r) => r.kind === 'correction' && r.pass).length
  const ok = total >= THRESHOLDS.total
    && detail >= THRESHOLDS.detail
    && correction >= THRESHOLDS.correction
  return {
    ok,
    total: `${total}/${rows.length}`,
    detail: tally('detail'),
    correction: tally('correction'),
    failed: rows.filter((r) => !r.pass).map((r) => `${r.id}:${r.reason}`),
  }
}

/**
 * 自检：假 fetch，不发网络请求。断言一条结构：
 * C 正确拼装（含【本轮记忆】、≤400 字符）、判分能识别对/错。
 */
export async function selftest() {
  const rt = await openRuntime()
  try {
    const captured = []
    const fakeFetch = async (url, init) => {
      captured.push({ url, body: JSON.parse(init.body) })
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '豆豆是领养的橘猫。' } }] }),
      }
    }
    const c = CASES.find((x) => x.id === 'd1')
    const row = await runCase(c, { ...rt, fetchImpl: fakeFetch })
    const req = captured[0]
    const userText = String(req?.body?.messages?.at(-1)?.content ?? '')
    const positive = scoreAnswer('豆豆是领养的橘猫。', c)
    const negative = scoreAnswer('豆豆是我朋友送的。', c)
    const ok = captured.length === 1
      && req.url === URL_
      && req.body.model === MODEL
      && userText.includes('【本轮记忆】')
      && userText.includes('领养')
      && row.cLen <= MAX_C_CHARS
      && positive.pass === true
      && negative.pass === false
    if (!ok) {
      console.error('selftest FAIL', JSON.stringify({ captured: captured.length, cLen: row.cLen, positive, negative }))
      return 1
    }
    console.log('selftest PASS：composeC 结构 + 假 fetch 请求体 + 判分方向正确')
    return 0
  } finally {
    rt.cleanup()
  }
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest()
  const rt = await openRuntime()
  try {
    const rows = []
    for (const c of CASES) {
      const row = await runCase(c, rt)
      rows.push(row)
      console.log(`${row.pass ? 'PASS' : 'FAIL'} ${row.kind.padEnd(10)} ${row.id.padEnd(4)} ${row.reason}`)
    }
    const s = summarize(rows)
    console.log(`e2e 总 ${s.total} · 细节 ${s.detail} · 纠错 ${s.correction} · ${s.ok ? '通过' : '未达标'}`)
    if (s.failed.length) console.log(`失败：${s.failed.join(' ')}`)
    return s.ok ? 0 : 1
  } finally {
    rt.cleanup()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const code = await main()
  process.exitCode = code
}
