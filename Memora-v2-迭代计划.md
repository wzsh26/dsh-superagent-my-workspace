# Memora v2 · 人格连续性迭代计划（新会话执行入口）

> **新会话只读这一份 + 当轮要改的 1–3 个源文件。** 读完从 §4 的第一个未完成里程碑开工。
> 更新：2026-10-27 · 状态：P3 完成，下一步 P4 · 预计 6 个里程碑（P5 可选）
> 目标：三个月后还是同一个人——细节记得住、纠错能改、语气随关系/情绪变、会遗忘、不编造。
> v1（M1–M4）已完成并验收，基线见 §1.3；本计划只做增量，不推翻 v1。

---

## 0. 执行规则（省 token 全靠这一节）

1. **一轮一个里程碑**：改代码 → 只做 §4 规定的自检 → 回 ≤8 行摘要。**中间不汇报、不确认、不贴日志/diff、不复述方案。**
2. 只有三种情况停下来问：**要删/迁移用户真实记忆**、**要改 profile/预设**、**需要点 GUI**。其余一律按本文件决策执行。
3. 只读：本文件 + 当轮白名单文件（§3）。**不读**旧计划/P0/P1.0/演示脚本/WorkBuddy 文档；**不 grep/解包 asar**；**不 cat 日志**；**不 `ls -R`**。
4. 命令输出一律 `| tail -5`；只看失败项，不贴 stdout 原文。
5. **数据测试尽可能少**：里程碑内只允许 `node --check` + §4 写明的“≤3 条断言”内联自检。**不跑** `memory.eval` / `verify` / `soak` / e2e / 真实 `~/.memora` 数据；这些全部攒到 §5 一次跑。
6. 只改 §3 白名单里的文件；不加依赖、不加常驻进程、不做每轮模型调用、不动 `runtime.js`。
7. 用户真实记忆只做**增量字段**，不删除、不重排旧行；任何 destructive 操作先备份并停下问。
8. GUI 只介入一次：全部 P0–P4 完成后，按 §5 让用户重启 + 点清单。中间不要要求用户点任何界面。

---

## 1. 目标与验收

### 1.1 “更像人”拆成四件事

| 维度 | 表现 | 最终验收线 |
|---|---|---|
| 连续性 | 记得细节，不只记得梗概 | 细节召回 ≥8/10 |
| 一致性 | 三个月后还是同一个人；被纠正后不再犯 | 纠错生效 ≥9/10；90 天模拟人格漂移有界 |
| 回应性 | 情绪/关系影响语气，但不忽冷忽热 | 规则状态机单测全绿；e2e 语气题 ≥6/8 |
| 克制 | 会遗忘、不翻旧账、不主动提不该提的 | 旧细节默认不注入；主动回忆 0 编造 |

### 1.2 理论映射（只借结构）

| 理论 | 实现 | 不做 |
|---|---|---|
| 皮层表征 | gist 事实（慢痕迹）+ episode 原句细节（快痕迹） | 不建向量库、不跑 VAE/CLIP |
| 海马索引 | 同会话/时间邻近/共享 kws 的共现绑定图，召回时 1 跳激活 | 不训练稀疏吸引子网络 |
| MTT | 一条 event 双写：gist 慢衰减（30 天）+ episode 快衰减（7–14 天，可复述强化） | 不做多模态 |
| 睡眠重激活 | 复用 idle：去重合并、episode→gist 提炼、未用细节降权/归档 | 不加定时进程 |
| 再巩固 | 纠错规则 → 旧事实标 `superseded`，新事实正常入库 | 不用模型判断对错 |
| ALMA | 三时标状态：瞬时情绪（回合）→ 心情（6h 半衰）→ 底色（固定/月级） | 不写 OCC 全套方程 |
| CAPS / P-GEM κ | if-then 写进静态 prompt + 规则选语气提示 | 不做逐轮模型分类 |
| TESSERA | `persona-state.json` 有界慢漂移 + 每 30 轮快照 | 不用 LLM 演化人格 |
| 依恋 | 每个人格固定底色，只影响措辞 | 不做关系状态机全集 |

### 1.3 v1 基线（不要回退）

单测 210 项全绿；`memory.eval` 18/18（原句 10/10、换说法 8/8）、隔离 10/10、负样本 5/5；`extract.eval` 10/10 + 5/5；`verify` 8/8；`soak 30` p95 865ms、swap 不增。

