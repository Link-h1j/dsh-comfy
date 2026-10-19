/**
 * dsh-comfy —— 浏览器半边（可读源码；产物 client.js 由 tools/build-client.mjs 生成）。
 *
 * 在 DSH 右侧栏里注册一个 `comfy` 页型 tab：原生 ComfyUI 工作流画布。
 *   · 顶栏：ComfyUI 状态灯 / 工作流选择器（搜索 + 按来源分组）/ 刷新 / 参数
 *   · 画布：无限平移缩放、节点卡片（按 object_info 分类着色）、贝塞尔连线、分组框、
 *           选中高亮、本地拖动节点、双击节点 → 参数抽屉 + 居中
 *   · 参数抽屉：graph.nodes[].widgets 的可编辑控件，改动写入 overrides（"<nodeId>.<name>"）
 *   · 运行栏：运行 / 中断 / 状态 / 耗时 / 队列位置，800ms 轮询 /progress
 *   · 结果：结果条 + 画布结果卡片 + 全屏预览（image/video/audio/3d/text），下载 / 新标签打开
 *   · 离线态：启动 ComfyUI 按钮 + 2s 轮询状态
 *
 * 形态约束（浏览器侧加载器只认这种）：
 *   - CJS：require / module.exports；无 ESM import/export（构建闸门会拦）。
 *   - 只 require('react')。
 *
 * 配色：优先用 DSH 的 --dsw-alias-* 令牌，统一收敛成本文件自己的 --cmf-* 变量
 * （var(--dsw-xxx, 浅色兜底)），浅色是默认，@media prefers-color-scheme: dark 覆盖深色兜底；
 * 另留 [data-cmf-theme="light"|"dark"] 供离线预览/截图强制主题。**不写死任何底色。**
 */
const React = require('react')

const h = React.createElement
const { useCallback, useEffect, useMemo, useRef, useState } = React

/** 本插件包名（= profile loader 行 = __ModuleLoader__ 注册 id）。 */
const PKG = 'dsh-comfy'
const TAB_ID = PKG
const TAB_KIND = 'comfy'
const NS = PKG

/** 构建标记：界面上不显示，写在 root 的 data 属性里，排查“跑的是哪一版”。 */
const BUILD_STAMP = '2026-10-19 v1 canvas'

const API = {
  status: '/api/dsh-comfy/status',
  start: '/api/dsh-comfy/start',
  workflows: '/api/dsh-comfy/workflows',
  workflow: '/api/dsh-comfy/workflow',
  run: '/api/dsh-comfy/run',
  progress: '/api/dsh-comfy/progress',
  interrupt: '/api/dsh-comfy/interrupt',
  history: '/api/dsh-comfy/history',
  view: '/api/dsh-comfy/view',
}

const ZOOM_MIN = 0.15
const ZOOM_MAX = 2.5
/** 视图自适应（fit 按钮 / F 键 / 打开工作流）的缩放夹取：绝不把整图缩到看不清。 */
const FIT_MIN_ZOOM = 0.45
const FIT_MAX_ZOOM = 0.85
const CENTER_MIN_ZOOM = 0.6
/** 打开工作流时的“可读优先”初始视图：整图 fit 够大就直接 fit；否则用这个缩放聚焦最大分组。 */
const INITIAL_READABLE_MIN = 0.55
const INITIAL_FOCUS_ZOOM = 0.62
const ZOOM_STEP = 1.22
const PROGRESS_POLL_MS = 800
/** 指针移动超过这个屏幕像素才算“拖动”，拖动开始后才做 pointer capture（否则 click 会被重定向到 stage）。 */
const DRAG_THRESHOLD_PX = 3
/** 右键菜单尺寸常量（估算用，CSS 里的宽高由内容决定，这里只用于贴边夹取）。 */
const CONTEXT_MENU_WIDTH = 210
const CONTEXT_MENU_ITEM_H = 28
const CONTEXT_MENU_SEP_H = 7
const CONTEXT_MENU_PAD = 8
const STATUS_ONLINE_MS = 15000
const STATUS_OFFLINE_MS = 2000
const NODE_HEADER_H = 22
const NODE_MIN_W = 112
const NODE_MAX_W = 420
const NODE_MIN_H = 46
const NODE_MAX_H = 340
const MAX_EDGES = 500
const MAX_RESULT_CARDS = 24

/* ------------------------------------------------------------------ */
/* 纯函数工具（__testHooks 导出，供 tools/client-smoke.mjs 单测）       */
/* ------------------------------------------------------------------ */

/** 数值夹取；非数字回落到 min。 */
function clamp(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return number < min ? min : number > max ? max : number
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/** 耗时格式化：0.0s / 12.3s / 1m05s。 */
function formatElapsed(milliseconds) {
  let ms = Number(milliseconds)
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const seconds = ms / 1000
  if (seconds < 60) return seconds.toFixed(1) + 's'
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return minutes + 'm' + String(rest).padStart(2, '0') + 's'
}

/** 文本截断（超过 max 用 … 收尾）。 */
function truncate(text, max) {
  const value = String(text === null || text === undefined ? '' : text)
  if (value.length <= max) return value
  return value.slice(0, Math.max(1, max - 1)) + '…'
}

/** widget 值的紧凑预览（节点卡片上的小标签）。 */
function previewValue(value) {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.length + ' items'
  if (typeof value === 'object') {
    try {
      return truncate(JSON.stringify(value), 24)
    } catch (error) {
      return '{…}'
    }
  }
  return truncate(String(value), 26)
}

/** 输出扩展名（小写、不含点）。 */
function extOf(filename) {
  const name = String(filename === null || filename === undefined ? '' : filename).replace(/\\/g, '/')
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

const KIND_BY_EXT = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', bmp: 'image', avif: 'image',
  svg: 'image', ico: 'image', apng: 'image', tif: 'image', tiff: 'image',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video', gif: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', opus: 'audio',
  glb: '3d', gltf: '3d', obj: '3d', fbx: '3d', ply: '3d', stl: '3d', splat: '3d',
  txt: 'text', md: 'text', json: 'text', csv: 'text',
}
const RESULT_KINDS = ['image', 'video', 'audio', '3d', 'text', 'file']

/** OutputRef → 结果种类（优先用 host 给的 kind，缺失按扩展名兜底）。 */
function resultKindOf(output) {
  const value = output === null || output === undefined ? {} : output
  const declared = String(value.kind === undefined || value.kind === null ? '' : value.kind).toLowerCase()
  if (RESULT_KINDS.indexOf(declared) !== -1) return declared
  const byExt = KIND_BY_EXT[extOf(value.filename)]
  return byExt === undefined ? 'file' : byExt
}

/** OutputRef → 可直接给 <img>/<video>/下载链接 用的同源 URL。 */
function outputUrl(output) {
  const value = output === null || output === undefined ? {} : output
  if (typeof value.url === 'string' && value.url !== '') return value.url
  const filename = String(value.filename === undefined || value.filename === null ? '' : value.filename)
  const subfolder = String(value.subfolder === undefined || value.subfolder === null ? '' : value.subfolder)
  const type = String(value.type === undefined || value.type === null ? '' : value.type)
  return API.view
    + '?filename=' + encodeURIComponent(filename)
    + '&subfolder=' + encodeURIComponent(subfolder)
    + '&type=' + encodeURIComponent(type === '' ? 'output' : type)
}

/** 节点卡片在画布上的实际尺寸（图里给的 w/h 会在合理区间内夹取）。 */
function normalizeNodeSize(node) {
  const value = node === null || node === undefined ? {} : node
  return {
    w: clamp(Number.isFinite(Number(value.w)) ? Number(value.w) : 240, NODE_MIN_W, NODE_MAX_W),
    h: clamp(Number.isFinite(Number(value.h)) ? Number(value.h) : 120, NODE_MIN_H, NODE_MAX_H),
  }
}

/** 节点标题。 */
function nodeTitleOf(node) {
  const value = node === null || node === undefined ? {} : node
  if (typeof value.title === 'string' && value.title !== '') return value.title
  if (typeof value.type === 'string' && value.type !== '') return value.type
  return String(value.id === undefined ? '?' : value.id)
}

/** 分类 → 0..7 的强调色序号（同名分类稳定同色）。 */
function categoryAccentIndex(category) {
  const text = String(category === null || category === undefined ? '' : category)
  if (text === '') return 0
  let hash = 0
  for (let index = 0; index < text.length; index++) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  }
  return hash % 8
}

/** overrides 的键：`<nodeId>.<inputName>`。 */
function overrideKeyOf(nodeId, name) {
  return String(nodeId) + '.' + String(name)
}

/** 写 overrides（返回新对象，不改原对象）；value 为 undefined 时删除该键。 */
function setOverrideValue(overrides, nodeId, name, value) {
  const key = overrideKeyOf(nodeId, name)
  const next = Object.assign({}, overrides === null || overrides === undefined ? {} : overrides)
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

/** 控件原始值 → 写入 overrides 的值。 */
function coerceWidgetValue(kind, raw) {
  if (kind === 'number') {
    if (raw === '' || raw === null || raw === undefined) return ''
    const number = Number(raw)
    return Number.isFinite(number) ? number : raw
  }
  if (kind === 'bool') return raw === true || raw === 'true' || raw === '1' || raw === 1
  if (kind === 'combo') {
    if (Array.isArray(raw)) return raw
    return raw
  }
  return raw === null || raw === undefined ? '' : String(raw)
}

/** combo 的显示文本（选项可能是字符串/数字/对象）。 */
function optionLabel(option) {
  if (typeof option === 'string') return option
  if (typeof option === 'number' || typeof option === 'boolean') return String(option)
  if (option === null || option === undefined) return ''
  try {
    return JSON.stringify(option)
  } catch (error) {
    return String(option)
  }
}

/** 在 combo 的 options 里按字符串回找原始选项（保持数字/对象类型不丢）。 */
function matchComboOption(options, raw) {
  const list = Array.isArray(options) ? options : []
  const text = optionLabel(raw)
  for (const option of list) {
    if (optionLabel(option) === text) return option
  }
  return raw
}

function contentBounds(items) {
  const list = Array.isArray(items) ? items.filter((item) => item && Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y))) : []
  if (list.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const item of list) {
    const x = Number(item.x)
    const y = Number(item.y)
    const w = Number.isFinite(Number(item.w)) ? Number(item.w) : 100
    const h = Number.isFinite(Number(item.h)) ? Number(item.h) : 40
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + w)
    maxY = Math.max(maxY, y + h)
  }
  return { minX, minY, maxX, maxY }
}

/** 把内容 bounds 装进 viewport：返回 {x,y,k}。 */
function fitViewToBounds(bounds, width, height, padding) {
  const pad = Number.isFinite(Number(padding)) ? Number(padding) : 32
  if (!bounds || !Number.isFinite(Number(width)) || !Number.isFinite(Number(height)) || Number(width) < 32 || Number(height) < 32) {
    return { x: pad, y: pad, k: 0.8 }
  }
  const boxWidth = Math.max(1, bounds.maxX - bounds.minX)
  const boxHeight = Math.max(1, bounds.maxY - bounds.minY)
  // 下限 0.45：窄侧栏里宽工作流不会被缩成 20% 的灰块（整图总览请手动滚轮缩小）；
  // 上限 0.85：小工作流不会被放到过大。两种 fit 入口（打开工作流 / fit 按钮）共用这一支。
  const scale = clamp(Math.min((Number(width) - pad * 2) / boxWidth, (Number(height) - pad * 2) / boxHeight), FIT_MIN_ZOOM, FIT_MAX_ZOOM)
  return {
    x: round2((Number(width) - boxWidth * scale) / 2 - bounds.minX * scale),
    y: round2((Number(height) - boxHeight * scale) / 2 - bounds.minY * scale),
    k: round2(scale),
  }
}

/** 以画布内某点为中心缩放到 k。 */
function zoomAtPoint(view, pointerX, pointerY, nextScale) {
  const current = view === null || view === undefined ? { x: 0, y: 0, k: 1 } : view
  const scale = clamp(nextScale, ZOOM_MIN, ZOOM_MAX)
  const ratio = scale / Math.max(0.0001, Number(current.k) || 1)
  return {
    k: scale,
    x: pointerX - (pointerX - current.x) * ratio,
    y: pointerY - (pointerY - current.y) * ratio,
  }
}

/** 滚轮 → 新 view（以指针为中心，deltaY 向下缩小）。 */
function wheelZoom(view, pointerX, pointerY, deltaY) {
  const current = view === null || view === undefined ? { x: 0, y: 0, k: 1 } : view
  const factor = Math.exp(-Number(deltaY || 0) / 420)
  return zoomAtPoint(current, pointerX, pointerY, (Number(current.k) || 1) * factor)
}

/** 屏幕坐标 → 世界坐标。 */
function screenToWorld(view, pointerX, pointerY) {
  const current = view === null || view === undefined ? { x: 0, y: 0, k: 1 } : view
  const scale = Math.max(0.0001, Number(current.k) || 1)
  return { x: (pointerX - current.x) / scale, y: (pointerY - current.y) / scale }
}

/** AABB 相交：box {x0,y0,x1,y1} × rect {x,y,w,h}（框选/命中测试共用）。 */
function intersectsRect(box, rect) {
  if (box === null || box === undefined || rect === null || rect === undefined) return false
  const x0 = Math.min(Number(box.x0), Number(box.x1))
  const x1 = Math.max(Number(box.x0), Number(box.x1))
  const y0 = Math.min(Number(box.y0), Number(box.y1))
  const y1 = Math.max(Number(box.y0), Number(box.y1))
  const rx = Number(rect.x)
  const ry = Number(rect.y)
  const rw = Number(rect.w)
  const rh = Number(rect.h)
  if (![x0, x1, y0, y1, rx, ry, rw, rh].every(Number.isFinite)) return false
  return rx < x1 && rx + rw > x0 && ry < y1 && ry + rh > y0
}

/** 框选命中（世界坐标）：entries [{id,x,y,w,h}] × box → 命中的 id 列表。 */
function selectNodesInBox(entries, box) {
  const list = Array.isArray(entries) ? entries : []
  const ids = []
  for (const entry of list) {
    if (entry === null || entry === undefined) continue
    if (intersectsRect(box, entry)) ids.push(String(entry.id))
  }
  return ids
}

/** 两个屏幕点 → 归一化矩形（left/top/width/height），用于框选遮罩。 */
function boxFromPoints(ax, ay, bx, by) {
  const x1 = Number(ax) || 0
  const y1 = Number(ay) || 0
  const x2 = Number(bx) || 0
  const y2 = Number(by) || 0
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}

/** 右键菜单位置夹取（position:fixed，四周留 6px，避免贴边溢出）。 */
function clampContextMenuPosition(x, y, width, height, viewportWidth, viewportHeight) {
  const margin = 6
  const viewWidth = Number.isFinite(Number(viewportWidth)) && Number(viewportWidth) > 0 ? Number(viewportWidth) : 1024
  const viewHeight = Number.isFinite(Number(viewportHeight)) && Number(viewportHeight) > 0 ? Number(viewportHeight) : 768
  const menuWidth = Number.isFinite(Number(width)) && Number(width) > 0 ? Number(width) : 210
  const menuHeight = Number.isFinite(Number(height)) && Number(height) > 0 ? Number(height) : 40
  return {
    x: clamp(Number.isFinite(Number(x)) ? Number(x) : margin, margin, Math.max(margin, viewWidth - menuWidth - margin)),
    y: clamp(Number.isFinite(Number(y)) ? Number(y) : margin, margin, Math.max(margin, viewHeight - menuHeight - margin)),
  }
}

/**
 * 右键菜单项模型（ComfyUI 习惯）：
 *   stage  = 空白画布；node = 节点上；result = 结果卡片上。
 * 渲染由 ContextMenu 组件负责，动作分发由 runContextMenuAction 负责（按 id）。
 */
const CONTEXT_MENU_ITEMS = {
  stage: [
    { id: 'fit', icon: 'fit', labelKey: 'ctxFit' },
    { id: 'zoom100', icon: 'reset', labelKey: 'ctxZoom100' },
    { id: 'deselect', icon: 'close', labelKey: 'ctxDeselect' },
    { id: 'params', icon: 'sliders', labelKey: 'ctxParams', needsGraph: true },
    { id: 'refresh', icon: 'refresh', labelKey: 'ctxRefresh' },
    { id: 'run', icon: 'play', labelKey: 'ctxRun', needsGraph: true },
    { id: 'picker', icon: 'search', labelKey: 'ctxPicker', separatorBefore: true },
  ],
  node: [
    { id: 'params', icon: 'sliders', labelKey: 'ctxOpenParams' },
    { id: 'center', icon: 'fit', labelKey: 'ctxCenter' },
    { id: 'copyType', icon: 'file', labelKey: 'ctxCopyType' },
    { id: 'copyTitle', icon: 'text', labelKey: 'ctxCopyTitle' },
  ],
  result: [
    { id: 'preview', icon: 'image', labelKey: 'ctxPreview' },
    { id: 'download', icon: 'download', labelKey: 'ctxDownload' },
    { id: 'open', icon: 'external', labelKey: 'ctxOpenTab' },
    { id: 'remove', icon: 'close', labelKey: 'ctxRemoveCard', separatorBefore: true, danger: true },
  ],
}

/** 取某类右键菜单的项（返回副本，避免调用方改到共享模型）。 */
function contextMenuItemsFor(kind) {
  const list = CONTEXT_MENU_ITEMS[kind]
  return Array.isArray(list) ? list.map((item) => Object.assign({}, item)) : []
}

/** 估算右键菜单高度（用于贴边夹取）。 */
function contextMenuHeight(items) {
  const list = Array.isArray(items) ? items : []
  let height = CONTEXT_MENU_PAD * 2
  for (const item of list) {
    if (item && item.separatorBefore === true) height += CONTEXT_MENU_SEP_H
    height += CONTEXT_MENU_ITEM_H
  }
  return height
}

/** 节点第 index 个端口在卡片内的纵向偏移（在标题栏以下均匀分布）。 */
function portOffset(index, count, height) {
  const total = Math.max(1, Number(count) || 1)
  const position = clamp(Number(index) || 0, 0, total - 1)
  const bodyHeight = Math.max(8, (Number(height) || NODE_MIN_H) - NODE_HEADER_H)
  return NODE_HEADER_H + ((position + 0.5) / total) * bodyHeight
}

/** 两点之间的三次贝塞尔 path。 */
function edgeBezierPath(x1, y1, x2, y2) {
  const startX = Number(x1) || 0
  const startY = Number(y1) || 0
  const endX = Number(x2) || 0
  const endY = Number(y2) || 0
  const handle = clamp(Math.abs(endX - startX) * 0.5, 22, 150)
  return 'M' + round2(startX) + ' ' + round2(startY)
    + ' C' + round2(startX + handle) + ' ' + round2(startY)
    + ', ' + round2(endX - handle) + ' ' + round2(endY)
    + ', ' + round2(endX) + ' ' + round2(endY)
}

/** 工作流列表按来源分组（固定来源顺序；未知来源接在后面）。 */
function groupWorkflows(items, sources, fallbackLabels) {
  const list = Array.isArray(items) ? items : []
  const labels = fallbackLabels === null || fallbackLabels === undefined ? {} : fallbackLabels
  const order = ['user', 'workspace', 'templates']
  const bySource = new Map()
  for (const item of list) {
    if (!item) continue
    const source = String(item.source === undefined || item.source === null ? 'other' : item.source)
    if (!bySource.has(source)) bySource.set(source, [])
    bySource.get(source).push(item)
  }
  const known = new Map()
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source || source.id === undefined) continue
    known.set(String(source.id), source)
  }
  const ids = []
  for (const id of order) if (bySource.has(id) || known.has(id)) ids.push(id)
  for (const id of bySource.keys()) if (ids.indexOf(id) === -1) ids.push(id)
  const groups = []
  for (const id of ids) {
    const entries = bySource.get(id) || []
    const meta = known.get(id)
    const label = meta && typeof meta.label === 'string' && meta.label !== ''
      ? meta.label
      : (labels[id] || id)
    groups.push({ id, label, count: entries.length, items: entries })
  }
  return groups
}

/** 工作流选择器搜索：名字 / 相对路径 / id，大小写不敏感。 */
function filterWorkflows(items, query) {
  const list = Array.isArray(items) ? items : []
  const text = String(query === null || query === undefined ? '' : query).trim().toLowerCase()
  if (text === '') return list
  return list.filter((item) => {
    if (!item) return false
    const name = String(item.name === undefined || item.name === null ? '' : item.name).toLowerCase()
    const relPath = String(item.relPath === undefined || item.relPath === null ? '' : item.relPath).toLowerCase()
    const id = String(item.id === undefined || item.id === null ? '' : item.id).toLowerCase()
    return name.indexOf(text) !== -1 || relPath.indexOf(text) !== -1 || id.indexOf(text) !== -1
  })
}

