// lib/session-handoff.mjs — 会话交接包（handoff package）的提取与渲染（纯函数 + 一个落盘器）
//
// 文件名的由来：插件自带 lib/handoff.mjs（外部 transcript → 交接摘要，供 /resume-claude、
// /resume-codex 用）。那个模块与本模块职责不同（一个是「读别人的历史」，一个是「写自己的
// 交接包」），所以本模块独立命名，绝不覆盖插件原有文件。
//
// 为什么需要这一层：把整条历史塞进目标模型的上下文是错的方向。一次真实导出 917375 字符
// ≈ 25.5 万 token，其中真正的人类/模型对话只有 13108 字符（1.4%），另外 98.6% 是工具日志
// ——为了带走 1.4% 而压缩 98.6%，得到的是一份残缺档案。正确的分法是：
//   1) 交接副本（handoff.md + 最近几轮原文）→ 注入目标会话的上下文，体量恒定、与原会话
//      长度无关，接手的模型先读懂「工作状态」；
//   2) 完整档案（original.jsonl / turns/ / tool-outputs/ / assets/）→ 落到项目目录，
//      目标模型需要细节时自己 grep/read，永不受上下文预算约束。
//
// 提取是确定性的（正则 + 结构化字段），不调用任何模型：导出路径上不能依赖 LLM 可用性，
// 而且这样每个数字都能被复核。质量取舍写在 README：它保证「不丢关键锚点」，不保证文笔。
//
// 纯函数部分（collectTurns / buildHandoffModel / render*）零 I/O、零 DSH 依赖，可单独自检；
// 落盘部分 writeHandoffArchive 收 ctx 只为读图片字节，失败按降级计数，不中断导出。

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'
import { sanitizeToolName, clampToolOutput, clampToolArguments } from './export/common.mjs'
import { readAttachmentBytes } from './attachments.mjs'

/** 归档目录相对项目根的路径（默认就放这里；用户可改）。 */
export const HANDOFF_REL_DIR = join('.dsh', 'session-handoff')

/** 交接副本里 handoff.md 的字符上限。约 6.6k token ≈ 258400 窗口的 2.6%。 */
export const HANDOFF_MAX_CHARS = 24000

/** 默认带过去的最近对话轮数（完整轮，不含中间工具往返）。 */
export const DEFAULT_RECENT_TURNS = 3

/** 单条长工具输出超过这个长度就单独落一个文件，交接书里只留首行 + 指针。 */
export const LONG_OUTPUT_CHARS = 2000

/** 写进 .git/info/exclude 的那一行（本地排除，不动项目正式的 .gitignore）。 */
export const GIT_EXCLUDE_LINE = HANDOFF_REL_DIR.split(sep).join('/') + '/'

/**
 * 迁移副本的字符预算。用户的决定是「交接书 + 最近对话合计控制在目标窗口 5% 左右」：
 * 258400 窗口 × 3.6 字符/token × 5% ≈ 46500 字符。这里留一点余量取 46000。
 */
export const COPY_MAX_CHARS = 46000

/**
 * 硬上限：超过它就真的会把目标窗口顶爆，必须继续压。
 *
 * 为什么需要两个阈值：一次对话轮次可能很长（实测某一轮 14 条助手消息、正文 34k 字符），
 * 单轮就接近 5% 软目标。此时把它压到 5% 只能靠砍正文，反而伤续聊质量——软目标是
 * 「尽量小」，硬上限才是「不能爆」。两者分开，阶梯在软目标够不到时停止恶化，如实报告
 * fitted:false，而不是一路砍到只剩骨架。258400 × 3.6 × 20% ≈ 186000。
 */
export const COPY_HARD_MAX_CHARS = 186000

/**
 * 迁移副本仍超预算时的收紧阶梯，每档 = [轮数, 工具输出上限, 参数上限, 早期助手正文上限]。
 *
 * 两条排序原则（都很关键）：
 *   1. **先钳内容、后减轮数**。轮数是「迁移多少工作状态」，减轮数直接丢上下文；钳工具输出
 *      只是丢证据。所以前三档都在 3 轮上收紧，只有钳到最紧仍装不下时才退到 2 轮、1 轮。
 *      （早期版本顺序反了，结果为了凑 5% 软目标把 3 轮砍成 1 轮，属于本末倒置。）
 *   2. 助手正文那一列是必需的：阶梯若只能缩工具输出，遇到「一轮里助手说了很多」的会话
 *      就压不动（实测真实会话里助手正文占副本 58%，工具输出只占 14%）。0 表示不钳正文。
 */
export const COPY_SHRINK_LADDER = Object.freeze([
  Object.freeze([3, 4000, 4000, 0]),
  Object.freeze([3, 2000, 2000, 0]),
  Object.freeze([3, 1000, 800, 6000]),
  Object.freeze([3, 600, 400, 3000]),
  Object.freeze([2, 600, 400, 3000]),
  Object.freeze([1, 400, 300, 2000]),
])

const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
const clip = (s, n) => {
  const t = String(s == null ? '' : s)
  return t.length <= n ? t : t.slice(0, n) + '…'
}
const tsOf = (ev, fallback) => (ev && Number.isFinite(ev.time) ? ev.time : fallback)
const isoOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().replace('.000Z', 'Z') : '')

// ── 事件 → 轮次 ────────────────────────────────────────────────────────────────

/**
 * 给每个事件标上「属于第几轮」。为什么单独一个纯函数：轮次信息在两个地方要用（提取交接书、
 * 组装迁移副本），而复用同一套归属规则才能保证「注入的轮次」和「交接书写的轮次」是同一批。
 *
 * 两类日志都要吃得下：
 *   1) 正常日志：turn/start 或事件自带 data.turn；
 *   2) 没有轮次线索的日志（老版本、或测试/手工构造的事件）：按顺序把每条真实提问开成新轮，
 *      其后的助手消息与工具调用归到当前轮。没有这条兜底，这类会话会被判成「0 轮」，
 *      整段对话在交接副本里凭空消失。
 */
function annotateTurns(events) {
  const list = Array.isArray(events) ? events : []
  const out = []
  let curTurn = null
  let synth = 0
  let real = false
  for (const ev of list) {
    if (!ev || typeof ev.type !== 'string') continue
    const data = ev.data || {}
    if (ev.type === 'turn/start' && Number.isFinite(data.turn)) { curTurn = data.turn; real = true }
    if (Number.isFinite(data.turn)) { curTurn = data.turn; real = true }
    const isRealUser = ev.type === 'user/message' && data.source && data.source.kind === 'user'
    if (!real) {
      if (isRealUser) { synth += 1; curTurn = synth } else if (synth === 0) continue
      else curTurn = synth
    }
    if (!Number.isFinite(curTurn)) continue
    out.push({ ev, turn: curTurn })
  }
  return out
}

