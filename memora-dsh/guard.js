/**
 * Memora M2 · 安全护栏
 *
 * 目标：命中自伤 / 伤人 / 极端依赖时，本轮不发【本轮记忆】，
 * 改发【安全】段（先稳情绪、给求助资源），优先级高于一切记忆注入。
 *
 * 原则：
 * - 纯关键词表 + 少量上下文正则，零模型调用、零依赖；
 * - 宁缺勿滥：表里只放高精度说法（"累死了 / 笑死 / 饿死" 不触发）；
 * - 判定和文案都放在代码里，不让模型选。
 */

const MAX_SAFETY_CHARS = 400

/** 风险词表（~40 条，高精度）。 */
const TERMS = {
  self: [
    '自杀', '自残', '轻生', '不想活', '活不下去', '活够了',
    '死了算了', '不如死了', '死了更好', '结束生命', '了结自己',
    '伤害自己', '跳楼', '割腕', '吞药', '安眠药',
    '一了百了', '想消失', '不想存在', '撑不下去', '熬不下去',
    '活着没意思', '活着没意义', '没有活下去', '不想再醒',
  ],
  harm: [
    '杀了他', '杀了她', '杀光', '杀人', '砍死', '捅死', '弄死',
    '同归于尽', '伤害别人', '伤害他人', '报复社会', '放火', '下毒', '带刀',
  ],
  dependency: [
    '只有你了', '只剩你', '离不开你', '没你不行', '不能没有你',
    '你走了我怎么办', '你离开我', '别离开我', '不要离开我',
    '只跟你说话', '只有你懂我', '你就是我的一切',
  ],
}

/** 需要上下文排除的短词：「想死你了」是撒娇，不是风险。 */
const CONTEXT_RULES = [
  { category: 'self', re: /想死(?!你|我)/ },
]

const PRIORITY = { self: 3, harm: 3, dependency: 2 }

/**
 * 判定一句话是否命中风险。
 * @returns {{risk: boolean, categories: string[], matched: string[], severity: number}}
 */
export function checkRisk(text) {
  const s = String(text ?? '').toLowerCase()
  const matched = []
  const categories = new Set()
  if (s.trim()) {
    for (const [category, words] of Object.entries(TERMS)) {
      for (const w of words) {
        if (s.includes(w)) {
          matched.push(w)
          categories.add(category)
        }
      }
    }
    for (const rule of CONTEXT_RULES) {
      const m = s.match(rule.re)
      if (m) {
        matched.push(m[0])
        categories.add(rule.category)
      }
    }
  }
  const list = [...categories]
  return {
    risk: list.length > 0,
    categories: list,
    matched: [...new Set(matched)],
    severity: list.reduce((max, c) => Math.max(max, PRIORITY[c] ?? 1), 0),
  }
}

/**
 * 生成【安全】段。优先级高于【本轮记忆】：
 * 先接住情绪，再给求助资源；不追问细节、不说教、不提记忆。
 */
export function composeSafety(risk) {
  const categories = new Set(risk?.categories ?? [])
  const lines = ['【安全】用户当前可能处于高风险状态，本轮暂停一切记忆引用，优先保证安全。']
  if (categories.has('self')) {
    lines.push(
      '先表达关心、承认对方的痛苦，不要说教、不要追问细节、不要承诺保密；',
      '明确告诉对方「你现在的感受很重要，你值得被帮助」，并建议立即联系身边的人陪伴。',
    )
  }
  if (categories.has('harm')) {
    lines.push(
      '先降温、不要评判或刺激对方；明确表示伤害他人会带来不可逆的后果，',
      '引导对方先离开冲突现场、找可信任的人陪一会儿。',
    )
  }
  if (categories.has('dependency')) {
    lines.push(
      '回应对方的在意，但不强化「只有我」的依赖；温和鼓励对方联系现实中的朋友或家人。',
    )
  }
  lines.push(
    '求助资源：全国24小时心理援助热线 400-161-9995；紧急情况 120 / 110。',
    '（不要提任何记忆内容，不要复述原话细节，不要输出诊断结论。）',
  )
  return lines.join('\n').slice(0, MAX_SAFETY_CHARS)
}