### 1.4 非目标（别顺手做）

向量/embedding、客户端 UI、多模态、完整 ALMA/TESSERA、每轮模型调用、独立常驻服务。理由见 §6。

---

## 2. 架构（已定，不再讨论）

### 2.1 存储：gist 与 episode 分文件

```
~/.memora/memora-<persona>.jsonl            # gist（v1 原文件，旧行无 kind = gist）
~/.memora/memora-<persona>.episodes.jsonl   # 细节原句（新文件，老代码完全忽略）
~/.memora/memora-<persona>.state.json       # 情绪/关系状态（P3）
```

- **gist 行**：v1 字段 + 可选 `kind:'gist'`、`source_episode_ids:[id]`、`salience`、`recall_count`、`last_recalled_at`、`superseded_by`。
- **episode 行**：`{id, session_id, text, created_at, kws, salience, recall_count, promoted, archived}`。
- **兼容**：无 `kind` 按 gist 处理；导出仍为单 JSON，版本升 2，`import` 必须继续接受 v1。
- **上限**：gist 沿用 `MEMORA_MAX_RECORDS=5000`；episode 新增 `MEMORA_MAX_EPISODES=3000`。
- **迁移**：不做批量迁移。新写入才双写；旧数据保持原样。

### 2.2 海马绑定图（内存态，不落盘）

- 载入时按 `session_id` 分组，按时间排序；相邻两条若间隔 ≤30 分钟或共享 ≥2 个 kws 则建边。
- 边权 `1 + 0.5 × 共享 kws 数`；每个节点最多 8 个邻居。
- 映射：episode → 它提炼出的 gist（`source_episode_ids` 反向表）。
- 5k gist + 3k episode 重建 <50ms；图只在内存。

### 2.3 召回 v2

1. gist 候选：沿用 M1 打分（0.6 bigram + 0.4 kws + 时间衰减）。
2. 1 跳扩展：经绑定图带入 co-activated gist（加分 `0.15 × 边权`，只补候选，不改主排序）。
3. 细节门控（代码判定，不让模型选）：
   - 查询命中 `/细节|具体|当时|原话|怎么(来|认识|回事)|为什么|后来|然后呢/`，或
   - 查询与某 episode 的 kws 命中 ≥2 且 gist 最高分 <0.25。
4. 输出：top3 gist + **至多 1 条** episode（截 60 字）。
5. `recall_count`/`last_recalled_at` 只改内存，idle 巩固时统一落盘。

### 2.4 注入格式与预算（硬顶 ≤400 字符 ≈120 token）

```
【关系】熟悉度 62 · 信任 48 · 情绪：低落（先共情，不接梗）
【本轮记忆】
- 2026-10-20：猫叫豆豆
- 2026-10-20（细节）：豆豆是领养的橘猫，刚来时才两个月
（问过去时用事实回答；细节只在用户问细节时用；不要补充没写的。）
```

- `【安全】` 仅风险轮，且**不叠加**关系/记忆。
- 无命中模板、问句/陈述句分支保持 v1 行为；关系行 ≤25 token；细节 ≤60 字；总长 `MAX_C_CHARS=400` 断言。

### 2.5 巩固 / 再巩固（全规则、零模型）

- **批量替换**：一个 idle 批次按人格分组，每组一次原子重写（替换现有逐条 `replace` 的多次全文件重写）。
- **去重合并**：仅合并“归一化文本完全相同”的 gist（去标点/空白）；保留最新 `created_at`，合并 kws / source_episode_ids / recall_count。
- **提炼**：episode `recall_count ≥ 2` 且未 `promoted` → 用 `extractRules` 生成 gist，挂 source_episode_ids。
- **衰减/归档**：每次巩固 `salience ×= 0.98`；episode 超 90 天且 salience <0.3 → `archived:true`（不删文件、不进索引）。
- **纠错**：命中 `/记错了|你记错|我没说过|不是[^。！？]{0,20}是/` → 把本会话最近注入的 gist 标 `superseded_by`（不删）；`不是…是…` 把“不是”剥掉后再走正常 ingest。
- 巩固只在 idle 且 `dirty` 时跑一次；单次上限 200ms，超时下次继续。

### 2.6 情绪/关系状态（P3）

`persona-state.json`：

