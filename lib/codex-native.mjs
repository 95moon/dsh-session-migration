// lib/codex-native.mjs — 把 DSH 会话「装进」真实的 Codex 库位（不是导出一个 .jsonl 让用户自己搬）
//
// 为什么需要这一层：lib/export/codex.mjs 只写最小子集（session_meta + response_item），
// 那是给 convertCodexJsonl 反向再导入用的中间件。真实 Codex 认一个会话要三件套缺一不可：
//   1) rollout 文件  <codexHome>/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
//      且首行 session_meta 必须带 creator_user_id / creator_account_id / base_instructions 等
//      （缺了会 invalid_session_metadata）；
//   2) state_5.sqlite 的 threads 表有对应 id 的一行（缺了 migrate-rollouts 报
//      missing_sqlite_metadata —— 这行就是 Codex 的「会话索引」，列表/项目归属都读它）；
//   3) `codex migrate-rollouts --apply --thread <id>` 让它自己写 thread_history 投影
//      （我们绝不直接写 thread_history_1.sqlite：那是它的内部投影，格式会随版本变）。
//
// 项目归属：threads 表 58 行全是 project_id = NULL，Codex 靠 projects + project_roots 的
// 路径匹配来归档会话。所以这里不伪造 project_id，而是把 cwd 选对——落到既有项目的目录
// 下，Codex 打开后就把它归到那个项目里（语义正确，不侵入它的项目状态）。

import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fitToBudget, sanitizeToolName, clampToolOutput } from './export/common.mjs'

/** Codex home：CODEX_HOME 优先，否则 ~/.codex（本机它是指向 E:\Codex\_appdata\codex-home 的联接）。 */
export function resolveCodexHome(env = process.env) {
  const custom = env && typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : ''
  return custom || join(homedir(), '.codex')
}

/** 常见安装位置（Desktop 版在 WindowsApps 下，PATH 上通常没有 codex）。 */
const CODEX_CANDIDATES = [
  'C:\\Program Files\\WindowsApps',
  'C:\\Users\\HASEE\\AppData\\Local\\Programs',
]

/**
 * 在 PATH 里找 codex（Windows 上要认 .exe / .cmd / .bat，Unix 上认可执行文件）。
 * 注意：`existsSync('codex')` 那种写法会把相对路径当成当前目录下的文件，永远是 false，别用。
 */
function codexOnPath(env) {
  const raw = (env && (env.PATH || env.Path)) || ''
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of raw.split(process.platform === 'win32' ? ';' : ':')) {
    const root = dir.trim().replace(/^"|"$/g, '')
    if (!root) continue
    for (const ext of exts) {
      const p = join(root, 'codex' + ext)
      if (existsSync(p)) return p
    }
  }
  return null
}

/**
 * 用 PowerShell 问「正在运行的 codex 进程在哪」。
 * 为什么需要这条兜底：Desktop 版装在 `C:\Program Files\WindowsApps` 下，那个目录
 * readdir 会被系统拒绝（EPERM，实测），所以既不能列目录也不能拼版本号猜路径；
 * 但只要有 codex 进程在跑，就能直接读到它的 Path。返回 null 表示没找到/不可用。
 */
async function codexFromProcess() {
  if (process.platform !== 'win32') return null
  const script = "(Get-Process codex -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path)"
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 15000, maxBuffer: 1 << 20 },
        (err, out) => (err ? reject(err) : resolve({ stdout: out })))
    })
    const p = String(stdout || '').trim()
    return p && existsSync(p) ? p : null
  } catch {
    return null
  }
}

/**
 * 找可执行的 codex（找不到就返回 null——调用方据此把「已装库」降级成「只写文件」）。
 * 顺序：CODEX_BIN 环境变量 → PATH → 正在运行的进程 → 已知安装根目录（能列目录时）。
 */
