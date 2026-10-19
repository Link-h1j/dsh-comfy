/**
 * Workflow source discovery and safe reading for the /api/dsh-comfy host half.
 *
 * Sources:
 *   user      — ComfyUI/user/default/workflows + ComfyUI/user/workflows (deduped)
 *   workspace — a user-configured workflow directory (recursive)
 *   templates — official comfyui_workflow_templates_json/templates (api_* and index* skipped)
 *
 * Machine-specific paths come from environment variables or the gitignored
 * `config.local.json` next to this package; see README "本机私有配置".
 *
 * `id` format is `<sourceId>::<relPath>` with '/' separators. Reading an id goes
 * through three layers of defence: the source id must be in the allow-list, the
 * relative path may not contain '..'/drive letters/absolute segments, and after
 * resolution the realpath must still live inside the source root.
 */
import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectWorkflowKind } from './graph.js'

/** Plugin package root. */
const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * Optional machine-private settings: `<plugin>/config.local.json` (gitignored).
 * Keys: comfyHome, workspaceRoot, templatesRoot, startScript.
 */
const LOCAL_CONFIG = (() => {
  try {
    const parsed = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'config.local.json'), 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
})()

/** One path from config.local.json, resolved and validated. */
function localPath(key) {
  const raw = LOCAL_CONFIG[key]
  return typeof raw === 'string' && raw.trim() !== '' ? path.resolve(raw.trim()) : null
}

/** Maximum workflow file size accepted from disk (mirrors the /workflow response cap). */
export const MAX_WORKFLOW_BYTES = 8 * 1024 * 1024

/** Directories never worth walking inside a workflow tree. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.cache', '.venv'])

/** Error raised by source discovery/reading; `status` maps to HTTP. */
export class SourceError extends Error {
  constructor(message, { code = 'source-error', status = 500 } = {}) {
    super(message)
    this.name = 'SourceError'
    this.code = code
    this.status = status
  }
}

/** Environment override helper. */
function envPath(name) {
  const raw = process.env[name]
  return typeof raw === 'string' && raw.trim() !== '' ? path.resolve(raw.trim()) : null
}

/** Root of the local ComfyUI installation. */
export function comfyHome() {
  return envPath('DSH_COMFY_HOME') ?? localPath('comfyHome') ?? path.join(os.homedir(), 'ComfyUI')
}

/** Root of the user's workspace workflows directory. */
export function workspaceRoot() {
  return envPath('DSH_COMFY_WORKSPACE') ?? localPath('workspaceRoot') ?? path.join(comfyHome(), 'workflows')
}

/** Official workflow template directory shipped with ComfyUI. */
export function templatesRoot() {
  return envPath('DSH_COMFY_TEMPLATES') ?? localPath('templatesRoot') ?? path.join(
    comfyHome(), '.venv', 'Lib', 'site-packages', 'comfyui_workflow_templates_json', 'templates',
  )
}

/** All configured path facts (handy for diagnostics). */
export function paths() {
  return {
    pluginRoot: PLUGIN_ROOT,
    comfyHome: comfyHome(),
    workspaceRoot: workspaceRoot(),
    templatesRoot: templatesRoot(),
    userWorkflowRoots: [
      path.join(comfyHome(), 'user', 'default', 'workflows'),
      path.join(comfyHome(), 'user', 'workflows'),
    ],
    startScript: startScript(),
  }
}

/** Locate the ComfyUI start script: env → config.local.json → sibling of the plugin. */
export function startScript() {
  const override = envPath('DSH_COMFY_START_SCRIPT') ?? localPath('startScript')
  const candidates = [
    ...(override !== null ? [override] : []),
    path.resolve(PLUGIN_ROOT, '..', 'start_comfyui.ps1'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate, exists: true }
  }
  return { path: candidates[0], exists: false }
}

/**
 * Build the effective source list. `extraSources` is only used by the dev tools
 * (tools/dev-server.mjs) so smoke tests can mount tools/fixtures as a throwaway
 * source; the production plugin never passes it.
 * @param {{ extraSources?: Array<{id:string,label:string,roots:string[],kind?:string}> }} [options]
 */
