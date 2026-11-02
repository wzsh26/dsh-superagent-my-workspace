/**
 * memora-bigfive · Host 半（人格档案 + 模式联动 + 故事生成）。
 *
 * 做四件事：
 * 1) 声明「人格档案」Config：
 *    { activeId, sidebarVisible, personas: [{ id, name, bio, tags[], scores[90],
 *      storyTitle, storyText, importedAt, charCount, summary, experiences[],
 *      memories[], emotions[], history[] }] }
 *    - name  = 角色名（会话「模式」选择里显示的就是它）
 *    - tags  = 标签，可多个
 *    - scores= 90 条行为描述的 1–5 分（维度分由它推出来，见下）
 * 2) 激活/改动时把档案写入 ~/.memora/personas.json（memora 插件按 personaId 取五维）
 * 3) 为「新增的」人格注册一个 agent preset（模式），模式名 = 角色名
 * 4) 暴露一个 RPC 端点 /memora-bigfive/generate，供设置页「故事导入生成人格」调用：
 *    读故事 → 调默认模型 → 结构化人格卡
 *
 * 维度分换算：一个维度 6 个 facet × 每个 3 条行为项 = 18 条，
 *   维度均分 = 这 18 条的均值（1–5），转成 0–100 = 均分 ÷ 5 × 100。
 *   与客户端 client.js 的 DIMENSIONS / ITEMS 必须保持完全一致。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

const MEMORA_HOME = process.env.MEMORA_HOME || path.join(os.homedir(), '.memora')
const PERSONAS_FILE = path.join(MEMORA_HOME, 'personas.json')

export const name = 'memora-bigfive'

/** 维度定义：[key, 中文名, 颜色, [[facetKey, facet名, [3 条行为描述]], ...]]。 */
export const DIMENSIONS = [
  ['openness', '开放性', '#8b5cf6', [
    ['fantasy', '幻想', ['常做生动的白日梦或想象', '脑海中情境与画面丰富', '能从想象中获得满足感']],
    ['aesthetics', '审美', ['对艺术、自然之美敏感', '主动欣赏或创造美的事物', '重视美感体验胜过实用']],
    ['feelings', '感受', ['对自身情绪高度敏感', '情感体验深刻且丰富', '愿沉浸并表达情感']],
    ['actions', '行动', ['愿尝试新做法、非常规路径', '喜欢新鲜多变的体验', '厌倦固定套路与重复']],
    ['ideas', '观念', ['爱探讨非常规、抽象想法', '开放接纳异见与矛盾', '偏好复杂思辨而非简单结论']],
    ['values', '价值', ['质疑传统与权威价值', '容忍多元价值观并存', '按自身标准判断好坏']],
  ]],
  ['conscientiousness', '尽责性', '#3b6ef5', [
    ['competence', '胜任', ['对自己能力有信心', '能有效解决实际问题', '把交代的事做成']],
    ['order', '条理', ['物品与环境保持有序', '计划清晰、步骤明确', '做事有系统不混乱']],
    ['dutifulness', '尽职', ['恪守承诺与义务', '认真负责、不敷衍', '尊重规则与约定']],
    ['achievement', '成就', ['有清晰目标并追求卓越', '努力工作以达标', '自我驱动、不需催促']],
    ['selfDiscipline', '自律', ['能抵抗短期诱惑', '坚持长期计划', '很少拖延']],
    ['deliberation', '审慎', ['三思而后行', '主动规避冲动风险', '重大决策谨慎权衡']],
  ]],
  ['extraversion', '外向性', '#f59e0b', [
    ['warmth', '热情', ['对人温暖、友好', '易亲近、有亲和力', '主动表达善意']],
    ['gregariousness', '合群', ['喜欢人群与陪伴', '主动发起社交', '在群体中自在放松']],
    ['assertiveness', '果断', ['表达观点坚定', '敢于主导局面', '在讨论中主动发声']],
    ['activity', '活跃', ['精力充沛、行动多', '生活节奏快', '闲不住、爱忙碌']],
    ['excitement', '刺激寻求', ['爱冒险与新奇', '主动追求刺激感', '厌恶单调沉闷']],
    ['positiveEmotions', '积极情绪', ['常感快乐兴奋', '乐观、少沉郁', '易笑、易乐']],
  ]],
  ['agreeableness', '宜人性', '#10b981', [
    ['trust', '信任', ['相信他人善意', '易托付、不先设防', '假定他人无害']],
    ['straightforwardness', '坦诚', ['直率、不掩饰', '不玩心机', '说真话、少算计']],
    ['altruism', '利他', ['乐于助人', '主动关心他人', '愿牺牲自己便利成全他人']],
    ['compliance', '顺从', ['避免冲突、愿意让步', '不与人正面对抗', '配合他人意愿']],
    ['modesty', '谦逊', ['不张扬、不自负', '低调处世', '不认为自己特殊于他人']],
    ['tenderMindedness', '同理心', ['易同情弱者', '能感受他人之苦', '心软、不忍伤害']],
  ]],
  ['neuroticism', '神经质', '#ef4444', [
    ['anxiety', '焦虑', ['易担心、紧张', '常预感坏事发生', '难以放松']],
    ['anger', '敌意', ['易恼怒', '爱挑剔、指责', '心怀怨愤难消']],
    ['depression', '抑郁', ['情绪易低落', '悲观、无望感', '小事也易失落']],
    ['selfConsciousness', '自我意识', ['在意他人评价', '怕当众出丑', '社交中拘谨害羞']],
    ['impulsiveness', '冲动', ['凭情绪即时行事', '难克制突发欲求', '易有暴食或挥霍等行为']],
    ['vulnerability', '脆弱', ['压力下易崩溃', '难独自扛事', '困境中急需他人支持']],
  ]],
]

