/**
 * Run submission, progress tracking and output expansion (CONTRACT.md §5).
 *
 * The host half is stateless apart from a small in-memory submission table used
 * for `elapsedMs` and the "queued for the first 10 seconds" heuristic. Progress
 * is polled by the browser half; no WebSocket is involved.
 */
import { isPlainObject } from './http.js'
import * as comfy from './comfy.js'

/** Error raised by runner operations; `status` maps to HTTP. */
export class RunnerError extends Error {
  constructor(message, code = 'runner-error', { status = 502, details = {} } = {}) {
    super(message)
    this.name = 'RunnerError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/** promptId -> { at, number } for recent submissions (bounded). */
const submissions = new Map()
const MAX_TRACKED = 300

/** promptId -> first time this host saw it polled (for elapsedMs fallback). */
const firstSeen = new Map()

/** Remember a submission so /progress can report elapsed time and queue order. */
function trackSubmission(promptId, number) {
  submissions.set(promptId, { at: Date.now(), number })
  if (submissions.size > MAX_TRACKED) {
    const oldest = submissions.keys().next().value
    submissions.delete(oldest)
  }
}

/** firstSeen bookkeeping, bounded the same way. */
function touchFirstSeen(promptId) {
  if (!firstSeen.has(promptId)) {
    firstSeen.set(promptId, Date.now())
    if (firstSeen.size > MAX_TRACKED) {
      const oldest = firstSeen.keys().next().value
      firstSeen.delete(oldest)
    }
  }
  return firstSeen.get(promptId)
}

/** Output keys whose payload is a list of files. */
const OUTPUT_KIND_BY_KEY = new Map([
  ['images', 'image'],
  ['gifs', 'video'],
  ['videos', 'video'],
  ['audio', 'audio'],
  ['audios', 'audio'],
  ['text', 'text'],
  ['texts', 'text'],
  ['string', 'text'],
])

/** Extension -> OutputRef kind fallback. */
const KIND_BY_EXTENSION = new Map([
  ['.png', 'image'], ['.jpg', 'image'], ['.jpeg', 'image'], ['.webp', 'image'],
  ['.bmp', 'image'], ['.avif', 'image'], ['.tiff', 'image'], ['.tif', 'image'], ['.svg', 'image'],
  ['.mp4', 'video'], ['.webm', 'video'], ['.mov', 'video'], ['.mkv', 'video'], ['.avi', 'video'],
  ['.wav', 'audio'], ['.mp3', 'audio'], ['.flac', 'audio'], ['.ogg', 'audio'], ['.m4a', 'audio'], ['.opus', 'audio'],
  ['.glb', '3d'], ['.gltf', '3d'], ['.obj', '3d'], ['.fbx', '3d'], ['.ply', '3d'],
  ['.stl', '3d'], ['.splat', '3d'], ['.usdz', '3d'], ['.spz', '3d'],
])

/** True when a value is a ComfyUI output item (`{filename, subfolder, type}`). */
function isOutputItem(item) {
  return isPlainObject(item) && typeof item.filename === 'string'
}

/** Determine the OutputRef kind from the output key, then the file extension. */
function kindOf(outputKey, filename) {
  const byKey = OUTPUT_KIND_BY_KEY.get(outputKey)
  if (byKey !== undefined) return byKey
  const lower = filename.toLowerCase()
  // 3D outputs can appear under arbitrary keys (e.g. "result"); extension wins.
  for (const [extension, kind] of KIND_BY_EXTENSION) {
    if (lower.endsWith(extension)) return kind
  }
  return 'file'
}

/** Build `/api/dsh-comfy/view` URLs. */
export function viewUrl(filename, subfolder, type) {
  const query = new URLSearchParams({
    filename,
    subfolder: subfolder ?? '',
    type: type ?? 'output',
  })
  return `/api/dsh-comfy/view?${query.toString()}`
}

/** Extract the submitted prompt map from a /history entry. */
function promptDictFromEntry(entry) {
  const prompt = entry?.prompt
  if (Array.isArray(prompt) && isPlainObject(prompt[2])) return prompt[2]
  if (isPlainObject(prompt)) return prompt
  return {}
}

/**
 * Expand a ComfyUI `outputs` map into the flat OutputRef list of CONTRACT.md §2.
 * @param {object} outputs history entry `outputs`
 * @param {object} promptDict prompt map (used for nodeType)
 * @returns {Array<object>}
 */
export function expandOutputs(outputs, promptDict = {}) {
  const refs = []
  if (!isPlainObject(outputs)) return refs
  for (const [nodeId, nodeOutputs] of Object.entries(outputs)) {
    if (!isPlainObject(nodeOutputs)) continue
    const nodeType = String(promptDict?.[nodeId]?.class_type ?? '')
    for (const [outputKey, list] of Object.entries(nodeOutputs)) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (!isOutputItem(item)) continue
        const filename = item.filename
        const subfolder = typeof item.subfolder === 'string' ? item.subfolder : ''
        const type = typeof item.type === 'string' ? item.type : 'output'
        refs.push({
          nodeId: String(nodeId),
          nodeType,
          kind: kindOf(outputKey, filename),
          filename,
          subfolder,
          type,
          url: viewUrl(filename, subfolder, type),
          label: filename,
        })
      }
    }
  }
  return refs
}