/**
 * 把 DSH 事件聚成轮次。每轮收：用户文本（只认 source.kind === 'user' 的真实提问，注入型
 * 消息不算）、助手文本（含 reasoning 与否由 includeReasoning 决定，默认不要——推理过程是
 * 模型的草稿，不是工作状态）、工具调用（名字/参数/输出/是否失败）。
 *
 * 轮次归属见 annotateTurns；`user/message` 本身没有 turn 字段，所以只能按顺序判。
 * @returns [{ turn, startedAt, userTexts[], userImages[], assistantTexts[], calls[] }]
 */
export function collectTurns(events, { includeReasoning = false } = {}) {
  const byTurn = new Map()
  const bucket = (n) => {
    if (!byTurn.has(n)) {
      byTurn.set(n, { turn: n, startedAt: null, userTexts: [], userImages: [], assistantTexts: [], calls: [] })
    }
    return byTurn.get(n)
  }
  const callsById = new Map()
  for (const { ev, turn: turnNo } of annotateTurns(events)) {
    const data = ev.data || {}
    const t = bucket(turnNo)
    if (t.startedAt === null) t.startedAt = tsOf(ev, null)
    if (ev.type === 'user/message') {
      if (!(data.source && data.source.kind === 'user')) continue
      const blocks = Array.isArray(data.content) ? data.content : []
      for (const b of blocks) {
        if (!b) continue
        if (b.type === 'text' && typeof b.text === 'string') t.userTexts.push(b.text)
        else if (b.type === 'image') t.userImages.push(b)
      }
      continue
    }
    if (ev.type === 'assistant/message') {
      const msg = data.message || {}
      const blocks = Array.isArray(msg.content) ? msg.content : []
      for (const b of blocks) {
        if (!b) continue
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) t.assistantTexts.push(b.text)
        else if (includeReasoning && b.type === 'reasoning' && typeof b.text === 'string' && b.text.trim()) {
          t.assistantTexts.push('[推理] ' + b.text)
        }
      }
      continue
    }
    if (ev.type === 'tool/call') {
      const call = {
        turn: turnNo,
        callId: data.callId || '',
        name: sanitizeToolName(data.name),
        rawName: typeof data.name === 'string' ? data.name : '',
        args: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}),
        output: '',
        isError: false,
        at: tsOf(ev, null),
      }
      t.calls.push(call)
      if (call.callId) callsById.set(call.callId, call)
      continue
    }
    if (ev.type === 'tool/result') {
      const msg = data.message || {}
      const callId = msg.toolCallId || (msg.source && msg.source.callId) || data.callId
      const blocks = Array.isArray(msg.content) ? msg.content : []
      const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text).join('\n')
      const call = callId ? callsById.get(callId) : null
      if (call) {
        call.output = text
        call.isError = msg.isError === true
      } else if (callId) {
        // 结果没有对应的 call（跨轮/被裁剪）：单独记一条，别把证据丢了
        t.calls.push({
          turn: turnNo, callId, name: 'unknown', rawName: '', args: '', output: text, isError: msg.isError === true, at: tsOf(ev, null),
        })
      }
      continue
    }
  }
  return [...byTurn.values()].sort((a, b) => a.turn - b.turn)
}

/** 轮次的纯文本形态（用户提问 + 助手答复），用于判断这一轮「有没有实际内容」。 */
export function turnText(turn) {
  return {
    user: (turn.userTexts || []).map(oneLine).filter(Boolean).join(' / '),
    assistant: (turn.assistantTexts || []).map((s) => String(s).trim()).filter(Boolean).join('\n\n'),
  }
}

// ── 各段提取 ──────────────────────────────────────────────────────────────────

const PATH_KEYS = ['path', 'filePath', 'file_path', 'file', 'target', 'filename']
const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch', 'notebook_edit', 'create_file', 'str_replace_editor'])

/** 从工具调用里抽被修改的文件（只认写类工具，读文件不算改动）。 */
export function extractTouchedFiles(turns) {
  const hits = new Map()
  for (const turn of turns) {
    for (const call of turn.calls) {
      if (!WRITE_TOOLS.has(call.name)) continue
      let parsed = null
      try { parsed = JSON.parse(call.args) } catch { parsed = null }
      const paths = []
      if (parsed && typeof parsed === 'object') {
        for (const key of PATH_KEYS) {
          if (typeof parsed[key] === 'string' && parsed[key].trim()) paths.push(parsed[key].trim())
        }
        if (Array.isArray(parsed.paths)) {
          for (const p of parsed.paths) if (typeof p === 'string' && p.trim()) paths.push(p.trim())
        }
      }
      for (const p of paths) {
        const prev = hits.get(p) || { path: p, count: 0, turns: new Set(), tool: call.name }
        prev.count++
        prev.turns.add(turn.turn)
        hits.set(p, prev)
      }
    }
  }
  return [...hits.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
}

const VERIFY_COMMAND = /(test|check|verify|自检|断言|build|lint|tsc|eslint|vitest|jest|node --check)/i
const VERIFY_PASS = /(全绿|通过|passed|passing|\bPASS\b|✓|ok: true|exit code: 0|exit 0)/i
const VERIFY_FAIL = /(失败|不通过|\bFAIL\b|✗|Error:|错误|exit code: [1-9])/i

/**
 * 从「测试类工具调用」里抽验证结果（命令 + 通过/失败 + 一行结论）。
 * 只认两种证据：命令本身是测试类（`node --check`、`vitest run`、`npm test`…），
 * 且输出里有明确的通过/失败信号。既无信号也无失败的调用不算结果——写进交接书只是噪声。
 */
export function extractVerification(turns) {
  const rows = []
  for (const turn of turns) {
    for (const call of turn.calls) {
      const out = call.output || ''
      if (!out) continue
      let command = call.args || ''
      try {
        const parsed = JSON.parse(call.args || '{}')
        if (parsed && typeof parsed.command === 'string') command = parsed.command
        else if (parsed && typeof parsed.script === 'string') command = parsed.script
      } catch { /* 参数不是 JSON：就用原文头部 */ }
      if (!VERIFY_COMMAND.test(command.slice(0, 400))) continue
      const pass = VERIFY_PASS.test(out)
      const fail = VERIFY_FAIL.test(out)
      if (call.isError || (fail && !pass)) {
        const line = out.split('\n').find((l) => VERIFY_FAIL.test(l)) || out.split('\n').find((l) => l.trim()) || ''
        rows.push({ turn: turn.turn, name: call.name, verdict: '失败', summary: clip(oneLine(line), 200) })
        continue
      }
      if (pass) {
        // 取真正带「通过」信号的那一行，比首行有信息量（首行往往是命令回显）
        const line = out.split('\n').find((l) => VERIFY_PASS.test(l)) || ''
        rows.push({ turn: turn.turn, name: call.name, verdict: '通过', summary: clip(oneLine(line), 200) })
      }
    }
  }
  return rows.slice(-20)
}

const DECISION_MARK = /(决定|选定|改用|换成|不再|因为|所以|instead of|chose|decided|better to|must not|不能)/i

/**
 * 从助手正文里抽「决策句」：一行一句，去重、限长。
 * 限 220 字符是有意的——决策的价值在「选择了什么 + 为什么」，超出部分通常是细节，
 * 细节留在 turns/ 全文里，不必挤占交接书预算。
 */
export function extractDecisions(turns, limit = 24) {
  const out = []
  const seen = new Set()
  for (const turn of turns) {
    for (const text of turn.assistantTexts) {
      for (const rawLine of String(text).split(/\n+/)) {
        const line = oneLine(rawLine.replace(/^[-*•\d.)\s]+/, ''))
        if (line.length < 12) continue
        if (!DECISION_MARK.test(line)) continue
        const key = line.slice(0, 60)
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ turn: turn.turn, line: clip(line, 220) })
      }
    }
  }
  return out.slice(-limit)
}

