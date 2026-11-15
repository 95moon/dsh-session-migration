# DSH Session Migration · 技术文档（导出侧实现）

> 上游：`Nwflower/dsh-chat-import`（MIT）· 本文档描述本仓库（`95moon/dsh-session-migration`）在导出方向上的改造
> 基线：上游 `v0.26.7` 的完整源码树 + 本改造
> 适用：DSH 0.2.2 桌面端（`dsh` runtime 0.2.2-rc.3）· Node 24.21.0

---

## 0. 一句话概括

上游插件解决的是「**把别人的聊天记录导进 DSH 继续聊**」；这次改造补齐了反方向，并且把反方向做成了
**可续聊的迁移**而不只是「导出个文件」：

- 新增**导出面板**（第三个子页）、`/export` 命令、四个 HTTP 路由，让导出能在 GUI 里点、也能让 agent 调；
- 新增 **Codex 原生装库**：不只是写一份 rollout 文件，而是直接写进 Codex 自己的会话库，打开 Codex 就能看到；
- 新增 **交接包（handoff package）**：导出时自动生成「交接书」，把完整历史归档到项目里，只把「交接书 + 最近对话」放进目标窗口——这是解决**导出后上下文爆窗口 / 前面的对话凭空消失**的核心；
- 入口改名「**会话迁移**」，会话列表改成**按来源工具分组**的层级；
- 工具名归一化 + 超大输出截断，修掉目标宿主直接拒收整份历史的 `Invalid 'input[N].name'` 报错。

---

## 1. 改造总览

| 能力 | 上游 0.26.7 | 本改造 |
|---|---|---|
| 导入 25+ 种 Agent 记录（含工具调用/推理） | ✅ | 保留不动 |
| `export_chat` 工具（claude / codex / kimi / opencode / bundle / markdown） | ✅ | ✅ 增强（交接包、名字归一化、输出截断） |
| 导出的 **HTTP 路由**（面板数据源） | ❌ | ✅ 新增 `lib/session-export.mjs` |
| GUI 里的**「导出」子页** | ❌ | ✅ 新增（第三个 tab） |
| `/export` 斜杠命令 | ❌ | ✅ 新增 |
| **Codex 原生装库**（写 `state_5.sqlite` + 规范 rollout） | ❌ | ✅ 新增 `lib/codex-native.mjs` / `lib/codex-export.mjs` |
| **交接包**（交接书 + 完整档案 + 迁移副本） | ❌ | ✅ 新增 `lib/session-handoff.mjs` |
| 入口命名 / 会话列表分组 | 单级「导入会话」 | 「会话迁移」+ 按工具两级分组 |
| 迁移副本的上下文预算 | 无（导出多大就多大） | ✅ 软目标 5% / 硬上限 20% 双闸 |

> 注意：上游 `lib/export-tool.mjs`、`lib/export/*.mjs`、`lib/tools/export-tools.mjs` **本来就存在**——上游的导出是「工具面」（agent 调 `export_chat`）。
> 本次新增的是**面板面**（路由 + UI）、**Codex 原生面**和**交接包**。

---

## 2. 运行环境与两条生效规则

插件装在 DSH profile 下，不是开发目录：

```
<DSH_HOME>\profiles\<profile>\node_modules\dsh-session-migration\
  lib\          运行时代码
  bin\          CLI（只读设计）
  docs\ assets\ 文档与图标
  package.json  name=dsh-session-migration
```

本仓库就是这份代码的源码：`lib/` 下的改动都在这里，客户端部分与 `src/client/` 分片保持同步（`node scripts/build-client.mjs --check` 能验证）。装法见 README——`dsh plugin --profile <profile> add dsh-session-migration`，或直接从本仓库的 GitHub 地址安装。

> 本次改造的**开发过程**是从一份已安装的插件副本开始的（当时本机 `git clone` 走 TLS 报 `schannel SEC_E_NO_CREDENTIALS`、PATH 里也没有 `node`/`pnpm`），所以早期用了一个本地补丁器逐文件改写。改造完成后，改动已全部进入本仓库源码，补丁器与开发期自检脚本**不在本仓库内**（第 8、9 节保留其设计记录，便于理解改动是怎么被验证的）。

### 两条生效规则（改运行中的插件时会用到，很关键）

| 改了什么 | 怎么让它生效 |
|---|---|
| `lib/*.mjs`（宿主侧代码） | `lib` **不热加载**。必须 `plugin_manager set_plugin enabled:false` → `enabled:true`（entry id `include:session-migration`） |
| `lib/client.js`（浏览器侧 bundle） | 直接从磁盘读，**Ctrl+F5 刷新页面**即可 |

