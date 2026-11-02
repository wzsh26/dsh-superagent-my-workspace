# Memora Bigfive · 交接文档

> 日期：2026-11-03
> 仓库：<https://github.com/wzsh26/dsh-superagent-my-workspace>
> 当前版本：`memora-bigfive` **2.5.0**
> 当前状态：列表 / 添加 / 草稿 / 详情 6 Tab 的 UI 已完成；**互动记录、情绪波动还没有接数据源**，目前只有结构和空态；「记忆萃取」按钮暂时禁用。

---

## 0. 新会话怎么开始

1. 先 `git pull` 本仓库，读这份 `HANDOFF.md`。
2. 再读原型目录里的：
   - `页面设计规范说明.md`
   - `字段说明.md`
   - `页面需求说明.md`
   - `agent-detail.html`
3. 本轮 **不要重做 UI**；从 §3「下次要做的事」开始，优先接互动记录 / 情绪波动的数据。
4. 本机测试配置和真实用户数据不要提交到仓库（见 §1.4）。

---

## 1. 项目位置与运行方式

### 1.1 仓库与源码

| 项 | 路径 |
|---|---|
| 仓库根目录 | `/Users/wen/DeepSeekHarness/插件开发/人格插件` |
| 当前要改的插件 | `memora-bigfive/` |
| 另一个插件（本轮未改） | `memora-dsh/` |
| GitHub remote | `https://github.com/wzsh26/dsh-superagent-my-workspace.git` |

### 1.2 DSH 里的安装方式

`memora-bigfive` 不是独立应用，是 DSH bundle 插件的 client/host 两半：

- Host：`memora-bigfive/index.js`
- Client：`memora-bigfive/client.js`（浏览器端 React）
- 安装 profile：`~/.dsh/profiles/desktop`
- 软链：`~/.dsh/profiles/desktop/node_modules/memora-bigfive -> /Users/wen/DeepSeekHarness/插件开发/人格插件/memora-bigfive`

### 1.3 运行与生效

- GUI：`http://127.0.0.1:61699`（DSH 重启后端口可能变；以实际为准）
- **只改 `client.js`**：保存后刷新页面（⌘R）即可。
- **改 `index.js`（schema / prompt / HTTP 路由）**：需要重启 DSH 进程才会生效。
- 本轮改了 `index.js` 的：
  - `memories` / `emotions` 两个 schema 字段与 normalize
  - 生成 prompt 里的人物摘要改成三段式
  - 这些 host 改动在当前运行进程里可能还没生效；新开会话重启后自然生效。

### 1.4 数据落点（不要提交）

| 数据 | 位置 |
|---|---|
| 人格配置 | `~/.dsh/profiles/desktop/cordis.patch.yml` 里的 `- id: memora-bigfive` 段 |
| 五维 / 记忆摘要 | `~/.memora/personas.json`（由 host 写） |
| memora 对话记忆 | `~/.memora/memora-<persona>.jsonl` |
| 仓库 | 只放源码 / 文档，**不要提交上面这些用户数据** |

仓库 `.gitignore` 目前只忽略 `.DS_Store`、`node_modules/`、`*.log`；如果新增 fixture / 本地数据文件，记得补 ignore。

### 1.5 原型文档位置（仓库外）

`/Users/wen/WorkBuddy/2026-10-31-21-13-21/小说人物设定模板/大五评分HTML原型/`

---

## 2. 当前已实现（2.5.0）

### 2.1 列表页

- 「会话页显示助理」开关（原「会话头像」改名）。
- 「添加助理」入口。
- 每行：头像、角色名、最多 3 个显著标签（高/低优先，`中` 标签不进列表）、一句话简介、生成状态。
- 生成 / 保存草稿后，新行带绿色「新」标记（仅本地 session 状态，刷新后消失）。
- 列表行不再有删除；子项线框为 `1px rgba(127,127,127,0.12)`，hover 变主色。

### 2.2 添加助理 / 草稿

- 字段：角色名（可选）、一句话简介（≤20 字）、故事标题（可选）、人物故事文本（必填，可上传 `.txt/.md`）。
- 操作：生成人格卡 / 保存草稿 / 取消。
- 保存草稿不校验必填，直接进列表，状态「草稿 · 待生成」。
- 草稿详情页没有评分类 Tab，只有「导入角色故事」引导 + 生成 / 保存。
- `isDraft(p)` 现在按 **是否有真实五维分数** 判断，不再按有没有 storyText；草稿保存故事后仍然是草稿。

### 2.3 详情页头部

- 头像 64、角色名 20、简介、五个只读标签、编辑 / 删除。
- 编辑 / 删除按钮相对简介栏垂直居中；删除是内联二次确认（确认删除 / 取消），删除后回列表。
- 编辑态可改角色名、简介；标签只读，标注「标签（由人物剖析图自动生成）」。
- 草稿态不显示标签，显示「人格卡生成后，将自动根据大五评分配上标签。」

