// session-handoff.test.mjs — 「迁移副本 + 交接书」纯函数单测（不需要 DSH 宿主）。
//
// 这些用例锁住的是导出侧最容易悄悄坏掉的几条不变式：
//   1. 目标格式要能续聊：对话（人说的话）一条都不能丢；
//   2. 体积要可控：工具流量才限量，且受软目标 / 硬上限约束；
//   3. 目标格式不消费的东西不能带过去（reasoning 流、宿主注入消息、插件内部事件）；
//   4. 工具名必须归一化到 ^[a-zA-Z0-9_-]+$，否则宿主会整份拒绝。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COPY_MAX_CHARS,
  COPY_HARD_MAX_CHARS,
  DEFAULT_RECENT_TURNS,
  buildHandoffModel,
  copyChars,
  fitCopyToBudget,
  renderHandoffMarkdown,
  withHandoffEvents,
} from '../lib/session-handoff.mjs'
import { clampToolArguments, clampToolOutput, sanitizeToolName } from '../lib/export/common.mjs'

const T = 1786000000000
const ISO = new Date(T).toISOString()

function ev(type, seq, data) {
  return { type, seq, time: T, data }
}

function turn(seq, n) {
  return ev('turn/start', seq, { turn: n })
}

function userMsg(seq, n, text, kind = 'user') {
  return ev('user/message', seq, {
    id: 'u' + n,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind },
  })
}

function asstMsg(seq, n, blocks, streamText = null) {
  const data = {
    turn: n,
    step: 1,
    message: { role: 'assistant', content: blocks },
    usage: { input: 1, output: 2 },
  }
  if (streamText) data.stream = [{ type: 'reasoning-delta', text: streamText }]
  return ev('assistant/message', seq, data)
}

function toolCall(seq, n, callId, name, args) {
  return ev('tool/call', seq, { turn: n, step: 1, callId, name, arguments: args })
}

function toolResult(seq, n, callId, text) {
  return ev('tool/result', seq, {
    turn: n,
    step: 1,
    message: {
      role: 'tool',
      toolCallId: callId,
      content: [{ type: 'text', text }],
      isError: false,
    },
  })
}

// 三轮完整对话：每轮一个提问、一条助手正文、一次工具调用与结果。
// 第 3 轮额外带一张只有图片的助手消息（转投回归）与一条只有推理块的消息（空 content 回归）。
function threeTurns({ withImage = true, withReasoningOnly = true, withStream = true } = {}) {
  const events = [ev('session', 1, { id: 's1', cwd: 'E:\\demo', version: 4 })]
  let seq = 2
  for (let n = 1; n <= 3; n++) {
    events.push(turn(seq++, n))
    events.push(userMsg(seq++, n, '提问' + n))
    events.push(asstMsg(seq++, n, [{ type: 'text', text: '回答' + n }], withStream ? '推理流' + n : null))
    events.push(toolCall(seq++, n, 'c' + n, 'pwsh', '{"command":"echo ' + n + '"}'))
    events.push(toolResult(seq++, n, 'c' + n, '输出' + n))
    events.push(ev('turn/end', seq++, { turn: n }))
  }
  // 宿主注入的假用户消息：不能出现在迁移副本里。
  events.push(userMsg(5, 1, '内部上下文别外传', 'runtime-context'))
  // 插件内部事件：目标格式不消费。
  events.push(ev('job/registered', 6, { id: 'j1', kind: 'shell' }))
  if (withImage) {
    events.push(asstMsg(7, 3, [{ type: 'image', attachment: { attachmentId: 'sha256:aa', mediaType: 'image/png' } }]))
  }
  if (withReasoningOnly) {
    events.push(asstMsg(8, 3, [{ type: 'reasoning', text: '只想了没说话' }]))
  }
  return events
}

const textsOf = (events) => JSON.stringify(events)
const userTexts = (events) =>
  events
    .filter((e) => e.type === 'user/message')
    .flatMap((e) => (e.data.content || []).filter((b) => b.type === 'text').map((b) => b.text))

test('withHandoffEvents 默认模式：只保留最近 N 轮，交接书排在最前', () => {
  const events = threeTurns()
  const out = withHandoffEvents(events, { handoffText: '交接书正文', recentTurns: 1, createdAt: ISO })
  assert.deepEqual(out.keptTurns, [3])
  assert.equal(out.toolTurns, 1)
  assert.equal(out.droppedTurns, 2)
  assert.equal(out.events[0].type, 'user/message')
  assert.ok(String(out.events[0].data.id).startsWith('handoff-'))
  assert.deepEqual(out.keptTurns.length, 1)
  // 第 1、2 轮的对话与工具都不在副本里
  assert.equal(textsOf(out.events).includes('提问1'), false)
  assert.equal(textsOf(out.events).includes('提问2'), false)
  assert.ok(textsOf(out.events).includes('提问3'))
  assert.ok(textsOf(out.events).includes('回答3'))
  assert.ok(textsOf(out.events).includes('c3'))
  assert.equal(textsOf(out.events).includes('c1'), false)
  assert.equal(out.handoffChars, '交接书正文'.length)
})