> 排查「明明改了却没生效」时，第一件事就是确认有没有重载：活宿主里跑的是进程启动时加载的旧模块。

---

## 3. 架构：三条链路

```
① 导入（上游，未改动）
   面板/import_chat → discovery（多格式探测）→ convert/* → DSH 事件流 → host-session.mjs 建会话

② 导出（本次重点）
   ┌── GUI「导出」tab ──┐
   │  /export 命令      ├─→ POST /api-import/export/run ─┐
   │  export_chat 工具  ┘                                 │
   └──────────────────────────────────────────────────────┘
                          ↓
                  lib/session-export.mjs（路由 + 格式分派 + 默认落点）
                          ↓
        ┌─────────────────┴──────────────────┐
        │                                    │
   lib/export-tool.mjs                lib/codex-export.mjs
   （claude/kimi/opencode/            （Codex 原生：写 state_5.sqlite
     codex/bundle/markdown）            + 生成规范 rollout）
        │                                    │
        └──────────→ lib/export/*.mjs 序列化器 ←──────┘
                          ↑
                  lib/export/common.mjs
              （名字归一化 / 输出截断 / 预算回落）

③ 交接包（贯穿②的横切能力）
   读 DSH 事件 → lib/session-handoff.mjs
        ├─ 写完整档案到 <项目>/.dsh/session-handoff/<session-id>/
        └─ 产出「迁移副本」事件流（交接书 + 最近对话）→ 交给②的序列化器
```

---

## 4. 导出能力的实现

### 4.1 路由层：`lib/session-export.mjs`

给面板和命令提供数据源，全部是 `POST`：

| 路由 | 作用 |
|---|---|
| `/api-import/export/sessions` | 列可导出的 DSH 会话（标题来自投影缓存，**不读日志本体**，几十 MB 的 zstd 日志只用来导出） |
| `/api-import/export/run` | 批量导出：`{ sessionIds, format, outputDir?, path?, cwd?, dryRun? }` |
| `/api-import/export/browse` | 目录浏览（面板里选输出目录） |
| `/api-import/export/codex-status` | 探测 Codex 是否装好（能不能走原生装库） |

- `EXPORT_FORMATS = ['claude','codex','codex-native','kimi','opencode','bundle','markdown']`
- 默认落点 `defaultOutputDir(format)`：`claude` → `~/.claude/projects`；`codex-native` → `<codexHome>/sessions`；其余 → `~/.dsh/exports`
- 上限：`MAX_ROWS 800`、`MAX_BATCH 200`
- 参数校验的中文报错：`没有选中要导出的会话` / `未知导出格式: …` / `导出路径只能用于单个会话（多选请用输出目录）`
- 落盘统一走 `writeExportFile(ctx, path, content, {kind})`：先试 `ctx.fs`，被沙箱拒绝（`file access denied under …`）就回退 `node:fs`，`createIfAbsent` 用 `wx` 标志避免覆盖既有文件

在 `lib/panel.mjs` 的 `registerRoutes(ctx, ws, registryDir)` 里挂上（`createSearchJobs(registryDir)` 之后）。

### 4.2 命令层：`/export`

`lib/command.mjs` 注册 `/export [format] [sessionId] [--out <path>]`：

- 参数缺省时：会话 = 当前会话（`invocation.agent.id`），格式 = `bundle`
- `--out` 的值用扩展名正则判「文件还是目录」（`/\.[A-Za-z0-9]{1,8}$/`）
- 别名表 `EXPORT_ALIAS = { claude, codex, kimi, opencode, bundle, md → markdown }`
- 结束后打印继续方式：claude → `claude --resume <uuid>`；bundle → `restore_bundle { path }`

### 4.3 工具层：`export_chat` 的输出 schema

`lib/tools/export-tools.mjs` 是给模型用的工具面。这里踩了一个**很隐蔽的坑**：

> **工具面输出 schema 会过滤未声明字段。** 新的 `handoff` 摘要不写进 `output.schema`，就永远到不了模型侧，
> 现象是「导出成功但看不到归档信息」。而且 `handoff.keptTurns` 是**轮次号数组**（`[7,8]`）不是数量，
> 声明成 `integer` 会让整个工具调用报
> `returned invalid output: "value.handoff.keptTurns" must be an integer`。

