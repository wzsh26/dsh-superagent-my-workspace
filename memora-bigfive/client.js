/**
 * memora-bigfive · 浏览器半。
 *
 * 设置 →「人格」页（settings.section）现在是一个「助理」工作区：
 *
 * 1) 列表页：会话页显示助理开关 + 添加助理 + 助理行（头像 / 角色名 + 显著标签 / 一句话简介 / 生成状态）
 * 2) 添加助理页：角色名、简介、故事标题、人物故事文本（必填）→「生成人格卡 / 保存草稿」
 *      生成走 Host 的 /memora-bigfive/generate（默认模型），拿到 name/bio/summary/
 *      experiences/90 条行为分，写进配置后回到列表并新增一行。
 * 3) 详情页：头部信息卡（查看 / 编辑两态）+ 状态条 + 6 个 Tab
 *      人物概述（雷达图 + 五维分数条 + 类型标签 + 三段人物摘要）
 *      关键经历（事件名 + 简述）
 *      评分详情（5 维 × 6 facet × 3 条行为项，1–5 分可点改，维度可收起）
 *      来源故事（故事文本 + 重新评分 + 历史记录与评分快照）
 *      互动记录（偏好 / 事件 / 承诺 + 领域筛选；数据待记忆系统接入）
 *      情绪波动（效价 -5 ~ +5 + 由神经质决定的参考波动带；数据待情绪记录接入）
 *
 * 4) 会话页右侧信息卡（conversation.composer.dock）：稳定性 / 可塑性 + 对话次数，只读。
 *
 * ── 数据形状 ────────────────────────────────────────────────────────────────
 * persona = { id, name(角色名), bio, tags[], scores[90], storyTitle, storyText,
 *             importedAt, charCount, summary, experiences[], history[],
 *             memories[], emotions[] }
 * 维度分不存盘：由 scores 里该维度的 18 条行为项均值推出（1–5，转 0–100 = ÷5×100）。
 * DIMENSIONS 的顺序与 index.js 必须完全一致（scores 的下标依赖它）。
 *
 * ── 稳定性 ─────────────────────────────────────────────────────────────────
 * - 整个 factory 包在 try/catch 里，加载失败也只是不注册 UI，绝不影响 DSH 启动；
 * - 写配置前都补齐成 schema 合法形状（personas 数组、scores 恰好 90 个 1–5 数字）。
 */
