/**
 * Memora P1.0 · 记忆抽取
 *
 * 目标：把一句用户原话拆成 0–2 条原子事实（每条 ≤20 字）。
 *
 * 两条路径，规则优先：
 * 1. `extractRules`：纯同步、零网络。按标点拆句、剥掉口语前缀/语气词、
 *    补全省略的主语（"我家猫叫豆豆，今年三岁" → "猫叫豆豆" + "猫今年三岁"）。
 *    绝大多数中文口语句都能覆盖，命中时完全不碰模型。
 * 2. `extractWithModel`：只处理规则不敢下结论的句子（太长 / 拆不出主语），
 *    一次最多 6 句、一个请求。只在 agent 空闲时调用，绝不每轮调。
 *
 * 异步约定（见《P1.0-记忆抽取》）：index.js 每轮先把原句 ingest 落盘，
 * 再把 id 放进 `createExtractQueue`；抽取成功后用 memory.replace 替换原句，
 * 失败/超时/服务不在 → 原句原样保留，行为退化成 P0。
 */

import { extractKeywords, looksLikeQuestion } from './memory.js'

const MAX_FACT_CHARS = 20
const MAX_FACTS = 2

/** 寒暄/语气词：整句只有这些时不进记忆。 */
const REACTION_RE = /^(嗯+|哦+|啊+|哈+|噢+|唉+|诶+|嘿+|哎+|喂+|好的?|行吧?|可以|收到|懂了|明白了?|没事|晚安|早安|再见|拜拜|谢谢|多谢|辛苦了|哈哈+|呵呵+)[。.!！~～…]*$/

/** 纯对话元问题：不是关于用户的事实。 */
const META_RE = /^(你觉得呢?|你说呢?|你猜|然后呢?|怎么办|为什么|是不是|能不能|要不要|有没有|可不可以|好不好|真的吗|是吗|对吧|懂了吗?|知道了吗?)[。.!！?？~～]*$/

/** 口语前缀，循环剥离。 */
const LEAD_FILLER_RE = /^(我觉得|我感觉|说起来|说实话|讲真|其实|然后|而且|但是|不过|另外|还有|所以|就是|反正|总之|总的来说|对了|话说)[，,、\s]*/

/** 第一人称主语；"我们/我家"不剥（语义不同）。 */
const LEAD_SELF_RE = /^我(?![们家])[，,\s]*/

/** 相对且会过期的模糊时间，剥掉后事实更耐久。 */
const VAGUE_TIME_RE = /^(最近|这段时间|这两天|前几天|前段时间|这阵子)[，,\s]*/

/** "我家猫叫豆豆" → "猫叫豆豆"，保留真正的主题。 */
const MY_HOME_RE = /^我家(.{1,3}?)(?=叫|是|今年|明年|去年|最近|在|要|不|有|养|很|挺|特别)/

const TRAIL_PARTICLE_RE = /[啊呀吧啦哦嘛咯呗捏噢]+$/

/** 省略主语的后续小句：时间 / 年龄 / 频率 / 动作开头。 */
const DEPENDENT_RE = /^(今年|明年|去年|前年|现在|目前|平时|经常|每天|每周|每月|每周末|周末|周[一二三四五六日天]|下个?月|下个?周|上个?月|上个?周|早上|上午|中午|下午|晚上|半夜|凌晨|\d{1,2}[点岁月号日]|吃|喝|去|来|买|用|玩|养|睡|起|醒|上班|下班|回家)/

/** 主语提取用的动词/形容词边界。 */
const SUBJECT_BOUNDARY_RE = /^(.{1,6}?)(?:不太|不好|很|挺|有点|经常|容易|在|要|想|喜欢|讨厌|叫|是|有|去|考|学|看|吃|喝|睡|住|养|买|换|做|说|觉得|需要|准备)/

