/**
 * 大五人格档案的读取：`~/.memora/personas.json`（新）与 `bigfive.json`（旧）。
 *
 * - memora-bigfive 独立包写 personas.json（多档案，含 id/name + 五维）；
 * - memora 人格插件按自己的 personaId 找到对应档案，作为底色；
 * - 找不到时退回旧版全局 bigfive.json，再退回 preset 的 config.traits。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MEMORA_HOME = process.env.MEMORA_HOME || path.join(os.homedir(), '.memora')
export const BIGFIVE_FILE = path.join(MEMORA_HOME, 'bigfive.json')
export const PERSONAS_FILE = path.join(MEMORA_HOME, 'personas.json')

const KEYS = ['neuroticism', 'extraversion', 'openness', 'agreeableness', 'conscientiousness']

const clampTrait = (n) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50)

const toTraits = (p) => {
  const out = {}
  for (const k of KEYS) out[k] = clampTrait(Number(p?.[k]))
  return out
}

let cached = { mtime: 0, value: null }

/** 读 personas.json 的档案列表；mtime 未变走缓存。文件不存在/损坏返回 null。 */
export function readPersonas() {
  let stat
  try {
    stat = fs.statSync(PERSONAS_FILE)
  } catch {
    cached = { mtime: 0, value: null }
    return null
  }
  if (stat.mtimeMs === cached.mtime && cached.value) return cached.value
  try {
    const raw = JSON.parse(fs.readFileSync(PERSONAS_FILE, 'utf8'))
    const personas = Array.isArray(raw?.personas) ? raw.personas : []
    cached = { mtime: stat.mtimeMs, value: personas }
    return personas
  } catch {
    return null
  }
}

/** 按人格 id 取五维；没有该档案返回 null。 */
export function readPersonaTraits(personaId) {
  const personas = readPersonas()
  if (Array.isArray(personas)) {
    const found = personas.find((p) => p && String(p.id) === String(personaId))
    if (found) return toTraits(found)
  }
  return readBigFive()
}

/** 旧版全局 bigfive.json；mtime 未变走缓存。文件不存在/损坏返回 null。 */
let bigfiveCache = { mtime: 0, value: null }
export function readBigFive() {
  let stat
  try {
    stat = fs.statSync(BIGFIVE_FILE)
  } catch {
    bigfiveCache = { mtime: 0, value: null }
    return null
  }
  if (stat.mtimeMs === bigfiveCache.mtime && bigfiveCache.value) return bigfiveCache.value
  try {
    const raw = JSON.parse(fs.readFileSync(BIGFIVE_FILE, 'utf8'))
    const value = toTraits(raw)
    bigfiveCache = { mtime: stat.mtimeMs, value }
    return value
  } catch {
    return null
  }
}

/** 写旧版全局 bigfive.json（兼容用）。 */
export function writeBigFive(traits) {
  const value = toTraits(traits)
  fs.mkdirSync(MEMORA_HOME, { recursive: true })
  fs.writeFileSync(BIGFIVE_FILE, JSON.stringify(value) + '\n')
  bigfiveCache = { mtime: 0, value: null }
  return value
}