/** graph 概要（优先用 host 的 stats，缺失时本地统计）。 */
function summarizeGraph(graph) {
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : []
  const edges = graph && Array.isArray(graph.edges) ? graph.edges : []
  const stats = graph && graph.stats ? graph.stats : null
  const missing = new Map()
  for (const node of nodes) {
    if (node && node.missing === true) missing.set(String(node.type === undefined ? '?' : node.type), true)
  }
  const muted = nodes.filter((node) => node && (node.mode === 2 || node.mode === 4)).length
  let widgetCount = 0
  for (const node of nodes) {
    if (node && Array.isArray(node.widgets)) widgetCount += node.widgets.length
  }
  return {
    nodeCount: stats && Number.isFinite(Number(stats.nodeCount)) ? Number(stats.nodeCount) : nodes.length,
    edgeCount: stats && Number.isFinite(Number(stats.edgeCount)) ? Number(stats.edgeCount) : edges.length,
    mutedCount: stats && Number.isFinite(Number(stats.mutedCount)) ? Number(stats.mutedCount) : muted,
    missingTypes: Array.isArray(stats && stats.missingTypes) ? stats.missingTypes.slice() : [...missing.keys()],
    widgetCount,
  }
}

/** 节点可编辑的 widget 列表（text/number/bool/combo）。 */
function editableWidgets(node) {
  const widgets = node && Array.isArray(node.widgets) ? node.widgets : []
  return widgets.filter((widget) => widget && typeof widget.name === 'string' && widget.name !== ''
    && (widget.kind === 'text' || widget.kind === 'number' || widget.kind === 'bool' || widget.kind === 'combo'))
}

/** 读 overrides 里某个 widget 的当前值。 */
function overrideValueOf(overrides, nodeId, name, fallback) {
  const map = overrides === null || overrides === undefined ? {} : overrides
  const key = overrideKeyOf(nodeId, name)
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : fallback
}

/**
 * 把一次运行的结果输出排成画布卡片：挂在对应节点右侧，同节点多个输出往下/往右错开。
 * @param outputs - /progress 的 outputs
 * @param graph - Graph
 * @param positions - { [nodeId]: {x,y} } 本地拖动后的位置
 */
function buildResultCards(outputs, graph, positions) {
  const list = Array.isArray(outputs) ? outputs : []
  const graphNodes = graph && Array.isArray(graph.nodes) ? graph.nodes : []
  const byId = new Map()
  for (const node of graphNodes) if (node) byId.set(String(node.id), node)
  const local = positions === null || positions === undefined ? {} : positions
  const counters = new Map()
  const cards = []
  for (let index = 0; index < list.length && cards.length < MAX_RESULT_CARDS; index++) {
    const output = list[index] || {}
    const kind = resultKindOf(output)
    const nodeId = String(output.nodeId === undefined || output.nodeId === null ? '' : output.nodeId)
    const node = byId.get(nodeId)
    let x = 60 + (index % 3) * 210
    let y = 60 + Math.floor(index / 3) * 150
    if (node !== undefined) {
      const pos = local[nodeId] !== undefined ? local[nodeId] : { x: node.x, y: node.y }
      const size = normalizeNodeSize(node)
      const count = counters.get(nodeId) || 0
      counters.set(nodeId, count + 1)
      x = Number(pos.x || 0) + size.w + 26 + (count % 2) * 196
      y = Number(pos.y || 0) + Math.floor(count / 2) * 132
    }
    cards.push({
      key: String(output.url || output.filename || index) + '@' + nodeId + '#' + index,
      output,
      kind,
      x: Math.round(x),
      y: Math.round(y),
      w: kind === 'image' ? 184 : 172,
      h: kind === 'image' ? 148 : kind === 'video' ? 140 : 96,
    })
  }
  return cards
}

/* ------------------------------------------------------------------ */
/* 文案（ZH 为主，EN 完整；键集合必须一致，smoke 会断言）              */
/* ------------------------------------------------------------------ */

const ZH = {
  title: 'ComfyUI',
  guideDesc: '本地 ComfyUI 工作流画布：浏览、调参、运行',
  loading: '正在读取 ComfyUI…',
  loadingWorkflow: '正在读取工作流…',
  loadingWorkflows: '正在读取工作流列表…',
  retry: '重试',
  dismiss: '关闭',
  refresh: '刷新',
  online: '在线',
  offline: '离线',
  busy: '运行中',
  statusUnknown: '状态未知',
  version: '版本',

  selectWorkflow: '选择工作流',
  changeWorkflow: '切换工作流',
  searchPlaceholder: '搜索工作流（名称 / 路径）…',
  noMatch: '没有匹配的工作流',
  sourceUser: '本机',
  sourceWorkspace: '工作区',
  sourceTemplates: '官方模板',
  sourceOther: '其它',
  workflowsTotal: '共 {n} 个工作流',
  moreItems: '还有 {n} 个，输入关键字搜索',
  kindUi: 'UI',
  kindApi: 'API',
  pickerEmpty: '工作流列表是空的',
  pickerEmptyHint: '确认 ComfyUI 的 user/workflows 或工作区工作流目录里有 .json 工作流',
  loadWorkflowsFailed: '读取工作流列表失败',

  params: '参数',
  paramsTitle: '参数',
  paramsOverrides: '{n} 项已改',
  paramsReset: '重置',
  paramsEmpty: '这个工作流没有可编辑参数',
  paramsEmptyHint: '（节点只有连线输入，或 ComfyUI 未运行导致参数不可用）',
  paramsMissingType: '节点类型缺失，无法编辑参数',
  paramsMuted: '已静音',
  resetOverrides: '重置全部参数',
  editedBadge: '已改',
  clickNodeHint: '双击画布节点可跳到对应参数',
  headHint: '单击标题打开参数',
  // 右键菜单（canvas / node / result）
  ctxFit: '适应画布',
  ctxZoom100: '缩放 100%',
  ctxDeselect: '取消选择',
  ctxParams: '参数面板',
  ctxRefresh: '刷新工作流',
  ctxRun: '运行',
  ctxPicker: '选择工作流…',
  ctxOpenParams: '打开参数',
  ctxCenter: '居中显示',
  ctxCopyType: '复制节点类型',
  ctxCopyTitle: '复制节点标题',
  ctxPreview: '预览大图',
  ctxDownload: '下载',
  ctxOpenTab: '在新标签打开',
  ctxRemoveCard: '从画布移除',
  copied: '已复制',
  copyFailed: '复制失败',
  boxSelectHint: '框选中',

  offlineTitle: 'ComfyUI 未运行',
  offlineHint: '点下方按钮在本机启动 ComfyUI（约 10-30 秒，首次加载模型更久）',
  startComfy: '启动 ComfyUI',
  startingComfy: '正在启动…',
  startRequested: '已请求启动，等待 ComfyUI 就绪…',
  startFailed: '启动失败',
  statusFailed: '读取 ComfyUI 状态失败',
  hostUnavailable: '读取 /api/dsh-comfy/status 失败，host 半边可能还没加载',

  emptyTitle: '还没有选择工作流',
  emptyHint: '从上方选择本机 / 工作区 / 官方模板工作流，在画布上查看并运行',
  pickWorkflow: '选择工作流',
  graphEmpty: '工作流里没有可显示的节点',
  graphEmptyHint: '这个文件可能是空的，或格式不被识别',

  nodes: '节点',
  edges: '连线',
  missingTypes: '缺失类型',
  mutedNodes: '静音/绕过',
  noWorkflowSelected: '未选择工作流',
  workflowWarnings: '工作流警告',

  run: '运行',
  runningBtn: '运行中',
  interrupt: '中断',
  interruptSent: '已发送中断请求',
  idle: '空闲',
  queued: '排队中',
  running: '运行中',
  done: '完成',
  failed: '失败',
  queuePosition: '队列 #',
  elapsed: '耗时',
  runFailed: '运行失败',
  interruptFailed: '中断请求失败',
  progressTimeout: '进度轮询超时，请检查 ComfyUI',
  noOutputs: '这次运行没有输出文件',

  results: '结果',
  resultsHint: '点击查看大图',
  download: '下载',
  openNewTab: '新标签打开',
  preview: '预览',
  outputText: '文本输出',
  outputFile: '文件输出',
  output3dHint: '3D 文件：下载后查看',
  outputLoading: '正在读取…',
  outputLoadFailed: '读取输出失败',
  closePreview: '关闭预览',

  canvasHint: '滚轮缩放 · 左键框选 · 中键/空格拖拽平移 · 右键菜单 · 双击节点参数 · F 适应',
  zoomIn: '放大',
  zoomOut: '缩小',
  fitView: '适应画布',
  resetView: '回到 100%',

  nodeMissing: '类型缺失',
  nodeMuted: '静音',
  nodeBypassed: '绕过',
  nodeOverride: '{n} 项已改',
  requestFailed: '请求失败',
  error: '出错了',
}

const EN = {
  title: 'ComfyUI',
  guideDesc: 'Local ComfyUI workflow canvas: browse, tweak and run',
  loading: 'Reading ComfyUI…',
  loadingWorkflow: 'Reading workflow…',
  loadingWorkflows: 'Reading workflow list…',
  retry: 'Retry',
  dismiss: 'Dismiss',
  refresh: 'Refresh',
  online: 'online',
  offline: 'offline',
  busy: 'running',
  statusUnknown: 'unknown',
  version: 'version',

  selectWorkflow: 'Select workflow',
  changeWorkflow: 'Change workflow',
  searchPlaceholder: 'Search workflows (name / path)…',
  noMatch: 'No matching workflow',
  sourceUser: 'Local',
  sourceWorkspace: 'Workspace',
  sourceTemplates: 'Templates',
  sourceOther: 'Other',
  workflowsTotal: '{n} workflows',
  moreItems: '{n} more — type to search',
  kindUi: 'UI',
  kindApi: 'API',
  pickerEmpty: 'No workflows found',
  pickerEmptyHint: 'Make sure .json workflows exist under user/workflows or the workspace workflow folder',
  loadWorkflowsFailed: 'Failed to load workflow list',

  params: 'Params',
  paramsTitle: 'Parameters',
  paramsOverrides: '{n} changed',
  paramsReset: 'Reset',
  paramsEmpty: 'This workflow has no editable parameters',
  paramsEmptyHint: '(Nodes have only linked inputs, or ComfyUI is offline)',
  paramsMissingType: 'Node type missing — parameters unavailable',
  paramsMuted: 'muted',
  resetOverrides: 'Reset all parameters',
  editedBadge: 'changed',
  clickNodeHint: 'Double-click a canvas node to jump to its parameters',
  headHint: 'Click title for parameters',
  ctxFit: 'Fit view',
  ctxZoom100: 'Zoom to 100%',
  ctxDeselect: 'Clear selection',
  ctxParams: 'Parameters panel',
  ctxRefresh: 'Reload workflow',
  ctxRun: 'Run',
  ctxPicker: 'Select workflow…',
  ctxOpenParams: 'Open parameters',
  ctxCenter: 'Center on canvas',
  ctxCopyType: 'Copy node type',
  ctxCopyTitle: 'Copy node title',
  ctxPreview: 'Preview',
  ctxDownload: 'Download',
  ctxOpenTab: 'Open in new tab',
  ctxRemoveCard: 'Remove from canvas',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  boxSelectHint: 'Box selecting',

  offlineTitle: 'ComfyUI is not running',
  offlineHint: 'Start ComfyUI on this machine with the button below (about 10-30 s)',
  startComfy: 'Start ComfyUI',
  startingComfy: 'Starting…',
  startRequested: 'Start requested, waiting for ComfyUI…',
  startFailed: 'Failed to start',
  statusFailed: 'Failed to read ComfyUI status',
  hostUnavailable: 'GET /api/dsh-comfy/status failed — the host half may not be loaded yet',

  emptyTitle: 'No workflow selected',
  emptyHint: 'Pick a local / workspace / template workflow above to inspect and run it on the canvas',
  pickWorkflow: 'Select workflow',
  graphEmpty: 'This workflow has no displayable nodes',
  graphEmptyHint: 'The file may be empty or in an unsupported format',

  nodes: 'nodes',
  edges: 'links',
  missingTypes: 'missing types',
  mutedNodes: 'muted/bypassed',
  noWorkflowSelected: 'No workflow selected',
  workflowWarnings: 'Workflow warnings',

  run: 'Run',
  runningBtn: 'Running',
  interrupt: 'Interrupt',
  interruptSent: 'Interrupt requested',
  idle: 'Idle',
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  queuePosition: 'queue #',
  elapsed: 'elapsed',
  runFailed: 'Run failed',
  interruptFailed: 'Interrupt request failed',
  progressTimeout: 'Progress polling timed out — check ComfyUI',
  noOutputs: 'This run produced no output files',

  results: 'Results',
  resultsHint: 'Click to preview',
  download: 'Download',
  openNewTab: 'Open in new tab',
  preview: 'Preview',
  outputText: 'Text output',
  outputFile: 'File output',
  output3dHint: '3D file — download to view',
  outputLoading: 'Loading…',
  outputLoadFailed: 'Failed to read output',
  closePreview: 'Close preview',

  canvasHint: 'Wheel zoom · drag left to box-select · middle/space drag to pan · right-click menu · double-click node for params · F to fit',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fitView: 'Fit view',
  resetView: 'Reset to 100%',

  nodeMissing: 'missing type',
  nodeMuted: 'muted',
  nodeBypassed: 'bypassed',
  nodeOverride: '{n} changed',
  requestFailed: 'Request failed',
  error: 'Something went wrong',
}

/* ------------------------------------------------------------------ */
/* locale：跟随宿主语言（zh 默认，en 完整）                             */
/* ------------------------------------------------------------------ */

const DICTIONARIES = { zh: ZH, en: EN }
let language = 'zh'
let languageVersion = 0
const languageListeners = new Set()

/** 词典插值：t('x', {n: 3}) 替换 {n}。 */
function t(key, values) {
  const dictionary = DICTIONARIES[language] || ZH
  const raw = dictionary[key]
  const text = raw === undefined ? (ZH[key] === undefined ? String(key) : ZH[key]) : raw
  if (values === null || values === undefined) return text
  return text.replace(/\{(\w+)\}/g, (match, name) => (values[name] === undefined ? match : String(values[name])))
}

function applyLocaleId(id) {
  const text = String(id === null || id === undefined ? '' : id).toLowerCase()
  const next = text.startsWith('en') ? 'en' : 'zh'
  if (next === language) return
  language = next
  languageVersion += 1
  for (const listener of [...languageListeners]) {
    try {
      listener()
    } catch (error) {
      /* 单个订阅者出错不影响其它订阅者 */
    }
  }
}

function subscribeLanguage(listener) {
  languageListeners.add(listener)
  return () => {
    languageListeners.delete(listener)
  }
}

/** 组件里订阅语言变化（SSR 用 getServerSnapshot 兜底）。 */
function useLanguage() {
  return React.useSyncExternalStore(subscribeLanguage, () => languageVersion, () => 0)
}

/** 从宿主 locale 服务读当前语言 id（兼容 string / {active|id|locale} 形状）。 */
function localeIdOf(locale) {
  try {
    if (locale === null || locale === undefined) return ''
    const value = typeof locale.getLocale === 'function' ? locale.getLocale() : undefined
    if (typeof value === 'string') return value
    if (value !== null && value !== undefined && typeof value === 'object') {
      const active = value.active
      if (typeof active === 'string') return active
      if (active !== null && active !== undefined && typeof active === 'object') {
        return String(active.id || active.locale || active.name || '')
      }
      return String(value.id || value.locale || '')
    }
  } catch (error) {
    /* 宿主实现差异：拿不到就当默认语言 */
  }
  return ''
}

/* ------------------------------------------------------------------ */
/* 样式：全部挂在面板内的 <style data-dsh-comfy> 里，类名 .dsh-comfy-*  */
/* ------------------------------------------------------------------ */

/** 浅色兜底（DSH 令牌存在时优先用令牌）。 */
const LIGHT_VARS = [
  '--cmf-bg:var(--dsw-alias-bg-base,#f6f7f9);--cmf-bg-1:var(--dsw-alias-bg-layer-1,#ffffff)',
  ';--cmf-bg-2:var(--dsw-alias-bg-layer-2,#f0f1f4);--cmf-overlay:var(--dsw-alias-bg-overlay,rgba(255,255,255,.96))',
  ';--cmf-border:var(--dsw-alias-border-l1,rgba(16,24,40,.10));--cmf-border-2:var(--dsw-alias-border-l2,rgba(16,24,40,.18))',
  ';--cmf-text:var(--dsw-alias-label-primary,#1b1d22);--cmf-dim:var(--dsw-alias-label-secondary,#6a6f7a)',
  ';--cmf-accent:var(--dsw-alias-brand-primary,#2f6feb);--cmf-on-accent:#ffffff',
  ';--cmf-error:var(--dsw-alias-state-error-primary,#d63a3f);--cmf-ok:var(--dsw-alias-state-success-primary,#1c8a5c)',
  ';--cmf-warn:var(--dsw-alias-state-warn-primary,#b26a00);--cmf-idle:var(--dsw-alias-state-idle-primary,#9aa0a6)',
  ';--cmf-hairline:rgba(16,24,40,.06);--cmf-hover:rgba(16,24,40,.055);--cmf-shadow:rgba(16,24,40,.16)',
  ';--cmf-grid:rgba(16,24,40,.075);--cmf-edge:rgba(70,84,110,.42);--cmf-edge-strong:#7a8290',
  ';--cmf-group-bg:rgba(16,24,40,.025);--cmf-scroll:rgba(16,24,40,.18)',
  ';--cmf-tint:rgba(47,111,235,.10);--cmf-tint-border:rgba(47,111,235,.35)',
  ';--cmf-error-bg:rgba(214,58,63,.09);--cmf-warn-bg:rgba(178,106,0,.10)',
  ';--cmf-cat-0:#d97706;--cmf-cat-1:#2563eb;--cmf-cat-2:#059669;--cmf-cat-3:#7c3aed',
  ';--cmf-cat-4:#db2777;--cmf-cat-5:#0891b2;--cmf-cat-6:#65a30d;--cmf-cat-7:#ea580c',
  ';--cmf-cat-0-bg:rgba(217,119,6,.13);--cmf-cat-1-bg:rgba(37,99,235,.12);--cmf-cat-2-bg:rgba(5,150,105,.12)',
  ';--cmf-cat-3-bg:rgba(124,58,237,.12);--cmf-cat-4-bg:rgba(219,39,119,.12);--cmf-cat-5-bg:rgba(8,145,178,.12)',
  ';--cmf-cat-6-bg:rgba(101,163,13,.13);--cmf-cat-7-bg:rgba(234,88,12,.12)',
].join('')

/** 深色兜底（同一个令牌名，只是兜底色换成深色）。 */
const DARK_VARS = [
  '--cmf-bg:var(--dsw-alias-bg-base,#141518);--cmf-bg-1:var(--dsw-alias-bg-layer-1,#1b1c20)',
  ';--cmf-bg-2:var(--dsw-alias-bg-layer-2,#232428);--cmf-overlay:var(--dsw-alias-bg-overlay,rgba(27,28,32,.96))',
  ';--cmf-border:var(--dsw-alias-border-l1,rgba(255,255,255,.10));--cmf-border-2:var(--dsw-alias-border-l2,rgba(255,255,255,.18))',
  ';--cmf-text:var(--dsw-alias-label-primary,#e7e8ea);--cmf-dim:var(--dsw-alias-label-secondary,#9aa0aa)',
  ';--cmf-accent:var(--dsw-alias-brand-primary,#4f8ef7);--cmf-on-accent:#151517',
  ';--cmf-error:var(--dsw-alias-state-error-primary,#f2555a);--cmf-ok:var(--dsw-alias-state-success-primary,#3ecf8e)',
  ';--cmf-warn:var(--dsw-alias-state-warn-primary,#ffb020);--cmf-idle:var(--dsw-alias-state-idle-primary,#7d838c)',
  ';--cmf-hairline:rgba(255,255,255,.06);--cmf-hover:rgba(255,255,255,.075);--cmf-shadow:rgba(0,0,0,.45)',
  ';--cmf-grid:rgba(255,255,255,.055);--cmf-edge:rgba(170,185,215,.42);--cmf-edge-strong:#8a93a3',
  ';--cmf-group-bg:rgba(255,255,255,.025);--cmf-scroll:rgba(255,255,255,.18)',
  ';--cmf-tint:rgba(79,142,247,.16);--cmf-tint-border:rgba(79,142,247,.45)',
  ';--cmf-error-bg:rgba(242,85,90,.14);--cmf-warn-bg:rgba(255,176,32,.14)',
  ';--cmf-cat-0:#fbbf24;--cmf-cat-1:#60a5fa;--cmf-cat-2:#34d399;--cmf-cat-3:#a78bfa',
  ';--cmf-cat-4:#f472b6;--cmf-cat-5:#22d3ee;--cmf-cat-6:#a3e635;--cmf-cat-7:#fb923c',
  ';--cmf-cat-0-bg:rgba(251,191,36,.14);--cmf-cat-1-bg:rgba(96,165,250,.14);--cmf-cat-2-bg:rgba(52,211,153,.13)',
  ';--cmf-cat-3-bg:rgba(167,139,250,.15);--cmf-cat-4-bg:rgba(244,114,182,.14);--cmf-cat-5-bg:rgba(34,211,238,.13)',
  ';--cmf-cat-6-bg:rgba(163,230,53,.13);--cmf-cat-7-bg:rgba(251,146,60,.14)',
].join('')

