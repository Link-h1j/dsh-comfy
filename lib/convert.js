/**
 * UI workflow -> ComfyUI API prompt (CONTRACT.md §4).
 *
 * Algorithm (mirrors what the ComfyUI frontend does in `graphToPrompt`):
 *   1. index nodes and links;
 *   2. drop frontend-only nodes (Note/MarkdownNote/Reroute/PrimitiveNode) and
 *      muted (mode 2) nodes; bypassed (mode 4) nodes only pass values through;
 *   3. take every linked input from the upstream node (PrimitiveNode inline
 *      values and reroutes resolved, bypassed nodes traversed);
 *   4. add widget values — `widgets_values_named` first, positional mapping with
 *      control_after_generate / image_upload / dynamic-combo slot handling
 *      second, node-definition defaults as the last resort;
 *   5. apply `"<nodeId>.<inputName>"` overrides from /run;
 *   6. validate against /object_info (unknown class_type / missing required input)
 *      and throw a Chinese ConvertError otherwise.
 *
 * API-format files (`{prompt:{...}}` or a bare prompt map) are returned as-is
 * after applying overrides.
 */
import { isPlainObject } from './http.js'
import {
  collectWidgetValues,
  detectWorkflowKind,
  extractPrompt,
  isStandardWidgetSpec,
  isVirtualNodeType,
  normalizeLinks,
  subgraphTypeIds,
} from './graph.js'

/** Error raised by conversion; `code` classifies it for validate.mjs and routes. */
export class ConvertError extends Error {
  constructor(message, code = 'convert-error', details = {}) {
    super(message)
    this.name = 'ConvertError'
    this.code = code
    this.details = details
  }
}

/** Read the inline value of a frontend PrimitiveNode. */
function primitiveValue(node) {
  const named = isPlainObject(node?.widgets_values_named) ? node.widgets_values_named : null
  if (named !== null) {
    const values = Object.values(named)
    if (values.length > 0) return values[0]
  }
  const positional = Array.isArray(node?.widgets_values) ? node.widgets_values : []
  return positional.length > 0 ? positional[0] : undefined
}

/**
 * Build a link resolver that follows reroutes and bypassed nodes and inlines
 * PrimitiveNode values. Returns `{ ref }`, `{ value }` or `{ missing: true }`.
 */
function makeLinkResolver(nodeById, linkById, warnings) {
  const resolve = (linkId, depth) => {
    if (depth > 64) {
      warnings.push('连线解析层级过深（可能存在循环连线）')
      return { missing: true }
    }
    const link = linkById.get(String(linkId))
    if (link === undefined) return { missing: true }
    const origin = nodeById.get(link.from)
    if (origin === undefined) {
      warnings.push(`连线指向不存在的节点 ${link.from}`)
      return { missing: true }
    }
    const type = String(origin.type ?? '')
    if (type === 'PrimitiveNode') {
      const value = primitiveValue(origin)
      if (value === undefined) {
        warnings.push(`原始值节点 ${origin.id} 没有值`)
        return { missing: true }
      }
      return { value }
    }
    if (type === 'Reroute') {
      const upstream = (Array.isArray(origin.inputs) ? origin.inputs : [])
        .find(input => input?.link !== null && input?.link !== undefined)
      if (upstream === undefined) return { missing: true }
      return resolve(upstream.link, depth + 1)
    }
    if (isVirtualNodeType(type)) {
      warnings.push(`节点 ${origin.id}（${type}）不能作为输入来源`)
      return { missing: true }
    }
    const mode = Number(origin.mode ?? 0)
    if (mode === 2) {
      warnings.push(`节点 ${origin.id}（${type}）已静音，其输出不可用`)
      return { missing: true }
    }
    if (mode === 4) {
      // Bypass: pass the matching input through instead of executing the node.
      // A bypassed node with no matching input (e.g. a bypassed loader) simply
      // contributes nothing — the ComfyUI frontend drops such links silently, so
      // optional inputs stay absent instead of turning into noisy warnings.
      const candidates = (Array.isArray(origin.inputs) ? origin.inputs : [])
        .filter(input => input?.link !== null && input?.link !== undefined)
      const sameType = candidates.find(input => String(input?.type ?? '') === String(link.type ?? ''))
      const chosen = sameType ?? candidates[0]
      if (chosen === undefined) return { missing: true }
      return resolve(chosen.link, depth + 1)
    }
    return { ref: [String(origin.id), link.fromSlot] }
  }
  return resolve
}