const TODO_MARK = /(TODO|FIXME|待办|未完成|还没|尚未|下一步|遗留|未解决|待确认|需要你|没有实现|尚未验证)/i

/** 从助手正文里抽未完成/待办句。 */
export function extractOpenItems(turns, limit = 20) {
  const out = []
  const seen = new Set()
  for (const turn of turns) {
    for (const text of turn.assistantTexts) {
      for (const rawLine of String(text).split(/\n+/)) {
        const line = oneLine(rawLine.replace(/^[-*•\d.)\s]+/, ''))
        if (line.length < 10) continue
        if (!TODO_MARK.test(line)) continue
        const key = line.slice(0, 50)
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ turn: turn.turn, line: clip(line, 220) })
      }
    }
  }
  return out.slice(-limit)
}

/**
 * 项目目标：标题 + 最早一条真实用户提问 + 最近一条（用首尾两句，既看起点也看最终诉求）。
 * 只取首尾而不是罗列全部，是因为中间轮次往往是过程指令（「继续」「然后呢」），信息量低。
 */
export function extractGoal(turns, title) {
  const real = []
  for (const turn of turns) {
    for (const text of turn.userTexts) {
      const line = oneLine(text)
      if (!line) continue
      real.push({ turn: turn.turn, line: clip(line, 200) })
      break
    }
  }
  if (real.length === 0) return { title: oneLine(title), opens: [] }
  if (real.length === 1) return { title: oneLine(title), opens: real }
  return { title: oneLine(title), opens: [real[0], real[real.length - 1]] }
}

// ── 模型 ──────────────────────────────────────────────────────────────────────

/**
 * 汇总成交接书需要的一切（纯函数，不再碰 I/O）。
 * @returns { sessionId, title, cwd, createdAt, turns, goal, files, verification, decisions, openItems, nextStep, stats }
 */
export function buildHandoffModel(events, {
  sessionId,
  title = '',
  cwd = '',
  createdAt = null,
  includeReasoning = false,
} = {}) {
  const turns = collectTurns(events, { includeReasoning })
  const withUser = turns.filter((t) => turnText(t).user)
  const last = withUser[withUser.length - 1] || null
  const nextStep = last ? clip(String(turnText(last).assistant).trim(), 1200) : ''
  const toolCalls = turns.reduce((n, t) => n + t.calls.length, 0)
  const failedCalls = turns.reduce((n, t) => n + t.calls.filter((c) => c.isError).length, 0)
  return {
    sessionId: String(sessionId || ''),
    title: oneLine(title),
    cwd: typeof cwd === 'string' ? cwd : '',
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
    turns,
    goal: extractGoal(turns, title),
    files: extractTouchedFiles(turns),
    verification: extractVerification(turns),
    decisions: extractDecisions(turns),
    openItems: extractOpenItems(turns),
    nextStep,
    stats: {
      turns: turns.length,
      userTurns: withUser.length,
      toolCalls,
      failedCalls,
      events: Array.isArray(events) ? events.length : 0,
      images: turns.reduce((n, t) => n + t.userImages.length, 0),
    },
  }
}

// ── 渲染 ──────────────────────────────────────────────────────────────────────

const turnFileName = (turnNo) => String(turnNo).padStart(3, '0') + '.md'
const safeName = (s) => String(s || 'x').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)

/**
 * handoff.md 正文（八段固定结构，见 README）。archiveRel 是归档目录相对项目根的路径，
 * 用于给接手方相对路径指针；archiveAbs 在 cwd 未知时兜底成绝对路径。
 */
