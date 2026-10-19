/**
 * Host route table for the dsh-comfy plugin — the complete `/api/dsh-comfy/*`
 * family from CONTRACT.md §2.
 *
 * Note: DSH hot-reloads this plugin when the host half changes; every endpoint
 * is a plain node:http handler so it can also be mounted by tools/dev-server.mjs
 * for curl/smoke testing without DSH.
 *
 * `makeRoutes(ctx)` keeps the signature index.js expects; the optional second
 * argument is only used by tools/dev-server.mjs (extra dev-only workflow source
 * for smoke tests) and is ignored by the production entry point.
 *
 * Each route is `{ kind: 'exact', path, handler }`, matching what
 * `ctx.webServer.register()` accepts. Every handler:
 *   - enforces loopback-only access and the HTTP method;
 *   - writes JSON in the contract shape (`{ok:true,...}` / `{ok:false,error:<中文>}`);
 *   - maps ConvertError / SourceError / RunnerError / ComfyError to meaningful
 *     HTTP statuses instead of leaking stack traces.
 */
import {
  HttpError,
  MAX_WORKFLOW_RESPONSE_BYTES,
  fail,
  guard,
  json,
  queryOf,
  readJson,
  requireMethod,
  sendBytes,
  isPlainObject,
} from './http.js'
import * as comfy from './comfy.js'
import * as sources from './sources.js'
import * as runner from './runner.js'
import { ConvertError, uiToPrompt } from './convert.js'
import { toGraph } from './graph.js'
import { StartError } from './start.js'
import { startComfy } from './start.js'

/** Route prefix shared by the whole family. */
const PREFIX = '/api/dsh-comfy'

/**
 * Map any thrown error to `{ status, message, extra }`.
 * User-facing messages are already Chinese; only unknown errors get a generic one.
 */
function mapError(error) {
  if (error instanceof HttpError) return { status: error.status, message: error.message, extra: error.extra }
  if (error instanceof sources.SourceError) return { status: error.status ?? 500, message: error.message, extra: { code: error.code } }
  if (error instanceof ConvertError) {
    const status = error.code === 'no-object-info' ? 503 : 400
    return { status, message: error.message, extra: { code: error.code, ...(error.details ?? {}) } }
  }
  if (error instanceof runner.RunnerError) return { status: error.status ?? 502, message: error.message, extra: { code: error.code } }
  if (error instanceof comfy.ComfyError) return { status: error.status ?? 503, message: error.message, extra: { code: error.code } }
  if (error instanceof StartError) return { status: error.status ?? 500, message: error.message, extra: { code: error.code } }
  console.error('[dsh-comfy] 未处理的错误:', error)
  return { status: 500, message: `内部错误：${error?.message ?? String(error)}`, extra: {} }
}

/** Wrap a handler with the loopback/method guards and error mapping. */
async function dispatch(req, res, method, handler) {
  if (!guard(req, res)) return
  if (!requireMethod(req, res, method)) return
  try {
    await handler(req, res)
  } catch (error) {
    const { status, message, extra } = mapError(error)
    fail(res, status, message, extra)
  }
}

/** Build one route entry. */
function route(pathname, method, handler) {
  return {
    kind: 'exact',
    path: `${PREFIX}${pathname}`,
    handler: (req, res) => { void dispatch(req, res, method, handler) },
  }
}

/**
 * Build the route table.
 * @param {unknown} [_ctx] host context (unused: the host half calls ComfyUI directly)
 * @param {{ extraSources?: Array<{id:string,label:string,roots:string[]}> }} [options]
 *   dev-only extra workflow sources (used by tools/dev-server.mjs smoke tests)
 * @returns {Array<{kind:'exact', path:string, handler:Function}>}
 */
