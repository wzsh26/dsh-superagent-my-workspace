# Memora · v1 迭代计划（已完成）

> **v1 状态入口。** 新会话做 v2 请只读 [Memora-v2-迭代计划.md](Memora-v2-迭代计划.md)；本文件仅保留 v1 完成记录。
> 更新：2026-10-27 · 阶段：M1–M4 完成并 GUI 验收 · v1 收工

---

## 0. 工作规则（先读，省 token 全靠这一节）

1. 只读本文件 + 当次要改的 1–2 个源文件。**不读** `P0-接口与数据.md` / `P1.0-记忆抽取.md` / WorkBuddy 里 20 份文档（要点已摘录在本文）。
2. 禁止：grep 或解包 `app.asar`、读大文档、`cat` 整份日志、`ls -R` 大目录。
3. 所有命令输出截断：`| tail -5`；测试只报「X/X 通过」；不贴 stdout 原文。
4. **一个里程碑 = 一轮**：改代码 → 跑离线单测 → 回 ≤10 行（改了什么 / 测试数字 / 下一步是否需要你动手）。
5. 不贴 diff、不复述方案、不中途请示。只有「要删你的记忆数据」「要改 profile」才停下来问。
6. 需要重启 DSH / 点 GUI 的步骤**全部攒到 M4**，一次说完。
7. 单测全部离线可跑（`node xxx.test.js`），不依赖 llama-server。只有 M4 的 smoke 需要模型。
8. 数据测试尽量少：M1–M3 只跑单测；eval / verify / soak / 双人格全量回归只在 M4 跑一次。

## 1. 这是什么

DSH 人格插件：两个人格（温柔学姐 `memora-gentle` / 嘴硬损友 `memora-tsundere`）+ 本地 Qwen2.5-3B + 每轮记忆注入。  
目标：跨会话记得住、人格隔离、不编造；全本地、低资源（16GB Mac mini M4）。

## 2. 硬约束（不可突破）

- 不加常驻进程、不加载 embedding 模型、不装 npm 原生依赖（可纯 JS 零依赖）。
- 每轮注入 ≤120 token；不做每轮额外模型调用（抽取走 idle 批量）。
- 每人格记忆上限 5000 条（`MEMORA_MAX_RECORDS`）。

## 3. 项目状态（已完成）

**P0**（已完成并验收）

- 插件壳 + 两预设 + 无工具 guard（llama.cpp 必需，见坑 1）；`llama-server` 随插件自启。
- 记忆：bigram 分词、JSONL、关键词召回、幂等、问句不入库、跨会话同文本去重。
- 注入：`agent/pre-step`(step=1) 先召回后写入 → C 层 user 角色 snapshot；问句/陈述句两套模板（代码分支，不让模型选）。
- 验收（P0 时）：`verify.mjs` 7/7；测试 27+21+9；召回 10/10 + 负样本 5/5；soak 40 轮 p50 585ms / p95 726ms / RSS +21MB / swap 不增。

**P1.0**（已完成并验收）

- `extract.js`：规则抽 0–2 条原子事实（拆句/剥前缀/补主语/≤20 字），规则不确信的批量问 3B。
- 异步：原句先落盘 → 入队 → `agent/status=idle` 触发；agent 变忙立即 abort。
- `memory.replace`：原句原子替换为事实（`facts: []` = 删除），索引重建、原子重写。
- 失败一律保留原句；只有规则确信 0 条（寒暄）才删。
- 验收：`verify.mjs` 8/8；规则 10/10 + 负样本 5/5；ingest+enqueue 1.3ms；真机 smoke 6 条事实、后台约 0.7s。

**M1**（已完成）

- `extract.js` 抽事实时同时产出 `kws`（每条 1–5 个，2–10 字）；`memory.js` 的 `ingest`/`replace` 落盘 `kws`，老记录无 `kws` 走纯 bigram。
- 打分 = `0.6 × 归一 bigram + 0.4 × kws 命中率`；同义词表补到 8 组（考试/备考、准备/备考等）。
- 验收：离线单测 160 全绿（memory 40 / index 21 / robust 9 / replace 23 / extract 67）；`memory.eval.js` 18 条（原句 10/10 + 换说法 8/8）、负样本 5/5、单次召回 max 0.24ms。

**M2**（已完成）

- `guard.js`：~50 条风险词（自伤/伤人/极端依赖）+ `想死(?!你|我)` 上下文规则；命中只发【安全】段，跳过召回与落库/抽取。
- 验收：`guard.test.js` 29 项（风险 5/5、日常 10/10、接线安全）；`index.test.js` 21 项原样不改仍绿。

**M3**（已完成）