现在的 schema：入参加 `archiveDir`（string）/ `recentTurns`（integer）；输出加 `handoff` 对象
（`archiveDir/archiveRelDir/handoffPath/fileCount/droppedTurns/keptTurns/assistantLimit/copyMaxChars/copyHardMaxChars/withinHardCap/copyChars/fitted/error`，
`keptTurns` 为 `array of integer`），`render` 里把归档信息拼到返回文本尾部。

### 4.4 面板层：第三个子页「导出」

`lib/client.js` 的 `ExportPanel()`：搜索框、含子代理开关、全选/清空、格式 chips、输出目录输入、执行、
逐行结果（✓ 文件路径 + 复制路径按钮 / ✗ 错误）。

结果行是**两层**：第一层「标题 · 装进什么项目 · 警告 + 复制路径」，第二层显示交接信息：
`完整历史已归档：<dir>` / `迁移副本 = 交接书 N 字符 + 最近 K 轮` / `已按目标窗口收紧（工具输出 ≤X、参数 ≤Y）`；
归档失败时第二层变警告色并显示 `完整档案没写成：<error>`。悬停提示里带完整归档路径。

> 实现细节：`useEffect(() => { load() }, [])` **故意不把 `t` 放进依赖数组**——`t` 每次渲染都是新闭包，
> 放进去会变成无限请求循环。

### 4.5 六种格式与落点

| 格式 | 产物 | 默认落点 | 目标宿主怎么用 |
|---|---|---|---|
| `claude` | Claude Code JSONL | `~/.claude/projects/<slug>/<uuid>.jsonl` | Claude Code 里直接可 resume |
| `codex` | Codex rollout JSONL | `~/.dsh/exports` | 复制进 Codex 会话目录，或给别的工具读 |
| `codex-native` | rollout + 写 `state_5.sqlite` | `<codexHome>/sessions` | **打开 Codex 桌面端就能看到这条线程** |
| `kimi` | `wire.jsonl` | `~/.dsh/exports` | Kimi CLI |
| `opencode` | `opencode.json` | `~/.dsh/exports` | `opencode import` |
| `bundle` | 可移植包（双 SHA-256） | `~/.dsh/exports` | `restore_bundle` |
| `markdown` | 单文件 .md（**唯一允许覆盖**） | `~/.dsh/exports` | 阅读/分享 |

`markdown` 用 `{kind:'overwrite'}`（一会话一文件，理应覆盖），其它格式产物名里带 uuid，天然不会撞。

### 4.6 Codex 原生装库（`lib/codex-native.mjs` + `lib/codex-export.mjs`）

这是「导出后**打开 Codex 就能接着聊**」的关键，纯文件复制是做不到的：

1. 找一个**已存在的 Codex 线程**当模板（`readCodexTemplate`）：读 `state_5.sqlite` 里的字段形状 + 一条真实 rollout 的头。
   找不到会明确报：`没找到 Codex 库（…\state_5.sqlite 里没有可参照的线程）；请先打开一次 Codex Desktop`。
2. 生成规范 rollout：`session_meta` / `turn_context` / `event_msg` / `response_item`。
   **桌面端只从 `event_msg/item_completed` 投影消息**，所以 `pushItem()` 同时写 `response_item` 和 `item_completed` 两份。
3. `insertCodexThread()` 往 `state_5.sqlite` 的 `threads` 表插一行（id 是纯 UUID，标题/first_user_message 保持 UTF-8），
   再调 `migrateCodexThread()` 让 Codex 自己迁移 rollouts（返回 `{ok, status, bytesProcessed}`）。
4. 写库前会备份 `state_5.sqlite`。

`task_started` 里写死 `model_context_window: 258400`（`CODEX_CONTEXT_WINDOW`），目标窗口预算全部基于这个数。

---

## 5. 交接包（核心机制）

### 5.1 起因：一份「刚好超窗口」的导出

真实会话 `session-9e733630`（1154 事件 / 8 个真实轮次 / 175 次工具调用 / 4 张截图）导成 codex-native 后：

| 项 | 数值 |
|---|---|
| 总字符（≈token） | 917375 字符 ≈ **254826 token** |
| Codex 上下文窗口 | **258400 token** |
| 结果 | 刚好卡临界 → 桌面端报 `Codex ran out of room in the model's context window` |

更糟的是**体积构成**：

| 内容 | 字符 | 占比 |
|---|---|---|
| `event_msg/item_completed`（与 `response_item` **重复写的一份**） | 462048 | 50.4% |
| 工具输出 | 249141 | 27.2% |
| 工具参数 | 92058 | 10.0% |
| **真正的人类/模型对话** | **13108** | **1.4%** |

> 也就是说：为了把 1.4% 的对话搬过去，我在搬 98.6% 的废料。

