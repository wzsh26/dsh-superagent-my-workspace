/**
 * 大五人格滑块面板（浏览器端）。
 *
 * 挂在输入框上方的 dock 槽位里，5 个 0–100 滑块。
 * 通过 ctx.configForms 读取/写入顶层 memora-bigfive 插件的配置；
 * 写回后由 Host 的 settings 服务持久化，settings.js 的 apply() 落 bigfive.json。
 *
 * 不依赖 Harness 的 client primitives，控件是原生 input[type=range]。
 */
window.__ModuleLoader__.load({
  id: 'memora-dsh',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const KEYS = [
      ['neuroticism', '神经质'],
      ['extraversion', '外倾性'],
      ['openness', '开放性'],
      ['agreeableness', '宜人性'],
      ['conscientiousness', '尽责性'],
    ]

    const styles = {
      wrap: {
        display: 'flex', flexWrap: 'wrap', gap: '10px 16px', alignItems: 'center',
        padding: '8px 12px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
      },
      title: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      row: { display: 'flex', alignItems: 'center', gap: '6px' },
      name: { minWidth: '42px' },
      range: { width: '96px', accentColor: 'var(--dsw-alias-state-business-primary)' },
      val: { minWidth: '24px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
      hint: { color: 'var(--dsw-alias-label-tertiary)' },
    }

    function Panel({ form }) {
      const [snap, setSnap] = React.useState(() => form && form.getSnapshot())
      React.useEffect(() => {
        if (!form || !form.subscribe) return undefined
        setSnap(form.getSnapshot())
        return form.subscribe(() => setSnap(form.getSnapshot()))
      }, [form])
      if (!form) {
        return h('div', { style: styles.wrap }, h('span', { style: styles.hint }, '大五滑块：configForms 不可用'))
      }
      const value = (snap && snap.value) || {}
      if (snap && snap.status === 'unavailable') {
        return h('div', { style: styles.wrap }, h('span', { style: styles.hint }, '大五滑块：memora-bigfive 未就绪'))
      }
      return h('div', { style: styles.wrap }, [
        h('span', { key: 't', style: styles.title }, '大五人格'),
        ...KEYS.map(([k, label]) =>
          h('label', { key: k, style: styles.row }, [
            h('span', { key: 'n', style: styles.name }, label),
            h('input', {
              key: 'r', type: 'range', min: 0, max: 100, step: 1,
              value: typeof value[k] === 'number' ? value[k] : 50,
              style: styles.range,
              onChange: (e) => form.set(k, Number(e.target.value)),
            }),
            h('span', { key: 'v', style: styles.val }, String(typeof value[k] === 'number' ? value[k] : 50)),
          ])),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // configForms 由 settings 客户端服务提供；用非注入读取，避免服务缺失时插件一直挂起。
        let form
        try {
          const cf = ctx.get ? ctx.get('configForms', false) : undefined
          form = cf && typeof cf.get === 'function' ? cf.get('memora-bigfive') : undefined
        } catch {
          form = undefined
        }
        const Bound = () => h(Panel, { form })
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'memora-bigfive-panel',
          order: 5,
        }, Bound))
      },
    }
  },
})