- `scripts/mem.js`：`list / del / export / import / stats`；`memory.js` 增 `listPersonas/list/reload/remove/exportAll/importAll`。
- 验收：`mem.cli.test.js` 21 项（export→清空→import 一致、del 后不再召回、版本不符退出码 2 且不写盘）。

**M4**（已完成，GUI 部分待用户按 §8 勾）

- 全量：单测 210 项全绿；`memory.eval.js` 18 条（10/10 + 8/8）、隔离 10/10、负样本 5/5；`extract.eval.js` 10/10 + 5/5。
- `verify.mjs` 8/8；`soak.mjs 30` p50 644ms / p95 865ms / max 867ms，swap 69.19MB 不变（沙箱禁 `ps`，RSS 未取）。
- 文档：`P0-接口与数据.md` / `P1.0-记忆抽取.md` 各补 M1–M3 段；`Memora-演示脚本.md` 升 v2（换说法 + CLI + 安全彩排）。

## 4. 代码地图（就这些，别找别的）

```
memora-dsh/
  index.js              # no-tools guard + 安全护栏 + pre-step 注入 + 抽取入队/idle
  memory.js             # 分词 / kws / JSONL / 召回 / replace / 导入导出 / CLI 支撑
  extract.js            # 规则抽取（含 kws）+ 模型兜底 + 空闲队列
  guard.js              # M2 安全护栏（风险词表 + 【安全】段）
  runtime.js            # llama-server 自启监管
  cordis.patch.yml      # 两 preset + 人格 prompt + personaId/extract 配置
  memory.test.js 40     index.test.js 21    memory.robust.test.js 9
  memory.replace.test.js 23                 extract.test.js 67
  guard.test.js 29      mem.cli.test.js 21
  memory.eval.js        # 召回评测 18 条、负样本 5/5
  extract.eval.js       # 抽取评测 10/10、负样本 5/5
  scripts/{verify,soak,extract-smoke}.mjs · scripts/mem.js
../p0-fixtures.json  ../p1-extract-fixtures.json
~/.memora/memora-<persona>.jsonl   # 记忆数据
```

运行形态：`llama-server` @ `127.0.0.1:8080/v1`，别名 `qwen2.5-3b-instruct`；预设**只能在新建会话时选**。

---

## 5. 剩余里程碑

### M1 · 关键词增强召回（替代向量召回）

**问题**：bigram 只能同词匹配，"考试准备得怎么样" 召回不到 "备考雅思"。

**做法**（零依赖、零内存）：

- `extract.js` 抽事实时同时产出 `kws`：3–5 个关键词（名词/动词性，≤10 字，去助词）。
- `memory.js`：`ingest`/`replace` 存 `kws`；打分 = `0.6 × bigram 分 + 0.4 × kws 命中率`；老记录无 `kws` 走纯 bigram（向后兼容）。
- 同义词表可顺手补 3–5 组（考试/备考、工作/上班）。

**验收**：单测全绿 + 新增 ≥8 条 `kws` 用例；`memory.eval.js` 扩到 18 条，换说法命中 ≥6/8；单次 recall <2ms。

**禁止**：引入 ONNX / fastembed / Python；动 C 层模板。

### M2 · 安全护栏

**做法**：`guard.js` —— ~40 个风险词（自伤/伤人/极端依赖）。命中时不发 `【本轮记忆】`，改发 `【安全】` 段（先稳情绪、给求助资源），优先级高于一切记忆注入。

**验收**：表驱动单测 —— 5 条风险句 100% 触发，10 条日常句 0 误伤；无风险路径行为不变（`index.test.js` 原有用例不改仍绿）。

**禁止**：接模型分类器；改人格 prompt 的既有条款。

### M3 · 记忆 CLI（替代 UI）

**做法**：`scripts/mem.js` —— `list <persona>` / `del <persona> <n>` / `export` / `import` / `stats`，读写 `~/.memora`，零依赖，导出为单 JSON（含版本号）。

**验收**：导出 → 清空 → 导入 → `stats` 一致；`del` 后该条不再被召回（单测用临时 `MEMORA_HOME`）；导入版本不符时拒绝并提示。

**禁止**：做客户端 UI 插件、碰 `conversation.view`。

### M4 · 收尾：回归 + 演示

- 跑全量：本地单测 + `verify.mjs` + `memory.eval.js` + `extract.eval.js` + `soak.mjs 30`，出 10 行结论。
- 文档：给 `P0-接口与数据.md` / `P1.0-记忆抽取.md` 各补一段 M1–M3 变更；校准 `Memora-演示脚本.md`。
- 输出 §8 的 GUI 验收清单（唯一需要用户动手的地方）。

**验收**：§8 全部勾完。

---

## 6. 砍掉的东西（已决策，别再讨论）

