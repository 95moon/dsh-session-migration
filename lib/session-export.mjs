// lib/session-export.mjs — 反向导出（DSH → 外部工具）的面板路由与执行体
//
// 为什么单独一个文件：lib/panel.mjs 是入边（发现 / 导入 / registry / 上传），导出是出边，
// 两边唯一共享的是「宿主会话 id」这一个键。执行体复用 lib/export-tool.mjs（export_chat /
// export_bundle 工具同一个函数），这里只补三件工具面没有的东西：
//   1. 会话列表：宿主 sessionPersistence.list()（内存表，零 I/O）+ session_projcache 里折叠
//      好的标题（lib/session-hints.mjs），面板不必为了让用户挑一个会话就整读几十 MB 日志；
//   2. 批量：一次请求导多个会话，逐条失败不拖垮整批（与 import 路由同款口径）；
//   3. markdown：纯文本出边（工具面没有），事件按 DSH 会话日志的 JSONL 形态喂给
//      lib/markdown.mjs 的 sessionJsonlToMarkdown，口径与 CLI 的 export-md 完全一致。
//
// 路由：POST /api-import/export/sessions（列会话）、POST /api-import/export/run（导出）。
// 与 panel.mjs 同一挂载方式（ctx.inject(['webServer']) 后由 registerRoutes 调进来），
// headless / 无 webServer 时回调不执行，工具面照常可用。

import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { readdir } from 'node:fs/promises'
import { listPersistedHeaders, persistedHeaderOf, readSessionRecord, canReadSessionEvents } from './imports.mjs'
import { makeSessionHintProvider } from './session-hints.mjs'
import { sessionJsonlToMarkdown } from './markdown.mjs'
import {
  writeExportFile,
  exportClaudeSession, exportCodexSession, exportKimiSession, exportOpencodeSession, exportBundleSession,
} from './export-tool.mjs'
import { exportCodexNative } from './codex-export.mjs'
import { resolveCodexHome, findCodexCli, readCodexTemplate, matchProjectRoot } from './codex-native.mjs'

const JSON_HEADERS = { 'content-type': 'application/json' }
const errorText = (err) => String((err && err.message) || err)
const badRequest = (error) => [400, { ok: false, error }]

/** 导出格式（面板与 /export 命令共用同一份清单）。
 *  codex-native 与 codex 的区别：codex 只产出一个 rollout.jsonl 给用户自己搬；
 *  codex-native 直接装进本机 Codex 库位（rollout + threads 索引 + 迁移），重开 Codex 就能看到。 */
export const EXPORT_FORMATS = Object.freeze(['claude', 'codex', 'codex-native', 'kimi', 'opencode', 'bundle', 'markdown'])

/** 每格式的默认输出目录（与 export-tool.mjs 内各自缺省一致；面板 placeholder 也读它）。 */
export function defaultOutputDir(format) {
  if (format === 'claude') return join(homedir(), '.claude', 'projects')
  if (format === 'codex-native') return join(resolveCodexHome(), 'sessions')
  return join(homedir(), '.dsh', 'exports')
}

// 单次列表的传输护栏：宿主 list() 本身是内存表，上限只挡响应体积（超出时如实报 total）。
const MAX_ROWS = 800
// 单次请求最多导出的会话数（批量是「补几个会话」，不是搬家工具）
const MAX_BATCH = 200

// 一条 JSON 路由：与 lib/panel.mjs 的 jsonRoute 同形（handler 返回 [状态码, 载荷]，抛错统一 500）。
function jsonRoute(path, handle) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      let status
      let payload
      try {
        [status, payload] = await handle(req)
      } catch (err) {
        status = 500
        payload = { ok: false, error: errorText(err) }
      }
      res.writeHead(status, JSON_HEADERS)
      res.end(JSON.stringify(payload))
    },
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(String(chunk))
  return JSON.parse(chunks.join('') || '{}')
}

/**
 * 列出可导出的 DSH 会话（宿主持久化列表 + 投影缓存标题），按创建时间倒序。
 * 只读：不 load/prepare 任何会话，也不碰导入 registry。
 * @returns [状态码, { ok, sessions, total }]
 */