test('keepAllTurns：人说的话全留，工具流量只留最近 N 轮', () => {
  const events = threeTurns()
  const out = withHandoffEvents(events, {
    handoffText: '交接书正文',
    recentTurns: 1,
    createdAt: ISO,
    keepAllTurns: true,
  })
  // 三轮的提问与回答都在
  assert.deepEqual(out.keptTurns, [1, 2, 3])
  assert.equal(out.toolTurns, 1)
  for (const n of [1, 2, 3]) {
    assert.ok(textsOf(out.events).includes('提问' + n), '缺第 ' + n + ' 轮提问')
    assert.ok(textsOf(out.events).includes('回答' + n), '缺第 ' + n + ' 轮回答')
  }
  // 但只有第 3 轮带工具明细
  assert.ok(textsOf(out.events).includes('c3'))
  assert.equal(textsOf(out.events).includes('c1'), false)
  assert.equal(textsOf(out.events).includes('c2'), false)
  // 掉出工具窗口的助手消息必须摘掉 tool-call 块，不能留下配不上 tool_result 的调用
  const asstEarly = out.events.filter((e) => e.type === 'assistant/message' && e.data.turn === 1)
  assert.equal(asstEarly.length, 1)
  assert.deepEqual(
    asstEarly[0].data.message.content.map((b) => b.type),
    ['text'],
  )
})

test('宿主注入的假用户消息与插件内部事件都不进迁移副本', () => {
  const events = threeTurns()
  const out = withHandoffEvents(events, {
    handoffText: '交接书',
    recentTurns: DEFAULT_RECENT_TURNS,
    keepAllTurns: true,
  })
  // 注入消息由轮次筛选层挡掉
  assert.equal(textsOf(out.events).includes('内部上下文别外传'), false)
  // 目标格式不消费的事件类型由收紧层（COPY_KEEP_TYPES）挡掉
  const budget = fitCopyToBudget(events, { handoffText: '交接书', recentTurns: 3 })
  assert.equal(budget.events.some((e) => e.type === 'job/registered'), false)
  assert.equal(budget.events.some((e) => e.type === 'session'), false)
})

test('没有 turn 线索的老日志也不会丢对话（按真实提问兜底分轮）', () => {
  // 不产生任何 turn/start，也没有 data.turn —— 早期会话与合成事件的形状。
  const events = [
    userMsg(1, 1, '第一问'),
    asstMsg(2, 1, [{ type: 'text', text: '第一答' }]),
    userMsg(3, 2, '第二问'),
    asstMsg(4, 2, [{ type: 'text', text: '第二答' }]),
  ]
  const out = withHandoffEvents(events, {
    handoffText: '交接书',
    recentTurns: 1,
    createdAt: ISO,
    keepAllTurns: true,
  })
  const model = buildHandoffModel(events, { sessionId: 's1', title: '老会话' })
  assert.equal(model.turns.length, 2)
  assert.ok(textsOf(out.events).includes('第一问'))
  assert.ok(textsOf(out.events).includes('第二答'))
})

test('reasoning 流与只有推理块的助手消息都不带过去，且不留空 content', () => {
  const out = withHandoffEvents(threeTurns(), {
    handoffText: '交接书',
    recentTurns: DEFAULT_RECENT_TURNS,
    keepAllTurns: true,
  })
  const budget = fitCopyToBudget(threeTurns(), { handoffText: '交接书', recentTurns: 3 })
  // 剥 data.stream / reasoning 块是「收紧」这一层（clampCopyEvents）的职责，
  // 所以只对最终用于序列化的 fitCopyToBudget 结果断言；轮次筛选层不做内容裁剪。
  const text = textsOf(budget.events)
  assert.equal(text.includes('推理流1'), false, 'data.stream 不应外泄')
  assert.equal(text.includes('只想了没说话'), false, 'reasoning 块不应外泄')
  for (const events of [out.events, budget.events]) {
    for (const e of events) {
      if (e.type !== 'assistant/message') continue
      assert.ok(e.data.message.content.length > 0, '助手消息不能是空 content')
    }
  }
})