**结论（设计原则）**：压缩阈值调参治不了这个——要改成
**「迁移的是工作状态，归档的是完整历史」**：

1. **交接书**导出时自动生成（不要求用户提前准备 handoff 文档）；
2. **完整历史**落到项目目录 `.dsh/session-handoff/<session-id>/`，可 grep/rg，且**永不截断**；
3. **预算回落只作用于迁移副本**，绝不动完整档案；
4. **双向可复用**——只认 DSH 事件形状，不为 Codex 写专用逻辑。

### 5.2 归档目录结构

```
<项目根>/.dsh/session-handoff/session-9e733630-19f2-4abc-9d2d-6ce3ff5f151e/
  handoff.md          自动生成的交接书（八段）
  index.md            归档索引（文件清单 + 每轮指针）
  original.jsonl      原始事件逐行原文（**零截断**，可 grep / rg）
  turns/001..008.md   每一轮的完整正文（超长工具输出只留首行 + 指向 tool-outputs/）
  tool-outputs/*.txt  超长工具输出全文
  assets/*.png        会话里引用的图片
```

同时往 `<项目根>/.git/info/exclude` 追加 `.dsh/session-handoff/`——**本地排除，不改项目正式 `.gitignore`**
（不打扰协作者，也不把别人的仓库改脏）。非 git 仓库时静默返回，不报错。

### 5.3 交接书八段与提取算法

固定八段（用户指定）：**项目目标 / 已完成工作 / 技术决策 / 修改文件 / 测试与验证 / 未解决问题 / 下一步任务 / 历史索引**。

生成过程是**纯函数式的本地归纳**（`buildHandoffModel`），不调模型、不把百万 token 交给摘要模型：

| 段 | 提取函数 | 规则要点 |
|---|---|---|
| 项目目标 | `extractGoal` | 「最早一条真实提问」+「最近一条真实提问」，渲染成起点/最终诉求（中间多是「继续」「然后呢」） |
| 已完成工作 | 轮次摘要 | 每轮：用户提问 + 助手正文首 180 字 + 工具次数 + 改动文件 |
| 技术决策 | `extractDecisions` | 正则取助手正文里的决策行，去重、截断 220 字符（保留「选了什么 + 为什么」） |
| 修改文件 | `extractTouchedFiles` | 只认写类工具（`write/edit/apply_patch/create_file/str_replace_editor` …），从 `path/filePath/target/…` 取路径，按次数排序 |
| 测试与验证 | `extractVerification` | **双重条件**：命令字段命中测试命令 **且** 输出里有明确通过/失败信号（否则真实会话 20 条里 16 条是噪声） |
| 未解决问题 | `extractOpenItems` | TODO 类正则 |
| 下一步任务 | 最后一轮收尾 | |
| 历史索引 | — | 表格：轮次 / 时间 / 提问 / 工具数 / 归档文件 |

实测（该会话）：`handoff.md` 8332 字符（≈2.3k token，窗口 0.9%）、16 条技术决策、2 条真实失败、
1 条未解决、8 行索引表。第 5 段里保留的是真实失败，例如
`SyntaxError: unterminated string literal (detected at line 1)`。

### 5.4 迁移副本的取舍模型

**维度一：谁留谁舍。** 早期实现是「只留最近 N 轮的**全部事件**」，结果在长会话里只有最狠一档塞得进预算，
前 7 轮整段消失——用户看到的界面就是「对话只剩最后一轮」，反馈原话是
**「对话就是张这个样子。到头了。」**。

现在的模型是 `keepAllTurns`：

| 事件 | 处理 |
|---|---|
| 所有轮次的**真实用户提问** | 全留 |
| 所有轮次的**助手正文** | 全留 |
| 掉出工具窗口的轮次的助手消息 | 剥掉 `tool-call` 块（只留正文/推理） |
| 工具调用与输出（`tool/call`、`tool/result`） | 只留最近 N 轮 |
| 宿主注入的假用户消息 | 一律丢弃 |

> 剥 `tool-call` 块是必须的：留着会产生**配不上 `tool_result` 的孤儿 `tool_use`**（claude）或
> **找不到输出的 `function_call`**（codex），宿主会拒绝整段历史。

**维度二：预算阶梯。** `fitCopyToBudget` 按 `COPY_SHRINK_LADDER` 逐档收紧，每档四列
`[工具轮数, 工具输出上限, 参数上限, 早期助手正文上限]`：

```
[3,4000,4000,0] → [3,2000,2000,0] → [3,1000,800,6000] → [3,600,400,3000]
                                                       → [2,600,400,3000] → [1,400,300,2000]
```