/** 扁平化后的 90 条行为描述，下标即 scores 的下标。 */
export const ITEMS = []
for (const [, , , facets] of DIMENSIONS) {
  for (const [, , items] of facets) {
    for (const text of items) ITEMS.push(text)
  }
}

export const SCORE_COUNT = ITEMS.length

/** bundle patch 里已静态定义的 personaId，不再动态注册模式。 */
const STATIC_PERSONA_IDS = new Set(['gentle_senior', 'tsundere_buddy'])

const clampScore = (n) => {
  const x = Number(n)
  return Number.isFinite(x) ? Math.min(5, Math.max(1, Math.round(x))) : 3
}

/** 情绪效价：-5（负）~ +5（正），保留 1 位小数。 */
const clampValence = (n) => {
  const x = Number(n)
  return Number.isFinite(x) ? Math.min(5, Math.max(-5, Math.round(x * 10) / 10)) : 0
}

/** 把任意长度的分数补/截成恰好 90 个合法分数。 */
export function normalizeScores(src) {
  const list = Array.isArray(src) ? src : []
  const out = []
  for (let i = 0; i < SCORE_COUNT; i += 1) out.push(clampScore(list[i] === undefined ? 3 : list[i]))
  return out
}

/** 维度 0–100：该维度 18 条行为项的均值 ÷ 5 × 100。 */
export function dimensionValue(scores, dimIndex) {
  const start = dimIndex * 18
  let sum = 0
  for (let i = start; i < start + 18; i += 1) sum += scores[i] || 3
  return Math.round((sum / 18) / 5 * 100)
}

export function dimensionsOf(scores) {
  const out = {}
  DIMENSIONS.forEach(([key], i) => { out[key] = dimensionValue(scores, i) })
  return out
}

/** 五维标签只有高/中/低三档：≥70 高，≥50 中，其余低。 */
export function tagLevel(value) {
  return value >= 70 ? '高' : value >= 50 ? '中' : '低'
}

/** 90 条行为分 → 五个「高/中/低 + 维度名」标签（顺序与 DIMENSIONS 一致）。 */
export function tagsFromScores(scores) {
  const normalized = normalizeScores(scores)
  return DIMENSIONS.map(([key, name], i) => `${tagLevel(dimensionValue(normalized, i))}${name}`)
}

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback)
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