/** Extract a Chinese execution error message from a history `status` block. */
function executionErrorOf(status) {
  if (!isPlainObject(status)) return null
  const messages = Array.isArray(status.messages) ? status.messages : []
  for (const message of messages) {
    if (!Array.isArray(message) || message.length < 2) continue
    const [kind, data] = message
    const info = isPlainObject(data) ? data : {}
    if (kind === 'execution_interrupted') return '执行被中断'
    if (kind === 'execution_error') {
      const detail = [info.exception_type, info.exception_message].filter(part => typeof part === 'string' && part !== '')
      const where = info.node_id !== undefined ? `（节点 ${info.node_id}）` : ''
      return `ComfyUI 执行出错${where}：${detail.join(': ') || '未知错误'}`
    }
  }
  if (status.status_str === 'error') return 'ComfyUI 执行出错（未提供错误详情）'
  return null
}

/** Compose a readable rejection message from a ComfyUI /prompt response. */
function describeRejection(result) {
  const body = isPlainObject(result?.body) ? result.body : {}
  const parts = []
  if (typeof body.error === 'string' && body.error !== '') parts.push(body.error)
  const nodeErrors = isPlainObject(body.node_errors) ? body.node_errors : {}
  for (const [nodeId, nodeError] of Object.entries(nodeErrors)) {
    const className = isPlainObject(nodeError) && typeof nodeError.class_type === 'string'
      ? ` ${nodeError.class_type}`
      : ''
    const errors = isPlainObject(nodeError) && Array.isArray(nodeError.errors) ? nodeError.errors : []
    for (const error of errors.slice(0, 3)) {
      const detail = (isPlainObject(error) && (error.details ?? error.message)) ?? ''
      if (detail !== '') parts.push(`节点 ${nodeId}${className}：${detail}`)
    }
  }
  if (parts.length === 0) parts.push(`HTTP ${result?.status ?? '未知'}`)
  return `ComfyUI 拒绝了这个工作流：${parts.slice(0, 8).join('；')}`
}

/**
 * Submit an API prompt to ComfyUI.
 * @returns {Promise<{ promptId: string, number: number|null }>}
 * @throws {RunnerError}
 */
export async function submit(prompt) {
  if (!isPlainObject(prompt) || Object.keys(prompt).length === 0) {
    throw new RunnerError('工作流没有可提交的节点', 'empty-prompt', { status: 400 })
  }
  const result = await comfy.submitPrompt(prompt)
  const body = isPlainObject(result.body) ? result.body : {}
  const nodeErrors = isPlainObject(body.node_errors) ? body.node_errors : {}
  const rejected = !result.ok || typeof body.prompt_id !== 'string' || Object.keys(nodeErrors).length > 0
  if (rejected) {
    const status = result.status >= 500 ? 502 : 400
    throw new RunnerError(describeRejection(result), 'submit-rejected', { status })
  }
  const number = typeof body.number === 'number' ? body.number : null
  trackSubmission(body.prompt_id, number)
  return { promptId: body.prompt_id, number }
}