两条排序原则（都来自实测）：

1. **先钳内容、后减轮数**：前三档都在 3 轮上收紧，只有钳到最紧仍装不下才退到 2 轮、1 轮。
   早期版本反了——为了凑 5% 把 3 轮砍成 1 轮，本末倒置。
2. **正文那一列必需**：实测助手正文占副本 58%、工具输出只占 14%，只缩工具输出根本压不动。

两个目标：

| 常量 | 值 | 含义 |
|---|---|---|
| `COPY_MAX_CHARS` | 46000 | **软目标**：窗口 ×3.6 字符/token ×5% |
| `COPY_HARD_MAX_CHARS` | 186000 | **硬上限**：×20%，超过它才真的会把目标窗口顶爆 |

软目标够不到时，取「仍装进硬上限、且**体积最小**」的那一档，并**如实报告 `fitted:false`**：
多留两轮工具明细要多花 5 万字符（17.7% vs 6.1%），而交接书第 3/4/5 段与 `tool-outputs/` 已覆盖那些细节。
**绝不为了凑轮数把目标窗口顶爆。** 交接书正文任何时候都不动。

### 5.5 五个体积来源（全部在 `clampCopyEvents` 里剥/钳）

| 来源 | 实测占比 | 处理 |
|---|---|---|
| `assistant/message.data.stream`（推理分片） | **79%** | 目标格式无人消费，与 `data.usage` 一起删 |
| 序列化器根本不读的事件类型 | **22%** | 白名单 `COPY_KEEP_TYPES` 过滤 |
| `tool/result` 文本 | 27% | `clampToolOutput` 截断 |
| `tool/call` 参数（助手消息的 `tool-call` 块里**还存着同一段**） | 10% | 两边都钳 |
| `assistant/message` 的 `reasoning` 块 | 最近一轮的 **60%+** | 整块剥掉（档案里全文都在） |

白名单 `COPY_KEEP_TYPES`：`user/message`、`assistant/message`、`tool/call`、`tool/result`、
`turn/start`、`turn/end`、`step/start`、`step/end`、`session/title`、`session/imported`。
被剥掉的实测类型：`job/registered`、`job/settled`、`session-log-deepseek/delivery-accepted`、
`agent/inbox/spliced`、`workspace/changes`、`session/end-seed`。

**一个必须遵守的不变式**：副本里不能出现 `content: []` 的助手消息。剥掉 `reasoning` 块后如果没剩别的块，
**整条丢弃**——Claude 的 assistant 记录空 content 会让 Claude Code 续聊直接报错。
这一条把该会话的副本从 110140 字符压到 56398 字符（111 条「只有推理块」的消息被丢弃）。

### 5.6 事件形状与坑

DSH 会话日志（`session.v4.jsonl.zstd`）的关键形状：

```jsonc
// 会话头
{"type":"session","version":4,"id":"session-…","createdAt":…,"cwd":"…","agentPreset":"…"}

// 用户消息：data 里**没有 turn 字段**
{"type":"user/message","data":{"content":[{"type":"text","text":"…"},
                                         {"type":"image","attachment":{"attachmentId":"…","mediaType":"image/png"}}],
                               "source":{"kind":"user"}}}   // 只有 kind==='user' 才是真实提问

// 工具调用：arguments 是 JSON 字符串
{"type":"tool/call","data":{"turn":6,"step":1,"callId":"call_00_…","name":"pwsh","arguments":"{…}"}}

// 工具结果：callId 在 message.toolCallId（或 message.source.callId），失败看 message.isError
{"type":"tool/result","data":{"turn":6,"step":1,"message":{"role":"tool","toolCallId":"call_00_…",
                               "content":[{"type":"text","text":"…"}],"isError":false}}}
```

踩过的坑：

1. **`user/message` 没有 `data.turn`**。轮次归属必须**顺序扫描**：遇 `turn/start` 或自带 `data.turn` 的事件推进游标，
   用户消息归到当前游标。否则整份日志被判成 0 轮、副本里对话全消失。没有 `turn/start` 的老日志用
   `annotateTurns` 的合成轮次兜底。
2. **只有 `data.source.kind === 'user'` 才是真实提问**。其余（`runtime-context` / `skill-catalog` /
   `time-context` / `user-approval`）是宿主注入——写进目标格式会被当成用户发言，而且单条 `skill-catalog`
   就能吃掉几千字符预算。