/** 一句话简介最多 20 个字；超长时用省略号收尾。 */
const BIO_LIMIT = 20
const clipBio = (v) => {
  const chars = Array.from(str(v).trim())
  return chars.length <= BIO_LIMIT ? chars.join('') : chars.slice(0, BIO_LIMIT - 1).join('') + '…'
}

const experienceSchema = z.object({
  title: z.string().default('').loose(),
  detail: z.string().default('').loose(),
})

const historySchema = z.object({
  at: z.number().default(0).loose(),
  action: z.string().default('').loose(),
  tags: z.array(z.string()).default([]).loose(),
  summary: z.string().default('').loose(),
  storyTitle: z.string().default('').loose(),
  storyExcerpt: z.string().default('').loose(),
  scores: z.array(z.number()).default([]).loose(),
})

/** 互动记录：从对话里萃取出来的长期记忆（偏好 / 事件 / 承诺）。 */
const memorySchema = z.object({
  at: z.number().default(0).loose(),
  type: z.string().default('').loose(),
  domain: z.string().default('').loose(),
  content: z.string().default('').loose(),
})

/** 情绪波动：每段互动后的情绪效价（-5 ~ +5）与类别。 */
const emotionSchema = z.object({
  at: z.number().default(0).loose(),
  valence: z.number().default(0).loose(),
  category: z.string().default('').loose(),
  memory: z.string().default('').loose(),
})

// .loose()：值不合法时退回默认值，而不是让整份配置校验失败。
// 配置校验失败会让 DSH 起不来，所以这里宁可降级也不报错。
const personaSchema = z.object({
  id: z.string().default('').loose(),
  name: z.string().default('').loose(),
  bio: z.string().default('').loose(),
  tags: z.array(z.string()).default([]).loose(),
  scores: z.array(z.number()).default([]).loose(),
  storyTitle: z.string().default('').loose(),
  storyText: z.string().default('').loose(),
  importedAt: z.number().default(0).loose(),
  charCount: z.number().default(0).loose(),
  summary: z.string().default('').loose(),
  experiences: z.array(experienceSchema).default([]).loose(),
  memories: z.array(memorySchema).default([]).loose(),
  emotions: z.array(emotionSchema).default([]).loose(),
  history: z.array(historySchema).default([]).loose(),
}).loose()

// 整个 Config 必须标 .volatile()：DSH 的 settings.describe 只投影带 volatile 的字段，
// 没有它 memora-bigfive 这个 namespace 根本不会出现在设置表单里（getSnapshot 为空、
// mutate 写不进去），表现就是助理列表永远是空的、生成完也加不进去。
export const Config = z.object({
  activeId: z.string().default('').loose(),
  sidebarVisible: z.boolean().default(false).loose(),
  personas: z.array(personaSchema).default([]).loose(),
}).loose().volatile()

/** 兼容数组/对象两种历史形状。 */
function toList(src) {
  if (Array.isArray(src)) return src
  if (src && typeof src === 'object') return Object.values(src)
  return []
}

/** 老档案没有 scores 时，从 facets 的 μ（0–100）反推行为分。 */
function scoresFromLegacyFacets(p, dimIndex) {
  const spec = DIMENSIONS[dimIndex]
  const out = []
  for (const [key] of spec[3]) {
    const mu = Number(p?.facets?.[key]?.mu)
    const dimVal = Number(p?.[spec[0]])
    const base = Number.isFinite(mu) ? mu : (Number.isFinite(dimVal) ? dimVal : 50)
    const v = clampScore(Math.round(base / 20))
    out.push(v, v, v)
  }
  return out
}

/** 原始档案里是否已经有真实五维数据（草稿没有，标签应保持为空）。 */
function hasScoreData(p) {
  if (Array.isArray(p?.scores) && p.scores.length > 0) return true
  if (p?.facets && typeof p.facets === 'object' && Object.keys(p.facets).length > 0) return true
  return DIMENSIONS.some(([key]) => Number.isFinite(Number(p?.[key])))
}