export function renderHandoffMarkdown(model, { archiveRel = '', archiveAbs = '', now = Date.now() } = {}) {
  const lines = []
  const title = model.title || model.sessionId || '（无标题会话）'
  lines.push('# 会话交接书 · ' + title)
  lines.push('')
  lines.push('> 由 DSH「会话迁移」于 ' + isoOf(now) + ' 自动生成（确定性提取，未经模型改写）。')
  lines.push('> 源会话 `' + model.sessionId + '`' + (model.cwd ? ' · cwd `' + model.cwd + '`' : ''))
  if (archiveRel || archiveAbs) {
    lines.push('> 完整历史归档：`' + (archiveRel || archiveAbs) + '`（`index.md` 索引 · `original.jsonl` 原始事件 · `turns/` 逐轮全文 · `tool-outputs/` 长输出 · `assets/` 图片）')
    lines.push('> 本文件是**交接副本**，为装进上下文做过取舍；完整档案未做任何截断。需要细节时按第 8 段检索原始文件，不要只凭本文件臆断。')
  }
  lines.push('>')
  lines.push('> 统计：' + model.stats.userTurns + ' 轮用户提问 · ' + model.stats.toolCalls
    + ' 次工具调用（失败 ' + model.stats.failedCalls + '）· 源事件 ' + model.stats.events
    + (model.stats.images ? ' · 图片 ' + model.stats.images + ' 张' : ''))
  lines.push('')

  lines.push('## 1. 项目目标')
  lines.push('')
  if (model.goal.title) lines.push('- 会话标题：' + model.goal.title)
  if (model.goal.opens.length === 0) {
    lines.push('- （这个会话没有可提取的用户提问）')
  } else if (model.goal.opens.length === 1) {
    lines.push('- 用户原话（第 ' + model.goal.opens[0].turn + ' 轮）：' + model.goal.opens[0].line)
  } else {
    const first = model.goal.opens[0]
    const last = model.goal.opens[model.goal.opens.length - 1]
    lines.push('- 起点（第 ' + first.turn + ' 轮）：' + first.line)
    lines.push('- 最终诉求（第 ' + last.turn + ' 轮）：' + last.line)
  }
  lines.push('')

  lines.push('## 2. 已完成工作（按轮次）')
  lines.push('')
  if (model.stats.userTurns === 0) {
    lines.push('（无可提取的轮次）')
  } else {
    const shown = model.turns.filter((t) => turnText(t).user)
    for (const t of shown) {
      const u = clip(turnText(t).user, 120)
      const a = clip(oneLine(turnText(t).assistant), 180)
      const files = extractTouchedFiles([t]).map((f) => f.path)
      lines.push('- **第 ' + t.turn + ' 轮** 用户：' + u)
      if (a) lines.push('  - 处理：' + a)
      const meta = []
      if (t.calls.length) meta.push('工具 ' + t.calls.length + ' 次')
      if (files.length) meta.push('改 ' + files.map((p) => '`' + clip(p, 70) + '`').join('、'))
      if (meta.length) lines.push('  - ' + meta.join(' · '))
    }
  }
  lines.push('')

  lines.push('## 3. 技术决策（为什么这么做）')
  lines.push('')
  if (model.decisions.length === 0) lines.push('（未从助手正文里识别到决策句；见 `turns/` 原文）')
  else for (const d of model.decisions) lines.push('- 第 ' + d.turn + ' 轮：' + d.line)
  lines.push('')

  lines.push('## 4. 修改文件')
  lines.push('')
  if (model.files.length === 0) lines.push('（本次会话没有记录到写文件类工具调用）')
  else {
    lines.push('| 文件 | 写入次数 | 涉及轮次 | 工具 |')
    lines.push('| --- | --- | --- | --- |')
    for (const f of model.files.slice(0, 60)) {
      lines.push('| `' + f.path + '` | ' + f.count + ' | ' + [...f.turns].join(', ') + ' | ' + f.tool + ' |')
    }
    if (model.files.length > 60) lines.push('')
    if (model.files.length > 60) lines.push('（另有 ' + (model.files.length - 60) + ' 个文件，见 `index.md`）')
  }
  lines.push('')

  lines.push('## 5. 测试与验证')
  lines.push('')
  if (model.verification.length === 0) lines.push('（未识别到测试类调用；不代表没有验证，见 `tool-outputs/`）')
  else {
    for (const v of model.verification) {
      lines.push('- 第 ' + v.turn + ' 轮 `' + v.name + '` → **' + v.verdict + '**' + (v.summary ? '：' + v.summary : ''))
    }
  }
  lines.push('')

  lines.push('## 6. 未解决问题')
  lines.push('')
  if (model.openItems.length === 0) lines.push('（未识别到明确的未完成项）')
  else for (const o of model.openItems) lines.push('- 第 ' + o.turn + ' 轮：' + o.line)
  lines.push('')

  lines.push('## 7. 下一步任务（最后一轮助手的收尾）')
  lines.push('')
  lines.push(model.nextStep ? model.nextStep : '（最后一轮没有文本答复）')
  lines.push('')

  lines.push('## 8. 历史索引')
  lines.push('')
  if (archiveRel || archiveAbs) {
    lines.push('- 完整档案：`' + (archiveRel || archiveAbs) + '/`')
    lines.push('- `index.md`：文件清单 + 轮次表')
    lines.push('- `original.jsonl`：源事件逐行原文（未截断）')
    lines.push('- `turns/NNN.md`：每轮的用户/助手全文与工具调用表')
    lines.push('- `tool-outputs/`：超过 ' + LONG_OUTPUT_CHARS + ' 字符的工具输出全文')
    lines.push('- `assets/`：会话里的图片原文件')
    lines.push('')
  }
  lines.push('| 轮次 | 时间 | 用户提问（截断） | 工具 | 归档 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const t of model.turns) {
    const u = oneLine(turnText(t).user)
    lines.push('| ' + t.turn + ' | ' + (isoOf(t.startedAt) || '-') + ' | ' + clip(u, 70).replace(/\|/g, '\\|')
      + ' | ' + t.calls.length + ' | `turns/' + turnFileName(t.turn) + '` |')
  }
  lines.push('')
  return lines.join('\n')
}

/** index.md：档案自身的清单，接手方先读它就知道去哪找。 */
export function renderIndexMarkdown(model, { files = [], now = Date.now() } = {}) {
  const lines = []
  lines.push('# 历史档案索引 · ' + (model.title || model.sessionId))
  lines.push('')
  lines.push('- 源会话：`' + model.sessionId + '`')
  if (model.cwd) lines.push('- cwd：`' + model.cwd + '`')
  if (model.createdAt) lines.push('- 创建时间：' + isoOf(model.createdAt))
  lines.push('- 导出时间：' + isoOf(now))
  lines.push('- 统计：' + model.stats.userTurns + ' 轮 / ' + model.stats.toolCalls + ' 次工具调用 / ' + model.stats.events + ' 事件')
  lines.push('')
  lines.push('## 文件清单')
  lines.push('')
  if (files.length === 0) lines.push('（未列出）')
  else for (const f of files) lines.push('- `' + f + '`')
  lines.push('')
  lines.push('## 轮次表')
  lines.push('')
  lines.push('| 轮次 | 时间 | 用户提问 | 助手回复首行 | 工具 | 归档 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const t of model.turns) {
    const u = oneLine(turnText(t).user)
    const a = oneLine(turnText(t).assistant)
    lines.push('| ' + t.turn + ' | ' + (isoOf(t.startedAt) || '-') + ' | ' + clip(u, 60).replace(/\|/g, '\\|')
      + ' | ' + clip(a, 60).replace(/\|/g, '\\|') + ' | ' + t.calls.length + ' | `turns/' + turnFileName(t.turn) + '` |')
  }
  lines.push('')
  return lines.join('\n')
}

/** turns/NNN.md：单轮全文（工具输出超过 LONG_OUTPUT_CHARS 时只留首行 + 指针）。 */
export function renderTurnMarkdown(model, turn) {
  const lines = []
  const { user, assistant } = turnText(turn)
  lines.push('# 第 ' + turn.turn + ' 轮 · ' + (isoOf(turn.startedAt) || '-'))
  lines.push('')
  lines.push('## 用户')
  lines.push('')
  lines.push(user || '（这一轮没有用户文本' + (turn.userImages.length ? '，只有 ' + turn.userImages.length + ' 张图片' : '') + '）')
  if (turn.userImages.length) {
    lines.push('')
    for (let i = 0; i < turn.userImages.length; i++) lines.push('- 图片 ' + (i + 1) + '：`assets/turn-' + turnFileName(turn.turn).replace(/\.md$/, '') + '-img' + (i + 1) + '.png`')
  }
  lines.push('')
  lines.push('## 助手')
  lines.push('')
  lines.push(assistant || '（这一轮没有助手文本）')
  lines.push('')
  if (turn.calls.length) {
    lines.push('## 工具调用（' + turn.calls.length + ' 次）')
    lines.push('')
    lines.push('| # | 工具 | 参数摘要 | 结果 |')
    lines.push('| --- | --- | --- | --- |')
    turn.calls.forEach((c, i) => {
      lines.push('| ' + (i + 1) + ' | `' + c.name + '` | ' + clip(oneLine(c.args), 120).replace(/\|/g, '\\|')
        + ' | ' + (c.isError ? '失败' : 'ok') + ' · ' + c.output.length + ' 字符 |')
    })
    lines.push('')
    lines.push('### 工具输出')
    lines.push('')
    turn.calls.forEach((c, i) => {
      lines.push('#### ' + (i + 1) + '. `' + c.name + '`')
      lines.push('')
      if (!c.output) { lines.push('（无输出）'); lines.push(''); return }
      if (c.output.length > LONG_OUTPUT_CHARS) {
        lines.push('首行：' + oneLine(c.output.split('\n')[0]))
        lines.push('')
        lines.push('（输出 ' + c.output.length + ' 字符，全文见 `tool-outputs/' + turnFileName(turn.turn).replace(/\.md$/, '')
          + '-' + (i + 1) + '-' + safeName(c.name) + '.txt`）')
        lines.push('')
        return
      }
      lines.push('```text')
      lines.push(c.output.slice(0, LONG_OUTPUT_CHARS))
      lines.push('```')
      lines.push('')
    })
  }
  return lines.join('\n')
}