export function getSources(options = {}) {
  const home = comfyHome()
  const userRoots = [
    path.join(home, 'user', 'default', 'workflows'),
    path.join(home, 'user', 'workflows'),
  ]
  const sources = [
    { id: 'user', label: '本机', kind: 'user', roots: userRoots },
    { id: 'workspace', label: '工作区', kind: 'workspace', roots: [workspaceRoot()] },
    { id: 'templates', label: '官方模板', kind: 'templates', roots: [templatesRoot()] },
  ]
  for (const extra of options.extraSources ?? []) {
    if (extra === null || typeof extra !== 'object' || typeof extra.id !== 'string') continue
    if (sources.some(source => source.id === extra.id)) continue
    sources.push({
      id: extra.id,
      label: typeof extra.label === 'string' ? extra.label : extra.id,
      kind: typeof extra.kind === 'string' ? extra.kind : 'extra',
      roots: Array.isArray(extra.roots) ? extra.roots.filter(root => typeof root === 'string') : [],
    })
  }
  return sources
}

/* ------------------------------------------------------------------ */
/* file walking / workflow classification                              */
/* ------------------------------------------------------------------ */

/**
 * Recursively list regular .json files below `root`.
 * Symlinks are skipped (no loops, no escaping the tree by accident).
 * @returns {Promise<Array<{ absPath: string, relPath: string }>>}
 */
async function walkJsonFiles(root) {
  const out = []
  async function walk(dir, relPrefix, depth) {
    if (depth > 12) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(abs, rel, depth + 1)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        out.push({ absPath: abs, relPath: rel })
      }
    }
  }
  await walk(root, '', 0)
  return out
}

/** Skip official template index/localisation files (not workflows). */
function isTemplateIndexFile(name) {
  return /^index([._-]|$)/i.test(name)
}

/** Kind cache keyed by absolute path: { mtimeMs, size, kind } — avoids re-parsing on every list. */
const kindCache = new Map()

/**
 * Classify a workflow file as 'ui' | 'api' | null, with a stat/mtime cache.
 * @returns {Promise<{kind: 'ui'|'api'|null, size: number, mtime: number}>}
 */
async function classifyFile(absPath) {
  let info
  try {
    info = await stat(absPath)
  } catch {
    return { kind: null, size: 0, mtime: 0 }
  }
  if (!info.isFile()) return { kind: null, size: 0, mtime: 0 }
  const cached = kindCache.get(absPath)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return { kind: cached.kind, size: info.size, mtime: Math.round(info.mtimeMs) }
  }
  let kind = null
  if (info.size <= MAX_WORKFLOW_BYTES) {
    try {
      const json = JSON.parse(await readFile(absPath, 'utf8'))
      kind = detectWorkflowKind(json)
    } catch {
      kind = null // malformed JSON is not a workflow: skip it from the list
    }
  }
  kindCache.set(absPath, { mtimeMs: info.mtimeMs, size: info.size, kind })
  return { kind, size: info.size, mtime: Math.round(info.mtimeMs) }
}

/** Build one WorkflowItem (CONTRACT.md §2). */
function makeItem(sourceId, relPath, name, kind, size, mtime) {
  return {
    id: `${sourceId}::${relPath}`,
    source: sourceId,
    relPath,
    name,
    kind,
    size,
    mtime,
    disabled: false,
  }
}

/**
 * List every discoverable workflow with its kind, plus per-source metadata.
 * @param {{ extraSources?: Array<object> }} [options]
 * @returns {Promise<{ sources: Array<object>, items: Array<object> }>}
 */
export async function listWorkflows(options = {}) {
  const sources = getSources(options)
  const sourceMeta = []
  const items = []
  for (const source of sources) {
    const seenRelPaths = new Set()
    const sourceItems = []
    const rootInfo = []
    for (const root of source.roots) {
      let rootExists = false
      try { rootExists = (await stat(root)).isDirectory() } catch { rootExists = false }
      rootInfo.push({ root, exists: rootExists })
      if (!rootExists) continue
      const files = await walkJsonFiles(root)
      for (const file of files) {
        if (seenRelPaths.has(file.relPath)) continue // dedupe: same relative path in two user roots
        if (source.kind === 'templates') {
          const base = path.basename(file.absPath)
          if (/^api_/i.test(base)) continue
          if (isTemplateIndexFile(base)) continue
        }
        const info = await classifyFile(file.absPath)
        if (info.kind === null) continue // not a ComfyUI workflow
        seenRelPaths.add(file.relPath)
        sourceItems.push(makeItem(source.id, file.relPath, path.basename(file.absPath), info.kind, info.size, info.mtime))
      }
    }
    sourceItems.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh-CN'))
    items.push(...sourceItems)
    const existingRoots = rootInfo.filter(info => info.exists).map(info => info.root)
    sourceMeta.push({
      id: source.id,
      label: source.label,
      kind: source.kind,
      root: existingRoots[0] ?? source.roots[0] ?? '',
      roots: source.roots,
      exists: existingRoots.length > 0,
      count: sourceItems.length,
    })
  }
  return { sources: sourceMeta, items }
}

