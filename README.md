# Memora

本地人格会话插件（DeepSeek Harness bundle）：两个人格 + 本地大五人格档案 + 每轮记忆注入。全本地、低资源、零原生依赖，使用本地 llama.cpp 模型。

## 组件

| 包 | 版本 | 职责 |
| --- | --- | --- |
| [`memora-dsh`](./memora-dsh) | 1.5.0 | 主插件：人格 preset、每轮记忆召回/注入、异步事实抽取、安全护栏、大五评分 |
| [`memora-bigfive`](./memora-bigfive) | 1.9.1 | 大五人格档案 UI：人格列表 → 详情页（Big Two + 5 维 × 3 facet），会话页只读信息卡 |

## 特性

- **两个人格 preset**：`Memora · 温柔学姐`（memora-gentle）与 `Memora · 嘴硬心软损友`（memora-tsundere）
- **大五人格（OCEAN）**：神经质 / 外倾性 / 开放性 / 宜人性 / 尽责性，0–100 五维可调，缺省补中性 50
- **每轮记忆注入**：JSONL 倒排索引 + 中文 bigram 关键词召回；问句不入库、跨会话同文本去重；每轮注入硬预算 ≤ 400 字符（≈ 120 token）
- **异步事实抽取**：规则优先、本地 3B 模型兜底；抽 0–2 条原子事实，绝不阻塞对话、不在生成期间抢占 llama-server；失败一律保留原句
- **安全护栏**：命中自伤 / 伤人 / 极端依赖 → 只发【安全】段，跳过记忆召回与落库
- **硬约束**：无常驻进程、无 embedding 模型、无 npm 原生依赖（纯 JS 零依赖）；每人格记忆上限 5000 条

## 安装

作为 DSH bundle 使用。把两个包以本地路径 link 进目标 profile，并把 `memora-dsh` 加入该 profile 的 bundles（`memora-bigfive` 由 `memora-dsh` 的 cordis 层自动挂载）：

```sh
dsh plugin --profile <profile> add "link:$PWD/memora-dsh"
dsh plugin --profile <profile> add "link:$PWD/memora-bigfive"
```

装好后在预设选择里会多出 `Memora · 温柔学姐` / `Memora · 嘴硬心软损友` 两个 preset；输入框上方会出现大五人格滑块面板（由 memora-bigfive 提供）。

### 依赖

- DeepSeek Harness 0.2.x、Node 22+
- 本地 [llama.cpp](https://github.com/ggml-org/llama.cpp)（llama-server 随插件自启；本项目用 Qwen2.5-3B）

## 数据落在哪

- **大五档案**：`~/.memora/bigfive.json`（memora-bigfive 滑块写入，下一轮生效）
- **记忆**：JSONL，可用 `memora-dsh/scripts/mem.js` 管理：`list` / `del` / `export` / `import` / `stats`

## 文档

- [Memora-迭代计划.md](./Memora-迭代计划.md) — v1（M1–M4）完成记录与工作规则
- [Memora-v2-迭代计划.md](./Memora-v2-迭代计划.md) — v2 迭代计划
- [P0-接口与数据.md](./P0-接口与数据.md) / [P1.0-记忆抽取.md](./P1.0-记忆抽取.md) — 设计文档
- [Memora-演示脚本.md](./Memora-演示脚本.md) — 演示 / 验收脚本

## 许可

暂未指定开源协议。公开此仓库前请自行确认是否补充 LICENSE。