/** 长工具输出的独立文件名 → 内容。 */
export function longOutputFiles(model) {
  const out = []
  for (const turn of model.turns) {
    turn.calls.forEach((c, i) => {
      if (c.output.length <= LONG_OUTPUT_CHARS) return
      const name = turnFileName(turn.turn).replace(/\.md$/, '') + '-' + (i + 1) + '-' + safeName(c.name) + '.txt'
      out.push({ name, content: '# 第 ' + turn.turn + ' 轮 · 工具 ' + c.name + ' · callId ' + (c.callId || '-') + '\n\n'
        + '## 参数\n\n' + c.args + '\n\n## 输出（' + c.output.length + ' 字符，未截断）\n\n' + c.output + '\n' })
    })
  }
  return out
}

// ── 注入：交接副本 + 最近几轮 ────────────────────────────────────────────────────

/**
 * 为目标格式组装「该注入的事件」：一条合成的用户消息（交接书正文）+ 真实事件。
 *
 * 两种模式：
 *   - 默认（`keepAllTurns:false`）：只保留最近 N 个轮次的全部事件。
 *   - `keepAllTurns:true`：**每个轮次的「人说的话」都留下**（真实用户提问 + 助手正文），
 *     只有工具流量（`tool/call`、`tool/result`）限制在最近 N 轮。
 *
 * 为什么要有第二种：只留最近 1~3 轮时，导入到目标宿主里的会话读起来是「一大段交接书 +
 * 最后一轮」，前面的对话整段消失——用户会以为迁移失败（实测反馈：「对话就是这个样子，
 * 到头了」）。而工具流量才是体积大头：把所有轮次的人话都留下、只压工具细节，实测比
 * 「保留 3 轮全量」还小。
 *
 * @returns { events, keptTurns, droppedTurns, handoffChars, toolTurns }
 */
export function withHandoffEvents(events, {
  handoffText = '',
  recentTurns = DEFAULT_RECENT_TURNS,
  createdAt = null,
  keepAllTurns = false,
} = {}) {
  const list = Array.isArray(events) ? events : []
  const text = clip(String(handoffText || ''), HANDOFF_MAX_CHARS)
  if (!text) return { events: list, keptTurns: [], droppedTurns: 0, handoffChars: 0, toolTurns: 0 }
  const all = collectTurns(list).filter((t) => turnText(t).user)
  const keep = all.slice(-Math.max(1, recentTurns)).map((t) => t.turn)
  const set = new Set(keep)
  // 用 annotateTurns 而不是读 ev.data.turn：没有轮次线索的日志里 ev.data.turn 全是 undefined，
  // 那样过滤会把整段对话筛空，只剩合成的交接书一条。
  const kept = annotateTurns(list).filter(({ turn, ev }) => {
    if (ev.type === 'user/message') {
      // 丢掉宿主注入的假用户消息（runtime-context / skill-catalog / time-context /
      // user-approval 等）：它们在 DSH 里是内部上下文，写进目标格式只会被当成用户发言，
      // 而且 skill-catalog 这类单条就能吃掉几千字符预算。真实提问（kind='user'）保留。
      const kind = ev.data && ev.data.source ? ev.data.source.kind : ''
      if (kind !== 'user') return false
      // keepAllTurns：所有轮次的提问都留（对话读起来才完整）；默认模式仍只看最近几轮。
      return keepAllTurns ? true : set.has(turn)
    }
    // 助手正文永远留下（keepAllTurns 模式下所有轮次，否则只留最近几轮）。
    if (keepAllTurns && ev.type === 'assistant/message') return true
    return set.has(turn)
  }).map(({ turn, ev }) => {
    if (!keepAllTurns || ev.type !== 'assistant/message' || set.has(turn)) return ev
    // 掉出工具窗口的轮次：摘掉 tool-call 块，其余块（正文、推理、图片）都要留下。否则会留下
    // 找不到结果的工具调用，目标格式（claude 的 tool_use）会因为配不上 tool_result 而拒绝整段历史。
    // 这里用「排除 tool-call」而不是「只留 text/reasoning」：图片属于内容而不是工具明细，
    // 按白名单过滤会让「一条只有图片的助手消息」整条消失（上游 transfer 用例正是这种形状）。
    const data = ev.data || {}
    const msg = data.message || {}
    const blocks = Array.isArray(msg.content) ? msg.content : null
    if (!blocks) return ev
    const next = blocks.filter((b) => !(b && b.type === 'tool-call'))
    // 只有工具调用的那几条助手消息清空后没有内容可留，整条丢掉（工具明细本来就在档案里）。
    if (next.length === 0) return null
    return { ...ev, data: { ...data, message: { ...msg, content: next } } }
  }).filter(Boolean)
  const allTurnNos = all.map((t) => t.turn)
  // keepAllTurns 下「保留的轮次」是全部有提问的轮次（对话都在），recentTurns 只是工具细节的
  // 深度；droppedTurns 因此表示「工具细节被压掉的轮数」。
  const reported = keepAllTurns ? allTurnNos : keep
  const at = Number.isFinite(createdAt) ? createdAt : (tsOf(list[0], Date.now()) || Date.now())
  const head = {
    type: 'user/message',
    time: at,
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
      role: 'user',
      id: 'handoff-' + safeName(reported.join('-') || 'head'),
    },
  }
  return {
    events: [head, ...kept],
    keptTurns: reported,
    droppedTurns: keepAllTurns ? all.length - set.size : all.length - keep.length,
    handoffChars: text.length,
    toolTurns: set.size,
  }
}