export function normalizePersona(p, i) {
  // 草稿（没有 scores / facets / 五维字段）保持空分，不补 90 个默认分。
  let scores = []
  if (Array.isArray(p?.scores) && p.scores.length > 0) scores = normalizeScores(p.scores)
  else if (hasScoreData(p)) {
    const legacy = []
    DIMENSIONS.forEach((_, di) => { legacy.push(...scoresFromLegacyFacets(p, di)) })
    scores = normalizeScores(legacy)
  }
  return {
    id: String(p?.id ?? '').trim() || `persona-${Date.now()}-${i}`,
    name: str(p?.name).trim() || `角色 ${i + 1}`,
    bio: clipBio(p?.bio),
    tags: scores.length > 0 ? tagsFromScores(scores) : [],
    scores,
    storyTitle: str(p?.storyTitle).trim(),
    storyText: str(p?.storyText),
    importedAt: num(p?.importedAt, 0),
    charCount: num(p?.charCount, 0),
    summary: str(p?.summary),
    experiences: (Array.isArray(p?.experiences) ? p.experiences : [])
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({ title: str(e.title).trim() || '关键经历', detail: str(e.detail).trim() }))
      .slice(0, 12),
    memories: (Array.isArray(p?.memories) ? p.memories : [])
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({
        at: num(e.at, 0),
        type: str(e.type).trim(),
        domain: str(e.domain).trim(),
        content: str(e.content).trim(),
      }))
      .filter((e) => e.content)
      .slice(0, 60),
    emotions: (Array.isArray(p?.emotions) ? p.emotions : [])
      .filter((e) => e && typeof e === 'object' && Number.isFinite(Number(e.valence)))
      .map((e) => ({
        at: num(e.at, 0),
        valence: clampValence(e.valence),
        category: str(e.category).trim(),
        memory: str(e.memory).trim(),
      }))
      .slice(0, 500),
    history: (Array.isArray(p?.history) ? p.history : [])
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({
        at: num(e.at, 0),
        action: str(e.action).trim() || '评分',
        tags: Array.isArray(e.scores) && e.scores.length > 0 ? tagsFromScores(e.scores) : [],
        summary: str(e.summary),
        storyTitle: str(e.storyTitle),
        storyExcerpt: str(e.storyExcerpt).slice(0, 600),
        scores: normalizeScores(e.scores),
      }))
      .slice(0, 12),
  }
}

function normalizePersonas(src) {
  return toList(src).map((p, i) => normalizePersona(p, i))
}

/** 把配置里的人格档案写盘；空列表不写，避免覆盖已有档案。 */
export function writePersonas(raw) {
  const personas = normalizePersonas(raw?.personas)
  // 草稿还没有真实五维数据，不写进 personas.json，避免用一排 60 覆盖
  // 静态 preset（温柔学姐 / 嘴硬损友）自己配置的 traits。
  const scored = personas.filter((p) => p.scores.length > 0)
  if (scored.length === 0) return
  fs.mkdirSync(MEMORA_HOME, { recursive: true })
  fs.writeFileSync(
    PERSONAS_FILE,
    JSON.stringify({
      activeId: String(raw?.activeId ?? ''),
      sidebarVisible: raw?.sidebarVisible === true,
      // memora-dsh 只读 id / name / 五维，这里把维度换算好写进去。
      personas: scored.map((p) => ({ id: p.id, name: p.name, tags: p.tags, ...dimensionsOf(p.scores) })),
    }) + '\n',
  )
}