export async function findCodexCli(env = process.env) {
  const fromEnv = env && typeof env.CODEX_BIN === 'string' ? env.CODEX_BIN.trim() : ''
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const onPath = codexOnPath(env)
  if (onPath) return onPath
  const fromProc = await codexFromProcess()
  if (fromProc) return fromProc
  for (const root of CODEX_CANDIDATES) {
    if (!existsSync(root)) continue
    let names
    try { names = await readdir(root) } catch { continue }
    for (const name of names) {
      if (!/^OpenAI\.Codex_/i.test(name) && !/^Codex$/i.test(name)) continue
      for (const rel of ['app\\resources\\codex.exe', 'codex.exe']) {
        const p = join(root, name, rel)
        if (existsSync(p)) return p
      }
    }
  }
  return null
}

// ── SQLite：只碰 state_5.sqlite，且只读写 threads / projects / project_roots 三张表 ──────
async function openStateDb(codexHome, { readOnly = false } = {}) {
  const path = join(codexHome, 'state_5.sqlite')
  if (!existsSync(path)) return null
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch (err) {
    throw new Error('当前 Node 不支持 node:sqlite，无法写入 Codex 会话索引：' + String((err && err.message) || err))
  }
  return new sqlite.DatabaseSync(path, readOnly ? { readOnly: true } : {})
}

/**
 * 读一份「跟这台机器上真实 Codex 一模一样」的模板：creator_* / cli_version / model_provider /
 * sandbox_policy / approval_mode 这些字段各版本不同，硬编码就会写出 Codex 不认的元数据。
 * 用库里最新的一行真实 thread 作模板，字段随本机 Codex 版本自动对齐。
 */