export function makeRoutes(_ctx, options = {}) {
  const sourceOptions = { extraSources: options?.extraSources ?? [] }

  /* GET /status — ComfyUI reachability, version, devices, queue, start script. */
  const status = route('/status', 'GET', async (_req, res) => {
    const probed = await comfy.probe()
    const script = sources.startScript()
    json(res, 200, {
      ok: true,
      reachable: probed.reachable === true,
      baseUrl: probed.baseUrl,
      ...(probed.version === null || probed.version === undefined ? {} : { version: probed.version }),
      ...(probed.python === null || probed.python === undefined ? {} : { python: probed.python }),
      devices: probed.devices ?? [],
      queue: probed.queue ?? { running: 0, pending: 0 },
      startScriptExists: script.exists === true,
      ...(probed.error === undefined ? {} : { error: probed.error }),
    })
  })

  /* POST /start — detached launch of the configured ComfyUI start script, idempotent. */
  const start = route('/start', 'POST', async (_req, res) => {
    const result = await startComfy()
    json(res, 200, { ok: true, started: result.started === true, message: result.message })
  })

  /* GET /workflows — every discoverable workflow grouped by source. */
  const workflows = route('/workflows', 'GET', async (_req, res) => {
    const listed = await sources.listWorkflows(sourceOptions)
    json(res, 200, { ok: true, sources: listed.sources, items: listed.items })
  })

  /* GET /workflow?id=... — normalized Graph for one workflow (UI or API format). */
  const workflow = route('/workflow', 'GET', async (req, res) => {
    const id = queryOf(req).get('id')
    if (typeof id !== 'string' || id === '') {
      throw new HttpError(400, '缺少 id 参数（工作流 id，形如 <来源>::<相对路径>）')
    }
    const loaded = await sources.readWorkflow(id, sourceOptions)
    const objectInfo = await comfy.getObjectInfoSafe()
    const normalized = toGraph(loaded.json, objectInfo)
    const payload = {
      ok: true,
      id: loaded.item.id,
      name: loaded.item.name,
      source: loaded.item.source,
      relPath: loaded.item.relPath,
      kind: normalized.kind,
      graph: normalized.graph,
      warnings: normalized.warnings,
    }
    // Contract: /workflow responses are capped at 8 MiB.
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_WORKFLOW_RESPONSE_BYTES) {
      throw new HttpError(413, '工作流过大（超过 8 MiB 响应上限）')
    }
    json(res, 200, payload)
  })

  /* POST /run {id, overrides?} — convert and queue a workflow. */
  const run = route('/run', 'POST', async (req, res) => {
    const body = await readJson(req)
    const id = typeof body?.id === 'string' ? body.id : ''
    if (id === '') throw new HttpError(400, '缺少 id（要运行的工作流 id）')
    const overrides = body?.overrides
    if (overrides !== undefined && overrides !== null && !isPlainObject(overrides)) {
      throw new HttpError(400, 'overrides 必须是对象（键为 "<节点id>.<输入名>"）')
    }
    const loaded = await sources.readWorkflow(id, sourceOptions)
    const objectInfo = await comfy.getObjectInfo()
    const converted = uiToPrompt(loaded.json, objectInfo, { overrides: overrides ?? {} })
    const submitted = await runner.submit(converted.prompt)
    json(res, 200, {
      ok: true,
      promptId: submitted.promptId,
      number: submitted.number,
      warnings: converted.warnings.slice(0, 100),
      queued: true,
    })
  })

  /* GET /progress?promptId=... — queued/running/done/error state. */
  const progress = route('/progress', 'GET', async (req, res) => {
    const promptId = queryOf(req).get('promptId')
    if (typeof promptId !== 'string' || promptId === '') {
      throw new HttpError(400, '缺少 promptId 参数')
    }
    const state = await runner.progress(promptId)
    json(res, 200, { ok: true, ...state })
  })

  /* POST /interrupt — stop the running prompt. */
  const interrupt = route('/interrupt', 'POST', async (_req, res) => {
    await runner.interrupt()
    json(res, 200, { ok: true })
  })

  /* POST /clear-queue — drop pending prompts. */
  const clearQueue = route('/clear-queue', 'POST', async (_req, res) => {
    await runner.clearQueue()
    json(res, 200, { ok: true })
  })

  /* GET /history?limit=N — recent runs, newest first. */
  const history = route('/history', 'GET', async (req, res) => {
    const rawLimit = queryOf(req).get('limit')
    const parsed = Number.parseInt(rawLimit ?? '10', 10)
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 50) : 10
    const runs = await runner.history(limit)
    json(res, 200, { ok: true, runs })
  })

  /* GET /view?filename=&subfolder=&type= — proxy ComfyUI output bytes. */
  const view = route('/view', 'GET', async (req, res) => {
    const query = queryOf(req)
    const filename = query.get('filename')
    if (typeof filename !== 'string' || filename === '') {
      throw new HttpError(400, '缺少 filename 参数')
    }
    const subfolder = query.get('subfolder') ?? ''
    if (filename.includes('\0') || filename.includes('..') || subfolder.includes('\0') || subfolder.includes('..')) {
      throw new HttpError(400, 'filename/subfolder 不合法')
    }
    const typeRaw = query.get('type') ?? 'output'
    const type = typeRaw === 'input' || typeRaw === 'temp' ? typeRaw : 'output'
    const result = await comfy.viewFile({ filename, subfolder, type })
    if (result.status !== 200) {
      const status = result.status === 404 ? 404 : 502
      throw new HttpError(status, status === 404 ? '找不到该输出文件' : `读取输出文件失败：HTTP ${result.status}`)
    }
    const contentType = result.headers.get('content-type') ?? 'application/octet-stream'
    sendBytes(res, 200, { 'content-type': contentType }, result.buffer)
  })

  return [status, start, workflows, workflow, run, progress, interrupt, clearQueue, history, view]
}