3. **`assistant/message.data.stream` 体积巨大且无用**，别读。
4. **助手消息的 `tool-call` 块没有 callId**，`tool/call` 事件才有；claude 序列化器从块里读 name/arguments，
   `tool/call` 事件用于配对，所以**两边的 arguments 都要钳**。
5. 长会话里「最近一轮」可能有 120 个事件——硬压到 5% 只能砍正文，伤续聊质量，所以需要硬上限兜底。

### 5.7 出边接线

`handoffForExport(ctx, {sessionId, header, events, archiveRoot, recentTurns})` 是**三条出边的统一入口**，
返回 `{events, handoff}`：`events` 是迁移副本、`handoff` 是给 UI/工具面的摘要。

- `lib/export-tool.mjs`：`exportClaudeSession` 与 `exportTargetFile` 都先取交接包，再解引用图片、再序列化
- `lib/codex-export.mjs`：`exportCodexNative` 在 `resolveImagesForExport` 之前取交接包
- `bundle` / `markdown` **不接**交接包——它们本身就是完整档案，接了反而丢东西（设计如此）

**归档失败不阻断导出**：`handoffForExport` 退回原始事件并带回 `handoff.error`，面板/工具面如实显示
「完整档案没写成：…（迁移副本退回原始历史，可能超出目标窗口）」。

### 5.8 实测数据

同一会话 `session-9e733630`（1154 事件 / 8 真实轮次 / 4 张图）：

| 指标 | 数值 |
|---|---|
| 交接包生成耗时 | ~85 ms |
| 完整档案 | `original.jsonl` **1154 行 = 源事件数（逐行可 JSON.parse，零截断）**、69 个文件 |
| 迁移副本 | 86 事件 / 56398 字符 ≈ **15666 token ≈ 窗口 6.1%**（此前 917375 字符 / 99%） |
| 副本内容 | **8 轮提问与助手正文全部保留**，工具明细压到最近 1 轮 |
| `codex` 序列化 | 44 记录 / 35739 字符；`function_call` 13 / `function_call_output` 13、孤儿 0、不合规工具名 0 |
| `codex-native` | 101 记录 / 101647 字符；`budget fitted:true attempt:0` |
| `claude` | 157 记录 / 85757 字符；`tool_use`↔`tool_result` 13/13 配对、无孤儿 |
| 真机端到端 | 另一个 8 轮会话导入 Codex 后：19 条 user / 76 条 assistant、93 次 `function_call` 全配对，追问能拿到带项目上下文的回答 |

---

## 6. 工具名归一化与截断（修「无法对话」）

**现象**：把 DSH 导出的会话喂给 ChatGPT/Codex 桌面端，发送时报

```
Invalid 'response.create' payload: Invalid 'input[287].name':
string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+\z'.
```

**根因**：不是压缩代理写坏了日志。扫全部 62 个会话 / 8315 次工具调用 / 42 个工具名，
唯一不合规的是 `acp tokens=`——模型某次把 ACP 标记片段当成了工具名（紧随其后就是
`Error: unknown tool "acp tokens="`）。这点失败调用被导出器**原样抄出**，
`acp tokens=` 含空格和等号，宿主直接**拒绝整份历史**。

**修法**（`lib/export/common.mjs`，两个纯函数）：

```js
// 非字符串 → 'unknown'；非法字符换 _；连续 _ 折叠；首尾 _ 去掉；空 → 'unknown'；截 64
export function sanitizeToolName(name) {
  const raw = typeof name === 'string' ? name.trim() : ''
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '')
  return (cleaned || 'unknown').slice(0, 64)
}

// 超长保留头 60% + 尾 40%，中间插省略标记
export function clampToolOutput(text, limit = 4000)
```

接入点：`lib/export/codex.mjs` 的 `function_call.name`、`lib/codex-native.mjs` 的三处 name 与
`McpToolCall.tool`、以及各处的 `output` 文本。**`call_id` 的配对关系不动**——只改名字，不改 id。

自检 `test-sanitize.mjs`（26 条）覆盖：`acp tokens=` → `acp_tokens`、中文名、点号→下划线、
`''`/`'!!'`/`undefined` → `unknown`、超长截 64、首尾下划线、连续折叠，并验证两个序列化器 call_id 配对不变。

---

## 7. UI 改造（`lib/client.js`）

> 上游 `lib/client.js` 是由 `scripts/build-client.mjs` 从 `src/` 构建出的 bundle。
> 本次 UI 改动**直接改在 bundle 上**，没有回写 `src/`——所以**跑 `npm run build` 会覆盖掉这些改动**（见第 10 节）。

### 7.1 入口改名