const THEME_VARS = [
  '.dsh-comfy-root{' + LIGHT_VARS + '}',
  '@media (prefers-color-scheme: dark){.dsh-comfy-root{' + DARK_VARS + '}}',
  '.dsh-comfy-root[data-cmf-theme="light"]{' + LIGHT_VARS + '}',
  '.dsh-comfy-root[data-cmf-theme="dark"]{' + DARK_VARS + '}',
].join('\n')

const CSS = [
  THEME_VARS,

  /* 根布局 */
  '.dsh-comfy-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;',
  'background:var(--cmf-bg);color:var(--cmf-text);font:12.5px/1.45 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
  'user-select:none;-webkit-user-select:none;outline:none}',
  '.dsh-comfy-root *{box-sizing:border-box}',
  '.dsh-comfy-root ::-webkit-scrollbar{width:8px;height:8px}',
  '.dsh-comfy-root ::-webkit-scrollbar-thumb{background:var(--cmf-scroll);border-radius:4px;border:2px solid transparent;background-clip:content-box}',
  '.dsh-comfy-root ::-webkit-scrollbar-track{background:transparent}',
  '.dsh-comfy-spacer{flex:1 1 auto;min-width:0}',
  '.dsh-comfy-dim{color:var(--cmf-dim)}',
  '.dsh-comfy-mono{font-family:ui-monospace,Consolas,monospace}',
  '.dsh-comfy-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',

  /* 通用按钮 */
  '.dsh-comfy-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 11px;',
  'border:1px solid var(--cmf-border-2);border-radius:7px;background:var(--cmf-bg-1);color:var(--cmf-text);',
  'font:inherit;font-size:12px;cursor:default;white-space:nowrap;text-decoration:none}',
  '.dsh-comfy-btn:hover{background:var(--cmf-hover)}',
  '.dsh-comfy-btn:active{transform:translateY(.5px)}',
  '.dsh-comfy-btn:disabled{opacity:.42;cursor:default;transform:none}',
  '.dsh-comfy-btn[data-primary="1"]{background:var(--cmf-accent);border-color:var(--cmf-accent);color:var(--cmf-on-accent)}',
  '.dsh-comfy-btn[data-primary="1"]:hover{filter:brightness(1.07);background:var(--cmf-accent)}',
  '.dsh-comfy-btn[data-danger="1"]{color:var(--cmf-error);border-color:var(--cmf-error-bg)}',
  '.dsh-comfy-btn[data-danger="1"]:hover{background:var(--cmf-error-bg)}',
  '.dsh-comfy-btn[data-ghost="1"]{background:transparent;border-color:transparent}',
  '.dsh-comfy-btn[data-ghost="1"]:hover{background:var(--cmf-hover)}',
  '.dsh-comfy-btn svg{flex:none}',
  '.dsh-comfy-ibtn{flex:none;position:relative;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;',
  'border:1px solid transparent;border-radius:7px;background:transparent;color:var(--cmf-text);font:inherit;cursor:default}',
  '.dsh-comfy-ibtn:hover{background:var(--cmf-hover)}',
  '.dsh-comfy-ibtn:disabled{opacity:.38;cursor:default}',
  '.dsh-comfy-ibtn[data-on="1"]{background:var(--cmf-tint);border-color:var(--cmf-tint-border);color:var(--cmf-accent)}',
  '.dsh-comfy-ibtn svg{flex:none}',
  '.dsh-comfy-ibtn-badge{position:absolute;top:-2px;right:-2px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;',
  'background:var(--cmf-accent);color:var(--cmf-on-accent);font-size:9.5px;line-height:14px;text-align:center}',
  '.dsh-comfy-kbd{font:10px ui-monospace,Consolas,monospace;padding:0 4px;border:1px solid var(--cmf-border);border-radius:4px;color:var(--cmf-dim)}',

  /* 顶栏 */
  '.dsh-comfy-head{flex:none;display:flex;align-items:center;gap:6px;height:40px;padding:0 8px;',
  'border-bottom:1px solid var(--cmf-border);background:var(--cmf-bg-1);z-index:5}',
  '.dsh-comfy-brand{flex:none;display:inline-flex;align-items:center;gap:5px;font-weight:600;font-size:12.5px;color:var(--cmf-text)}',
  '.dsh-comfy-brand svg{color:var(--cmf-accent)}',
  '.dsh-comfy-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--cmf-idle)}',
  '.dsh-comfy-dot[data-ok="1"]{background:var(--cmf-ok)}',
  '.dsh-comfy-dot[data-tone="warn"]{background:var(--cmf-warn)}',
  '.dsh-comfy-dot[data-tone="error"]{background:var(--cmf-error)}',
  '.dsh-comfy-dot[data-tone="accent"]{background:var(--cmf-accent)}',
  '.dsh-comfy-dot[data-busy="1"]{background:var(--cmf-accent);animation:dsh-comfy-pulse 1.2s ease-in-out infinite}',
  '.dsh-comfy-pick{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:6px;height:26px;padding:0 5px 0 8px;',
  'border:1px solid var(--cmf-border);border-radius:7px;background:var(--cmf-bg-2);color:var(--cmf-text);font:inherit;cursor:default;text-align:left}',
  '.dsh-comfy-pick:hover{border-color:var(--cmf-border-2)}',
  '.dsh-comfy-pick:disabled{opacity:.5;cursor:default}',
  '.dsh-comfy-pick[data-open="1"]{border-color:var(--cmf-accent);background:var(--cmf-tint)}',
  '.dsh-comfy-pick-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px}',
  '.dsh-comfy-pick-name[data-empty="1"]{color:var(--cmf-dim)}',
  '.dsh-comfy-pick-meta{flex:none;font-size:10px;color:var(--cmf-dim)}',
  '.dsh-comfy-pick svg{flex:none;color:var(--cmf-dim)}',
  '.dsh-comfy-badge{display:inline-flex;align-items:center;flex:none;height:16px;padding:0 5px;border-radius:5px;',
  'background:var(--cmf-bg-2);border:1px solid var(--cmf-border);color:var(--cmf-dim);font:9.5px/14px ui-monospace,Consolas,monospace}',
  '.dsh-comfy-badge[data-tone="warn"]{background:var(--cmf-warn-bg);border-color:transparent;color:var(--cmf-warn)}',
  '.dsh-comfy-badge[data-tone="error"]{background:var(--cmf-error-bg);border-color:transparent;color:var(--cmf-error)}',
  '.dsh-comfy-badge[data-tone="accent"]{background:var(--cmf-tint);border-color:transparent;color:var(--cmf-accent)}',

  /* 内联错误/警告条 */
  '.dsh-comfy-banner{flex:none;display:flex;align-items:flex-start;gap:6px;padding:6px 8px;border-bottom:1px solid var(--cmf-border);',
  'background:var(--cmf-bg-1);color:var(--cmf-text);font-size:11.5px;line-height:1.45}',
  '.dsh-comfy-banner[data-kind="error"]{background:var(--cmf-error-bg);color:var(--cmf-error)}',
  '.dsh-comfy-banner[data-kind="warn"]{background:var(--cmf-warn-bg);color:var(--cmf-warn)}',
  '.dsh-comfy-banner-icon{flex:none;margin-top:1px}',
  '.dsh-comfy-banner-text{flex:1 1 auto;min-width:0;max-height:64px;overflow:auto;white-space:pre-wrap;word-break:break-word;user-select:text}',
  '.dsh-comfy-banner-actions{flex:none;display:flex;gap:4px;align-items:center}',
  '.dsh-comfy-banner .dsh-comfy-ibtn{width:20px;height:20px;color:inherit}',

  /* 主体 + 画布 */
  '.dsh-comfy-body{position:relative;flex:1 1 auto;min-height:0;display:flex;flex-direction:column}',
  '.dsh-comfy-stage{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;touch-action:none;cursor:default;',
  'background-color:var(--cmf-bg);background-image:radial-gradient(var(--cmf-grid) 1px,transparent 1px);background-size:22px 22px}',
  '.dsh-comfy-stage[data-panning="1"]{cursor:grabbing}',
  '.dsh-comfy-stage[data-space="1"]{cursor:grab}',
  '.dsh-comfy-stage[data-boxing="1"]{cursor:crosshair}',
  // 左键框选遮罩（stage 局部坐标，pointer-events:none 不挡命中）
  '.dsh-comfy-marquee{position:absolute;z-index:8;pointer-events:none;border:1px solid var(--cmf-accent);border-radius:3px;',
  'background:var(--cmf-tint);box-shadow:0 0 0 1px var(--cmf-tint-border) inset}',
  // 右键上下文菜单：fixed 跟随视口（面板在右侧栏里，client 坐标即可），主题变量着色
  '.dsh-comfy-ctx{position:fixed;z-index:50;min-width:196px;padding:' + CONTEXT_MENU_PAD + 'px;',
  'border:1px solid var(--cmf-border-2);border-radius:10px;background:var(--cmf-overlay);',
  'box-shadow:0 10px 30px var(--cmf-shadow);color:var(--cmf-text);font:inherit}',
  '.dsh-comfy-ctx-item{display:flex;align-items:center;gap:8px;width:100%;height:' + CONTEXT_MENU_ITEM_H + 'px;padding:0 8px;',
  'border:none;border-radius:7px;background:transparent;color:var(--cmf-text);font:inherit;font-size:12px;cursor:default;',
  'text-align:left;white-space:nowrap}',
  '.dsh-comfy-ctx-item:hover{background:var(--cmf-hover)}',
  '.dsh-comfy-ctx-item:disabled{opacity:.4;cursor:default}',
  '.dsh-comfy-ctx-item:disabled:hover{background:transparent}',
  '.dsh-comfy-ctx-item svg{flex:none;color:var(--cmf-dim)}',
  '.dsh-comfy-ctx-item[data-tone="danger"]{color:var(--cmf-error)}',
  '.dsh-comfy-ctx-item[data-tone="danger"] svg{color:var(--cmf-error)}',
  '.dsh-comfy-ctx-sep{height:1px;margin:4px 2px;background:var(--cmf-hairline)}',
  // 轻量 toast（复制反馈等）
  '.dsh-comfy-toast{position:absolute;left:50%;bottom:52px;transform:translateX(-50%);z-index:60;pointer-events:none;',
  'padding:5px 12px;border:1px solid var(--cmf-border);border-radius:999px;background:var(--cmf-overlay);',
  'color:var(--cmf-text);box-shadow:0 6px 20px var(--cmf-shadow);font-size:11.5px;white-space:nowrap}',
  '.dsh-comfy-world{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}',
  '.dsh-comfy-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}',
  '.dsh-comfy-edge{fill:none;stroke:var(--cmf-edge);stroke-width:1.4;stroke-linecap:round}',
  '.dsh-comfy-edge[data-accent="1"]{stroke:var(--cmf-accent);stroke-width:1.9}',
  '.dsh-comfy-edge[data-muted="1"]{stroke-dasharray:4 3;opacity:.62}',
  '.dsh-comfy-edge-dot{fill:var(--cmf-edge-strong)}',
  '.dsh-comfy-edge-dot[data-accent="1"]{fill:var(--cmf-accent)}',

  /* 分组框 */
  '.dsh-comfy-group{position:absolute;border:1px dashed var(--cmf-border-2);border-radius:10px;background:var(--cmf-group-bg);pointer-events:none}',
  '.dsh-comfy-group-head{position:absolute;left:10px;top:-9px;display:inline-flex;align-items:center;gap:5px;max-width:78%;',
  'padding:1px 8px;border-radius:999px;border:1px solid var(--cmf-border);background:var(--cmf-bg-1);color:var(--cmf-dim);',
  'font-size:10.5px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-comfy-group-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--cmf-group-accent,var(--cmf-accent))}',

  /* 节点卡片 */
  '.dsh-comfy-node{position:absolute;display:flex;flex-direction:column;overflow:hidden;border-radius:8px;',
  'border:1px solid var(--cmf-border);border-top:2px solid var(--cmf-node-accent,var(--cmf-accent));background:var(--cmf-bg-1);',
  'box-shadow:0 3px 10px var(--cmf-shadow);cursor:move}',
  '.dsh-comfy-node[data-sel="1"]{border-color:var(--cmf-accent);box-shadow:0 0 0 1px var(--cmf-accent),0 6px 18px var(--cmf-shadow);z-index:3}',
  '.dsh-comfy-node[data-dim="1"]{opacity:.5}',
  '.dsh-comfy-node[data-missing="1"]{border-style:dashed;border-color:var(--cmf-error)}',
  '.dsh-comfy-node-head{flex:none;display:flex;align-items:center;gap:5px;height:' + NODE_HEADER_H + 'px;padding:0 6px;',
  'background:var(--cmf-node-tint,var(--cmf-bg-2));border-bottom:1px solid var(--cmf-hairline)}',
  '.dsh-comfy-node[data-lod="1"] .dsh-comfy-node-widgets{display:flex;gap:3px;padding-top:4px}',
  '.dsh-comfy-node[data-lod="1"] .dsh-comfy-node-type{display:none}',
  // 低倍总览（45% 左右）时文字已不可读：widget 行改成骨架条，保留“这是一张有参数的节点”的形状感
  '.dsh-comfy-node[data-lod="1"] .dsh-comfy-wchip{display:block;height:4px;margin:0;border-radius:2px;background:var(--cmf-border);opacity:.7;overflow:hidden}',
  '.dsh-comfy-node[data-lod="1"] .dsh-comfy-wchip-k,.dsh-comfy-node[data-lod="1"] .dsh-comfy-wchip-v{display:none}',
  '.dsh-comfy-node-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--cmf-node-accent,var(--cmf-accent))}',
  '.dsh-comfy-node-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:600;color:var(--cmf-text)}',
  '.dsh-comfy-node-badge{flex:none;font-size:9px;line-height:13px;padding:0 4px;border-radius:4px;background:var(--cmf-warn-bg);color:var(--cmf-warn)}',
  '.dsh-comfy-node-badge[data-kind="error"]{background:var(--cmf-error-bg);color:var(--cmf-error)}',
  '.dsh-comfy-node-badge[data-kind="accent"]{background:var(--cmf-tint);color:var(--cmf-accent)}',
  '.dsh-comfy-node-type{flex:none;padding:1px 7px 0;font:10px/1.35 ui-monospace,Consolas,monospace;color:var(--cmf-dim);',
  'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-comfy-node-widgets{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:1px;padding:2px 7px 4px;overflow:hidden}',
  '.dsh-comfy-wchip{display:flex;align-items:center;gap:5px;min-width:0;font-size:9.5px;line-height:14px}',
  '.dsh-comfy-wchip-k{flex:none;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--cmf-dim)}',
  '.dsh-comfy-wchip-v{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
  'color:var(--cmf-text);font-family:ui-monospace,Consolas,monospace}',
  '.dsh-comfy-port{position:absolute;width:7px;height:7px;border-radius:50%;background:var(--cmf-bg-1);',
  'border:1.5px solid var(--cmf-edge-strong);transform:translate(-50%,-50%);pointer-events:none}',
  '.dsh-comfy-port[data-side="out"]{background:var(--cmf-node-accent,var(--cmf-accent));border-color:var(--cmf-node-accent,var(--cmf-accent))}',

  /* 结果卡片（画布上） */
  '.dsh-comfy-rcard{position:absolute;display:flex;flex-direction:column;overflow:hidden;border-radius:8px;cursor:pointer;',
  'border:1px solid var(--cmf-tint-border);background:var(--cmf-bg-1);box-shadow:0 4px 14px var(--cmf-shadow)}',
  '.dsh-comfy-rcard:hover{border-color:var(--cmf-accent)}',
  '.dsh-comfy-rcard-head{flex:none;display:flex;align-items:center;gap:4px;height:19px;padding:0 5px;font-size:9.5px;',
  'color:var(--cmf-dim);border-bottom:1px solid var(--cmf-hairline)}',
  '.dsh-comfy-rcard-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-comfy-rcard-media{flex:1 1 auto;min-height:0;background:var(--cmf-bg-2);display:flex;align-items:center;justify-content:center;color:var(--cmf-dim);overflow:hidden}',
  '.dsh-comfy-rcard-media img{display:block;width:100%;height:100%;object-fit:cover}',
  '.dsh-comfy-rcard-media svg{opacity:.7}',

  /* 缩放工具条 */
  '.dsh-comfy-zoom{position:absolute;right:8px;bottom:8px;z-index:6;display:flex;align-items:center;gap:2px;padding:3px;',
  'border:1px solid var(--cmf-border);border-radius:9px;background:var(--cmf-overlay);box-shadow:0 3px 12px var(--cmf-shadow)}',
  '.dsh-comfy-zoom .dsh-comfy-ibtn{width:24px;height:24px}',
  '.dsh-comfy-zoom-pct{min-width:44px;height:24px;padding:0 3px;border:none;border-radius:6px;background:transparent;',
  'color:var(--cmf-dim);font:10.5px/1 ui-monospace,Consolas,monospace;cursor:default}',
  '.dsh-comfy-zoom-pct:hover{background:var(--cmf-hover);color:var(--cmf-text)}',

  /* 居中的空态 / 错误态 / 加载态 */
  '.dsh-comfy-center{position:absolute;inset:0;z-index:4;display:flex;flex-direction:column;align-items:center;justify-content:center;',
  'gap:8px;padding:24px;text-align:center;color:var(--cmf-dim);background:var(--cmf-bg);overflow:auto}',
  '.dsh-comfy-center[data-kind="overlay"]{background:transparent;pointer-events:none}',
  '.dsh-comfy-center[data-kind="overlay"] .dsh-comfy-btn{pointer-events:auto}',
  '.dsh-comfy-state-icon{display:flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:12px;',
  'background:var(--cmf-bg-2);color:var(--cmf-accent);flex:none}',
  '.dsh-comfy-state-icon[data-tone="warn"]{color:var(--cmf-warn);background:var(--cmf-warn-bg)}',
  '.dsh-comfy-state-icon[data-tone="error"]{color:var(--cmf-error);background:var(--cmf-error-bg)}',
  '.dsh-comfy-state-title{font-size:13px;font-weight:600;color:var(--cmf-text);line-height:1.4}',
  '.dsh-comfy-state-hint{font-size:11.5px;line-height:1.6;max-width:340px;color:var(--cmf-dim)}',
  '.dsh-comfy-state-hint[data-tone="error"]{color:var(--cmf-error);user-select:text;word-break:break-word;max-height:120px;overflow:auto}',
  '.dsh-comfy-state-actions{display:flex;align-items:center;gap:6px;margin-top:4px}',
  '.dsh-comfy-spin{display:inline-block;width:14px;height:14px;border-radius:50%;border:2px solid var(--cmf-border-2);',
  'border-top-color:var(--cmf-accent);animation:dsh-comfy-spin .8s linear infinite}',
  '.dsh-comfy-hintline{position:absolute;left:8px;bottom:8px;z-index:5;max-width:62%;padding:3px 8px;border-radius:8px;',
  'border:1px solid var(--cmf-hairline);background:var(--cmf-overlay);color:var(--cmf-dim);font-size:9.5px;line-height:1.35;',
  'overflow:hidden;white-space:normal;pointer-events:none}',

  /* 工作流选择浮层 */
  '.dsh-comfy-popmask{position:absolute;inset:0;z-index:18}',
  '.dsh-comfy-pop{position:absolute;left:8px;right:8px;top:44px;z-index:19;display:flex;flex-direction:column;',
  'max-height:min(74%,640px);border:1px solid var(--cmf-border-2);border-radius:10px;background:var(--cmf-overlay);',
  'box-shadow:0 12px 34px var(--cmf-shadow);overflow:hidden}',
  '.dsh-comfy-pop-search{flex:none;display:flex;align-items:center;gap:6px;padding:7px 8px;border-bottom:1px solid var(--cmf-border)}',
  '.dsh-comfy-input{flex:1 1 auto;min-width:0;height:26px;padding:0 8px;border:1px solid var(--cmf-border);border-radius:6px;',
  'background:var(--cmf-bg);color:var(--cmf-text);font:inherit;font-size:12px;outline:none}',
  '.dsh-comfy-input:focus{border-color:var(--cmf-accent);box-shadow:0 0 0 2px var(--cmf-tint)}',
  '.dsh-comfy-input::placeholder{color:var(--cmf-dim)}',
  '.dsh-comfy-pop-list{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 6px 8px}',
  '.dsh-comfy-group-label{display:flex;align-items:center;gap:6px;padding:8px 4px 4px;font-size:10px;font-weight:600;',
  'letter-spacing:.05em;text-transform:uppercase;color:var(--cmf-dim)}',
  '.dsh-comfy-group-label .dsh-comfy-count{font-weight:400;letter-spacing:0;text-transform:none;color:var(--cmf-dim)}',
  '.dsh-comfy-wf{display:flex;align-items:center;gap:6px;width:100%;padding:4px 6px;border:none;border-radius:6px;',
  'background:transparent;color:var(--cmf-text);font:inherit;cursor:default;text-align:left}',
  '.dsh-comfy-wf:hover{background:var(--cmf-hover)}',
  '.dsh-comfy-wf[data-active="1"]{background:var(--cmf-tint);color:var(--cmf-accent)}',
  '.dsh-comfy-wf[data-disabled="1"]{opacity:.45}',
  '.dsh-comfy-wf-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}',
  '.dsh-comfy-wf-path{flex:0 1 auto;max-width:44%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--cmf-dim)}',
  '.dsh-comfy-pop-foot{flex:none;display:flex;align-items:center;gap:6px;padding:5px 8px;border-top:1px solid var(--cmf-border);',
  'font-size:10.5px;color:var(--cmf-dim)}',
  '.dsh-comfy-pop-empty{padding:18px 12px;text-align:center;color:var(--cmf-dim);font-size:11.5px;line-height:1.6}',

  /* 结果条 */
  '.dsh-comfy-results{flex:none;border-top:1px solid var(--cmf-border);background:var(--cmf-bg-1)}',
  '.dsh-comfy-results-head{display:flex;align-items:center;gap:6px;padding:5px 8px 0;font-size:10.5px;color:var(--cmf-dim)}',
  '.dsh-comfy-results-row{display:flex;gap:8px;padding:5px 8px 8px;overflow-x:auto}',
  '.dsh-comfy-thumb{flex:none;display:flex;flex-direction:column;gap:3px;width:72px;padding:0;border:none;background:transparent;',
  'color:var(--cmf-text);font:inherit;cursor:default;text-align:left}',
  '.dsh-comfy-thumb-box{display:flex;align-items:center;justify-content:center;width:72px;height:54px;overflow:hidden;',
  'border:1px solid var(--cmf-border);border-radius:6px;background:var(--cmf-bg-2);color:var(--cmf-dim)}',
  '.dsh-comfy-thumb-box img{display:block;width:100%;height:100%;object-fit:cover}',
  '.dsh-comfy-thumb-label{max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9.5px;line-height:1.2;color:var(--cmf-dim)}',
  '.dsh-comfy-thumb:hover .dsh-comfy-thumb-box{border-color:var(--cmf-accent);color:var(--cmf-accent)}',

  /* 参数抽屉 */
  '.dsh-comfy-drawer{position:absolute;left:0;right:0;bottom:0;z-index:12;display:flex;flex-direction:column;max-height:66%;',
  'border-top:1px solid var(--cmf-border-2);border-radius:12px 12px 0 0;background:var(--cmf-overlay);box-shadow:0 -8px 26px var(--cmf-shadow)}',
  '.dsh-comfy-drawer-head{flex:none;display:flex;align-items:center;gap:6px;height:34px;padding:0 8px;border-bottom:1px solid var(--cmf-border)}',
  '.dsh-comfy-drawer-title{display:flex;align-items:center;gap:6px;font-weight:600;font-size:12px;white-space:nowrap}',
  '.dsh-comfy-drawer-sub{font-size:10.5px;color:var(--cmf-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-comfy-drawer-list{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 8px 12px}',
  '.dsh-comfy-drawer-empty{padding:20px 12px;text-align:center;color:var(--cmf-dim);font-size:11.5px;line-height:1.6}',
  '.dsh-comfy-pnode{margin-bottom:6px;overflow:hidden;border:1px solid var(--cmf-border);border-radius:8px;background:var(--cmf-bg-1)}',
  '.dsh-comfy-pnode[data-focus="1"]{border-color:var(--cmf-accent);box-shadow:0 0 0 1px var(--cmf-tint-border)}',
  '.dsh-comfy-pnode-head{display:flex;align-items:center;gap:6px;padding:5px 7px;background:var(--cmf-bg-2);border-bottom:1px solid var(--cmf-hairline)}',
  '.dsh-comfy-pnode-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--cmf-node-accent,var(--cmf-accent))}',
  '.dsh-comfy-pnode-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:600}',
  '.dsh-comfy-pnode-type{flex:0 1 auto;max-width:44%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:10px ui-monospace,Consolas,monospace;color:var(--cmf-dim)}',
  '.dsh-comfy-prow{display:flex;align-items:center;gap:8px;padding:4px 7px;border-top:none}',
  '.dsh-comfy-prow + .dsh-comfy-prow{border-top:1px solid var(--cmf-hairline)}',
  '.dsh-comfy-plabel{flex:0 0 40%;min-width:0;display:flex;align-items:center;gap:4px;font-size:11px;color:var(--cmf-dim);',
  'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-comfy-plabel[data-over="1"]{color:var(--cmf-accent)}',
  '.dsh-comfy-plabel-dot{flex:none;width:5px;height:5px;border-radius:50%;background:var(--cmf-accent)}',
  '.dsh-comfy-pctl{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:6px}',
  '.dsh-comfy-pinput{width:100%;min-width:0;height:24px;padding:0 6px;border:1px solid var(--cmf-border);border-radius:5px;',
  'background:var(--cmf-bg);color:var(--cmf-text);font:11px/22px ui-monospace,Consolas,monospace;outline:none}',
  '.dsh-comfy-pinput:focus{border-color:var(--cmf-accent)}',
  '.dsh-comfy-pinput[type="number"]{font-family:ui-monospace,Consolas,monospace}',
  'textarea.dsh-comfy-pinput{height:auto;min-height:44px;padding:4px 6px;line-height:1.45;resize:vertical;font-family:inherit}',
  'select.dsh-comfy-pinput{font-family:inherit;padding-right:2px}',
  '.dsh-comfy-pcheck{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--cmf-text);cursor:default}',
  '.dsh-comfy-pcheck input{width:14px;height:14px;margin:0;accent-color:var(--cmf-accent)}',
  '.dsh-comfy-pnote{padding:5px 7px;font-size:10.5px;color:var(--cmf-dim)}',
  '.dsh-comfy-pnote[data-tone="error"]{color:var(--cmf-error)}',

  /* 运行栏 */
  '.dsh-comfy-runbar{flex:none;display:flex;align-items:center;gap:6px;height:40px;padding:0 8px;',
  'border-top:1px solid var(--cmf-border);background:var(--cmf-bg-1)}',
  '.dsh-comfy-runbar .dsh-comfy-btn{height:28px}',
  '.dsh-comfy-state{display:flex;align-items:center;gap:5px;min-width:0;overflow:hidden;white-space:nowrap;font-size:11px;color:var(--cmf-dim)}',
  '.dsh-comfy-state b{font-weight:500;color:var(--cmf-text)}',
  '.dsh-comfy-state .dsh-comfy-dot{width:6px;height:6px}',

  /* 全屏预览 */
  '.dsh-comfy-overlay{position:absolute;inset:0;z-index:30;display:flex;padding:10px;background:var(--cmf-overlay)}',
  '.dsh-comfy-preview{display:flex;flex-direction:column;width:100%;max-height:100%;overflow:hidden;border-radius:10px;',
  'border:1px solid var(--cmf-border-2);background:var(--cmf-bg);box-shadow:0 12px 40px var(--cmf-shadow)}',
  '.dsh-comfy-preview-head{flex:none;display:flex;align-items:center;gap:6px;height:34px;padding:0 8px;',
  'border-bottom:1px solid var(--cmf-border);background:var(--cmf-bg-1)}',
  '.dsh-comfy-preview-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px}',
  '.dsh-comfy-preview-body{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;padding:8px;',
  'background:var(--cmf-bg-2);overflow:auto}',
  '.dsh-comfy-preview-body img{display:block;max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;user-select:none}',
  '.dsh-comfy-preview-body video{display:block;max-width:100%;max-height:100%;border-radius:4px;background:#000}',
  '.dsh-comfy-preview-body audio{width:100%}',
  '.dsh-comfy-preview-body pre{width:100%;height:100%;margin:0;padding:8px;overflow:auto;border-radius:6px;',
  'background:var(--cmf-bg-1);font:11px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word;user-select:text}',
  '.dsh-comfy-preview-foot{flex:none;display:flex;align-items:center;gap:6px;padding:6px 8px;border-top:1px solid var(--cmf-border);',
  'background:var(--cmf-bg-1);flex-wrap:wrap}',
  '.dsh-comfy-preview-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--cmf-dim);text-align:right}',
  '.dsh-comfy-filecard{display:flex;flex-direction:column;align-items:center;gap:8px;padding:24px;text-align:center;color:var(--cmf-dim);font-size:11.5px;line-height:1.6}',
  '.dsh-comfy-filecard svg{color:var(--cmf-accent)}',

  /* 动画 */
  '@keyframes dsh-comfy-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
  '@keyframes dsh-comfy-spin{to{transform:rotate(360deg)}}',
  '@media (prefers-reduced-motion: reduce){.dsh-comfy-dot[data-busy="1"]{animation:none}.dsh-comfy-spin{animation:none}}',
].join('\n')