/**
 * Validate a prompt against /object_info.
 * @throws {ConvertError} code 'unknown-node' or 'missing-required'
 */
export function validatePrompt(prompt, objectInfo) {
  if (objectInfo === null || objectInfo === undefined) {
    throw new ConvertError('ComfyUI 未运行，无法校验工作流（缺少节点定义）', 'no-object-info')
  }
  for (const [nodeId, node] of Object.entries(prompt)) {
    const type = String(node?.class_type ?? '')
    const def = objectInfo[type]
    if (def === undefined) {
      throw new ConvertError(
        `未知节点类型 "${type}"（节点 ${nodeId}），本机 ComfyUI 未安装对应自定义节点`,
        'unknown-node',
        { nodeId, nodeType: type },
      )
    }
    const required = isPlainObject(def.input?.required) ? def.input.required : {}
    const nodeInputs = isPlainObject(node.inputs) ? node.inputs : {}
    const missing = []
    for (const [inputName, rawSpec] of Object.entries(required)) {
      if (!Array.isArray(rawSpec)) continue
      const value = nodeInputs[inputName]
      if (value !== undefined) continue
      // Dynamic/dotted inputs (autogrow groups, dynamic-combo sub inputs) are
      // carried as flat dotted keys (e.g. "images.image0"); the base required
      // name is satisfied when any such key is present.
      const hasDotted = Object.keys(nodeInputs).some(key => key.startsWith(`${inputName}.`))
      if (hasDotted) continue
      missing.push(inputName)
    }
    if (missing.length > 0) {
      throw new ConvertError(
        `节点 ${nodeId}（${type}）缺少必填输入：${missing.join('、')}`,
        'missing-required',
        { nodeId, nodeType: type, missing },
      )
    }
  }
}

/** Apply `"<nodeId>.<inputName>"` overrides onto an existing prompt. */
function applyOverrides(prompt, overrides, warnings) {
  if (overrides === null || overrides === undefined) return
  if (!isPlainObject(overrides)) {
    warnings.push('overrides 必须是对象（键为 "<节点id>.<输入名>"）')
    return
  }
  for (const [key, value] of Object.entries(overrides)) {
    const dot = key.indexOf('.')
    if (dot <= 0 || dot === key.length - 1) {
      warnings.push(`忽略无效的参数覆盖：${key}（应为 "<节点id>.<输入名>"）`)
      continue
    }
    const nodeId = key.slice(0, dot)
    const inputName = key.slice(dot + 1)
    const target = prompt[nodeId]
    if (target === undefined) {
      warnings.push(`忽略参数覆盖：${key}（节点 ${nodeId} 不存在或不可执行）`)
      continue
    }
    target.inputs[inputName] = value
  }
}

/** Clone an API prompt so overrides never mutate the caller's workflow object. */
function cloneApiPrompt(prompt) {
  const cloned = {}
  for (const [nodeId, node] of Object.entries(prompt)) {
    if (!isPlainObject(node) || typeof node.class_type !== 'string') {
      throw new ConvertError(`API 工作流节点 ${nodeId} 缺少 class_type`, 'invalid-api')
    }
    cloned[nodeId] = {
      class_type: node.class_type,
      inputs: isPlainObject(node.inputs) ? { ...node.inputs } : {},
    }
  }
  return cloned
}

/**
 * Convert a parsed workflow file into an API prompt.
 *
 * @param {object} workflow parsed UI- or API-format workflow JSON
 * @param {object|null} objectInfo /object_info map (required for UI workflows)
 * @param {{ overrides?: Record<string, unknown> }} [options]
 * @returns {{ prompt: Record<string, {class_type: string, inputs: Record<string, unknown>}>, warnings: string[] }}
 * @throws {ConvertError}
 */
