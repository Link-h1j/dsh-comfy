/**
 * ComfyUI HTTP transport for the /api/dsh-comfy host half.
 *
 * Responsibilities:
 *  - resolve the ComfyUI base URL (env override, then probe 8188, then 8189) and
 *    cache the winner for a short TTL, re-probing when the cached one dies;
 *  - every call goes through `comfyFetch` with an abort timeout and a Chinese
 *    error message (the browser half shows errors verbatim);
 *  - cache `/object_info` (≈3.7 MB / 1584 node types on this machine) so the
 *    workflow list and converter do not refetch it per request;
 *  - expose the small ComfyUI surface the plugin needs: system stats, queue,
 *    history, prompt submit, interrupt, queue clear, and /view proxying.
 *
 * No dependencies beyond global fetch (Node >= 22).
 */

/** Env override: one explicit base URL wins over auto-detection. */
const ENV_URL = (process.env.DSH_COMFY_URL ?? process.env.DSH_COMFY_BASE_URL ?? '').trim()

/** Ports probed (in order) when no explicit URL is configured. */
const DEFAULT_PORTS = [8188, 8189]

/** How long a resolved base URL is trusted before re-probing. */
const RESOLVE_TTL_MS = 15_000

/** object_info cache lifetime (node definitions only change on ComfyUI restart). */
const OBJECT_INFO_TTL_MS = 120_000

/** Cached resolved base URL and its timestamp. */
let resolvedBase = null
let resolvedAt = 0

/** In-flight object_info promise (dedupe concurrent calls). */
let objectInfoPromise = null
let objectInfoCache = null
let objectInfoAt = 0

/** Stable client id shared by all prompts submitted from this host process. */
const CLIENT_ID = `dsh-comfy-${Math.random().toString(36).slice(2, 10)}`

/**
 * Error raised for any ComfyUI transport/HTTP problem. `status` lets routes map
 * it to an HTTP status without knowing transport details.
 */
export class ComfyError extends Error {
  constructor(message, { code = 'comfy-error', status = 503, cause } = {}) {
    super(message)
    this.name = 'ComfyError'
    this.code = code
    this.status = status
    if (cause !== undefined) this.cause = cause
  }
}

/** Normalize a URL (strip trailing slashes). */
function normalizeBase(url) {
  return String(url).replace(/\/+$/, '')
}

/** All base URL candidates in probe order. */
function candidates() {
  if (ENV_URL !== '') return [normalizeBase(ENV_URL)]
  return DEFAULT_PORTS.map(port => `http://127.0.0.1:${port}`)
}

/** The URL used for display when nothing is reachable. */
export function configuredBaseUrl() {
  return candidates()[0]
}

/**
 * Resolve (and cache) the ComfyUI base URL by probing `/system_stats`.
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<string>} resolved URL; the first candidate when none answer.
 */
export async function getBaseUrl({ force = false } = {}) {
  if (!force && resolvedBase !== null && Date.now() - resolvedAt < RESOLVE_TTL_MS) return resolvedBase
  for (const base of candidates()) {
    try {
      const res = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) {
        resolvedBase = base
        resolvedAt = Date.now()
        return base
      }
    } catch {
      // try the next candidate
    }
  }
  resolvedBase = null
  resolvedAt = 0
  return candidates()[0]
}

/** Human-readable text for a fetch failure. */
function describeFetchError(error, base) {
  const cause = error?.cause ?? error
  const code = cause?.code ?? ''
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return `ComfyUI 未运行或无法连接（${base}）`
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `无法解析 ComfyUI 地址（${base}）`
  if (cause?.name === 'TimeoutError' || error?.name === 'TimeoutError') return `请求 ComfyUI 超时（${base}）`
  return `请求 ComfyUI 失败（${base}）：${cause?.message ?? String(error)}`
}

/**
 * Fetch a ComfyUI path with a timeout and normalized errors.
 * @param {string} pathname e.g. '/queue'
 * @param {RequestInit} [init]
 * @param {number} [timeoutMs]
 * @returns {Promise<Response>}
 */
