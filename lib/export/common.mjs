// lib/export/common.mjs — 各反向导出格式共用的小件（纯函数，零 DSH 依赖）
import { sanitizeParseError } from '../convert/core.mjs'

// 是否存在可导出的 surface 事件（user 直连提问 / assistant / tool/result）。没有就是空
// 会话，各序列化器据此抛「无可导出内容」。
export function hasSurfaceEvents(events) {
  return (Array.isArray(events) ? events : []).some((ev) => ev && (
    (ev.type === 'user/message' && ev.data && ev.data.source && ev.data.source.kind === 'user')
    || ev.type === 'assistant/message'
    || ev.type === 'tool/result'
  ))
}

// 事件时间（毫秒）：缺失回退 meta.createdAt，再回退 fallbackMs，最后回退当前时刻。
export function eventTimeMs(ev, meta, fallbackMs) {
  return typeof ev.time === 'number' ? ev.time
    : meta && typeof meta.createdAt === 'number' ? meta.createdAt
      : fallbackMs !== undefined ? fallbackMs : Date.now()
}

// 同 eventTimeMs，格式化为 ISO8601。
export function eventIso(ev, meta, fallbackMs) {
  return new Date(eventTimeMs(ev, meta, fallbackMs)).toISOString()
}

// 工具名归一化。为什么必须有：OpenAI 侧的 function_call.name 与 Anthropic 侧的
// tool_use.name 都只认 ^[a-zA-Z0-9_-]{1,64}$ 这一类字符集。DSH 会把模型偶尔写坏的
// 「工具名」照实记进日志（实测有一条 name 是 "acp tokens="，含空格与等号），导出时原样
// 抄出去，宿主校验收到的整个请求，于是整段会话「能打开但发不出去」。这里统一压成合规
// 形状：非法字符换下划线、折叠连续下划线、掐掉首尾下划线、空名回退 unknown、截到 64。
export function sanitizeToolName(name) {
  const raw = typeof name === 'string' ? name.trim() : ''
  const mapped = raw.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '')
  return mapped ? mapped.slice(0, 64) : 'unknown'
}

// 工具输出截断。为什么必须有：一次真实导出里 60 个工具调用的输出合计 46.8 万字符，
// 塞进宿主上下文直接触发「ran out of room in the model's context window」——会话能显示，
// 但一发消息就报上下文不足。保留头部（有用信息通常在前）与尾部（错误/结论常在后），
// 中间换成一行说明，读者能看出这里被截过、原文有多长。
export function clampToolOutput(text, limit = 4000) {
  if (Array.isArray(text)) return text.map((part) => (part && part.type === 'input_text'
    ? { ...part, text: clampToolOutput(part.text, limit) }
    : part))
  const s = typeof text === 'string' ? text : String(text ?? '')
  // limit <= 0 是「预算已经压到极限」的信号：正文全部丢弃，只留一行说明。给 0 留这个
  // 分支（而不是回退到默认 4000）才能让总量回落阶梯真正收到地板。
  if (Number.isFinite(limit) && limit <= 0) return '\n…[输出已省略 ' + s.length + ' 字符：历史过长]…\n'
  const budget = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 4000
  if (s.length <= budget) return s
  const head = Math.floor(budget * 0.6)
  const tail = Math.floor(budget * 0.4)
  return s.slice(0, head) + '\n…[输出过长已截断 ' + (s.length - head - tail) + ' 字符]…\n' + s.slice(s.length - tail)
}

// 工具参数截断（与 clampToolOutput 同一动机）。为什么单独一个函数：参数是 JSON 文本，
// 直接切字会切出非法 JSON，宿主解析失败同样是「整份历史发不出去」。所以超长时返回一个
// 合法的小对象：保留 _truncated / _originalChars 让读者知道被截过，preview 留一段开头。
export function clampToolArguments(args, limit = 4000) {
  const s = typeof args === 'string' ? args : JSON.stringify(args ?? {})
  const budget = Number.isFinite(limit) ? Math.floor(limit) : 4000
  if (budget < 0 || s.length <= budget) return s
  const preview = budget > 0 ? s.slice(0, Math.max(0, budget - 80)) : ''
  return JSON.stringify({ _truncated: true, _originalChars: s.length, preview })
}