export function uiToPrompt(workflow, objectInfo, options = {}) {
  const warnings = []
  const overrides = options.overrides ?? {}
  const kind = detectWorkflowKind(workflow)

  if (kind === 'api') {
    const prompt = cloneApiPrompt(extractPrompt(workflow))
    applyOverrides(prompt, overrides, warnings)
    validatePrompt(prompt, objectInfo)
    return { prompt, warnings }
  }
  if (kind !== 'ui') {
    throw new ConvertError('不是有效的 ComfyUI 工作流（既没有 nodes 也没有 prompt）', 'invalid-workflow')
  }
  if (objectInfo === null || objectInfo === undefined || Object.keys(objectInfo).length === 0) {
    throw new ConvertError(
      'ComfyUI 未运行，无法把 UI 工作流转换为 API 格式（缺少节点定义）',
      'no-object-info',
    )
  }

  const rawNodes = Array.isArray(workflow.nodes) ? workflow.nodes : []
  const nodeById = new Map()
  for (const node of rawNodes) {
    if (node === null || typeof node !== 'object') continue
    nodeById.set(String(node.id), node)
  }
  const linkById = new Map()
  for (const link of normalizeLinks(workflow.links)) linkById.set(link.id, link)
  const resolveLink = makeLinkResolver(nodeById, linkById, warnings)
  const subgraphIds = subgraphTypeIds(workflow)

  const prompt = {}
  for (const node of rawNodes) {
    if (node === null || typeof node !== 'object') continue
    const nodeId = String(node.id)
    const type = String(node.type ?? '')
    if (type === '' || isVirtualNodeType(type)) continue
    const mode = Number(node.mode ?? 0)
    if (mode === 2 || mode === 4) continue // muted / bypassed nodes are not executed
    if (subgraphIds.has(type)) {
      // Frontend subgraph nodes are expanded by the ComfyUI frontend before
      // queueing; expanding them here is not implemented (CONTRACT.md has no
      // subgraph requirement), so refuse with a precise message.
      throw new ConvertError(
        `节点 ${nodeId} 是子图（Subgraph）节点，当前版本暂不支持运行含子图的工作流`,
        'subgraph-node',
        { nodeId, nodeType: type },
      )
    }
    const def = objectInfo[type]
    if (def === undefined) {
      throw new ConvertError(
        `未知节点类型 "${type}"（节点 ${nodeId}），本机 ComfyUI 未安装对应自定义节点`,
        'unknown-node',
        { nodeId, nodeType: type },
      )
    }

    const inputs = {}

    // 3) linked inputs first (links win over widget values on the same name)
    for (const input of Array.isArray(node.inputs) ? node.inputs : []) {
      if (input === null || typeof input !== 'object') continue
      if (input.link === null || input.link === undefined) continue
      const name = String(input.name ?? '')
      if (name === '') continue
      const resolved = resolveLink(input.link, 0)
      if (resolved.ref !== undefined) inputs[name] = resolved.ref
      else if ('value' in resolved) inputs[name] = resolved.value
    }

    // 4) widget values (named first, positional fallback, defaults last)
    const named = isPlainObject(node.widgets_values_named) ? node.widgets_values_named : null
    const positional = Array.isArray(node.widgets_values) ? node.widgets_values : []
    const nodeInputNames = new Set(
      (Array.isArray(node.inputs) ? node.inputs : []).map(input => String(input?.name ?? '')),
    )
    const collected = collectWidgetValues(def, positional, named, { nodeInputNames })
    for (const entry of collected.entries) {
      if (entry.value !== undefined) {
        if (!(entry.name in inputs)) inputs[entry.name] = entry.value
        continue
      }
      // Custom widget inputs (IMAGECOMPARE, LOAD_3D, …) have no stored value in
      // old files but the API prompt still has to carry their name: the ComfyUI
      // frontend sends the widget's (empty) value, so null is the faithful stand-in.
      if (entry.spec.isWidget && entry.spec.section === 'required' && !isStandardWidgetSpec(entry.spec) && !entry.name.includes('.')) {
        if (!(entry.name in inputs)) inputs[entry.name] = null
      }
    }
    // A required autogrow group with no connections at all is still legal when
    // its template declares min=0; otherwise ComfyUI itself reports the details.
    if (collected.unknownNamed.length > 0) {
      warnings.push(`节点 ${nodeId}（${type}）有未定义参数，已忽略：${collected.unknownNamed.slice(0, 8).join('、')}`)
    }
    if (named === null && collected.positional.warnings.length > 0) {
      for (const warning of collected.positional.warnings) warnings.push(`${nodeId} ${type} ${warning}`)
    }

    prompt[nodeId] = { class_type: type, inputs }
  }

  if (Object.keys(prompt).length === 0) {
    throw new ConvertError('工作流没有可执行的节点（可能全部被静音或绕过）', 'empty-prompt')
  }

  // 5) overrides last, so /run wins over file values
  applyOverrides(prompt, overrides, warnings)

  // 6) structural validation against /object_info
  validatePrompt(prompt, objectInfo)

  return { prompt, warnings }
}