/* ------------------------------------------------------------------ */
/* 图标                                                                */
/* ------------------------------------------------------------------ */

const ICON_PATHS = {
  graph: ['M3.2 5.4h5.2v3.8H3.2z', 'M13 3.4h5.2v3.8H13z', 'M13 12.6h5.2v3.8H13z', 'M8.4 7.3h2.2v1.1H8.4z', 'M10.6 7.3v7.2h2.4', 'M8.4 13.1h2.2v1.1H8.4z'],
  play: ['M7.3 4.4l10 5.6-10 5.6z'],
  stop: ['M6.6 6.6h10.8v10.8H6.6z'],
  refresh: ['M19.4 12a7.4 7.4 0 1 1-2.2-5.2', 'M19.9 4.6V9h-4.4'],
  sliders: ['M4 7h9.5', 'M17.7 7h2.3', 'M13.6 4.9v4.2', 'M4 17h3', 'M11.2 17h8.8', 'M9.1 14.9v4.2'],
  chevron: ['M6.5 9.2l5.5 5.5 5.5-5.5'],
  search: ['M10.6 4.2a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8z', 'M15.4 15.4L20 20'],
  close: ['M6.4 6.4l11.2 11.2', 'M17.6 6.4L6.4 17.6'],
  fit: ['M4 8.8V5.5A1.5 1.5 0 0 1 5.5 4h3.3', 'M20 8.8V5.5A1.5 1.5 0 0 0 18.5 4h-3.3', 'M4 15.2v3.3A1.5 1.5 0 0 0 5.5 20h3.3', 'M20 15.2v3.3a1.5 1.5 0 0 1-1.5 1.5h-3.3', 'M8.4 12h7.2'],
  plus: ['M12 5.2v13.6', 'M5.2 12h13.6'],
  minus: ['M5.2 12h13.6'],
  image: ['M4.4 5.4h15.2v13.2H4.4z', 'M4.4 15.2l4.6-4.6 3.4 3.4 2.6-2.6 4.6 4.6', 'M9.1 9.3a1.15 1.15 0 1 0 0-2.3 1.15 1.15 0 0 0 0 2.3z'],
  video: ['M4.4 6.4h10.8v11.2H4.4z', 'M15.2 10.2l4.4-2.2v8l-4.4-2.2'],
  music: ['M9.1 18.4V6.6l9-2v11.8', 'M9.1 18.4a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 0 1 4.4 0z', 'M18.1 16.4a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 0 1 4.4 0z'],
  cube: ['M12 3.2l8 4.5v8.6L12 20.8l-8-4.5V7.7z', 'M12 3.2v8.9', 'M12 12.1l8-4.4', 'M12 12.1L4 7.7'],
  file: ['M6.2 3.6h6.9l4.7 4.7v12.1H6.2z', 'M13.1 3.6v4.7h4.7'],
  text: ['M5 6.4h14', 'M5 12h14', 'M5 17.6h9'],
  download: ['M12 4.2v10.2', 'M8 10.7l4 4 4-4', 'M4.6 19.8h14.8'],
  external: ['M14.2 4.4h5.4V9.8', 'M19.2 4.4l-7.6 7.6', 'M18.2 14v5.2H4.8V6.2H10.2'],
  warn: ['M12 4.2l8.4 15.2H3.6z', 'M12 9.2v4.6', 'M12 16.4v.4'],
  offline: ['M7.4 18h8.4a4.3 4.3 0 0 0 1.3-8.4A6 6 0 0 0 6.2 10 4 4 0 0 0 7.4 18z', 'M4 4l16 16'],
  empty: ['M4.4 6.4h15.2v12.2H4.4z', 'M8 10.8h8', 'M8 14.4h5'],
  reset: ['M9.2 7.1H5.6V3.5', 'M5.8 7.3A7.4 7.4 0 1 1 6.1 16'],
  info: ['M12 3.7a8.3 8.3 0 1 0 0 16.6 8.3 8.3 0 0 0 0-16.6z', 'M12 11v5', 'M12 7.8v.4'],
}

/** 线性图标（24 网格；继承 currentColor）。 */
function Glyph(props) {
  const size = props.size === undefined || props.size === null ? 16 : props.size
  const paths = ICON_PATHS[props.name] || []
  return h(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: props.weight === undefined ? 1.6 : props.weight,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      style: { display: 'block', flex: 'none' },
    },
    paths.map((data, index) => h('path', { key: index, d: data })),
  )
}

/** 品牌图标（16 网格，guide 入口也用它）。 */
function ComfyGuideIcon(props) {
  const size = props !== null && props !== undefined && props.size !== undefined ? props.size : 16
  return h(
    'svg',
    {
      viewBox: '0 0 16 16',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      style: { display: 'block', flex: 'none' },
    },
    h('rect', { x: 1.4, y: 2.6, width: 5, height: 3.9, rx: 1 }),
    h('rect', { x: 1.4, y: 9.5, width: 5, height: 3.9, rx: 1 }),
    h('rect', { x: 9.6, y: 6, width: 5, height: 3.9, rx: 1 }),
    h('path', { d: 'M6.4 4.6h1.6v3.4M6.4 11.5h1.6V8M8 8h1.6' }),
  )
}

/* ------------------------------------------------------------------ */
/* 通用小部件                                                          */
/* ------------------------------------------------------------------ */

function IconButton(props) {
  return h(
    'button',
    {
      type: 'button',
      className: 'dsh-comfy-ibtn' + (props.className ? ' ' + props.className : ''),
      title: props.title,
      'aria-label': props.title,
      disabled: props.disabled === true,
      'data-on': props.on === true ? '1' : '0',
      'data-cmf': props.data,
      onPointerDown: (event) => event.stopPropagation(),
      onClick: (event) => {
        event.stopPropagation()
        if (typeof props.onClick === 'function') props.onClick(event)
      },
    },
    h(Glyph, { name: props.icon, size: props.size === undefined ? 15 : props.size }),
    props.badge === undefined || props.badge === null
      ? null
      : h('span', { className: 'dsh-comfy-ibtn-badge' }, String(props.badge)),
  )
}

function Spinner() {
  return h('span', { className: 'dsh-comfy-spin', 'aria-hidden': true })
}

/** 状态点：ok / busy / idle / warn / error。 */
function StatusDot(props) {
  return h('span', {
    className: 'dsh-comfy-dot',
    'data-ok': props.ok === true ? '1' : '0',
    'data-busy': props.busy === true ? '1' : '0',
    'data-tone': props.tone,
    title: props.title,
  })
}

/* ------------------------------------------------------------------ */
/* 工作流选择浮层                                                      */
/* ------------------------------------------------------------------ */

function WorkflowPicker(props) {
  const { workflows, loading, error, query, selectedId } = props
  const [localQuery, setLocalQuery] = useState('')
  const inputRef = useRef(null)
  const effectiveQuery = query === undefined ? localQuery : query
  const setQuery = typeof props.onQuery === 'function' ? props.onQuery : setLocalQuery
  const items = workflows && Array.isArray(workflows.items) ? workflows.items : []
  const sources = workflows && Array.isArray(workflows.sources) ? workflows.sources : []
  const groups = useMemo(
    () => groupWorkflows(filterWorkflows(items, effectiveQuery), sources, { user: t('sourceUser'), workspace: t('sourceWorkspace'), templates: t('sourceTemplates'), other: t('sourceOther') }),
    // t() 依赖 language，这里用 useLanguage 的版本号触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, sources, effectiveQuery, languageVersion],
  )
  const total = filterWorkflows(items, effectiveQuery).length
  const shown = Math.min(total, 400)
  const hidden = total - shown
  const empty = workflows !== null && workflows !== undefined && items.length === 0 && loading !== true && !error

  useEffect(() => {
    const input = inputRef.current
    if (input !== null && typeof input.focus === 'function') input.focus()
  }, [])

  let body
  if (workflows === null || workflows === undefined) {
    body = error
      ? h('div', { className: 'dsh-comfy-pop-empty' }, h('div', { style: { color: 'var(--cmf-error)' } }, error), h('button', { type: 'button', className: 'dsh-comfy-btn', style: { marginTop: 10 }, onClick: props.onRetry }, t('retry')))
      : h('div', { className: 'dsh-comfy-pop-empty' }, h(Spinner), h('div', { style: { marginTop: 8 } }, t('loadingWorkflows')))
  } else if (loading === true && items.length === 0) {
    body = h('div', { className: 'dsh-comfy-pop-empty' }, h(Spinner), h('div', { style: { marginTop: 8 } }, t('loadingWorkflows')))
  } else if (error) {
    body = h('div', { className: 'dsh-comfy-pop-empty' }, h('div', { style: { color: 'var(--cmf-error)' } }, error), h('button', { type: 'button', className: 'dsh-comfy-btn', style: { marginTop: 10 }, onClick: props.onRetry }, t('retry')))
  } else if (empty) {
    body = h(
      'div',
      { className: 'dsh-comfy-pop-empty' },
      h('div', null, t('pickerEmpty')),
      h('div', { className: 'dsh-comfy-dim', style: { marginTop: 6 } }, t('pickerEmptyHint')),
    )
  } else if (groups.length === 0 || total === 0) {
    body = h('div', { className: 'dsh-comfy-pop-empty' }, t('noMatch'))
  } else {
    const rows = []
    let budget = 400
    for (const group of groups) {
      if (group.items.length === 0) continue
      rows.push(
        h(
          'div',
          { key: 'g-' + group.id, className: 'dsh-comfy-group-label' },
          group.label,
          h('span', { className: 'dsh-comfy-count' }, String(group.items.length)),
        ),
      )
      for (const item of group.items) {
        if (budget <= 0) break
        budget -= 1
        rows.push(
          h(
            'button',
            {
              key: item.id,
              type: 'button',
              className: 'dsh-comfy-wf',
              'data-active': item.id === selectedId ? '1' : '0',
              'data-disabled': item.disabled === true ? '1' : '0',
              'data-cmf': 'workflow-item',
              'data-cmf-id': item.id,
              title: item.relPath || item.name,
              onClick: () => {
                if (item.disabled === true) return
                props.onPick(item)
              },
            },
            h(Glyph, { name: 'file', size: 13, weight: 1.3 }),
            h('span', { className: 'dsh-comfy-wf-name' }, String(item.name || item.relPath || item.id || '')),
            item.relPath && item.relPath !== item.name ? h('span', { className: 'dsh-comfy-wf-path' }, String(item.relPath)) : null,
            h('span', { className: 'dsh-comfy-badge' }, item.kind === 'api' ? t('kindApi') : t('kindUi')),
          ),
        )
      }
    }
    body = h('div', { className: 'dsh-comfy-pop-list' }, rows)
  }

  return h(
    React.Fragment,
    null,
    h('div', { className: 'dsh-comfy-popmask', 'data-cmf': 'picker-mask', onClick: props.onClose }),
    h(
      'div',
      { className: 'dsh-comfy-pop', 'data-cmf': 'picker', role: 'dialog', 'aria-label': t('selectWorkflow') },
      h(
        'div',
        { className: 'dsh-comfy-pop-search' },
        h(Glyph, { name: 'search', size: 14 }),
        h('input', {
          ref: inputRef,
          className: 'dsh-comfy-input',
          type: 'search',
          value: effectiveQuery,
          placeholder: t('searchPlaceholder'),
          'data-cmf': 'picker-search',
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              props.onClose()
            }
          },
        }),
        h(IconButton, { icon: 'close', title: t('dismiss'), size: 14, onClick: props.onClose }),
      ),
      body,
      h(
        'div',
        { className: 'dsh-comfy-pop-foot' },
        h('span', null, t('workflowsTotal', { n: total })),
        hidden > 0 ? h('span', { className: 'dsh-comfy-spacer' }) : null,
        hidden > 0 ? h('span', null, t('moreItems', { n: hidden })) : null,
        loading === true && items.length > 0 ? h('span', { className: 'dsh-comfy-spacer' }) : null,
        loading === true && items.length > 0 ? h(Spinner) : null,
      ),
    ),
  )
}