```json
{"version":1,"attachment":"secure","familiarity":20,"trust":30,
 "mood":{"valence":0,"arousal":0.4,"updated_at":"..."},
 "traits":{"neuroticism":25,"extraversion":40,"openness":60,"agreeableness":80,"conscientiousness":78},
 "proactive_off_until":null,"snapshots":[]}
```

- 人格底色采用**大五（五因子模型 / OCEAN）**：`neuroticism`（神经质）、`extraversion`（外倾性）、`openness`（开放性）、`agreeableness`（宜人性）、`conscientiousness`（尽责性），五维 0–100 均可调；preset 通过 `config.traits` 指定，缺省补中性 50。
- 每轮规则更新：褒/贬词表各 ≤20 条；`valence` 单轮 ±0.2 封顶；`trust` 单日 ±1；`familiarity` 单日 +2 封顶；风险轮冻结。
- 载入时按小时对 `mood` 做 6h 半衰回基线（`valence→0`、`arousal→0.3`）。
- `traits` 月级漂移 ≤2（正性→更外倾/宜人/少神经质；负性→更神经质）；每 30 轮存快照（最多 12 个，覆盖最旧）。
- 只影响 `【关系】` 提示与语气模板，**不影响召回选择、不影响安全护栏**。

---

## 3. 代码地图与白名单（只改这些）

```
memora-dsh/
  memory.js          # gist 存储/召回/打分/replaceBatch/导出导入（v2 字段）
  episode.js         # 新增：episode 存储、绑定图、细节门控、巩固
  persona.js         # 新增：情绪/关系状态机、TESSERA-lite、语气提示
  extract.js         # 队列：先写 episode 再 replace；批量替换
  index.js           # 接线顺序：安全 → 关系/情绪 → 召回 → 注入 → ingest/纠错
  guard.js           # 安全护栏（不改逻辑，只保证优先级）
  cordis.patch.yml   # 静态 CAPS if-then 段落（P3）
  scripts/mem.js     # list/state/export/import（v2）、doctor（P4）
  scripts/eval-e2e.mjs  # 新增：端到端评测（P0 写，§5 才跑）
  episode.test.js / persona.test.js  # 新增：纯函数单测（写，§5 才跑）
  memory.test.js / extract.test.js   # 只在必要时补 ≤5 条
```

数据文件见 §2.1。**不改** `runtime.js`、`scripts/verify.mjs`、`scripts/soak.mjs`、已有 fixtures 之外的东西。

---

## 4. 里程碑

> 每个里程碑结束只回 ≤8 行。自检命令之外的测试一律不跑。

### P0 · 地基：schema + 分段注入 + e2e 骨架（1 轮）

**做**
- `memory.js` 写入 gist 时补 `kind:'gist'`；读旧行按 gist；`replace` 接受 `episodeIds` 写入 `source_episode_ids`。
- `index.js` 的 `composeC` 改成分段拼装（关系行可空、记忆、细节），**v1 无细节时输出与现在逐字一致**；加 `MAX_C_CHARS` 断言函数。
- 新增 `scripts/eval-e2e.mjs`：读 10 条事实 → 用 `composeC` 拼 C → 调 llama-server → 规则判分（20 题）。**只写不跑**；用假 fetch 做 1 条结构断言。

**自检**：`node --check` 三个改动文件；`composeC` 三条断言（无命中模板不变 / 有命中 ≤400 字符 / 关系行可省略）。
**不要**：动打分公式、动抽取规则、跑模型。

### P1 · 双痕迹 + 海马索引（2 轮）

**做**
- `episode.js`：追加/载入 episode；`kws` 用 `extractKeywords`；绑定图按 §2.2 重建；`pickDetails(query, gistCandidates)` 按 §2.3 门控。
- `extract.js`：idle 抽取时**先把原句写成 episode**，再 `replace` 原句为 gist；gist 挂 `source_episode_ids`。
- `memory.js`：`recall` 返回 `{memories, details}`；`details` 至多 1 条，带 `date/text`。
- `index.js`：`composeC` 注入细节段。
- `episode.test.js`：写 8–10 条纯函数用例（绑定、门控、归档），**不跑**。

**自检**：`node --check`；内联 3 断言（append 后 load 条数、同会话建边、细节门控命中/不命中各一）。
**不要**：改 M1 打分权重；不要为了细节把 gist 全量注入。