/** 迁移副本的体积代理（事件 JSON 字符数；目标格式的序列化只会比它更小或相当）。 */
export function copyChars(events) {
  const list = Array.isArray(events) ? events : []
  let chars = 0
  for (const ev of list) chars += JSON.stringify(ev).length + 1
  return chars
}

/**
 * 迁移副本 + 预算回落。取舍维度是「工具细节的深度」：**每个轮次的对话（用户提问 + 助手正文）
 * 都保留**，阶梯只决定最近几轮还带完整工具流量（`tool/call` / `tool/result`）。交接书正文
 * 始终完整保留（它才是工作状态本身，被砍就失去迁移的意义）。
 *
 * 为什么不再按「保留几轮对话」回落：实测反馈是「对话就是这个样子，到头了」——把前面 7 轮
 * 整段丢掉，看到的会话就像迁移失败。而体积大头是工具流量而不是人话，所以保留全部人话、
 * 只压工具细节既更像完整对话，又比「保留 3 轮全量」更小。
 *
 * 为什么用字符代理而不是各格式的最终长度：出边有 claude / codex / codex-native / kimi /
 * opencode 五种序列化器，逐一序列化再回退代价过高（实测一次 codex-native 序列化要 1s 级）。
 * 事件 JSON 是共同上界，按它收紧后各格式必然也在预算内。
 *
 * @returns { events, keptTurns, droppedTurns, handoffChars, toolTurns, recentTurns, outputLimit,
 *            argumentLimit, assistantLimit, chars, maxChars, hardMaxChars, fitted, withinHardCap, attempt }
 */
export function fitCopyToBudget(events, {
  handoffText = '',
  recentTurns = DEFAULT_RECENT_TURNS,
  createdAt = null,
  maxChars = COPY_MAX_CHARS,
  hardMaxChars = COPY_HARD_MAX_CHARS,
  ladder = COPY_SHRINK_LADDER,
} = {}) {
  let last = null
  let withinHard = null
  const tiers = Array.isArray(ladder) && ladder.length > 0 ? ladder : COPY_SHRINK_LADDER
  for (let i = 0; i < tiers.length; i++) {
    const [turns, outputLimit, argumentLimit, assistantLimit] = tiers[i]
    // 阶梯里的轮数上限不得放宽调用方给的更小值（调用方显式要 1 轮就别给他 3 轮）。
    const want = Math.min(Math.max(1, turns), Math.max(1, recentTurns))
    const base = withHandoffEvents(events, { handoffText, recentTurns: want, createdAt, keepAllTurns: true })
    const tightened = clampCopyEvents(base.events, { outputLimit, argumentLimit, assistantLimit })
    const chars = copyChars(tightened)
    last = {
      ...base,
      events: tightened,
      recentTurns: want,
      toolTurns: base.toolTurns,
      outputLimit,
      argumentLimit,
      assistantLimit: Number.isFinite(assistantLimit) ? assistantLimit : 0,
      chars,
      maxChars,
      hardMaxChars,
      fitted: chars <= maxChars,
      withinHardCap: chars <= hardMaxChars,
      attempt: i,
    }
    if (chars <= maxChars) return last
    // 软目标（5%）够不到时（现在很常见：保留所有轮次的对话后，副本下限就在 7~8% 左右），
    // 取「仍装进硬上限、且体积最小」的那一档——而不是「工具轮数最多」：真实会话里多保留
    // 两轮工具明细要多花 5 万字符（17% vs 12%），而交接书第 3/4/5 段与 tool-outputs/ 已经
    // 覆盖了那些工具细节。硬上限（20%）是「不能爆」的最后一道闸。
    if (chars <= hardMaxChars && base.toolTurns >= 1) {
      if (!withinHard || chars < withinHard.chars) withinHard = last
    }
  }
  // 一档都装不进硬上限才一路压到底（此时已经没有「保留更多轮次」的余地了）。
  return withinHard || last
}

/**
 * 迁移副本里保留的事件类型白名单——五种序列化器（claude / codex / codex-native / kimi /
 * opencode）实际消费的全部类型，逐条对照源码得出。其余类型（`job/registered`、
 * `job/settled`、`step/*` 之外的后台事件、`session-log-deepseek/*`、`agent/inbox/spliced`、
 * `workspace/changes`、`session/end-seed`、`permission/*`、`sandbox/mode`）对任何目标格式
 * 都没有意义：实测在真实会话里它们占迁移副本 22%，删掉不影响任何一条输出记录。
 */
const COPY_KEEP_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'session/title',
  'session/imported',
])

/**
 * 把副本里与目标格式无关的大块内容剥掉、工具输出与参数就地钳到指定上限（返回新数组，
 * 不改原始事件）。
 *
 * 三处体积来源，实测在真实会话里分别占迁移副本的：
 *   1. `assistant/message.data.stream`（推理分片）**79%** —— 目标格式（claude / codex /
 *      kimi / opencode）没有一个消费它，它只是 DSH 的流式中间态。留着它，阶梯会被一路
 *      压到最狠一档仍然超预算，最后牺牲掉真正的最近对话——本末倒置。所以这里整块剥掉，
 *      连 usage 一起（usage 与 stream 都只对 DSH 自己的界面有意义）。
 *   2. 序列化器根本不读的事件类型（`job/*` 等）**22%** —— 见 COPY_KEEP_TYPES。
 *   3. `tool/result` 的文本块（27%）与 `tool/call.data.arguments`（10%）。
 *   4. `assistant/message` 的 `reasoning` 块（模型的内部独白）——**整块剥掉**。目标格式
 *      虽然能吃（claude 的 thinking、kimi 的 reasoning），但那是另一个模型的思考过程，
 *      接话用不上，档案里全文都在。实测它占最近一轮的 60% 以上。
 *   5. `assistant/message` 的正文（剥掉前两项后仍是大头）——只在最后几档才钳，因为助手
 *      说了什么正是续聊要接的话。`assistantLimit > 0` 时钳掉除**最后一条**以外的所有
 *      助手正文：接话靠的是最后那条，之前的正文档案里有。
 *
 * 只剥不改原始事件：返回的是新对象，`original.jsonl` 里仍是完整原文。
 */
