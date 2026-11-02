/**
 * 顶层「大五人格」滑块插件。
 *
 * 为什么单独一个顶层插件：DSH 的配置表单只投影「顶层可编辑项」的 volatile 字段，
 * 嵌在 preset 里的 memora 插件不会被投影。放在 bundle patch 顶层的这一行，
 * 才会在「插件管理器」里出现 5 个 0–100 滑块。
 *
 * 滑块改动 → 配置写回 → 本插件重启 → apply() 把五维写入 ~/.memora/bigfive.json；
 * memora 插件下一轮读取并作为人格底色。
 *
 * 首次激活（配置仍是全 50 且还没有 bigfive.json）不写盘，这样两个 preset
 * 各自的默认人格不会被立刻覆盖。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { BIGFIVE_FILE, writeBigFive } from './bigfive.js'

export const name = 'memora-bigfive'

const MARKER_FILE = path.join(
  process.env.MEMORA_HOME || path.join(os.homedir(), '.memora'),
  '.bigfive-applied',
)

const KEYS = ['neuroticism', 'extraversion', 'openness', 'agreeableness', 'conscientiousness']

const slider = (label) =>
  z.number().min(0).max(100).step(1).default(50).role('slider').description(label)

export const Config = z.object({
  neuroticism: slider('神经质'),
  extraversion: slider('外倾性'),
  openness: slider('开放性'),
  agreeableness: slider('宜人性'),
  conscientiousness: slider('尽责性'),
}).volatile()

export function apply(ctx, config) {
  const raw = config && typeof config.get === 'function' ? config.get() : config
  try {
    fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true })
    fs.writeFileSync(
      MARKER_FILE,
      JSON.stringify({ at: new Date().toISOString(), values: raw ?? null }) + '\n',
    )
    const allDefault = KEYS.every((k) => (Number(raw?.[k]) || 50) === 50)
    const exists = fs.existsSync(BIGFIVE_FILE)
    if (exists || !allDefault) writeBigFive(raw)
  } catch (err) {
    ctx?.logger?.warn?.(`memora: write bigfive failed: ${err?.message ?? err}`)
  }
}