### 2.4 详情页 6 个 Tab

1. **人物概述**
   - 人物剖析：雷达图 + 五维分数条 + 五个类型标签
   - 人物摘要：只展示三段「性格 / 说话方式 / 内在矛盾」；旧的「核心设定」不再展示（数据里可能还有，显示时过滤）
2. **关键经历**：事件名 + 简述
3. **评分详情**：5 维 × 6 子维度 × 3 条行为项，1–5 分可点改；维度标题可收起/展开；评分格 26px
4. **来源故事**：故事标题 + 故事文本 + 上传 + 重新评分；历史记录（默认约 3 条，内部展开评分快照，恢复 / 清空）
5. **互动记录**：类型 / 领域筛选 / 作用域提示 / 时间 / 内容；**目前空态**
6. **情绪波动**：近 7 天 / 30 天 / 全部、参考波动带、正负情绪图例；**目前空态**；图表代码已就绪

### 2.5 数据形状

`persona` 现在多了两个可选数组（只有非空时才写进配置）：

```js
{
  id, name, bio, tags[], scores[90], storyTitle, storyText,
  importedAt, charCount, summary, experiences[], history[],
  memories?: [{ at, type, domain, content }],
  emotions?: [{ at, valence, category, memory }]
}
```

- `memories`：互动记录；`type` = 偏好 / 事件 / 承诺，`domain` = 工作 / 情感 / 生活 / 学习 / 通用。
- `emotions`：情绪记录；`valence` = -5（负）~ +5（正），`category` = 愉悦 / 焦虑 / 平静 等，`memory` = 关联记忆文本（可空）。
- 作用域是派生的，不存字段：`type === '偏好'` → 全局通；事件 / 承诺 → 仅本助理。
- 参考波动带也是派生的：神经质「高」→ ±4.0，「中」→ ±2.7，「低」→ ±1.5（`emotionBandHalf`）。

### 2.6 设计规范落点

- 卡片 12px，头部信息卡 16px，按钮 / 输入框 8px，子卡 10px，chip 6px。
- 无阴影，1px 边框；4px 网格；列表行淡线。
- 主色 / 状态色全部走 `--dsw-alias-*` token，暗色模式随 DSH。
- 本轮把按钮圆角从 9 调到 8、卡片从 14 调到 12、评分格从 22 调到 26、维度竖条从 3px 调到 4px。

---

## 3. 下次要做的事

### P0-1 · 互动记录接真实数据

**现在的问题**：`client.js` 的互动记录 Tab 只读 `persona.memories`；配置里没有数据，所以永远是空态。`memora-dsh` 已经有对话记忆，但它的 JSONL 只有 `text` / `facts` / `created_at` 这类字段，**没有 `type`（偏好/事件/承诺）和 `domain`（工作/情感/…）**，不能直接映射。

**推荐做法（v1，尽量不动 `memora-dsh` 的抽取管线）**：

1. 在 `memora-bigfive` host 新增 sidecar 读写：
   - `~/.memora/bigfive-<personaId>.memories.jsonl`
   - 一行一条 `{ at, type, domain, content }`，append-only；读取时按 `at` 倒序、按 content 去重、cap 500。
2. 新增 host 路由（照 `registerGenerateRoute` 的 `connection.fetch.register` 写法）：
   - `POST /api/memora-bigfive/extract-memories`
     - body：`{ personaId }`
     - 读 `~/.memora/memora-<personaId>.jsonl` 里最近的 gist / 原文（可限制最近 N 条或最近 30 天）
     - 用默认模型做一次结构化抽取：输出 0–5 条 `{ type, domain, content }`；提示词要求「只抽明确说过的偏好/事件/承诺，不推测；偏好才可全局，事件/承诺只属于本助理」
     - 去重后 append 到 sidecar，返回新增条数与全部记录
   - `GET /api/memora-bigfive/records?personaId=...`（可选，也可以只靠 extract 返回）
3. 客户端在详情页挂载时 `fetch('api/memora-bigfive/records?personaId=...')`，把结果存在 **组件本地 state**，不要写回 config。
4. 「记忆萃取」按钮改成可点：busy 态 → 调 extract → 成功后刷新本地列表并提示「新增 N 条」；没有可萃取内容时提示「暂无可萃取的对话」。
5. 偏好全局：如果以后要多助理共享，另存 `~/.memora/bigfive-preferences.jsonl`；读取时和本人格事件/承诺合并。v1 也可以先存在本人格，UI 标「全局通」，下一版再做真正的跨人格读取。

**验收**：

