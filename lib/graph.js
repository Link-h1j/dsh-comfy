/**
 * Workflow normalization (`Graph`, CONTRACT.md §3) plus object_info inspection
 * helpers shared with lib/convert.js.
 *
 * This module is pure data handling: it never talks to ComfyUI itself. Callers
 * pass the `/object_info` map (or null when ComfyUI is offline) and get back the
 * normalized canvas graph the browser half renders.
 *
 * `object_info` shape per node:
 *   { input: { required: { name: [TYPE, opts] }, optional: {...}, hidden: {...} },
 *     input_order: { required: [names], optional: [names] }, category: string }
 * TYPE is either a string (INT/FLOAT/STRING/BOOLEAN/COMBO/MODEL/…) or an array
 * (legacy combo: the array itself is the option list). COMFY_DYNAMICCOMBO_V3 is a
 * combo whose options carry nested inputs; nested/extra widget slots consume
 * positional `widgets_values` entries exactly like the ComfyUI frontend does.
 */
import { isPlainObject } from './http.js'

/** Frontend-only node types that never appear in /object_info but are valid. */
const VIRTUAL_NODE_TYPES = new Set(['Note', 'MarkdownNote', 'PrimitiveNode', 'Reroute'])

/** Named widget values that are frontend bookkeeping, not node inputs. */
const FRONTEND_NAMED_KEYS = new Set([
  'control_after_generate',
  // control-after-generate state can be serialized under the mode name itself
  'fixed', 'randomize', 'increment', 'decrement', 'increment-wrap',
  // upload widget bookkeeping (image_upload / video_upload / audio_upload)
  'upload',
])

/** Input types rendered as a single editable widget. */
const PRIMITIVE_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])

/** Option lists are capped so a pathological definition cannot bloat the response. */
const MAX_COMBO_OPTIONS = 500

/** Extra widget slots some inputs append after their main value. */
const EXTRA_SLOT_FLAGS = [
  'control_after_generate',
  'image_upload',
  'video_upload',
  'animated_image_upload',
  'mesh_upload',
  'audio_upload',
  'upload',
]

/* ------------------------------------------------------------------ */
/* types / detection                                                   */
/* ------------------------------------------------------------------ */

/** True for frontend-only nodes (Note/MarkdownNote/Reroute/PrimitiveNode). */
export function isVirtualNodeType(type) {
  return VIRTUAL_NODE_TYPES.has(String(type ?? ''))
}

/** Ids of frontend-defined subgraph "node types" in a UI workflow. */
export function subgraphTypeIds(workflow) {
  const ids = new Set()
  const subgraphs = workflow?.definitions?.subgraphs
  if (!Array.isArray(subgraphs)) return ids
  for (const subgraph of subgraphs) {
    if (subgraph !== null && typeof subgraph === 'object' && typeof subgraph.id === 'string') ids.add(subgraph.id)
  }
  return ids
}

/** True for COMFY_DYNAMICCOMBO_V3-like inputs. */
export function isDynamicComboType(type) {
  return String(type ?? '').startsWith('COMFY_DYNAMICCOMBO')
}

/** True when a value is a ComfyUI API link reference into `prompt`. */
export function isLinkRef(value, prompt) {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === 'string'
    && Number.isInteger(Number(value[1]))
    && isPlainObject(prompt) && Object.prototype.hasOwnProperty.call(prompt, value[0])
}

/** Convert ComfyUI UI-format links (array or object form) into a uniform list. */
export function normalizeLinks(rawLinks) {
  const out = []
  if (!Array.isArray(rawLinks)) return out
  for (const link of rawLinks) {
    if (Array.isArray(link) && link.length >= 5) {
      out.push({
        id: String(link[0]),
        from: String(link[1]),
        fromSlot: Number(link[2]) || 0,
        to: String(link[3]),
        toSlot: Number(link[4]) || 0,
        type: link[5] === undefined ? undefined : String(link[5]),
      })
    } else if (isPlainObject(link)) {
      out.push({
        id: String(link.id ?? ''),
        from: String(link.origin_id ?? ''),
        fromSlot: Number(link.origin_slot) || 0,
        to: String(link.target_id ?? ''),
        toSlot: Number(link.target_slot) || 0,
        type: link.type === undefined ? undefined : String(link.type),
      })
    }
  }
  return out
}