export async function comfyFetch(pathname, init = {}, timeoutMs = 15_000) {
  const base = await getBaseUrl()
  try {
    return await fetch(`${base}${pathname}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    // The cached base may be stale (ComfyUI restarted on another port): forget it.
    resolvedBase = null
    resolvedAt = 0
    const detail = describeFetchError(error, base)
    throw new ComfyError(detail, { code: 'comfy-unreachable', status: 503, cause: error })
  }
}

/** GET a ComfyUI JSON endpoint, normalizing HTTP failures. */
async function getJson(pathname, timeoutMs = 15_000) {
  const res = await comfyFetch(pathname, { headers: { accept: 'application/json' } }, timeoutMs)
  if (!res.ok) throw new ComfyError(`ComfyUI 返回 HTTP ${res.status}（${pathname}）`, { code: 'comfy-http', status: 502 })
  try {
    return await res.json()
  } catch (error) {
    throw new ComfyError(`ComfyUI 返回了无法解析的 JSON（${pathname}）`, { code: 'comfy-json', status: 502, cause: error })
  }
}

/** POST a ComfyUI JSON endpoint, returning the parsed body even on 4xx. */
async function postJson(pathname, payload, timeoutMs = 30_000) {
  const res = await comfyFetch(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload ?? {}),
  }, timeoutMs)
  let body = null
  try { body = await res.json() } catch { body = null }
  return { status: res.status, ok: res.ok, body }
}

/** Lightweight reachability check (no object_info fetch). */
export async function checkReachable({ timeoutMs = 2500 } = {}) {
  const base = await getBaseUrl({ force: true })
  try {
    const res = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { reachable: false, baseUrl: base, error: `ComfyUI 返回 HTTP ${res.status}` }
    return { reachable: true, baseUrl: base }
  } catch (error) {
    return { reachable: false, baseUrl: base, error: describeFetchError(error, base) }
  }
}

/** Read `/queue` (running/pending arrays). */
export async function getQueue() {
  const body = await getJson('/queue', 8_000)
  return {
    running: Array.isArray(body?.queue_running) ? body.queue_running : [],
    pending: Array.isArray(body?.queue_pending) ? body.queue_pending : [],
  }
}

/** Read `/history` (map promptId -> entry). `maxItems` maps to ComfyUI's max_items. */
export async function getHistory({ maxItems } = {}) {
  const query = Number.isFinite(maxItems) && maxItems > 0 ? `?max_items=${encodeURIComponent(String(maxItems))}` : ''
  return getJson(`/history${query}`, 20_000)
}

/** Read `/history/<promptId>`; returns the entry or null when unknown. */
export async function getHistoryFor(promptId) {
  const body = await getJson(`/history/${encodeURIComponent(promptId)}`, 20_000)
  const entry = body?.[promptId]
  return entry ?? null
}

/** Submit an API prompt. Returns `{ status, ok, body }` (body has prompt_id / node_errors). */
export async function submitPrompt(prompt) {
  return postJson('/prompt', { prompt, client_id: CLIENT_ID }, 30_000)
}

/** Interrupt the running prompt (optionally only that prompt id). */
export async function interrupt(promptId) {
  const payload = typeof promptId === 'string' && promptId !== '' ? { prompt_id: promptId } : {}
  const result = await postJson('/interrupt', payload, 10_000)
  if (!result.ok) throw new ComfyError(`中断失败：ComfyUI 返回 HTTP ${result.status}`, { code: 'comfy-http', status: 502 })
  return true
}

/** Clear the pending queue. */
export async function clearQueue() {
  const result = await postJson('/queue', { clear: true }, 10_000)
  if (!result.ok) throw new ComfyError(`清空队列失败：ComfyUI 返回 HTTP ${result.status}`, { code: 'comfy-http', status: 502 })
  return true
}

/**
 * Proxy one ComfyUI output file (`/view`).
 * @param {{ filename: string, subfolder?: string, type?: string }} params
 * @returns {Promise<{ status: number, headers: Headers, buffer: Buffer }>}
 */
export async function viewFile({ filename, subfolder = '', type = 'output' }) {
  const query = new URLSearchParams({
    filename: String(filename),
    subfolder: String(subfolder),
    type: String(type),
  })
  const res = await comfyFetch(`/view?${query.toString()}`, { headers: { accept: '*/*' } }, 120_000)
  const buffer = Buffer.from(await res.arrayBuffer())
  return { status: res.status, headers: res.headers, buffer }
}

/**
 * `/system_stats` mapped to the compact shape used by `GET /status`.
 */
export async function systemStats() {
  const body = await getJson('/system_stats', 6_000)
  const devices = Array.isArray(body?.devices) ? body.devices.map(device => ({
    name: device?.name ?? '',
    type: device?.type ?? '',
    vramTotal: device?.vram_total ?? 0,
    vramFree: device?.vram_free ?? 0,
  })) : []
  return {
    version: body?.system?.comfyui_version ?? null,
    python: body?.system?.python_version ?? null,
    devices,
  }
}

/**
 * Probe ComfyUI for `GET /status`. Never throws: failures become `reachable:false`.
 */
export async function probe() {
  const base = await getBaseUrl()
  try {
    const [stats, queue] = await Promise.all([systemStats(), getQueue()])
    return {
      reachable: true,
      baseUrl: base,
      version: stats.version,
      python: stats.python,
      devices: stats.devices,
      queue: { running: queue.running.length, pending: queue.pending.length },
    }
  } catch (error) {
    return {
      reachable: false,
      baseUrl: base,
      devices: [],
      queue: { running: 0, pending: 0 },
      error: error?.message ?? String(error),
    }
  }
}

/**
 * `/object_info`, cached. Throws ComfyError when ComfyUI is unreachable.
 * @param {{ refresh?: boolean }} [opts]
 */
export async function getObjectInfo({ refresh = false } = {}) {
  if (!refresh && objectInfoCache !== null && Date.now() - objectInfoAt < OBJECT_INFO_TTL_MS) return objectInfoCache
  if (objectInfoPromise !== null) return objectInfoPromise
  objectInfoPromise = (async () => {
    const body = await getJson('/object_info', 30_000)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ComfyError('ComfyUI 的 /object_info 返回结构异常', { code: 'comfy-json', status: 502 })
    }
    objectInfoCache = body
    objectInfoAt = Date.now()
    return body
  })().finally(() => { objectInfoPromise = null })
  return objectInfoPromise
}

/** object_info for graph building: `null` instead of throwing when offline. */
export async function getObjectInfoSafe() {
  try {
    return await getObjectInfo()
  } catch {
    return null
  }
}

/** The client id this host uses for /prompt submissions (exposed for tests). */
export function clientId() {
  return CLIENT_ID
}