export async function listExportSessions(ctx) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function') {
    return [500, { ok: false, error: 'sessionPersistence 不可用（需要 list 面）' }]
  }
  let entries
  try {
    const listed = await sp.list()
    entries = Array.isArray(listed) ? listed : []
  } catch (err) {
    return [500, { ok: false, error: '读取会话列表失败：' + errorText(err) }]
  }
  const headers = []
  const rows = []
  for (const entry of entries) {
    // 两套持久化形状（句柄式 snapshot / 直写式 header）只在 persistedHeaderOf 里认一次
    const header = persistedHeaderOf(entry)
    if (!header || typeof header.id !== 'string' || !header.id) continue
    headers.push(header)
    rows.push({
      sessionId: header.id,
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      createdAt: Number.isFinite(header.createdAt) ? header.createdAt : 0,
      ...(header.origin === 'subagent' ? { subagent: true } : {}),
      ...(typeof header.agentPreset === 'string' && header.agentPreset ? { preset: header.agentPreset } : {}),
      ...(Number.isFinite(entry && entry.eventCount) ? { eventCount: entry.eventCount } : {}),
      ...(Number.isFinite(entry && entry.sizeBytes) ? { sizeBytes: entry.sizeBytes } : {}),
    })
  }
  // 标题取自宿主持久投影缓存（sync、零 I/O）。缓存没有就留空——面板显示「未命名会话」，
  // 绝不为了一行标题去整读（可能几十 MB 的）会话日志。
  const hint = makeSessionHintProvider(ctx, headers)
  for (const row of rows) {
    const h = hint({ format: 'dsh4', sessionId: row.sessionId })
    const title = h && typeof h.title === 'string' ? h.title.trim() : ''
    if (title) row.title = title
  }
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return [200, { ok: true, sessions: rows.slice(0, MAX_ROWS), total: rows.length }]
}

// DSH 会话 → Markdown：把 header 合成一条 type:"session" 记录，事件按日志形态逐行串起来，
// 再交给 lib/markdown.mjs（与 CLI export-md 同一渲染器，口径不会漂）。
async function exportMarkdown(ctx, args) {
  const sp = ctx.get('sessionPersistence')
  if (!canReadSessionEvents(sp)) throw new Error('sessionPersistence 不可用（需要读事件面）')
  const record = await readSessionRecord(ctx, args.sessionId, 0)
  if (!record) throw new Error('会话日志读不到：' + args.sessionId)
  const events = Array.isArray(record.events) ? record.events : []
  // header 走 list()（readSessionRecord 的 meta 形态在不同宿主代次间不稳定），cwd/创建时间
  // 只用于 Markdown 顶部那几行元信息，取不到就不写。
  const header = (await listPersistedHeaders(ctx)).find((h) => h && h.id === args.sessionId)
  const head = { type: 'session', id: args.sessionId }
  if (header && typeof header.cwd === 'string' && header.cwd) head.cwd = header.cwd
  if (header && Number.isFinite(header.createdAt)) head.createdAt = header.createdAt
  // 标题：会话日志里通常只有 session/title 事件，也可能只在投影缓存里（用户改过名）。
  // 渲染器只认 session/title 记录，所以这里补一条，让 .md 顶部有一个真标题而不是会话 id。
  const hint = makeSessionHintProvider(ctx, [header].filter(Boolean))
  const title = (hint({ format: 'dsh4', sessionId: args.sessionId }) || {}).title
  const lines = [JSON.stringify(head)]
  if (typeof title === 'string' && title.trim()) lines.push(JSON.stringify({ type: 'session/title', data: { title: title.trim() } }))
  lines.push(...events.map((e) => JSON.stringify(e)))
  const markdown = sessionJsonlToMarkdown(lines.join('\n'))
  const filePath = typeof args.path === 'string' && args.path
    ? args.path
    : join(args.outputDir || defaultOutputDir('markdown'), args.sessionId + '.md')
  // markdown 是「同一个会话 → 同一个 .md」，用户再点一次导出就是要看最新状态；用 overwrite
  // 而不是 createIfAbsent，否则第二次导出会撞 EEXIST（其它格式文件名含 uuid，不会撞）。
  if (args.dryRun !== true) await writeExportFile(ctx, filePath, markdown, { kind: 'overwrite' })
  return {
    sessionId: args.sessionId,
    format: 'markdown',
    filePath,
    recordCount: events.length,
    dryRun: args.dryRun === true,
  }
}

/**
 * 单会话导出分派（面板路由与 /export 命令共用这一个入口，避免两条面各自漂移）。
 * @param ctx 插件 ctx
 * @param args { sessionId, format, outputDir?, path?, cwd?, dryRun? }
 * @returns export-tool 各执行体的返回（filePath / recordCount / degradations…）
 */
export async function exportSession(ctx, args) {
  const format = typeof args.format === 'string' && args.format ? args.format : 'bundle'
  if (!EXPORT_FORMATS.includes(format)) throw new Error('未知导出格式: ' + format)
  const call = { ...args, format }
  if (format === 'markdown') return exportMarkdown(ctx, call)
  if (format === 'bundle') return exportBundleSession(ctx, call)
  if (format === 'codex-native') return exportCodexNative(ctx, call)
  if (format === 'codex') return exportCodexSession(ctx, call)
  if (format === 'kimi') return exportKimiSession(ctx, call)
  if (format === 'opencode') return exportOpencodeSession(ctx, call)
  return exportClaudeSession(ctx, call)
}

/**
 * Codex 库位信息（面板用来显示「将会装进哪个项目」和是否有 CLI 可跑迁移）。
 * 只读：读 state_5.sqlite 的 projects / project_roots + 找一个 codex 可执行文件。
 */