/* ------------------------------------------------------------------ */
/* 参数抽屉                                                            */
/* ------------------------------------------------------------------ */

function WidgetControl(props) {
  const { nodeId, widget, overrides, onChange } = props
  const value = overrideValueOf(overrides, nodeId, widget.name, widget.value)
  const overridden = overrideValueOf(overrides, nodeId, widget.name, undefined) !== undefined
  const commit = (next) => onChange(nodeId, widget.name, widget.kind, next)
  if (widget.kind === 'bool') {
    return h(
      'label',
      { className: 'dsh-comfy-pcheck' },
      h('input', {
        type: 'checkbox',
        checked: value === true || value === 'true',
        'data-cmf': 'param-input',
        'data-cmf-key': overrideKeyOf(nodeId, widget.name),
        onChange: (event) => commit(event.target.checked),
      }),
      h('span', null, value === true || value === 'true' ? 'true' : 'false'),
      overridden ? h('span', { className: 'dsh-comfy-badge', 'data-tone': 'accent' }, t('editedBadge')) : null,
    )
  }
  if (widget.kind === 'combo') {
    const options = Array.isArray(widget.options) ? widget.options : []
    if (options.length > 0) {
      const current = optionLabel(value)
      const hasCurrent = options.some((option) => optionLabel(option) === current)
      return h(
        React.Fragment,
        null,
        h(
          'select',
          {
            className: 'dsh-comfy-pinput',
            value: current,
            'data-cmf': 'param-input',
            'data-cmf-key': overrideKeyOf(nodeId, widget.name),
            onChange: (event) => commit(matchComboOption(options, event.target.value)),
          },
          hasCurrent ? null : h('option', { value: current }, current),
          options.map((option, index) => h('option', { key: index, value: optionLabel(option) }, optionLabel(option))),
        ),
        overridden ? h('span', { className: 'dsh-comfy-badge', 'data-tone': 'accent' }, t('editedBadge')) : null,
      )
    }
    return h('input', {
      className: 'dsh-comfy-pinput',
      type: 'text',
      value: value === null || value === undefined ? '' : String(value),
      'data-cmf': 'param-input',
      'data-cmf-key': overrideKeyOf(nodeId, widget.name),
      onChange: (event) => commit(event.target.value),
    })
  }
  if (widget.kind === 'number') {
    const numeric = typeof value === 'number' && Number.isFinite(value) ? value : value === '' || value === null || value === undefined ? '' : value
    return h(
      React.Fragment,
      null,
      h('input', {
        className: 'dsh-comfy-pinput',
        type: 'number',
        value: numeric,
        step: widget.step === undefined || widget.step === null ? 'any' : widget.step,
        min: widget.min === undefined ? undefined : widget.min,
        max: widget.max === undefined ? undefined : widget.max,
        'data-cmf': 'param-input',
        'data-cmf-key': overrideKeyOf(nodeId, widget.name),
        onChange: (event) => commit(event.target.value),
      }),
      overridden ? h('span', { className: 'dsh-comfy-badge', 'data-tone': 'accent' }, t('editedBadge')) : null,
    )
  }
  const text = value === null || value === undefined ? '' : String(value)
  const multiline = widget.multiline === true || text.length > 48
  if (multiline) {
    return h('textarea', {
      className: 'dsh-comfy-pinput',
      rows: 2,
      value: text,
      'data-cmf': 'param-input',
      'data-cmf-key': overrideKeyOf(nodeId, widget.name),
      onChange: (event) => commit(event.target.value),
    })
  }
  return h(
    React.Fragment,
    null,
    h('input', {
      className: 'dsh-comfy-pinput',
      type: 'text',
      value: text,
      'data-cmf': 'param-input',
      'data-cmf-key': overrideKeyOf(nodeId, widget.name),
      onChange: (event) => commit(event.target.value),
    }),
    overridden ? h('span', { className: 'dsh-comfy-badge', 'data-tone': 'accent' }, t('editedBadge')) : null,
  )
}

function ParamsDrawer(props) {
  const { graph, overrides, focusNodeId, onChange, onReset, onClose } = props
  const listRef = useRef(null)
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : []
  const targets = useMemo(() => {
    const list = []
    for (const node of nodes) {
      const widgets = editableWidgets(node)
      if (widgets.length === 0) continue
      list.push({ node, widgets })
    }
    return list
  }, [nodes])
  const overrideCount = Object.keys(overrides || {}).length

  useEffect(() => {
    if (!focusNodeId) return
    const container = listRef.current
    if (container === null || container === undefined) return
    const target = container.querySelector('[data-cmf-param-node="' + String(focusNodeId).replace(/"/g, '\\"') + '"]')
    if (target !== null && typeof target.scrollIntoView === 'function') {
      try {
        target.scrollIntoView({ block: 'nearest' })
      } catch (error) {
        /* jsdom 等环境里 scrollIntoView 可能不完整 */
      }
    }
  }, [focusNodeId])

  let body
  if (targets.length === 0) {
    body = h(
      'div',
      { className: 'dsh-comfy-drawer-empty' },
      h('div', null, t('paramsEmpty')),
      h('div', { className: 'dsh-comfy-dim', style: { marginTop: 4 } }, t('paramsEmptyHint')),
    )
  } else {
    body = h(
      'div',
      { className: 'dsh-comfy-drawer-list', ref: listRef },
      targets.map(({ node, widgets }) => {
        const muted = node.mode === 2 || node.mode === 4
        return h(
          'div',
          {
            key: String(node.id),
            className: 'dsh-comfy-pnode',
            'data-cmf-param-node': String(node.id),
            'data-focus': String(node.id) === String(focusNodeId) ? '1' : '0',
            style: { '--cmf-node-accent': 'var(--cmf-cat-' + categoryAccentIndex(node.category) + ')' },
          },
          h(
            'div',
            { className: 'dsh-comfy-pnode-head' },
            h('span', { className: 'dsh-comfy-pnode-dot' }),
            h('span', { className: 'dsh-comfy-pnode-title', title: nodeTitleOf(node) }, nodeTitleOf(node)),
            node.missing === true
              ? h('span', { className: 'dsh-comfy-badge', 'data-tone': 'error' }, t('nodeMissing'))
              : null,
            muted ? h('span', { className: 'dsh-comfy-badge', 'data-tone': 'warn' }, node.mode === 2 ? t('nodeMuted') : t('nodeBypassed')) : null,
            h('span', { className: 'dsh-comfy-pnode-type', title: String(node.type || '') }, String(node.type || '')),
          ),
          node.missing === true
            ? h('div', { className: 'dsh-comfy-pnote', 'data-tone': 'error' }, t('paramsMissingType'))
            : widgets.map((widget) =>
                h(
                  'div',
                  { key: widget.name, className: 'dsh-comfy-prow' },
                  h(
                    'span',
                    {
                      className: 'dsh-comfy-plabel',
                      'data-over': overrideValueOf(overrides, node.id, widget.name, undefined) !== undefined ? '1' : '0',
                      title: widget.name,
                    },
                    overrideValueOf(overrides, node.id, widget.name, undefined) !== undefined
                      ? h('span', { className: 'dsh-comfy-plabel-dot' })
                      : null,
                    widget.name,
                  ),
                  h('span', { className: 'dsh-comfy-pctl' }, h(WidgetControl, { nodeId: node.id, widget, overrides, onChange })),
                ),
              ),
        )
      }),
    )
  }

  return h(
    'div',
    { className: 'dsh-comfy-drawer', 'data-cmf': 'params-drawer' },
    h(
      'div',
      { className: 'dsh-comfy-drawer-head' },
      h(Glyph, { name: 'sliders', size: 14 }),
      h('span', { className: 'dsh-comfy-drawer-title' }, t('params')),
      overrideCount > 0 ? h('span', { className: 'dsh-comfy-badge', 'data-tone': 'accent' }, t('paramsOverrides', { n: overrideCount })) : null,
      h('span', { className: 'dsh-comfy-spacer' }),
      overrideCount > 0
        ? h(
            'button',
            { type: 'button', className: 'dsh-comfy-btn', 'data-ghost': '1', 'data-cmf': 'params-reset', onClick: onReset, title: t('resetOverrides') },
            h(Glyph, { name: 'reset', size: 13 }),
            t('paramsReset'),
          )
        : null,
      h(IconButton, { icon: 'close', title: t('dismiss'), size: 14, onClick: onClose }),
    ),
    body,
  )
}

/* ------------------------------------------------------------------ */
/* 全屏输出预览                                                        */
/* ------------------------------------------------------------------ */

function PreviewOverlay(props) {
  const { output, onClose } = props
  const kind = resultKindOf(output)
  const url = outputUrl(output)
  const label = String(output.label || output.filename || '')
  const [text, setText] = useState('')
  const [textError, setTextError] = useState('')
  const [textLoading, setTextLoading] = useState(kind === 'text')

  useEffect(() => {
    if (kind !== 'text') return undefined
    let alive = true
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    setTextLoading(true)
    setTextError('')
    fetch(url, { signal: controller === null ? undefined : controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.text()
      })
      .then((value) => {
        if (!alive) return
        setText(String(value))
        setTextLoading(false)
      })
      .catch((error) => {
        if (!alive) return
        setTextError(error && error.message ? error.message : String(error))
        setTextLoading(false)
      })
    return () => {
      alive = false
      if (controller !== null) controller.abort()
    }
  }, [kind, url])

  let media
  if (kind === 'image') {
    media = h('img', { src: url, alt: label, draggable: false })
  } else if (kind === 'video') {
    media = h('video', { src: url, controls: true, autoPlay: true, playsInline: true })
  } else if (kind === 'audio') {
    media = h('audio', { src: url, controls: true, autoPlay: true })
  } else if (kind === 'text') {
    media = h('pre', null, textLoading ? t('outputLoading') : textError ? t('outputLoadFailed') + '：' + textError : text)
  } else if (kind === '3d') {
    media = h(
      'div',
      { className: 'dsh-comfy-filecard' },
      h(Glyph, { name: 'cube', size: 34 }),
      h('div', null, label),
      h('div', null, t('output3dHint')),
    )
  } else {
    media = h(
      'div',
      { className: 'dsh-comfy-filecard' },
      h(Glyph, { name: 'file', size: 34 }),
      h('div', null, label),
      h('div', null, t('outputFile')),
    )
  }

  const path = [output.subfolder, output.filename].filter((part) => typeof part === 'string' && part !== '').join('/')

  return h(
    'div',
    {
      className: 'dsh-comfy-overlay',
      'data-cmf': 'preview',
      role: 'dialog',
      'aria-label': t('preview'),
      onClick: onClose,
    },
    h(
      'div',
      { className: 'dsh-comfy-preview', onClick: (event) => event.stopPropagation() },
      h(
        'div',
        { className: 'dsh-comfy-preview-head' },
        h(Glyph, kind === 'image' ? { name: 'image', size: 14 } : kind === 'video' ? { name: 'video', size: 14 } : kind === 'audio' ? { name: 'music', size: 14 } : kind === '3d' ? { name: 'cube', size: 14 } : kind === 'text' ? { name: 'text', size: 14 } : { name: 'file', size: 14 }),
        h('span', { className: 'dsh-comfy-preview-title', title: label }, label || t('preview')),
        h('span', { className: 'dsh-comfy-badge' }, String(kind)),
        h('span', { className: 'dsh-comfy-spacer' }),
        h(IconButton, { icon: 'close', title: t('closePreview'), size: 14, onClick: onClose }),
      ),
      h('div', { className: 'dsh-comfy-preview-body' }, media),
      h(
        'div',
        { className: 'dsh-comfy-preview-foot' },
        h('a', { className: 'dsh-comfy-btn', href: url, download: String(output.filename || ''), 'data-cmf': 'preview-download' }, h(Glyph, { name: 'download', size: 13 }), t('download')),
        h('a', { className: 'dsh-comfy-btn', href: url, target: '_blank', rel: 'noreferrer noopener', 'data-cmf': 'preview-open' }, h(Glyph, { name: 'external', size: 13 }), t('openNewTab')),
        h('span', { className: 'dsh-comfy-preview-path', title: path }, path),
      ),
    ),
  )
}

/* ------------------------------------------------------------------ */
/* 画布节点卡片 / 结果卡片                                              */
/* ------------------------------------------------------------------ */

function NodeCard(props) {
  const { node, x, y, width, height, selected, lod, onPointerDown, onDoubleClick, onHeadClick } = props
  const accentIndex = categoryAccentIndex(node.category)
  const accent = 'var(--cmf-cat-' + accentIndex + ')'
  const widgets = Array.isArray(node.widgets) ? node.widgets.slice(0, 4) : []
  const muted = node.mode === 2 || node.mode === 4
  const inputs = Array.isArray(node.inputs) ? node.inputs : []
  const outputs = Array.isArray(node.outputs) ? node.outputs : []
  return h(
    'div',
    {
      className: 'dsh-comfy-node',
      'data-cmf-node': String(node.id),
      'data-sel': selected ? '1' : '0',
      'data-dim': muted ? '1' : '0',
      'data-missing': node.missing === true ? '1' : '0',
      'data-lod': lod ? '1' : '0',
      style: {
        left: x + 'px',
        top: y + 'px',
        width: width + 'px',
        height: height + 'px',
        '--cmf-node-accent': accent,
        '--cmf-node-tint': 'var(--cmf-cat-' + accentIndex + '-bg)',
      },
      title: nodeTitleOf(node),
      onPointerDown: (event) => onPointerDown(event, node),
      onDoubleClick: (event) => onDoubleClick(event, node),
    },
    h(
      'div',
      {
        className: 'dsh-comfy-node-head',
        title: t('headHint'),
        onClick: (event) => {
          event.stopPropagation()
          if (typeof onHeadClick === 'function') onHeadClick(event, node)
        },
      },
      h('span', { className: 'dsh-comfy-node-dot' }),
      h('span', { className: 'dsh-comfy-node-title' }, nodeTitleOf(node)),
      node.missing === true
        ? h('span', { className: 'dsh-comfy-node-badge', 'data-kind': 'error' }, t('nodeMissing'))
        : muted
          ? h('span', { className: 'dsh-comfy-node-badge' }, node.mode === 2 ? t('nodeMuted') : t('nodeBypassed'))
          : null,
    ),
    h('div', { className: 'dsh-comfy-node-type' }, String(node.type || '')),
    h(
      'div',
      { className: 'dsh-comfy-node-widgets' },
      widgets.map((widget) =>
        h(
          'div',
          { key: widget.name, className: 'dsh-comfy-wchip' },
          h('span', { className: 'dsh-comfy-wchip-k' }, widget.name),
          h('span', { className: 'dsh-comfy-wchip-v' }, previewValue(widget.value)),
        ),
      ),
    ),
    inputs.map((input, index) =>
      h('span', {
        key: 'in-' + index,
        className: 'dsh-comfy-port',
        'data-side': 'in',
        style: { left: 0, top: portOffset(index, inputs.length, height) + 'px' },
        title: input && input.name ? String(input.name) : '',
      }),
    ),
    outputs.map((output, index) =>
      h('span', {
        key: 'out-' + index,
        className: 'dsh-comfy-port',
        'data-side': 'out',
        style: { left: width, top: portOffset(index, outputs.length, height) + 'px' },
        title: output && output.name ? String(output.name) : '',
      }),
    ),
  )
}

function ResultCard(props) {
  const { card, onPointerDown, onOpen } = props
  const output = card.output || {}
  const label = String(output.label || output.filename || '')
  const url = outputUrl(output)
  const kind = card.kind
  let media
  if (kind === 'image') {
    media = h('img', { src: url, alt: label, draggable: false })
  } else {
    media = h(Glyph, { name: kind === 'video' ? 'video' : kind === 'audio' ? 'music' : kind === '3d' ? 'cube' : kind === 'text' ? 'text' : 'file', size: 26 })
  }
  return h(
    'div',
    {
      className: 'dsh-comfy-rcard',
      'data-cmf-result': card.key,
      style: { left: card.x + 'px', top: card.y + 'px', width: card.w + 'px', height: card.h + 'px' },
      title: t('resultsHint'),
      onPointerDown: (event) => onPointerDown(event, card),
      onClick: (event) => {
        event.stopPropagation()
        onOpen(card.output)
      },
    },
    h(
      'div',
      { className: 'dsh-comfy-rcard-head' },
      h(Glyph, { name: 'image', size: 11 }),
      h('span', { className: 'dsh-comfy-rcard-label' }, label),
    ),
    h('div', { className: 'dsh-comfy-rcard-media' }, media),
  )
}

/* ------------------------------------------------------------------ */
/* 右键上下文菜单                                                       */
/* ------------------------------------------------------------------ */

/**
 * 画布/节点/结果卡片的右键菜单（position:fixed，跟随主题）。
 * 关闭由 Panel 的 window pointerdown/keydown/blur/wheel 监听负责，动作由 runContextMenuAction 分发。
 */
function ContextMenu(props) {
  useLanguage()
  const menu = props.menu
  const items = contextMenuItemsFor(menu.kind)
  const rows = []
  items.forEach((item, index) => {
    if (item.separatorBefore === true) rows.push(h('div', { key: 'sep-' + index, className: 'dsh-comfy-ctx-sep' }))
    rows.push(h(
      'button',
      {
        key: item.id,
        type: 'button',
        className: 'dsh-comfy-ctx-item',
        'data-cmf': 'ctx-item',
        'data-cmf-id': item.id,
        'data-tone': item.danger === true ? 'danger' : undefined,
        title: t(item.labelKey),
        disabled: item.needsGraph === true && menu.hasGraph !== true,
        onPointerDown: (event) => event.stopPropagation(),
        onClick: (event) => {
          event.stopPropagation()
          props.onAction(item.id)
        },
      },
      h(Glyph, { name: item.icon, size: 14 }),
      h('span', null, t(item.labelKey)),
    ))
  })
  return h(
    'div',
    {
      className: 'dsh-comfy-ctx',
      'data-cmf': 'context-menu',
      role: 'menu',
      style: { left: menu.x + 'px', top: menu.y + 'px' },
      onContextMenu: (event) => event.preventDefault(),
    },
    rows,
  )
}

/* ------------------------------------------------------------------ */
/* 画布主面板                                                          */
/* ------------------------------------------------------------------ */

/** 统一请求：同源 fetch + JSON + 错误抽成 Error。 */
async function requestJson(url, options) {
  const init = Object.assign({ headers: { accept: 'application/json' } }, options)
  const response = await fetch(url, init)
  let body = {}
  try {
    body = await response.json()
  } catch (error) {
    body = {}
  }
  if (!response.ok || body.ok === false) {
    const message = body && typeof body.error === 'string' && body.error !== '' ? body.error : 'HTTP ' + response.status
    throw new Error(message)
  }
  return body === null || typeof body !== 'object' ? {} : body
}

function postJson(url, payload) {
  return requestJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload === undefined || payload === null ? {} : payload),
  })
}