/** Inspect a parsed file: 'ui' | 'api' | null (CONTRACT.md §2 heuristic). */
export function detectWorkflowKind(json) {
  if (!isPlainObject(json)) return null
  if (Array.isArray(json.nodes)) return 'ui'
  const prompt = extractPrompt(json)
  return prompt === null ? null : 'api'
}

/**
 * Extract an API prompt object from either `{prompt:{...}}` or a bare prompt map.
 * @returns {Record<string, object>|null}
 */
export function extractPrompt(json) {
  if (!isPlainObject(json)) return null
  if (isPlainObject(json.prompt) && looksLikePrompt(json.prompt)) return json.prompt
  if (looksLikePrompt(json)) return json
  return null
}

/** True when every own value looks like `{ class_type, inputs }`. */
function looksLikePrompt(value) {
  if (!isPlainObject(value)) return false
  const entries = Object.entries(value)
  if (entries.length === 0) return false
  return entries.every(([, node]) => isPlainObject(node) && typeof node.class_type === 'string')
}

/* ------------------------------------------------------------------ */
/* object_info input inspection                                        */
/* ------------------------------------------------------------------ */

/**
 * Build the ordered input-spec list for one node definition.
 * Order follows `input_order.required` then `input_order.optional`, falling back
 * to the object key order when input_order is missing.
 *
 * `options.nodeInputNames` (a Set of the saved node's `inputs[].name`) lets us
 * detect custom widget types (LOAD_3D, IMAGECOMPARE, …): the ComfyUI frontend
 * only creates input sockets for link-capable inputs, so an object_info input
 * that is absent from the saved node's input array is rendered as a widget.
 */
export function inputSpecs(def, options = {}) {
  const out = []
  const order = isPlainObject(def?.input_order) ? def.input_order : {}
  const input = isPlainObject(def?.input) ? def.input : {}
  for (const section of ['required', 'optional']) {
    const dict = isPlainObject(input[section]) ? input[section] : {}
    const names = Array.isArray(order[section]) && order[section].length > 0 ? order[section] : Object.keys(dict)
    for (const name of names) {
      const raw = dict[name]
      if (!Array.isArray(raw)) continue
      out.push(makeSpec(String(name), section, raw, options))
    }
  }
  return out
}

/** Ordered specs that consume a widget value. */
export function widgetSpecs(def, options = {}) {
  return inputSpecs(def, options).filter(spec => spec.isWidget)
}

/** name -> spec map for all required+optional inputs. */
export function inputSpecMap(def, options = {}) {
  const map = new Map()
  for (const spec of inputSpecs(def, options)) map.set(spec.name, spec)
  return map
}

/** Normalize one `[TYPE, opts]` pair into an internal spec. */
function makeSpec(name, section, raw, options = {}) {
  const type = raw[0]
  const opts = isPlainObject(raw[1]) ? raw[1] : {}
  const dynamic = isDynamicComboType(type)
  let extraSlots = 0
  // control_after_generate may be `true` or one of the string modes ("fixed",
  // "randomize", ...) depending on the node definition version.
  if (opts.control_after_generate === true || typeof opts.control_after_generate === 'string') extraSlots += 1
  for (const flag of EXTRA_SLOT_FLAGS) {
    if (flag === 'control_after_generate') continue
    if (opts[flag] === true) extraSlots += 1
  }
  let isWidget = Array.isArray(type) || PRIMITIVE_TYPES.has(String(type)) || dynamic
  if (!isWidget && opts.forceInput !== true) {
    // Explicit socketless widgets (IMAGECOMPARE/COLOR/...) are always widgets.
    if (opts.socketless === true) {
      isWidget = true
    } else if (options.nodeInputNames instanceof Set && !options.nodeInputNames.has(name)) {
      // Data-driven fallback for custom widget types that carry no marker: if
      // the saved node has no input socket with this name, it was a widget.
      isWidget = true
    }
  }
  return {
    name,
    section,
    type,
    opts,
    dynamic,
    isWidget,
    extraSlots,
    depth: options.depth ?? 0,
  }
}

