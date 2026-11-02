/**
 * Memora v2/P3 · 情绪 / 关系状态机 + 语气提示（ALMA 三时标 + TESSERA-lite）
 *
 * 人格底色改用大五（五因子模型 / OCEAN），五个维度 0–100，均可调：
 * - 神经质 Neuroticism：情绪稳定性（越低越稳，越高越敏感/易焦虑）
 * - 外倾性 Extraversion：社交活跃 / 主动 / 话多程度
 * - 开放性 Openness：好奇 / 求新 / 愿意尝试新想法
 * - 宜人性 Agreeableness：温和 / 合作 / 共情程度
 * - 尽责性 Conscientiousness：自律 / 条理 / 可靠程度
 *
 * 三个时标（§2.6）：
 * - 瞬时情绪：`mood.valence`（-1..1）+ `mood.arousal`，6h 半衰回基线（0 / 0.3）；
 * - 心情：每轮按褒/贬词表微调，单轮 ±0.2 封顶；
 * - 底色：`traits`（大五五维）+ 固定 `attachment`，月级漂移每字段 ≤2，只影响措辞。
 *
 * 关系量：
 * - `trust` 单日 ±1（净变化封顶）；`familiarity` 单日 +2（每轮 +0.5）。
 * - 风险轮冻结：`observe({risk:true})` 直接返回，不改任何字段。
 *
 * 写盘：`observe` 只改内存；由 index.js 每 5 轮或 idle 调 `saveState` 一次。
 * 红线：只产出一行【关系】提示与语气建议，不参与召回打分、不影响安全护栏。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MEMORA_HOME = process.env.MEMORA_HOME || path.join(os.homedir(), '.memora')
const STATE_VERSION = 1
const MOOD_HALF_LIFE_HOURS = 6
const AROUSAL_BASELINE = 0.3
const VALENCE_TURN_CAP = 0.2
const DAILY_TRUST_CAP = 1
const DAILY_FAMILIARITY_CAP = 2
const FAMILIARITY_TURN_STEP = 0.5
const TRAIT_MONTH_CAP = 2
const SNAPSHOT_EVERY = 30
const MAX_SNAPSHOTS = 12

/** 大五维度（顺序固定，只影响输出/漂移，不影响召回与安全）。 */
export const BIG_FIVE_KEYS = [
  'neuroticism',
  'extraversion',
  'openness',
  'agreeableness',
  'conscientiousness',
]

/** 中性人格基线：五维全 50。preset 可用 config.traits 覆盖任意维度。 */
export const DEFAULT_TRAITS = {
  neuroticism: 50,
  extraversion: 50,
  openness: 50,
  agreeableness: 50,
  conscientiousness: 50,
}

