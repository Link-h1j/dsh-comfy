#!/usr/bin/env node
/**
 * End-to-end smoke test for the dsh-comfy host half.
 *
 * Boots tools/dev-server.mjs on a local test port (default 8199), then exercises
 * every /api/dsh-comfy endpoint over real HTTP — including a real queue round
 * trip of the tiny EmptyImage -> SaveImage fixtures (UI and API formats) with
 * /progress polling and PNG byte proxying through /view.
 *
 * The fixtures are mounted as a dev-only `fixtures` source by dev-server.mjs;
 * the production plugin only exposes user/workspace/templates (CONTRACT.md §2).
 *
 * Requirements: ComfyUI running at http://127.0.0.1:8188 (auto-detected; 8189 is
 * the fallback). Tiny 64x64 runs only: no models, no GPU-heavy work.
 *
 * Usage: node tools/smoke.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as comfy from '../lib/comfy.js'
import * as sources from '../lib/sources.js'
import { uiToPrompt } from '../lib/convert.js'
import { toGraph } from '../lib/graph.js'

const PORT = Number(process.env.DSH_COMFY_SMOKE_PORT ?? 8199)
const BASE = `http://127.0.0.1:${PORT}`
const DEV_SERVER = fileURLToPath(new URL('./dev-server.mjs', import.meta.url))
const RUN_TIMEOUT_MS = 180_000

let passed = 0
const failed = []

/** Record one assertion. */
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`PASS ${name}`)
  } else {
    failed.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
    console.log(`FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/** GET helper returning {status, body, bytes, headers}. */
async function get(path, { raw = false } = {}) {
  const response = await fetch(`${BASE}${path}`)
  if (raw) {
    return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) }
  }
  let body = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body, headers: response.headers }
}

/** POST helper returning {status, body}. */
async function post(path, payload = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
  let body = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body }
}

/** Poll /progress until done/error or timeout. */
async function waitForRun(promptId) {
  const deadline = Date.now() + RUN_TIMEOUT_MS
  let last = null
  while (Date.now() < deadline) {
    const result = await get(`/api/dsh-comfy/progress?promptId=${encodeURIComponent(promptId)}`)
    last = result.body
    if (result.status !== 200) return { state: 'http-error', status: result.status, last: result }
    if (last?.state === 'done' || last?.state === 'error') return last
    await new Promise(resolve => setTimeout(resolve, 800))
  }
  return { state: 'timeout', last }
}

/** Wait until dev-server answers /status. */
async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/dsh-comfy/status`)
      if (response.ok) return true
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

async function main() {
  console.log(`[smoke] ComfyUI base: ${comfy.configuredBaseUrl()}`)
  const server = spawn(process.execPath, [DEV_SERVER], {
    env: { ...process.env, DSH_COMFY_DEV_PORT: String(PORT), DSH_COMFY_DEV_FIXTURES: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let serverLog = ''
  server.stdout.on('data', chunk => { serverLog += String(chunk) })
  server.stderr.on('data', chunk => { serverLog += String(chunk) })

  try {
    const ready = await waitForServer()
    check('dev-server boots and answers /status', ready, serverLog.slice(-500))
    if (!ready) return

    /* ---------------- status ---------------- */
    const status = await get('/api/dsh-comfy/status')
    check('GET /status -> 200', status.status === 200)
    check('status.ok is true', status.body?.ok === true)
    check('status.reachable is true', status.body?.reachable === true, status.body?.error)
    check('status.baseUrl is loopback', /^http:\/\/127\.0\.0\.1:\d+$/.test(status.body?.baseUrl ?? ''), status.body?.baseUrl)
    check('status.version present', typeof status.body?.version === 'string' && status.body.version !== '', status.body?.version)
    check('status.devices populated', Array.isArray(status.body?.devices) && status.body.devices.length > 0)
    const device = status.body?.devices?.[0] ?? {}
    check('status.device fields', typeof device.name === 'string' && typeof device.type === 'string'
      && Number.isFinite(device.vramTotal) && Number.isFinite(device.vramFree))
    check('status.queue numbers', Number.isFinite(status.body?.queue?.running) && Number.isFinite(status.body?.queue?.pending))
    check('status.startScriptExists', status.body?.startScriptExists === true)

    /* ---------------- workflows ---------------- */
    const workflows = await get('/api/dsh-comfy/workflows')
    check('GET /workflows -> 200', workflows.status === 200)
    const sourceIds = (workflows.body?.sources ?? []).map(source => source.id)
    check('workflows.sources = user/workspace/templates', ['user', 'workspace', 'templates'].every(id => sourceIds.includes(id)), sourceIds.join(','))
    const items = Array.isArray(workflows.body?.items) ? workflows.body.items : []
    check('workflows.items not empty', items.length > 0, String(items.length))

    const userItem = items.find(item => item.source === 'user' && item.name.startsWith('SF_H3'))
    check('user workflow listed (kind ui)', userItem?.kind === 'ui', JSON.stringify(userItem))
    const workspaceItem = items.find(item => item.source === 'workspace' && item.name === 'hunyuan3d_image_to_model_api.json')
    check('workspace api workflow listed (kind api)', workspaceItem?.kind === 'api', JSON.stringify(workspaceItem))
    const templateItems = items.filter(item => item.source === 'templates')
    check('official templates listed', templateItems.length >= 250, String(templateItems.length))
    check('api_ templates skipped', templateItems.every(item => !item.name.startsWith('api_')))
    check('template index files skipped', templateItems.every(item => !/^index[._-]/i.test(item.name)))
    check('item ids use <source>::<relPath>', items.every(item => item.id === `${item.source}::${item.relPath}`))
    check('items carry size/mtime/disabled', items.every(item => Number.isFinite(item.size) && Number.isFinite(item.mtime) && item.disabled === false))

    /* ---------------- id safety ---------------- */
    const traversal = await get(`/api/dsh-comfy/workflow?id=${encodeURIComponent('user::../../../../Windows/win.ini')}`)
    check('path traversal rejected', traversal.status === 400 && traversal.body?.ok === false, `${traversal.status} ${traversal.body?.error}`)
    const badSource = await get(`/api/dsh-comfy/workflow?id=${encodeURIComponent('evil::x.json')}`)
    check('unknown source rejected', badSource.status === 400 && badSource.body?.ok === false, `${badSource.status} ${badSource.body?.error}`)
    const missingFile = await get(`/api/dsh-comfy/workflow?id=${encodeURIComponent('user::does-not-exist.json')}`)
    check('missing workflow -> 404', missingFile.status === 404 && missingFile.body?.ok === false, `${missingFile.status}`)
    const noId = await get('/api/dsh-comfy/workflow')
    check('workflow without id -> 400', noId.status === 400 && noId.body?.ok === false)
    const unknownRoute = await get('/api/dsh-comfy/nope')
    check('unknown route -> 404', unknownRoute.status === 404)

    /* ---------------- workflow (UI) ---------------- */
    const uiWorkflow = await get(`/api/dsh-comfy/workflow?id=${encodeURIComponent(userItem.id)}`)
    check('GET /workflow (UI) -> 200', uiWorkflow.status === 200)
    check('UI workflow kind=ui', uiWorkflow.body?.kind === 'ui')
    check('UI workflow 15 nodes', uiWorkflow.body?.graph?.stats?.nodeCount === 15, String(uiWorkflow.body?.graph?.stats?.nodeCount))
    check('UI workflow 13 edges', uiWorkflow.body?.graph?.stats?.edgeCount === 13, String(uiWorkflow.body?.graph?.stats?.edgeCount))
    check('UI workflow 4 groups', (uiWorkflow.body?.graph?.groups ?? []).length === 4)
    const graphNodes = uiWorkflow.body?.graph?.nodes ?? []
    const samplerNode = graphNodes.find(node => node.id === '10')
    check('node 10 present with title', samplerNode?.type === 'H3SeamlessChainSampler' && typeof samplerNode.title === 'string' && samplerNode.title !== '')
    check('node 10 has editable widgets', (samplerNode?.widgets ?? []).length >= 25, String((samplerNode?.widgets ?? []).length))
    const seedWidget = (samplerNode?.widgets ?? []).find(widget => widget.name === '种子')
    check('node 10 seed widget value preserved', seedWidget?.value === 19389496656561 && seedWidget?.kind === 'number', JSON.stringify(seedWidget))
    const samplerWidget = (samplerNode?.widgets ?? []).find(widget => widget.name === '采样器')
    check('combo widget carries options', samplerWidget?.kind === 'combo' && Array.isArray(samplerWidget.options) && samplerWidget.options.includes('res_multistep'))
    const sparseNode = graphNodes.find(node => node.id === '60')
    const tauWidget = (sparseNode?.widgets ?? []).find(widget => widget.name === 'selection.tau')
    check('dynamic-combo nested widget exposed', tauWidget?.value === 1.3 && tauWidget?.kind === 'number', JSON.stringify(tauWidget))
    check('node coords/size are numbers', graphNodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.w) && Number.isFinite(node.h)))
    check('node ids are strings', graphNodes.every(node => typeof node.id === 'string'))
    check('UI workflow has no missing types', uiWorkflow.body?.graph?.stats?.missingTypes?.length === 0, JSON.stringify(uiWorkflow.body?.graph?.stats?.missingTypes))
    check('UI workflow has no warnings', (uiWorkflow.body?.warnings ?? []).length === 0, JSON.stringify(uiWorkflow.body?.warnings))
    check('graph nodes carry categories', graphNodes.filter(node => node.type !== 'MarkdownNote').every(node => typeof node.category === 'string'))

    /* ---------------- workflow (API) ---------------- */
    const apiWorkflow = await get(`/api/dsh-comfy/workflow?id=${encodeURIComponent(workspaceItem.id)}`)
    check('GET /workflow (API) -> 200', apiWorkflow.status === 200)
    check('API workflow kind=api', apiWorkflow.body?.kind === 'api')
    check('API workflow node count = 10', apiWorkflow.body?.graph?.stats?.nodeCount === 10, String(apiWorkflow.body?.graph?.stats?.nodeCount))
    check('API workflow has edges', (apiWorkflow.body?.graph?.stats?.edgeCount ?? 0) > 0, String(apiWorkflow.body?.graph?.stats?.edgeCount))
    const apiGraphNodes = apiWorkflow.body?.graph?.nodes ?? []
    const loaderNode = apiGraphNodes.find(node => node.id === '1')
    check('API node widgets parsed', loaderNode?.type === 'ImageOnlyCheckpointLoader'
      && (loaderNode?.widgets ?? []).some(widget => widget.name === 'ckpt_name'), JSON.stringify(loaderNode?.widgets))
    check('API nodes auto-laid out in layers', new Set(apiGraphNodes.map(node => node.x)).size > 1)
    check('API workflow has no warnings', (apiWorkflow.body?.warnings ?? []).length === 0, JSON.stringify(apiWorkflow.body?.warnings))

    /* ---------------- conversion against live object_info ---------------- */
    const objectInfo = await comfy.getObjectInfo()
    const loaded = await sources.readWorkflow(userItem.id)
    const converted = uiToPrompt(loaded.json, objectInfo)
    const prompt = converted.prompt
    check('convert(user UI workflow) -> 9 executable nodes', Object.keys(prompt).length === 9, String(Object.keys(prompt).length))
    check('convert: every class_type exists in object_info', Object.values(prompt).every(node => objectInfo[node.class_type] !== undefined))
    check('convert: muted/bypassed nodes dropped', !('64' in prompt) && !('69' in prompt) && !('71' in prompt))
    check('convert: bypassed LoRA passthrough resolved', JSON.stringify(prompt['53']?.inputs?.model) === JSON.stringify(['63', 0]), JSON.stringify(prompt['53']?.inputs?.model))
    check('convert: seed widget preserved', prompt['10']?.inputs?.['种子'] === 19389496656561)
    check('convert: dynamic combo flat keys preserved', prompt['60']?.inputs?.selection === 'sol-attn' && prompt['60']?.inputs?.['selection.tau'] === 1.3)
    check('convert: frontend control key dropped', Object.values(prompt).every(node => !('control_after_generate' in (node.inputs ?? {}))))
    let namedMismatch = []
    for (const node of loaded.json.nodes) {
      const nodePrompt = prompt[String(node.id)]
      if (nodePrompt === undefined) continue
      for (const [key, value] of Object.entries(node.widgets_values_named ?? {})) {
        if (key === 'control_after_generate') continue
        if (key === '二采模型') continue
        if (JSON.stringify(nodePrompt.inputs[key]) !== JSON.stringify(value)) namedMismatch.push(`${node.id}.${key}`)
      }
    }
    check('convert: converted inputs match widgets_values_named', namedMismatch.length === 0, namedMismatch.slice(0, 5).join(','))
    check('convert: warnings empty for user workflow', converted.warnings.length === 0, JSON.stringify(converted.warnings))

    // positional fallback + overrides on the tiny fixture
    const { readFile } = await import('node:fs/promises')
    const fixture = JSON.parse(await readFile(new URL('./fixtures/minimal_ui.json', import.meta.url), 'utf8'))
    const fixtureConverted = uiToPrompt(fixture, objectInfo)
    const positionalFixture = JSON.parse(JSON.stringify(fixture))
    for (const node of positionalFixture.nodes) delete node.widgets_values_named
    const positionalConverted = uiToPrompt(positionalFixture, objectInfo)
    check('convert: positional fallback matches named conversion',
      JSON.stringify(fixtureConverted.prompt) === JSON.stringify(positionalConverted.prompt))
    const overridden = uiToPrompt(fixture, objectInfo, { overrides: { '1.width': 32, '2.filename_prefix': 'dsh-comfy_override' } })
    check('convert: overrides applied', overridden.prompt['1'].inputs.width === 32 && overridden.prompt['2'].inputs.filename_prefix === 'dsh-comfy_override')

    // synthetic graph exercising PrimitiveNode / Reroute / muted / Note handling
    const synthetic = {
      nodes: [
        { id: 1, type: 'EmptyImage', pos: [0, 0], size: [100, 100], mode: 0, inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1] }], widgets_values: [8, 8, 1, 0] },
        { id: 2, type: 'SaveImage', pos: [0, 0], size: [100, 100], mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 2 }, { name: 'filename_prefix', type: 'STRING', link: 3, widget: { name: 'filename_prefix' } }], outputs: [], widgets_values: ['x'] },
        { id: 3, type: 'PrimitiveNode', pos: [0, 0], size: [100, 100], mode: 0, inputs: [], outputs: [{ name: 'STRING', type: 'STRING', links: [3] }], widgets_values: ['from-primitive'] },
        { id: 4, type: 'Reroute', pos: [0, 0], size: [10, 10], mode: 0, inputs: [{ name: '', type: '*', link: 1 }], outputs: [{ name: '', type: 'IMAGE', links: [2] }] },
        { id: 5, type: 'EmptyImage', pos: [0, 0], size: [100, 100], mode: 2, inputs: [], outputs: [], widgets_values: [8, 8, 1, 0] },
        { id: 6, type: 'MarkdownNote', pos: [0, 0], size: [100, 100], mode: 0, inputs: [], outputs: [], widgets_values: ['note'] },
      ],
      links: [[1, 1, 0, 4, 0, 'IMAGE'], [2, 4, 0, 2, 0, 'IMAGE'], [3, 3, 0, 2, 1, 'STRING']],
    }
    const syntheticConverted = uiToPrompt(synthetic, objectInfo)
    check('convert: PrimitiveNode value inlined', syntheticConverted.prompt['2']?.inputs?.filename_prefix === 'from-primitive', JSON.stringify(syntheticConverted.prompt['2']))
    check('convert: Reroute followed to origin', JSON.stringify(syntheticConverted.prompt['2']?.inputs?.images) === JSON.stringify(['1', 0]))
    check('convert: muted node dropped', syntheticConverted.prompt['5'] === undefined)
    check('convert: Note nodes dropped from prompt', syntheticConverted.prompt['6'] === undefined)
    const syntheticGraph = toGraph(synthetic, objectInfo)
    check('graph: Reroute/PrimitiveNode/Note cards kept', ['3', '4', '6'].every(id => syntheticGraph.graph.nodes.some(node => node.id === id)))
    check('graph: muted count reported', syntheticGraph.graph.stats.mutedCount === 1)

    /* ---------------- run: UI fixture round trip ---------------- */
    const run = await post('/api/dsh-comfy/run', { id: 'fixtures::minimal_ui.json', overrides: { '2.filename_prefix': 'dsh-comfy_selftest' } })
    check('POST /run (UI fixture) -> 200', run.status === 200 && run.body?.ok === true, `${run.status} ${JSON.stringify(run.body).slice(0, 300)}`)
    const promptId = run.body?.promptId
    check('run returns promptId + number', typeof promptId === 'string' && promptId.length > 0 && Number.isFinite(run.body?.number), String(run.body?.number))
    check('run returns warnings array', Array.isArray(run.body?.warnings))
    const progress = await waitForRun(promptId)
    check('progress reaches done', progress?.state === 'done', `${progress?.state} http=${progress?.status ?? ''} ${progress?.error ?? progress?.last?.body?.error ?? ''}`)
    const outputs = Array.isArray(progress?.outputs) ? progress.outputs : []
    check('progress expands an image output', outputs.length > 0 && outputs[0].kind === 'image', JSON.stringify(outputs).slice(0, 300))
    check('output ref has view url + node type', typeof outputs[0]?.url === 'string' && outputs[0].url.startsWith('/api/dsh-comfy/view?')
      && outputs[0]?.nodeType === 'SaveImage', JSON.stringify(outputs[0] ?? null).slice(0, 300))
    check('progress reports elapsedMs', Number.isFinite(progress?.elapsedMs) && progress.elapsedMs >= 0)

    if (typeof outputs[0]?.url === 'string') {
      const view = await get(outputs[0].url, { raw: true })
      check('GET /view -> 200', view.status === 200, String(view.status))
      check('GET /view content-type image/png', (view.headers.get('content-type') ?? '').startsWith('image/png'), view.headers.get('content-type') ?? '')
      check('GET /view returns a real PNG', view.bytes.length > 200 && view.bytes[0] === 0x89 && view.bytes[1] === 0x50 && view.bytes[2] === 0x4e && view.bytes[3] === 0x47, `${view.bytes.length} bytes`)
    } else {
      check('GET /view -> 200', false, 'no output url to proxy')
      check('GET /view content-type image/png', false, 'no output url to proxy')
      check('GET /view returns a real PNG', false, 'no output url to proxy')
    }

    /* ---------------- run: API fixture round trip ---------------- */
    const apiRun = await post('/api/dsh-comfy/run', { id: 'fixtures::minimal_api.json' })
    check('POST /run (API fixture) -> 200', apiRun.status === 200 && apiRun.body?.ok === true, `${apiRun.status} ${JSON.stringify(apiRun.body).slice(0, 300)}`)
    const apiProgress = await waitForRun(apiRun.body?.promptId)
    check('API-format run reaches done', apiProgress?.state === 'done' && (apiProgress?.outputs ?? []).length > 0, `${apiProgress?.state} ${apiProgress?.error ?? ''}`)

    /* ---------------- history ---------------- */
    const history = await get('/api/dsh-comfy/history?limit=5')
    check('GET /history -> 200', history.status === 200 && history.body?.ok === true)
    const runs = Array.isArray(history.body?.runs) ? history.body.runs : []
    check('history returns runs', runs.length > 0 && runs.length <= 5, String(runs.length))
    const historyEntry = runs.find(entry => entry.promptId === apiRun.body?.promptId) ?? runs.find(entry => entry.promptId === promptId)
    check('history includes the fixture run with outputs', historyEntry !== undefined && (historyEntry.outputs ?? []).length > 0, JSON.stringify(runs.map(entry => entry.promptId)))
    check('history runs newest first', runs.every((entry, index) => index === 0 || (runs[index - 1].number ?? 0) >= (entry.number ?? 0)))

    /* ---------------- progress edge cases ---------------- */
    const badProgress = await get('/api/dsh-comfy/progress')
    check('progress without promptId -> 400', badProgress.status === 400 && badProgress.body?.ok === false)
    const unknownProgress = await get('/api/dsh-comfy/progress?promptId=00000000-0000-0000-0000-000000000000')
    check('progress for unknown prompt -> queued|unknown', ['queued', 'unknown'].includes(unknownProgress.body?.state), JSON.stringify(unknownProgress.body))

    /* ---------------- control endpoints ---------------- */
    const interrupt = await post('/api/dsh-comfy/interrupt', {})
    check('POST /interrupt -> ok', interrupt.status === 200 && interrupt.body?.ok === true, `${interrupt.status} ${interrupt.body?.error ?? ''}`)
    const clear = await post('/api/dsh-comfy/clear-queue', {})
    check('POST /clear-queue -> ok', clear.status === 200 && clear.body?.ok === true, `${clear.status} ${clear.body?.error ?? ''}`)
    const start = await post('/api/dsh-comfy/start', {})
    check('POST /start is idempotent (already running)', start.status === 200 && start.body?.ok === true
      && start.body?.started === false && typeof start.body?.message === 'string', JSON.stringify(start.body))

    /* ---------------- view safety ---------------- */
    const noFilename = await get('/api/dsh-comfy/view')
    check('/view without filename -> 400', noFilename.status === 400)
    const traversalView = await get(`/api/dsh-comfy/view?filename=${encodeURIComponent('../secret.png')}&type=output`)
    check('/view traversal filename -> 400', traversalView.status === 400)
    const badRun = await post('/api/dsh-comfy/run', { id: 'user::nope.json' })
    check('/run unknown workflow -> 404', badRun.status === 404 && badRun.body?.ok === false, String(badRun.status))
    const badBody = await post('/api/dsh-comfy/run', '{not json')
    check('/run invalid JSON body -> 400', badBody.status === 400)
    const wrongMethod = await get('/api/dsh-comfy/run')
    check('GET on POST-only route -> 405', wrongMethod.status === 405, String(wrongMethod.status))
  } finally {
    server.kill('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 300))
    if (!server.killed) server.kill('SIGKILL')
    if (failed.length > 0) {
      console.error('\n[smoke] dev-server log tail:')
      console.error(serverLog.split('\n').slice(-20).join('\n'))
    }
  }

  console.log('\n================ smoke result ================')
  console.log(`passed=${passed} failed=${failed.length}`)
  for (const failure of failed) console.log(`  FAILED: ${failure}`)
  if (failed.length === 0) {
    console.log('SMOKE: PASS')
  } else {
    console.log('SMOKE: FAIL')
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('smoke 崩溃：', error)
  process.exitCode = 2
})