function clampCopyEvents(events, { outputLimit, argumentLimit, assistantLimit = 0 }) {
  const list = Array.isArray(events) ? events : []
  const kept = list.filter((ev) => {
    if (!ev || typeof ev.type !== 'string' || !COPY_KEEP_TYPES.has(ev.type)) return false
    // 宿主注入的假用户消息（runtime-context / skill-catalog / time-context / user-approval）
    // 在 DSH 里是内部上下文，写进目标格式会被当成用户发言，且单条就能吃掉几千字符预算。
    if (ev.type === 'user/message') {
      const kind = ev.data && ev.data.source ? ev.data.source.kind : ''
      return kind === 'user'
    }
    return true
  })
  // 最后一条助手消息的序号：正文钳制放过它（无论它属于第几轮——只留一轮时按轮次判会
  // 把所有助手消息都当成「最近」，钳制永远不生效）。
  let lastAssistant = -1
  kept.forEach((ev, i) => { if (ev.type === 'assistant/message') lastAssistant = i })
  const bounded = kept.map((ev, index) => {
    if (ev.type === 'assistant/message') {
      const data = ev.data || {}
      const msg = data.message || {}
      const blocks = Array.isArray(msg.content) ? msg.content : null
      const dropMeta = data.stream !== undefined || data.usage !== undefined
      let nextData = dropMeta ? { ...data } : data
      if (dropMeta) {
        delete nextData.stream
        delete nextData.usage
      }
      if (blocks) {
        let touched = false
        let nextBlocks = blocks.filter((b) => {
          if (b && b.type === 'reasoning') { touched = true; return false }
          return true
        })
        // 只剥空推理块后没有内容可留（整条助手消息只有 reasoning）→ 整条丢掉。
        // 必须有这条不变式：Claude 的 assistant 记录 content 为空数组时，Claude Code
        // 续聊会直接报错；codex 侧也会多出一条空 message。工具调用块不在剥离范围内，
        // 所以不会因此产生配对不上 tool_result 的孤儿 tool_use。
        if (nextBlocks.length === 0) return null
        // tool-call 块里的 arguments 与 tool/call 事件里的那一份是同一段文本（claude 序列化
        // 器只从块里读，tool/call 事件用于配对）——两边都钳，否则重复的那份照样占满预算。
        nextBlocks = nextBlocks.map((b) => {
          if (!b || b.type !== 'tool-call' || typeof b.arguments !== 'string') return b
          const args = clampToolArguments(b.arguments, argumentLimit)
          if (args === b.arguments) return b
          touched = true
          return { ...b, arguments: args }
        })
        if (assistantLimit > 0 && index !== lastAssistant) {
          nextBlocks = nextBlocks.map((b) => {
            if (!b || b.type !== 'text' || typeof b.text !== 'string') return b
            if (b.text.length <= assistantLimit) return b
            touched = true
            return { ...b, text: b.text.slice(0, assistantLimit) + '…[本段已压缩，全文见档案]' }
          })
        }
        if (touched) nextData = { ...nextData, message: { ...msg, content: nextBlocks } }
      }
      return nextData === data ? ev : { ...ev, data: nextData }
    }
    if (ev.type === 'tool/call') {
      const data = ev.data || {}
      const args = clampToolArguments(data.arguments, argumentLimit)
      return args === data.arguments ? ev : { ...ev, data: { ...data, arguments: args } }
    }
    if (ev.type === 'tool/result') {
      const data = ev.data || {}
      const msg = data.message || {}
      const blocks = Array.isArray(msg.content) ? msg.content : null
      if (!blocks) return ev
      let touched = false
      const next = blocks.map((b) => {
        if (!b || b.type !== 'text' || typeof b.text !== 'string') return b
        const text = clampToolOutput(b.text, outputLimit)
        if (text === b.text) return b
        touched = true
        return { ...b, text }
      })
      return touched ? { ...ev, data: { ...data, message: { ...msg, content: next } } } : ev
    }
    return ev
  })
  // 上面可能把「只有推理块」的助手消息标成 null，这里统一丢掉。
  return bounded.filter(Boolean)
}

// ── 交接包组装（落档案 + 产出迁移副本） ───────────────────────────────────────

/**
 * 一次导出用的「交接包」：先把完整档案落进项目目录，再把「交接书 + 最近 N 轮」作为
 * 迁移副本返回。三个出边（claude / codex 系列 / markdown 之外的矩阵格式）共用它，
 * 保证任何目标格式的上下文占用都是常数级，而档案一份都不少。
 *
 * @param ctx 插件 ctx（读图片字节；读不到按降级计数）
 * @param args { sessionId, events, header?, cwd?, title?, createdAt?, recentTurns?,
 *               archiveRoot?, now?, readImage? }
 * @returns { archive, copy, enabled } — enabled=false 时 copy.events 就是原始事件
 */
export async function prepareHandoffCopy(ctx, {
  sessionId,
  events,
  header = null,
  cwd = '',
  title = '',
  createdAt = null,
  recentTurns = DEFAULT_RECENT_TURNS,
  archiveRoot = '',
  now = Date.now(),
  readImage = null,
} = {}) {
  const archive = await writeHandoffArchive(ctx, {
    sessionId, events, header, cwd, title, createdAt, archiveRoot, now, readImage,
  })
  // 归档目录只在本地：写进 .git/info/exclude，绝不改项目正式 .gitignore。
  let exclude = null
  try {
    exclude = await ensureGitExclude(cwd)
  } catch {
    exclude = null
  }
  const copy = fitCopyToBudget(events, { handoffText: archive.handoffText, recentTurns, createdAt })
  return {
    enabled: true,
    archive: {
      dir: archive.dir,
      relDir: archive.archiveRel,
      handoffPath: archive.handoffPath,
      indexPath: archive.indexPath,
      fileCount: archive.files.length,
      unavailableImages: archive.unavailableImages,
      gitExclude: exclude,
      stats: archive.model.stats,
    },
    copy,
  }
}

/** 交给面板/返回值的精简摘要（archive 对象里有绝对路径，返回值按需取用）。 */
export function handoffSummary(pack) {
  if (!pack || !pack.enabled) return null
  return {
    archiveDir: pack.archive.dir,
    archiveRelDir: pack.archive.relDir,
    handoffPath: pack.archive.handoffPath,
    fileCount: pack.archive.fileCount,
    // droppedTurns = 工具细节被压掉的轮数（对话本身仍在副本里，全在档案里）。
    droppedTurns: pack.copy.droppedTurns,
    keptTurns: pack.copy.keptTurns,
    handoffChars: pack.copy.handoffChars,
    // 面板文案是「迁移副本 = 交接书 N 字符 + 最近 K 轮」，这里的 K 必须是**副本里实际带了
    // 对话的轮数**（keepAllTurns 下就是全部轮次），而不是工具细节的深度——否则界面会显示
    // 「最近 1 轮」，让人误以为前 7 轮又丢了。
    recentTurns: Array.isArray(pack.copy.keptTurns) && pack.copy.keptTurns.length > 0
      ? pack.copy.keptTurns.length
      : pack.copy.recentTurns,
    outputLimit: pack.copy.outputLimit,
    argumentLimit: pack.copy.argumentLimit,
    assistantLimit: pack.copy.assistantLimit,
    copyChars: pack.copy.chars,
    copyMaxChars: pack.copy.maxChars,
    copyHardMaxChars: pack.copy.hardMaxChars,
    fitted: pack.copy.fitted,
    withinHardCap: pack.copy.withinHardCap,
  }
}