export async function readCodexTemplate(codexHome) {
  const db = await openStateDb(codexHome, { readOnly: true })
  if (!db) return null
  try {
    const row = db.prepare(
      `select source, model_provider, cwd, sandbox_policy, approval_mode, cli_version,
              model, reasoning_effort, memory_mode, thread_source, originator,
              creator_user_id, creator_account_id
         from threads
        where originator is not null and creator_user_id is not null
        order by created_at desc limit 1`,
    ).get()
    if (!row) return null
    let projects = []
    try {
      projects = db.prepare(
        `select p.id as id, p.name as name, r.path as path
           from projects p join project_roots r on r.project_id = p.id
          order by p.position, r.position`,
      ).all() || []
    } catch { projects = [] }
    return { template: row, projects }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

/** cwd → 已存在的 Codex 项目根（最长前缀匹配）；匹配不上就返回 null（会话落在所有项目之外）。 */
export function matchProjectRoot(cwd, projects) {
  if (typeof cwd !== 'string' || !cwd || !Array.isArray(projects)) return null
  // Codex 库里存的是长路径（\\?\E:\...），DSH 侧是普通路径：去掉 \\?\ 前缀再比较。
  // 注意必须整段去掉「\\?\」四个字符——用 /\\?\?\\/ 只会吃掉后三个，留下开头那个反斜杠，
  // 结果所有项目根都匹配不上（实测踩过）。斜杠方向也要统一（用户可能给 e:/x/y 这种）。
  const norm = (p) => String(p || '')
    .replace(/^\\\\\?\\/, '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
  const target = norm(cwd)
  let best = null
  for (const p of projects) {
    const root = norm(p && p.path)
    if (!root) continue
    if (target === root || target.startsWith(root + '\\') || target.startsWith(root + '/')) {
      if (!best || root.length > norm(best.path).length) best = p
    }
  }
  return best
}

// ── rollout 序列化（完整 Codex 记录形状） ───────────────────────────────────────────────

const iso = (ms) => new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString()
const ms = (value, fallback) => (Number.isFinite(value) ? value : fallback)

/** DSH 内容块 → Codex ContentItem（文本 + 图片，图片块沿用 codex.mjs 的 input_image 形态）。 */
function contentOf(blocks, textType) {
  if (typeof blocks === 'string') return { items: [{ type: textType, text: blocks }], text: blocks, images: 0 }
  if (!Array.isArray(blocks)) return { items: [], text: '', images: 0 }
  const items = []
  const texts = []
  let images = 0
  for (const b of blocks) {
    if (!b) continue
    if (b.type === 'text' && typeof b.text === 'string') {
      items.push({ type: textType, text: b.text })
      texts.push(b.text)
      continue
    }
    if (b.type === 'image' && b.data && b.mediaType) {
      items.push({ type: 'input_image', image_url: 'data:' + b.mediaType + ';base64,' + b.data })
      images++
    }
  }
  return { items, text: texts.join('\n'), images }
}

/** Codex 侧上下文窗口（rollout 里 task_started.model_context_window 也写这个值）。 */
export const CODEX_CONTEXT_WINDOW = 258400

/**
 * 序列化预算：字符上限 = 窗口 token × 3.6。为什么要留这么大折扣：Codex 打开会话时要把
 * 整条历史塞进一次请求，除了历史本身还有系统提示、工具清单、新用户消息；而且 JSONL 的
 * 引号/转义字符会略微膨胀。取 0.65 的利用率，给这些固定开销留出余量。
 */
export const CODEX_NATIVE_MAX_CHARS = Math.floor(CODEX_CONTEXT_WINDOW * 3.6 * 0.65)

/**
 * DSH 事件 → Codex 完整 rollout 记录数组（带总量预算回落）。
 * 一条 DSH user/message 开一个 Codex turn（respond_item 顺序与真实 rollout 一致：
 * task_started → response_item* → task_complete），turn_context 跟在 session_meta 后。
 *
 * 为什么要量了再重算：单条工具输出截断只保证「每条不超过 N 字符」，N×60 次调用仍然能
 * 顶爆 258400 的窗口（实测一份导出 917375 字符 ≈ 25.5 万 token，刚好卡在窗口边上，
 * Codex 能显示但发不出消息）。所以这里按 fitToBudget 的阶梯由宽到严重算，直到装进窗口；
 * 返回值多一个 budget 字段，调用方可以据此提示用户。
 */
export function serializeCodexNative(events, options = {}) {
  const fitted = fitToBudget(
    (limits) => buildCodexNative(events, { ...options, ...limits }),
    CODEX_NATIVE_MAX_CHARS,
  )
  // 图片是预算里最不可压缩的一块（一张 1500×1200 截图的 base64 就有几十万字符，且截断
  // base64 会破坏图片）。文字档位收到地板仍超预算时，才按「丢掉内联图片、只留一行占位」
  // 再走一遍阶梯——这时会话至少还能续聊，总比打不开强。
  if (!fitted.budget.fitted && fitted.inlineImages > 0) {
    const stripped = fitToBudget(
      (limits) => buildCodexNative(events, { ...options, ...limits, dropImages: true }),
      CODEX_NATIVE_MAX_CHARS,
    )
    return { ...stripped, droppedImages: fitted.inlineImages }
  }
  return fitted
}

function buildCodexNative(events, {
  sessionUuid,
  cwd,
  createdAt,
  title,
  template = {},
  workspaceRoots = [],
  model,
  reasoningEffort,
  outputLimit = 4000,
  argumentLimit = 4000,
  dropImages = false,
}) {
  const list = Array.isArray(events) ? events : []
  const created = ms(createdAt, Date.now())
  const records = []
  let ordinal = 0
  const push = (type, payload, timestampMs) => {
    records.push({ timestamp: iso(timestampMs), ordinal: ordinal++, type, payload })
  }

  const sessionId = String(sessionUuid)
  const rootCwd = typeof cwd === 'string' && cwd ? cwd : ''

  push('session_meta', {
    account_scoped: true,
    creator_user_id: template.creator_user_id || null,
    creator_account_id: template.creator_account_id || null,
    session_id: sessionId,
    id: sessionId,
    parent_thread_id: null,
    timestamp: iso(created),
    cwd: rootCwd,
    runtime_workspace_roots: workspaceRoots.length ? workspaceRoots : (rootCwd ? [rootCwd] : []),
    originator: 'Codex Desktop',
    cli_version: template.cli_version || '',
    source: 'vscode',
    thread_source: 'user',
    model_provider: template.model_provider || 'openai',
    base_instructions: { text: '' },
  }, created)

  const turnIds = []
  let current = null
  const startTurn = (ts) => {
    const turnId = randomUUID()
    turnIds.push(turnId)
    current = { turnId, startedAt: ts, lastAssistant: '' }
    push('event_msg', {
      type: 'task_started',
      turn_attribution: {
        turn_id: turnId,
        turn_trigger: 'user',
        parent_turn_id: null,
        initiating_agent_path: null,
        root_turn_id: turnId,
      },
      turn_id: turnId,
      root_turn_id: turnId,
      started_at: Math.round(ts / 1000),
      model_context_window: 258400,
      collaboration_mode_kind: 'default',
    }, ts)
    push('turn_context', {
      turn_id: turnId,
      root_turn_id: turnId,
      disabled_plugin_ids: [],
      cwd: rootCwd,
      approval_policy: 'never',
      approvals_reviewer: null,
      permission_profile: { type: 'disabled' },
    }, ts)
  }
  const endTurn = (ts) => {
    if (!current) return
    push('event_msg', {
      type: 'task_complete',
      root_turn_id: current.turnId,
      turn_id: current.turnId,
      last_agent_message: current.lastAssistant || null,
      started_at: Math.round(current.startedAt / 1000),
      completed_at: Math.round(ts / 1000),
      duration_ms: Math.max(0, ts - current.startedAt),
      time_to_first_token_ms: null,
    }, ts)
    current = null
  }

  // Codex 桌面端的会话视图不读 response_item：它从 event_msg/item_completed 投影 thread_items，
  // 只有 response_item 的 rollout 会显示成空会话。所以每条会话项既写 response_item（原生形状），
  // 也写一条 item_completed（投影入口）。
  const pushItem = (turnId, item, startedAt, completedAt) => {
    push('event_msg', {
      type: 'item_completed',
      thread_id: sessionId,
      turn_id: turnId,
      item,
      started_at_ms: Math.round(startedAt),
      completed_at_ms: Math.round(completedAt),
    }, completedAt)
  }
  const argsOf = (value) => {
    if (value && typeof value === 'object') return value
    if (typeof value !== 'string') return {}
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed }
    } catch {
      return { raw: value }
    }
  }
  const pendingCalls = new Map()

  for (const ev of list) {
    if (!ev || typeof ev.type !== 'string') continue
    const data = ev.data || {}
    const ts = ms(ev.time, ms(ev.timestamp, created))
    if (ev.type === 'user/message') {
      // 注入型消息（系统提示/tool 结果回灌）不当用户轮次
      if (data.source && data.source.kind && data.source.kind !== 'user') continue
      const { items, text } = contentOf(data.content, 'input_text')
      if (!text && items.length === 0) continue
      endTurn(ts)
      startTurn(ts)
      push('response_item', { type: 'message', id: 'msg_' + randomUUID(), role: 'user', content: items }, ts)
      const textBlocks = items
        .filter((i) => i.type === 'input_text')
        .map((i) => ({ type: 'text', text: i.text, text_elements: [] }))
      if (!textBlocks.length) textBlocks.push({ type: 'text', text: '（图片）', text_elements: [] })
      pushItem(current.turnId, {
        type: 'UserMessage',
        id: randomUUID(),
        client_id: randomUUID(),
        content: textBlocks,
      }, ts, ts)
      continue
    }
    if (ev.type === 'assistant/message') {
      const msg = data.message || {}
      const blocks = Array.isArray(msg.content) ? msg.content : []
      const { items, text } = contentOf(blocks, 'output_text')
      if (!text && items.length === 0) continue
      if (!current) startTurn(ts)
      current.lastAssistant = text
      push('response_item', { type: 'message', id: 'msg_' + randomUUID(), role: 'assistant', content: items }, ts)
      // 带 tool-call 的 assistant 消息是中间说明，纯文本的收尾才算最终答复
      const phase = blocks.some((b) => b && b.type === 'tool-call') ? 'commentary' : 'final_answer'
      if (text) {
        pushItem(current.turnId, {
          type: 'AgentMessage',
          id: 'msg_' + randomUUID().replace(/-/g, ''),
          content: [{ type: 'Text', text }],
          phase,
        }, ts, ts)
      }
      continue
    }
    if (ev.type === 'tool/call') {
      if (!current) startTurn(ts)
      const callId = data.callId || randomUUID()
      push('response_item', {
        type: 'function_call',
        call_id: callId,
        name: sanitizeToolName(data.name),
        arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}),
      }, ts)
      pendingCalls.set(callId, { name: sanitizeToolName(data.name), arguments: data.arguments, at: ts })
      continue
    }
    if (ev.type === 'tool/result') {
      // 真实形状：{ turn, step, message:{ role:'tool', toolCallId, source:{kind:'tool',callId},
      // content:[{type:'text',text}], isError, id }, meta } —— callId 在 message.toolCallId 上
      const msg = data.message || {}
      const callId = msg.toolCallId || (msg.source && msg.source.callId) || data.callId
      if (!callId) continue
      const output = clampToolOutput(contentOf(msg.content, 'input_text').text)
      push('response_item', { type: 'function_call_output', call_id: callId, output }, ts)
      const call = pendingCalls.get(callId) || { name: sanitizeToolName(data.name), arguments: data.arguments, at: ts }
      pendingCalls.delete(callId)
      if (!current) startTurn(call.at || ts)
      const failed = msg.isError === true
      const elapsed = Math.max(0, ts - (call.at || ts))
      pushItem(current.turnId, {
        type: 'McpToolCall',
        id: 'exec-' + randomUUID(),
        server: 'dsh',
        tool: sanitizeToolName(String(call.name || 'tool')),
        arguments: argsOf(call.arguments),
        readOnlyHint: true,
        status: failed ? 'failed' : 'completed',
        result: { content: [{ type: 'text', text: output || '' }], isError: failed, _meta: {} },
        duration: { secs: Math.floor(elapsed / 1000), nanos: (elapsed % 1000) * 1000000 },
      }, call.at || ts, ts)
    }
  }
  endTurn(ms(list.length ? list[list.length - 1].time : created, created))

  const firstUser = records.find((r) => r.type === 'response_item' && r.payload.role === 'user')
  const firstText = firstUser
    ? firstUser.payload.content.filter((p) => p.type === 'input_text').map((p) => p.text).join('\n')
    : ''
  return {
    records,
    sessionId,
    turnCount: turnIds.length,
    firstUserMessage: firstText,
    preview: (title || firstText || '').slice(0, 200),
    model: model || template.model || null,
    reasoningEffort: reasoningEffort || template.reasoning_effort || null,
    updatedAt: ms(list.length ? list[list.length - 1].time : created, created),
  }
}