面板入口文案 导入会话 → **会话迁移**（英文 `Import Sessions` → `Session Migration`），
连带 `trigger.title` / `sidebar.guide.description` / 设置项描述一起改；设置页标题保留「会话导入」不动。

### 7.2 会话列表按工具分组

按用户要求「显示先按照 harness 区分带图标，然后往下展开」，列表改成**两级层级**。第一版两级头
「只差 2px 高、字重 500→600、颜色 dim→text」，渲染出来是两条一样的整宽深色条，
用户反馈**「层级还是怪怪的。」**——所以重做：

| 层级 | 样式 |
|---|---|
| **工具头（唯一大标题）** | 30px 高、13px/600、主色、sticky `z-index:2`，带品牌图标与折叠箭头、会话数 |
| **工作区子头** | 24px、12px/500、`dimmer` 色、**透明底**、**不 sticky**、左侧 2px 竖引导线 |
| 行 | 按层级缩进（子头下 16px / 扁平组 28px） |

再加一条**扁平化**规则：`flat = groups.length <= 1 || spaces.length === 0`：

- 该工具下只有 1 个工作区 → **不画子分组头**，工作区名作为小组头右侧的小字（`harnessSub`）
- 只有 1 条会话的工作区 → **完全不给头**，这些行合并成组尾的无头「零散块」，工作区名放进每行的 tooltip

> 为什么需要这条：真实数据里 Codex 36 条会话散在 **18 个工作区（17 个各 1 条）**、
> WorkBuddy 18 条散在 7 个（6 个各 1 条）。每个工作区都给头，就是一堵「一行标题夹一行内容」的墙。

实现要点：`groupByHarness` / `layoutHarness` 是纯函数（`windowRange` 的窗口算术保持纯数值），
折叠键做了命名空间隔离（`h:<tool>` / `w:<tool>|<workspace>`），避免同名工作区在两个工具下被一起折叠；
`SessionRow` 是 `memo` 组件，**新增 prop 必须同步加进比较器**，否则行不刷新。

### 7.3 导出结果行

见 4.4。

---

## 8. 落地方式：开发期的补丁器（不在本仓库内）

改造最初不是从源码树开始的——插件已经装好，而本机装不了工具链、也拉不到上游仓库。于是做法是**补丁源 + 补丁器**：把每一处改动写成一条带锚点的编辑规则，由补丁器验证后写入已安装的插件文件，同时保证可复现、可回滚、可重装。

```powershell
& '<node>' <patch-dir>\apply.mjs "<插件 lib 目录>" [--dry]
```

设计要点（记录于此，便于理解改动是怎么被安全地反复应用的）：

- **两阶段**：先收集所有编辑（每个 `replaceOnce` 校验锚点唯一），任何一个出问题就在**写盘前**整体中止，不会留下半成品。
- **锚点校验**：`replaceOnce(text, from, to, label)` 抛 `锚点缺失：…` / `锚点不唯一：…`，上游一改代码就能立刻发现补丁失效。
- **幂等**：每个文件带自己的标记（如 `existing.includes('export function sanitizeToolName')`），已打过就输出 `= … 已打过补丁`；重复运行输出 `无需改动：全部已打过补丁`。
- **备份**：写盘前留 `<file>.orig-<date>`（**仅当不存在**），可随时回滚。
- **待写合并层**：同一文件被多块补丁先后编辑时，用 `pendingOf(file, fresh)` / `pushChange(entry)` 在内存里串起来，避免后一块用磁盘旧内容覆盖前一块的改动（这个 bug 真的发生过）。
- **整文件复制**用于新模块与「几乎全部重写」的模块（`session-handoff.mjs` / `codex-native.mjs` / `codex-export.mjs` / `session-export.mjs`），anchor 补丁用于侵入式小改（`panel.mjs` / `command.mjs` / `client.js` / `export/common.mjs` / `export/codex.mjs` / `tools/export-tools.mjs`）。

最后一步是把已安装副本上的改动合并回**本仓库源码**，并且把 `lib/client.js` 的客户端改动反向移植回 `src/client/` 分片——上游 `test/build-client.test.mjs` 会断言「`assemble()` 的结果 == 磁盘上的 `lib/client.js`」，两边不同步这条测试就会失败。移植后 `node scripts/build-client.mjs --check` 通过，说明 `lib/client.js` 已经是可从分片重建的产物。