function errorText(error) {
  if (error && typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/** 最大分组（按面积）的 bbox；没有合法分组时返回 null。 */
function largestGroupBox(groups) {
  const list = Array.isArray(groups) ? groups : []
  let best = null
  let bestArea = -1
  for (const group of list) {
    if (group === null || group === undefined) continue
    const x = Number(group.x)
    const y = Number(group.y)
    const width = Number(group.w)
    const height = Number(group.h)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) continue
    if (width <= 0 || height <= 0) continue
    const area = width * height
    if (area > bestArea) {
      bestArea = area
      best = { x, y, w: width, h: height }
    }
  }
  return best
}

/** 最大分组的中心；没有合法分组时返回 null。 */
function largestGroupCenter(groups) {
  const box = largestGroupBox(groups)
  return box === null ? null : { x: box.x + box.w / 2, y: box.y + box.h / 2 }
}

/** 面积最大的节点 bbox（entries 形状 {x,y,w,h}）。 */
function largestNodeBox(entries) {
  const list = Array.isArray(entries) ? entries : []
  let best = null
  let bestArea = -1
  for (const entry of list) {
    if (entry === null || entry === undefined) continue
    const area = Number(entry.w) * Number(entry.h)
    if (!Number.isFinite(area) || area <= 0) continue
    if (area > bestArea) {
      bestArea = area
      best = { x: Number(entry.x), y: Number(entry.y), w: Number(entry.w), h: Number(entry.h) }
    }
  }
  return best
}

/**
 * 打开工作流时的初始视图（可读优先，纯函数）：
 *   1. 先算整图 fit（夹取 [0.45, 0.85]，与 ⛶ 按钮同一套）；fitScale >= 0.55 → 直接整图 fit（居中）。
 *   2. 否则 k = 0.62，中心依次取：
 *      a. **采样/导演节点**（KSampler / *Sampler / *Director* —— 用户真正要调参的地方；
 *         SF 工作流最大分组是横跨 1780px 的稀疏链，按分组 bbox 中心会落在空档里，
 *         所以“可读优先”先把视口落在主节点上）；
 *      b. 最大分组的 bbox 中心；
 *      c. 最大节点的 bbox 中心；
 *      d. 整图 bbox 中心。
 *      竖直方向做夹取（目标比视口矮时保证顶/底不会被切）。
 * 注意：fit 按钮 / F 键始终是“整图总览”，本函数只用于“打开工作流”的初始视图。
 * @param graph - { nodes:[{x,y,w,h,type}], groups:[{x,y,w,h}] }
 * @param width - 画布宽（px）
 * @param height - 画布高（px）
 * @param padding - 边距（默认 36）
 * @returns {{ view: {x:number,y:number,k:number}, mode: 'fit'|'focus' }}
 */
function initialViewForGraph(graph, width, height, padding) {
  const pad = Number.isFinite(Number(padding)) ? Number(padding) : 36
  const nodes = graph !== null && graph !== undefined && Array.isArray(graph.nodes) ? graph.nodes : []
  const entries = []
  for (const node of nodes) {
    if (node === null || node === undefined) continue
    const size = normalizeNodeSize(node)
    entries.push({ x: Number(node.x) || 0, y: Number(node.y) || 0, w: size.w, h: size.h, node })
  }
  const bounds = contentBounds(entries)
  const widthNumber = Number(width)
  const heightNumber = Number(height)
  const fitted = fitViewToBounds(bounds, widthNumber, heightNumber, pad)
  if (fitted.k >= INITIAL_READABLE_MIN || entries.length === 0) return { view: fitted, mode: 'fit' }

  const viewWidth = widthNumber >= 32 ? widthNumber : 560
  const viewHeight = heightNumber >= 32 ? heightNumber : 900
  const groups = graph !== null && graph !== undefined && Array.isArray(graph.groups) ? graph.groups : []
  let target = null
  const anchor = entries.find((entry) => entry.node !== null && entry.node !== undefined && /Sampler|Director/i.test(String(entry.node.type || '')))
  if (anchor !== undefined) target = { x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h }
  if (target === null) target = largestGroupBox(groups)
  if (target === null) target = largestNodeBox(entries)
  if (target === null) {
    target = bounds === null ? null : { x: bounds.minX, y: bounds.minY, w: bounds.maxX - bounds.minX, h: bounds.maxY - bounds.minY }
  }
  if (target === null) return { view: { x: pad, y: pad, k: INITIAL_FOCUS_ZOOM }, mode: 'focus' }

  const scale = INITIAL_FOCUS_ZOOM
  const centerX = target.x + target.w / 2
  const centerY = target.y + target.h / 2
  let viewX = viewWidth / 2 - centerX * scale
  let viewY = viewHeight / 2 - centerY * scale
  // 目标比视口矮时，保证它整块落在可见带内（顶部不被画布边缘切掉）。
  const marginY = Math.min(24, viewHeight * 0.04)
  if (target.h * scale <= viewHeight - marginY * 2) {
    const top = viewY + target.y * scale
    const bottom = viewY + (target.y + target.h) * scale
    if (top < marginY) viewY = marginY - target.y * scale
    else if (bottom > viewHeight - marginY) viewY = viewHeight - marginY - (target.y + target.h) * scale
  }
  return { view: { x: round2(viewX), y: round2(viewY), k: round2(scale) }, mode: 'focus' }
}

/** 把 graph.nodes 变成 {id:{x,y}} 的本地位置表。 */
function positionsFromGraph(graph) {
  const map = {}
  if (graph && Array.isArray(graph.nodes)) {
    for (const node of graph.nodes) {
      if (!node) continue
      map[String(node.id)] = { x: Number(node.x) || 0, y: Number(node.y) || 0 }
    }
  }
  return map
}

function ComfyPanel() {
  useLanguage()

  const [status, setStatus] = useState(null)
  const [statusError, setStatusError] = useState('')
  const [workflows, setWorkflows] = useState(null)
  const [workflowsError, setWorkflowsError] = useState('')
  const [workflowsLoading, setWorkflowsLoading] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null)
  const [doc, setDoc] = useState(null)
  const [docError, setDocError] = useState('')
  const [docLoading, setDocLoading] = useState(false)
  const [positions, setPositions] = useState({})
  const [view, setView] = useState({ x: 20, y: 20, k: 0.8 })
  const [selectedIds, setSelectedIds] = useState([])
  const [paramsOpen, setParamsOpen] = useState(false)
  const [focusNodeId, setFocusNodeId] = useState('')
  const [overrides, setOverrides] = useState({})
  const [outputs, setOutputs] = useState([])
  const [resultCards, setResultCards] = useState([])
  const [preview, setPreview] = useState(null)
  const [starting, setStarting] = useState(false)
  const [banner, setBanner] = useState(null)
  const [run, setRun] = useState({ state: 'idle', promptId: '', number: 0, elapsedMs: 0, queuePosition: undefined, error: '', warnings: [] })
  const [stageReady, setStageReady] = useState(false)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [dragging, setDragging] = useState('')
  const [marquee, setMarquee] = useState(null)
  const [menu, setMenu] = useState(null)
  const [toast, setToast] = useState('')

  const rootRef = useRef(null)
  const stageRef = useRef(null)
  const dragRef = useRef(null)
  const spaceRef = useRef(false)
  const panelHoverRef = useRef(false)
  const mountedRef = useRef(true)
  const workflowAbortRef = useRef(null)
  const positionsRef = useRef({})
  const graphRef = useRef(null)
  const builtRunRef = useRef('')
  const overridesRef = useRef({})
  const selectedRef = useRef([])
  const suppressClickRef = useRef(false)
  const toastTimerRef = useRef(0)

  positionsRef.current = positions
  overridesRef.current = overrides
  selectedRef.current = selectedIds

  const graph = doc && doc.graph ? doc.graph : null
  graphRef.current = graph
  const stats = useMemo(() => summarizeGraph(graph), [graph])
  const reachable = status !== null && status.reachable === true
  const overrideCount = Object.keys(overrides).length
  const runActive = run.state === 'queued' || run.state === 'running' || run.state === 'unknown'

  const bindStage = useCallback((node) => {
    stageRef.current = node
    setStageReady(node !== null && node !== undefined)
  }, [])

  /** 轻量 toast（复制反馈等），1.9s 自动消失；卸载时清定时器。 */
  const showToast = useCallback((text) => {
    setToast(String(text === null || text === undefined ? '' : text))
    window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(''), 1900)
  }, [])

  useEffect(() => () => window.clearTimeout(toastTimerRef.current), [])

  /** 右键菜单：点外面 / Esc / 窗口失焦都关掉（capture 阶段监听，先于画布 pointerdown）。 */
  useEffect(() => {
    if (menu === null) return undefined
    const onPointerDown = (event) => {
      const target = event.target
      if (target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('.dsh-comfy-ctx') !== null) return
      setMenu(null)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setMenu(null)
    }
    const onBlur = () => setMenu(null)
    const onWheel = () => setMenu(null)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('wheel', onWheel)
    }
  }, [menu])

  /* ---------------- 状态轮询 ---------------- */

  const loadStatus = useCallback(async () => {
    try {
      const body = await requestJson(API.status)
      if (!mountedRef.current) return null
      setStatus(body)
      setStatusError('')
      return body
    } catch (error) {
      if (!mountedRef.current) return null
      setStatus((current) => (current && current.reachable === false ? Object.assign({}, current, { error: errorText(error) }) : { reachable: false, error: errorText(error) }))
      setStatusError(errorText(error))
      return null
    }
  }, [])

  useEffect(() => {
    let alive = true
    let timer = 0
    const loop = async () => {
      await loadStatus()
      if (!alive) return
      timer = window.setTimeout(loop, reachable ? STATUS_ONLINE_MS : STATUS_OFFLINE_MS)
    }
    void loop()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [loadStatus, reachable, starting])

  /* ---------------- 工作流列表 ---------------- */

  const loadWorkflows = useCallback(async () => {
    setWorkflowsLoading(true)
    try {
      const body = await requestJson(API.workflows)
      if (!mountedRef.current) return
      setWorkflows({ sources: Array.isArray(body.sources) ? body.sources : [], items: Array.isArray(body.items) ? body.items : [] })
      setWorkflowsError('')
    } catch (error) {
      if (!mountedRef.current) return
      setWorkflowsError(errorText(error))
    } finally {
      if (mountedRef.current) setWorkflowsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!reachable) return
    if (workflows !== null || workflowsLoading) return
    void loadWorkflows()
  }, [reachable, workflows, workflowsLoading, loadWorkflows])

  /* ---------------- 打开工作流 ---------------- */

  const openWorkflow = useCallback(async (item) => {
    if (!item) return
    setSelected(item)
    setPickerOpen(false)
    setQuery('')
    setDoc(null)
    setDocError('')
    setDocLoading(true)
    setParamsOpen(false)
    setFocusNodeId('')
    setOverrides({})
    setOutputs([])
    setResultCards([])
    setPreview(null)
    setBanner(null)
    setSelectedIds([])
    setRun({ state: 'idle', promptId: '', number: 0, elapsedMs: 0, queuePosition: undefined, error: '', warnings: [] })
    builtRunRef.current = ''
    if (workflowAbortRef.current !== null) {
      try {
        workflowAbortRef.current.abort()
      } catch (error) {
        /* ignore */
      }
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    workflowAbortRef.current = controller
    try {
      const body = await requestJson(API.workflow + '?id=' + encodeURIComponent(item.id), controller === null ? undefined : { signal: controller.signal })
      if (!mountedRef.current) return
      setDoc(body)
      setPositions(positionsFromGraph(body.graph))
      setView({ x: 24, y: 24, k: 0.8 })
      const warnings = Array.isArray(body.warnings) ? body.warnings.filter((warning) => typeof warning === 'string' && warning !== '') : []
      if (warnings.length > 0) setBanner({ kind: 'warn', text: warnings.join('\n') })
    } catch (error) {
      if (!mountedRef.current) return
      if (error && (error.name === 'AbortError' || String(error.message).indexOf('abort') !== -1)) return
      setDocError(errorText(error))
    } finally {
      if (mountedRef.current) setDocLoading(false)
    }
  }, [])

  /* ---------------- 视图 ---------------- */

  const fitView = useCallback(() => {
    const stage = stageRef.current
    if (stage === null || stage === undefined) return
    const box = typeof stage.getBoundingClientRect === 'function' ? stage.getBoundingClientRect() : { width: 0, height: 0 }
    const nodes = graph ? graph.nodes : []
    const items = []
    for (const node of nodes) {
      const size = normalizeNodeSize(node)
      const pos = positionsRef.current[String(node.id)] || { x: node.x, y: node.y }
      items.push({ x: Number(pos.x) || 0, y: Number(pos.y) || 0, w: size.w, h: size.h })
    }
    for (const card of resultCards) items.push({ x: card.x, y: card.y, w: card.w, h: card.h })
    const bounds = contentBounds(items)
    const width = Number(box.width) || 0
    const height = Number(box.height) || 0
    // ⛶ 按钮 / F 键 = 整图总览（夹取 0.45–0.85，居中整图）。
    setView(fitViewToBounds(bounds, width, height, 36))
  }, [graph, resultCards])

  /** 打开工作流时的初始视图（可读优先）：fit 够大就整图 fit，否则聚焦最大分组。 */
  const applyInitialView = useCallback(() => {
    const stage = stageRef.current
    const source = graphRef.current
    if (stage === null || stage === undefined || source === null || source === undefined) return
    const box = typeof stage.getBoundingClientRect === 'function' ? stage.getBoundingClientRect() : { width: 0, height: 0 }
    const nodes = []
    for (const node of Array.isArray(source.nodes) ? source.nodes : []) {
      const pos = positionsRef.current[String(node.id)]
      nodes.push(pos === undefined ? node : Object.assign({}, node, { x: pos.x, y: pos.y }))
    }
    const result = initialViewForGraph({ nodes, groups: Array.isArray(source.groups) ? source.groups : [] }, Number(box.width) || 0, Number(box.height) || 0, 36)
    setView(result.view)
  }, [])

  useEffect(() => {
    if (!stageReady || graph === null) return undefined
    const timer = window.setTimeout(applyInitialView, 60)
    return () => window.clearTimeout(timer)
  }, [stageReady, doc, applyInitialView, graph])

  /** 以画布中心缩放。 */
  const zoomBy = useCallback((factor) => {
    const stage = stageRef.current
    if (stage === null || stage === undefined) return
    const box = typeof stage.getBoundingClientRect === 'function' ? stage.getBoundingClientRect() : { width: 0, height: 0 }
    setView((current) => zoomAtPoint(current, (Number(box.width) || 0) / 2, (Number(box.height) || 0) / 2, (Number(current.k) || 1) * factor))
  }, [])

  const resetView = useCallback(() => {
    const stage = stageRef.current
    if (stage === null || stage === undefined) return
    const box = typeof stage.getBoundingClientRect === 'function' ? stage.getBoundingClientRect() : { width: 0, height: 0 }
    setView((current) => zoomAtPoint(current, (Number(box.width) || 0) / 2, (Number(box.height) || 0) / 2, 1))
  }, [])

  const centerOnNode = useCallback((nodeId, focusRatio) => {
    const stage = stageRef.current
    const node = (graph ? graph.nodes : []).find((entry) => String(entry.id) === String(nodeId))
    if (stage === null || stage === undefined || node === undefined) return
    const box = typeof stage.getBoundingClientRect === 'function' ? stage.getBoundingClientRect() : { width: 0, height: 0 }
    const size = normalizeNodeSize(node)
    const pos = positionsRef.current[String(node.id)] || { x: node.x, y: node.y }
    const ratio = typeof focusRatio === 'number' ? clamp(focusRatio, 0.08, 0.5) : 0.5
    setView((current) => {
      const scale = clamp(Math.max(current.k, 0.72), CENTER_MIN_ZOOM, FIT_MAX_ZOOM)
      return {
        k: scale,
        x: (Number(box.width) || 0) / 2 - (Number(pos.x) + size.w / 2) * scale,
        y: (Number(box.height) || 0) * ratio - (Number(pos.y) + size.h / 2) * scale,
      }
    })
  }, [graph])

  /** 打开某个节点的参数抽屉并把它居中到抽屉上方的可见带。 */
  const openNodeParams = useCallback((nodeId) => {
    const id = String(nodeId)
    setSelectedIds([id])
    setFocusNodeId(id)
    setParamsOpen(true)
    centerOnNode(id, 0.17)
  }, [centerOnNode])

  /* ---------------- 滚轮（非 passive） ---------------- */

  useEffect(() => {
    const stage = stageRef.current
    if (stage === null || stage === undefined) return undefined
    const onWheel = (event) => {
      event.preventDefault()
      const box = typeof stage.getBoundingClientRect === 'function' ? stage.getBoundingClientRect() : { left: 0, top: 0 }
      const pointerX = event.clientX - (box.left || 0)
      const pointerY = event.clientY - (box.top || 0)
      setView((current) => wheelZoom(current, pointerX, pointerY, event.deltaY))
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [stageReady])

  /* ---------------- 键盘：空格平移 / F 适应 / Esc 关闭浮层 ---------------- */

  useEffect(() => {
    const isEditable = (target) => {
      if (target === null || target === undefined) return false
      const tag = String(target.tagName || '').toUpperCase()
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
    }
    const rootHasFocus = () => {
      const root = rootRef.current
      if (root === null || root === undefined) return false
      const active = typeof document === 'undefined' ? null : document.activeElement
      return active !== null && active !== undefined && root.contains(active)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (preview !== null) {
          setPreview(null)
          return
        }
        if (pickerOpen) {
          setPickerOpen(false)
          return
        }
        if (paramsOpen) setParamsOpen(false)
        return
      }
      if (isEditable(event.target)) return
      if (event.code === 'Space' || event.key === ' ') {
        if (panelHoverRef.current || rootHasFocus()) {
          event.preventDefault()
          spaceRef.current = true
          setSpaceHeld(true)
        }
        return
      }
      if (!rootHasFocus()) return
      const key = String(event.key || '').toLowerCase()
      if (key === 'f') {
        event.preventDefault()
        fitView()
      } else if (key === '+' || key === '=') {
        event.preventDefault()
        zoomBy(ZOOM_STEP)
      } else if (key === '-') {
        event.preventDefault()
        zoomBy(1 / ZOOM_STEP)
      }
    }
    const onKeyUp = (event) => {
      if (event.code === 'Space' || event.key === ' ') {
        spaceRef.current = false
        setSpaceHeld(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      spaceRef.current = false
    }
  }, [fitView, paramsOpen, pickerOpen, preview, zoomBy])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (workflowAbortRef.current !== null) {
        try {
          workflowAbortRef.current.abort()
        } catch (error) {
          /* ignore */
        }
      }
    }
  }, [])

  /* ---------------- 画布指针交互 ---------------- */

  /**
   * 指针捕获必须“拖起来才捕获”，不能在 pointerdown 就捕获：
   * 一旦 stage 持有 capture，pointerup 会被重定向到 stage，Chrome 会把随后的 click
   * 派发给最近公共祖先（stage）—— 节点标题/结果卡片的 click 永远收不到（真机实测）。
   * 拖动超过阈值后才 setPointerCapture，保证拖出画布也不丢 move/up。
   */
  const capturePointerLazily = (state) => {
    if (state === null || state === undefined || state.captured === true) return
    const stage = stageRef.current
    if (stage === null || stage === undefined) return
    try {
      if (typeof stage.setPointerCapture === 'function' && state.pointerId !== undefined) stage.setPointerCapture(state.pointerId)
      state.captured = true
    } catch (error) {
      state.captured = false
    }
  }

  const releasePointerCapture = (state) => {
    if (state === null || state === undefined || state.captured !== true) return
    const stage = stageRef.current
    state.captured = false
    if (stage === null || stage === undefined) return
    try {
      if (typeof stage.releasePointerCapture === 'function' && state.pointerId !== undefined) stage.releasePointerCapture(state.pointerId)
    } catch (error) {
      /* ignore */
    }
  }

  /** 指针是否已从按下点多移动了超过拖拽阈值（屏幕 px）。 */
  const movedBeyondThreshold = (state, clientX, clientY) => {
    if (state.startX === undefined) return false
    return Math.hypot(Number(clientX) - state.startX, Number(clientY) - state.startY) > DRAG_THRESHOLD_PX
  }

  const toWorld = useCallback((clientX, clientY) => {
    const stage = stageRef.current
    const box = stage !== null && stage !== undefined && typeof stage.getBoundingClientRect === 'function'
      ? stage.getBoundingClientRect()
      : { left: 0, top: 0 }
    return screenToWorld(view, clientX - (box.left || 0), clientY - (box.top || 0))
  }, [view])

  const onStagePointerDown = useCallback((event) => {
    setMenu(null)
    // 中键拖拽平移：阻止 Chrome 的中键自动滚动/粘贴默认行为
    if (event.button === 1) {
      try {
        event.preventDefault()
      } catch (error) {
        /* ignore */
      }
    }
    if (event.button !== 0 && event.button !== 1) return
    const target = event.target
    const onNode = target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('[data-cmf-node]') !== null
    const onResult = target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('[data-cmf-result]') !== null
    if (onNode || onResult) return
    // 平移：中键 / 空格+左键 / Alt+左键（ComfyUI 习惯，左键留给框选）
    const wantsPan = event.button === 1 || spaceRef.current === true || event.altKey === true
    if (wantsPan) {
      dragRef.current = {
        kind: 'pan',
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
        wantPan: true,
        captured: false,
        pointerId: event.pointerId,
      }
      setDragging('pan')
      return
    }
    // 左键空白拖拽 = 框选；超过 3px 才开始画框，未拖动单击 = 清空选择
    dragRef.current = {
      kind: 'box',
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      base: event.shiftKey === true ? selectedRef.current.slice() : [],
      captured: false,
      pointerId: event.pointerId,
    }
    setDragging('box')
    // 不在这里 setPointerCapture：见 capturePointerLazily 的注释
  }, [])

  const onNodePointerDown = useCallback((event, node) => {
    if (event.button !== 0) return
    setMenu(null)
    event.stopPropagation()
    const id = String(node.id)
    if (event.shiftKey === true) {
      setSelectedIds((current) => (current.indexOf(id) === -1 ? current.concat([id]) : current.filter((entry) => entry !== id)))
      return
    }
    const currentSelection = selectedRef.current
    const group = currentSelection.indexOf(id) === -1 ? [id] : currentSelection.slice()
    setSelectedIds(group)
    const target = event.target
    const headHit = target !== null && target !== undefined && typeof target.closest === 'function'
      && target.closest('.dsh-comfy-node-head') !== null
    dragRef.current = {
      kind: 'nodes',
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      ids: group,
      nodeId: id,
      headHit,
      captured: false,
      pointerId: event.pointerId,
      origin: Object.fromEntries(group.map((entry) => {
        const pos = positionsRef.current[entry]
        return [entry, { x: pos === undefined ? 0 : Number(pos.x) || 0, y: pos === undefined ? 0 : Number(pos.y) || 0 }]
      })),
    }
    setDragging('nodes')
    // 不在这里 setPointerCapture：否则 click 会被重定向到 stage，标题单击/双击全部失效
  }, [])

  const onResultPointerDown = useCallback((event, card) => {
    if (event.button !== 0) return
    setMenu(null)
    event.stopPropagation()
    dragRef.current = {
      kind: 'result',
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      key: card.key,
      output: card.output,
      origin: { x: card.x, y: card.y },
      captured: false,
      pointerId: event.pointerId,
    }
    setDragging('result')
  }, [])

  const onStagePointerMove = useCallback((event) => {
    const state = dragRef.current
    if (state === null) return
    // 拖动真正开始（超过 3px）才捕获指针；这样普通点击的 click 仍落在原目标上。
    if (state.moved !== true && movedBeyondThreshold(state, event.clientX, event.clientY)) {
      state.moved = true
      capturePointerLazily(state)
    }
    if (state.kind === 'box') {
      state.x = event.clientX
      state.y = event.clientY
      if (state.moved !== true) return
      const stage = stageRef.current
      const rect = stage !== null && stage !== undefined && typeof stage.getBoundingClientRect === 'function'
        ? stage.getBoundingClientRect()
        : { left: 0, top: 0 }
      setMarquee(boxFromPoints(
        state.startX - (Number(rect.left) || 0),
        state.startY - (Number(rect.top) || 0),
        event.clientX - (Number(rect.left) || 0),
        event.clientY - (Number(rect.top) || 0),
      ))
      return
    }
    if (state.kind === 'pan') {
      const dx = event.clientX - state.lastX
      const dy = event.clientY - state.lastY
      state.lastX = event.clientX
      state.lastY = event.clientY
      setView((current) => ({ k: current.k, x: current.x + dx, y: current.y + dy }))
      return
    }
    const scale = Math.max(0.0001, Number(view.k) || 1)
    if (state.kind === 'nodes') {
      const dx = (event.clientX - state.startX) / scale
      const dy = (event.clientY - state.startY) / scale
      setPositions((current) => {
        const next = Object.assign({}, current)
        for (const id of state.ids) {
          const origin = state.origin[id]
          if (origin === undefined) continue
          next[id] = { x: origin.x + dx, y: origin.y + dy }
        }
        return next
      })
      return
    }
    if (state.kind === 'result') {
      const dx = (event.clientX - state.startX) / scale
      const dy = (event.clientY - state.startY) / scale
      setResultCards((current) => current.map((card) => (card.key === state.key ? Object.assign({}, card, { x: state.origin.x + dx, y: state.origin.y + dy }) : card)))
    }
  }, [view.k])

  const onStagePointerUp = useCallback((event) => {
    const state = dragRef.current
    dragRef.current = null
    setDragging('')
    if (state === null) return
    if (state.kind === 'box') {
      setMarquee(null)
      if (state.moved === true) {
        const stage = stageRef.current
        const rect = stage !== null && stage !== undefined && typeof stage.getBoundingClientRect === 'function'
          ? stage.getBoundingClientRect()
          : { left: 0, top: 0 }
        // 框选结果在世界坐标里算：屏幕点 → stage 局部 → 世界坐标，和节点位置/尺寸同一坐标系
        const start = screenToWorld(view, state.startX - (Number(rect.left) || 0), state.startY - (Number(rect.top) || 0))
        const end = screenToWorld(view, state.x - (Number(rect.left) || 0), state.y - (Number(rect.top) || 0))
        const box = { x0: start.x, y0: start.y, x1: end.x, y1: end.y }
        const source = graphRef.current
        const entries = []
        for (const node of source !== null && source !== undefined && Array.isArray(source.nodes) ? source.nodes : []) {
          const size = normalizeNodeSize(node)
          const pos = positionsRef.current[String(node.id)] || { x: node.x, y: node.y }
          entries.push({ id: String(node.id), x: Number(pos.x) || 0, y: Number(pos.y) || 0, w: size.w, h: size.h })
        }
        const hits = selectNodesInBox(entries, box)
        setSelectedIds(state.base.length > 0 ? state.base.concat(hits.filter((id) => state.base.indexOf(id) === -1)) : hits)
      } else if (state.base.length === 0) {
        // 空白单击（未拖动）且没按 Shift = 取消选择
        setSelectedIds([])
      }
    } else if (state.kind === 'pan') {
      // 平移不改变选择（中键/空格拖拽是纯视图操作）
    } else if (state.kind === 'nodes') {
      if (state.moved === true) {
        suppressClickRef.current = true
      } else if (state.headHit === true && state.nodeId !== undefined) {
        // pointerdown 落在节点标题上且没有拖动 = 单击标题 → 打开参数抽屉（不依赖 click 是否被重定向）
        openNodeParams(state.nodeId)
      }
    } else if (state.kind === 'result') {
      if (state.moved === true) {
        suppressClickRef.current = true
      } else if (state.output !== undefined) {
        setPreview(state.output)
      }
    }
    releasePointerCapture(state)
  }, [openNodeParams, view])

  const onNodeDoubleClick = useCallback((event, node) => {
    event.stopPropagation()
    openNodeParams(String(node.id))
  }, [openNodeParams])

  /** 单击节点标题 = 选中 + 打开参数（click 事件路径；pointerup 路径见 onStagePointerUp）。 */
  const onNodeHeadClick = useCallback((event, node) => {
    if (event !== null && event !== undefined && event.shiftKey === true) return
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    openNodeParams(String(node.id))
  }, [openNodeParams])

  const onStageDoubleClick = useCallback((event) => {
    const target = event.target
    const onNode = target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('[data-cmf-node]') !== null
    if (onNode) return
    fitView()
  }, [fitView])

  /* ---------------- 参数编辑 ---------------- */

  const onWidgetChange = useCallback((nodeId, name, kind, raw) => {
    if (kind === 'number' && (raw === '' || raw === null || raw === undefined)) {
      setOverrides((current) => setOverrideValue(current, nodeId, name, undefined))
      return
    }
    const value = coerceWidgetValue(kind, raw)
    setOverrides((current) => setOverrideValue(current, nodeId, name, value))
  }, [])

  const resetOverrides = useCallback(() => setOverrides({}), [])

  /* ---------------- 运行 / 进度 ---------------- */

  const startRun = useCallback(async () => {
    if (doc === null || doc === undefined) return
    setBanner(null)
    setOutputs([])
    setResultCards([])
    setPreview(null)
    builtRunRef.current = ''
    setRun({ state: 'queued', promptId: '', number: 0, elapsedMs: 0, queuePosition: undefined, error: '', warnings: [], startedAt: Date.now() })
    try {
      const payload = { id: doc.id }
      if (Object.keys(overridesRef.current).length > 0) payload.overrides = overridesRef.current
      const body = await postJson(API.run, payload)
      if (!mountedRef.current) return
      const warnings = Array.isArray(body.warnings) ? body.warnings.filter((warning) => typeof warning === 'string' && warning !== '') : []
      setRun((current) => Object.assign({}, current, {
        state: 'queued',
        promptId: String(body.promptId === undefined || body.promptId === null ? '' : body.promptId),
        number: Number(body.number) || 0,
        warnings,
        startedAt: Date.now(),
      }))
      if (warnings.length > 0) setBanner({ kind: 'warn', text: warnings.join('\n') })
    } catch (error) {
      if (!mountedRef.current) return
      setRun((current) => Object.assign({}, current, { state: 'error', error: errorText(error) }))
    }
  }, [doc])

  const interruptRun = useCallback(async () => {
    try {
      await postJson(API.interrupt, {})
      if (mountedRef.current) setBanner({ kind: 'warn', text: t('interruptSent') })
    } catch (error) {
      if (mountedRef.current) setBanner({ kind: 'error', text: t('interruptFailed') + '：' + errorText(error) })
    }
  }, [])

  // 进度轮询：promptId + runActive 驱动；state 变化不重建计时器（依赖里没有 run.state 本身）。
  useEffect(() => {
    const promptId = run.promptId
    if (promptId === '' || !runActive) return undefined
    let alive = true
    let timer = 0
    let attempts = 0
    const poll = async () => {
      attempts += 1
      try {
        const body = await requestJson(API.progress + '?promptId=' + encodeURIComponent(promptId))
        if (!alive || !mountedRef.current) return
        const state = body.state === 'queued' || body.state === 'running' || body.state === 'done' || body.state === 'error' ? body.state : 'unknown'
        setRun((current) => {
          if (current.promptId !== promptId) return current
          const next = Object.assign({}, current, {
            state,
            elapsedMs: Number(body.elapsedMs) || 0,
            queuePosition: body.queuePosition === undefined || body.queuePosition === null ? undefined : Number(body.queuePosition),
          })
          if (state === 'done') next.outputs = Array.isArray(body.outputs) ? body.outputs : []
          if (state === 'error') next.error = body.error ? String(body.error) : t('runFailed')
          return next
        })
        if (state === 'done' || state === 'error') return
      } catch (error) {
        if (!alive || !mountedRef.current) return
        setRun((current) => (current.promptId === promptId ? Object.assign({}, current, { pollError: errorText(error) }) : current))
      }
      if (!alive) return
      if (attempts > 900) {
        setRun((current) => (current.promptId === promptId ? Object.assign({}, current, { state: 'error', error: t('progressTimeout') }) : current))
        return
      }
      timer = window.setTimeout(poll, PROGRESS_POLL_MS)
    }
    timer = window.setTimeout(poll, 260)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.promptId, runActive])

  // 运行完成后：把 outputs 落到结果条 + 画布结果卡片（每个 prompt 只做一次）
  useEffect(() => {
    if (run.state !== 'done') return
    const promptKey = String(run.promptId || '')
    if (promptKey === '' || builtRunRef.current === promptKey) return
    builtRunRef.current = promptKey
    const list = Array.isArray(run.outputs) ? run.outputs : []
    setOutputs(list)
    setResultCards(buildResultCards(list, graphRef.current, positionsRef.current))
    if (list.length === 0) setBanner({ kind: 'warn', text: t('noOutputs') })
  }, [run.state, run.promptId, run.outputs])

  // 运行失败：错误进 banner
  useEffect(() => {
    if (run.state !== 'error') return
    const message = String(run.error || t('runFailed'))
    setBanner({ kind: 'error', text: message })
  }, [run.state, run.error])

  /* ---------------- ComfyUI 启动 ---------------- */

  const startComfy = useCallback(async () => {
    setStarting(true)
    setBanner(null)
    try {
      const body = await postJson(API.start, {})
      if (!mountedRef.current) return
      setBanner({ kind: 'warn', text: body.message ? String(body.message) : t('startRequested') })
      window.setTimeout(() => {
        if (mountedRef.current) void loadStatus()
      }, 1500)
    } catch (error) {
      if (mountedRef.current) setBanner({ kind: 'error', text: t('startFailed') + '：' + errorText(error) })
    } finally {
      if (mountedRef.current) setStarting(false)
    }
  }, [loadStatus])

  const refreshAll = useCallback(() => {
    void loadStatus()
    void loadWorkflows()
    if (!runActive && selected !== null && selected !== undefined) void openWorkflow(selected)
  }, [loadStatus, loadWorkflows, openWorkflow, runActive, selected])

  /* ---------------- 右键上下文菜单 ---------------- */

  /** 复制文本到剪贴板（失败给 toast，不污染宿主 DOM）。 */
  const copyText = useCallback(async (text) => {
    const value = String(text === null || text === undefined ? '' : text)
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && navigator.clipboard !== null
        && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value)
        showToast(t('copied'))
        return
      }
      throw new Error('clipboard unavailable')
    } catch (error) {
      showToast(t('copyFailed'))
    }
  }, [showToast])

  /** 下载一个输出（同源 /view，用临时 <a download>，挂在面板根节点里并且用完即删）。 */
  const downloadOutput = useCallback((output) => {
    try {
      if (typeof document === 'undefined' || output === null || output === undefined) return
      const anchor = document.createElement('a')
      anchor.href = outputUrl(output)
      anchor.download = String(output.filename || 'output')
      anchor.rel = 'noreferrer'
      anchor.style.display = 'none'
      const host = rootRef.current !== null && rootRef.current !== undefined ? rootRef.current : document.body
      host.appendChild(anchor)
      anchor.click()
      anchor.remove()
    } catch (error) {
      showToast(t('copyFailed'))
    }
  }, [showToast])

  /** 在新标签打开输出。 */
  const openOutput = useCallback((output) => {
    try {
      if (typeof window === 'undefined' || output === null || output === undefined) return
      window.open(outputUrl(output), '_blank', 'noopener,noreferrer')
    } catch (error) {
      showToast(t('copyFailed'))
    }
  }, [showToast])

  /** 右键：按目标（空白 / 节点 / 结果卡片）开菜单，位置贴边夹取。 */
  const openContextMenu = useCallback((event) => {
    event.preventDefault()
    event.stopPropagation()
    const target = event.target
    const closest = (selector) => (target !== null && target !== undefined && typeof target.closest === 'function' ? target.closest(selector) : null)
    const nodeElement = closest('[data-cmf-node]')
    const resultElement = closest('[data-cmf-result]')
    let next = null
    if (nodeElement !== null) {
      const nodeId = String(nodeElement.getAttribute('data-cmf-node') || '')
      const source = graphRef.current
      const node = source !== null && source !== undefined && Array.isArray(source.nodes)
        ? source.nodes.find((entry) => String(entry.id) === nodeId)
        : undefined
      next = {
        kind: 'node',
        nodeId,
        nodeType: node === undefined ? '' : String(node.type || ''),
        nodeTitle: node === undefined ? nodeId : nodeTitleOf(node),
        hasGraph: true,
      }
    } else if (resultElement !== null) {
      const key = String(resultElement.getAttribute('data-cmf-result') || '')
      const card = resultCards.find((entry) => entry.key === key)
      next = card === undefined ? { kind: 'stage', hasGraph: graphRef.current !== null } : { kind: 'result', cardKey: key, output: card.output, hasGraph: true }
    } else {
      next = { kind: 'stage', hasGraph: graphRef.current !== null }
    }
    const items = contextMenuItemsFor(next.kind)
    const position = clampContextMenuPosition(
      event.clientX,
      event.clientY,
      CONTEXT_MENU_WIDTH,
      contextMenuHeight(items),
      typeof window !== 'undefined' ? window.innerWidth : 1024,
      typeof window !== 'undefined' ? window.innerHeight : 768,
    )
    setMenu(Object.assign(next, { x: position.x, y: position.y }))
  }, [resultCards])

  /** 执行右键菜单动作（先关菜单，再按 kind/id 分发；任何异常都吞掉，不影响画布）。 */
  const runContextMenuAction = useCallback((actionId) => {
    const current = menu
    setMenu(null)
    if (current === null) return
    try {
      if (current.kind === 'node') {
        if (actionId === 'params') {
          if (current.nodeId) openNodeParams(current.nodeId)
        } else if (actionId === 'center') {
          if (current.nodeId) centerOnNode(current.nodeId, 0.5)
        } else if (actionId === 'copyType') {
          void copyText(current.nodeType)
        } else if (actionId === 'copyTitle') {
          void copyText(current.nodeTitle)
        }
        return
      }
      if (current.kind === 'result') {
        if (actionId === 'preview') {
          if (current.output) setPreview(current.output)
        } else if (actionId === 'download') {
          if (current.output) downloadOutput(current.output)
        } else if (actionId === 'open') {
          if (current.output) openOutput(current.output)
        } else if (actionId === 'remove') {
          setResultCards((cards) => cards.filter((card) => card.key !== current.cardKey))
        }
        return
      }
      if (actionId === 'fit') fitView()
      else if (actionId === 'zoom100') resetView()
      else if (actionId === 'deselect') setSelectedIds([])
      else if (actionId === 'params') setParamsOpen((currentOpen) => !currentOpen)
      else if (actionId === 'refresh') refreshAll()
      else if (actionId === 'run') void startRun()
      else if (actionId === 'picker') setPickerOpen(true)
    } catch (error) {
      try {
        console.error('[dsh-comfy] context menu action failed:', error)
      } catch (inner) {
        /* ignore */
      }
    }
  }, [menu, openNodeParams, centerOnNode, fitView, resetView, refreshAll, startRun, copyText, downloadOutput, openOutput])

  /* ---------------- 渲染辅助 ---------------- */

  const renderedNodes = useMemo(() => {
    const nodes = graph ? graph.nodes : []
    return nodes.map((node) => {
      const size = normalizeNodeSize(node)
      const pos = positions[String(node.id)] || { x: Number(node.x) || 0, y: Number(node.y) || 0 }
      return { node, x: Number(pos.x) || 0, y: Number(pos.y) || 0, w: size.w, h: size.h }
    })
  }, [graph, positions])

  const byId = useMemo(() => {
    const map = new Map()
    for (const entry of renderedNodes) map.set(String(entry.node.id), entry)
    return map
  }, [renderedNodes])

  const edges = useMemo(() => {
    const list = []
    const edgeList = graph && Array.isArray(graph.edges) ? graph.edges : []
    const selection = selectedIds.map(String)
    for (const edge of edgeList) {
      if (list.length >= MAX_EDGES) break
      if (!edge || !edge.from || !edge.to) continue
      const from = byId.get(String(edge.from.node))
      const to = byId.get(String(edge.to.node))
      if (from === undefined || to === undefined) continue
      const outputCount = Array.isArray(from.node.outputs) && from.node.outputs.length > 0 ? from.node.outputs.length : 1
      const inputCount = Array.isArray(to.node.inputs) && to.node.inputs.length > 0 ? to.node.inputs.length : 1
      const y1 = from.y + portOffset(edge.from.slot, outputCount, from.h)
      const y2 = to.y + portOffset(edge.to.slot, inputCount, to.h)
      const accent = selection.indexOf(String(from.node.id)) !== -1 || selection.indexOf(String(to.node.id)) !== -1
      const muted = from.node.mode === 2 || from.node.mode === 4 || to.node.mode === 2 || to.node.mode === 4
      list.push({
        key: String(from.node.id) + '>' + String(to.node.id) + ':' + String(edge.from.slot) + ':' + String(edge.to.slot),
        d: edgeBezierPath(from.x + from.w, y1, to.x, y2),
        x: to.x,
        y: y2,
        accent,
        muted,
      })
    }
    return list
  }, [graph, byId, selectedIds])

  const edgeLayerSize = useMemo(() => {
    let width = 1
    let height = 1
    for (const entry of renderedNodes) {
      width = Math.max(width, entry.x + entry.w + 240)
      height = Math.max(height, entry.y + entry.h + 240)
    }
    for (const card of resultCards) {
      width = Math.max(width, card.x + card.w + 80)
      height = Math.max(height, card.y + card.h + 80)
    }
    return { width: Math.ceil(width), height: Math.ceil(height) }
  }, [renderedNodes, resultCards])

  const statusLabel = status === null ? t('loading') : reachable ? t('online') : t('offline')
  const runStateLabel = {
    idle: t('idle'),
    queued: t('queued'),
    running: t('running'),
    done: t('done'),
    error: t('failed'),
    unknown: t('statusUnknown'),
  }[run.state] || t('idle')
  const runStateTone = run.state === 'error' ? 'error' : run.state === 'done' ? 'ok' : run.state === 'running' ? 'accent' : run.state === 'queued' || run.state === 'unknown' ? 'warn' : 'idle'

  /* ---------------- 渲染 ---------------- */

  const header = h(
    'div',
    { className: 'dsh-comfy-head' },
    h('span', { className: 'dsh-comfy-brand', title: statusLabel },
      h(Glyph, { name: 'graph', size: 15 }),
      h('span', null, t('title')),
    ),
    h(StatusDot, {
      ok: reachable,
      busy: runActive,
      tone: reachable ? undefined : status === null ? 'idle' : 'warn',
      title: statusLabel,
    }),
    h(
      'button',
      {
        type: 'button',
        className: 'dsh-comfy-pick',
        'data-cmf': 'picker-toggle',
        'data-open': pickerOpen ? '1' : '0',
        disabled: !reachable && status !== null,
        title: selected === null ? t('selectWorkflow') : t('changeWorkflow'),
        onClick: () => {
          setPickerOpen((current) => !current)
          setQuery('')
        },
      },
      h('span', { className: 'dsh-comfy-pick-name', 'data-empty': selected === null ? '1' : '0' },
        selected === null ? t('selectWorkflow') : String(selected.name || selected.relPath || selected.id || '')),
      selected !== null && graph !== null ? h('span', { className: 'dsh-comfy-pick-meta' }, stats.nodeCount + ' ' + t('nodes')) : null,
      h(Glyph, { name: 'chevron', size: 13 }),
    ),
    h(IconButton, { icon: 'refresh', title: t('refresh'), size: 15, onClick: refreshAll }),
    h(IconButton, {
      icon: 'sliders',
      title: t('params'),
      size: 15,
      on: paramsOpen,
      data: 'params-toggle',
      disabled: graph === null,
      badge: overrideCount > 0 ? overrideCount : undefined,
      onClick: () => setParamsOpen((current) => !current),
    }),
  )

  let bannerNode = null
  if (banner !== null) {
    bannerNode = h(
      'div',
      { className: 'dsh-comfy-banner', 'data-kind': banner.kind === 'error' ? 'error' : 'warn' },
      h('span', { className: 'dsh-comfy-banner-icon' }, h(Glyph, { name: 'warn', size: 14 })),
      h('span', { className: 'dsh-comfy-banner-text' }, banner.text),
      h('span', { className: 'dsh-comfy-banner-actions' },
        h(IconButton, { icon: 'close', title: t('dismiss'), size: 12, onClick: () => setBanner(null) }),
      ),
    )
  }

  /* 画布区 */
  let stageChildren = null
  if (graph === null) {
    if (docLoading) {
      stageChildren = h(
        'div',
        { className: 'dsh-comfy-center' },
        h(Spinner),
        h('div', { className: 'dsh-comfy-state-hint' }, t('loadingWorkflow')),
      )
    } else if (status === null && statusError === '') {
      stageChildren = h(
        'div',
        { className: 'dsh-comfy-center' },
        h(Spinner),
        h('div', { className: 'dsh-comfy-state-hint' }, t('loading')),
      )
    } else if (docError) {
      stageChildren = h(
        'div',
        { className: 'dsh-comfy-center' },
        h('div', { className: 'dsh-comfy-state-icon', 'data-tone': 'error' }, h(Glyph, { name: 'warn', size: 20 })),
        h('div', { className: 'dsh-comfy-state-title' }, t('loadWorkflowsFailed')),
        h('div', { className: 'dsh-comfy-state-hint', 'data-tone': 'error' }, docError),
        h('div', { className: 'dsh-comfy-state-actions' },
          h('button', { type: 'button', className: 'dsh-comfy-btn', 'data-primary': '1', onClick: () => { if (selected !== null) void openWorkflow(selected) } }, t('retry')),
        ),
      )
    } else if (!reachable) {
      stageChildren = h(
        'div',
        { className: 'dsh-comfy-center' },
        h('div', { className: 'dsh-comfy-state-icon', 'data-tone': 'warn' }, h(Glyph, { name: 'offline', size: 20 })),
        h('div', { className: 'dsh-comfy-state-title' }, t('offlineTitle')),
        h('div', { className: 'dsh-comfy-state-hint' }, statusError && /HTTP|fetch|network|Failed/i.test(statusError) ? t('hostUnavailable') + '\n' + statusError : t('offlineHint')),
        h('div', { className: 'dsh-comfy-state-actions' },
          h('button', { type: 'button', className: 'dsh-comfy-btn', 'data-primary': '1', 'data-cmf': 'start-comfy', disabled: starting, onClick: startComfy },
            starting ? h(Spinner) : h(Glyph, { name: 'play', size: 13 }),
            starting ? t('startingComfy') : t('startComfy')),
          h('button', { type: 'button', className: 'dsh-comfy-btn', onClick: () => void loadStatus() }, t('refresh')),
        ),
      )
    } else if (selected === null) {
      stageChildren = h(
        'div',
        { className: 'dsh-comfy-center' },
        h('div', { className: 'dsh-comfy-state-icon' }, h(Glyph, { name: 'graph', size: 22 })),
        h('div', { className: 'dsh-comfy-state-title' }, t('emptyTitle')),
        h('div', { className: 'dsh-comfy-state-hint' }, t('emptyHint')),
        h('div', { className: 'dsh-comfy-state-actions' },
          h('button', { type: 'button', className: 'dsh-comfy-btn', 'data-primary': '1', 'data-cmf': 'empty-pick', onClick: () => setPickerOpen(true) }, t('pickWorkflow')),
        ),
      )
    } else {
      stageChildren = h(
        'div',
        { className: 'dsh-comfy-center' },
        h('div', { className: 'dsh-comfy-state-icon' }, h(Glyph, { name: 'graph', size: 20 })),
        h('div', { className: 'dsh-comfy-state-title' }, t('graphEmpty')),
        h('div', { className: 'dsh-comfy-state-hint' }, t('graphEmptyHint')),
      )
    }
  } else {
    const nodeEls = []
    for (const group of Array.isArray(graph.groups) ? graph.groups : []) {
      if (!group || !Number.isFinite(Number(group.x))) continue
      nodeEls.push(h(
        'div',
        {
          key: 'group-' + nodeEls.length,
          className: 'dsh-comfy-group',
          style: {
            left: (Number(group.x) || 0) + 'px',
            top: (Number(group.y) || 0) + 'px',
            width: Math.max(40, Number(group.w) || 0) + 'px',
            height: Math.max(30, Number(group.h) || 0) + 'px',
            '--cmf-group-accent': typeof group.color === 'string' && group.color !== '' ? group.color : 'var(--cmf-accent)',
          },
        },
        h('span', { className: 'dsh-comfy-group-head' }, h('span', { className: 'dsh-comfy-group-dot' }), String(group.title || '')),
      ))
    }
    nodeEls.push(h(
      'svg',
      { key: 'edges', className: 'dsh-comfy-edges', width: edgeLayerSize.width, height: edgeLayerSize.height, 'aria-hidden': true },
      edges.map((edge) => h('g', { key: edge.key },
        h('path', { className: 'dsh-comfy-edge', d: edge.d, 'data-accent': edge.accent ? '1' : '0', 'data-muted': edge.muted ? '1' : '0' }),
        h('circle', { className: 'dsh-comfy-edge-dot', cx: edge.x, cy: edge.y, r: 1.8, 'data-accent': edge.accent ? '1' : '0' }),
      )),
    ))
    for (const entry of renderedNodes) {
      nodeEls.push(h(NodeCard, {
        key: 'node-' + String(entry.node.id),
        node: entry.node,
        x: entry.x,
        y: entry.y,
        width: entry.w,
        height: entry.h,
        lod: (Number(view.k) || 1) < 0.5,
        selected: selectedIds.indexOf(String(entry.node.id)) !== -1,
        onPointerDown: onNodePointerDown,
        onDoubleClick: onNodeDoubleClick,
        onHeadClick: onNodeHeadClick,
      }))
    }
    for (const card of resultCards) {
      nodeEls.push(h(ResultCard, {
        key: 'result-' + card.key,
        card,
        onPointerDown: onResultPointerDown,
        onOpen: (output) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false
            return
          }
          setPreview(output)
        },
      }))
    }
    const stageBox = stageRef.current !== null && stageRef.current !== undefined && typeof stageRef.current.getBoundingClientRect === 'function'
      ? stageRef.current.getBoundingClientRect()
      : { width: 0, height: 0 }
    stageChildren = h(
      React.Fragment,
      null,
      h(
        'div',
        {
          className: 'dsh-comfy-world',
          style: { transform: 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')' },
        },
        nodeEls,
      ),
      marquee !== null
        ? h('div', {
          className: 'dsh-comfy-marquee',
          'data-cmf': 'marquee',
          style: {
            left: marquee.left + 'px',
            top: marquee.top + 'px',
            width: marquee.width + 'px',
            height: marquee.height + 'px',
          },
        })
        : null,
      h(
        'div',
        { className: 'dsh-comfy-zoom', 'data-cmf': 'zoom' },
        h(IconButton, { icon: 'minus', title: t('zoomOut'), size: 13, data: 'zoom-out', onClick: () => zoomBy(1 / ZOOM_STEP) }),
        h('button', { type: 'button', className: 'dsh-comfy-zoom-pct', title: t('resetView'), 'data-cmf': 'zoom-reset', onClick: resetView }, Math.round((Number(view.k) || 1) * 100) + '%'),
        h(IconButton, { icon: 'plus', title: t('zoomIn'), size: 13, data: 'zoom-in', onClick: () => zoomBy(ZOOM_STEP) }),
        h(IconButton, { icon: 'fit', title: t('fitView'), size: 13, data: 'zoom-fit', onClick: fitView }),
      ),
      stageBox.width > 0 ? h('div', { className: 'dsh-comfy-hintline' }, t('canvasHint')) : null,
    )
  }

  const resultsNode = outputs.length > 0
    ? h(
        'div',
        { className: 'dsh-comfy-results', 'data-cmf': 'results' },
        h('div', { className: 'dsh-comfy-results-head' },
          h(Glyph, { name: 'image', size: 12 }),
          t('results'),
          h('span', { className: 'dsh-comfy-dim' }, '· ' + outputs.length),
          h('span', { className: 'dsh-comfy-spacer' }),
          h('span', { className: 'dsh-comfy-dim' }, t('resultsHint')),
        ),
        h(
          'div',
          { className: 'dsh-comfy-results-row' },
          outputs.map((output, index) => {
            const kind = resultKindOf(output)
            const url = outputUrl(output)
            const label = String(output.label || output.filename || String(index + 1))
            return h(
              'button',
              {
                key: String(output.url || output.filename || index) + '#' + index,
                type: 'button',
                className: 'dsh-comfy-thumb',
                'data-cmf': 'output-thumb',
                title: label,
                onClick: () => setPreview(output),
              },
              h('span', { className: 'dsh-comfy-thumb-box' },
                kind === 'image'
                  ? h('img', { src: url, alt: label, draggable: false })
                  : h(Glyph, { name: kind === 'video' ? 'video' : kind === 'audio' ? 'music' : kind === '3d' ? 'cube' : kind === 'text' ? 'text' : 'file', size: 20 })),
              h('span', { className: 'dsh-comfy-thumb-label' }, label),
            )
          }),
        ),
      )
    : null

  const paramsNode = paramsOpen && graph !== null
    ? h(ParamsDrawer, {
        graph,
        overrides,
        focusNodeId,
        onChange: onWidgetChange,
        onReset: resetOverrides,
        onClose: () => setParamsOpen(false),
      })
    : null

  const runBar = h(
    'div',
    { className: 'dsh-comfy-runbar' },
    h('button', {
      type: 'button',
      className: 'dsh-comfy-btn',
      'data-primary': '1',
      'data-cmf': 'run',
      disabled: graph === null || runActive,
      title: t('run'),
      onClick: () => void startRun(),
    },
      runActive ? h(Spinner) : h(Glyph, { name: 'play', size: 13 }),
      runActive ? t('runningBtn') : t('run'),
    ),
    h('button', {
      type: 'button',
      className: 'dsh-comfy-btn',
      'data-danger': '1',
      'data-cmf': 'interrupt',
      disabled: !runActive,
      title: t('interrupt'),
      onClick: () => void interruptRun(),
    },
      h(Glyph, { name: 'stop', size: 13 }),
      t('interrupt'),
    ),
    h('span', { className: 'dsh-comfy-state' },
      h('span', {
        className: 'dsh-comfy-dot',
        'data-ok': run.state === 'done' ? '1' : '0',
        'data-busy': run.state === 'running' ? '1' : '0',
        style: runStateTone === 'warn' ? { background: 'var(--cmf-warn)' } : runStateTone === 'error' ? { background: 'var(--cmf-error)' } : runStateTone === 'accent' ? { background: 'var(--cmf-accent)' } : undefined,
      }),
      h('b', null, runStateLabel),
      run.queuePosition !== undefined ? h('span', null, '· ' + t('queuePosition') + run.queuePosition) : null,
      run.elapsedMs > 0 ? h('span', null, '· ' + formatElapsed(run.elapsedMs)) : null,
      run.number > 0 ? h('span', { className: 'dsh-comfy-dim' }, '#' + run.number) : null,
    ),
    h('span', { className: 'dsh-comfy-spacer' }),
    graph !== null
      ? h('span', { className: 'dsh-comfy-dim', style: { fontSize: '10.5px', whiteSpace: 'nowrap' } },
          stats.nodeCount + ' ' + t('nodes') + ' · ' + stats.edgeCount + ' ' + t('edges'))
      : null,
  )

  return h(
    'div',
    {
      className: 'dsh-comfy-root',
      ref: rootRef,
      tabIndex: -1,
      'data-cmf': 'root',
      'data-cmf-build': BUILD_STAMP,
      'data-cmf-status': reachable ? 'online' : status === null ? 'loading' : 'offline',
      onPointerDown: (event) => {
        const root = rootRef.current
        const target = event.target
        const interactive = target !== null && target !== undefined && typeof target.closest === 'function'
          && target.closest('input,textarea,select,button,a') !== null
        if (!interactive && root !== null && typeof root.focus === 'function') {
          try {
            root.focus({ preventScroll: true })
          } catch (error) {
            /* ignore */
          }
        }
      },
      onPointerEnter: () => {
        panelHoverRef.current = true
      },
      onPointerLeave: () => {
        panelHoverRef.current = false
      },
    },
    h('style', { 'data-dsh-comfy': '' }, CSS),
    header,
    bannerNode,
    h(
      'div',
      { className: 'dsh-comfy-body' },
      h(
        'div',
        {
          className: 'dsh-comfy-stage',
          ref: bindStage,
          'data-cmf': 'stage',
          'data-panning': dragging === 'pan' ? '1' : '0',
          'data-space': spaceHeld && dragging === '' ? '1' : '0',
          'data-boxing': dragging === 'box' ? '1' : '0',
          onPointerDown: onStagePointerDown,
          onPointerMove: onStagePointerMove,
          onPointerUp: onStagePointerUp,
          onPointerCancel: onStagePointerUp,
          onDoubleClick: onStageDoubleClick,
          onContextMenu: openContextMenu,
        },
        stageChildren,
      ),
      resultsNode,
      paramsNode,
    ),
    runBar,
    pickerOpen ? h(WorkflowPicker, {
      workflows,
      loading: workflowsLoading,
      error: workflowsError,
      query,
      onQuery: setQuery,
      selectedId: selected === null ? '' : selected.id,
      onPick: (item) => void openWorkflow(item),
      onClose: () => setPickerOpen(false),
      onRetry: () => void loadWorkflows(),
    }) : null,
    preview !== null ? h(PreviewOverlay, { output: preview, onClose: () => setPreview(null) }) : null,
    toast !== '' ? h('div', { className: 'dsh-comfy-toast', 'data-cmf': 'toast' }, toast) : null,
    menu !== null ? h(ContextMenu, { menu, onAction: runContextMenuAction }) : null,
  )
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

