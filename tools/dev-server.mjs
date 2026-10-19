#!/usr/bin/env node
/**
 * Standalone dev server for the /api/dsh-comfy host half.
 *
 * Mounts the exact same `makeRoutes()` table index.js gives to the DSH web
 * server onto a plain node:http server, so every endpoint can be curl-tested
 * before the plugin is exercised inside DSH. It deliberately imports nothing
 * from DSH.
 *
 * Usage:
 *   node tools/dev-server.mjs                 # http://127.0.0.1:8199
 *   set DSH_COMFY_DEV_PORT=9123 && node tools/dev-server.mjs
 *   set DSH_COMFY_DEV_FIXTURES=0 && node tools/dev-server.mjs   # hide tools/fixtures
 *
 * The dev-only `fixtures` source (tools/fixtures/**) lets smoke.mjs run the tiny
 * EmptyImage -> SaveImage workflows through the real /run + /progress + /view
 * chain. It is never mounted by the production plugin entry point.
 */
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { makeRoutes } from '../lib/routes.js'

const PORT = Number(process.env.DSH_COMFY_DEV_PORT ?? process.env.PORT ?? 8199)
const HOST = '127.0.0.1'
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url))
const INCLUDE_FIXTURES = process.env.DSH_COMFY_DEV_FIXTURES !== '0'

const extraSources = INCLUDE_FIXTURES
  ? [{ id: 'fixtures', label: '测试夹具', kind: 'fixtures', roots: [FIXTURES_DIR] }]
  : []

const routes = makeRoutes(undefined, { extraSources })

/** Find the route matching a pathname (exact first, then prefix). */
function findRoute(pathname) {
  let prefixMatch = null
  for (const route of routes) {
    if (route.kind === 'prefix') {
      if (prefixMatch === null && (pathname === route.path || pathname.startsWith(route.path.endsWith('/') ? route.path : `${route.path}/`))) {
        prefixMatch = route
      }
    } else if (route.path === pathname) {
      return route
    }
  }
  return prefixMatch ?? undefined
}

const server = http.createServer((req, res) => {
  let pathname
  try {
    pathname = new URL(req.url ?? '/', `http://${HOST}`).pathname
  } catch {
    pathname = '/'
  }
  const route = findRoute(pathname)
  if (route === undefined) {
    const body = JSON.stringify({ ok: false, error: `未知接口：${pathname}` })
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
    return
  }
  Promise.resolve()
    .then(() => route.handler(req, res))
    .catch((error) => {
      console.error('[dev-server] handler crashed:', error)
      if (!res.headersSent) {
        const body = JSON.stringify({ ok: false, error: `开发服务器内部错误：${error?.message ?? String(error)}` })
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
        res.end(body)
      } else {
        try { res.end() } catch { /* ignore */ }
      }
    })
})

server.listen(PORT, HOST, () => {
  console.log(`[dsh-comfy dev-server] http://${HOST}:${PORT}`)
  console.log(`[dsh-comfy dev-server] routes: ${routes.map(route => route.path).join(', ')}`)
  if (INCLUDE_FIXTURES) console.log(`[dsh-comfy dev-server] fixtures source: ${FIXTURES_DIR}`)
})

/** Clean shutdown for smoke.mjs (SIGTERM) and Ctrl+C. */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
  })
}