/** rollout 落盘路径：<codexHome>/sessions/YYYY/MM/DD/rollout-<ISO(本地时间)>-<uuid>.jsonl */
export function rolloutPathFor(codexHome, sessionId, createdAt) {
  const d = new Date(Number.isFinite(createdAt) ? createdAt : Date.now())
  const yyyy = String(d.getFullYear())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const stamp = d.getFullYear() + '-' + mm + '-' + dd + 'T' +
    String(d.getHours()).padStart(2, '0') + '-' + String(d.getMinutes()).padStart(2, '0') + '-' +
    String(d.getSeconds()).padStart(2, '0')
  return join(codexHome, 'sessions', yyyy, mm, dd, 'rollout-' + stamp + '-' + sessionId + '.jsonl')
}

/** 在 threads 表登记一行（Codex 的会话索引；项目归属靠 cwd 与 project_roots 的路径匹配）。 */
export async function insertCodexThread(codexHome, { sessionId, rolloutPath, cwd, title, template, serialized }) {
  const db = await openStateDb(codexHome)
  if (!db) throw new Error('Codex 库不存在：' + join(codexHome, 'state_5.sqlite'))
  const t = template || {}
  const created = ms(serialized.createdAt, Date.now())
  const updated = ms(serialized.updatedAt, created)
  const row = {
    id: sessionId,
    rollout_path: rolloutPath,
    created_at: Math.round(created / 1000),
    updated_at: Math.round(updated / 1000),
    source: 'vscode',
    model_provider: t.model_provider || 'openai',
    cwd,
    title: title || serialized.firstUserMessage || sessionId,
    sandbox_policy: t.sandbox_policy || '{"type":"disabled"}',
    approval_mode: 'never',
    tokens_used: 0,
    has_user_event: serialized.firstUserMessage ? 1 : 0,
    archived: 0,
    cli_version: t.cli_version || '',
    first_user_message: serialized.firstUserMessage || '',
    memory_mode: t.memory_mode || 'enabled',
    model: serialized.model,
    reasoning_effort: serialized.reasoningEffort,
    created_at_ms: Math.round(created),
    updated_at_ms: Math.round(updated),
    thread_source: 'user',
    preview: serialized.preview || '',
    recency_at: Math.round(updated / 1000),
    recency_at_ms: Math.round(updated),
    history_mode: 'paginated',
    name: title || null,
    is_pinned: 0,
    originator: t.originator || 'Codex Desktop',
    creator_user_id: t.creator_user_id || null,
    creator_account_id: t.creator_account_id || null,
  }
  const cols = Object.keys(row)
  try {
    db.prepare(
      `insert or replace into threads (${cols.join(',')}) values (${cols.map(() => '?').join(',')})`,
    ).run(...cols.map((c) => row[c]))
    return row
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

/** 让 Codex 自己把 rollout 投影进 thread_history（幂等：已迁移过会返回 already_paginated）。 */
export function migrateCodexThread(codexBin, sessionId, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    if (!codexBin) return resolve({ ok: false, skipped: true, reason: '找不到 codex 可执行文件' })
    execFile(codexBin, ['migrate-rollouts', '--apply', '--thread', sessionId, '--json'],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const text = String(stdout || '') + '\n' + String(stderr || '')
        let report = null
        try { report = JSON.parse(String(stdout || '{}')) } catch { report = null }
        if (err && !report) {
          return resolve({ ok: false, reason: String((err && err.message) || err) + ' ' + text.slice(0, 400) })
        }
        // 实测 0.169.0-alpha 的输出是 {"outcomes":[{thread_id, rollout_path, status, bytes_processed, message}]}；
        // 早期版本用过 "threads"，两种都认，免得 Codex 升级又静默判失败。
        const list = report && Array.isArray(report.outcomes)
          ? report.outcomes
          : (report && Array.isArray(report.threads) ? report.threads : [])
        const entry = list.find((t) => t && t.thread_id === sessionId) || null
        const status = entry ? entry.status : null
        const good = status === 'migrated' || status === 'already_paginated'
        return resolve({
          ok: good,
          status,
          bytesProcessed: entry ? entry.bytes_processed : null,
          reason: good ? undefined : (entry && (entry.failure_reason || entry.message)) || text.slice(0, 400),
        })
      })
  })
}

/**
 * 把序列化结果装进 Codex 库位：写 rollout → 登记 threads 行 → 触发投影迁移。
 * 三步任何一步失败都如实上报（partial 结果里保留已完成的步骤，便于用户手工收尾）。
 */
export async function installCodexSession({
  codexHome,
  codexBin,
  sessionId,
  serialized,
  cwd,
  title,
  template,
  createdAt,
  dryRun = false,
}) {
  const rolloutPath = rolloutPathFor(codexHome, sessionId, ms(createdAt, Date.now()))
  const jsonl = serialized.records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  if (dryRun === true) {
    return { rolloutPath, jsonl, dryRun: true, thread: null, migration: null }
  }
  await mkdir(dirname(rolloutPath), { recursive: true })
  await writeFile(rolloutPath, jsonl, { encoding: 'utf8', flag: 'w' })
  const thread = await insertCodexThread(codexHome, {
    sessionId, rolloutPath, cwd, title, template,
    serialized: { ...serialized, createdAt: ms(createdAt, Date.now()) },
  })
  const migration = await migrateCodexThread(codexBin, sessionId)
  return { rolloutPath, jsonl, thread, migration, dryRun: false }
}