/** cordis 服务注入（模块级）。 */
module.exports.inject = ['slots', 'locale', 'sidebarRightTabs']

/** 兼容 ctx.get(service) 与 ctx.service 两种取法；拿不到就返回 undefined（不抛）。 */
function serviceOf(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(name)
      if (value !== undefined && value !== null) return value
    }
  } catch (error) {
    /* 没有声明 inject 时 ctx.get 会抛；继续走属性兜底 */
  }
  try {
    const value = ctx[name]
    if (value !== undefined && value !== null) return value
  } catch (error) {
    /* ignore */
  }
  return undefined
}

/** 注册字典并跟随宿主语言（每个调用都包一层 try：apply 绝不能抛）。 */
function installLocale(ctx, effect) {
  const locale = serviceOf(ctx, 'locale')
  if (locale === undefined) return
  const register = () => {
    if (typeof locale.register !== 'function') return () => {}
    return locale.register(NS, { zh: ZH, en: EN })
  }
  const subscribe = () => {
    const read = () => applyLocaleId(localeIdOf(locale))
    read()
    if (typeof locale.subscribe !== 'function') return () => {}
    return locale.subscribe(read)
  }
  try {
    effect(register, 'dsh-comfy: dictionaries')
  } catch (error) {
    try {
      register()
    } catch (inner) {
      /* ignore */
    }
  }
  try {
    effect(subscribe, 'dsh-comfy: follow host locale')
  } catch (error) {
    try {
      const dispose = subscribe()
      effect(() => dispose, 'dsh-comfy: dispose locale subscription')
    } catch (inner) {
      /* ignore */
    }
  }
}