### P2 · 批量替换 + 巩固 + 再巩固（2 轮）

**做**
- `memory.replaceBatch(items)`：按人格一次原子重写；旧 `replace` 保留给 CLI/单测。
- `extract.js` 队列改为收集后批量替换；失败仍保留原句。
- `episode.js` 增 `consolidate(persona)`：去重合并、episode→gist、衰减、归档、episode 上限滚动。
- `index.js` 增 `detectCorrection(text)`（规则见 §2.5）；纠错目标取本会话最近注入的 gist id（内存 Map）。
- `scripts/mem.js`：`list` 显示 gist/episode 类型；`del` 仍按 list 序号。

**自检**：`node --check`；内联 3 断言（两条同文本合并、episode 复述 2 次提炼、superseded 不再进 recall）。
**不要**：无差别合并不同值的事实；不要在对话路径调用 consolidate；不要自动删除任何行。

### P3 · 情绪/关系 + CAPS 语气（1–2 轮）

**做**
- `persona.js`：状态载入/保存；每轮 `observe({text, risk, correction})`；`toneHint()`；6h 心情半衰；日/月封顶；快照。
- `index.js`：安全 → `persona.observe` → 召回 → `composeC` 带关系行；风险轮冻结状态且只发【安全】。
- `cordis.patch.yml`：每个 preset 加 5 条静态 if-then（≤80 token），描述“被夸/被批评/用户低落/用户玩笑/被纠正”时的姿态。
- `persona.test.js`：fake clock 用例（衰减、封顶、褒贬、快照），**不跑**。

**自检**：`node --check`；内联 3 断言（褒→valence 上升、6h 后回落、单日 familiarity 不超 +2）。
**不要**：让情绪改变召回排序或安全判定；不要每轮写盘（每 5 轮或 idle 写一次）。

### P4 · 长期人格 + CLI/doctor + 文档（1–2 轮）

**做**
- `persona.js`：TESSERA-lite（traits 月漂移 ≤2、快照上限 12）；`mem.js state <persona>` 输出可读状态。
- `scripts/mem.js`：`stats --json`、`state`、`doctor`（check profile/preset/模型健康/数据目录/备份）、export/import v2（含 episodes + state，import 兼容 v1）。
- 文档：只读 `P0-接口与数据.md` / `P1.0-记忆抽取.md` 末尾 20 行，各补一段 “v2 变更”；`Memora-演示脚本.md` 升 v3。
- 更新本文件 §7 状态表。

**自检**：`node --check`；内联 2 断言（export→import 计数一致、doctor 缺 profile 时返回非 0）。
**不要**：改旧数据格式；不要删 `.episodes` 之外的任何文件。

### P5 · 克制的主动回忆（可选，默认关闭）

**做**
- 仅会话首轮、且用户消息是问候（`你好/在吗/早/晚安/我回来了/好久不见`）时；环境变量 `MEMORA_PROACTIVE=1` 才启用。
- 选 1 条 `recall_count ≥ 2`、`salience` 高、>24h 未被注入的 gist；风险轮跳过；用户表示不喜（“别翻旧账/不用提”）→ `proactive_off_until=+7d`。
- 注入一行 `【主动】`，总长仍 ≤400 字符。

**自检**：`node --check`；内联 2 断言（默认关闭不注入、开启且命中时只 1 条）。
**不做**：默认开启、每轮主动、模型生成开场白。

---

## 5. 最终验收（全部里程碑完成后，一次；唯一 GUI 介入点）

### 5.1 Agent 本地一次性跑（按顺序，失败即停并报哪项）

```bash
cd memora-dsh
node --check memory.js && node --check episode.js && node --check persona.js && node --check index.js
node memory.test.js && node index.test.js && node memory.robust.test.js \
  && node memory.replace.test.js && node extract.test.js && node guard.test.js \
  && node mem.cli.test.js && node episode.test.js && node persona.test.js   # 一次全绿
node memory.eval.js          # 18/18、隔离 10/10、负样本 5/5 不回退
node extract.eval.js         # 10/10 + 5/5 不回退
node scripts/eval-e2e.mjs    # ≥16/20；细节题 ≥8/10；纠错 ≥9/10
node scripts/verify.mjs      # 8/8
node scripts/soak.mjs 30     # p95 <1000ms、swap 不增
node scripts/mem.js doctor   # 全绿
```