- 造 3 条 fixture（偏好 / 事件 / 承诺各一），Tab 能显示；领域筛选正确；作用域文案正确。
- 重复萃取不产生重复行。
- 换一个助理看不到别人的事件/承诺。
- 配置 `cordis.patch.yml` 不因读取记录而变大。

### P0-2 · 情绪波动接真实数据

**现在的问题**：情绪记录完全没有数据源；`memora-dsh` 不记录情绪。

**推荐做法（v1）**：

1. 新增 sidecar：`~/.memora/bigfive-<personaId>.emotions.jsonl`
   - 一行一条 `{ at, valence, category, memory }`
   - cap 1000，按 `at` 升序读给图表。
2. 记录时机二选一：
   - **A（更贴字段说明）**：在 `memora-dsh` 的每轮对话结束后做一次轻量情绪判断（规则/小模型/默认模型），append 一条；缺点是改 `memora-dsh`，且每轮多一次模型调用。
   - **B（v1 更快）**：在「记忆萃取」或打开情绪 Tab 时，由 host 批量分析最近 N 轮对话，生成若干条情绪记录并落 sidecar；缺点不是严格「每段互动后自动记录」，但可以先跑通 UI。
   - 推荐先做 **B**，把 A 作为 v2。
3. 新增 host 路由 `POST /api/memora-bigfive/extract-emotions`（或和 memories 合并成一个 `analyze` 路由），返回新增记录。
4. 客户端把记录传给 `EmotionChart`；图表已支持：
   - 折线 + 渐变面积
   - 参考带 `±1.5 / ±2.7 / ±4.0`
   - 正/负/平静图例
   - 点的 `<title>` tooltip：时间 · 类别 · 效价 · 关联记忆
5. 时间筛选：客户端已按 `at` 做 7/30/全部过滤；如果数据量大，再改成 host 参数。

**验收**：

- 8–10 个点能正常画线、参考带、tooltip。
- 神经质高/中/低三个助理的参考带不同。
- 空态 / 时间范围无数据态正确。
- 情绪记录仅本助理可见。

### P0-3 · 「记忆萃取」按钮

- 现在 `disabled`，title 是「等待接入对话记忆系统」。
- 接上 `extract-memories` 后改成可用；增加 `busy` / 成功提示 / 失败提示。
- 不要在没有对话时假装成功；返回 0 条要提示「暂无可萃取的对话」。

### P1 · 收尾项

- **人物摘要提示词**：`index.js` 已改成只输出三段，但当前 DSH 进程可能还是旧 prompt；重启后新生成才生效。现有数据的「核心设定」在 UI 已隐藏。
- **会话页人格卡**：`client.js` 的 `InfoCard` 完整视图仍直接显示 `p.summary`（可能带「核心设定」）；如果要求所有 surface 一致，改成 `summarySegments` 渲染。本轮没动会话卡。
- **简介 20 字副作用**：`putPersonas()` 对**所有** persona 走 `cleanPersona`，会把超长 bio 截成 20。也就是说编辑一个助理 / 删除一个助理，会顺带截断其他助理的原始 bio。若需要保留原始长 bio，改成「只对本次编辑的 persona clipBio」或给 `cleanPersona` 加 `clip: false` 选项。**这是一个已知数据丢失风险，下轮建议先修。**
- **列表标签数量**：列表只显示 3 个显著标签（非「中」优先），详情显示 5 个；如果产品要求列表也显示 5 个，改 `listTags()`。
- **测试 fixture**：可以在本地 `cordis.patch.yml` 的某个 persona 下临时加 `memories` / `emotions` 数组，刷新看 UI；测完删掉。注意：host 必须先重启加载 2.5.0 schema，否则新字段可能被旧 schema 丢掉。

---

## 4. 数据契约（给下轮直接用）

```ts
type MemoryType = '偏好' | '事件' | '承诺'
type MemoryDomain = '工作' | '情感' | '生活' | '学习' | '通用'

interface Memory {
  at: number          // 毫秒时间戳
  type: MemoryType | ''
  domain: MemoryDomain | ''
  content: string
}

interface Emotion {
  at: number          // 毫秒时间戳
  valence: number     // -5 ~ +5
  category: string    // 愉悦 / 焦虑 / 平静 / ...
  memory?: string     // 关联记忆文本，可空
}
```

派生规则：

- `scope = type === '偏好' ? '全局通' : '仅本助理'`
- `bandHalf = 神经质高 ? 4.0 : 神经质中 ? 2.7 : 1.5`
- 标签：`≥70 高 / ≥50 中 / 其余低`，标签字符串 = `level + 维度名`（所以「中 + 外向性」会得到「中外向性」，这是现有规则，不是 bug）

---

## 5. 关键代码位置

### `client.js`