export async function codexStatus() {
  const codexHome = resolveCodexHome()
  let found = null
  try {
    found = await readCodexTemplate(codexHome)
  } catch (err) {
    return [200, { ok: true, codexHome, available: false, error: errorText(err), projects: [] }]
  }
  const bin = await findCodexCli()
  if (!found) {
    return [200, { ok: true, codexHome, available: false, cli: bin || null, projects: [] }]
  }
  const projects = (found.projects || []).map((p) => ({ id: p.id, name: p.name, path: p.path }))
  const seen = new Set()
  const unique = []
  for (const p of projects) {
    const key = String(p.path || '').toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(p)
  }
  return [200, {
    ok: true,
    codexHome,
    available: true,
    cli: bin || null,
    template: {
      modelProvider: found.template.model_provider,
      cliVersion: found.template.cli_version,
      model: found.template.model,
      creatorUserId: found.template.creator_user_id,
    },
    projects: unique,
  }]
}

/**
 * 列一个目录下的子文件夹（面板的「选择项目文件夹」用，避免让用户手打路径）。
 * 只读、只列目录、跳过隐藏项；顺带告诉面板「这个路径会归到哪个 Codex 项目」。
 * @returns [状态码, { ok, path, parent, dirs, project, home }]
 */
export async function browseDirs(body) {
  const home = homedir()
  const wanted = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : home
  const abs = resolvePath(wanted)
  let entries
  try {
    entries = await readdir(abs, { withFileTypes: true })
  } catch (err) {
    return [400, { ok: false, error: '读不到这个目录：' + errorText(err), path: abs }]
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
    .map((e) => ({ name: e.name, path: join(abs, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 300)
  // 项目匹配是「提示」而不是「约束」：用户挑一个不在任何项目下的文件夹也合法
  let project = null
  try {
    const found = await readCodexTemplate(resolveCodexHome())
    const hit = found ? matchProjectRoot(abs, found.projects) : null
    if (hit) project = { id: hit.id, name: hit.name, path: hit.path }
  } catch { /* 读不到 Codex 库就不给提示，选择照常 */ }
  return [200, { ok: true, path: abs, parent: dirname(abs) === abs ? null : dirname(abs), dirs, project, home }]
}

// POST /api-import/export/run：body { sessionIds: string[], format, outputDir?, path?, cwd?, dryRun? }
// 逐条导出，单条失败进 failures 而不是整批 500（与 /import 的条目级错误同款口径）。
async function runExport(ctx, body) {
  const format = typeof body.format === 'string' && body.format ? body.format : 'bundle'
  if (!EXPORT_FORMATS.includes(format)) return badRequest('未知导出格式: ' + format)
  const ids = Array.isArray(body.sessionIds)
    ? body.sessionIds.filter((v) => typeof v === 'string' && v)
    : typeof body.sessionId === 'string' && body.sessionId ? [body.sessionId] : []
  if (ids.length === 0) return badRequest('没有选中要导出的会话')
  const shared = {
    format,
    ...(typeof body.outputDir === 'string' && body.outputDir ? { outputDir: body.outputDir } : {}),
    ...(typeof body.cwd === 'string' && body.cwd ? { cwd: body.cwd } : {}),
    ...(body.dryRun === true ? { dryRun: true } : {}),
  }
  // 显式文件路径只对单会话有意义：多会话共用一个路径会互相覆盖（除 markdown 外的格式
  // 文件名都含 uuid，正常不会撞；markdown 是同一会话同一文件，重复导出按最新覆盖）
  if (typeof body.path === 'string' && body.path) {
    if (ids.length > 1) return badRequest('导出路径只能用于单个会话（多选请用输出目录）')
    shared.path = body.path
  }
  const results = []
  const failures = []
  for (const sessionId of ids.slice(0, MAX_BATCH)) {
    try {
      const out = await exportSession(ctx, { ...shared, sessionId })
      results.push(out)
    } catch (err) {
      failures.push({ sessionId, error: errorText(err) })
    }
  }
  return [200, { ok: true, format, results, failures, outputDirDefault: defaultOutputDir(format) }]
}

/** 挂载导出路由（由 lib/panel.mjs 的 registerRoutes 调用，与其它 /api-import/* 同一 ws）。 */
export function registerExportRoutes(ctx, ws) {
  ws.register(jsonRoute('/api-import/export/sessions', async (req) => {
    await readBody(req) // 统一 POST 契约；畸形 body 照常 500
    return listExportSessions(ctx)
  }))
  ws.register(jsonRoute('/api-import/export/codex-status', async (req) => {
    await readBody(req)
    return codexStatus()
  }))
  ws.register(jsonRoute('/api-import/export/browse', async (req) => browseDirs(await readBody(req))))
  ws.register(jsonRoute('/api-import/export/run', async (req) => runExport(ctx, await readBody(req))))
}