/** Find an entry in a /queue array (entries are `[number, prompt_id, ...]`). */
function findQueueIndex(list, promptId) {
  if (!Array.isArray(list)) return -1
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index]
    if (Array.isArray(entry) && entry[1] === promptId) return index
    if (isPlainObject(entry) && entry.prompt_id === promptId) return index
  }
  return -1
}

/**
 * Compute the state of one submitted prompt.
 * @returns {Promise<{ state: 'unknown'|'queued'|'running'|'done'|'error', promptId: string,
 *   elapsedMs: number, queuePosition?: number, outputs: object[], error?: string }>}
 */
export async function progress(promptId) {
  if (typeof promptId !== 'string' || promptId === '') {
    throw new RunnerError('缺少 promptId', 'bad-request', { status: 400 })
  }
  touchFirstSeen(promptId)
  const submitted = submissions.get(promptId)
  const startedAt = submitted?.at ?? firstSeen.get(promptId) ?? Date.now()
  const elapsedMs = Math.max(0, Date.now() - startedAt)

  // 1) finished (success or error) -> /history/<promptId>
  const entry = await comfy.getHistoryFor(promptId)
  if (entry !== null) {
    const status = isPlainObject(entry.status) ? entry.status : {}
    const outputs = expandOutputs(entry.outputs ?? {}, promptDictFromEntry(entry))
    const error = executionErrorOf(status)
    if (error !== null) return { state: 'error', promptId, elapsedMs, outputs, error }
    return { state: 'done', promptId, elapsedMs, outputs }
  }

  // 2) still queued/running -> /queue
  const queue = await comfy.getQueue()
  if (findQueueIndex(queue.running, promptId) !== -1) {
    return { state: 'running', promptId, elapsedMs, outputs: [] }
  }
  const pendingIndex = findQueueIndex(queue.pending, promptId)
  if (pendingIndex !== -1) {
    return { state: 'queued', promptId, elapsedMs, queuePosition: pendingIndex + 1, outputs: [] }
  }

  // 3) just submitted but not visible yet (ComfyUI takes a moment to enqueue)
  if (elapsedMs < 10_000) return { state: 'queued', promptId, elapsedMs, outputs: [] }
  return { state: 'unknown', promptId, elapsedMs, outputs: [] }
}

/**
 * Recent runs, newest first (CONTRACT.md §2 /history).
 * @param {number} limit
 * @returns {Promise<Array<{ promptId: string, number: number|null, outputs: object[] }>>}
 */
export async function history(limit = 10) {
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 10, 1), 50)
  const body = await comfy.getHistory({ maxItems: Math.max(safeLimit * 3, 20) })
  const entries = []
  let order = 0
  for (const [promptId, entry] of Object.entries(isPlainObject(body) ? body : {})) {
    if (!isPlainObject(entry)) continue
    const number = Array.isArray(entry.prompt) && typeof entry.prompt[0] === 'number' ? entry.prompt[0] : null
    const createTime = Array.isArray(entry.prompt) && isPlainObject(entry.prompt[3]) && typeof entry.prompt[3].create_time === 'number'
      ? entry.prompt[3].create_time
      : 0
    entries.push({ promptId, entry, number, createTime, order: order++ })
  }
  entries.sort((a, b) => {
    if (a.number !== null && b.number !== null && a.number !== b.number) return b.number - a.number
    if (a.createTime !== b.createTime) return b.createTime - a.createTime
    return b.order - a.order
  })
  return entries.slice(0, safeLimit).map(({ promptId, entry, number }) => ({
    promptId,
    number,
    outputs: expandOutputs(entry.outputs ?? {}, promptDictFromEntry(entry)),
  }))
}

/** Interrupt the currently running prompt. */
export async function interrupt(promptId) {
  await comfy.interrupt(promptId)
  return true
}

/** Clear the pending queue. */
export async function clearQueue() {
  await comfy.clearQueue()
  return true
}
