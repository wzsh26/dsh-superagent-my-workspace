/**
 * memora-bigfive · 浏览器半。
 *
 * 两个落点：
 * 1) 设置 →「人格」页（settings.section）
 *    - 人格列表：只显示名字，可上下排序、可新增
 *    - 点名字 → 进入「人格详情页」，有「展示」和「编辑」两种状态：
 *        进入是展示态，显示「编辑」→ 点击进入编辑态，显示「保存」→ 保存时校验
 *    - 详情页内容：5 个维度 × 每个 3 个 facet，每个 facet 三个参数
 *        μ 基线（可编辑）/ σ 波动幅度（只读）/ θ 吸引子强度（只读）
 *    - 详情页顶部有「特质栏」：Big Two 的稳定性 / 可塑性，只读，
 *      随五维（facet μ）实时重算，并配一小段 Big Five → Big Two 的说明
 *    - 维度值 = 该维度 3 个 facet 的 μ 平均值
 * 2) 会话页右侧信息卡（conversation.composer.dock），只读：
 *    - 只显示 Big Two：稳定性 Stability / 可塑性 Plasticity
 *    - 显示该人格的对话次数：今天 / 本周 / 累计（按人格分开）
 *    - 按当前会话模式（agentPreset 投影）决定显示哪个人格，
 *      标准模式等非 memora 模式不显示卡片
 *
 * ── 数据来源 ────────────────────────────────────────────────────────────────
 * dock 槽位注册的组件 callback 会收到槽位的 standardProps，与本插件相关的是：
 *   useProjection(key)      当前会话的 Session 投影，agentPreset → preset id | null
 *   useSessions(selector)   会话列表 store，selector 拿到 { ids, byId, phase }
 * 会话列表每个条目：{ id, displayTitle, running, retainedBy, blank, updatedAt,
 * formatStatus, projectionValues?, title?, cwd?, parentId?, origin? }
 * 其中 projectionValues 含 agentPreset 与 sessionListMetadata；
 * updatedAt 取 max(会话 updatedAt, lastPromptAt)。
 *
 * ── Big Two 转换 ───────────────────────────────────────────────────────────
 * 稳定性  Stability  = (0.5×N逆 + 0.3×A + 0.3×C) ÷ 1.1   （权重标准化到和为 1）
 * 可塑性  Plasticity = 0.6×E + 0.4×O
 * N逆 = 100 - 神经质。
 *
 * ── 稳定性 ─────────────────────────────────────────────────────────────────
 * - 整个 factory 包在 try/catch 里，加载失败也只是不注册 UI，绝不影响 DSH 启动；
 * - 所有写入 config 的数值都先 sanitize 成 schema 合法形状（personas 必须是数组，
 *   每项必须有字符串 id/name、五维 0..100 数字、15 个 facet 各带数字 mu/sigma/theta），
 *   否则 profile patch 校验失败会导致 DSH 启动失败。
 */