| 项               | 处理            | 理由                              |
| --------------- | ------------- | ------------------------------- |
| P1.1/P1.2 向量召回  | 砍，由 M1 替代     | +0.1–0.3GB 常驻 + 新依赖；关键词增强已能覆盖演示 |
| P1.3 L3 语气签名    | 砍             | persona prompt 已在做，参数化只是重排      |
| P1.4 关系状态机      | 砍             | 演示用 prompt 兜底，状态机是纯增量           |
| P1.5 主动回忆       | 砍             | 每 N 轮 +token，且有编造风险             |
| P1.6 记忆管理 UI    | 砍，由 M3 CLI 替代 | 客户端插件要 GUI 调试，token 最贵          |
| P2.1 ALMA 情绪动力学 | 砍             | 需生成后回写，每轮多一次模型/解析               |
| P2.2 备份/恢复      | 并入 M3         | 就是 export/import                |
| P2.3 多模态        | 砍             | 不在 v1 范围                        |

被判"砍"的项若日后确实需要，单独立项，不要在里程碑里顺手加。

## 7. 常用命令

```bash
cd memora-dsh
node memory.test.js && node index.test.js && node memory.robust.test.js \
  && node memory.replace.test.js && node extract.test.js \
  && node guard.test.js && node mem.cli.test.js                   # 离线单测 210 项，约 3s
node memory.eval.js                       # 召回 18 条 + 负样本 5
node extract.eval.js                      # 抽取 10 条 + 负样本 5
node scripts/verify.mjs | tail -12        # 一键验收（8 项，需 llama-server）
node scripts/soak.mjs 30 | tail -6        # 压测
node scripts/extract-smoke.mjs            # 真机抽取链路
node scripts/mem.js stats                 # 记忆 CLI（M3）
```

重启 DSH（**改了任何插件 js 都要重载**；`cordis.patch.yml` 改预设同样要重启）：

```bash
osascript -e 'tell application "DeepSeek Harness" to quit'; sleep 6
pkill -f "MacOS/DeepSeek"; pkill -f llama-server; sleep 2
open -a "DeepSeek Harness"
```

## 8. 收尾时才做的 GUI 验收（M4 一次性）

1. 重启后检查 `~/.dsh/profiles/desktop/package.json` 里仍有 `memora-dsh`、`cordis.patch.yml` 里仍有 `local-llama` 路由（丢了两处都从 `.bak-*` 恢复）。
2. 新建会话 → 选 `memora-gentle` → 说 3 件事（含一条带细节的，如"猫叫豆豆，今年三岁"）。
3. 新会话同人格 → 问其中一件 → 应准确召回、不编造。
4. 新会话选 `memora-tsundere` → 问同一件 → 应说"这对我还是新的，你再跟我说说？"（隔离）。
5. 无记忆的新会话问过去的事 → 只回那一句，不反问。
6. `node scripts/mem.js list gentle_senior` → 新会话写入的事实末尾带 `[关键词]`（M1 前的老记录没有，属正常）。

## 9. 踩过的坑（别再踩）

1. **llama.cpp 拒绝 `tools` + `stream`**（500）→ `system-prompt/assemble` 里把 `tools` 置空。
2. **C 层必须 user 角色**：`source:{kind:'memora', form:'snapshot', sections:[{name,text}]}`；system 角色走不通。
3. **每轮必发信号**，无命中也要发"无相关记忆"；跳过就开编。
4. **append-only，不删旧 C** —— 保 prefix cache，靠 compaction 兜底。
5. **问句不入库**（`？/?/吗/呢` 结尾）。
6. **无命中分两支**：问过去 → "只回：这对我还是新的…"；说新事 → 正常回应。判定放代码，别让模型选。
7. **重启可能重置 profile**（版本升级时），见 §8.1。
8. **预设只能空白会话切**，非空报 `agent-preset/locked`。
9. **抽取只在 idle 跑**：单槽模型，生成期间发请求互相等。
10. **规则抽完要补主语**：`猫叫豆豆` + `今年三岁` → `猫今年三岁`。
11. **`memory.replace` 是整文件原子重写**，只在 idle 调。
12. **模型失败/返回 0 条一律保留原句**；只有规则确信 0 条才删。
13. **kws 是加分项，不是独立通道**：候选仍靠 bigram 倒排，所以查询关键词的 bigram 必须并进检索，否则换说法召回不到。
14. **安全护栏命中必须跳过 ingest/抽取**，否则危机原话会落库，日后被召回注入。
15. **CLI 改文件后插件内存缓存不刷新**：`import` / `del` 后要重启 DSH（或等插件重载）。
16. **导入先校验后写盘**：版本/结构不对时一条都不写，避免半套数据。
