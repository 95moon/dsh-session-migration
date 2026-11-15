// shape-env-injection.test.mjs — isEnvInjectionEvent 的生产者标识兼容面
// V3 保留 kind='plugin' + plugin=<生产者>，V4 把 kind 改写成 'plugin:<生产者>'；插件改名
// （chat-import → session-migration）后旧会话里写的仍是旧标识，两代都要认，否则重导旧导入
// 会话时会把环境变更声明当成真实提问。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isEnvInjectionEvent } from '../lib/convert/index.mjs'

const envEvent = (source, id = 'import:sess-1:env') => ({ type: 'user/message', data: { id, source } })

test('isEnvInjectionEvent：V3 形状（kind=plugin）认两代生产者名', () => {
  assert.equal(isEnvInjectionEvent(envEvent({ kind: 'plugin', plugin: 'session-migration' })), true)
  assert.equal(isEnvInjectionEvent(envEvent({ kind: 'plugin', plugin: 'chat-import' })), true)
})

test('isEnvInjectionEvent：V4 形状（kind=plugin:<生产者>）认两代标识', () => {
  assert.equal(isEnvInjectionEvent(envEvent({ kind: 'plugin:session-migration' })), true)
  assert.equal(isEnvInjectionEvent(envEvent({ kind: 'plugin:chat-import' })), true)
})

test('isEnvInjectionEvent：别的生产者、别的 id 形状都不算', () => {
  // V4 形态带生产者标识，非本插件即不认
  assert.equal(isEnvInjectionEvent(envEvent({ kind: 'plugin:other-plugin' })), false)
  assert.equal(isEnvInjectionEvent(envEvent({ kind: 'agent-instructions', plugin: 'compact' })), false)
  assert.equal(isEnvInjectionEvent(envEvent({ kind: 'plugin:session-migration' }, 'import:sess-1:real')), false)
  assert.equal(isEnvInjectionEvent({ type: 'assistant/message', data: { id: 'x:env', source: { kind: 'plugin' } } }), false)
  assert.equal(isEnvInjectionEvent({ type: 'user/message', data: { id: 'x:env' } }), false)
})
