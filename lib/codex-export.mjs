// lib/codex-export.mjs — 「导出到 Codex 库位」的 DSH 侧适配（读会话 + 选 cwd + 装库）
//
// 分层：codex-native.mjs 只管 Codex 那一侧（模板、rollout 形状、threads 行、迁移），
// 这里管 DSH 这一侧（读会话事件、解引用附件、按项目根挑 cwd、把结果说清楚）。
// session-export.mjs 的 exportSession 以格式 'codex-native' 分派过来。

import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { listPersistedHeaders, readSessionRecord, canReadSessionEvents } from './imports.mjs'
import { makeSessionHintProvider } from './session-hints.mjs'
import { resolveImagesForExport } from './attachments.mjs'
import { handoffForExport } from './session-handoff.mjs'
import {
  resolveCodexHome,
  findCodexCli,
  readCodexTemplate,
  matchProjectRoot,
  serializeCodexNative,
  installCodexSession,
} from './codex-native.mjs'

const errorText = (err) => String((err && err.message) || err)

/** 会话标题：先看 session/title 事件，再退回投影缓存（与 markdown 导出同一口径）。 */
function titleOf(ctx, events, header) {
  const ev = Array.isArray(events)
    ? events.find((e) => e && e.type === 'session/title' && e.data && typeof e.data.title === 'string')
    : null
  const fromEvents = ev && ev.data.title ? String(ev.data.title).trim() : ''
  if (fromEvents) return fromEvents
  const hint = makeSessionHintProvider(ctx, [header].filter(Boolean))
  const fromCache = (hint({ format: 'dsh4', sessionId: header && header.id }) || {}).title
  return typeof fromCache === 'string' && fromCache.trim() ? fromCache.trim() : ''
}

/**
 * 把 DSH 会话装进真实 Codex 库位。
 * @param ctx 插件 ctx
 * @param args { sessionId, cwd?, title?, dryRun?, codexId? }
 * @returns { mode:'codex-native', sessionId, codexId, filePath, rolloutPath, cwd, project, turnCount,
 *            firstUserMessage, thread, migration, dryRun }
 */
export async function exportCodexNative(ctx, args) {
  const sp = ctx.get('sessionPersistence')
  if (!canReadSessionEvents(sp)) throw new Error('sessionPersistence 不可用（需要读事件面）')
  const record = await readSessionRecord(ctx, args.sessionId, 0)
  if (!record) throw new Error('会话日志读不到：' + args.sessionId)
  const events = Array.isArray(record.events) ? record.events : []
  if (events.length === 0) throw new Error('这个会话没有可导出的内容')

  // Codex 的 thread id 必须是 UUID（`--thread` 参数会校验：DSH 的 "session-xxxx" 直接被拒），
  // 所以这里另起一个 UUID 当 Codex 侧身份，并在返回里同时给出两边 id 便于对照。
  const codexId = typeof args.codexId === 'string' && /^[0-9a-fA-F-]{36}$/.test(args.codexId)
    ? args.codexId
    : randomUUID()

  const header = (await listPersistedHeaders(ctx)).find((h) => h && h.id === args.sessionId) || null
  const sourceCwd = typeof args.cwd === 'string' && args.cwd
    ? args.cwd
    : (header && typeof header.cwd === 'string' ? header.cwd : '')

  const codexHome = resolveCodexHome()
  const found = await readCodexTemplate(codexHome)
  if (!found) {
    throw new Error('没找到 Codex 库（' + codexHome + '\\state_5.sqlite 里没有可参照的线程）；请先打开一次 Codex Desktop')
  }
  const { template, projects } = found
  const project = matchProjectRoot(sourceCwd, projects)
  // 落在既有项目的目录下，Codex 打开后就归到那个项目；匹配不上就用会话自己的 cwd
  const cwd = (project && project.path) || sourceCwd || template.cwd
  if (typeof cwd !== 'string' || !cwd) throw new Error('这个会话没有 cwd，无法确定装进 Codex 的哪个项目')

  // 图片：会话日志里只有附件引用，Codex 的 input_image 需要 base64
  const title = (typeof args.title === 'string' && args.title.trim()) || titleOf(ctx, events, header)
  const createdAt = header && Number.isFinite(header.createdAt) ? header.createdAt : Date.now()

  // 迁移副本：先把完整档案落进项目目录，再拿「交接书 + 最近几轮」去序列化。这一步是
  // 「能显示但发不出消息」的根治点——导出的体积从此与实际会话长度无关。归档失败时
  // handoff.error 会如实带回去（不阻断导出）。
  const handoff = await handoffForExport(ctx, {
    sessionId: args.sessionId,
    header,
    events,
    archiveRoot: typeof args.archiveDir === 'string' && args.archiveDir ? args.archiveDir : '',
    recentTurns: Number.isFinite(args.recentTurns) ? args.recentTurns : undefined,
  })

  const images = await resolveImagesForExport(ctx, handoff.events)

  const serialized = serializeCodexNative(images.events, {
    sessionUuid: codexId,
    cwd,
    createdAt,
    title,
    template,
    workspaceRoots: Array.from(new Set([cwd, sourceCwd].filter(Boolean))),
  })

  const codexBin = await findCodexCli()
  const installed = await installCodexSession({
    codexHome,
    codexBin,
    sessionId: codexId,
    serialized: { ...serialized, createdAt },
    cwd,
    title: title || serialized.firstUserMessage || args.sessionId,
    template,
    createdAt,
    dryRun: args.dryRun === true,
  })

  return {
    mode: 'codex-native',
    sessionId: args.sessionId,
    codexId,
    filePath: installed.rolloutPath,
    rolloutPath: installed.rolloutPath,
    codexHome,
    cwd,
    sourceCwd: sourceCwd || undefined,
    project: project ? { id: project.id, name: project.name, path: project.path } : null,
    projectHint: project ? null : '落在所有 Codex 项目之外（cwd 不在任何 project_roots 下）',
    title: title || basename(cwd || '') || undefined,
    turnCount: serialized.turnCount,
    recordCount: serialized.records.length,
    firstUserMessage: serialized.firstUserMessage || undefined,
    thread: installed.thread || null,
    migration: installed.migration || null,
    ...(handoff.handoff ? { handoff: handoff.handoff } : {}),
    ...(images.unavailable > 0 ? { unavailableImages: images.unavailable } : {}),
    dryRun: args.dryRun === true,
  }
}

export { errorText as codexErrorText }