/* ------------------------------------------------------------------ */
/* id parsing / safe reading                                           */
/* ------------------------------------------------------------------ */

/**
 * Parse `<sourceId>::<relPath>` and validate both halves.
 * @returns {{ sourceId: string, relPath: string, segments: string[] }}
 */
export function parseWorkflowId(id, options = {}) {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new SourceError('缺少工作流 id（应为 <来源>::<相对路径>）', { code: 'invalid-id', status: 400 })
  }
  const sep = id.indexOf('::')
  if (sep <= 0) {
    throw new SourceError('工作流 id 格式不正确（应为 <来源>::<相对路径>）', { code: 'invalid-id', status: 400 })
  }
  const sourceId = id.slice(0, sep)
  const rawRelPath = id.slice(sep + 2)
  const source = getSources(options).find(candidate => candidate.id === sourceId)
  if (source === undefined) {
    throw new SourceError(`未知的工作流来源："${sourceId}"`, { code: 'invalid-id', status: 400 })
  }
  if (rawRelPath === '' || rawRelPath.includes('\0')) {
    throw new SourceError('工作流相对路径为空或包含非法字符', { code: 'invalid-id', status: 400 })
  }
  // Normalize Windows separators to '/', then reject absolute paths and '..'.
  const normalized = rawRelPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith('/')) {
    throw new SourceError('工作流相对路径不能是绝对路径', { code: 'invalid-id', status: 400 })
  }
  const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.some(segment => segment === '..')) {
    throw new SourceError('工作流相对路径不合法（禁止 .. 与空路径）', { code: 'invalid-id', status: 400 })
  }
  return { sourceId, relPath: segments.join('/'), segments }
}

/** True when `candidate` is inside (or equal to) `root`, case-insensitively on Windows. */
function isInside(root, candidate) {
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const rootNorm = normalize(path.resolve(root))
  const candidateNorm = normalize(path.resolve(candidate))
  return candidateNorm === rootNorm || candidateNorm.startsWith(rootNorm + path.sep)
}

/**
 * Read one workflow by id, enforcing path containment with realpath.
 * @returns {Promise<{ item: object, json: object, kind: 'ui'|'api' }>}
 */
export async function readWorkflow(id, options = {}) {
  const { sourceId, relPath, segments } = parseWorkflowId(id, options)
  const source = getSources(options).find(candidate => candidate.id === sourceId)
  for (const root of source.roots) {
    const absolute = path.resolve(root, ...segments)
    // Cheap pre-check before touching the filesystem.
    if (!isInside(root, absolute)) {
      throw new SourceError('工作流路径越界（拒绝读取来源目录之外的文件）', { code: 'outside-root', status: 403 })
    }
    let rootReal
    let fileReal
    try {
      rootReal = await realpath(root)
    } catch {
      continue // root does not exist
    }
    try {
      fileReal = await realpath(absolute)
    } catch {
      continue // not in this root
    }
    if (!isInside(rootReal, fileReal)) {
      throw new SourceError('工作流路径越界（realpath 不在来源目录内）', { code: 'outside-root', status: 403 })
    }
    let info
    try {
      info = await stat(fileReal)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    if (info.size > MAX_WORKFLOW_BYTES) {
      throw new SourceError(`工作流文件过大（${Math.round(info.size / 1024 / 1024)} MiB，上限 8 MiB）`, { code: 'too-large', status: 413 })
    }
    let text
    try {
      text = await readFile(fileReal, 'utf8')
    } catch (error) {
      throw new SourceError(`读取工作流失败：${error?.message ?? String(error)}`, { code: 'unreadable', status: 500 })
    }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new SourceError('工作流文件不是合法的 JSON', { code: 'invalid-json', status: 400 })
    }
    const kind = detectWorkflowKind(json)
    if (kind === null) {
      throw new SourceError('该文件不是 ComfyUI 工作流（缺少 nodes 或 prompt 字段）', { code: 'invalid-json', status: 400 })
    }
    return {
      item: makeItem(sourceId, relPath, path.basename(fileReal), kind, info.size, Math.round(info.mtimeMs)),
      json,
      kind,
    }
  }
  throw new SourceError(`找不到工作流文件："${id}"`, { code: 'not-found', status: 404 })
}