/** 褒 / 贬词表各 ≤20 条（高精度、口语常见）。 */
const POSITIVE_WORDS = [
  '谢谢', '感谢', '开心', '高兴', '喜欢', '太棒', '厉害', '可爱', '温柔', '贴心',
  '辛苦', '加油', '好多了', '懂了', '明白', '有用', '帮到', '满意', '舒服', '放心',
]
const NEGATIVE_WORDS = [
  '烦', '讨厌', '生气', '失望', '难过', '无聊', '没用', '闭嘴', '蠢', '笨',
  '别说了', '不想聊', '够了', '垃圾', '差劲', '难受', '压力', '累', '崩', '敷衍',
]

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const round4 = (v) => Math.round(v * 10000) / 10000
const dateKey = (ts) => new Date(ts).toISOString().slice(0, 10)
const monthKey = (ts) => new Date(ts).toISOString().slice(0, 7)
/** 数值或回退：缺字段/非数字时用 fallback，不把 0 当缺省。 */
const toNum = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function stateFile(persona) {
  const safe = String(persona || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(MEMORA_HOME, `memora-${safe}.state.json`)
}

/** 归一化大五值：可只给部分维度，其余用 fallback（默认中性 50）；全部夹到 0–100。 */
export function normalizeTraits(traits, fallback = DEFAULT_TRAITS) {
  const out = {}
  for (const k of BIG_FIVE_KEYS) {
    out[k] = clamp(toNum(traits?.[k], fallback?.[k] ?? 50), 0, 100)
  }
  return out
}

function zeroDrift() {
  return { neuroticism: 0, extraversion: 0, openness: 0, agreeableness: 0, conscientiousness: 0 }
}

/** 默认状态（新人：熟悉度 20、信任 30、安全型依恋；大五用传入或中性值）。 */
export function defaultState(now = Date.now(), traits) {
  return {
    version: STATE_VERSION,
    attachment: 'secure',
    familiarity: 20,
    trust: 30,
    mood: { valence: 0, arousal: 0.4, updated_at: new Date(now).toISOString() },
    traits: normalizeTraits(traits),
    proactive_off_until: null,
    turns: 0,
    daily: { date: dateKey(now), trust: 0, familiarity: 0 },
    traitsDrift: { month: monthKey(now), ...zeroDrift() },
    snapshots: [],
    updated_at: new Date(now).toISOString(),
  }
}

/** 规范化外部状态：缺字段补默认、数值夹到合法区间、快照截断。 */
function normalizeState(raw, now, baseTraits) {
  const base = defaultState(now, baseTraits)
  if (!raw || typeof raw !== 'object') return base
  const st = {
    ...base,
    ...raw,
    version: STATE_VERSION,
    attachment: ['secure', 'anxious', 'avoidant'].includes(raw.attachment) ? raw.attachment : 'secure',
    familiarity: clamp(Number(raw.familiarity) || 0, 0, 100),
    trust: clamp(Number(raw.trust) || 0, 0, 100),
    mood: {
      valence: clamp(Number(raw?.mood?.valence) || 0, -1, 1),
      arousal: clamp(Number(raw?.mood?.arousal) || 0, 0, 1),
      updated_at: raw?.mood?.updated_at || new Date(now).toISOString(),
    },
    traits: normalizeTraits(raw?.traits, base.traits),
    turns: Math.max(0, Math.floor(Number(raw.turns) || 0)),
    daily: {
      date: raw?.daily?.date || dateKey(now),
      trust: clamp(Number(raw?.daily?.trust) || 0, -DAILY_TRUST_CAP, DAILY_TRUST_CAP),
      familiarity: clamp(Number(raw?.daily?.familiarity) || 0, 0, DAILY_FAMILIARITY_CAP),
    },
    traitsDrift: {
      month: raw?.traitsDrift?.month || monthKey(now),
      neuroticism: clamp(Number(raw?.traitsDrift?.neuroticism) || 0, -TRAIT_MONTH_CAP, TRAIT_MONTH_CAP),
      extraversion: clamp(Number(raw?.traitsDrift?.extraversion) || 0, -TRAIT_MONTH_CAP, TRAIT_MONTH_CAP),
      openness: clamp(Number(raw?.traitsDrift?.openness) || 0, -TRAIT_MONTH_CAP, TRAIT_MONTH_CAP),
      agreeableness: clamp(Number(raw?.traitsDrift?.agreeableness) || 0, -TRAIT_MONTH_CAP, TRAIT_MONTH_CAP),
      conscientiousness: clamp(Number(raw?.traitsDrift?.conscientiousness) || 0, -TRAIT_MONTH_CAP, TRAIT_MONTH_CAP),
    },
    snapshots: Array.isArray(raw.snapshots) ? raw.snapshots.slice(-MAX_SNAPSHOTS) : [],
  }
  if (st.daily.date !== dateKey(now)) st.daily = { date: dateKey(now), trust: 0, familiarity: 0 }
  if (st.traitsDrift.month !== monthKey(now)) st.traitsDrift = { month: monthKey(now), ...zeroDrift() }
  return st
}

/**
 * 载入状态（含 6h 心情半衰）。只在内存里衰减，不写盘。
 * 文件缺失/损坏 → 默认状态（损坏文件留给人看，不自动删）。
 * `baseTraits` 是 preset 给的大五底色：老状态缺维度时用它补齐。
 */
export function loadState(persona, now = Date.now(), baseTraits) {
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(stateFile(persona), 'utf8'))
  } catch {
    raw = null
  }
  const st = normalizeState(raw, now, baseTraits)
  return decayMood(st, now)
}