// 导出总量回落阶梯：(outputLimit, argumentLimit) 从宽到严。为什么需要：单条截断有上限
// 之和——一次真实导出里 60 次调用各留 4000 字符仍有 25 万 token，超过 Codex 的 258400
// 窗口。所以序列化完要量总长，超预算就换下一档重算，直到装进窗口。
export const EXPORT_CLAMP_LADDER = Object.freeze([
  Object.freeze([4000, 4000]),
  Object.freeze([2000, 1500]),
  Object.freeze([1000, 800]),
  Object.freeze([600, 400]),
  Object.freeze([300, 200]),
  Object.freeze([0, 0]),
])

// 记录数组的序列化长度（按 JSONL 实际字节量算，与最终文件同尺度）。
export function measureRecords(records) {
  const list = Array.isArray(records) ? records : []
  let chars = 0
  for (const r of list) chars += JSON.stringify(r).length + 1
  return chars
}

// 按阶梯重试 serialize(limits)，直到长度 <= maxChars。serialize 收一个 { outputLimit,
// argumentLimit } 并返回带 records 的任意对象（返回值原样透传，另加 budget 信息）。
// 全部档位都超预算时返回最严的那一档结果（宁可截狠，也不要交出一份打不开的会话）。
export function fitToBudget(serialize, maxChars, ladder = EXPORT_CLAMP_LADDER) {
  let last = null
  for (let i = 0; i < ladder.length; i++) {
    const [outputLimit, argumentLimit] = ladder[i]
    const out = serialize({ outputLimit, argumentLimit })
    const chars = measureRecords(out.records)
    last = { ...out, budget: { outputLimit, argumentLimit, chars, maxChars, fitted: chars <= maxChars, attempt: i } }
    if (chars <= maxChars) return last
  }
  return last
}

// 记录序列化结果 → JSONL 文本（每条一行、以恰好一个换行结尾）与统一的计数外形。
export function jsonlResult(out) {
  return {
    jsonl: out.records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    recordCount: out.records.length,
    toolCalls: out.toolCalls,
    toolResults: out.toolResults,
    droppedToolResults: out.droppedToolResults,
    skippedInjections: out.skippedInjections,
    skippedBlocks: out.skippedBlocks,
  }
}

// JSONL 文件只读校验的共用骨架：恰好一个换行结尾、无空行、逐行 JSON 合法（报错经
// sanitizeParseError，不回显行内容）、至少一条记录、存在头记录。isHeader(rec) 判定头
// 记录；checkRecord(rec)（可选）返回非头记录的问题描述，无问题返回 null；headerMissing
// 是缺头记录时的报错。返回 { ok: true, recordCount } 或 { ok: false, errors: [{ line, error }] }。
export function verifyJsonlRecords(jsonl, { isHeader, headerMissing, checkRecord }) {
  const errors = []
  const text = String(jsonl)
  if (!text.endsWith('\n')) errors.push({ line: 1, error: '文件必须以恰好一个换行结尾' })
  const lines = text.split('\n')
  let count = 0
  let sawHeader = false
  for (let i = 0; i < lines.length; i++) {
    if (i === lines.length - 1 && text.endsWith('\n')) continue
    const t = lines[i].trim()
    if (!t) { errors.push({ line: i + 1, error: '空行' }); continue }
    let rec
    try { rec = JSON.parse(t) } catch (err) {
      errors.push({ line: i + 1, error: 'JSON 解析失败: ' + sanitizeParseError(err) })
      continue
    }
    count++
    if (isHeader(rec)) {
      sawHeader = true
    } else if (checkRecord) {
      const problem = checkRecord(rec)
      if (problem) errors.push({ line: i + 1, error: problem })
    }
  }
  if (count === 0) errors.push({ line: 1, error: '无任何记录' })
  else if (!sawHeader) errors.push({ line: 1, error: headerMissing })
  return errors.length ? { ok: false, errors } : { ok: true, recordCount: count }
}
