/**
 * memora-bigfive · Host 半（人格档案 + 模式联动）。
 *
 * 顶层插件（包根名挂载），做三件事：
 * 1) 声明「人格档案」 Config：{ activeId, sidebarVisible, personas: [{ id, name, 5 维 }] }
 * 2) 激活/改动时把档案写入 ~/.memora/personas.json（memora 插件按 personaId 取用）
 * 3) 为「新增的」人格注册一个 agent preset（模式），让新人格出现在新建会话的
 *    人格/模式选择里。原有两个模式（温柔学姐/嘴硬损友）仍由 bundle patch 静态定义，
 *    这里只补新增的，避免重复。
 *
 * 客户端半在 client.js（同包 ./client 导出），由 DSH 的 dsh.client 机制加载。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

const MEMORA_HOME = process.env.MEMORA_HOME || path.join(os.homedir(), '.memora')
const PERSONAS_FILE = path.join(MEMORA_HOME, 'personas.json')

export const name = 'memora-bigfive'

const KEYS = ['neuroticism', 'extraversion', 'openness', 'agreeableness', 'conscientiousness']

/** bundle patch 里已静态定义的 personaId，不再动态注册模式。 */
const STATIC_PERSONA_IDS = new Set(['gentle_senior', 'tsundere_buddy'])

// .loose()：值不合法时退回默认值，而不是让整份配置校验失败。
// 配置校验失败会让 DSH 起不来，所以这里宁可降级也不报错。
const slider = (label) =>
  z.number().min(0).max(100).step(1).default(50).role('slider').description(label).loose()

const clamp = (n) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50)

/** 每个维度 3 个 facet，顺序与 UI 一致。 */
export const FACET_KEYS = {
  extraversion: ['sociability', 'assertiveness', 'energyLevel'],
  agreeableness: ['compassion', 'respectfulness', 'trust'],
  conscientiousness: ['organization', 'productiveness', 'selfDiscipline'],
  neuroticism: ['anxiety', 'depression', 'emotionalVolatility'],
  openness: ['curiosity', 'aestheticSensitivity', 'creativeImagination'],
}

// facet 的三个参数：μ 基线（唯一可编辑）、σ 波动幅度、θ 吸引子强度。
// 字段不给默认值：缺省时保留 {}，让客户端按维度值推出 μ，
// 这样老数据（只有五维、没有 facet）不会被误当成「μ 全是 50」。
const facetSchema = z.object({
  mu: z.number().min(0).max(100).step(1).loose(),
  sigma: z.number().min(0).max(100).loose(),
  theta: z.number().min(0).max(1).step(0.01).loose(),
})

const facetShape = {}
for (const keys of Object.values(FACET_KEYS)) {
  for (const key of keys) facetShape[key] = facetSchema
}

// 每个字段都给默认值：profile patch 里形状不完整时也能校验通过，
// 不会因为一处脏数据让 DSH 直接起不来。
const personaSchema = z.object({
  id: z.string().default('').loose(),
  name: z.string().default('').loose(),
  neuroticism: slider('神经质'),
  extraversion: slider('外倾性'),
  openness: slider('开放性'),
  agreeableness: slider('宜人性'),
  conscientiousness: slider('尽责性'),
  facets: z.object(facetShape).default({}),
})

export const Config = z.object({
  activeId: z.string().default('').loose(),
  sidebarVisible: z.boolean().default(false).loose(),
  personas: z.array(personaSchema).default([]).loose(),
}).volatile()

/** 兼容数组/对象两种历史形状。 */
function toList(src) {
  if (Array.isArray(src)) return src
  if (src && typeof src === 'object') return Object.values(src)
  return []
}

