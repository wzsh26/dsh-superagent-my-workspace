/**
 * Memora P1.0 · plugin entry
 *
 * 四件事：
 * 0. 安全护栏（M2）：命中自伤/伤人/极端依赖 → 只发【安全】段，跳过记忆召回与落库。
 * 1. no-tools guard：llama.cpp 的 OpenAI 层拒绝 `tools` + `stream`，
 *    本 preset 不需要工具，所以在组装阶段把 tools 置空。
 * 2. 每轮记忆注入：在 `agent/pre-step`（step === 1）召回上一轮之前的记忆，
 *    以 user 角色的 snapshot 消息追加到进入步骤的批次末尾。
 * 3. 异步抽取：同一步把原句 ingest 落盘后入队；agent 进入 idle 时，
 *    队列先跑规则、再批量问模型，成功则把原句替换成 0–2 条原子事实。
 *    抽取失败/超时/服务不在 → 原句保留（P0 行为）。
 *
 * 约定（见《Memora-技术方案优化》v1.1 / 《P1.0-记忆抽取》）：
 * - C 层每轮必发（有命中给事实，无命中给"无相关记忆"），不能跳过；
 * - append-only，不删旧 C，保证 prefix cache 稳定；
 * - 注入失败只降级，不影响正常对话；
 * - 抽取绝不阻塞对话，也不在生成期间抢 llama-server。
 */

import { randomUUID } from 'node:crypto'
import {
  ingest, looksLikeQuestion, markSuperseded, recall, replace, replaceBatch,
} from './memory.js'
import { createExtractQueue } from './extract.js'
import { appendEpisode, consolidate } from './episode.js'
import { defaultState, loadState, observe, saveState, toneHint, normalizeTraits, BIG_FIVE_KEYS } from './persona.js'
import { checkRisk, composeSafety } from './guard.js'
import { readPersonaTraits } from './bigfive.js'
import z from '@deepseek-ai/schemastery'

export const name = 'memora'
export const inject = ['systemPrompt']

/**
 * 大五人格配置（0–100，五维均可调）。
 * - `.role('slider')`：数值字段渲染为滑块；
 * - `.volatile()`：让这些字段进入 Settings 的「实时可编辑表单」（DSH 的
 *   配置表单只投影带 volatile 的字段，不标 volatile 就不会出现）。
 * 缺省维度由 persona.js 补中性 50。
 */
const traitSlider = (label) =>
  z.number().min(0).max(100).step(1).default(50).role('slider').description(label)

export const Config = z.object({
  personaId: z.string().default('default'),
  traits: z.object({
    neuroticism: traitSlider('神经质'),
    extraversion: traitSlider('外倾性'),
    openness: traitSlider('开放性'),
    agreeableness: traitSlider('宜人性'),
    conscientiousness: traitSlider('尽责性'),
  }).description('大五人格（0–100）').volatile(),
})

const SOURCE_KIND = 'memora'
const MAX_C_CHARS = 400
/** 细节行上限：至多 1 条、原句截 60 字（§2.3/§2.4）。 */
const MAX_DETAILS = 1
const DETAIL_MAX_CHARS = 60

/** 按码点数长度（中文/emoji 都按 1 个算），断言与截断统一用它。 */
export function cLength(text) {
  return Array.from(String(text ?? '')).length
}

/** 按码点截断，不切坏代理对。 */
export function clampChars(text, max = MAX_C_CHARS) {
  return Array.from(String(text ?? '')).slice(0, max).join('')
}

/**
 * 硬预算断言：C 层总长不得超过 MAX_C_CHARS（默认 400 ≈ 120 token）。
 * 超了抛 `C_OVER_BUDGET`，调用方只降级、不影响对话。
 */
export function assertWithinBudget(text, max = MAX_C_CHARS) {
  const len = cLength(text)
  if (len > max) {
    const err = new Error(`memora: C 超预算 ${len}/${max}`)
    err.code = 'C_OVER_BUDGET'
    throw err
  }
  return true
}