/** 从人格档案生成一段 system prompt（含角色名 / 标签 / 大五数值 / 记忆边界）。 */
function buildPersonaPrefix(p) {
  const dims = dimensionsOf(p.scores)
  const lines = [
    `你是「${p.name}」。${p.bio || ''}`.trim(),
    p.tags.length > 0 ? `你的性格标签：${p.tags.join('、')}。` : '',
    `你的大五人格（0–100）：开放性 ${dims.openness}，尽责性 ${dims.conscientiousness}，外向性 ${dims.extraversion}，宜人性 ${dims.agreeableness}，神经质 ${dims.neuroticism}。`,
  ]
  if (p.summary) {
    lines.push('', '人格卡：', p.summary)
  }
  if (p.experiences.length > 0) {
    lines.push('', '关键经历：', ...p.experiences.map((e) => `- ${e.title}：${e.detail}`))
  }
  lines.push(
    '',
    '说话风格：自然口语，短句；先接住对方的情绪，再回应内容。',
    '',
    '边界：',
    '- 只依据【本轮记忆】里明确写出的事实谈过去。',
    '- 【本轮记忆】写"无相关记忆"时，不要承认任何过去的事，只回答："这对我还是新的，你再跟我说说？"',
    '- 【本轮记忆】有内容时，直接承认并用上；绝对不要说"这对我还是新的"。',
    '- 不提供医疗、法律、金融诊断；遇到自伤或伤人风险，先稳住情绪，再建议求助。',
    '- 不替用户做不可逆决定，不替用户承诺第三方。',
    '- 不要向用户提到"记忆""上下文""规则"这些词。',
  )
  return lines.filter((l) => l !== '').join('\n')
}

/** 新人格对应的一条 agent preset 的 plugins 列表（与 bundle 里的结构一致）。 */
function presetPlugins(p) {
  return [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { complete: true, includeRuntimeContext: false, prefix: buildPersonaPrefix(p) },
    },
    {
      id: 'memora',
      name: 'memora-dsh',
      config: { personaId: p.id, extract: { idleDelayMs: 1200 } },
    },
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true },
      config: [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' }],
    },
  ]
}

/** 只允许安全字符，避免 preset id 非法导致注册抛错。 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/

/**
 * 让「人格档案」和「模式（agent preset）」保持同步。
 *
 * 注意：Config 整体标了 .volatile()（设置页要能实时读写），DSH 的 loader 对
 * 纯 volatile 的配置变更不会重启插件，只会把新值 commit 进运行中的 config。
 * 所以在 apply 里注册一次是不够的 —— 新增人格后模式列表不会更新。这里监听
 * loader/volatile-update，按当前 config 做增删同步。
 */
function registerPresets(ctx, config) {
  if (!ctx || typeof ctx.inject !== 'function') return

  const readPersonas = () => {
    try {
      const raw = config && typeof config.get === 'function' ? config.get() : config
      return normalizePersonas(raw?.personas)
    } catch {
      return []
    }
  }

  let requestSync = () => {}

  // 这个事件只发给本插件 fiber，用来感知 volatile 配置的热更新。
  // 顺手把最新档案写进 ~/.memora/personas.json，否则新人格的五维底色不会生效。
  try {
    ctx.on?.('loader/volatile-update', () => {
      try {
        const raw = config && typeof config.get === 'function' ? config.get() : config
        writePersonas(raw)
      } catch (err) {
        ctx.logger?.warn?.(`memora-bigfive: write personas on update failed: ${err?.message ?? err}`)
      }
      requestSync()
    })
  } catch {}

  // 注意：inject 的回调是在服务就绪后才跑的，外面的 try/catch 抓不到它，
  // 所以这里必须自己在回调内部再包一层 —— 之前 DSH 起不来就栽在这类异步回调上。
  ctx.inject(['agentPresets'], (child) => {
    try {
      if (!child.agentPresets || typeof child.agentPresets.register !== 'function') return
      const registered = new Map() // personaId -> dispose()
      let disposed = false
      let queue = Promise.resolve()

      const sync = async () => {
        if (disposed) return
        const personas = readPersonas()
        const wanted = new Map()
        personas.forEach((persona, index) => {
          if (!persona || !SAFE_ID.test(persona.id) || STATIC_PERSONA_IDS.has(persona.id)) return
          wanted.set(persona.id, { persona, order: 40 + index })
        })

        // 先删掉配置里已经不存在的人格
        for (const [id, dispose] of [...registered]) {
          if (wanted.has(id)) continue
          registered.delete(id)
          try { await dispose() } catch (err) {
            ctx.logger?.warn?.(`memora-bigfive: preset ${id} 注销失败（已跳过）: ${err?.message ?? err}`)
          }
        }

        // 再补上新出现的人格
        for (const [id, { persona, order }] of wanted) {
          if (registered.has(id)) continue
          try {
            const dispose = await child.agentPresets.register({
              id: `memora-${id}`,
              // 会话「选模式」里显示的就是角色名。
              name: persona.name,
              description: persona.bio || '本地人格会话，无工具，低资源。',
              order,
              plugins: presetPlugins(persona),
            })
            if (disposed) { try { await dispose?.() } catch {} ; continue }
            registered.set(id, typeof dispose === 'function' ? dispose : () => {})
          } catch (err) {
            ctx.logger?.warn?.(`memora-bigfive: preset ${id} 注册失败（已跳过）: ${err?.message ?? err}`)
          }
        }
      }

      const schedule = () => {
        queue = queue.then(sync).catch((err) => {
          ctx.logger?.warn?.(`memora-bigfive: preset 同步失败（已跳过）: ${err?.message ?? err}`)
        })
      }
      requestSync = schedule

      child.effect(() => () => {
        disposed = true
        const pending = [...registered.values()]
        registered.clear()
        for (const dispose of pending) {
          try { dispose() } catch {}
        }
      }, 'memora-bigfive.presets')

      schedule()
    } catch (err) {
      ctx.logger?.warn?.(`memora-bigfive: preset 注册整体失败（已跳过）: ${err?.message ?? err}`)
    }
  })
}