/** 会话里的 session/title 事件标题（没有则空串）。 */
function titleOfEvents(events) {
  const ev = (Array.isArray(events) ? events : []).find((e) => e && e.type === 'session/title'
    && e.data && typeof e.data.title === 'string' && e.data.title.trim())
  return ev ? String(ev.data.title).trim() : ''
}

/**
 * 出边统一入口：把「整条历史」换成「迁移副本」。
 *
 * 为什么放在这一层而不是各格式内部：交接包与目标格式无关——Claude Code、Codex、Kimi、
 * opencode 拿到的都是「一份交接书 + 最近几轮原文」，差别只在序列化器。放这里，将来加新
 * 目标格式自动继承（双向迁移的架构要求），也不会出现某个格式忘了压缩、又把窗口顶爆。
 *
 * 档案写不进去（沙箱拒绝、目录只读）时不阻断导出：退回原始事件，并把错误如实放进
 * handoff.error——降级口径与其它导出降级一致，绝不静默。
 *
 * @returns { events, handoff } — handoff 为 null 表示没有可用事件，{ error } 表示归档失败
 */
export async function handoffForExport(ctx, {
  sessionId,
  header = null,
  events,
  archiveRoot = '',
  recentTurns = DEFAULT_RECENT_TURNS,
  now = Date.now(),
} = {}) {
  const list = Array.isArray(events) ? events : []
  if (list.length === 0) return { events: list, handoff: null }
  const cwd = header && typeof header.cwd === 'string' ? header.cwd : ''
  const title = titleOfEvents(list)
  const createdAt = header && Number.isFinite(header.createdAt) ? header.createdAt : null
  try {
    const pack = await prepareHandoffCopy(ctx, {
      sessionId, events: list, header, cwd, title, createdAt, recentTurns, archiveRoot, now,
    })
    return { events: pack.copy.events, handoff: handoffSummary(pack) }
  } catch (err) {
    return {
      events: list,
      handoff: { error: '完整档案写入失败（迁移副本退回原始历史）：' + String((err && err.message) || err) },
    }
  }
}

// ── 落盘 ──────────────────────────────────────────────────────────────────────

async function exists(path) {
  return stat(path).then(() => true).catch(() => false)
}

async function writeTextFile(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

/**
 * 把 `.dsh/session-handoff/` 加进 `.git/info/exclude`（本地排除，不改项目正式 .gitignore）。
 * 只在 cwd 是 git 仓库时做；已存在则不重复写。失败静默（不影响导出结果）。
 * @returns { path, added } 或 null
 */
export async function ensureGitExclude(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null
  const repoRoot = join(cwd, '.git')
  if (!(await exists(repoRoot))) return null
  const excludePath = join(repoRoot, 'info', 'exclude')
  let current = ''
  try { current = await readFile(excludePath, 'utf8') } catch { current = '' }
  const lines = current.split('\n')
  if (lines.some((l) => l.trim() === GIT_EXCLUDE_LINE || l.trim() === HANDOFF_REL_DIR)) {
    return { path: excludePath, added: false }
  }
  const next = current && !current.endsWith('\n') ? current + '\n' : current
  await writeTextFile(excludePath, next + '# DSH 会话迁移的完整历史归档（本地，不提交）\n' + GIT_EXCLUDE_LINE + '\n')
  return { path: excludePath, added: true }
}

/**
 * 落盘完整档案 + 交接书。
 * @param ctx 插件 ctx（只为读图片字节；读不到按降级计数，不中断）
 * @param args { sessionId, events, header, archiveRoot?, cwd?, title?, createdAt?, readImage?,
 *               now?, includeReasoning?, writeHandoff?: boolean }
 * @returns { dir, handoffPath, indexPath, files[], model, handoffText, unavailableImages }
 */
export async function writeHandoffArchive(ctx, {
  sessionId,
  events,
  header = null,
  archiveRoot = '',
  cwd = '',
  title = '',
  createdAt = null,
  readImage = null,
  now = Date.now(),
  includeReasoning = false,
} = {}) {
  const root = archiveRoot || join(cwd || process.cwd(), HANDOFF_REL_DIR)
  const dir = join(root, String(sessionId))
  // 图片读取默认走宿主的 attachments 服务（readAttachmentBytes 内部处理服务缺席/读不到，
  // 返回 null）；显式传入 readImage 则为自检/测试留出替换口。
  const read = typeof readImage === 'function'
    ? readImage
    : (ref) => readAttachmentBytes(ctx, ref)
  const model = buildHandoffModel(events, { sessionId, title, cwd, createdAt, includeReasoning })
  const archiveRel = cwd && isAbsolute(dir) && dir.startsWith(cwd)
    ? relative(cwd, dir).split(sep).join('/')
    : ''
  const handoffText = clip(renderHandoffMarkdown(model, { archiveRel, archiveAbs: dir, now }), HANDOFF_MAX_CHARS)

  const files = []
  await writeTextFile(join(dir, 'handoff.md'), handoffText + '\n')
  files.push('handoff.md')

  // 原始事件逐行落盘（这才是「完整历史」；不截断、不压缩、不改写）
  const original = (Array.isArray(events) ? events : []).map((ev) => JSON.stringify(ev)).join('\n') + '\n'
  await writeTextFile(join(dir, 'original.jsonl'), original)
  files.push('original.jsonl')

  for (const turn of model.turns) {
    await writeTextFile(join(dir, 'turns', turnFileName(turn.turn)), renderTurnMarkdown(model, turn))
    files.push('turns/' + turnFileName(turn.turn))
  }
  for (const out of longOutputFiles(model)) {
    await writeTextFile(join(dir, 'tool-outputs', out.name), out.content)
    files.push('tool-outputs/' + out.name)
  }

  // 图片：能读到字节就落原文件（不 base64，避免把档案撑成二进制垃圾）
  let unavailableImages = 0
  for (const turn of model.turns) {
    for (let i = 0; i < turn.userImages.length; i++) {
      const block = turn.userImages[i]
      const ref = block && block.attachment && typeof block.attachment === 'object' ? block.attachment : (block || {})
      let bytes = null
      try {
        bytes = await read(ref)
      } catch {
        bytes = null
      }
      const name = 'turn-' + turnFileName(turn.turn).replace(/\.md$/, '') + '-img' + (i + 1) + '.png'
      if (!bytes || !bytes.length) { unavailableImages++; continue }
      await mkdir(join(dir, 'assets'), { recursive: true })
      await writeFile(join(dir, 'assets', name), bytes)
      files.push('assets/' + name)
    }
  }

  await writeTextFile(join(dir, 'index.md'), renderIndexMarkdown(model, { files, now }))
  files.unshift('index.md')

  return {
    dir,
    archiveRel,
    handoffPath: join(dir, 'handoff.md'),
    indexPath: join(dir, 'index.md'),
    files,
    model,
    handoffText,
    unavailableImages,
  }
}