/** 细节 → [{date,text}]：至多 1 条，原句截 60 字，缺 date 不补。 */
function normalizeDetails(details) {
  const out = []
  for (const d of Array.isArray(details) ? details : []) {
    const text = String(d?.text ?? '').trim()
    if (!text) continue
    out.push({ date: String(d?.date ?? '').trim(), text: clampChars(text, DETAIL_MAX_CHARS) })
    if (out.length >= MAX_DETAILS) break
  }
  return out
}

/** 已知的上下文消息来源，跳过它们找用户原话。 */
const CONTEXT_KINDS = new Set([
  'agent-instructions', 'skill-catalog', 'time-context', 'tmux-context',
  'session-reference', SOURCE_KIND,
])

function textOf(message) {
  if (!message || message.role !== 'user') return ''
  const blocks = Array.isArray(message.content) ? message.content : []
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** 取本轮用户真正输入的那句话（最后一条 source.kind === 'user' 的文本）。 */
function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m?.source?.kind === 'user') {
      const t = textOf(m)
      if (t) return t
    }
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (CONTEXT_KINDS.has(m?.source?.kind)) continue
    const t = textOf(m)
    if (t) return t
  }
  return ''
}

/** C 层文本。有命中给 top3 事实；无命中按「问过去 / 说新事」分支。
 *
 *  为什么分支：无命中时如果一律说"只回：这对我还是新的"，用户刚说完一件新事
 *  （"我家猫叫豆豆"）也会被回一句"这对我还是新的，你再跟我说说？"，非常出戏。
 *  问句在代码里就能判定（looksLikeQuestion），交给模型判断反而不稳：
 *  实测三分支写法在损友人格上掉到 0–1/4，代码分支 + 两套模板是 32/32。
 *
 *  v2/P0 分段拼装：关系行（可空）+ 记忆段 + 细节段。
 *  关系行与细节段都缺省时，输出与 v1 逐字一致（见 index.test.js）。
 *  细节只跟在命中的记忆后面，无命中时不出细节（§2.4：细节只在用户问细节时用）。 */
export function composeC(result, { isQuestion = false, relation = '', details } = {}) {
  const detailList = normalizeDetails(details ?? result?.details)
  const relationLine = normalizeRelation(relation)
  const base = composeMemoryBody(result, isQuestion, [])
  const withDetails = detailList.length ? composeMemoryBody(result, isQuestion, detailList) : base

  // 预算分配顺序：事实 > 细节 > 关系行；超了就丢后面那段，绝不截断事实。
  let body = base
  if (detailList.length && cLength(join(relationLine, withDetails)) <= MAX_C_CHARS) {
    body = withDetails
  }
  let out = join(relationLine, body)
  if (cLength(out) > MAX_C_CHARS) out = body
  out = clampChars(out, MAX_C_CHARS)
  assertWithinBudget(out)
  return out
}

function join(relationLine, body) {
  return relationLine ? `${relationLine}\n${body}` : body
}

/** 关系行：调用方可以给纯内容（自动补 `【关系】`），也可以给整行。 */
function normalizeRelation(relation) {
  const s = String(relation ?? '').trim()
  if (!s) return ''
  return s.startsWith('【') ? s : `【关系】${s}`
}

/** 记忆段本体（v1 原样）。detailList 为空时与 v1 输出逐字一致。 */
function composeMemoryBody(result, isQuestion, detailList = []) {
  if (!result || !result.hit || result.memories.length === 0) {
    return isQuestion
      ? '【本轮记忆】无相关记忆。\n（禁止反问、禁止猜测、禁止说"你上次说"；只回：这对我还是新的，你再跟我说说？）'
      : '【本轮记忆】无相关记忆。\n（用户在告诉你一件新事，正常回应这件事；不要说"这对我还是新的"，也不要提记忆。）'
  }
  const lines = result.memories
    .slice(0, 3)
    .map((m) => `- ${m.date}：${m.text}`)
    .concat(detailList.map((d) => (d.date ? `- ${d.date}（细节）：${d.text}` : `- （细节）：${d.text}`)))
    .join('\n')
  return `【本轮记忆】\n${lines}\n（用户问到过去时，直接用这里的事实回答；不要补充没写到的细节。）`.slice(0, MAX_C_CHARS)
}