test('只有图片的助手消息必须保留图片块（转投图片口径回归）', () => {
  const events = threeTurns()
  const out = withHandoffEvents(events, {
    handoffText: '交接书',
    recentTurns: 1,
    createdAt: ISO,
    keepAllTurns: true,
  })
  const withImage = out.events.filter(
    (e) => e.type === 'assistant/message' && (e.data.message.content || []).some((b) => b.type === 'image'),
  )
  assert.equal(withImage.length, 1)
  assert.equal(withImage[0].data.turn, 3)
})

test('fitCopyToBudget：预算再紧也不丢对话，并且不动原始事件', () => {
  const events = threeTurns()
  const snapshot = JSON.stringify(events)
  const out = fitCopyToBudget(events, { handoffText: '交接书', recentTurns: 3 })
  assert.equal(JSON.stringify(events), snapshot, '原始事件不能被就地改写')
  assert.equal(out.maxChars, COPY_MAX_CHARS)
  assert.equal(out.hardMaxChars, COPY_HARD_MAX_CHARS)
  assert.ok(out.chars === copyChars(out.events))
  // 三轮的对话都留着
  for (const n of [1, 2, 3]) {
    assert.ok(textsOf(out.events).includes('提问' + n))
    assert.ok(textsOf(out.events).includes('回答' + n))
  }
  // 极紧的预算下仍然保留全部对话，只是 fitted 为 false
  const tight = fitCopyToBudget(events, { handoffText: '交接书', recentTurns: 3, maxChars: 10 })
  assert.equal(tight.fitted, false)
  assert.ok(tight.chars <= COPY_HARD_MAX_CHARS || tight.withinHardCap === false)
  assert.ok(textsOf(tight.events).includes('提问1'))
  assert.ok(textsOf(tight.events).includes('提问3'))
})

test('超长工具输出与参数会被钳制，但钳完仍是合法 JSON', () => {
  const huge = 'x'.repeat(20000)
  const out = fitCopyToBudget(threeTurns(), {
    handoffText: '交接书',
    recentTurns: 3,
    maxChars: 12000,
    hardMaxChars: 20000,
  })
  const calls = out.events.filter((e) => e.type === 'tool/call')
  for (const c of calls) {
    assert.ok(c.data.arguments.length <= 4000)
  }
  // clampToolArguments 的结果必须是可解析的 JSON
  const clamped = clampToolArguments(JSON.stringify({ command: huge }), 400)
  assert.doesNotThrow(() => JSON.parse(clamped))
  const clampedOut = clampToolOutput(huge, 400)
  assert.ok(clampedOut.length < huge.length)
  assert.ok(clampedOut.includes('截断'))
  assert.equal(clampToolOutput('short', 400), 'short')
  assert.equal(clampToolOutput(huge, 0).includes(huge), false)
})

test('交接书渲染出固定的八个章节', () => {
  const events = threeTurns()
  const model = buildHandoffModel(events, { sessionId: 's1', title: '演示会话', cwd: 'E:\\demo' })
  assert.equal(model.stats.userTurns, 3)
  assert.equal(model.stats.toolCalls, 3)
  const md = renderHandoffMarkdown(model, { archiveRel: '.dsh/session-handoff/s1', now: T })
  for (const heading of [
    '项目目标',
    '已完成工作',
    '技术决策',
    '修改文件',
    '测试与验证',
    '未解决问题',
    '下一步任务',
    '历史索引',
  ]) {
    assert.ok(md.includes(heading), '交接书缺章节：' + heading)
  }
  assert.ok(md.includes('.dsh/session-handoff/s1'))
})

test('工具名归一化：宿主不合法的名字一律变成合法字符集', () => {
  // ^[a-zA-Z0-9_-]+$ —— 实测 Codex 会整份拒绝不合规名字
  assert.equal(sanitizeToolName('acp tokens='), 'acp_tokens')
  assert.equal(sanitizeToolName('a.b/c:d'), 'a_b_c_d')
  assert.equal(sanitizeToolName('中文工具'), 'unknown')
  assert.equal(sanitizeToolName(''), 'unknown')
  assert.equal(sanitizeToolName(undefined), 'unknown')
  assert.equal(sanitizeToolName('__x__'), 'x')
  const long = sanitizeToolName('a'.repeat(200))
  assert.equal(long.length, 64)
  for (const name of ['acp tokens=', 'a.b/c:d', '中文工具', '', 'x y', 'a'.repeat(200)]) {
    assert.match(sanitizeToolName(name), /^[a-zA-Z0-9_-]+$/)
  }
})