;(function () {
  function build(require) {
    const React = require('react')
    const h = React.createElement

    // [维度key, 代号, 中文名, 英文名, 颜色, [[facetKey, 中文名, 英文名], ...]]
    const DIMENSIONS = [
      ['extraversion', 'E', '外向性', 'Extraversion', '#e0913d', [
        ['sociability', '社交性', 'Sociability'],
        ['assertiveness', '果断性', 'Assertiveness'],
        ['energyLevel', '精力水平', 'Energy Level'],
      ]],
      ['agreeableness', 'A', '宜人性', 'Agreeableness', '#57b06a', [
        ['compassion', '同情心', 'Compassion'],
        ['respectfulness', '尊重', 'Respectfulness'],
        ['trust', '信任', 'Trust'],
      ]],
      ['conscientiousness', 'C', '尽责性', 'Conscientiousness', '#9a6fd6', [
        ['organization', '条理性', 'Organization'],
        ['productiveness', '勤勉性', 'Productiveness'],
        ['selfDiscipline', '自律', 'Self-Discipline'],
      ]],
      ['neuroticism', 'N', '负性情绪', 'Neuroticism', '#e05d5d', [
        ['anxiety', '焦虑', 'Anxiety'],
        ['depression', '抑郁', 'Depression'],
        ['emotionalVolatility', '情绪不稳', 'Emotional Volatility'],
      ]],
      ['openness', 'O', '思维开放', 'Openness', '#4a9fe0', [
        ['curiosity', '求知好奇', 'Intellectual Curiosity'],
        ['aestheticSensitivity', '审美敏感', 'Aesthetic Sensitivity'],
        ['creativeImagination', '创造想象', 'Creative Imagination'],
      ]],
    ]

    const ALL_FACETS = []
    for (const [dim, , , , , facets] of DIMENSIONS) {
      for (const [key, zh, en] of facets) ALL_FACETS.push({ key, dim, zh, en })
    }

    const DEFAULT_SIGMA = 10
    const DEFAULT_THETA = 0.6

    // 会话页信息卡只展示这两维
    const BIG_TWO = [
      ['stability', '稳定性', '#4a7fe0'],
      ['plasticity', '可塑性', '#e0763d'],
    ]

    const DEFAULTS = [
      { id: 'gentle_senior', name: '温柔学姐', neuroticism: 25, extraversion: 40, openness: 60, agreeableness: 80, conscientiousness: 78 },
      { id: 'tsundere_buddy', name: '嘴硬损友', neuroticism: 35, extraversion: 70, openness: 50, agreeableness: 40, conscientiousness: 45 },
    ]

    const clamp = (n) => {
      // null / undefined / '' 都按「没填」处理回退到 50，不要被 Number(null)=0 带偏。
      if (n === null || n === undefined || n === '') return 50
      const x = Number(n)
      return Number.isFinite(x) ? Math.min(100, Math.max(0, Math.round(x))) : 50
    }

    const numOr = (n, fallback) => {
      if (n === null || n === undefined || n === '') return fallback
      const x = Number(n)
      return Number.isFinite(x) ? x : fallback
    }

    const clampNum = (n, fallback, min, max) => {
      const x = numOr(n, fallback)
      return Math.min(max, Math.max(min, x))
    }

    function toArray(v) {
      if (Array.isArray(v)) return v
      if (v && typeof v === 'object') return Object.values(v)
      return []
    }

    /** 把任意来源的人格补齐成「15 个 facet 齐全」的形状（读用，不写盘）。 */
    function withFacets(p) {
      const out = { ...(p || {}), facets: {} }
      for (const f of ALL_FACETS) {
        const src = (p && p.facets && p.facets[f.key]) || {}
        out.facets[f.key] = {
          mu: clamp(src.mu !== undefined && src.mu !== null ? src.mu : (p ? p[f.dim] : 50)),
          sigma: clampNum(src.sigma, DEFAULT_SIGMA, 0, 100),
          theta: clampNum(src.theta, DEFAULT_THETA, 0, 1),
        }
      }
      return out
    }

    /** 维度值 = 该维度 3 个 facet 的 μ 平均值。 */
    function dimensionValue(persona, dim) {
      const spec = DIMENSIONS.find((d) => d[0] === dim)
      if (!spec) return 50
      const facets = spec[5]
      const filled = withFacets(persona)
      const sum = facets.reduce((s, [k]) => s + filled.facets[k].mu, 0)
      return clamp(Math.round(sum / facets.length))
    }

    /** 把任意来源的人格列表压成 schema 合法形状，避免写坏 profile patch。 */
    function sanitize(list) {
      return toArray(list)
        .filter((p) => p && typeof p === 'object')
        .map((p, i) => {
          const filled = withFacets(p)
          const out = {
            id: String(p.id || `persona-${Date.now()}-${i}`),
            name: String(p.name || '').trim() || `人格 ${i + 1}`,
            facets: filled.facets,
          }
          // 维度值由 facet 的 μ 推出来，保持单一事实来源
          for (const [dim] of DIMENSIONS) out[dim] = dimensionValue(p, dim)
          return out
        })
    }

    /** 大五 → Big Two。N 反向编码后参与；权重各自标准化到和为 1。 */
    function bigTwo(p) {
      const filled = withFacets(p)
      const n = dimensionValue(filled, 'neuroticism')
      const e = dimensionValue(filled, 'extraversion')
      const o = dimensionValue(filled, 'openness')
      const a = dimensionValue(filled, 'agreeableness')
      const c = dimensionValue(filled, 'conscientiousness')
      const stabilityRaw = 0.5 * (100 - n) + 0.3 * a + 0.3 * c
      return {
        stability: clamp(Math.round(stabilityRaw / 1.1)), // 0.5+0.3+0.3
        plasticity: clamp(Math.round(0.6 * e + 0.4 * o)), // 权重和本来就是 1
      }
    }

    // 静态 bundle preset id → personaId；动态 preset id 形如 `memora-<personaId>`。
    const STATIC_PRESETS = {
      'memora-gentle': 'gentle_senior',
      'memora-tsundere': 'tsundere_buddy',
    }

    /** 按会话 preset 找对应人格；不是 memora 人格模式（标准模式等）返回 null。 */
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

    /** 这个 preset 是否属于这个人格（静态别名 + 动态 `memora-<id>`）。 */
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

    /** 周一为一周起点。 */
    function startOfWeek(now) {
      const d = new Date(startOfDay(now))
      const offset = (d.getDay() + 6) % 7 // 周一 = 0
      d.setDate(d.getDate() - offset)
      return d.getTime()
    }

    /** 某人格的对话次数：今天 / 本周 / 累计。跳过空白会话和子会话。 */
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

    /** 保存前校验；返回错误文案或 null。 */
    function validatePersona(draft, list) {
      const name = String((draft && draft.name) || '').trim()
      if (!name) return '人格名称不能为空'
      if (name.length > 40) return '人格名称最多 40 个字'
      const dup = list.some((p) => p && p.id !== draft.id && String(p.name || '').trim() === name)
      if (dup) return `已经有人格叫「${name}」了`
      for (const f of ALL_FACETS) {
        const cell = draft && draft.facets && draft.facets[f.key]
        const raw = cell ? cell.mu : undefined
        const x = Number(raw)
        if (raw === undefined || raw === null || raw === '' || !Number.isFinite(x)) {
          return `「${f.zh}」的基线 μ 必须填数字`
        }
        if (x < 0 || x > 100) return `「${f.zh}」的基线 μ 要在 0–100 之间`
      }
      return null
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)', fontSize: '13px' },
      row: { display: 'flex', alignItems: 'center', gap: '10px' },
      label: { minWidth: '72px', color: 'var(--dsw-alias-label-secondary)' },
      list: { display: 'flex', flexDirection: 'column', gap: '2px', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: '8px', padding: '4px' },
      listRow: { display: 'flex', alignItems: 'center', gap: '4px' },
      item: { flex: 1, textAlign: 'left', padding: '8px 10px', borderRadius: '6px', border: 0, background: 'transparent', cursor: 'pointer', font: 'inherit', color: 'inherit' },
      itemOn: { background: 'var(--dsw-alias-interactive-bg-hover)' },
      mini: { font: 'inherit', width: '24px', height: '24px', borderRadius: '6px', cursor: 'pointer', border: '0.5px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', lineHeight: 1 },
      input: { font: 'inherit', padding: '4px 8px', borderRadius: '6px', border: '0.5px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit' },
      num: { width: '60px', textAlign: 'right', font: 'inherit', padding: '3px 6px', borderRadius: '6px', border: '0.5px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit' },
      btn: { font: 'inherit', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', border: '0.5px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit' },
      btnPrimary: { padding: '4px 12px', borderRadius: '6px', cursor: 'pointer', border: '0.5px solid var(--dsw-alias-state-business-primary)', background: 'var(--dsw-alias-state-business-primary)', color: '#fff', font: 'inherit' },
      btnDanger: { color: 'var(--dsw-alias-state-error-primary)' },
      hint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      help: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-1)', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: '10px' },
      helpRow: { display: 'flex', gap: '8px', alignItems: 'baseline' },
      dot: { width: '8px', height: '8px', borderRadius: '50%', flex: 'none' },

      // 详情页
      head: { display: 'flex', alignItems: 'center', gap: '10px' },
      headName: { fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      spacer: { flex: 1 },
      dimBlock: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: '10px' },
      dimHead: { display: 'flex', alignItems: 'baseline', gap: '8px' },
      dimCode: { fontSize: '11px', fontWeight: 700, color: '#fff', borderRadius: '4px', padding: '0px 5px' },
      dimName: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      dimEn: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      dimMean: { marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)' },
      facetRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      facetName: { width: '150px', flex: 'none', color: 'var(--dsw-alias-label-secondary)' },
      facetNameEn: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      track: { flex: 1, height: '6px', borderRadius: '3px', background: 'rgba(127,127,127,0.18)', overflow: 'hidden' },
      fill: { height: '100%', borderRadius: '3px' },
      greek: { width: '96px', flex: 'none', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' },
      legend: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },

      // 特质栏（Big Two）
      traitBlock: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 12px', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: '10px', background: 'rgba(127,127,127,0.04)' },
      traitHead: { display: 'flex', alignItems: 'baseline', gap: '8px' },
      traitTitle: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      traitHint: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      traitRow: { display: 'flex', alignItems: 'center', gap: '10px' },
      traitName: { width: '64px', flex: 'none', color: 'var(--dsw-alias-label-primary)' },
      traitTrack: { flex: 1, height: '8px', borderRadius: '4px', background: 'rgba(127,127,127,0.18)', overflow: 'hidden' },
      traitFill: { height: '100%', borderRadius: '4px' },
      traitVal: { width: '34px', flex: 'none', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      traitNote: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },

      // 信息卡
      card: {
        position: 'fixed', right: '14px', top: '84px', width: '232px', zIndex: 40,
        display: 'flex', flexDirection: 'column', gap: '10px',
        padding: '10px 12px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
        boxShadow: '0 6px 24px rgba(0,0,0,0.12)',
      },
      cardName: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      stats: { display: 'flex', gap: '6px' },
      stat: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px', padding: '6px 0', borderRadius: '8px', background: 'rgba(127,127,127,0.08)' },
      statNum: { fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 },
      statLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      dimRow: { display: 'flex', flexDirection: 'column', gap: '4px' },
      dimHeadCard: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
      dimNameCard: { color: 'var(--dsw-alias-label-primary)' },
      dimVal: { fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)' },
      trackCard: { height: '6px', borderRadius: '3px', background: 'rgba(127,127,127,0.18)', overflow: 'hidden' },
      fillCard: { height: '100%', borderRadius: '3px' },
    }

    function useForm(form) {
      const [snap, setSnap] = React.useState(() => (form ? form.getSnapshot() : undefined))
      React.useEffect(() => {
        if (!form || !form.subscribe) return undefined
        setSnap(form.getSnapshot())
        return form.subscribe(() => setSnap(form.getSnapshot()))
      }, [form])
      return snap
    }

    /** 整组覆盖写 personas（先 sanitize），不做按索引写，避免写成对象。 */
    function putPersonas(form, list) {
      if (!form) return
      form.mutate([{ op: 'set', path: ['personas'], value: sanitize(list) }])
    }

    function putActiveId(form, id) {
      if (!form) return
      form.mutate([{ op: 'set', path: ['activeId'], value: String(id || '') }])
    }

    function HelpBox() {
      return h('div', { style: S.help }, [
        h('div', { key: 't', style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '五个维度与三个 facet'),
        ...DIMENSIONS.map(([dim, code, zh, en, color, facets]) =>
          h('div', { key: dim, style: S.helpRow }, [
            h('span', { key: 'd', style: { ...S.dot, background: color } }),
            h('span', { key: 'n', style: { minWidth: '120px', fontWeight: 600 } }, `${code} ${zh} ${en}`),
            h('span', { key: 's' }, facets.map(([, fzh]) => fzh).join(' / ')),
          ])),
        h('div', { key: 'p', style: { ...S.hint, marginTop: '4px' } },
          '每个 facet 三个参数：μ 基线（唯一可编辑项）、σ 波动幅度、θ 吸引子强度。维度值 = 三个 facet 的 μ 平均值。'),
        h('div', { key: 'b2', style: S.hint },
          '会话页信息卡只展示归并后的两维：稳定性 = 0.5×情绪稳定性 + 0.3×宜人性 + 0.3×尽责性；可塑性 = 0.6×外倾性 + 0.4×开放性。'),
      ])
    }

    // ── 详情页：展示 / 编辑 两态 ─────────────────────────────────────────────

    /** 特质栏：Big Two 两维，只读，随五维变化实时重算。 */
    function TraitSection({ persona }) {
      const b = bigTwo(persona)
      return h('div', { style: S.traitBlock, 'data-memora-traits': 'bigtwo' }, [
        h('div', { key: 'head', style: S.traitHead }, [
          h('span', { key: 't', style: S.traitTitle }, '特质'),
          h('span', { key: 'h', style: S.traitHint }, '由五个维度归并而来，不可直接修改'),
        ]),
        ...BIG_TWO.map(([k, name, color]) =>
          h('div', { key: k, style: S.traitRow, 'data-trait': k }, [
            h('span', { key: 'n', style: S.traitName }, name),
            h('div', { key: 't', style: S.traitTrack }, [
              h('div', { key: 'f', style: { ...S.traitFill, width: `${b[k]}%`, background: color } }),
            ]),
            h('span', { key: 'v', style: S.traitVal }, String(b[k])),
          ])),
        h('div', { key: 'note', style: S.traitNote }, [
          h('div', { key: 'a' }, 'Big Five 的五个维度可以归并为两个高阶特质，也就是 Big Two。'),
          h('div', { key: 'b' }, '稳定性 Stability ≈ (0.5×N逆 + 0.3×A + 0.3×C) ÷ 1.1，其中 N逆 = 100 − 神经质。'),
          h('div', { key: 'c' }, '可塑性 Plasticity ≈ 0.6×E + 0.4×O。'),
        ]),
      ])
    }

    function PersonaDetailPage({ form, list, persona, canDelete, onBack, onDeleted }) {
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState(null)
      const [error, setError] = React.useState(null)

      const shown = editing && draft ? draft : persona
      const setFacetMu = (key, v) => {
        setDraft((d) => (d ? { ...d, facets: { ...d.facets, [key]: { ...d.facets[key], mu: clamp(v) } } } : d))
        setError(null)
      }
      const begin = () => {
        setDraft(withFacets(persona))
        setError(null)
        setEditing(true)
      }
      const cancel = () => {
        setDraft(null)
        setError(null)
        setEditing(false)
      }
      const save = () => {
        const next = withFacets(draft)
        next.name = String(draft.name || '').trim()
        const problem = validatePersona(next, list)
        if (problem) {
          setError(problem)
          return
        }
        putPersonas(form, list.map((p) => (p.id === persona.id ? next : p)))
        setEditing(false)
        setDraft(null)
        setError(null)
      }
      const remove = () => {
        if (!canDelete) return
        putPersonas(form, list.filter((p) => p.id !== persona.id))
        onDeleted?.()
      }

      return h('div', { style: S.page }, [
        h('div', { key: 'head', style: S.head }, [
          h('button', { key: 'back', type: 'button', style: S.btn, onClick: onBack }, '← 返回'),
          h('span', { key: 'n', style: S.headName }, shown.name || '未命名人格'),
          h('span', { key: 'sp', style: S.spacer }),
          editing
            ? h('button', { key: 'cancel', type: 'button', style: S.btn, onClick: cancel }, '取消')
            : h('button', { key: 'edit', type: 'button', style: S.btn, onClick: begin }, '编辑'),
          editing
            ? h('button', { key: 'save', type: 'button', style: S.btnPrimary, onClick: save }, '保存')
            : null,
        ]),
        editing
          ? h('div', { key: 'nameRow', style: S.row }, [
              h('span', { key: 'l', style: S.label }, '名称'),
              h('input', {
                key: 'i', type: 'text', style: { ...S.input, flex: 1 },
                value: draft ? draft.name : '', maxLength: 40,
                onChange: (e) => {
                  const v = e.target.value
                  setDraft((d) => (d ? { ...d, name: v } : d))
                  setError(null)
                },
              }),
            ])
          : null,
        error ? h('div', { key: 'err', style: S.error }, error) : null,
        h(TraitSection, { key: 'traits', persona: shown }),
        ...DIMENSIONS.map(([dim, code, zh, en, color, facets]) =>
          h('div', { key: dim, style: S.dimBlock }, [
            h('div', { key: 'h', style: S.dimHead }, [
              h('span', { key: 'c', style: { ...S.dimCode, background: color } }, code),
              h('span', { key: 'n', style: S.dimName }, zh),
              h('span', { key: 'e', style: S.dimEn }, en),
              h('span', { key: 'm', style: S.dimMean }, `均值 ${dimensionValue(shown, dim)}`),
            ]),
            ...facets.map(([key, fzh, fen]) => {
              const cell = withFacets(shown).facets[key]
              return h('div', { key, style: S.facetRow }, [
                h('span', { key: 'n', style: S.facetName }, [
                  fzh,
                  h('span', { key: 'e', style: { ...S.facetNameEn, marginLeft: '6px' } }, fen),
                ]),
                editing
                  ? h('input', {
                      key: 'r', type: 'range', min: 0, max: 100, step: 1,
                      value: cell.mu, 'data-facet': key,
                      style: { flex: 1, accentColor: color },
                      onChange: (e) => setFacetMu(key, e.target.value),
                    })
                  : h('div', { key: 't', style: S.track }, [
                      h('div', { key: 'f', style: { ...S.fill, width: `${cell.mu}%`, background: color } }),
                    ]),
                editing
                  ? h('input', {
                      key: 'v', type: 'number', min: 0, max: 100, step: 1,
                      value: cell.mu, 'data-facet-mu': key,
                      style: S.num, onChange: (e) => setFacetMu(key, e.target.value),
                    })
                  : h('span', { key: 'v', style: { ...S.dimVal, width: '60px', flex: 'none', textAlign: 'right' } }, String(cell.mu)),
                h('span', { key: 'g', style: S.greek }, `σ ${cell.sigma.toFixed(1)}  θ ${cell.theta.toFixed(2)}`),
              ])
            }),
          ])),
        h('div', { key: 'legend', style: S.legend },
          editing ? '编辑中：只有 μ 基线可改，σ 波动幅度和 θ 吸引子强度是只读参数。' : '展示态：点右上角「编辑」才能修改。'),
        editing && canDelete
          ? h('div', { key: 'danger', style: S.row }, [
              h('button', { key: 'd', type: 'button', style: { ...S.btn, ...S.btnDanger }, onClick: remove }, '删除这个人格'),
              h('span', { key: 'h', style: S.hint }, '至少保留一个人格'),
            ])
          : null,
      ])
    }

    function SettingsPage({ form }) {
      const snap = useForm(form)
      const [openId, setOpenId] = React.useState(null)
      const [showHelp, setShowHelp] = React.useState(false)
      const seeded = React.useRef(false)

      const value = (snap && snap.value) || {}
      const list = toArray(value.personas)
      const sidebarVisible = value.sidebarVisible === true
      const activeId = value.activeId || (list[0] && list[0].id) || ''

      React.useEffect(() => {
        if (!form || !snap || snap.status === 'loading') return
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

      const openPersona = openId ? list.find((p) => p && p.id === openId) : null

      // 详情页
      if (openPersona) {
        return h(PersonaDetailPage, {
          key: `detail-${openPersona.id}`,
          form,
          list,
          persona: openPersona,
          canDelete: list.length > 1,
          onBack: () => setOpenId(null),
          onDeleted: () => setOpenId(null),
        })
      }

      const move = (i, dir) => {
        const j = i + dir
        if (j < 0 || j >= list.length) return
        const next = [...list]
        const tmp = next[i]
        next[i] = next[j]
        next[j] = tmp
        putPersonas(form, next)
      }
      const addPersona = () => {
        const base = list.find((p) => p && p.id === activeId) || list[0] || {}
        const id = `persona-${Date.now()}`
        const next = { ...withFacets(base), id, name: `人格 ${list.length + 1}` }
        putPersonas(form, [...list, next])
        putActiveId(form, id)
        setOpenId(id)
      }

      return h('div', { style: S.page }, [
        h('div', { key: 'toggle', style: S.row }, [
          h('label', { key: 'l', style: { ...S.row, cursor: 'pointer' } }, [
            h('input', {
              key: 'c', type: 'checkbox', checked: sidebarVisible,
              onChange: (e) => form.mutate([{ op: 'set', path: ['sidebarVisible'], value: e.target.checked }]),
            }),
            h('span', { key: 's' }, '在会话页右侧显示人格信息卡'),
          ]),
        ]),
        h('div', { key: 'head', style: S.row }, [
          h('span', { key: 'l', style: S.label }, '人格列表'),
          h('button', { key: 'a', type: 'button', style: S.btn, onClick: addPersona }, '＋ 新增'),
          h('button', {
            key: 'h', type: 'button', style: S.btn, title: '维度与 facet 说明',
            onClick: () => setShowHelp((v) => !v),
          }, showHelp ? '收起说明' : '？说明'),
        ]),
        showHelp ? h(HelpBox, { key: 'help' }) : null,
        h('div', { key: 'list', style: S.list },
          list.length === 0
            ? [h('span', { key: 'e', style: { ...S.hint, padding: '8px' } }, '还没有人格，点「＋ 新增」')]
            : list.map((p, i) => h('div', { key: p.id || i, style: S.listRow }, [
                h('button', {
                  key: 'n', type: 'button',
                  style: p.id === activeId ? { ...S.item, ...S.itemOn } : S.item,
                  onClick: () => {
                    putActiveId(form, p.id)
                    setOpenId(p.id)
                  },
                }, p.name || `人格 ${i + 1}`),
                h('button', { key: 'u', type: 'button', style: S.mini, title: '上移', disabled: i === 0, onClick: () => move(i, -1) }, '↑'),
                h('button', { key: 'd', type: 'button', style: S.mini, title: '下移', disabled: i === list.length - 1, onClick: () => move(i, 1) }, '↓'),
              ]))),
        h('div', { key: 'tip', style: S.hint }, '点人格名字进入详情页；详情页里可以编辑。'),
      ])
    }

    // ── 会话页信息卡（只读） ────────────────────────────────────────────────
    function StatCell({ value, label }) {
      return h('div', { style: S.stat }, [
        h('span', { key: 'v', style: S.statNum }, value === undefined ? '—' : String(value)),
        h('span', { key: 'l', style: S.statLabel }, label),
      ])
    }

    function DimBar({ name, color, value }) {
      return h('div', { style: S.dimRow }, [
        h('div', { key: 'h', style: S.dimHeadCard }, [
          h('span', { key: 'n', style: S.dimNameCard }, name),
          h('span', { key: 'v', style: S.dimVal }, String(value)),
        ]),
        h('div', { key: 't', style: S.trackCard }, [
          h('div', { key: 'f', style: { ...S.fillCard, width: `${value}%`, background: color } }),
        ]),
      ])
    }

    function InfoCard({ form, presetId, byId }) {
      const snap = useForm(form)
      const value = (snap && snap.value) || {}

      const list = toArray(value.personas)
      // undefined = 还没读到会话模式（无会话/投影未到）→ 退回设置页选中的人格；
      // null / 非 memora preset = 标准模式等 → 不显示卡片。
      const p =
        presetId === undefined
          ? list.find((x) => x && x.id === value.activeId) || list[0] || null
          : personaForPreset(list, presetId)
      if (value.sidebarVisible !== true || !p) return null

      const counts = countConversations(byId, p.id, Date.now())
      const dims = bigTwo(p)

      return h('div', {
        style: S.card,
        'data-memora-card': 'persona',
        'data-memora-persona': p.id || '',
        'data-memora-preset': typeof presetId === 'string' ? presetId : String(presetId),
      }, [
        h('div', { key: 'name', style: S.cardName }, p.name || '未命名人格'),
        h('div', { key: 'stats', style: S.stats, title: '当前人格的对话次数' }, [
          h(StatCell, { key: 'd', value: byId === undefined ? undefined : counts.today, label: '今天' }),
          h(StatCell, { key: 'w', value: byId === undefined ? undefined : counts.week, label: '本周' }),
          h(StatCell, { key: 't', value: byId === undefined ? undefined : counts.total, label: '累计' }),
        ]),
        ...BIG_TWO.map(([k, name, color]) =>
          h(DimBar, { key: k, name, color, value: dims[k] })),
      ])
    }

    // 槽位可能不给某些 hook，而 Hook 不能条件调用，所以按「拿到了哪些」分组件。
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
        // 加载失败也不能连累 DSH 启动：退化成不注册任何 UI。
        try {
          console.error('[memora-bigfive] 客户端加载失败，已跳过:', err)
        } catch {}
        return { inject: ['slots'], apply() {} }
      }
    },
  })
})()
