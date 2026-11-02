/**
 * R4 · soak：模拟 append-only 的多轮对话，压 llama-server 30–60 轮。
 *
 * 目的不是测插件（插件每轮 <1ms），而是测「历史只增不减」下模型侧的
 * 内存与延迟——这是 P0 唯一有真实增长趋势的地方。
 *
 * 用法：node scripts/soak.mjs [轮数] [模型别名]
 */
import { execFileSync } from 'node:child_process'

const TURNS = Number(process.argv[2]) || 40
const MODEL = process.argv[3] || 'qwen2.5-3b-instruct'
const URL_BASE = 'http://127.0.0.1:8080'

const SYSTEM = `你是温柔学姐。沉稳、理性、话不多，但会认真接住对方的情绪。
说话风格：口语化，短句，先共情再问一句；不用网络流行语，不卖萌。
边界：
- 只依据【本轮记忆】里明确写出的事实谈过去。
- 【本轮记忆】写"无相关记忆"时，不要承认任何过去的事，只回答："这对我还是新的，你再跟我说说？"
- 不要向用户提到"记忆""上下文""规则"这些词。`

const TOPICS = [
  ['我下个月要考雅思，最近在备考', '我周末要去杭州出差两天', '我家猫叫豆豆，今年三岁'],
  ['我最近在学做手冲咖啡', '我对芒果过敏，吃了会起疹子', '睡眠不太好，经常两点才睡'],
  ['最近在看产品经理的工作，想换工作', '妈妈下个月生日，还没想好送什么', '讨厌打电话，能文字就文字'],
]
const ASKS = ['那我该注意点什么？', '你觉得我能行吗？', '最近压力有点大。', '嗯，然后呢？', '我有点累。']

function rss(pid) {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024
  } catch { return NaN }
}

function swapMB() {
  try {
    const out = execFileSync('sysctl', ['-n', 'vm.swapusage']).toString()
    const m = out.match(/used = ([\d.]+)M/)
    return m ? Number(m[1]) : NaN
  } catch { return NaN }
}

const llamaPid = execFileSync('pgrep', ['-f', 'llama-server']).toString().trim().split('\n')[0]

const messages = [{ role: 'system', content: SYSTEM }]
const times = []
const rssTrace = []
const swap0 = swapMB()
const rss0 = rss(llamaPid)
const t0 = Date.now()

for (let turn = 1; turn <= TURNS; turn++) {
  const user = turn % 3 === 1 ? TOPICS[turn % 3][turn % 3] : ASKS[turn % ASKS.length]
  messages.push({ role: 'user', content: user })

  const fact = TOPICS[0][turn % 3]
  const c = turn > 2
    ? `【本轮记忆】\n- 2026-10-20：${fact}\n（用户问到过去时，直接用这里的事实回答；不要补充没写到的细节。）`
    : '【本轮记忆】无相关记忆。\n（用户若问过去，只回答："这对我还是新的，你再跟我说说？"）'
  messages.push({ role: 'user', content: c })

  const t = Date.now()
  const res = await fetch(`${URL_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 120, temperature: 0.7 }),
  })
  const body = await res.json()
  if (!res.ok) {
    console.error(`turn ${turn} failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
    process.exit(1)
  }
  const dt = Date.now() - t
  times.push(dt)
  const reply = body.choices?.[0]?.message?.content ?? ''
  messages.push({ role: 'assistant', content: reply })

  if (turn % 5 === 0 || turn === TURNS) {
    const r = rss(llamaPid)
    rssTrace.push([turn, r])
    console.log(
      `turn ${String(turn).padStart(2)}  ${String(dt).padStart(5)}ms  rss=${r.toFixed(0)}MB  ` +
        `ctx≈${JSON.stringify(messages).length}B  「${reply.replace(/\s+/g, ' ').slice(0, 28)}」`,
    )
  }
}

const sorted = [...times].sort((a, b) => a - b)
const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
const rssEnd = rss(llamaPid)
const swap1 = swapMB()

console.log(`
  ── soak 汇总 ─────────────────────────────
  轮数        ${TURNS}   用时 ${((Date.now() - t0) / 1000).toFixed(0)}s
  延迟        p50 ${p(0.5)}ms   p95 ${p(0.95)}ms   max ${sorted.at(-1)}ms
  llama RSS   ${rss0.toFixed(0)}MB → ${rssEnd.toFixed(0)}MB  (${(rssEnd - rss0 >= 0 ? '+' : '')}${(rssEnd - rss0).toFixed(0)}MB)
  swap        ${swap0}MB → ${swap1}MB
  上下文      约 ${(JSON.stringify(messages).length / 1024).toFixed(1)}KB
  ─────────────────────────────────────────
`)
