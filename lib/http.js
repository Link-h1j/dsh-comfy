/**
 * Tiny HTTP helpers shared by the /api/dsh-comfy route family.
 *
 * Every helper stays dependency-free (node:http + node:buffer only) so the same
 * modules can be mounted on the DSH web server and on a plain node:http server
 * (tools/dev-server.mjs) without pulling any DSH package into the host half.
 */
import { IncomingMessage, ServerResponse } from 'node:http' // type-only imports

/** Maximum JSON request body accepted by any route. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Maximum serialized /workflow response (CONTRACT.md §2). */
export const MAX_WORKFLOW_RESPONSE_BYTES = 8 * 1024 * 1024

/**
 * Error carrying an HTTP status plus an optional structured payload.
 * Routes turn these into `{ ok: false, error: <中文> }` responses.
 */
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.extra = extra
  }
}

/** Write a JSON response with UTF-8 and no cache. */
export function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Write a failed JSON response in the contract shape.
 * @param {ServerResponse} res
 * @param {number} status
 * @param {string} message human-readable Chinese message
 * @param {object} [extra] extra fields merged into the body
 */
export function fail(res, status, message, extra = {}) {
  if (res.headersSent) {
    try { res.end() } catch { /* client already gone */ }
    return
  }
  json(res, status, { ok: false, error: message, ...extra })
}

/** True when the request originates from the loopback interface. */
export function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Enforce loopback-only access.
 * @returns true when the request may proceed; a 403 has already been written otherwise.
 */
export function guard(req, res) {
  if (isLoopback(req)) return true
  fail(res, 403, 'forbidden: loopback-only')
  return false
}

/**
 * Reject a request whose method does not match, writing a 405 itself.
 * HEAD is treated as GET where the caller passes 'GET' (no bodies are streamed
 * for HEAD in node:http anyway).
 */
export function requireMethod(req, res, method) {
  const actual = (req.method ?? 'GET').toUpperCase()
  if (actual === method || (method === 'GET' && actual === 'HEAD')) return true
  res.setHeader('allow', method)
  fail(res, 405, `不支持的请求方法：${actual}（应为 ${method}）`)
  return false
}

/** Parse the request URL (query included) without throwing on odd input. */
export function parseUrl(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1')
  } catch {
    return new URL('/', 'http://127.0.0.1')
  }
}

/** Convenience: query parameters of a request. */
export function queryOf(req) {
  return parseUrl(req).searchParams
}

/**
 * Read and parse a JSON request body, bounded.
 * Throws HttpError(413) when the body exceeds the limit and HttpError(400) on
 * malformed JSON, so route handlers never have to special-case it.
 */
export async function readJson(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, `请求体过大（上限 ${Math.round(limit / 1024 / 1024)} MiB）`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON')
  }
}

/**
 * Reply with raw bytes (used by /view to proxy ComfyUI file content).
 * @param {ServerResponse} res
 * @param {number} status
 * @param {Record<string,string>} headers
 * @param {Buffer|Uint8Array} bytes
 */
export function sendBytes(res, status, headers, bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  res.writeHead(status, {
    'cache-control': 'no-store',
    ...headers,
    'content-length': body.length,
  })
  if ((res.req?.method ?? 'GET').toUpperCase() === 'HEAD') res.end()
  else res.end(body)
}

/** True when a value is a plain JSON object (not null, not an array). */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
