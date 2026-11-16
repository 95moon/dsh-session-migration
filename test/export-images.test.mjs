// test/export-images.test.mjs — 导出前的图片解引用必须能在**冻结**事件上工作
//
// 回归：宿主交给插件的会话事件是冻结的（DSH 冻结日志以防插件改坏它）。早期
// `resolveInBlocks` 就地写 `blocks[i] = …`，于是任何含图片的会话导出 claude / codex /
// codex-native 都抛 `TypeError: Cannot assign to read only property '0' of object
// '[object Array]'`（面板里表现为一行红字，七种格式只挂三种）。本文件锁住写时复制语义：
// 输入永不被改写、图片照旧内联、读不到字节时降级为占位而不是抛错。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveImagesForExport } from '../lib/attachments.mjs'
import { makeCtx } from './_support/fake-host.mjs'

// 与宿主一致：整棵事件树深度冻结（这才是复现那个 TypeError 的关键）
function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

function imageRefEvents() {
  return [
    // 用户消息里一张附件引用（宿主原生形状）
    {
      type: 'user/message',
      data: {
        id: 'u1',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image', attachment: { attachmentId: 'sha256:aa', mediaType: 'image/png', name: 'shot.png' } },
        ],
      },
    },
    // V3 tool/result 的 wrapper：图片在 message.content 里
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'call_1',
          content: [{ type: 'image', attachment: { attachmentId: 'sha256:bb', mediaType: 'image/jpeg' } }],
        },
      },
    },
    // 不带图片的事件：必须原样透传（引用相等，调用方零开销）
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } },
  ]
}

const readService = (bytes = 'abc') => ({
  services: {
    attachments: {
      async readImage(ref) {
        return { data: Buffer.from(bytes), mediaType: ref && ref.mediaType }
      },
    },
  },
})

test('resolveImagesForExport：冻结事件不抛错，且不改写输入', async () => {
  const events = deepFreeze(imageRefEvents())
  const { ctx } = makeCtx({}, readService())

  const out = await resolveImagesForExport(ctx, events)

  // 1) 没有抛错（回归点）
  assert.equal(out.resolved, 2)
  assert.equal(out.unavailable, 0)
  // 2) 输入数组与其中的块都没被改写：还是附件引用形态
  assert.equal(events[0].data.content[1].type, 'image')
  assert.equal(events[0].data.content[1].attachment.attachmentId, 'sha256:aa')
  assert.equal(events[0].data.content[1].data, undefined)
  // 3) 输出是新对象、图片已内联为 base64
  assert.notEqual(out.events, events)
  assert.notEqual(out.events[0], events[0])
  assert.equal(out.events[0].data.content[1].type, 'image')
  assert.equal(out.events[0].data.content[1].data, Buffer.from('abc').toString('base64'))
  assert.equal(out.events[0].data.content[1].mediaType, 'image/png')
  assert.equal(out.events[0].data.content[1].name, 'shot.png')
  // 4) 文本块与轮次字段原样保留
  assert.equal(out.events[0].data.content[0].text, '看这张图')
  assert.equal(out.events[0].data.id, 'u1')
})

test('resolveImagesForExport：tool/result 内层 content 也走写时复制', async () => {
  const events = deepFreeze(imageRefEvents())
  const { ctx } = makeCtx({}, readService('xy'))

  const out = await resolveImagesForExport(ctx, events)
  const inner = out.events[1].data.message.content

  assert.equal(inner[0].data, Buffer.from('xy').toString('base64'))
  assert.equal(inner[0].mediaType, 'image/jpeg')
  // 输入里那份 wrapper 仍指向原来的冻结数组
  assert.equal(events[1].data.message.content[0].attachment.attachmentId, 'sha256:bb')
})

test('resolveImagesForExport：没有图片时事件按引用透传', async () => {
  const events = deepFreeze([
    { type: 'user/message', data: { id: 'u1', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'turn/start', data: { turn: 1 } },
  ])
  const { ctx } = makeCtx({}, readService())

  const out = await resolveImagesForExport(ctx, events)

  assert.equal(out.resolved, 0)
  assert.equal(out.events.length, 2)
  // 逐条引用相等：没变的层不重建（体积与调用方语义都不变）
  assert.equal(out.events[0], events[0])
  assert.equal(out.events[1], events[1])
})

test('resolveImagesForExport：读不到字节时降级为占位，而不是抛错', async () => {
  const events = deepFreeze([
    {
      type: 'user/message',
      data: {
        id: 'u1',
        content: [{ type: 'image', attachment: { attachmentId: 'sha256:cc', mediaType: 'image/png', name: 'gone.png' } }],
      },
    },
  ])
  // 服务缺席（可选服务未挂载）
  const { ctx } = makeCtx({}, { services: {} })

  const out = await resolveImagesForExport(ctx, events)

  assert.equal(out.resolved, 0)
  assert.equal(out.unavailable, 1)
  const block = out.events[0].data.content[0]
  assert.equal(block.type, 'text')
  assert.match(block.text, /gone\.png/)
  // 输入仍然完好
  assert.equal(events[0].data.content[0].type, 'image')
})

test('resolveImagesForExport：已是 data 形态的块幂等（再跑一次不重复计数）', async () => {
  const events = deepFreeze([
    {
      type: 'user/message',
      data: { id: 'u1', content: [{ type: 'image', data: Buffer.from('zz').toString('base64'), mediaType: 'image/png' }] },
    },
  ])
  const { ctx } = makeCtx({}, readService())

  const first = await resolveImagesForExport(ctx, events)
  const second = await resolveImagesForExport(ctx, first.events)

  assert.equal(first.resolved, 1)
  assert.equal(second.resolved, 1)
  assert.equal(second.events[0].data.content[0].data, Buffer.from('zz').toString('base64'))
})

test('resolveImagesForExport：非数组与畸形事件不炸', async () => {
  const { ctx } = makeCtx({}, readService())
  assert.deepEqual((await resolveImagesForExport(ctx, null)).events, [])
  assert.deepEqual((await resolveImagesForExport(ctx, 'nope')).events, [])
  const weird = deepFreeze([null, 3, { type: 'x' }, { type: 'y', data: null }])
  const out = await resolveImagesForExport(ctx, weird)
  assert.equal(out.events.length, 4)
  assert.equal(out.events[1], 3)
})