> 踩过的坑：插件自带一个**同名不同用**的 `lib/handoff.mjs`（给 `/resume-claude`、`/resume-codex` 用的 `summarizeClaudeJsonl` / `summarizeCodexJsonl`）。最初把新模块也叫 `handoff.mjs` 并整文件覆盖，会当场打断那两条导入路径——**已改名 `session-handoff.mjs`**，补丁只允许往里放新文件（本仓库里这两个文件并存，名字不可互换）。

---

## 9. 开发期自检（9 套，无需浏览器；脚本不在本仓库内）

> 这一节记录的是**改造开发期**用过的本机脚本，它们不在本仓库内，也不会随包发布——写在这里是为了说明「改动是怎么被验证的」。仓库自身的门禁与测试是另一套：`.github/scripts/check-*.mjs`（`check:linux` / `check:leaks` / `check:links` / `check:tests`）与 `test/*.test.mjs`（`node --test "test/*.test.mjs"`）。

面板相关的检查用 Node 桩脚本完成——当时 GUI 对任何 header/cookie 都返回 401，也没有浏览器可用，所以渲染检查靠「假 DOM + 假 React + 真组件函数」求值。

| 脚本 | 收的路径 | 断言 | 覆盖 |
|---|---|---|---|
| `check-bundle.cjs` | `lib/client.js` | 9 | stub DOM 里求值整个 bundle，捕获 `__ModuleLoader__.load`，在假 ctx 上跑 `apply()`，确认插槽注册不报错 |
| `check-panel.cjs` | `lib/client.js` | — | 中英文字典键交叉核对（无缺失）、`COLORS`/`STYLES` 键完整 |
| `check-harness.cjs` | `lib/client.js` | 37 | 分组/折叠/窗口算术纯函数：工具切分与排序、`claude`→`claude-code` 映射、只有≥2 条的 workspace 才给子头、零散块、扁平规则、逐像素高度 |
| `check-render.cjs` | `lib/client.js` | 34 | 真组件 + 最小 React 桩渲染 `HarnessGroup`：图标、箭头旋转、扁平组 `hideHead`+缩进 28、零散块、`harnessSub` |
| `verify-harness.cjs` | `lib/client.js` | — | 落地核对（行数 / CRLF / BOM / 替换字符 / 关键符号出现位置） |
| `test-export.mjs` | `lib` 目录 | — | 五种格式 + 路由层（含 400 分支）+ **交接包**（摘要指向归档、`original.jsonl` 行数=事件数、副本保留真实提问） |
| `test-codex-native.mjs` | `lib` 目录 | 42 | Codex 原生序列化、`session_meta` 字段形状、call/output 配对 |
| `test-sanitize.mjs` | `lib` 目录 | 26 | 工具名归一化 + 输出截断 + call_id 配对不变 |
| `test-handoff.mjs` | `lib` 目录 | 65 | 轮次归属（含无 `turn/start` 老日志兜底）、八段渲染、`keepAllTurns` 对话全留、预算回落、空 content 不变式、归档完整性、git exclude 幂等 |

签名区别（别传错）：`check-*.cjs` 收 **`lib/client.js` 路径**，`test-*.mjs` 收 **`lib` 目录**。

---

## 10. 已知限制

1. **`lib/client.js` 是生成产物**：源在 `src/client/` 分片，改动已反向移植回去，`node scripts/build-client.mjs --check` 通过。**不要直接改 `lib/client.js`**，改分片后用 `node scripts/build-client.mjs` 重建。
2. **面板路由层（`lib/session-export.mjs`）与 Codex 原生装库（`lib/codex-native.mjs`）不在上游**，
   与上游后续版本合并时可能冲突。
3. **Codex 原生装库依赖 Codex 桌面端已初始化**：`state_5.sqlite` 里没有可参照线程时会明确报错并停止，
   不会写出半成品。
4. **写 `state_5.sqlite` 前会备份**，但仍属「改别人的数据库」，跨版本 Codex 可能变字段。
5. **`attachment-skipped` 计数**：迁移副本只带窗口内轮次的图片，被过滤轮次的图片引用会记为降级，属预期。
6. 交接包的 `tool-outputs/` 与 `assets/` 会让归档目录有几十个文件——这是「完整历史」的代价，已被 `.git/info/exclude` 本地排除。

---

## 11. 许可与致谢

- 上游 `dsh-chat-import` 由 **Nwflower** 开发，MIT 许可，本仓库保留原 `LICENSE` 与版权声明；
  本改造是在其之上的衍生修改。
- 本改造为个人工作流定制：面板导出、Codex 原生装库、交接包、会话列表分组。
- 反馈上游问题请走 `https://github.com/Nwflower/dsh-chat-import/issues`；
  与本改造相关的问题请在本仓库开 issue。