/** facet 三个参数的安全数值（缺省时用维度值当 μ）。 */
function normalizeFacets(p) {
  const out = {}
  for (const [dim, keys] of Object.entries(FACET_KEYS)) {
    for (const key of keys) {
      const src = p?.facets?.[key]
      const mu = Number(src?.mu)
      const sigma = Number(src?.sigma)
      const theta = Number(src?.theta)
      out[key] = {
        mu: Number.isFinite(mu) ? Math.min(100, Math.max(0, mu)) : clamp(Number(p?.[dim])),
        sigma: Number.isFinite(sigma) ? Math.min(100, Math.max(0, sigma)) : 10,
        theta: Number.isFinite(theta) ? Math.min(1, Math.max(0, theta)) : 0.6,
      }
    }
  }
  return out
}

function normalizePersonas(src) {
  return toList(src)
    .map((p) => {
      const out = {
        id: String(p?.id ?? '').trim() || `persona-${Date.now()}`,
        name: String(p?.name ?? '').trim() || '未命名人格',
      }
      for (const k of KEYS) out[k] = clamp(Number(p?.[k]))
      out.facets = normalizeFacets(p)
      return out
    })
}

/** 把配置里的人格档案写盘；空列表不写，避免覆盖已有档案。 */
export function writePersonas(raw) {
  const personas = normalizePersonas(raw?.personas)
  if (personas.length === 0) return
  fs.mkdirSync(MEMORA_HOME, { recursive: true })
  fs.writeFileSync(
    PERSONAS_FILE,
    JSON.stringify({
      activeId: String(raw?.activeId ?? ''),
      sidebarVisible: raw?.sidebarVisible === true,
      personas,
    }) + '\n',
  )
}

/** 从人格档案生成一段 system prompt（含大五数值 + 记忆边界）。 */
function buildPersonaPrefix(p) {
  return [
    `你是「${p.name}」。你的性格可以用大五人格描述：`,
    `神经质 ${p.neuroticism}/100，外倾性 ${p.extraversion}/100，开放性 ${p.openness}/100，宜人性 ${p.agreeableness}/100，尽责性 ${p.conscientiousness}/100。`,
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
  ].join('\n')
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

/** 为新增人格注册 agent preset（模式）。 */
function registerPresets(ctx, personas) {
  if (!ctx || typeof ctx.inject !== 'function') return
  const dynamic = personas.filter((p) => p && SAFE_ID.test(p.id) && !STATIC_PERSONA_IDS.has(p.id))
  if (dynamic.length === 0) return

  // 注意：inject 的回调是在服务就绪后才跑的，外面的 try/catch 抓不到它，
  // 所以这里必须自己在回调内部再包一层 —— 之前 DSH 起不来就栽在这类异步回调上。
  ctx.inject(['agentPresets'], (child) => {
    try {
      if (!child.agentPresets || typeof child.agentPresets.register !== 'function') return
      dynamic.forEach((p, i) => {
        try {
          const entry = {
            id: `memora-${p.id}`,
            name: `Memora · ${p.name}`,
            description: '本地人格会话，无工具，低资源。',
            order: 40 + i,
            plugins: presetPlugins(p),
          }
          if (typeof child.effect === 'function') {
            child.effect(() => child.agentPresets.register(entry), `preset-${p.id}`)
          } else {
            const dispose = child.agentPresets.register(entry)
            if (typeof dispose === 'function') {
              child.on?.('dispose', dispose)
            }
          }
        } catch (err) {
          ctx.logger?.warn?.(`memora-bigfive: preset ${p.id} 注册失败（已跳过）: ${err?.message ?? err}`)
        }
      })
    } catch (err) {
      ctx.logger?.warn?.(`memora-bigfive: preset 注册整体失败（已跳过）: ${err?.message ?? err}`)
    }
  })
}

export function apply(ctx, config) {
  const raw = config && typeof config.get === 'function' ? config.get() : config
  const personas = normalizePersonas(raw?.personas)
  try {
    writePersonas(raw)
  } catch (err) {
    ctx?.logger?.warn?.(`memora-bigfive: write personas failed: ${err?.message ?? err}`)
  }
  try {
    registerPresets(ctx, personas)
  } catch (err) {
    ctx?.logger?.warn?.(`memora-bigfive: register presets failed: ${err?.message ?? err}`)
  }
}