function contextMessage(text, sectionName = '本轮记忆') {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: sectionName, text }] },
  }
}

// ── P2 · 纠错判定（§2.5，纯规则、零模型）────────────────────

const CORRECTION_DENY_RE = /记错了|你记错|我没说过/
const CORRECTION_REPLACE_RE = /不是[^。！？]{0,20}是/
const DENY_LEAD_RE = /^(?:记错了|你记错了?|我没说过)[，,。；;、\s]+/

/**
 * §2.5 纠错判定。
 * - `deny`：命中「记错了 / 你记错 / 我没说过」→ 只标 superseded；
 *   若否定语后面跟的是逗号分句（“记错了，我家猫叫咪咪”），把新值剥出来正常 ingest；
 *   紧贴宾语的说法（“我没说过我讨厌爬山”）整句不入库，避免把被否认的内容当事实。
 * - `replace`：命中「不是…是…」→ 剥掉“不是”再走正常 ingest。
 *
 * @returns {{ isCorrection:boolean, kind:'deny'|'replace'|null, cleaned:string, skipIngest:boolean }}
 */
export function detectCorrection(text) {
  const s = String(text ?? '').trim()
  if (!s) return { isCorrection: false, kind: null, cleaned: s, skipIngest: false }
  if (CORRECTION_DENY_RE.test(s)) {
    const cleaned = s.replace(DENY_LEAD_RE, '').trim()
    const ingestable = Boolean(cleaned) && cleaned !== s
    return { isCorrection: true, kind: 'deny', cleaned: ingestable ? cleaned : s, skipIngest: !ingestable }
  }
  if (CORRECTION_REPLACE_RE.test(s)) {
    const cleaned = s
      .replace(/不是/g, '')
      .replace(/^[，,。；;、\s]+/, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    return { isCorrection: true, kind: 'replace', cleaned: cleaned || s, skipIngest: false }
  }
  return { isCorrection: false, kind: null, cleaned: s, skipIngest: false }
}

export function apply(ctx, config = {}) {
  const personaId = String(config?.personaId || 'default')
  const extractCfg = config?.extract && typeof config.extract === 'object' ? config.extract : {}
  // 大五人格底色（0–100，可只给部分维度）；缺省维度由 persona.js 补中性 50。
  // traits 被 Config 标记为 volatile，运行时是 Volatile 引用（带 .get()）。
  const rawTraits = config?.traits
  const baseTraits = (rawTraits && typeof rawTraits.get === 'function' ? rawTraits.get() : rawTraits) || {}

  // 3) 空闲抽取队列：每轮只入队，idle 后才碰规则/模型。
  const extractQueue = createExtractQueue({
    replace,
    replaceBatch,
    appendEpisode,
    enabled: config?.extract !== false,
    idleDelayMs: Number(extractCfg.idleDelayMs ?? 1200),
    batchSize: Number(extractCfg.batchSize ?? 6),
    url: extractCfg.url,
    model: extractCfg.model,
    timeoutMs: extractCfg.timeoutMs,
    ...(typeof extractCfg.extractBatch === 'function' ? { extractBatch: extractCfg.extractBatch } : {}),
    logger: ctx.logger,
  })
  ctx.effect?.(() => () => extractQueue.dispose(), 'memora.extract')

  // 兜底探针：正常路径是 agent/status=idle；万一该事件没送到插件，
  // 5s 后看一次 agent.status，仍未空闲就每 3s 再看，最多 10 次。
  let lastAgent = null
  let idleProbe = null
  let probeTries = 0
  let disposed = false
  const clearProbe = () => {
    if (idleProbe) {
      clearTimeout(idleProbe)
      idleProbe = null
    }
  }
  const probeIdle = () => {
    idleProbe = null
    if (disposed) return
    if (lastAgent?.status === 'idle') {
      lastAgent = null
      extractQueue.onIdle()
      flushPersona()
      scheduleConsolidate()
      return
    }
    if (++probeTries >= 10) return
    idleProbe = setTimeout(probeIdle, 3000)
    idleProbe.unref?.()
  }
  const armProbe = () => {
    if (disposed || idleProbe) return
    probeTries = 0
    idleProbe = setTimeout(probeIdle, 5000)
    idleProbe.unref?.()
  }
  ctx.effect?.(() => () => {
    disposed = true
    clearProbe()
    if (consolidateTimer) {
      clearTimeout(consolidateTimer)
      consolidateTimer = null
    }
    flushPersona() // 退出前把状态落一次（失败只降级）
  }, 'memora.extract.probe')

  // 3.5) P2 巩固：dirty 时 idle 跑一次（≤200ms），超时下次继续。
  let dirty = false
  let consolidating = false
  let consolidateTimer = null
  const markDirty = () => { dirty = true }
  const runConsolidate = () => {
    if (!dirty || consolidating || disposed) return
    if (process.env.MEMORA_CONSOLIDATE === '0') return
    // 抽取队列还没跑完就先让路，避免和批量替换抢同一份 store。
    if (extractQueue.pending > 0 || extractQueue.running) {
      scheduleConsolidate(800)
      return
    }
    dirty = false
    consolidating = true
    consolidate(personaId, { budgetMs: 200 })
      .then((s) => {
        if (s && (s.merged || s.promoted || s.archived || s.truncated)) {
          ctx.logger?.debug?.(
            `memora[${personaId}] consolidate merged=${s.merged} promoted=${s.promoted} ` +
              `archived=${s.archived} truncated=${s.truncated} took=${s.took_ms}ms`,
          )
        }
        if (s?.timedOut) dirty = true // 没跑完，下次 idle 继续
      })
      .catch((err) => ctx.logger?.warn?.(`memora: consolidate failed: ${err?.message ?? err}`))
      .finally(() => { consolidating = false })
  }
  const scheduleConsolidate = (delay = 1200) => {
    if (!dirty || consolidating || consolidateTimer || disposed) return
    consolidateTimer = setTimeout(() => {
      consolidateTimer = null
      runConsolidate()
    }, delay)
    consolidateTimer.unref?.()
  }

  // 本会话最近一次注入的 gist id（纠错时定位要标 superseded 的目标）。
  const lastInjected = new Map()
  const pruneLastInjected = () => {
    if (lastInjected.size <= 64) return
    const entries = [...lastInjected.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0))
    for (let i = 0; i < entries.length - 64; i++) lastInjected.delete(entries[i][0])
  }

  // P3 情绪/关系状态：常驻内存，每 5 轮或 idle 落盘一次（§2.6）。
  let personaState
  try {
    personaState = loadState(personaId, Date.now(), baseTraits)
  } catch {
    personaState = defaultState(Date.now(), baseTraits)
  }
  let personaDirty = false
  let turnsSinceSave = 0
  const flushPersona = () => {
    if (!personaDirty) return
    try {
      saveState(personaId, personaState)
      personaDirty = false
      turnsSinceSave = 0
    } catch (err) {
      ctx.logger?.warn?.(`memora: save state failed: ${err?.message ?? err}`)
    }
  }

  // 滑块面板写入的 personas.json 里，本 persona 的档案是「用户调整后的底色」：变了就重置五维。
  let lastBigFive = null
  const syncBigFive = () => {
    try {
      const bf = readPersonaTraits(personaId)
      if (!bf) return false
      if (lastBigFive && BIG_FIVE_KEYS.every((k) => bf[k] === lastBigFive[k])) return false
      lastBigFive = bf
      personaState.traits = normalizeTraits(bf)
      personaDirty = true
      return true
    } catch (err) {
      ctx.logger?.warn?.(`memora: read persona traits failed: ${err?.message ?? err}`)
      return false
    }
  }
  syncBigFive()

  // 1) no-tools guard：只作用于本 preset 的 agent。
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    return { ...assembled, tools: [] }
  })

  // agent 跑完一轮才抽取，避免和用户正在等的那次生成抢模型。
  ctx.on('agent/status', (payload = {}) => {
    const status = payload.status
    if (status === 'idle') {
      clearProbe()
      lastAgent = null
      extractQueue.onIdle()
      flushPersona()
      scheduleConsolidate()
    } else if (status === 'running') {
      extractQueue.onBusy()
    }
  })

  // 2) 每轮记忆注入。
  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal?.aborted) return decision
    if (step !== 1) return decision

    const sessionId = String(agent?.session?.id ?? agent?.session?.sessionId ?? '')
    const text = lastUserText(messages)
    if (!text) return decision

    // M2：风险句优先于一切记忆注入。本轮不召回、也不落库/抽取
    //（避免把危机原话写进记忆，日后又被召回注入）。
    const risk = checkRisk(text)
    if (risk.risk) {
      ctx.logger?.debug?.(`memora[${personaId}] safety=${risk.categories.join(',')} matched=${risk.matched.join(',')}`)
      return { ...decision, messages: [...decision.messages, contextMessage(composeSafety(risk), '安全')] }
    }

    // P2 纠错（§2.5）：先标 superseded，再召回——纠错当轮就不再注入旧事实。
    // 目标 = 本会话最近一次注入的 gist id（内存 Map，只在本轮生效一次）。
    const correction = detectCorrection(text)
    if (correction.isCorrection) {
      const target = lastInjected.get(sessionId)
      if (target?.ids?.length) {
        try {
          const marked = markSuperseded({ persona: personaId, ids: target.ids })
          if (marked.marked) {
            ctx.logger?.debug?.(`memora[${personaId}] correction kind=${correction.kind} marked=${marked.marked}`)
          }
        } catch (err) {
          ctx.logger?.warn?.(`memora: markSuperseded failed: ${err?.message ?? err}`)
        }
        target.ids = []
      }
    }

    // P3：情绪/关系观察（纯内存）。风险轮已在上方提前返回，状态自然冻结。
    // 先同步一次顶层滑块写入的大五底色（若变了）。
    syncBigFive()
    let relation = ''
    try {
      const obs = observe({ state: personaState, text, correction: correction.isCorrection })
      if (obs.changed) {
        personaDirty = true
        turnsSinceSave++
      }
      relation = toneHint(personaState, { correction: correction.isCorrection })
    } catch (err) {
      ctx.logger?.warn?.(`memora: persona observe failed: ${err?.message ?? err}`)
      relation = ''
    }

    let injection
    try {
      const result = recall({ persona: personaId, session: sessionId, query: text })
      injection = contextMessage(
        composeC(result, {
          isQuestion: looksLikeQuestion(text),
          relation,
          details: result.details,
        }),
      )
      if (result.hit && result.memories.length) {
        lastInjected.set(sessionId, {
          ids: result.memories.map((m) => m.id).filter((v) => v != null),
          at: Date.now(),
        })
        pruneLastInjected()
      }
      ctx.logger?.debug?.(
        `memora[${personaId}] hit=${result.hit} n=${result.memories.length} ` +
          `detail=${result.details?.length ?? 0} ` +
          `took=${result.debug.took_ms}ms tokens=${result.debug.tokens.length}`,
      )
    } catch (err) {
      ctx.logger?.warn?.(`memora: recall failed: ${err?.message ?? err}`)
      return decision
    }

    // 先召回后写入：当前句不会命中自己。抽取是异步的，这里只入队。
    // 纠错轮写入剥掉“不是”的文本或否定语后的新值；deny 紧贴宾语时整句不入库。
    const ingestText = correction.isCorrection ? correction.cleaned : text
    if (!(correction.isCorrection && correction.skipIngest) && ingestText) {
      try {
        const res = ingest({ persona: personaId, session: sessionId, text: ingestText })
        if (res?.id) {
          markDirty()
          if (extractQueue.enqueue({ persona: personaId, id: res.id, session: sessionId, text: ingestText })) {
            lastAgent = agent
            armProbe()
          }
        }
      } catch (err) {
        ctx.logger?.warn?.(`memora: ingest failed: ${err?.message ?? err}`)
      }
    }

    // 不每轮写盘：攒够 5 轮或 idle 时再落一次状态。
    if (turnsSinceSave >= 5) flushPersona()

    return { ...decision, messages: [...decision.messages, injection] }
  })
}