/** 6h 半衰：valence → 0，arousal → 0.3。返回同一个对象。 */
export function decayMood(st, now = Date.now()) {
  const last = Date.parse(st?.mood?.updated_at) || now
  const hours = Math.max(0, (now - last) / 3_600_000)
  if (hours <= 0) {
    st.mood.updated_at = new Date(now).toISOString()
    return st
  }
  const f = Math.pow(0.5, hours / MOOD_HALF_LIFE_HOURS)
  st.mood.valence = round4(st.mood.valence * f)
  st.mood.arousal = round4(AROUSAL_BASELINE + (st.mood.arousal - AROUSAL_BASELINE) * f)
  st.mood.updated_at = new Date(now).toISOString()
  return st
}

/** 原子写状态文件（index.js 每 5 轮 / idle 调一次）。 */
export function saveState(persona, state) {
  fs.mkdirSync(MEMORA_HOME, { recursive: true })
  const file = stateFile(persona)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state) + '\n')
  fs.renameSync(tmp, file)
  return { ok: true }
}

/** 删除状态文件（§8：删 `.state.json` 即回默认）。 */
export function resetState(persona) {
  try { fs.unlinkSync(stateFile(persona)) } catch { /* 无文件 */ }
  return { ok: true }
}

function countWords(text, words) {
  const s = String(text ?? '')
  let n = 0
  for (const w of words) if (s.includes(w)) n++
  return n
}

function ensureDay(st, now) {
  if (st.daily.date === dateKey(now)) return
  st.daily = { date: dateKey(now), trust: 0, familiarity: 0 }
}

function ensureMonth(st, now) {
  if (st.traitsDrift.month === monthKey(now)) return
  st.traitsDrift = { month: monthKey(now), ...zeroDrift() }
}

/** 信任变化：单日净变化封顶 ±1；返回是否真的改了。 */
function bumpTrust(st, delta) {
  const room = delta > 0 ? DAILY_TRUST_CAP - st.daily.trust : DAILY_TRUST_CAP + st.daily.trust
  if (room <= 0) return false
  const d = clamp(delta, -room, room)
  st.trust = clamp(round4(st.trust + d), 0, 100)
  st.daily.trust = round4(st.daily.trust + d)
  return true
}

/** 月级大五漂移，每字段每月 ≤2。正性→更外倾/宜人/少神经质；负性→更神经质。 */
function driftTraits(st) {
  const plans = []
  if (st.mood.valence > 0.2) plans.push(['extraversion', 1], ['agreeableness', 1], ['neuroticism', -1])
  else if (st.mood.valence < -0.2) plans.push(['neuroticism', 1], ['agreeableness', -1])
  let changed = false
  for (const [key, dir] of plans) {
    if (Math.abs(st.traitsDrift[key] ?? 0) >= TRAIT_MONTH_CAP) continue
    st.traits[key] = clamp(st.traits[key] + dir, 0, 100)
    st.traitsDrift[key] = (st.traitsDrift[key] ?? 0) + dir
    changed = true
  }
  return changed
}

function pushSnapshot(st, now) {
  st.snapshots.push({
    at: new Date(now).toISOString(),
    familiarity: st.familiarity,
    trust: st.trust,
    valence: st.mood.valence,
    arousal: st.mood.arousal,
    traits: { ...st.traits },
  })
  while (st.snapshots.length > MAX_SNAPSHOTS) st.snapshots.shift()
}

/**
 * 每轮观察（纯内存，不写盘）。
 *
 * - `text` 决定 valence / trust / familiarity 的微调；
 * - `correction` 表示本轮是纠错轮（信任轻微下降 + 语气提示先认错）；
 * - `risk` 为 true 时冻结：不读盘以外的任何变更，原样返回；
 * - 传入 `state` 则原地修改并返回同一对象；不传则从磁盘载入。
 *
 * @returns {{ state: object, changed: boolean, frozen?: boolean }}
 */