// ── 故事 → 人格卡（调默认模型） ───────────────────────────────────────────

function buildPrompt({ storyTitle, storyText, nameHint, bioHint }) {
  const numbered = ITEMS.map((text, i) => `${i}. ${text}`).join('\n')
  return [
    '你是一名人格分析助手。请阅读下面这段小说/故事文本，为其中的主要人物建立一张大五人格（OCEAN）档案。',
    '',
    '【任务】',
    '1. 判断这个人物的性格。',
    `2. 对下面 0–${SCORE_COUNT - 1} 号共 ${SCORE_COUNT} 条行为描述逐条打 1–5 分：1=完全不符合，5=完全符合。必须每条都打分，顺序与编号严格一致。`,
    '3. 给出角色名、一句话简介、人物摘要（只写三段：性格 / 说话方式 / 内在矛盾）、3–5 条关键经历（性格标签由人物剖析图自动推导，不用你写）。',
    '',
    '【行为描述】',
    numbered,
    '',
    '【输出格式】只输出一个 JSON 对象，不要解释、不要 markdown 代码块：',
    '{',
    '  "name": "角色名，故事里有名字就用故事的",',
    '  "bio": "一句话简介，20 字以内",',
    '  "summary": "性格：……\\n说话方式：……\\n内在矛盾：……",',
    '  "experiences": [{"title": "事件名", "detail": "一句话说明"}],',
    `  "scores": [${SCORE_COUNT} 个 1–5 的整数]`,
    '}',
    '',
    `【用户填写的角色名】${nameHint || '（未填，请你按故事定）'}`,
    `【用户填写的一句话简介】${bioHint || '（未填，请你按故事写）'}`,
    `【故事标题】${storyTitle || '（未填）'}`,
    '',
    '【故事正文】',
    storyText,
  ].join('\n')
}

/** 从模型输出里抠出 JSON 对象。 */
function extractJson(text) {
  const raw = String(text || '').trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON')
  return JSON.parse(body.slice(start, end + 1))
}

function normalizeGenerated(raw, input) {
  const obj = extractJson(raw)
  const experiences = (Array.isArray(obj.experiences) ? obj.experiences : [])
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({ title: String(e.title || '').trim(), detail: String(e.detail || '').trim() }))
    .filter((e) => e.title || e.detail)
    .slice(0, 6)
  const scores = normalizeScores(obj.scores)
  const storyText = String(input.storyText || '')
  return {
    name: String(input.nameHint || obj.name || '').trim() || '未命名角色',
    bio: clipBio(input.bioHint || obj.bio || ''),
    // 标签不再由模型自由发挥，统一从 90 条行为分推出五维高/中/低。
    tags: tagsFromScores(scores),
    scores,
    summary: String(obj.summary || '').trim(),
    experiences,
    storyTitle: String(input.storyTitle || '').trim(),
    storyText,
    importedAt: Date.now(),
    charCount: storyText.replace(/\s/g, '').length,
  }
}