- `DIMENSIONS` / `SCORE_COUNT` / `FACET_INDEX`：90 条行为分
- `tagsFromScores` / `levelOfPercent` / `dimAvg` / `dimPercent`：标签与五维
- `summarySegments`：把 summary 拆成三段（过滤「核心设定」）
- `emotionBandHalf`：参考带
- `isDraft`：按 `hasScoreData` 判断
- `cleanPersona`：写盘前补齐；`memories` / `emotions` 非空才保留；bio 会 `clipBio`
- `DetailPage`：6 Tab、编辑、删除、评分、历史
- `HistorySection`：来源故事历史 / 快照
- `EmotionChart`：情绪折线图
- `InfoCard`：会话页人格卡（本轮未改）
- `SettingsPage`：列表 / 添加 / 详情路由、`newId`、`deletePersona`
- `TABS`：`overview / exp / detail / source / interact / emotion`

### `index.js`

- `DIMENSIONS` / `ITEMS`（与 client 完全同序）
- `personaSchema`：含 `memories` / `emotions`
- `normalizePersona`：读写配置时补齐
- `writePersonas`：只写 scored persona 到 `~/.memora/personas.json`
- `buildPrompt` / `normalizeGenerated`：故事 → 人格卡；summary 三段式
- `registerGenerateRoute`：`connection.fetch.register({ path: '/api/memora-bigfive/generate', methods: ['POST'] })`
- `apply`：注册 preset、生成路由、volatile 同步

### 可复用的路由写法

```js
connection.fetch.register({
  path: '/api/memora-bigfive/records',
  methods: ['GET'],
  async fetch(request) {
    const url = new URL(request.url)
    const personaId = url.searchParams.get('personaId') || ''
    // read sidecar
    return jsonResponse({ ok: true, value: { memories, emotions } })
  },
})
```

（`jsonResponse` 已在 `index.js` 里。）

---

## 6. 已知问题 / 风险

1. **互动记录 / 情绪波动是空态**：不是 bug，是数据源没接；不要用假数据填。
2. **「记忆萃取」disabled**：同上。
3. **配置是 volatile 的**：不要把无限增长的记忆 / 情绪数组写进 `cordis.patch.yml`；用 sidecar JSONL + host 路由。
4. **bio 截断副作用**：见 §3 P1；任何 `putPersonas` 都会重置所有 bio 到 20 字。
5. **host 改动需重启**：schema / prompt / 新路由都是 host 侧。
6. **只有已生成（有 scores）的 persona 才有 6 Tab**；草稿只有引导。
7. **列表 3 标签、详情 5 标签**：有意为之，不是数据丢失。
8. **没有自动化测试**：本轮用 headless Chrome + 真实 DSH 页面做了手工回归；下轮如果加 host 路由，建议补 `node --check` + 至少一个 fixture 脚本。

---

## 7. 本轮做过的验证

- `node --check client.js`、`node --check index.js` 通过。
- `package.json` / `locale/*.json` JSON 合法。
- 真实 DSH 页面（headless Chrome + 登录 cookie）回归：
  - 列表 / 添加 / 保存草稿 / 新标记 / 删除
  - 详情头部查看 / 编辑 / 取消
  - 人物概述 / 关键经历 / 评分详情（含维度收起）/ 来源故事
  - 互动记录空态 / 情绪波动空态
- 未做：互动记录 / 情绪波动的真实数据渲染（因为还没有数据源）。

---

## 8. 新会话开场提示（可直接复制）

> 继续 Memora 人格插件项目。先读仓库根目录的 `HANDOFF.md`，再读原型目录的 `字段说明.md` 和 `页面设计规范说明.md`。  
> 当前 `memora-bigfive` 2.5.0 的 UI 已完成，互动记录 / 情绪波动只有空态。  
> 本轮目标：按 `HANDOFF.md` §3 的推荐方案，接 `GET/POST /api/memora-bigfive/*` host 路由 + `~/.memora/bigfive-<personaId>.memories.jsonl` / `.emotions.jsonl` sidecar，打通「记忆萃取」、互动记录和情绪波动；不要重做 UI，不要往配置里塞大数组。  
> 先给方案再动手；改完做 `node --check` 和真实页面回归。

---

## 9. 版本 / 提交说明

- `memora-bigfive` 从 2.4.0 → **2.5.0**
- 本轮改动文件：
  - `memora-bigfive/client.js`
  - `memora-bigfive/index.js`
  - `memora-bigfive/package.json`
  - `memora-bigfive/locale/zh.json`
  - `memora-bigfive/locale/en.json`
  - `HANDOFF.md`（本文件）
  - `README.md`（补版本与交接链接）
- 工作区里还有一个 **未纳入本次提交** 的 `memora-dsh/cordis.patch.yml`（preset 显示名从「Memora · 温柔学姐」改成「温柔学姐」等）。它不是本轮 UI 改动，提交前请确认是否要一起带上。