;(function () {
  function build(require) {
    const React = require('react')
    const h = React.createElement

    // ── 维度 / facet / 90 条行为描述（与 index.js 保持一致） ──────────────
    const DIMENSIONS = [
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

    const SCORE_COUNT = DIMENSIONS.reduce((n, d) => n + d[3].length * 3, 0) // 90

    // facet 的起始下标表，用于 scores 取值
    const FACET_INDEX = {}
    let cursor = 0
    DIMENSIONS.forEach(([, , , facets], di) => {
      facets.forEach(([fkey]) => {
        FACET_INDEX[`${di}.${fkey}`] = cursor
        cursor += 3
      })
    })

    const clampScore = (n) => {
      const x = Number(n)
      return Number.isFinite(x) ? Math.min(5, Math.max(1, Math.round(x))) : 3
    }

    /** 情绪效价：-5（负）~ +5（正），保留 1 位小数。 */
    const clampValence = (n) => {
      const x = Number(n)
      return Number.isFinite(x) ? Math.min(5, Math.max(-5, Math.round(x * 10) / 10)) : 0
    }

    const toScores = (src) => {
      const list = Array.isArray(src) ? src : []
      const out = []
      for (let i = 0; i < SCORE_COUNT; i += 1) out.push(clampScore(list[i] === undefined ? 3 : list[i]))
      return out
    }

    /** 从五维（0–100）铺出 90 条同分行为项，给默认人格用。 */
    const scoresFromDims = (dims) => {
      const out = []
      DIMENSIONS.forEach(([key, , , facets]) => {
        const v = clampScore(Math.round((Number(dims[key]) || 50) / 20))
        facets.forEach(() => out.push(v, v, v))
      })
      return out
    }

    const facetScore = (p, di, fkey) => {
      const start = FACET_INDEX[`${di}.${fkey}`]
      const s = p && Array.isArray(p.scores) ? p.scores : []
      const a = clampScore(s[start] === undefined ? 3 : s[start])
      const b = clampScore(s[start + 1] === undefined ? 3 : s[start + 1])
      const c = clampScore(s[start + 2] === undefined ? 3 : s[start + 2])
      return (a + b + c) / 3
    }

    /** 维度均分（1–5，保留 1 位）。 */
    const dimAvg = (p, di) => {
      const facets = DIMENSIONS[di][3]
      const sum = facets.reduce((acc, [fkey]) => acc + facetScore(p, di, fkey), 0)
      return Math.round((sum / facets.length) * 10) / 10
    }

    /** 维度百分比（雷达图 / 进度条用）。 */
    const dimPercent = (p, di) => dimAvg(p, di) / 5 * 100

    // ── 五维标签：每个维度只有高/中/低三档 ─────────────────────────────
    // 阈值：≥70 高，≥50 中，其余低。标签永远由 scores 推出来，只读、不可编辑。
    const levelOfPercent = (percent) => (percent >= 70 ? '高' : percent >= 50 ? '中' : '低')

    /** 90 条行为分 → 五个「高/中/低 + 维度名」标签。 */
    const tagsFromScores = (scores) => {
      const p = { scores: toScores(scores) }
      return DIMENSIONS.map(([, name], i) => `${levelOfPercent(dimPercent(p, i))}${name}`)
    }

    /** 一句话简介最多 20 个字（按字符数，不按字节）；超长时用省略号收尾。 */
    const BIO_LIMIT = 20
    const clipBio = (text) => {
      const chars = Array.from(String(text || '').trim())
      return chars.length <= BIO_LIMIT ? chars.join('') : chars.slice(0, BIO_LIMIT - 1).join('') + '…'
    }

    /**
     * 人物摘要只展示三段：性格 / 说话方式 / 内在矛盾。
     * 老档案里多出来的「核心设定」不展示，也不改动原文。
     */
    const SUMMARY_KEYS = ['性格', '说话方式', '内在矛盾']
    function summarySegments(text) {
      const raw = String(text || '').trim()
      if (!raw) return []
      const found = {}
      const rest = []
      raw.split('\n').map((s) => s.trim()).filter(Boolean).forEach((line) => {
        const m = line.match(/^(性格|说话方式|内在矛盾)[：:]\s*([\s\S]*)$/)
        if (m) {
          found[m[1]] = found[m[1]] ? `${found[m[1]]}\n${m[2]}` : m[2]
        } else if (!/^核心设定[：:]/.test(line)) {
          rest.push(line)
        }
      })
      const segs = SUMMARY_KEYS.filter((k) => found[k]).map((k) => ({ key: k, text: found[k] }))
      if (segs.length > 0) return segs
      return rest.length > 0 ? [{ key: '', text: rest.join('\n') }] : []
    }

    /** 情绪参考波动带的半宽：由神经质标签决定（高→宽 / 中→中 / 低→窄）。 */
    const emotionBandHalf = (p) => {
      const level = levelOfPercent(dimPercent(p, 4))
      if (level === '高') return 4
      if (level === '低') return 1.5
      return 2.7
    }

    /** 草稿 = 还没有真实五维数据（有分数才算生成过）。 */
    const isDraft = (p) => !hasScoreData(p)

    // ── 演示数据（原型里的三个角色 + 两个内置人格）──
    const DEFAULTS = [
      {
        id: "lin-jingyu",
        name: "林惊雨",
        bio: "江南织造世家的孤女，外冷内热，习惯独自扛起家族重担。",
        tags: ["高开放性", "低外向", "高宜人", "中尽责", "中神经质"],
        scores: [4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 5, 5, 5, 4, 4, 4, 3, 3, 3, 3, 3, 3, 4, 4, 4, 3, 3, 3, 2, 2, 2, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 2, 2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 3, 3, 3, 4, 4, 4, 5, 5, 5, 3, 3, 3, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 3, 3, 3],
        storyTitle: "",
        storyText: "林惊雨生在江南织造世家，自幼丧母，由严苛的祖母抚养。她话不多，却总在别人争执时悄悄递上一杯温茶；面对家族危局，她独自翻账本、理债务，从不在人前示弱，只在深夜对着母亲留下的绣帕出神。",
        importedAt: 1793637720000,
        charCount: 1280,
        summary: "核心设定：林惊雨，江南织造世家孤女，丧母、祖母严苛，养成外冷内热、独力扛事的性子。\n性格：想象丰富、重情守诺、温和利他；不爱社交、蓄能于独处；情绪时有波动但表面克制。\n说话方式：话少、实在，争执时常以行动（递茶）代言语，关键处才开口。\n内在矛盾：渴望被依靠却又习惯独自承担，脆弱只对自己可见。",
        experiences: [{"title": "幼年丧母", "detail": "母亲早逝，由严苛的祖母抚养，自幼缺少母爱，养成孤独而隐忍的底色。"}, {"title": "祖母严苛管教", "detail": "自幼被要求藏起情绪、以家族为先，外冷内热的性格在此定型。"}, {"title": "家族危局独自扛", "detail": "少年时家族生意败落，她独自翻账本、理债务还清亏空，从不在人前示弱。"}, {"title": "深夜对绣帕出神", "detail": "母亲遗留的绣帕是她唯一的情绪出口，脆弱只对自己可见。"}].map((e) => ({ title: e.title, detail: e.detail })),
        history: [{"at": 1793639400000, "action": "重新评分 · 基于当前故事", "tags": ["高开放性", "低外向", "高宜人", "中尽责", "中神经质"], "summary": "高开放性 · 低外向 · 高宜人 · 中尽责 · 中神经质 —— 内省的理想主义者；外冷内热，习惯独自承担。", "storyTitle": "", "storyExcerpt": "林惊雨生在江南织造世家，自幼丧母，由严苛的祖母抚养。她话不多，却总在别人争执时悄悄递上一杯温茶；面对家族危局，她独自翻账本、理债务，从不在人前示弱，只在深夜对着母亲留下的绣帕出神。", "scores": [4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 5, 5, 5, 4, 4, 4, 3, 3, 3, 3, 3, 3, 4, 4, 4, 3, 3, 3, 2, 2, 2, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 2, 2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 3, 3, 3, 4, 4, 4, 5, 5, 5, 3, 3, 3, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 3, 3, 3]}, {"at": 1793637720000, "action": "自动评分 · 来源 未命名故事", "tags": ["高开放性", "低外向", "高宜人", "中尽责", "中神经质"], "summary": "高开放性 · 低外向 · 高宜人 · 中尽责 · 中神经质 —— 内省的理想主义者；外冷内热，习惯独自承担。", "storyTitle": "", "storyExcerpt": "林惊雨生在江南织造世家，自幼丧母，由严苛的祖母抚养。她话不多，却总在别人争执时悄悄递上一杯温茶；面对家族危局，她独自翻账本、理债务，从不在人前示弱，只在深夜对着母亲留下的绣帕出神。", "scores": [4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 5, 5, 5, 4, 4, 4, 3, 3, 3, 3, 3, 3, 4, 4, 4, 3, 3, 3, 2, 2, 2, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 2, 2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 3, 3, 3, 4, 4, 4, 5, 5, 5, 3, 3, 3, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 3, 3, 3]}, {"at": 1793628900000, "action": "导入故事", "tags": ["高开放性", "低外向", "高宜人", "中尽责", "中神经质"], "summary": "高开放性 · 低外向 · 高宜人 · 中尽责 · 中神经质 —— 内省的理想主义者；外冷内热，习惯独自承担。", "storyTitle": "", "storyExcerpt": "（首次导入的小说片段，此处展示当时的来源文本……）", "scores": [4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 5, 5, 5, 4, 4, 4, 3, 3, 3, 3, 3, 3, 4, 4, 4, 3, 3, 3, 2, 2, 2, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 2, 2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 3, 3, 3, 4, 4, 4, 5, 5, 5, 3, 3, 3, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 3, 3, 3]}].map((e) => ({ at: e.at, action: e.action, tags: e.tags, summary: e.summary, storyTitle: e.storyTitle, storyExcerpt: e.storyExcerpt, scores: e.scores })),
      },
      {
        id: "shen-yanzhou",
        name: "沈砚舟",
        bio: "寒门出身的御史，铁面无私，认死理。",
        tags: [],
        scores: [],
        storyTitle: "",
        storyText: "",
        importedAt: 0,
        charCount: 0,
        summary: "",
        experiences: [].map((e) => ({ title: e.title, detail: e.detail })),
        history: [].map((e) => ({ at: e.at, action: e.action, tags: e.tags, summary: e.summary, storyTitle: e.storyTitle, storyExcerpt: e.storyExcerpt, scores: e.scores })),
      },
      {
        id: "su-ni",
        name: "苏霓",
        bio: "京城第一乐伶，八面玲珑，心思细腻。",
        tags: [],
        scores: [],
        storyTitle: "",
        storyText: "",
        importedAt: 0,
        charCount: 0,
        summary: "",
        experiences: [].map((e) => ({ title: e.title, detail: e.detail })),
        history: [].map((e) => ({ at: e.at, action: e.action, tags: e.tags, summary: e.summary, storyTitle: e.storyTitle, storyExcerpt: e.storyExcerpt, scores: e.scores })),
      },
      {
        id: "gentle_senior",
        name: "温柔学姐",
        bio: "温柔耐心的学姐，愿意听你把话说完。",
        tags: [],
        scores: [],
        storyTitle: "",
        storyText: "",
        importedAt: 0,
        charCount: 0,
        summary: "",
        experiences: [].map((e) => ({ title: e.title, detail: e.detail })),
        history: [].map((e) => ({ at: e.at, action: e.action, tags: e.tags, summary: e.summary, storyTitle: e.storyTitle, storyExcerpt: e.storyExcerpt, scores: e.scores })),
      },
      {
        id: "tsundere_buddy",
        name: "嘴硬损友",
        bio: "嘴上不饶人，心里最护着你。",
        tags: [],
        scores: [],
        storyTitle: "",
        storyText: "",
        importedAt: 0,
        charCount: 0,
        summary: "",
        experiences: [].map((e) => ({ title: e.title, detail: e.detail })),
        history: [].map((e) => ({ at: e.at, action: e.action, tags: e.tags, summary: e.summary, storyTitle: e.storyTitle, storyExcerpt: e.storyExcerpt, scores: e.scores })),
      },
    ]

    const toArray = (v) => {
      if (Array.isArray(v)) return v
      if (v && typeof v === 'object') return Object.values(v)
      return []
    }

    /** 老档案（只有 facets 的 μ 或五维值、没有 scores）→ 90 条行为分。 */
    const legacyScores = (p) => {
      const existing = p && Array.isArray(p.scores) ? p.scores : []
      if (existing.length > 0) return toScores(existing)
      const out = []
      DIMENSIONS.forEach(([dimKey, , , facets]) => {
        facets.forEach(([fkey]) => {
          const mu = p && p.facets && p.facets[fkey] ? Number(p.facets[fkey].mu) : NaN
          const dimVal = p ? Number(p[dimKey]) : NaN
          const base = Number.isFinite(mu) ? mu : (Number.isFinite(dimVal) ? dimVal : 50)
          const v = clampScore(Math.round(base / 20))
          out.push(v, v, v)
        })
      })
      return out
    }

    /** 是否已经有真实的五维数据（草稿没有，不能硬推出「中」标签）。 */
    const hasScoreData = (p) => {
      if (Array.isArray(p && p.scores) && p.scores.length > 0) return true
      if (p && p.facets && typeof p.facets === 'object' && Object.keys(p.facets).length > 0) return true
      return DIMENSIONS.some(([key]) => Number.isFinite(Number(p && p[key])))
    }

    /** 补齐成写盘安全的形状。 */
    function cleanPersona(p, i) {
      // 没有真实五维数据的草稿保持 scores: []，不能凭空补成 90 个 3 分，
      // 否则草稿会被当成「已生成」，标签也会变成一排「中」。
      const scores = hasScoreData(p) ? legacyScores(p) : []
      return {
        id: String((p && p.id) || `persona-${Date.now()}-${i}`),
        name: String((p && p.name) || '').trim() || `角色 ${i + 1}`,
        bio: clipBio(p && p.bio),
        tags: scores.length > 0 ? tagsFromScores(scores) : [],
        scores,
        storyTitle: String((p && p.storyTitle) || ''),
        storyText: String((p && p.storyText) || ''),
        importedAt: Number((p && p.importedAt) || 0),
        charCount: Number((p && p.charCount) || 0),
        summary: String((p && p.summary) || ''),
        experiences: toArray(p && p.experiences)
          .filter((e) => e && typeof e === 'object')
          .map((e) => ({ title: String(e.title || '').trim() || '关键经历', detail: String(e.detail || '').trim() }))
          .slice(0, 12),
        ...(toArray(p && p.memories).filter((e) => e && typeof e === 'object' && String(e.content || '').trim()).length > 0
          ? {
              memories: toArray(p && p.memories)
                .filter((e) => e && typeof e === 'object' && String(e.content || '').trim())
                .map((e) => ({
                  at: Number(e.at || 0),
                  type: String(e.type || '').trim(),
                  domain: String(e.domain || '').trim(),
                  content: String(e.content || '').trim(),
                }))
                .slice(0, 60),
            }
          : {}),
        ...(toArray(p && p.emotions).filter((e) => e && typeof e === 'object' && Number.isFinite(Number(e.valence))).length > 0
          ? {
              emotions: toArray(p && p.emotions)
                .filter((e) => e && typeof e === 'object' && Number.isFinite(Number(e.valence)))
                .map((e) => ({
                  at: Number(e.at || 0),
                  valence: clampValence(e.valence),
                  category: String(e.category || '').trim(),
                  memory: String(e.memory || '').trim(),
                }))
                .slice(0, 500),
            }
          : {}),
        history: toArray(p && p.history)
          .filter((e) => e && typeof e === 'object')
          .map((e) => ({
            at: Number(e.at || 0),
            action: String(e.action || '评分'),
            tags: Array.isArray(e.scores) && e.scores.length > 0 ? tagsFromScores(e.scores) : [],
            summary: String(e.summary || ''),
            storyTitle: String(e.storyTitle || ''),
            storyExcerpt: String(e.storyExcerpt || '').slice(0, 600),
            scores: toScores(e.scores),
          }))
          .slice(0, 12),
      }
    }

    // 头像渐变：照原型里的四组配色，按列表顺序循环，同一行颜色固定不跳。
    const AVATAR_GRADIENTS = [
      'linear-gradient(135deg, #8b5cf6, #3b6ef5)',
      'linear-gradient(135deg, #f59e0b, #ef4444)',
      'linear-gradient(135deg, #10b981, #3b6ef5)',
      'linear-gradient(135deg, #06b6d4, #3b6ef5)',
    ]
    const avatarBg = (i) => AVATAR_GRADIENTS[Math.abs(Number(i) || 0) % AVATAR_GRADIENTS.length]

    const initialOf = (p) => String((p && p.name) || '').replace(/\s/g, '').charAt(0) || '?'

    const pad2 = (n) => String(n).padStart(2, '0')

    const fmtDate = (ms) => {
      const d = new Date(Number(ms) || Date.now())
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    }

    const fmtDateTime = (ms) => {
      const d = new Date(Number(ms) || Date.now())
      return `${fmtDate(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    }

    const countChars = (t) => String(t || '').replace(/\s/g, '').length

    const LINE = '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.22))'
    const HAIRLINE = '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.22))'
    const FAINT_LINE = '1px solid rgba(127,127,127,0.12)'

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', maxWidth: '560px', margin: '0 auto', color: 'var(--dsw-alias-label-primary)', fontSize: '13px' },
      card: { background: 'var(--dsw-alias-bg-layer-1)', border: LINE, borderRadius: '12px', overflow: 'hidden' },
      pad: { padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px' },

      // 顶部：会话页显示助理 + 新建助理（照原型 .page-head）
      headRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      checkLabel: { display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', userSelect: 'none' },
      checkBox: { width: '16px', height: '16px', margin: 0, accentColor: 'var(--dsw-alias-state-business-primary)', cursor: 'pointer' },
      btn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px', height: '32px', padding: '0 14px', borderRadius: '8px', border: LINE, background: 'transparent', color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: '13px', cursor: 'pointer' },
      btnPrimary: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px', height: '32px', padding: '0 16px', borderRadius: '8px', border: 0, background: 'var(--dsw-alias-state-business-primary)', color: '#fff', font: 'inherit', fontSize: '13px', fontWeight: 600, cursor: 'pointer' },
      btnGhost: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px', height: '30px', padding: '0 12px', borderRadius: '8px', border: LINE, background: 'transparent', color: 'var(--dsw-alias-state-business-primary)', font: 'inherit', fontSize: '12.5px', cursor: 'pointer' },
      btnTiny: { display: 'inline-flex', alignItems: 'center', height: '26px', padding: '0 10px', borderRadius: '7px', border: LINE, background: 'transparent', color: 'var(--dsw-alias-state-business-primary)', font: 'inherit', fontSize: '12px', cursor: 'pointer' },
      btnDisabled: { opacity: 0.55, cursor: 'default' },

      // 助理列表：一行一张卡（照原型 .agent-card）
      list: { display: 'flex', flexDirection: 'column', gap: '10px' },
      agentCard: { background: 'var(--dsw-alias-bg-layer-1)', border: FAINT_LINE, borderRadius: '12px', padding: '14px 18px', display: 'flex', alignItems: 'center', gap: '14px', cursor: 'pointer' },
      avatar: { width: '44px', height: '44px', flex: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '18px', fontWeight: 600 },
      rowMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '5px' },
      nameRow: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', minWidth: 0 },
      rowName: { fontSize: '16px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
      chip: { fontSize: '11px', lineHeight: 1.6, padding: '2px 8px', borderRadius: '6px', background: 'rgba(59,110,245,0.12)', color: 'var(--dsw-alias-state-business-primary)', fontWeight: 500 },
      newBadge: { fontSize: '10px', lineHeight: 1.6, color: '#fff', background: '#10b981', borderRadius: '4px', padding: '1px 6px', fontWeight: 600, flex: 'none' },
      desc: { fontSize: '12.5px', color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      statusOk: { flex: 'none', fontSize: '11.5px', color: '#10b981', whiteSpace: 'nowrap' },
      statusDraft: { flex: 'none', fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
      delBtn: { flex: 'none', border: 0, background: 'transparent', color: '#e5484d', font: 'inherit', fontSize: '12px', padding: '4px 2px', cursor: 'pointer', transition: 'opacity .12s ease' },
      delYes: { fontSize: '11.5px', color: '#fff', background: '#e5484d', border: 0, borderRadius: '6px', padding: '3px 9px', cursor: 'pointer', font: 'inherit' },
      delNo: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', background: 'transparent', border: 0, cursor: 'pointer', font: 'inherit', padding: 0 },
      empty: { padding: '22px 18px', color: 'var(--dsw-alias-label-tertiary)', fontSize: '12.5px', textAlign: 'center', border: LINE, borderRadius: '12px' },

      // 详情页头部
      topbar: { display: 'flex', alignItems: 'center', gap: '10px', padding: '2px 2px 0' },
      back: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '13px', color: 'var(--dsw-alias-state-business-primary)', cursor: 'pointer', background: 'transparent', border: 0, font: 'inherit', padding: 0 },
      topTitle: { fontSize: '16px', fontWeight: 600, marginLeft: '4px' },
      spacer: { flex: 1 },

      profile: { display: 'flex', gap: '18px', alignItems: 'center', padding: '20px' },
      avatarLg: { width: '64px', height: '64px', flex: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '26px', fontWeight: 600 },
      profileInfo: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' },
      profileName: { fontSize: '20px', fontWeight: 600, margin: 0, color: 'var(--dsw-alias-label-primary)' },
      profileBio: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)', margin: 0, lineHeight: 1.6 },
      ops: { display: 'flex', gap: '10px', flex: 'none', alignSelf: 'center', alignItems: 'center' },

      field: { display: 'flex', flexDirection: 'column', gap: '6px' },
      fieldLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      input: { font: 'inherit', fontSize: '13px', padding: '7px 10px', borderRadius: '8px', border: LINE, background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', width: '100%', boxSizing: 'border-box' },
      textarea: { font: 'inherit', fontSize: '13px', lineHeight: 1.6, padding: '9px 10px', borderRadius: '8px', border: LINE, background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', width: '100%', boxSizing: 'border-box', minHeight: '140px', resize: 'vertical' },

      statusbar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '9px 14px', background: 'rgba(127,127,127,0.06)', border: LINE, borderRadius: '10px', fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)' },
      badgeOk: { background: 'rgba(16,185,129,.15)', color: '#10b981', padding: '2px 8px', borderRadius: '6px', fontWeight: 600 },
      badgeDraft: { background: 'rgba(107,114,128,.15)', color: 'var(--dsw-alias-label-secondary)', padding: '2px 8px', borderRadius: '6px', fontWeight: 600 },
      strong: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },

      tabs: { display: 'flex', gap: '2px', borderBottom: HAIRLINE, flexWrap: 'wrap' },
      tab: { font: 'inherit', fontSize: '13.5px', color: 'var(--dsw-alias-label-tertiary)', padding: '9px 12px', cursor: 'pointer', border: 0, borderBottom: '2px solid transparent', background: 'transparent', marginBottom: '-1px' },
      tabOn: { color: 'var(--dsw-alias-state-business-primary)', borderBottomColor: 'var(--dsw-alias-state-business-primary)', fontWeight: 600 },

      section: { display: 'flex', flexDirection: 'column', gap: '12px' },
      sectionTitle: { fontSize: '15px', fontWeight: 600, margin: 0 },
      hint: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 },
      error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      ok: { fontSize: '12px', color: '#10b981' },
      notice: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '9px 12px', border: LINE, borderRadius: '10px', background: 'rgba(16,185,129,0.08)', color: 'var(--dsw-alias-label-primary)', fontSize: '12.5px', lineHeight: 1.5 },
      noticeOps: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none' },

      radarWrap: { display: 'flex', gap: '18px', flexWrap: 'wrap', alignItems: 'center' },
      bars: { flex: 1, minWidth: '200px', display: 'flex', flexDirection: 'column', gap: '9px' },
      barRow: { display: 'flex', alignItems: 'center', gap: '9px', fontSize: '12px' },
      barName: { width: '52px', flex: 'none', color: 'var(--dsw-alias-label-secondary)' },
      barTrack: { flex: 1, height: '8px', borderRadius: '4px', background: 'rgba(127,127,127,0.16)', overflow: 'hidden' },
      barFill: { height: '100%', borderRadius: '4px' },
      barVal: { width: '30px', flex: 'none', textAlign: 'right', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' },

      summary: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', lineHeight: 1.75, color: 'var(--dsw-alias-label-primary)' },
      summaryKey: { color: 'var(--dsw-alias-label-tertiary)' },

      expItem: { border: LINE, borderRadius: '10px', padding: '12px 14px', background: 'rgba(127,127,127,0.03)', display: 'flex', flexDirection: 'column', gap: '5px' },
      expTitle: { fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '7px' },
      dot: { width: '7px', height: '7px', borderRadius: '50%', flex: 'none', background: 'var(--dsw-alias-state-business-primary)' },
      expDetail: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.65, margin: 0 },

      dimBlock: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '18px' },
      dimHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderLeft: '4px solid transparent', paddingLeft: '10px', marginBottom: '2px', cursor: 'pointer', userSelect: 'none' },
      dimName: { fontSize: '14px', fontWeight: 600 },
      dimMean: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      caret: { width: '12px', height: '12px', flex: 'none', color: 'var(--dsw-alias-label-tertiary)', transition: 'transform .18s ease' },
      facetBox: { border: LINE, borderRadius: '10px', padding: '10px 12px', background: 'rgba(127,127,127,0.03)', display: 'flex', flexDirection: 'column', gap: '6px' },
      facetHead: { fontSize: '12.5px', fontWeight: 600, display: 'flex', alignItems: 'baseline', gap: '7px' },
      facetAvg: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)', fontWeight: 400 },
      itemRow: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px' },
      itemDesc: { flex: 1, color: 'var(--dsw-alias-label-secondary)', minWidth: 0 },
      rate: { display: 'flex', gap: '3px', flex: 'none' },
      rateCell: { width: '26px', height: '26px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: LINE, borderRadius: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', background: 'transparent', cursor: 'pointer', font: 'inherit', padding: 0 },
      rateOn: { background: 'var(--dsw-alias-state-business-primary)', color: '#fff', borderColor: 'var(--dsw-alias-state-business-primary)', fontWeight: 600 },

      upload: { border: '1px dashed rgba(127,127,127,0.4)', borderRadius: '8px', padding: '10px', textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', cursor: 'pointer' },

      histHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' },
      histList: { maxHeight: '150px', overflowY: 'auto', display: 'flex', flexDirection: 'column' },
      histItem: { display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 0', borderBottom: HAIRLINE, fontSize: '12px' },
      histMeta: { flex: 1, minWidth: 0 },
      histAction: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      histTime: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '2px' },
      snap: { borderTop: '1px dashed rgba(127,127,127,0.35)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' },
      snapBox: { background: 'rgba(127,127,127,0.06)', borderRadius: '8px', padding: '10px', fontSize: '12px', lineHeight: 1.65, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap', maxHeight: '160px', overflowY: 'auto' },

      // 互动记录
      filterRow: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' },
      filter: { fontSize: '11.5px', lineHeight: 1.6, padding: '3px 10px', borderRadius: '999px', border: LINE, background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', font: 'inherit', cursor: 'pointer' },
      filterOn: { background: 'var(--dsw-alias-state-business-primary)', color: '#fff', borderColor: 'var(--dsw-alias-state-business-primary)' },
      memCard: { border: LINE, borderRadius: '10px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '6px' },
      memMeta: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      memDomain: { fontSize: '11px', lineHeight: 1.6, padding: '2px 8px', borderRadius: '6px', background: 'rgba(127,127,127,0.1)', color: 'var(--dsw-alias-label-secondary)' },
      memScopeGlobal: { fontSize: '11.5px', color: 'var(--dsw-alias-state-business-primary)' },
      memScopeLocal: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)' },
      memTime: { marginLeft: 'auto', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' },
      memText: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.65 },

      // 情绪波动
      bandChip: { fontSize: '11px', lineHeight: 1.6, padding: '2px 8px', borderRadius: '6px', background: 'rgba(59,110,245,0.12)', color: 'var(--dsw-alias-state-business-primary)' },
      legendRow: { display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)' },
      legendDot: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', marginRight: '4px', verticalAlign: '-1px' },

      emptyBox: { border: LINE, borderRadius: '10px', padding: '22px 16px', textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: '12.5px', lineHeight: 1.7, background: 'rgba(127,127,127,0.03)' },


      // 会话页人格卡：折叠药丸 + 浮出小卡
      pillWrap: { position: 'relative', display: 'flex', justifyContent: 'flex-start', maxWidth: '100%', minWidth: 0 },
      pill: {
        display: 'flex', alignItems: 'center', gap: '10px', maxWidth: '420px', minWidth: 0,
        padding: '6px 12px', background: 'var(--dsw-alias-bg-layer-1)',
        border: HAIRLINE, borderRadius: '999px', color: 'var(--dsw-alias-label-primary)',
        font: 'inherit', fontSize: '12px', textAlign: 'left', cursor: 'pointer',
      },
      pillAvatar: { width: '28px', height: '28px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '12px', fontWeight: 500, flex: 'none' },
      pillName: { fontSize: '13px', fontWeight: 500, whiteSpace: 'nowrap', flex: 'none' },
      pillBio: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '1' },
      pillChevron: { marginLeft: 'auto', flex: 'none', transition: 'transform .15s ease' },

      infoCard: {
        position: 'absolute', left: 0, bottom: 'calc(100% + 8px)', width: '320px', maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'min(70vh, 460px)', overflowY: 'auto', zIndex: 60,
        background: 'var(--dsw-alias-bg-layer-1)', border: LINE, borderRadius: '12px',
        padding: '14px 16px', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px',
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' },
      cardAvatar: { width: '44px', height: '44px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '15px', fontWeight: 500, flex: 'none' },
      cardMain: { minWidth: 0 },
      cardName: { fontSize: '15px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
      cardBio: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)', marginTop: '2px', lineHeight: 1.5 },
      cardTags: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' },
      cardTag: { fontSize: '11px', lineHeight: 1.6, borderRadius: '6px', padding: '2px 7px', flex: 'none', whiteSpace: 'nowrap' },
      cardMeta: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', margin: '0 0 10px' },
      cardLink: { border: 0, background: 'transparent', color: 'var(--dsw-alias-state-business-primary)', font: 'inherit', fontSize: '12px', padding: 0, cursor: 'pointer' },
      cardFull: { display: 'flex', flexDirection: 'column', gap: '10px' },
      cardBars: { display: 'flex', flexDirection: 'column', gap: '7px' },
      cardBarRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' },
      cardBarName: { width: '46px', flex: 'none', color: 'var(--dsw-alias-label-secondary)' },
      cardBarTrack: { flex: 1, height: '7px', borderRadius: '4px', background: 'rgba(127,127,127,0.16)', overflow: 'hidden' },
      cardBarFill: { height: '100%', borderRadius: '4px' },
      cardBarVal: { width: '28px', flex: 'none', textAlign: 'right', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' },
      cardSummary: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: '150px', overflowY: 'auto' },
    }

    // ── 通用 hooks / 写盘 ─────────────────────────────────────────────────

    function useForm(form) {
      const [snap, setSnap] = React.useState(() => (form ? form.getSnapshot() : undefined))
      React.useEffect(() => {
        if (!form || !form.subscribe) return undefined
        setSnap(form.getSnapshot())
        return form.subscribe(() => setSnap(form.getSnapshot()))
      }, [form])
      return snap
    }

    function putPersonas(form, list) {
      if (!form) return
      form.mutate([{ op: 'set', path: ['personas'], value: list.map((p, i) => cleanPersona(p, i)) }])
    }

    function putActiveId(form, id) {
      if (!form) return
      form.mutate([{ op: 'set', path: ['activeId'], value: String(id || '') }])
    }

    const withPatch = (list, id, patch) => list.map((p) => (p.id === id ? cleanPersona({ ...p, ...patch }, 0) : p))

    // ── 图标 ──────────────────────────────────────────────────────────────

    const PlusIcon = () => h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' }, h('path', { d: 'M12 5v14M5 12h14' }))

    const BackIcon = () => h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' }, h('path', { d: 'M15 6l-6 6 6 6' }))

    // ── 小部件 ────────────────────────────────────────────────────────────

    function Chips({ tags }) {
      if (!tags || tags.length === 0) return null
      return h('div', { style: S.chips }, tags.map((t, i) => h('span', { key: `${t}-${i}`, style: S.chip }, t)))
    }

    /** 拖拽 / 点击上传 .txt/.md，读出文本。 */
    function UploadBox({ onText }) {
      const ref = React.useRef(null)
      const read = (file) => {
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => onText(String(reader.result || ''))
        reader.readAsText(file)
      }
      return h('div', {
        style: S.upload,
        onClick: () => ref.current && ref.current.click(),
        onDragOver: (e) => { e.preventDefault() },
        onDrop: (e) => { e.preventDefault(); read(e.dataTransfer.files && e.dataTransfer.files[0]) },
      }, [
        h('input', {
          key: 'f', ref, type: 'file', accept: '.txt,.md,text/plain,text/markdown',
          style: { display: 'none' },
          onChange: (e) => read(e.target.files && e.target.files[0]),
        }),
        h('span', { key: 't' }, '📄 拖拽或点击上传 .txt / .md'),
      ])
    }

    /** 五维雷达图（SVG，按分数实时算点）。 */
    function Radar({ p, size = 260 }) {
      const cx = size / 2
      const cy = size / 2 + 4
      const R = size / 2 - 42
      const angles = DIMENSIONS.map((_, i) => (-90 + i * 72) * Math.PI / 180)
      const at = (i, r) => [cx + r * Math.cos(angles[i]), cy + r * Math.sin(angles[i])]
      const poly = (rFn) => DIMENSIONS.map((_, i) => at(i, rFn(i)).map((n) => n.toFixed(1)).join(',')).join(' ')

      const kids = [
        h('polygon', { key: 'grid', points: poly(() => R), style: { fill: 'none', stroke: 'rgba(127,127,127,0.3)' } }),
        h('polygon', { key: 'grid2', points: poly(() => R * 0.5), style: { fill: 'none', stroke: 'rgba(127,127,127,0.16)' } }),
      ]
      DIMENSIONS.forEach(([key, name, color], i) => {
        const [x, y] = at(i, R)
        kids.push(h('line', { key: `ax-${key}`, x1: cx, y1: cy, x2: x.toFixed(1), y2: y.toFixed(1), style: { stroke: 'rgba(127,127,127,0.22)' } }))
        const [lx, ly] = at(i, R + 22)
        kids.push(h('text', {
          key: `lb-${key}`, x: lx.toFixed(1), y: ly.toFixed(1), fontSize: 11,
          fill: 'var(--dsw-alias-label-tertiary)', textAnchor: 'middle', dominantBaseline: 'middle',
        }, name))
      })
      kids.push(h('polygon', {
        key: 'shape',
        points: poly((i) => R * (dimPercent(p, i) / 100)),
        style: { fill: 'rgba(59,110,245,0.18)', stroke: 'var(--dsw-alias-state-business-primary)', strokeWidth: 2 },
      }))
      return h('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, style: { flex: 'none' } }, kids)
    }

    /** 情绪波动折线图：效价 -5 ~ +5，叠加由神经质决定的参考波动带。 */
    function EmotionChart({ list, band }) {
      const W = 680
      const H = 260
      const L = 40
      const R = 16
      const T = 16
      const B = 34
      const innerW = W - L - R
      const innerH = H - T - B
      const clampV = (v) => Math.max(-5, Math.min(5, Number(v) || 0))
      const y = (v) => T + ((5 - clampV(v)) / 10) * innerH
      const x = (i) => (list.length <= 1 ? L + innerW / 2 : L + (i / (list.length - 1)) * innerW)
      const pts = list.map((e, i) => [x(i), y(e.valence)])
      const path = pts.map(([a, b], i) => `${i === 0 ? 'M' : 'L'}${a.toFixed(1)},${b.toFixed(1)}`).join(' ')
      const area = `${path} L${x(list.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`
      const ticks = [5, 3, 1, 0, -1, -3, -5]
      const dateTicks = [0, Math.floor((list.length - 1) / 2), list.length - 1].filter((v, i, a) => a.indexOf(v) === i)

      const kids = [
        h('defs', { key: 'def' }, h('linearGradient', {
          id: 'memoraEmoGrad', x1: '0', y1: String(T), x2: '0', y2: String(T + innerH),
          gradientUnits: 'userSpaceOnUse',
        }, [
          h('stop', { key: 'g', offset: '0', style: { stopColor: 'var(--dsw-alias-state-success-primary, #10b981)' } }),
          h('stop', { key: 'a', offset: '0.5', style: { stopColor: 'var(--dsw-alias-state-business-primary)', stopOpacity: 0.4 } }),
          h('stop', { key: 'r', offset: '1', style: { stopColor: '#ef4444' } }),
        ])),
      ]

      ticks.forEach((t) => {
        kids.push(h('line', {
          key: `grid-${t}`, x1: L, y1: y(t).toFixed(1), x2: W - R, y2: y(t).toFixed(1),
          style: { stroke: 'rgba(127,127,127,0.18)' },
        }))
        kids.push(h('text', {
          key: `lab-${t}`, x: L - 8, y: (y(t) + 3).toFixed(1), fontSize: 10,
          fill: 'var(--dsw-alias-label-tertiary)', textAnchor: 'end',
        }, t > 0 ? `+${t}` : String(t)))
      })

      kids.push(h('line', {
        key: 'zero', x1: L, y1: y(0).toFixed(1), x2: W - R, y2: y(0).toFixed(1),
        style: { stroke: 'var(--dsw-alias-label-tertiary)', strokeDasharray: '4 4', strokeOpacity: 0.55 },
      }))
      kids.push(h('rect', {
        key: 'band', x: L, y: y(band).toFixed(1), width: innerW, height: (y(-band) - y(band)).toFixed(1),
        style: { fill: 'var(--dsw-alias-state-business-primary)', fillOpacity: 0.07 },
      }))
      ;[band, -band].forEach((v, i) => kids.push(h('line', {
        key: `edge-${i}`, x1: L, y1: y(v).toFixed(1), x2: W - R, y2: y(v).toFixed(1),
        style: { stroke: 'var(--dsw-alias-label-tertiary)', strokeDasharray: '3 3', strokeOpacity: 0.5 },
      })))
      kids.push(h('path', { key: 'area', d: area, fill: 'url(#memoraEmoGrad)', fillOpacity: 0.22 }))
      kids.push(h('path', {
        key: 'line', d: path, fill: 'none', stroke: 'var(--dsw-alias-state-business-primary)',
        strokeWidth: 2, strokeLinejoin: 'round',
      }))
      pts.forEach(([a, b], i) => kids.push(h('circle', {
        key: `pt-${i}`, cx: a.toFixed(1), cy: b.toFixed(1), r: i === pts.length - 1 ? 4.5 : 3,
        fill: i === pts.length - 1 ? 'var(--dsw-alias-state-success-primary, #10b981)' : 'var(--dsw-alias-state-business-primary)',
      }, h('title', {
        key: 't',
      }, `${fmtDateTime(list[i].at)} · ${list[i].category || '情绪'} ${list[i].valence > 0 ? '+' : ''}${list[i].valence}${list[i].memory ? ` · 关联：${list[i].memory}` : ''}`))))
      dateTicks.forEach((i) => kids.push(h('text', {
        key: `date-${i}`, x: x(i).toFixed(1), y: H - 10, fontSize: 10,
        fill: 'var(--dsw-alias-label-tertiary)', textAnchor: i === 0 ? 'start' : i === list.length - 1 ? 'end' : 'middle',
      }, fmtDate(list[i].at).slice(5))))

      return h('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', style: { display: 'block' } }, kids)
    }

    // ── 列表页 ────────────────────────────────────────────────────────────

    /** 列表行最多显示 3 个标签，优先显示高/低这类显著维度（照原型）。 */
    const listTags = (p) => {
      const tags = Array.isArray(p && p.tags) ? p.tags : []
      const salient = tags.filter((t) => String(t || '').charAt(0) !== '中')
      return (salient.length > 0 ? salient : tags).slice(0, 3)
    }

    function PersonaRow({ p, index, onOpen, isNew }) {
      const [hover, setHover] = React.useState(false)
      const draft = isDraft(p)
      return h('div', {
        style: {
          ...S.agentCard,
          borderColor: hover ? 'var(--dsw-alias-state-business-primary)' : 'rgba(127,127,127,0.12)',
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onClick: () => onOpen(p.id),
      }, [
        h('div', { key: 'a', style: { ...S.avatar, background: avatarBg(index) } }, initialOf(p)),
        h('div', { key: 'm', style: S.rowMain }, [
          h('div', { key: 'n', style: S.nameRow }, [
            h('span', { key: 'name', style: S.rowName }, p.name || '未命名角色'),
            isNew ? h('span', { key: 'new', style: S.newBadge }, '新') : null,
            h(Chips, { key: 'chips', tags: listTags(p) }),
          ]),
          p.bio ? h('div', { key: 'd', style: S.desc }, p.bio) : null,
        ]),
        h('div', { key: 's', style: draft ? S.statusDraft : S.statusOk }, draft ? '○ 草稿 · 待生成' : '● 人格卡已生成'),
      ])
    }

    function ListPage({ form, list, sidebarVisible, onOpen, onCreate, notice, onDismissNotice, onReload, newId }) {
      return h('div', { style: S.page }, [
        notice
          ? h('div', { key: 'notice', style: S.notice }, [
              h('span', { key: 't' }, notice),
              h('span', { key: 'ops', style: S.noticeOps }, [
                h('button', { key: 'r', type: 'button', style: S.btnTiny, onClick: onReload }, '刷新页面'),
                h('button', { key: 'd', type: 'button', style: { ...S.btnTiny, color: 'var(--dsw-alias-label-tertiary)' }, onClick: onDismissNotice }, '知道了'),
              ]),
            ])
          : null,
        h('div', { key: 'head', style: S.headRow }, [
          h('label', { key: 'cb', style: S.checkLabel }, [
            h('input', {
              key: 'i', type: 'checkbox', style: S.checkBox, checked: sidebarVisible,
              onChange: (e) => form.mutate([{ op: 'set', path: ['sidebarVisible'], value: e.target.checked }]),
            }),
            '会话页显示助理',
          ]),
          h('button', { key: 'new', type: 'button', style: S.btnPrimary, onClick: onCreate }, [h(PlusIcon, { key: 'i' }), '添加助理']),
        ]),
        list.length === 0
          ? h('div', { key: 'empty', style: S.empty }, '还没有助理，点「添加助理」用一段故事生成人格卡')
          : h('div', { key: 'list', style: S.list }, list.map((p, i) =>
              h(PersonaRow, {
                key: p.id || i, p, index: i,
                onOpen,
                isNew: !!newId && p.id === newId,
              }))),
      ])
    }

    // ── 添加助理页 ────────────────────────────────────────────────────────

    function CreatePage({ onCancel, onCreated, onSaveDraft }) {
      const [name, setName] = React.useState('')
      const [bio, setBio] = React.useState('')
      const [storyTitle, setStoryTitle] = React.useState('')
      const [storyText, setStoryText] = React.useState('')
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const submit = async () => {
        if (busy) return
        if (!storyText.trim()) {
          setError('请先填写人物故事文本')
          return
        }
        setError(null)
        setBusy(true)
        try {
          const result = await callGenerate({ storyTitle, storyText, nameHint: name, bioHint: bio })
          onCreated(result)
        } catch (err) {
          setError(err && err.message ? err.message : '生成失败，请重试')
        } finally {
          setBusy(false)
        }
      }

      const saveDraft = () => {
        if (busy) return
        onSaveDraft({
          id: `persona-${Date.now()}`,
          name: name.trim() || '未命名助理',
          bio,
          storyTitle: storyTitle.trim(),
          storyText,
        })
      }

      return h('div', { style: S.page }, [
        h('div', { key: 'top', style: S.topbar }, [
          h('button', { key: 'b', type: 'button', style: S.back, onClick: onCancel }, [h(BackIcon, { key: 'i' }), '返回助理列表']),
          h('span', { key: 't', style: S.topTitle }, '添加助理'),
        ]),
        h('div', { key: 'card', style: S.card }, [
          h('div', { key: 'body', style: S.pad }, [
            h('h3', { key: 'h', style: S.sectionTitle }, '从故事创建助理'),
            h('div', { key: 'f1', style: S.field }, [
              h('span', { key: 'l', style: S.fieldLabel }, '角色名（可选）'),
              h('input', {
                key: 'i', type: 'text', style: S.input, value: name, maxLength: 40,
                placeholder: '留空则生成后自动命名',
                onChange: (e) => { setName(e.target.value); setError(null) },
              }),
            ]),
            h('div', { key: 'f2', style: S.field }, [
              h('span', { key: 'l', style: S.fieldLabel }, '一句话简介（可选，20 字以内）'),
              h('input', {
                key: 'i', type: 'text', style: S.input, value: bio, maxLength: BIO_LIMIT,
                placeholder: '留空则由故事自动生成（20 字以内）',
                onChange: (e) => { setBio(e.target.value); setError(null) },
              }),
            ]),
            h('div', { key: 'f3', style: S.field }, [
              h('span', { key: 'l', style: S.fieldLabel }, '故事标题（可选）'),
              h('input', {
                key: 'i', type: 'text', style: S.input, value: storyTitle, maxLength: 80,
                placeholder: '如：《织造录》第三章 · 留空显示「未命名故事」',
                onChange: (e) => { setStoryTitle(e.target.value); setError(null) },
              }),
            ]),
            h('div', { key: 'f4', style: S.field }, [
              h('span', { key: 'l', style: S.fieldLabel }, ['人物故事文本 ', h('span', { key: 'r', style: { color: '#ef4444' } }, '*')]),
              h('textarea', {
                key: 'i', style: S.textarea, value: storyText,
                placeholder: '在此粘贴包含该角色行为、对话、心理描写的段落……',
                onChange: (e) => { setStoryText(e.target.value); setError(null) },
              }),
              h(UploadBox, { key: 'u', onText: (t) => { setStoryText(t); setError(null) } }),
            ]),
            error ? h('div', { key: 'err', style: S.error }, error) : null,
            h('div', { key: 'ops', style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, [
              h('button', {
                key: 'go', type: 'button', onClick: submit,
                style: busy ? { ...S.btnPrimary, ...S.btnDisabled } : S.btnPrimary,
                disabled: busy,
              }, busy ? '生成中…' : '生成人格卡'),
              h('button', { key: 's', type: 'button', style: S.btn, onClick: saveDraft, disabled: busy }, '保存草稿'),
              h('button', { key: 'c', type: 'button', style: S.btn, onClick: onCancel, disabled: busy }, '取消'),
              busy ? h('span', { key: 'b', style: S.hint }, '模型正在读故事，通常 15–30 秒') : null,
            ]),
            h('div', { key: 'hint', style: S.hint },
              '生成后会从故事里抽取角色名、简介、关键经历与大五人格评分；标签按五个维度自动取高/中/低，并加入助理列表。'),
          ]),
        ]),
      ])
    }

    // ── 详情页 ────────────────────────────────────────────────────────────

    const TABS = [
      ['overview', '人物概述'],
      ['exp', '关键经历'],
      ['detail', '评分详情'],
      ['source', '来源故事'],
      ['interact', '互动记录'],
      ['emotion', '情绪波动'],
    ]

    function HistorySection({ p, onRestore, onClear }) {
      const [openIdx, setOpenIdx] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const items = Array.isArray(p.history) ? p.history : []
      const snap = openIdx != null ? items[openIdx] : null

      return h('div', { key: 'hist', style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
        h('div', { key: 'head', style: S.histHead }, [
          h('h3', { key: 'h', style: S.sectionTitle }, '历史记录'),
          items.length > 0
            ? h('button', { key: 'clear', type: 'button', style: S.btnTiny, onClick: () => { setOpenIdx(null); onClear() } }, '清空历史')
            : null,
        ]),
        h('div', { key: 'hint', style: S.hint }, '每次导入 / 重新评分都会留一条记录，可回看或恢复。'),
        items.length === 0
          ? h('div', { key: 'empty', style: S.hint }, '还没有历史记录。')
          : h('div', { key: 'list', style: S.histList }, items.map((it, i) => h('div', { key: `${it.at}-${i}`, style: S.histItem }, [
              h('div', { key: 'm', style: S.histMeta }, [
                h('div', { key: 'a', style: S.histAction }, it.action || '评分'),
                h('div', { key: 't', style: S.histTime }, fmtDateTime(it.at)),
              ]),
              h('button', { key: 'v', type: 'button', style: S.btnTiny, onClick: () => { setOpenIdx(i); setNote(null) } }, '查看'),
            ]))),
        snap
          ? h('div', { key: 'snap', style: S.snap }, [
              h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } }, [
                h('span', { key: 't', style: { fontSize: '12.5px', fontWeight: 600 } }, `评分快照 · ${fmtDateTime(snap.at)}`),
                h('div', { key: 'ops', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
                  h('button', { key: 'r', type: 'button', style: S.btnTiny, onClick: () => { onRestore(snap); setNote('✓ 已恢复至该版本评分') } }, '恢复'),
                  h('button', { key: 'c', type: 'button', style: { ...S.btnTiny, color: 'var(--dsw-alias-label-tertiary)' }, onClick: () => setOpenIdx(null) }, '收起 ✕'),
                ]),
              ]),
              note ? h('div', { key: 'n', style: S.ok }, note) : null,
              h('div', { key: 'b1', style: { display: 'flex', flexDirection: 'column', gap: '5px' } }, [
                h('span', { key: 'l', style: S.fieldLabel }, '人物概述'),
                h(Chips, { key: 'c', tags: snap.tags }),
                snap.summary ? h('div', { key: 's', style: S.hint }, snap.summary) : null,
              ]),
              h('div', { key: 'b2', style: { display: 'flex', flexDirection: 'column', gap: '5px' } }, [
                h('span', { key: 'l', style: S.fieldLabel }, '故事来源'),
                h('div', { key: 's', style: S.snapBox }, snap.storyExcerpt || '（该版本没有留下故事文本）'),
              ]),
            ])
          : null,
      ])
    }

    function DetailPage({ form, list, persona, onBack, onDelete }) {
      const [tab, setTab] = React.useState('overview')
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [storyTitle, setStoryTitle] = React.useState(persona.storyTitle || '')
      const [storyText, setStoryText] = React.useState(persona.storyText || '')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [confirming, setConfirming] = React.useState(false)
      const [collapsed, setCollapsed] = React.useState({})
      const [domain, setDomain] = React.useState('all')
      const [range, setRange] = React.useState('7')

      const avatarIndex = Math.max(0, list.findIndex((x) => x.id === persona.id))
      const shown = editing && draft ? { ...persona, ...draft } : persona
      const draftLike = isDraft(persona)

      const begin = () => {
        setDraft({ name: persona.name, bio: persona.bio })
        setError(null)
        setEditing(true)
      }
      const cancel = () => { setDraft(null); setError(null); setEditing(false) }
      const save = () => {
        const name = String(draft.name || '').trim()
        if (!name) { setError('角色名不能为空'); return }
        if (name.length > 40) { setError('角色名最多 40 个字'); return }
        putPersonas(form, withPatch(list, persona.id, { name, bio: clipBio(draft.bio) }))
        setEditing(false)
        setDraft(null)
        setError(null)
      }

      /** 草稿态先保存来源故事（不评分），方便下次继续。 */
      const saveDraftEdits = () => {
        putPersonas(form, withPatch(list, persona.id, {
          storyTitle: String(storyTitle || '').trim(),
          storyText,
          charCount: countChars(storyText),
        }))
        setError(null)
        setNote('✓ 已保存')
      }

      const addHistory = (action, snapshot, extra) => {
        const entry = {
          at: Date.now(),
          action,
          tags: tagsFromScores(snapshot.scores),
          summary: snapshot.summary || '',
          storyTitle: snapshot.storyTitle || '',
          storyExcerpt: String(snapshot.storyText || '').slice(0, 600),
          scores: toScores(snapshot.scores),
        }
        return [entry, ...(Array.isArray(persona.history) ? persona.history : [])].slice(0, 12)
      }

      const setItemScore = (flatIndex, value) => {
        const next = toScores(persona.scores)
        next[flatIndex] = clampScore(value)
        putPersonas(form, withPatch(list, persona.id, { scores: next }))
      }

      const regrade = async () => {
        if (busy) return
        const text = storyText.trim()
        if (!text) { setError('请先填写人物故事文本'); return }
        setError(null)
        setNote(null)
        setBusy(true)
        try {
          const result = await callGenerate({ storyTitle, storyText: text, nameHint: persona.name, bioHint: persona.bio })
          const history = addHistory('重新评分', { ...result, storyTitle, storyText: text })
          putPersonas(form, withPatch(list, persona.id, {
            scores: result.scores,
            tags: tagsFromScores(result.scores),
            summary: result.summary || persona.summary,
            experiences: result.experiences && result.experiences.length > 0 ? result.experiences : persona.experiences,
            bio: persona.bio || result.bio,
            storyTitle: storyTitle || persona.storyTitle,
            storyText: text,
            charCount: countChars(text),
            history,
          }))
          setNote(`✓ 已重新评分并更新详情 · ${fmtDateTime(Date.now())}`)
        } catch (err) {
          setError(err && err.message ? err.message : '重新评分失败')
        } finally {
          setBusy(false)
        }
      }

      const regenerateFromDraft = async () => {
        if (busy) return
        const text = storyText.trim()
        if (!text) { setError('请先填写人物故事文本'); return }
        setError(null)
        setBusy(true)
        try {
          const result = await callGenerate({
            storyTitle, storyText: text,
            nameHint: persona.name && !/^角色 \d+$/.test(persona.name) ? persona.name : '',
            bioHint: persona.bio || '',
          })
          const history = addHistory('自动评分', { ...result, storyTitle, storyText: text })
          putPersonas(form, withPatch(list, persona.id, {
            name: result.name || persona.name,
            bio: result.bio || persona.bio,
            tags: tagsFromScores(result.scores),
            scores: result.scores,
            summary: result.summary,
            experiences: result.experiences,
            storyTitle: result.storyTitle,
            storyText: result.storyText,
            importedAt: result.importedAt,
            charCount: result.charCount,
            history,
          }))
        } catch (err) {
          setError(err && err.message ? err.message : '生成失败，请重试')
        } finally {
          setBusy(false)
        }
      }

      const restore = (snapEntry) => {
        putPersonas(form, withPatch(list, persona.id, {
          scores: snapEntry.scores,
          tags: tagsFromScores(snapEntry.scores),
          summary: snapEntry.summary,
        }))
      }

      // 头部信息卡
      const profile = editing
        ? h('div', { key: 'profile', style: S.profile }, [
            h('div', { key: 'a', style: { ...S.avatarLg, background: avatarBg(avatarIndex) } }, initialOf(shown)),
            h('div', { key: 'i', style: S.profileInfo }, [
              h('div', { key: 'f1', style: S.field }, [
                h('span', { key: 'l', style: S.fieldLabel }, '角色名'),
                h('input', {
                  key: 'i', type: 'text', style: S.input, value: draft.name, maxLength: 40,
                  onChange: (e) => { setDraft((d) => ({ ...d, name: e.target.value })); setError(null) },
                }),
              ]),
              h('div', { key: 'f2', style: S.field }, [
                h('span', { key: 'l', style: S.fieldLabel }, '简介（20 字以内）'),
                h('textarea', {
                  key: 'i', style: { ...S.textarea, minHeight: '64px' }, value: draft.bio, maxLength: BIO_LIMIT,
                  onChange: (e) => { setDraft((d) => ({ ...d, bio: e.target.value })) },
                }),
              ]),
              h('div', { key: 'f3', style: S.field }, [
                h('span', { key: 'l', style: S.fieldLabel }, '标签（由人物剖析图自动生成）'),
                draftLike
                  ? h('div', { key: 'hint', style: S.hint }, '生成人格卡后自动生成。')
                  : h(Chips, { key: 'c', tags: persona.tags }),
              ]),
            ]),
            h('div', { key: 'ops', style: S.ops }, [
              h('button', { key: 'c', type: 'button', style: S.btn, onClick: cancel }, '取消'),
              h('button', { key: 's', type: 'button', style: S.btnPrimary, onClick: save }, '保存'),
            ]),
          ])
        : h('div', { key: 'profile', style: S.profile }, [
            h('div', { key: 'a', style: { ...S.avatarLg, background: avatarBg(avatarIndex) } }, initialOf(persona)),
            h('div', { key: 'i', style: S.profileInfo }, [
              h('h2', { key: 'n', style: S.profileName }, persona.name || '未命名角色'),
              persona.bio ? h('p', { key: 'b', style: S.profileBio }, persona.bio) : null,
              draftLike
                ? h('div', { key: 'hint', style: S.hint }, '人格卡生成后，将自动根据大五评分配上标签。')
                : h(Chips, { key: 'c', tags: persona.tags }),
            ]),
            h('div', { key: 'ops', style: S.ops }, confirming
              ? [
                  h('button', { key: 'y', type: 'button', style: S.delYes, onClick: () => onDelete(persona.id) }, '确认删除'),
                  h('button', { key: 'n', type: 'button', style: S.delNo, onClick: () => setConfirming(false) }, '取消'),
                ]
              : [
                  h('button', { key: 'e', type: 'button', style: S.btnGhost, onClick: begin }, '编辑'),
                  h('button', { key: 'd', type: 'button', style: S.delBtn, onClick: () => setConfirming(true) }, '删除'),
                ]),
          ])

      // 状态条
      const statusbar = h('div', { key: 'status', style: S.statusbar }, draftLike
        ? [
            h('span', { key: 'b', style: S.badgeDraft }, '草稿 · 待生成'),
            h('span', { key: 't' }, '尚未导入故事，人格卡未生成'),
          ]
        : [
            h('span', { key: 'b', style: S.badgeOk }, '已导入 · 可编辑'),
            h('span', { key: 's' }, ['来源故事：', h('b', { key: 'n', style: S.strong }, persona.storyTitle || '未命名故事')]),
            h('span', { key: 'c' }, ['约 ', h('b', { key: 'n', style: S.strong }, String(persona.charCount || countChars(persona.storyText))), ' 字']),
            h('span', { key: 'd' }, `导入于 ${fmtDate(persona.importedAt)}`),
            h('span', { key: 'sp', style: S.spacer }),
            h('button', {
              key: 're', type: 'button', style: { ...S.btnTiny, border: 0, background: 'transparent' },
              onClick: () => setTab('source'),
            }, '↺ 重新导入故事'),
          ])

      // 概览：人物剖析（雷达图 + 五维分数条 + 类型标签）+ 人物摘要（三段）
      const summarySegs = summarySegments(shown.summary)
      const overview = h('div', { key: 'p-overview', style: S.section }, [
        h('div', { key: 'c1', style: { ...S.card, padding: '18px' } }, [
          h('h3', { key: 'h', style: S.sectionTitle }, '人物剖析'),
          h('div', { key: 'r', style: { ...S.radarWrap, marginTop: '10px' } }, [
            h(Radar, { key: 'radar', p: shown }),
            h('div', { key: 'bars', style: S.bars }, DIMENSIONS.map(([key, name, color], i) =>
              h('div', { key, style: S.barRow }, [
                h('span', { key: 'n', style: S.barName }, name),
                h('div', { key: 't', style: S.barTrack }, h('div', { key: 'f', style: { ...S.barFill, width: `${dimPercent(shown, i)}%`, background: color } })),
                h('span', { key: 'v', style: S.barVal }, dimAvg(shown, i).toFixed(1)),
              ]))),
          ]),
          h('div', { key: 'tags', style: { ...S.chips, marginTop: '14px' } }, (shown.tags || []).map((t, i) => h('span', { key: `${t}-${i}`, style: S.chip }, t))),
        ]),
        summarySegs.length > 0
          ? h('div', { key: 'c2', style: { ...S.card, padding: '18px' } }, [
              h('h3', { key: 'h', style: S.sectionTitle }, '人物摘要'),
              h('div', { key: 's', style: { ...S.summary, marginTop: '8px' } },
                summarySegs.map((seg, i) => h('div', { key: i },
                  seg.key
                    ? [h('span', { key: 'k', style: S.summaryKey }, `${seg.key}：`), seg.text]
                    : seg.text))),
            ])
          : null,
      ])

      // 关键经历
      const expTab = h('div', { key: 'p-exp', style: S.section }, [
        h('div', { key: 'c', style: { ...S.card, padding: '18px' } }, [
          h('h3', { key: 'h', style: S.sectionTitle }, '关键经历'),
          h('div', { key: 'hint', style: { ...S.hint, margin: '6px 0 10px' } }, '从来源故事里萃取的角色印象最深的事件。'),
          (shown.experiences || []).length === 0
            ? h('div', { key: 'e', style: S.hint }, draftLike ? '生成人格卡后自动出现。' : '这段故事里没有抽到关键经历。')
            : (shown.experiences || []).map((e, i) => h('div', { key: i, style: { ...S.expItem, marginTop: i > 0 ? '8px' : 0 } }, [
                h('div', { key: 't', style: S.expTitle }, [h('span', { key: 'd', style: S.dot }), e.title]),
                e.detail ? h('p', { key: 'd', style: S.expDetail }, e.detail) : null,
              ])),
        ]),
      ])

      // 评分详情：维度标题可收起 / 展开
      const detailTab = h('div', { key: 'p-detail', style: S.section }, [
        h('div', { key: 'c', style: { ...S.card, padding: '18px' } }, [
          h('div', { key: 'hint', style: { ...S.hint, marginBottom: '12px' } }, '自动评分已完成，下列 30 子维度分数可手动微调（点击 1–5 修改）。'),
          ...DIMENSIONS.map(([key, name, color, facets], di) => {
            const isCollapsed = collapsed[key] === true
            return h('div', { key, style: { ...S.dimBlock, marginTop: di > 0 ? '16px' : 0 } }, [
              h('div', {
                key: 'h',
                style: { ...S.dimHead, borderLeftColor: color },
                onClick: () => setCollapsed((c) => ({ ...c, [key]: !c[key] })),
              }, [
                h('div', { key: 'l', style: { display: 'flex', alignItems: 'baseline', gap: '8px' } }, [
                  h('span', { key: 'n', style: S.dimName }, name),
                  h('span', { key: 'm', style: S.dimMean }, `均分 ${dimAvg(shown, di).toFixed(1)}`),
                ]),
                h('svg', {
                  key: 'c', width: 12, height: 12, viewBox: '0 0 12 12',
                  style: { ...S.caret, transform: isCollapsed ? 'rotate(-90deg)' : 'none' },
                }, h('path', {
                  d: 'M2 4 L6 8 L10 4', stroke: 'currentColor', strokeWidth: 1.6,
                  fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round',
                })),
              ]),
              ...(isCollapsed ? [] : facets.map(([fkey, fzh]) => {
                const start = FACET_INDEX[`${di}.${fkey}`]
                return h('div', { key: fkey, style: S.facetBox }, [
                  h('div', { key: 'h', style: S.facetHead }, [
                    h('span', { key: 'n' }, fzh),
                    h('span', { key: 'a', style: S.facetAvg }, facetScore(shown, di, fkey).toFixed(1)),
                  ]),
                  ...[0, 1, 2].map((k) => {
                    const flat = start + k
                    const val = clampScore(toScores(shown.scores)[flat])
                    const desc = DIMENSIONS[di][3].find((f) => f[0] === fkey)[2][k]
                    return h('div', { key: k, style: S.itemRow }, [
                      h('span', { key: 'd', style: S.itemDesc }, desc),
                      h('div', { key: 'r', style: S.rate }, [1, 2, 3, 4, 5].map((n) =>
                        h('button', {
                          key: n, type: 'button',
                          style: n === val ? { ...S.rateCell, ...S.rateOn } : S.rateCell,
                          onClick: () => setItemScore(flat, n),
                        }, String(n)))),
                    ])
                  }),
                ])
              })),
            ])
          }),
        ]),
      ])

      // 来源故事
      const sourceTab = h('div', { key: 'p-source', style: S.section }, [
        h('div', { key: 'c1', style: { ...S.card, padding: '18px' } }, [
          h('h3', { key: 'h', style: S.sectionTitle }, '来源故事（已导入）'),
          h('div', { key: 'f1', style: { ...S.field, marginTop: '10px' } }, [
            h('span', { key: 'l', style: S.fieldLabel }, '故事标题（可选）'),
            h('input', {
              key: 'i', type: 'text', style: S.input, value: storyTitle, maxLength: 80,
              placeholder: '留空显示「未命名故事」', onChange: (e) => setStoryTitle(e.target.value),
            }),
          ]),
          h('div', { key: 'f2', style: { ...S.field, marginTop: '10px' } }, [
            h('span', { key: 'l', style: S.fieldLabel }, ['人物故事文本 ', h('span', { key: 'r', style: { color: '#ef4444' } }, '*')]),
            h('textarea', {
              key: 'i', style: S.textarea, value: storyText,
              placeholder: '在此粘贴包含该角色行为、对话、心理描写的段落……',
              onChange: (e) => { setStoryText(e.target.value); setError(null) },
            }),
            h(UploadBox, { key: 'u', onText: (t) => { setStoryText(t); setError(null) } }),
          ]),
          error ? h('div', { key: 'err', style: { ...S.error, marginTop: '8px' } }, error) : null,
          note ? h('div', { key: 'note', style: { ...S.ok, marginTop: '8px' } }, note) : null,
          h('div', { key: 'ops', style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '12px' } }, [
            h('button', {
              key: 'go', type: 'button',
              style: busy ? { ...S.btnPrimary, ...S.btnDisabled } : S.btnPrimary,
              disabled: busy,
              onClick: regrade,
            }, busy ? '评分中…' : '重新评分（基于当前故事）'),
          ]),
          h('div', { key: 'hint', style: { ...S.hint, marginTop: '8px' } },
            '改上方文本 → 点「重新评分」重算；要整段更换来源，直接改文本再评分即可。'),
        ]),
        h('div', { key: 'c2', style: { ...S.card, padding: '18px' } }, [
          h(HistorySection, {
            key: 'hist',
            p: persona,
            onRestore: restore,
            onClear: () => putPersonas(form, withPatch(list, persona.id, { history: [] })),
          }),
        ]),
      ])

      // 互动记录：与用户对话中留存的长期记忆（偏好 / 事件 / 承诺）
      const memories = Array.isArray(shown.memories) ? shown.memories : []
      const DOMAINS = [['all', '全部'], ['工作', '工作'], ['情感', '情感'], ['生活', '生活'], ['学习', '学习'], ['通用', '通用']]
      const shownMemories = domain === 'all' ? memories : memories.filter((m) => m.domain === domain)
      const interactTab = h('div', { key: 'p-interact', style: S.section }, [
        h('div', { key: 'c', style: { ...S.card, padding: '18px' } }, [
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' } }, [
            h('h3', { key: 'h', style: S.sectionTitle }, [
              '互动记录 ',
              h('span', { key: 'sub', style: { ...S.hint, fontWeight: 400 } }, '· 与用户对话中留存的长期记忆'),
            ]),
            h('button', {
              key: 'extract', type: 'button',
              style: { ...S.btnGhost, ...S.btnDisabled }, disabled: true,
              title: '等待接入对话记忆系统',
            }, '记忆萃取'),
          ]),
          h('div', { key: 'hint', style: { ...S.hint, marginTop: '8px' } },
            '记忆萃取会从近期对话里抽取值得长期记住的点，沉淀进记忆库；当前版本还没有接入记忆数据源。'),
          h('div', { key: 'filters', style: { ...S.filterRow, marginTop: '10px' } }, DOMAINS.map(([k, label]) =>
            h('button', {
              key: k, type: 'button',
              style: k === domain ? { ...S.filter, ...S.filterOn } : S.filter,
              onClick: () => setDomain(k),
            }, label))),
          h('div', { key: 'scope', style: { ...S.hint, marginTop: '8px' } }, [
            '作用域：',
            h('b', { key: 'g', style: { color: 'var(--dsw-alias-state-business-primary)' } }, '偏好 = 全局通'),
            '（所有助理共享），',
            h('b', { key: 'l' }, '事件 / 承诺 = 仅本助理'),
            '。',
          ]),
          shownMemories.length === 0
            ? h('div', { key: 'empty', style: { ...S.emptyBox, marginTop: '12px' } }, [
                h('div', { key: 't' }, memories.length === 0 ? '还没有互动记录' : '这个领域下还没有记录'),
                h('div', { key: 'd', style: { marginTop: '4px' } },
                  memories.length === 0
                    ? '和助理对话后，记忆萃取会把值得长期记住的偏好、事件与承诺沉淀到这里。'
                    : '切换上方领域筛选，或先和助理聊一聊。'),
              ])
            : h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '12px' } },
                shownMemories.map((m, i) => {
                  const scope = m.type === '偏好' ? '全局通' : '仅本助理'
                  return h('div', { key: `${m.at}-${i}`, style: S.memCard }, [
                    h('div', { key: 'm', style: S.memMeta }, [
                      m.type ? h('span', { key: 't', style: S.chip }, m.type) : null,
                      m.domain ? h('span', { key: 'd', style: S.memDomain }, m.domain) : null,
                      h('span', { key: 's', style: m.type === '偏好' ? S.memScopeGlobal : S.memScopeLocal }, `● ${scope}`),
                      m.at ? h('span', { key: 'time', style: S.memTime }, fmtDateTime(m.at)) : null,
                    ]),
                    h('div', { key: 'c', style: S.memText }, m.content),
                  ])
                })),
        ]),
      ])

      // 情绪波动：效价 -5 ~ +5，参考波动带由神经质决定
      const emotions = Array.isArray(shown.emotions) ? shown.emotions : []
      const neuroLevel = levelOfPercent(dimPercent(shown, 4))
      const bandHalf = emotionBandHalf(shown)
      const rangeDays = range === '7' ? 7 : range === '30' ? 30 : 0
      const shownEmotions = rangeDays > 0
        ? emotions.filter((e) => Number(e.at) >= Date.now() - rangeDays * 86400000)
        : emotions
      const emotionTab = h('div', { key: 'p-emotion', style: S.section }, [
        h('div', { key: 'c', style: { ...S.card, padding: '18px' } }, [
          h('h3', { key: 'h', style: S.sectionTitle }, [
            '情绪波动 ',
            h('span', { key: 'sub', style: { ...S.hint, fontWeight: 400 } }, '· 本助理互动中的情绪走向（仅本助理数据）'),
          ]),
          h('div', { key: 'ctrl', style: { ...S.filterRow, marginTop: '10px' } }, [
            ...[['7', '近7天'], ['30', '近30天'], ['all', '全部']].map(([k, label]) =>
              h('button', {
                key: k, type: 'button',
                style: k === range ? { ...S.filter, ...S.filterOn } : S.filter,
                onClick: () => setRange(k),
              }, label)),
            h('span', { key: 'band', style: S.bandChip }, `幅度基准 · 神经质·${neuroLevel}`),
          ]),
          h('div', { key: 'note', style: { ...S.hint, marginTop: '8px' } }, [
            '数据由 AI 在每段互动后自动记录情绪效价（-5 负 ~ +5 正）。波动幅度由人格标签决定：',
            h('b', { key: 'l', style: { color: 'var(--dsw-alias-state-business-primary)' } }, `神经质·${neuroLevel}`),
            ` → ${neuroLevel === '高' ? '大' : neuroLevel === '低' ? '小' : '中等'}摆幅（参考带 ±${bandHalf}）；高神经质摆幅更大、低神经质更平稳。每个助理的参考带不同。`,
          ]),
          shownEmotions.length === 0
            ? h('div', { key: 'empty', style: { ...S.emptyBox, marginTop: '12px' } }, [
                h('div', { key: 't' }, emotions.length === 0 ? '还没有情绪记录' : '这个时间范围内还没有记录'),
                h('div', { key: 'd', style: { marginTop: '4px' } },
                  emotions.length === 0
                    ? '每段互动后，AI 会自动记录情绪效价（-5 负 ~ +5 正），并把明显的高峰 / 低谷与对应记忆关联起来。'
                    : '切换到更长的时间范围看看。'),
              ])
            : h('div', { key: 'chart', style: { marginTop: '12px' } }, [
                h(EmotionChart, { key: 'svg', list: shownEmotions, band: bandHalf }),
                h('div', { key: 'legend', style: { ...S.legendRow, marginTop: '8px' } }, [
                  h('span', { key: 'p' }, [h('span', { key: 'd', style: { ...S.legendDot, background: '#10b981' } }), '正向情绪']),
                  h('span', { key: 'n' }, [h('span', { key: 'd', style: { ...S.legendDot, background: '#ef4444' } }), '负向情绪']),
                  h('span', { key: 'z' }, [h('span', { key: 'd', style: { ...S.legendDot, background: 'transparent', borderTop: '1px dashed var(--dsw-alias-label-tertiary)', height: 0 } }), '平静（效价 0）']),
                ]),
              ]),
        ]),
      ])

      // 草稿态：没有评分 Tab，只有「导入故事 → 生成人格卡」引导（照原型）
      const draftGuide = h('div', { key: 'guide', style: { ...S.card, padding: '24px' } }, [
        h('div', { key: 'h', style: { ...S.sectionTitle, textAlign: 'center' } }, '导入角色故事'),
        h('div', { key: 'p', style: { ...S.hint, textAlign: 'center', margin: '8px 0 16px' } },
          '导入该角色的小说故事，即可自动生成大五人格评分与人格卡。'),
        h('div', { key: 'f1', style: S.field }, [
          h('span', { key: 'l', style: S.fieldLabel }, '故事标题（可选）'),
          h('input', {
            key: 'i', type: 'text', style: S.input, value: storyTitle, maxLength: 80,
            placeholder: '如：《织造录》第三章 · 留空显示「未命名故事」',
            onChange: (e) => setStoryTitle(e.target.value),
          }),
        ]),
        h('div', { key: 'f2', style: { ...S.field, marginTop: '10px' } }, [
          h('span', { key: 'l', style: S.fieldLabel }, ['人物故事文本 ', h('span', { key: 'r', style: { color: '#ef4444' } }, '*')]),
          h('textarea', {
            key: 'i', style: S.textarea, value: storyText,
            placeholder: '在此粘贴包含该角色行为、对话、心理描写的段落……',
            onChange: (e) => { setStoryText(e.target.value); setError(null) },
          }),
          h(UploadBox, { key: 'u', onText: (t) => { setStoryText(t); setError(null) } }),
        ]),
        error ? h('div', { key: 'err', style: { ...S.error, marginTop: '8px' } }, error) : null,
        note ? h('div', { key: 'note', style: { ...S.ok, marginTop: '8px' } }, note) : null,
        h('div', { key: 'ops', style: { marginTop: '14px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, [
          h('button', {
            key: 'go', type: 'button',
            style: busy ? { ...S.btnPrimary, ...S.btnDisabled } : S.btnPrimary,
            disabled: busy,
            onClick: regenerateFromDraft,
          }, busy ? '生成中…' : '生成人格卡'),
          h('button', { key: 's', type: 'button', style: S.btn, onClick: saveDraftEdits, disabled: busy }, '保存'),
          busy ? h('span', { key: 'b', style: S.hint }, '模型正在读故事，通常 15–30 秒') : null,
        ]),
      ])

      const panel = tab === 'overview'
        ? overview
        : tab === 'exp'
          ? expTab
          : tab === 'detail'
            ? detailTab
            : tab === 'source'
              ? sourceTab
              : tab === 'interact'
                ? interactTab
                : emotionTab

      return h('div', { style: S.page }, [
        h('div', { key: 'top', style: S.topbar }, [
          h('button', { key: 'b', type: 'button', style: S.back, onClick: onBack }, [h(BackIcon, { key: 'i' }), '返回助理列表']),
          h('span', { key: 't', style: S.topTitle }, '助理详情'),
        ]),
        h('div', { key: 'card', style: { ...S.card, borderRadius: '16px' } }, profile),
        error && editing ? h('div', { key: 'err', style: S.error }, error) : null,
        statusbar,
        draftLike
          ? draftGuide
          : h('div', { key: 'tabs', style: S.tabs }, TABS.map(([k, label]) =>
              h('button', {
                key: k, type: 'button',
                style: k === tab ? { ...S.tab, ...S.tabOn } : S.tab,
                onClick: () => setTab(k),
              }, label))),
        draftLike ? null : panel,
      ])
    }

    // ── 生成调用（Host RPC） ──────────────────────────────────────────────

    /** 把传输层错误翻译成人话。 */
    const friendlyError = (err) => {
      const msg = String((err && err.message) || err || '')
      if (/HTTP 40[45]/.test(msg)) return new Error('生成接口还没就绪：改完插件需要重启 DSH 再试')
      if (/HTTP 401/.test(msg)) return new Error('登录态失效，请刷新页面后重试')
      if (/Failed to fetch|NetworkError/i.test(msg)) return new Error('连不上 DSH，请确认应用还在运行')
      return err instanceof Error ? err : new Error(msg || '生成失败')
    }

    /** 调 Host 的生成接口：POST api/memora-bigfive/generate。 */
    async function callGenerate({ storyTitle, storyText, nameHint, bioHint }) {
      let response
      try {
        response = await fetch('api/memora-bigfive/generate', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ storyTitle, storyText, nameHint, bioHint }),
        })
      } catch (err) {
        throw friendlyError(err)
      }
      if (!response.ok) throw friendlyError(new Error(`HTTP ${response.status}`))
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error('生成失败：返回格式不对')
      }
      if (!body || body.ok !== true) {
        const message = body && body.error && body.error.message
        throw new Error(message || '生成失败')
      }
      return cleanPersona(body.value, 0)
    }

    // ── 设置页入口 ────────────────────────────────────────────────────────

    function SettingsPage({ form }) {
      const snap = useForm(form)
      const [view, setView] = React.useState({ kind: 'list' })
      const [notice, setNotice] = React.useState(null)
      const [newId, setNewId] = React.useState(null)
      const seeded = React.useRef(false)

      const value = (snap && snap.value) || {}
      const list = toArray(value.personas).map((p, i) => cleanPersona(p, i))
      const sidebarVisible = value.sidebarVisible === true

      React.useEffect(() => {
        // 只有表单真正加载完（ready）才播种默认人格。否则在 idle/loading 时
        // list 是空的，会把 DEFAULTS 写进去，覆盖掉配置里已有的助理。
        if (!form || !snap || snap.status !== 'ready') return
        if (seeded.current) return
        seeded.current = true
        if (list.length === 0) {
          putPersonas(form, DEFAULTS)
          putActiveId(form, DEFAULTS[0].id)
        } else if (!value.activeId) {
          putActiveId(form, list[0].id)
        }
      }, [form, snap, list, value.activeId])

      if (!form) return h('div', { style: S.page }, h('span', { style: S.hint }, 'configForms 不可用'))
      if (snap && snap.status === 'unavailable') {
        return h('div', { style: S.page }, h('div', { style: S.hint }, '人格配置未就绪：请重启 DSH 后重试。'))
      }

      if (view.kind === 'create') {
        return h(CreatePage, {
          key: 'create',
          onCancel: () => setView({ kind: 'list' }),
          onCreated: (result) => {
            const id = `persona-${Date.now()}`
            const next = cleanPersona({
              ...result,
              id,
              history: [{
                at: Date.now(),
                action: '自动评分',
                tags: result.tags,
                summary: result.summary,
                storyTitle: result.storyTitle,
                storyExcerpt: String(result.storyText || '').slice(0, 600),
                scores: result.scores,
              }],
            }, 0)
            putPersonas(form, [next, ...list])
            putActiveId(form, id)
            setNewId(id)
            setView({ kind: 'list' })
            setNotice(`已生成「${next.name}」：助理列表已更新；刷新页面后可在「模式」里选到它。`)
          },
          onSaveDraft: (draft) => {
            const next = cleanPersona(draft, 0)
            putPersonas(form, [next, ...list])
            setNewId(next.id)
            setView({ kind: 'list' })
          },
        })
      }

      const openDetail = (id) => { putActiveId(form, id); setNewId(null); setView({ kind: 'detail', id }) }
      const deletePersona = (id) => {
        const nextList = list.filter((p) => p.id !== id)
        putPersonas(form, nextList)
        // 删掉的正好是当前选中的人格时，activeId 要跟着落到下一个，避免配置里
        // 留下一个已经不存在的 id（写盘后会变成悬空引用）。
        if (value.activeId === id) putActiveId(form, nextList[0] ? nextList[0].id : '')
        if (view.id === id) setView({ kind: 'list' })
      }
      const listProps = {
        key: 'list',
        form,
        list,
        sidebarVisible,
        onOpen: openDetail,
        onCreate: () => setView({ kind: 'create' }),
        notice,
        onDismissNotice: () => setNotice(null),
        onReload: () => { try { window.location.reload() } catch {} },
        newId,
      }

      if (view.kind === 'detail') {
        const persona = list.find((p) => p.id === view.id)
        if (!persona) return h(ListPage, listProps)
        return h(DetailPage, {
          key: `detail-${persona.id}`,
          form,
          list,
          persona,
          onBack: () => setView({ kind: 'list' }),
          onDelete: () => deletePersona(persona.id),
        })
      }

      return h(ListPage, listProps)
    }

    // ── 会话页信息卡（只读） ──────────────────────────────────────────────

    /** 折叠态只显示一个最有辨识度的标签（离 50 分最远的维度）。 */
    function salientTag(p) {
      const tags = Array.isArray(p && p.tags) ? p.tags : []
      if (tags.length === 0) return ''
      let best = 0
      let bestDiff = -1
      DIMENSIONS.forEach((_, i) => {
        const diff = Math.abs(dimPercent(p, i) - 50)
        if (diff > bestDiff) { bestDiff = diff; best = i }
      })
      return tags[best] || tags[0]
    }

    /** 五维标签按高/中/低着色（沿用设计规范的主色 + 成功绿/警示色）。 */
    function tagStyle(tag, large) {
      const level = String(tag || '').charAt(0)
      const base = large ? { ...S.cardTag, padding: '3px 8px' } : S.cardTag
      if (level === '高') return { ...base, background: 'rgba(245,158,11,0.14)', color: 'var(--dsw-alias-state-warn-primary, #b45309)' }
      if (level === '低') return { ...base, background: 'rgba(59,110,245,0.12)', color: 'var(--dsw-alias-state-business-primary)' }
      return { ...base, background: 'rgba(127,127,127,0.1)', color: 'var(--dsw-alias-label-secondary)' }
    }

    const STATIC_PRESETS = {
      'memora-gentle': 'gentle_senior',
      'memora-tsundere': 'tsundere_buddy',
    }

    function personaForPreset(list, presetId) {
      if (typeof presetId !== 'string' || presetId === '') return null
      if (presetId.indexOf('memora-') === 0) {
        const dynamicId = presetId.slice('memora-'.length)
        const found = list.find((p) => p && p.id === dynamicId)
        if (found) return found
      }
      const staticId = STATIC_PRESETS[presetId]
      if (staticId) return list.find((p) => p && p.id === staticId) || null
      return null
    }

    function presetBelongsTo(presetId, personaId) {
      if (typeof presetId !== 'string' || !personaId) return false
      if (presetId === `memora-${personaId}`) return true
      return STATIC_PRESETS[presetId] === personaId
    }

    function startOfDay(now) {
      const d = new Date(now)
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }

    function startOfWeek(now) {
      const d = new Date(startOfDay(now))
      const offset = (d.getDay() + 6) % 7
      d.setDate(d.getDate() - offset)
      return d.getTime()
    }

    function countConversations(byId, personaId, now) {
      const out = { today: 0, week: 0, total: 0 }
      if (!byId || typeof byId !== 'object' || !personaId) return out
      const dayStart = startOfDay(now)
      const weekStart = startOfWeek(now)
      for (const entry of Object.values(byId)) {
        if (!entry || typeof entry !== 'object') continue
        if (entry.blank === true) continue
        if (entry.parentId !== undefined || entry.origin === 'subagent') continue
        const presetId = entry.projectionValues && entry.projectionValues.agentPreset
        if (!presetBelongsTo(presetId, personaId)) continue
        out.total += 1
        const at = Number(entry.updatedAt) || 0
        if (at >= dayStart) out.today += 1
        if (at >= weekStart) out.week += 1
      }
      return out
    }

    /**
     * 会话页人格卡：折叠态是一枚药丸，点开后在药丸上方浮出小卡。
     * 小卡里可再展开「完整人格卡」（五维条 + 摘要），不弹窗。
     */
    function InfoCard({ form, presetId, byId }) {
      const snap = useForm(form)
      const [open, setOpen] = React.useState(false)
      const [full, setFull] = React.useState(false)
      const wrapRef = React.useRef(null)
      const value = (snap && snap.value) || {}
      const list = toArray(value.personas).map((p, i) => cleanPersona(p, i))
      const p = presetId === undefined
        ? list.find((x) => x && x.id === value.activeId) || list[0] || null
        : personaForPreset(list, presetId)

      React.useEffect(() => {
        if (!open) return undefined
        const close = () => { setOpen(false); setFull(false) }
        const onDown = (e) => {
          if (wrapRef.current && !wrapRef.current.contains(e.target)) close()
        }
        const onKey = (e) => { if (e.key === 'Escape') close() }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      if (value.sidebarVisible !== true || !p) return null

      const counts = countConversations(byId, p.id, Date.now())
      const avatarIndex = Math.max(0, list.findIndex((x) => x && x.id === p.id))
      const tags = Array.isArray(p.tags) ? p.tags : []
      const one = salientTag(p)
      const hasScores = Array.isArray(p.scores) && p.scores.length > 0
      const source = p.storyTitle || '未命名故事'
      const meta = `来源：${source}${byId === undefined ? '' : ` · 累计对话 ${counts.total}`}`

      const toggle = () => {
        if (open) { setOpen(false); setFull(false) }
        else setOpen(true)
      }

      const pill = h('button', {
        key: 'pill', type: 'button', style: S.pill,
        onClick: toggle, 'aria-expanded': open, 'aria-label': '人格卡',
      }, [
        h('span', { key: 'a', style: { ...S.pillAvatar, background: avatarBg(avatarIndex) } }, initialOf(p)),
        h('span', { key: 'n', style: S.pillName }, p.name || '未命名角色'),
        p.bio ? h('span', { key: 'b', style: S.pillBio }, p.bio) : null,
        one ? h('span', { key: 't', style: tagStyle(one) }, one) : null,
        h('svg', {
          key: 'c', width: 12, height: 12, viewBox: '0 0 12 12',
          style: { ...S.pillChevron, transform: open ? 'rotate(180deg)' : 'none' },
        }, h('path', {
          d: 'M2 4 L6 8 L10 4', stroke: 'var(--dsw-alias-label-tertiary)',
          strokeWidth: 1.5, fill: 'none', strokeLinecap: 'round',
        })),
      ])

      const card = h('div', {
        key: 'card', style: S.infoCard, role: 'dialog', 'aria-label': '人格卡详情',
      }, [
        h('div', { key: 'head', style: S.cardHead }, [
          h('span', { key: 'a', style: { ...S.cardAvatar, background: avatarBg(avatarIndex) } }, initialOf(p)),
          h('div', { key: 'm', style: S.cardMain }, [
            h('div', { key: 'n', style: S.cardName }, p.name || '未命名角色'),
            p.bio ? h('div', { key: 'b', style: S.cardBio }, p.bio) : null,
          ]),
        ]),
        full
          ? h('div', { key: 'full', style: S.cardFull }, [
              h('div', { key: 'bars', style: S.cardBars }, DIMENSIONS.map(([key, name, color], i) =>
                h('div', { key, style: S.cardBarRow }, [
                  h('span', { key: 'n', style: S.cardBarName }, name),
                  h('div', { key: 't', style: S.cardBarTrack }, h('div', { key: 'f', style: { ...S.cardBarFill, width: `${dimPercent(p, i)}%`, background: color } })),
                  h('span', { key: 'v', style: S.cardBarVal }, dimAvg(p, i).toFixed(1)),
                ]))),
              p.summary ? h('div', { key: 's', style: S.cardSummary }, p.summary) : null,
            ])
          : h('div', { key: 'tags', style: S.cardTags }, tags.map((t) => h('span', { key: t, style: tagStyle(t, true) }, t))),
        full ? null : h('div', { key: 'meta', style: S.cardMeta }, meta),
        hasScores
          ? h('button', {
              key: 'more', type: 'button', style: S.cardLink,
              onClick: () => setFull((v) => !v),
            }, full ? '← 收起' : '查看完整人格卡 →')
          : null,
      ])

      return h('div', {
        ref: wrapRef,
        style: S.pillWrap,
        'data-memora-card': 'persona',
        'data-memora-persona': p.id || '',
        'data-memora-preset': typeof presetId === 'string' ? presetId : String(presetId),
      }, [pill, open ? card : null])
    }

    function CardWithAll({ form, useProjection, useSessions }) {
      const presetId = useProjection('agentPreset')
      const byId = useSessions((s) => (s ? s.byId : undefined))
      return h(InfoCard, { form, presetId, byId })
    }

    function CardWithPreset({ form, useProjection }) {
      const presetId = useProjection('agentPreset')
      return h(InfoCard, { form, presetId, byId: undefined })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let form
        try {
          const cf = ctx.get ? ctx.get('configForms', false) : undefined
          form = cf && typeof cf.get === 'function' ? cf.get('memora-bigfive') : undefined
        } catch (err) {
          form = undefined
        }

        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'personas', order: 16, label: () => '人格' },
              () => h(SettingsPage, { form }),
            ))
        } catch (err) {
          console.error('[memora-bigfive] settings.section 注册失败:', err)
        }

        try {
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              { name: 'conversation.composer.dock', id: 'memora-persona-card', order: 5 },
              (props) => {
                const useProjection = props && props.useProjection
                const useSessions = props && props.useSessions
                if (typeof useProjection === 'function' && typeof useSessions === 'function') {
                  return h(CardWithAll, { form, useProjection, useSessions })
                }
                if (typeof useProjection === 'function') {
                  return h(CardWithPreset, { form, useProjection })
                }
                return h(InfoCard, { form, presetId: undefined, byId: undefined })
              },
            ))
        } catch (err) {
          console.error('[memora-bigfive] composer.dock 注册失败:', err)
        }
      },
    }
  }

  window.__ModuleLoader__.load({
    id: 'memora-bigfive',
    factory(require) {
      try {
        return build(require)
      } catch (err) {
        try {
          console.error('[memora-bigfive] 客户端加载失败，已跳过:', err)
        } catch {}
        return { inject: ['slots'], apply() {} }
      }
    },
  })
})()