汇总成 ≤10 行结论（数字 + 失败项），不贴日志。

### 5.2 用户动手（Agent 先备份，再让用户执行）

```bash
node scripts/mem.js export ~/memora-backup-v1-$(date +%F).json
osascript -e 'tell application "DeepSeek Harness" to quit'; sleep 6
pkill -f "MacOS/DeepSeek"; pkill -f llama-server; sleep 2
open -a "DeepSeek Harness"
```

重启后 GUI 清单（用户逐条回“过/不过”）：

1. profile 里仍有 `memora-dsh`、`cordis.patch.yml` 仍有 `local-llama`；丢了从 `.bak-*` 恢复。
2. 新建 `memora-gentle`：说“我家猫叫豆豆，今年三岁，是领养的橘猫”。
3. 新会话问“豆豆怎么来的” → 应说出“领养”（细节召回）。
4. 同一会话纠正“不是，豆豆是朋友送的” → 应接受；再问“豆豆怎么来的” → 不再说“领养”。
5. 新会话问“我考试准备得怎么样”（先种过雅思事实）→ 说出备考/雅思（换说法）。
6. 新建 `memora-tsundere` 问“我家猫叫什么” → 只说“这对我还是新的…”（隔离）。
7. 全新会话问“我之前说过我喜欢爬山吗” → 只回模板，不编、不追问。
8. `node scripts/mem.js state gentle_senior` 与 `list gentle_senior` 能看到状态与 `[关键词]`。

全部通过后，本文件标“已完成”，v2 收工。

---

## 6. 已决策（别再讨论）

| 项 | 决定 | 一句话理由 |
|---|---|---|
| 向量库 / embedding | 不做 | 常驻 +0.1–0.3GB、新依赖，演示与细节召回用图+关键词够 |
| 稀疏吸引子网络 | 不做，用共现图近似 | 训练与调参成本远超收益，5k 规模图足够 |
| 每轮模型调用 | 不做 | 单槽 3B，和用户生成抢队列，延迟翻倍 |
| 客户端 UI | 不做，CLI 替代 | GUI 调试 token 最贵，`mem.js` 已够 |
| 完整 ALMA/TESSERA | 不做，三时标 + 有界漂移 | 逐轮推断违反零调用；规则更可控、可测、不会人格突变 |
| 主动回忆 | 默认关闭，P5 可选 | 省 token、防编造；要有明确开关和退避 |
| episodes 独立文件 | 是 | 老代码天然忽略，回滚只删新文件 |
| 细节注入上限 | 1 条 / 60 字 | 防刷屏、防 token 超 |
| 纠错只标不删 | 是 | 保留审计；删除走 CLI 且二次确认 |

---

## 7. 状态表（每完成一个里程碑改一行）

| 里程碑 | 状态 | 完成日期 |
|---|---|---|
| P0 地基 | 已完成 | 2026-10-27 |
| P1 双痕迹+索引 | 已完成 | 2026-10-27 |
| P2 巩固+纠错 | 已完成 | 2026-10-27 |
| P3 情绪/关系 | 已完成 | 2026-10-27 |
| P4 长期人格+CLI | 未开始 | |
| P5 主动回忆（可选） | 未开始 | |

---

## 8. 风险与回滚

- **episode 写失败**：不影响 gist/对话；下一轮重试，原句仍按 v1 保留。
- **巩固误合并**：只合并归一化文本完全相同者；不同值不合并。发现异常先停巩固开关（`MEMORA_CONSOLIDATE=0`）。
- **纠错误判**：只标 `superseded`，不改写原文；用户可用 `mem.js list/del` 检查。
- **情绪失控**：所有 delta 有上下限、6h 半衰、风险轮冻结；异常时删 `.state.json` 即回默认。
- **回滚 v2**：保留 gist 文件不动，删除 `.episodes.jsonl` / `.state.json`，代码回退 v1 tag；导出的 v2 JSON 仍可被 v1 导入（忽略新字段）。
- **最终验收前必须备份**：`mem.js export`，失败不重启。

---

## 9. 每轮摘要模板（≤8 行）

```
P<N> 完成：<改了什么，1–2 句>
自检：node --check 通过；断言 3/3
下一步：P<N+1>
需用户动手：无 / <仅最后重启时>
```