export function observe({ persona, state, text, risk = false, correction = false, now = Date.now() } = {}) {
  const st = state || loadState(persona, now)
  if (risk) return { state: st, changed: false, frozen: true }

  decayMood(st, now)
  ensureDay(st, now)
  ensureMonth(st, now)
  const s = String(text ?? '')
  const pos = countWords(s, POSITIVE_WORDS)
  const neg = countWords(s, NEGATIVE_WORDS)
  let changed = false

  if (pos !== neg) {
    const dir = pos > neg ? 1 : -1
    st.mood.valence = clamp(round4(st.mood.valence + dir * VALENCE_TURN_CAP), -1, 1)
    st.mood.arousal = clamp(round4(st.mood.arousal + (dir > 0 ? 0.05 : 0.1)), 0, 1)
    changed = true
  }
  if (pos > neg && bumpTrust(st, 0.3)) changed = true
  if (neg > pos && bumpTrust(st, -0.5)) changed = true
  if (correction && bumpTrust(st, -0.3)) changed = true

  if (s.trim()) {
    const add = Math.min(FAMILIARITY_TURN_STEP, DAILY_FAMILIARITY_CAP - st.daily.familiarity)
    if (add > 0) {
      st.familiarity = clamp(round4(st.familiarity + add), 0, 100)
      st.daily.familiarity = round4(st.daily.familiarity + add)
      changed = true
    }
  }

  if (driftTraits(st)) changed = true

  st.turns = (st.turns ?? 0) + 1
  if (st.turns % SNAPSHOT_EVERY === 0) {
    pushSnapshot(st, now)
    changed = true
  }
  st.updated_at = new Date(now).toISOString()
  return { state: st, changed }
}

function emotionLabel(valence, arousal) {
  if (valence <= -0.5) return '低落'
  if (valence <= -0.2) return '有点低落'
  if (valence < -0.05) return '略闷'
  if (valence >= 0.5) return arousal > 0.7 ? '兴奋' : '很好'
  if (valence >= 0.2) return '不错'
  return '平静'
}

/** 情绪中性时按大五底色给一句语气提示（只取最显著的一维）。 */
function traitAdvice(traits) {
  const t = traits ?? {}
  if (t.agreeableness >= 70) return '语气温和'
  if (t.agreeableness <= 35) return '直说少客套'
  if (t.extraversion >= 70) return '主动有活力'
  if (t.neuroticism >= 70) return '别显焦虑'
  if (t.conscientiousness >= 70) return '条理清楚'
  if (t.openness >= 70) return '愿意聊新想法'
  return ''
}

function adviceFor(state, { correction } = {}) {
  const v = state.mood?.valence ?? 0
  if (correction) return '先认错，按新的说'
  if (v <= -0.3) return '先共情，不接梗'
  if (v <= -0.1) return '收着点，别玩笑'
  if (v >= 0.4) return '可以接梗，别夸张'
  if (state.attachment === 'anxious') return '多确认一句'
  if (state.attachment === 'avoidant') return '别追问'
  return traitAdvice(state.traits)
}

/**
 * §2.4 关系行内容（不含 `【关系】` 前缀，composeC 自动补）。
 * 例：`熟悉度 62 · 信任 48 · 情绪：低落（先共情，不接梗）`，≤25 token。
 */
export function toneHint(state, { correction = false } = {}) {
  const st = state || defaultState()
  const v = st.mood?.valence ?? 0
  const a = st.mood?.arousal ?? AROUSAL_BASELINE
  const advice = adviceFor(st, { correction })
  return `熟悉度 ${Math.round(st.familiarity)} · 信任 ${Math.round(st.trust)} · 情绪：${emotionLabel(v, a)}${advice ? `（${advice}）` : ''}`
}

/** CLI / doctor 用：状态摘要（不含内部漂移计数器）。 */
export function stateSummary(persona, now = Date.now()) {
  const st = loadState(persona, now)
  return {
    persona,
    attachment: st.attachment,
    familiarity: st.familiarity,
    trust: st.trust,
    valence: st.mood.valence,
    arousal: st.mood.arousal,
    tone: toneHint(st),
    traits: { ...st.traits },
    turns: st.turns,
    snapshots: st.snapshots.length,
    proactive_off_until: st.proactive_off_until,
    updated_at: st.updated_at,
  }
}