/** 调默认模型，把故事变成人格卡。 */
async function generateFromStory(ctx, input) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('当前环境没有可用的模型服务')

  let route
  try {
    const def = ctx.get('agentDefaultModel')
    route = def && typeof def.currentSelection === 'function' ? def.currentSelection() : undefined
  } catch {}
  const provider = (route && route.provider) || 'deepseek-account'
  const model = (route && route.model) || 'deepseek-flash'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180000)
  let text = ''
  let failure
  try {
    const stream = llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(input) }] }],
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') text += chunk.text || ''
      else if (chunk.type === 'finish' && chunk.reason) {
        const kind = chunk.reason.kind
        if (kind === 'error' || kind === 'aborted') {
          failure = chunk.reason.failure || { message: `模型返回异常：${kind}` }
        }
      }
    }
  } catch (err) {
    failure = { message: err?.message ?? String(err) }
  } finally {
    clearTimeout(timer)
  }
  if (failure) throw new Error(failure.message || '模型调用失败')
  if (!text.trim()) throw new Error('模型没有返回内容')
  return normalizeGenerated(text, input)
}

// ── 插件入口 ──────────────────────────────────────────────────────────────

const GENERATE_PATH = '/api/memora-bigfive/generate'

/** 统一的 JSON 响应。 */
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * 注册「故事 → 人格卡」的精确 HTTP 路由。
 * 走 connection 的 exact Fetch route（/api/...），浏览器侧直接 POST JSON 即可，
 * 不需要 Typert RPC 那套 descriptor。
 */
function registerGenerateRoute(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return
  ctx.inject(['connection'], (child) => {
    try {
      const connection = child.connection
      if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
        ctx.logger?.warn?.('memora-bigfive: connection.fetch 不可用，故事生成接口未注册')
        return
      }
      connection.fetch.register({
        path: GENERATE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
          let payload
          try {
            payload = await request.json()
          } catch {
            return jsonResponse({ ok: false, error: { message: '请求体不是 JSON' } }, 400)
          }
          const input = payload && typeof payload === 'object' ? payload : {}
          const storyText = String(input.storyText || '').trim()
          if (!storyText) return jsonResponse({ ok: false, error: { message: '请先填写人物故事文本' } }, 400)
          if (storyText.length > 40000) return jsonResponse({ ok: false, error: { message: '故事文本最多 4 万字' } }, 400)
          try {
            const value = await generateFromStory(ctx, {
              storyText,
              storyTitle: String(input.storyTitle || '').trim(),
              nameHint: String(input.nameHint || '').trim(),
              bioHint: String(input.bioHint || '').trim(),
            })
            return jsonResponse({ ok: true, value })
          } catch (err) {
            ctx.logger?.warn?.(`memora-bigfive: 生成失败: ${err?.message ?? err}`)
            return jsonResponse({ ok: false, error: { message: err?.message ?? String(err) } }, 500)
          }
        },
      })
    } catch (err) {
      ctx.logger?.warn?.(`memora-bigfive: 生成路由注册失败（已跳过）: ${err?.message ?? err}`)
    }
  })
}

export function apply(ctx, config) {
  const raw = config && typeof config.get === 'function' ? config.get() : config
  try {
    writePersonas(raw)
  } catch (err) {
    ctx?.logger?.warn?.(`memora-bigfive: write personas failed: ${err?.message ?? err}`)
  }
  try {
    registerPresets(ctx, config)
  } catch (err) {
    ctx?.logger?.warn?.(`memora-bigfive: register presets failed: ${err?.message ?? err}`)
  }
  try {
    registerGenerateRoute(ctx)
  } catch (err) {
    ctx?.logger?.warn?.(`memora-bigfive: register generate route failed: ${err?.message ?? err}`)
  }
}