/** 注册右侧栏 tab 类型 + 正文；apply 内部任何异常都在这里兜住，绝不冒泡到 GUI boot。 */
function apply(ctx) {
  try {
    const effect = typeof ctx.effect === 'function' ? (callback, label) => ctx.effect(callback, label) : (callback) => callback()
    installLocale(ctx, effect)
    const tabs = serviceOf(ctx, 'sidebarRightTabs')
    const slots = serviceOf(ctx, 'slots')
    if (tabs === undefined || slots === undefined) return
    if (typeof tabs.register !== 'function' || typeof slots.register !== 'function' || typeof slots.inject !== 'function') return

    effect(() => tabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      title: () => t('title'),
      guide: [{
        order: 31,
        title: () => t('title'),
        description: () => t('guideDesc'),
        icon: ComfyGuideIcon,
      }],
    }), 'dsh-comfy: tab type')

    effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
      locale: NS,
      inject: () => ({}),
    }, ComfyPanel)), 'dsh-comfy: tab body')
  } catch (error) {
    try {
      console.error('[dsh-comfy] apply failed:', error)
    } catch (inner) {
      /* 控制台都没有的极端环境也不能抛 */
    }
  }
}

module.exports.apply = apply

/** 纯函数自检钩子（tools/client-smoke.mjs 用；不参与界面）。 */
module.exports.__testHooks = {
  clamp,
  formatElapsed,
  truncate,
  previewValue,
  extOf,
  resultKindOf,
  outputUrl,
  normalizeNodeSize,
  nodeTitleOf,
  categoryAccentIndex,
  overrideKeyOf,
  setOverrideValue,
  overrideValueOf,
  coerceWidgetValue,
  optionLabel,
  matchComboOption,
  contentBounds,
  fitViewToBounds,
  zoomAtPoint,
  wheelZoom,
  screenToWorld,
  intersectsRect,
  selectNodesInBox,
  boxFromPoints,
  clampContextMenuPosition,
  contextMenuItemsFor,
  contextMenuHeight,
  CONTEXT_MENU_ITEMS,
  portOffset,
  edgeBezierPath,
  groupWorkflows,
  filterWorkflows,
  summarizeGraph,
  editableWidgets,
  buildResultCards,
  positionsFromGraph,
  largestGroupBox,
  largestGroupCenter,
  largestNodeBox,
  initialViewForGraph,
  localeIdOf,
  t,
  applyLocaleId,
  dictionaries: DICTIONARIES,
  CSS,
  ZOOM_MIN,
  ZOOM_MAX,
  FIT_MIN_ZOOM,
  FIT_MAX_ZOOM,
  CENTER_MIN_ZOOM,
  INITIAL_READABLE_MIN,
  INITIAL_FOCUS_ZOOM,
  PROGRESS_POLL_MS,
  DRAG_THRESHOLD_PX,
  CONTEXT_MENU_WIDTH,
  CONTEXT_MENU_ITEM_H,
  CONTEXT_MENU_SEP_H,
  CONTEXT_MENU_PAD,
  ComfyPanel: ComfyPanel,
  ComfyGuideIcon: ComfyGuideIcon,
}