/** Widget kind for the Graph schema. */
export function widgetKindOf(spec) {
  if (Array.isArray(spec.type) || spec.dynamic) return 'combo'
  const type = String(spec.type)
  if (type === 'INT' || type === 'FLOAT') return 'number'
  if (type === 'BOOLEAN') return 'bool'
  if (type === 'COMBO') return 'combo'
  return 'text'
}

/** Option list of a combo spec (legacy array, COMBO opts.options, dynamic keys). */
export function comboOptionsOf(spec) {
  let raw = []
  if (Array.isArray(spec.type)) {
    raw = spec.type
  } else if (spec.dynamic) {
    raw = Array.isArray(spec.opts.options) ? spec.opts.options.map(option => (isPlainObject(option) ? option.key : option)) : []
  } else if (Array.isArray(spec.opts.options)) {
    raw = spec.opts.options
  }
  return raw.filter(option => ['string', 'number', 'boolean'].includes(typeof option)).slice(0, MAX_COMBO_OPTIONS)
}

/**
 * Nested input specs contributed by a dynamic combo's currently selected option.
 * @returns {Array<object>} specs whose dotted name is `<combo>.<name>`
 */
export function dynamicOptionInputs(spec, selectedValue, depth = 0) {
  if (spec?.dynamic !== true || depth > 3) return []
  const options = Array.isArray(spec.opts.options) ? spec.opts.options : []
  const wanted = String(selectedValue)
  const selected = options.find(option => isPlainObject(option) && String(option.key) === wanted)
  if (selected === undefined) return []
  const out = []
  for (const section of ['required', 'optional']) {
    const dict = selected.inputs?.[section]
    if (!isPlainObject(dict)) continue
    for (const [name, raw] of Object.entries(dict)) {
      if (!Array.isArray(raw)) continue
      out.push(makeSpec(String(name), section, raw, { depth: depth + 1 }))
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* widget value mapping (positional fallback, CONTRACT.md §4.4)        */
/* ------------------------------------------------------------------ */

/**
 * Map an old positional `widgets_values` array onto input names.
 * Handles dynamic-combo nested widget slots and extra widget slots
 * (control_after_generate / image_upload / ...).
 *
 * @param {object} def object_info entry for the node type
 * @param {unknown[]} positionalValues raw `widgets_values`
 * @param {{ nodeInputNames?: Set<string> }} [options]
 * @returns {{ values: Map<string, unknown>, warnings: string[], expected: number, actual: number }}
 */
export function mapPositionalWidgets(def, positionalValues, options = {}) {
  const values = new Map()
  const arr = Array.isArray(positionalValues) ? positionalValues : []
  const warnings = []
  const missing = []
  const cursor = { index: 0 }
  let expected = 0

  const consumeTree = (spec, prefix) => {
    const name = prefix === '' ? spec.name : `${prefix}.${spec.name}`
    expected += 1
    if (cursor.index >= arr.length) {
      missing.push(name)
      return undefined
    }
    const value = arr[cursor.index++]
    values.set(name, value)
    // Extra widget slots (e.g. the seed "control after generate" combo) follow
    // the value they belong to and are intentionally discarded.
    if (spec.extraSlots > 0) {
      expected += spec.extraSlots
      cursor.index += spec.extraSlots
    }
    if (spec.dynamic) {
      // Only widget-like nested inputs consume positional slots; nested sockets
      // (e.g. an autogrow input inside a dynamic combo) are links, not widgets.
      for (const sub of dynamicOptionInputs(spec, value)) {
        if (sub.isWidget) consumeTree(sub, name)
      }
    }
    return value
  }

  for (const spec of widgetSpecs(def, options)) consumeTree(spec, '')

  const actual = arr.length
  if (missing.length > 0 || actual !== expected) {
    warnings.push(`widget 数量不匹配(${actual}/${expected})`)
  }
  return { values, warnings, expected, actual }
}

/**
 * Resolve the effective widget values of one UI node, preferring
 * `widgets_values_named` and falling back to positional mapping + defaults.
 *
 * @param {object} def object_info entry
 * @param {unknown[]} positionalValues raw `widgets_values`
 * @param {object|null} namedValues raw `widgets_values_named`
 * @param {{ nodeInputNames?: Set<string> }} [options]
 * @returns {{ entries: Array<{name:string,value:unknown,spec:object}>, unknownNamed: string[], positional: object }}
 */
export function collectWidgetValues(def, positionalValues, namedValues, options = {}) {
  const named = isPlainObject(namedValues) ? namedValues : null
  const positional = mapPositionalWidgets(def, positionalValues, options)
  const entries = []
  const consumedNamed = new Set()

  const pushEntry = (spec, prefix) => {
    const name = prefix === '' ? spec.name : `${prefix}.${spec.name}`
    let value
    if (named !== null && Object.prototype.hasOwnProperty.call(named, name)) {
      value = named[name]
      consumedNamed.add(name)
    } else if (positional.values.has(name)) {
      value = positional.values.get(name)
    }
    if (value === undefined && Object.prototype.hasOwnProperty.call(spec.opts, 'default')) {
      value = spec.opts.default // the ComfyUI frontend fills missing widgets from defaults
    }
    entries.push({ name, value, spec })
    if (spec.dynamic) {
      for (const sub of dynamicOptionInputs(spec, value)) {
        if (sub.isWidget) pushEntry(sub, name)
      }
    }
  }

  for (const spec of widgetSpecs(def, options)) pushEntry(spec, '')

  const unknownNamed = []
  if (named !== null) {
    for (const key of Object.keys(named)) {
      if (consumedNamed.has(key)) continue
      if (FRONTEND_NAMED_KEYS.has(key)) continue
      unknownNamed.push(key)
    }
  }
  return { entries, unknownNamed, positional }
}

/** True when a spec is a standard (primitive/combo/dynamic) widget type. */
export function isStandardWidgetSpec(spec) {
  return Array.isArray(spec.type) || PRIMITIVE_TYPES.has(String(spec.type)) || spec.dynamic === true
}

/** Turn one collected widget entry into the CONTRACT §3 widget descriptor. */
export function describeWidget(entry) {
  const spec = entry.spec
  const kind = widgetKindOf(spec)
  const widget = { name: entry.name, kind, value: entry.value }
  if (kind === 'combo') {
    const options = comboOptionsOf(spec)
    if (options.length > 0) widget.options = options
  } else if (kind === 'number') {
    if (Number.isFinite(spec.opts.min)) widget.min = spec.opts.min
    if (Number.isFinite(spec.opts.max)) widget.max = spec.opts.max
    if (Number.isFinite(spec.opts.step)) widget.step = spec.opts.step
  } else if (kind === 'text') {
    if (spec.opts.multiline === true) widget.multiline = true
  }
  return widget
}

/** Kind guessed from a raw JSON value (used when object_info is unavailable). */
export function inferKindOfValue(value) {
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) return 'combo'
  return 'text'
}

/** Raw widget fallback for nodes without object_info (offline / missing type). */
function rawWidgets(node) {
  const named = isPlainObject(node.widgets_values_named) ? node.widgets_values_named : null
  if (named !== null) {
    return Object.entries(named).map(([name, value]) => ({
      name,
      kind: inferKindOfValue(value),
      value: typeof value === 'object' && value !== null ? JSON.stringify(value) : value,
    }))
  }
  const positional = Array.isArray(node.widgets_values) ? node.widgets_values : []
  return positional.map((value, index) => ({
    name: `参数 ${index + 1}`,
    kind: inferKindOfValue(value),
    value: typeof value === 'object' && value !== null ? JSON.stringify(value) : value,
  }))
}

/* ------------------------------------------------------------------ */
/* UI format -> Graph                                                  */
/* ------------------------------------------------------------------ */

const DEFAULT_NODE_SIZE = [220, 80]

/** Coerce `pos`/`size` (array or {x,y}) into two numbers. */
function numberPair(value, fallback) {
  if (Array.isArray(value) && value.length >= 2) {
    const x = Number(value[0])
    const y = Number(value[1])
    return [Number.isFinite(x) ? x : fallback[0], Number.isFinite(y) ? y : fallback[1]]
  }
  if (isPlainObject(value)) {
    const x = Number(value.x ?? value[0])
    const y = Number(value.y ?? value[1])
    return [Number.isFinite(x) ? x : fallback[0], Number.isFinite(y) ? y : fallback[1]]
  }
  return fallback.slice()
}

/**
 * Normalize a UI-format workflow into Graph.
 * @param {object} workflow parsed UI workflow JSON
 * @param {object|null} objectInfo `/object_info` or null when offline
 * @param {string[]} warnings mutated with human-readable Chinese warnings
 */
export function uiToGraph(workflow, objectInfo, warnings) {
  const hasInfo = objectInfo !== null
  const rawNodes = Array.isArray(workflow?.nodes) ? workflow.nodes : []
  const links = normalizeLinks(workflow?.links)
  const missingTypes = new Set()
  const subgraphIds = subgraphTypeIds(workflow)
  let subgraphNodeCount = 0

  const edges = links.map(link => ({
    from: { node: link.from, slot: link.fromSlot },
    to: { node: link.to, slot: link.toSlot },
    ...(link.type === undefined ? {} : { type: link.type }),
  }))

  const nodes = rawNodes.map(rawNode => {
    const id = String(rawNode?.id ?? '')
    const type = String(rawNode?.type ?? 'unknown')
    const def = hasInfo ? objectInfo[type] : undefined
    const isSubgraph = subgraphIds.has(type)
    if (isSubgraph) subgraphNodeCount += 1
    const missing = Boolean(hasInfo && def === undefined && !isVirtualNodeType(type) && !isSubgraph)
    if (missing) missingTypes.add(type)

    const named = isPlainObject(rawNode?.widgets_values_named) ? rawNode.widgets_values_named : null
    let widgets = []
    if (hasInfo && def !== undefined) {
      const nodeInputNames = new Set(
        (Array.isArray(rawNode?.inputs) ? rawNode.inputs : []).map(input => String(input?.name ?? '')),
      )
      const collected = collectWidgetValues(
        def,
        Array.isArray(rawNode?.widgets_values) ? rawNode.widgets_values : [],
        named,
        { nodeInputNames },
      )
      widgets = collected.entries
        .filter(entry => entry.value !== undefined)
        .map(describeWidget)
      if (collected.unknownNamed.length > 0) {
        warnings.push(`节点 ${id}（${type}）有未定义参数：${collected.unknownNamed.slice(0, 6).join('、')}`)
      }
      // Count mismatch only matters when we actually had to trust positions.
      if (named === null) {
        for (const warning of collected.positional.warnings) warnings.push(`节点 ${id}（${type}）${warning}`)
      }
    } else {
      widgets = rawWidgets(rawNode ?? {})
    }

    const [x, y] = numberPair(rawNode?.pos, [0, 0])
    const [w, h] = numberPair(rawNode?.size, DEFAULT_NODE_SIZE)
    return {
      id,
      type,
      title: String(rawNode?.title ?? type),
      x,
      y,
      w,
      h,
      color: typeof rawNode?.color === 'string' ? rawNode.color : null,
      mode: Number.isFinite(Number(rawNode?.mode)) ? Number(rawNode.mode) : 0,
      ...(def?.category !== undefined ? { category: String(def.category) } : (isSubgraph ? { category: 'subgraph' } : {})),
      missing,
      widgets,
      inputs: (Array.isArray(rawNode?.inputs) ? rawNode.inputs : []).map(input => ({
        name: String(input?.name ?? ''),
        type: String(input?.type ?? ''),
      })),
      outputs: (Array.isArray(rawNode?.outputs) ? rawNode.outputs : []).map(output => ({
        name: String(output?.name ?? ''),
        type: String(output?.type ?? ''),
      })),
    }
  })

  if (missingTypes.size > 0) {
    const list = [...missingTypes]
    const shown = list.slice(0, 12).join('、')
    const more = list.length > 12 ? ` 等 ${list.length} 种` : ''
    warnings.push(`未知节点类型：${shown}${more}（本机 ComfyUI 可能未安装对应自定义节点）`)
  }
  if (subgraphNodeCount > 0) {
    warnings.push(`工作流包含 ${subgraphNodeCount} 个子图节点（Subgraph），当前版本暂不支持运行含子图的工作流（画布可正常查看）`)
  }

  const groups = (Array.isArray(workflow?.groups) ? workflow.groups : []).map(group => {
    const bounding = Array.isArray(group?.bounding) ? group.bounding : []
    const [x, y] = numberPair(bounding, [0, 0])
    const [, , w, h] = bounding
    return {
      title: String(group?.title ?? ''),
      x,
      y,
      w: Number.isFinite(Number(w)) ? Number(w) : 0,
      h: Number.isFinite(Number(h)) ? Number(h) : 0,
      ...(typeof group?.color === 'string' ? { color: group.color } : {}),
    }
  })

  return {
    nodes,
    edges,
    groups,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      missingTypes: [...missingTypes],
      mutedCount: nodes.filter(node => node.mode === 2).length,
    },
  }
}

/* ------------------------------------------------------------------ */
/* API format -> Graph                                                 */
/* ------------------------------------------------------------------ */

/** Longest-path depth per prompt node (cycle safe). */
function computeDepths(prompt) {
  const depths = new Map()
  const visiting = new Set()
  const visit = (id, stack) => {
    if (depths.has(id)) return depths.get(id)
    if (visiting.has(id) || stack > 256) return 0
    visiting.add(id)
    let depth = 0
    const inputs = prompt[id]?.inputs
    if (isPlainObject(inputs)) {
      for (const value of Object.values(inputs)) {
        if (isLinkRef(value, prompt)) depth = Math.max(depth, visit(value[0], stack + 1) + 1)
      }
    }
    visiting.delete(id)
    depths.set(id, depth)
    return depth
  }
  for (const id of Object.keys(prompt)) visit(id, 0)
  return depths
}

/** Human readable type label for Graph input/output port lists. */
function typeLabel(type) {
  if (Array.isArray(type)) return 'COMBO'
  const text = String(type ?? '')
  return isDynamicComboType(text) ? 'COMBO' : text
}

/** Numeric ordering for prompt ids so layout is deterministic. */
function compareIds(a, b) {
  const numericA = /^\d+$/.test(a) ? Number(a) : Number.MAX_SAFE_INTEGER
  const numericB = /^\d+$/.test(b) ? Number(b) : Number.MAX_SAFE_INTEGER
  if (numericA !== numericB) return numericA - numericB
  return a.localeCompare(b)
}

/**
 * Normalize an API-format workflow into Graph (layered auto layout).
 * @param {object} workflow parsed file containing a prompt
 * @param {object|null} objectInfo `/object_info` or null when offline
 * @param {string[]} warnings mutated with human-readable Chinese warnings
 */
export function apiToGraph(workflow, objectInfo, warnings) {
  const hasInfo = objectInfo !== null
  const prompt = extractPrompt(workflow) ?? {}
  const ids = Object.keys(prompt).sort(compareIds)
  const depths = computeDepths(prompt)
  const layers = new Map()
  for (const id of ids) {
    const depth = depths.get(id) ?? 0
    if (!layers.has(depth)) layers.set(depth, [])
    layers.get(depth).push(id)
  }
  const missingTypes = new Set()
  const nodes = []
  const edges = []

  for (const id of ids) {
    const entry = prompt[id] ?? {}
    const type = String(entry.class_type ?? 'unknown')
    const def = hasInfo ? objectInfo[type] : undefined
    const missing = Boolean(hasInfo && def === undefined)
    if (missing) missingTypes.add(type)
    const inputValues = isPlainObject(entry.inputs) ? entry.inputs : {}
    const specMap = def !== undefined ? inputSpecMap(def) : new Map()

    const widgets = []
    for (const [name, value] of Object.entries(inputValues)) {
      if (isLinkRef(value, prompt)) continue
      const spec = specMap.get(name)
      if (spec !== undefined && spec.isWidget) {
        // A dynamic combo can also be submitted as one object; show its base value.
        if (isPlainObject(value) && spec.dynamic) {
          const base = Object.prototype.hasOwnProperty.call(value, name) ? value[name] : Object.values(value)[0]
          widgets.push({ name, kind: 'combo', value: base })
          for (const [subName, subValue] of Object.entries(value)) {
            if (subName === name) continue
            widgets.push({ name: `${name}.${subName}`, kind: inferKindOfValue(subValue), value: subValue })
          }
        } else {
          widgets.push(describeWidget({ name, value, spec }))
        }
      } else {
        widgets.push({
          name,
          kind: inferKindOfValue(value),
          value: typeof value === 'object' && value !== null ? JSON.stringify(value) : value,
        })
      }
    }

    const inputs = []
    if (def !== undefined) {
      for (const spec of inputSpecs(def)) inputs.push({ name: spec.name, type: typeLabel(spec.type) })
      for (const name of Object.keys(inputValues)) {
        if (!inputs.some(input => input.name === name)) inputs.push({ name, type: '*' })
      }
    } else {
      for (const [name, value] of Object.entries(inputValues)) {
        inputs.push({ name, type: isLinkRef(value, prompt) ? '*' : '*' })
      }
    }

    const outputs = def !== undefined && Array.isArray(def.output)
      ? def.output.map((outputType, index) => ({
        name: Array.isArray(def.output_name) && def.output_name[index] !== undefined
          ? String(def.output_name[index])
          : `output_${index}`,
        type: typeLabel(outputType),
      }))
      : []

    const depth = depths.get(id) ?? 0
    const layer = layers.get(depth) ?? []
    const row = layer.indexOf(id)
    nodes.push({
      id,
      type,
      title: type,
      x: 80 + depth * 300,
      y: 60 + row * 140,
      w: 240,
      h: 100,
      color: null,
      mode: 0,
      ...(def?.category !== undefined ? { category: String(def.category) } : {}),
      missing,
      widgets,
      inputs,
      outputs,
    })

    // Record edges and the target slot index.
    const slotByName = new Map(inputs.map((input, index) => [input.name, index]))
    for (const [name, value] of Object.entries(inputValues)) {
      if (!isLinkRef(value, prompt)) continue
      const fromNode = String(value[0])
      const fromSlot = Number(value[1])
      const fromEntry = prompt[fromNode]
      const fromDef = hasInfo && fromEntry !== undefined ? objectInfo[String(fromEntry.class_type)] : undefined
      const edgeType = fromDef?.output?.[fromSlot]
      edges.push({
        from: { node: fromNode, slot: fromSlot },
        to: { node: id, slot: slotByName.get(name) ?? -1 },
        ...(edgeType === undefined ? {} : { type: typeLabel(edgeType) }),
      })
    }
  }

  if (missingTypes.size > 0) {
    const list = [...missingTypes]
    const shown = list.slice(0, 12).join('、')
    const more = list.length > 12 ? ` 等 ${list.length} 种` : ''
    warnings.push(`未知节点类型：${shown}${more}（本机 ComfyUI 可能未安装对应自定义节点）`)
  }

  return {
    nodes,
    edges,
    groups: [],
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      missingTypes: [...missingTypes],
      mutedCount: 0,
    },
  }
}

/**
 * Normalize any ComfyUI workflow file into `{ kind, graph, warnings }`.
 * Never throws for valid files; throws for files that are not workflows.
 *
 * @param {object} workflow parsed workflow JSON (UI or API format)
 * @param {object|null} objectInfo /object_info map, or null when ComfyUI is offline
 */
export function toGraph(workflow, objectInfo) {
  const kind = detectWorkflowKind(workflow)
  if (kind === null) throw new Error('不是有效的 ComfyUI 工作流')
  const hasInfo = objectInfo !== null && typeof objectInfo === 'object'
    && !Array.isArray(objectInfo) && Object.keys(objectInfo).length > 0
  const warnings = []
  if (!hasInfo) warnings.push('ComfyUI 未运行，参数不可编辑')
  const info = hasInfo ? objectInfo : null
  const graph = kind === 'ui' ? uiToGraph(workflow, info, warnings) : apiToGraph(workflow, info, warnings)
  return { kind, graph, warnings }
}