const PRONOUN_RE = /^(我|你|他|她|它|我们|你们|他们|她们|大家|自己)/
const SUBJECT_STOP_RE = /^(不太|很|挺|有点|特别|经常|容易|最近|现在|目前|已经|还是|也|又|还|就|才|都|可能|应该)$/
const TIME_ONLY_RE = /^(今天|明天|昨天|后天|前天|今晚|明早|周末|周[一二三四五六日天]|下个?周|下个?月|上个?周|上个?月|今年|明年|去年|现在|目前|最近|每天|每周|\d{1,2}[点岁号日])$/

const charLen = (s) => Array.from(String(s ?? '')).length

/** 按标点拆小句。刻意不拆英文句点，避免把 3.5 / 网址拆坏。 */
export function splitClauses(text) {
  return String(text ?? '')
    .split(/[，,。；;！!？?\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 清洗一个小句：剥口语前缀、第一人称、模糊时间、语气词，去掉纯标点。
 * @returns {string} 空串表示这半句不值得记。
 */
export function cleanClause(clause) {
  let c = String(clause ?? '').trim()
  if (!c) return ''

  // 循环剥前缀，处理 "我最近…" 和 "最近我…" 两种顺序。
  for (let i = 0; i < 3; i++) {
    const before = c
    c = c
      .replace(LEAD_FILLER_RE, '')
      .replace(LEAD_SELF_RE, '')
      .replace(VAGUE_TIME_RE, '')
      .replace(LEAD_FILLER_RE, '')
      .trim()
    if (c === before) break
  }

  c = c.replace(MY_HOME_RE, '$1')

  // 去掉结尾语气词；不能把两字词削成单字（"周末" 不是 "周"）。
  const stripped = c.replace(TRAIL_PARTICLE_RE, '')
  if (charLen(stripped) >= 2) c = stripped

  c = c
    .replace(/^[\s"“”'‘’`]+|[\s"“”'‘’`]+$/g, '')
    .replace(/\.{3,}|…+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (charLen(c) < 2) return ''
  if (!/[\p{L}\p{N}]/u.test(c)) return '' // 纯表情/符号
  if (looksLikeQuestion(c)) return ''
  if (REACTION_RE.test(c) || META_RE.test(c)) return ''
  return c
}

/** 从一条事实里猜主语。猜不准就返回空串，宁可不补。 */
function subjectOf(fact) {
  const s = String(fact ?? '').trim()
  if (!s) return ''

  // "对芒果过敏" → 芒果（后续 "吃了会起疹子" 可以接上）
  const topic = s.match(/^对(.{1,4}?)(?:过敏|敏感|反感|不适|上瘾)/)
  if (topic) return topic[1].trim()

  const m = s.match(SUBJECT_BOUNDARY_RE)
  if (!m) return ''
  let subject = m[1].trim()
  if (!subject || PRONOUN_RE.test(subject)) return ''
  if (SUBJECT_STOP_RE.test(subject) || TIME_ONLY_RE.test(subject)) return ''
  if (charLen(subject) > 6) return ''
  return subject
}

/** 给省略主语的小句补主语（只补能确定、且补完不超长的）。 */
function carrySubjects(facts) {
  const out = []
  let previous = ''
  for (const fact of facts) {
    let text = fact
    if (DEPENDENT_RE.test(text) && previous && !PRONOUN_RE.test(text)) {
      const merged = previous + text
      if (charLen(merged) <= MAX_FACT_CHARS) text = merged
    }
    out.push(text)
    previous = subjectOf(fact)
  }
  return out
}

/**
 * 规则抽取。同步、无 IO。
 * @returns {{facts: string[], kws: string[][], confident: boolean, reason: string}}
 * - `kws` 与 `facts` 下标对齐（M1：每条事实 1–5 个关键词），存进记忆供召回打分。
 * - confident=true 且 facts=[]：确认不值得记（寒暄/元问题/纯语气）。
 * - confident=false：规则不敢定，交给空闲时的模型批量抽；失败则保留原句。
 */
export function extractRules(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return { facts: [], kws: [], confident: true, reason: 'empty' }
  if (looksLikeQuestion(raw)) return { facts: [], kws: [], confident: true, reason: 'question' }
  if (REACTION_RE.test(raw) || META_RE.test(raw)) return { facts: [], kws: [], confident: true, reason: 'filler' }

  const cleaned = []
  for (const clause of splitClauses(raw)) {
    const fact = cleanClause(clause)
    if (!fact) continue
    if (charLen(fact) > MAX_FACT_CHARS) return { facts: [], kws: [], confident: false, reason: 'too-long' }
    // "它今年三岁" 这种指代需要上下文，规则补不出来，交给模型/保留原句。
    if (/^(他|她|它|他们|她们)/.test(fact)) return { facts: [], kws: [], confident: false, reason: 'pronoun' }
    cleaned.push(fact)
  }

  if (cleaned.length === 0) return { facts: [], kws: [], confident: true, reason: 'no-fact' }

  const facts = carrySubjects(cleaned).slice(0, MAX_FACTS)
  return { facts, kws: facts.map((f) => extractKeywords(f)), confident: true, reason: 'rules' }
}

/** 清洗模型给的事实：去编号/项目符号、去问句、压到 20 字。 */
export function normalizeFact(value) {
  let t = String(value ?? '')
    .replace(/^\s*(?:[-*•·]|\d+\s*[.、)）])\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  t = t.replace(/^["“”'‘’`]+|["“”'‘’`]+$/g, '').trim()
  if (!t || looksLikeQuestion(t)) return ''
  // 模型偶尔会漏补主语，直接写「它今年三岁」；这种事实召回时没有指代对象，丢掉。
  if (/^(他|她|它|他们|她们)/.test(t)) return ''
  if (charLen(t) <= MAX_FACT_CHARS) return t

  const head = Array.from(t).slice(0, MAX_FACT_CHARS).join('')
  const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf(','), head.lastIndexOf(' '))
  return (cut >= 8 ? head.slice(0, cut) : head).trim()
}

export function buildModelMessages(texts) {
  const list = texts.map((t, i) => `${i + 1}. ${String(t).replace(/\s+/g, ' ').trim()}`).join('\n')
  return [
    {
      role: 'system',
      content: [
        '你是记忆抽取器。把每句用户原话拆成 0-2 条原子事实。',
        '规则：',
        '- 每条 ≤20 个汉字；保留主语和原话里的时间说法，不要换算日期。',
        '- 每条必须能单独看懂：不要用「它/他/她/这个」开头；原句省略主语时，从原句里补上主体。',
        '- 只写原话明确有的信息，不要推断、不要补充。',
        '- 疑问、寒暄、语气词不产生事实。',
        '输出：每句一行，行首是序号，事实之间用 | 分隔；没有事实就写「无」。',
        '不要解释，不要代码块，不要重复原句。',
        '示例：',
        '输入：1. 我养了一只猫叫豆豆，它今年三岁',
        '输出：1. 猫叫豆豆|猫今年三岁',
        '输入：2. 今天老板临时改需求，我整个下午都在返工',
        '输出：2. 老板临时改需求|我下午在返工',
        '输入：3. 嗯嗯好的',
        '输出：3. 无',
      ].join('\n'),
    },
    { role: 'user', content: `输入（共 ${texts.length} 句）：\n${list}` },
  ]
}

/**
 * 解析模型输出。优先按「每行一句 + | 分隔」，兼容 JSON。
 * @param {string} raw
 * @param {number} count 输入句数
 * @param {string[]} inputs 原始输入，用来剔除模型复读的行
 * @returns {string[][] | null} 长度必须等于 count，否则 null（整批退化为原句）
 */
export function parseModelOutput(raw, count, inputs = []) {
  if (!raw || count <= 0) return null
  let text = String(raw)
    .trim()
    .replace(/^```(?:json|text)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  if (!text) return null
  // 模型拒答/跑题：整批退化为原句，绝不把「我不知道」写进记忆。
  if (/^(我不知道|不知道|无法|抱歉|对不起|不能|不会|没有答案)[。.!！]?$/.test(text)) return null

  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const arr = JSON.parse(text)
      if (Array.isArray(arr) && arr.length === count) {
        return arr.map((item) => {
          const list = Array.isArray(item) ? item : item && Array.isArray(item.facts) ? item.facts : [item]
          return list
            .map((x) => normalizeFact(typeof x === 'string' ? x : x && x.text))
            .filter(Boolean)
            .slice(0, MAX_FACTS)
        })
      }
    } catch { /* 落到下面：JSON 坏掉就整批退化为原句 */ }
    return null
  }

  let lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const numbered = lines.filter((l) => /^\d+\s*[.、:：)）]/.test(l))
  if (numbered.length) lines = numbered

  const inputSet = new Set(inputs.map((s) => String(s).replace(/\s+/g, ' ').trim()))
  lines = lines.filter((line) => {
    const body = line.replace(/^\d+\s*[.、:：)）]\s*/, '').trim()
    return !inputSet.has(body.replace(/\s+/g, ' ').trim())
  })
  if (lines.length < count) return null

  const out = []
  for (let i = 0; i < count; i++) {
    const line = lines[i].replace(/^\d+\s*[.、:：)）]\s*/, '').trim()
    if (/^(无|无事实|没有|none|n\/a|—|-)$/i.test(line)) {
      out.push([])
      continue
    }
    out.push(line.split(/[|｜]/).map(normalizeFact).filter(Boolean).slice(0, MAX_FACTS))
  }
  return out
}

const DEFAULT_URL = process.env.MEMORA_LLM_URL || 'http://127.0.0.1:8080/v1/chat/completions'
const DEFAULT_MODEL = process.env.MEMORA_LLM_MODEL || 'qwen2.5-3b-instruct'

/**
 * 批量问本地 3B。绝不抛错：失败返回 { facts: null, error }。
 * @param {string[]} texts
 * @param {{url?:string, model?:string, timeoutMs?:number, signal?:AbortSignal, fetch?:Function}} [opts]
 * @returns {Promise<{facts: string[][]|null, raw: string, tookMs: number, error?: string}>}
 */
export async function extractWithModel(texts, opts = {}) {
  const list = (Array.isArray(texts) ? texts : [])
    .map((t) => String(t ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (list.length === 0) return { facts: [], raw: '', tookMs: 0 }

  const url = opts.url || DEFAULT_URL
  const model = opts.model || DEFAULT_MODEL
  const timeoutMs = Number(opts.timeoutMs ?? 20_000)
  const doFetch = opts.fetch || globalThis.fetch
  const t0 = Date.now()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const onAbort = () => controller.abort(opts.signal?.reason ?? new Error('aborted'))
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  if (opts.signal?.aborted) controller.abort(opts.signal.reason)

  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: buildModelMessages(list),
        max_tokens: Math.max(160, Math.min(640, list.length * 96)),
        temperature: 0,
        stream: false,
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    const raw = body?.choices?.[0]?.message?.content ?? ''
    const facts = parseModelOutput(raw, list.length, list)
    return {
      facts,
      raw,
      tookMs: Date.now() - t0,
      ...(facts ? {} : { error: 'parse' }),
    }
  } catch (err) {
    return {
      facts: null,
      raw: '',
      tookMs: Date.now() - t0,
      error: err?.name === 'AbortError' ? 'aborted' : String(err?.message ?? err),
    }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 空闲抽取队列。
 *
 * 每轮只 enqueue（O(1)）；agent 进入 idle 后由一个 timer 触发批量 flush：
 * 规则能定的当场 replace，规则不敢定的凑一批给模型。agent 重新变忙时
 * abort 在途请求，任务留到下次空闲，保证不跟用户的生成抢 llama-server。
 *
 * @param {{
 *   replace: (input:{persona:string,id:number,facts:string[]}) => any,
 *   replaceBatch?: (items:Array<object>) => {results?:Array<{ok?:boolean}>},
 *   appendEpisode?: (input:{persona:string,session?:string,text:string}) => {id:number|null},
 *   extractBatch?: Function,
 *   enabled?: boolean,
 *   idleDelayMs?: number,
 *   batchSize?: number,
 *   maxAttempts?: number,
 *   url?: string,
 *   model?: string,
 *   timeoutMs?: number,
 *   logger?: {debug?:Function,warn?:Function},
 * }} options
 */
export function createExtractQueue(options = {}) {
  const {
    replace,
    replaceBatch,
    appendEpisode,
    extractBatch = extractWithModel,
    enabled = true,
    idleDelayMs = 1200,
    batchSize = 6,
    maxAttempts = 2,
    url,
    model,
    timeoutMs,
    logger = null,
  } = options

  /**
   * v2 双写（P1）：先把原句落成 episode，再 replace 成 gist。
   * 只在确实要生成 gist（facts 非空）时调用；写失败只记日志，不影响 replace。
   * 没注入 appendEpisode 时返回 null（单测/老调用零副作用）。
   * @returns {number|null} episode id
   */
  function episodeIdOf(job) {
    if (typeof appendEpisode !== 'function') return null
    try {
      const res = appendEpisode({ persona: job.persona, session: job.session, text: job.text })
      return res?.id ?? null
    } catch (err) {
      logger?.warn?.(`memora-extract: episode write failed: ${err?.message ?? err}`)
      return null
    }
  }

  /** 组装 replace 参数：有 episode 就把 id 挂到每条新 gist 上。 */
  function replaceInput(job, facts, kws) {
    const epId = facts.length ? episodeIdOf(job) : null
    return {
      persona: job.persona,
      id: job.id,
      facts,
      kws,
      ...(epId != null ? { episodeIds: facts.map(() => epId) } : {}),
    }
  }

  const jobs = new Map()
  let timer = null
  let running = null
  let controller = null
  let disposed = false
  let idle = true

  const keyOf = (job) => `${job.persona}\u0000${job.id}`

  function enqueue(job) {
    if (!enabled || disposed || !job) return false
    if (job.id == null || !String(job.text ?? '').trim()) return false
    const key = keyOf(job)
    if (!jobs.has(key)) jobs.set(key, { ...job, attempts: 0 })
    return true
  }

  function schedule(delay = idleDelayMs) {
    if (!enabled || disposed || running || timer || jobs.size === 0) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, Math.max(0, delay))
    timer.unref?.()
  }

  function onIdle() {
    idle = true
    schedule()
  }

  function onBusy() {
    idle = false
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (controller) controller.abort(new Error('agent-busy'))
  }

  function requeue(list, countAttempt = true) {
    if (disposed) return
    for (const job of list) {
      if (countAttempt && job.attempts >= maxAttempts) continue
      const key = keyOf(job)
      if (!jobs.has(key)) jobs.set(key, job)
    }
  }

  async function run() {
    const batch = [...jobs.values()].slice(0, batchSize)
    for (const job of batch) jobs.delete(keyOf(job))

    const t0 = Date.now()
    const modelJobs = []
    const pending = [] // P2：本批收集待替换项，跑完一次性批量替换
    let ruleN = 0
    let removedN = 0
    let fallbackN = 0

    for (const job of batch) {
      let result
      try {
        result = extractRules(job.text)
      } catch (err) {
        logger?.warn?.(`memora-extract: rule failed: ${err?.message ?? err}`)
        result = { facts: [], confident: false }
      }

      if (!result.confident) {
        job.attempts = (job.attempts || 0) + 1
        modelJobs.push(job)
        continue
      }

      // P2：先收集，本批跑完一次性批量替换（每组人格一次原子重写）。
      pending.push({ input: replaceInput(job, result.facts, result.kws), kind: 'rule', hasFacts: result.facts.length > 0 })
    }

    let modelN = 0
    let modelEmptyN = 0
    if (modelJobs.length > 0) {
      if (!idle || disposed) {
        requeue(modelJobs, false)
      } else if (typeof extractBatch !== 'function') {
        fallbackN += modelJobs.length
      } else {
        controller = new AbortController()
        let out = null
        try {
          out = await extractBatch(modelJobs.map((j) => j.text), {
            signal: controller.signal,
            url,
            model,
            timeoutMs,
          })
        } catch (err) {
          logger?.warn?.(`memora-extract: model failed: ${err?.message ?? err}`)
        } finally {
          const aborted = controller.signal.aborted
          controller = null
          if (aborted) {
            for (const job of modelJobs) job.attempts = Math.max(0, job.attempts - 1)
            requeue(modelJobs, false)
            applyPending() // 规则批已经抽好，照旧落地
            return finish()
          }
        }

        const factsList = Array.isArray(out) ? out : out?.facts
        if (!Array.isArray(factsList) || factsList.length !== modelJobs.length) {
          fallbackN += modelJobs.length
          requeue(modelJobs)
        } else {
          for (let i = 0; i < modelJobs.length; i++) {
            const job = modelJobs[i]
            const facts = factsList[i]
            if (!Array.isArray(facts) || facts.length === 0) {
              modelEmptyN++ // 模型说没有事实：保留原句，宁可少删
              continue
            }
            // 模型只给事实，关键词在本地补（零额外请求）。
            pending.push({
              input: replaceInput(job, facts, facts.map((f) => extractKeywords(f))),
              kind: 'model',
              hasFacts: true,
            })
          }
        }
      }
    }

    applyPending()
    return finish()

    /** 收集后批量替换；批量失败/未注入时逐条降级（失败即原句保留）。 */
    function applyPending() {
      if (pending.length === 0) return
      let outcomes = []
      if (typeof replaceBatch === 'function') {
        try {
          const out = replaceBatch(pending.map((p) => p.input))
          outcomes = Array.isArray(out?.results) ? out.results : []
        } catch (err) {
          logger?.warn?.(`memora-extract: batch replace failed: ${err?.message ?? err}`)
          outcomes = []
        }
      }
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i]
        let ok
        if (outcomes.length) {
          ok = outcomes[i]?.ok !== false
        } else {
          try {
            ok = replace(p.input)?.ok !== false
          } catch (err) {
            logger?.warn?.(`memora-extract: replace failed: ${err?.message ?? err}`)
            ok = false
          }
        }
        if (!ok) {
          fallbackN++
          continue
        }
        if (p.kind === 'rule') {
          if (p.hasFacts) ruleN++
          else removedN++
        } else {
          modelN++
        }
      }
      pending.length = 0
    }

    function finish() {
      logger?.debug?.(
        `memora-extract: jobs=${batch.length} rule=${ruleN} model=${modelN} ` +
          `drop=${removedN} empty=${modelEmptyN} fallback=${fallbackN} took=${Date.now() - t0}ms`,
      )
    }
  }

  async function flush() {
    if (running) return running
    if (!enabled || disposed || jobs.size === 0) return
    running = run().finally(() => {
      running = null
      if (!disposed && idle && jobs.size > 0) schedule(300)
    })
    return running
  }

  return {
    enqueue,
    onIdle,
    onBusy,
    flush,
    /** 等队列真正跑完（含在途模型请求）。测试/离线 smoke 用。 */
    async drain(timeoutMs = 60_000) {
      idle = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (running) {
          await running.catch(() => {})
          continue
        }
        if (jobs.size === 0) return true
        if (disposed || !enabled) return false
        await flush()
      }
      return jobs.size === 0 && !running
    },
    get pending() {
      return jobs.size
    },
    get running() {
      return running !== null
    },
    get enabled() {
      return enabled && !disposed
    },
    dispose() {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (controller) controller.abort(new Error('disposed'))
      jobs.clear()
    },
  }
}
