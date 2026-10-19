/**
 * dsh-comfy 客户端自检（无浏览器）：
 *   1. 用 vm 在伪 window 里执行生成的 client.js，抓 window.__ModuleLoader__.load 的 factory；
 *   2. 用假的 ctx 调 apply()，断言 tab 类型 / guide 入口 / slot 正文 / locale 字典都注册了，
 *      且 apply 拿不到服务时也不抛；
 *   3. 用真实 react + react-dom/server（从本机 infinite-canvas 的 web node_modules 借）SSR 渲染
 *      面板的加载态，断言不抛、结构来自本插件（.dsh-comfy-root / <style data-dsh-comfy>）；
 *   4. 单测 __testHooks 里的纯函数（布局 / 缩放 / 分组 / overrides / 输出种类 …）；
 *   5. 校验 client.js 与 client.body.js 同步（build-client --check）。
 *
 * 依赖：Node 22；React/ReactDOM 从 DSH 本机参考工程的 web node_modules 解析（可用环境变量覆盖：
 *   DSH_COMFY_REACT_ROOT）。不需要 jsdom、不需要网络、不需要浏览器。
 *
 * 用法：node tools/client-smoke.mjs   → PASS/FAIL + exit code
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'client.js')
const BODY = path.join(ROOT, 'client.body.js')
const DEFAULT_REACT_ROOT = path.join(ROOT, '..', 'apps', 'infinite-canvas', 'web')
const REACT_ROOT = process.env.DSH_COMFY_REACT_ROOT || DEFAULT_REACT_ROOT

let passed = 0
let failed = 0
const failures = []
function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  ✓ ' + name)
  } else {
    failed += 1
    const text = detail === undefined ? '' : ' — ' + String(detail)
    failures.push(name + text)
    console.log('  ✗ ' + name + text)
  }
}
function section(title) {
  console.log('\n== ' + title + ' ==')
}

// ── 0. 依赖 + 产物 ─────────────────────────────────────────────────────
section('环境与产物')
if (!fs.existsSync(CLIENT) || !fs.existsSync(BODY)) {
  console.error('缺少 client.js / client.body.js，先跑 node tools/build-client.mjs')
  process.exit(2)
}
let requireReact
try {
  requireReact = createRequire(path.join(REACT_ROOT, 'package.json'))
  const reactVersion = requireReact('react/package.json').version
  console.log('  React ' + reactVersion + ' @ ' + REACT_ROOT)
  ok('react / react-dom/server 可解析', typeof requireReact('react') === 'object' && typeof requireReact('react-dom/server').renderToStaticMarkup === 'function')
} catch (error) {
  console.error('解析 React 失败：' + String(error && error.message ? error.message : error))
  console.error('可用 DSH_COMFY_REACT_ROOT 指向含 react + react-dom 的 node_modules 目录')
  process.exit(2)
}
const React = requireReact('react')
const ReactDOMServer = requireReact('react-dom/server')

const buildCheck = (() => {
  try {
    const output = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-client.mjs'), '--check'], { encoding: 'utf8' })
    return { ok: true, output: output.trim() }
  } catch (error) {
    return { ok: false, output: String((error && error.stdout) || (error && error.message) || error) }
  }
})()
ok('client.js 与 client.body.js 同步（build --check）', buildCheck.ok, buildCheck.output)

// ── 1. 在伪 window 里加载产物 ──────────────────────────────────────────
section('模块加载（window.__ModuleLoader__ shim）')
const clientCode = fs.readFileSync(CLIENT, 'utf8')
let registration = null
const sandbox = {
  window: { __ModuleLoader__: { load(value) { registration = value } } },
  console,
}
vm.runInNewContext(clientCode, sandbox, { filename: 'client.js' })
ok('client.js 调用了 __ModuleLoader__.load', registration !== null)
ok('注册 id = dsh-comfy', registration !== null && registration.id === 'dsh-comfy', registration && registration.id)

const requireShim = (spec) => {
  if (spec === 'react') return React
  throw new Error('unexpected require: ' + spec)
}
const plugin = registration === null ? null : registration.factory(requireShim)
ok('factory 返回 {inject, apply, __testHooks}', plugin !== null && Array.isArray(plugin.inject) && typeof plugin.apply === 'function' && typeof plugin.__testHooks === 'object')
ok('inject 含 slots/locale/sidebarRightTabs',
  plugin !== null && ['slots', 'locale', 'sidebarRightTabs'].every((name) => plugin.inject.indexOf(name) !== -1),
  plugin && JSON.stringify(plugin.inject))

// ── 2. apply() 注册行为（假 ctx） ──────────────────────────────────────
section('apply() 注册')
function makeFakeCtx() {
  const state = { tabs: [], bodies: [], injections: [], locales: [], disposers: [], listeners: new Set(), localeId: 'zh-CN' }
  const locale = {
    register(namespace, dictionaries) {
      state.locales.push({ namespace, dictionaries })
      return () => {}
    },
    getLocale() {
      return { active: state.localeId }
    },
    subscribe(listener) {
      state.listeners.add(listener)
      return () => state.listeners.delete(listener)
    },
  }
  const sidebarRightTabs = {
    register(definition) {
      state.tabs.push(definition)
      return () => {}
    },
  }
  const slots = {
    register(options, Body) {
      state.bodies.push({ options, Body })
      return () => {}
    },
    inject(name, factory) {
      state.injections.push(name)
      return factory()
    },
  }
  const services = { locale, sidebarRightTabs, slots }
  const ctx = {
    effect(callback) {
      const dispose = callback()
      state.disposers.push(dispose)
      return dispose
    },
    get(name) {
      return services[name]
    },
    locale,
    sidebarRightTabs,
    slots,
  }
  return { ctx, state }
}

const { ctx, state } = makeFakeCtx()
let applyError = null
try {
  plugin.apply(ctx)
} catch (error) {
  applyError = error
}
ok('apply() 不抛异常', applyError === null, applyError && applyError.message)

const tab = state.tabs[0]
ok('注册了 1 个 sidebarRightTabs 类型', state.tabs.length === 1)
ok('tab id/kind = dsh-comfy/comfy', tab !== undefined && tab.id === 'dsh-comfy' && tab.kind === 'comfy', tab && JSON.stringify({ id: tab.id, kind: tab.kind }))
ok('guide 入口 order=31、标题 ComfyUI、description 非空', tab !== undefined && Array.isArray(tab.guide) && tab.guide.length === 1
  && tab.guide[0].order === 31 && tab.guide[0].title() === 'ComfyUI' && typeof tab.guide[0].description() === 'string' && tab.guide[0].description() !== '')
ok('guide 入口带 icon 组件', tab !== undefined && typeof tab.guide[0].icon === 'function')

const body = state.bodies[0]
ok('注册了 sidebar.right.pane.tab 正文', state.bodies.length === 1)
ok('正文 slot 名/key 正确', body !== undefined && body.options.name === 'sidebar.right.pane.tab' && body.options.key === 'dsh-comfy' && body.options.locale === 'dsh-comfy')
ok('正文 Body 是组件函数', body !== undefined && typeof body.Body === 'function')
ok('slots.inject 指向 sidebar.right.pane.tab', state.injections.indexOf('sidebar.right.pane.tab') !== -1)

const dict = state.locales[0]
ok('注册了 locale 字典（zh + en）', dict !== undefined && dict.namespace === 'dsh-comfy'
  && dict.dictionaries && dict.dictionaries.zh && dict.dictionaries.en)

// 切到英文 → 标题回调 + t() 立刻变化
state.localeId = 'en-US'
for (const listener of [...state.listeners]) listener()
ok('跟随宿主 locale：切 en 后 guide 描述变英文',
  tab !== undefined && tab.guide[0].description() === plugin.__testHooks.dictionaries.en.guideDesc,
  tab && tab.guide[0].description())
state.localeId = 'zh-CN'
for (const listener of [...state.listeners]) listener()
ok('跟随宿主 locale：切回 zh', plugin.__testHooks.t('guideDesc') === plugin.__testHooks.dictionaries.zh.guideDesc)

// 服务缺失 / ctx.get 抛错时 apply 不能抛（GUI boot 安全）
let degradedError = null
try {
  plugin.apply({
    effect(callback) { callback() },
    get() { throw new Error('cannot get property without inject') },
  })
} catch (error) {
  degradedError = error
}
ok('ctx.get 抛错时 apply 仍不抛', degradedError === null, degradedError && degradedError.message)

let emptyCtxError = null
try {
  plugin.apply({})
} catch (error) {
  emptyCtxError = error
}
ok('空 ctx（无服务）时 apply 不抛', emptyCtxError === null, emptyCtxError && emptyCtxError.message)

// ── 3. SSR 渲染加载态 ─────────────────────────────────────────────────
section('SSR 渲染（react-dom/server）')
const hooks = plugin.__testHooks
let markup = ''
let ssrError = null
try {
  markup = ReactDOMServer.renderToStaticMarkup(React.createElement(body.Body, {}))
} catch (error) {
  ssrError = error
}
ok('SSR 渲染加载态不抛异常', ssrError === null, ssrError && ssrError.stack)
ok('输出含 .dsh-comfy-root', markup.indexOf('class="dsh-comfy-root"') !== -1)
ok('输出含插件样式 <style data-dsh-comfy>', markup.indexOf('data-dsh-comfy') !== -1 && markup.indexOf('<style') !== -1)
ok('加载态文案来自 ZH 字典', markup.indexOf(plugin.__testHooks.dictionaries.zh.loading) !== -1, markup.slice(0, 200) + '…')
ok('顶栏含工作流选择占位（选择工作流）', markup.indexOf(plugin.__testHooks.dictionaries.zh.selectWorkflow) !== -1)
ok('SSR 输出含运行栏按钮', markup.indexOf('data-cmf="run"') !== -1 && markup.indexOf('data-cmf="interrupt"') !== -1)
ok('SSR 输出不含 window 专属属性泄漏（无 [object Object]）', markup.indexOf('[object Object]') === -1)

let guideMarkup = ''
let guideError = null
try {
  guideMarkup = ReactDOMServer.renderToStaticMarkup(React.createElement(plugin.__testHooks.ComfyGuideIcon, { size: 16 }))
} catch (error) {
  guideError = error
}
ok('guide 图标可 SSR', guideError === null && guideMarkup.indexOf('<svg') !== -1)

// ── 4. 纯函数单测 ──────────────────────────────────────────────────────
section('纯函数：数值 / 文本')
ok('clamp 上下界', hooks.clamp(5, 0, 3) === 3 && hooks.clamp(-1, 0, 3) === 0 && hooks.clamp(2, 0, 3) === 2)
ok('clamp 非数字回落 min', hooks.clamp(Number.NaN, 1, 3) === 1 && hooks.clamp('x', 1, 3) === 1)
ok('formatElapsed 0 → 0.0s', hooks.formatElapsed(0) === '0.0s')
ok('formatElapsed 1234 → 1.2s', hooks.formatElapsed(1234) === '1.2s')
ok('formatElapsed 65000 → 1m05s', hooks.formatElapsed(65000) === '1m05s')
ok('truncate 中文/ascii', hooks.truncate('abcdef', 4) === 'abc…' && hooks.truncate('ab', 4) === 'ab')
ok('previewValue 各类值', hooks.previewValue(true) === 'true' && hooks.previewValue(null) === '—' && hooks.previewValue(3.5) === '3.5' && hooks.previewValue([1, 2]).indexOf('2 items') !== -1)
ok('extOf', hooks.extOf('a\\b\\C.PNG') === 'png' && hooks.extOf('noext') === '')

section('纯函数：输出 / overrides / widget')
ok('resultKindOf 扩展名兜底', hooks.resultKindOf({ filename: 'x.png' }) === 'image' && hooks.resultKindOf({ filename: 'x.mp4' }) === 'video'
  && hooks.resultKindOf({ filename: 'x.glb' }) === '3d' && hooks.resultKindOf({ filename: 'x.mp3' }) === 'audio' && hooks.resultKindOf({ filename: 'x.bin' }) === 'file')
ok('resultKindOf 优先 host kind', hooks.resultKindOf({ kind: 'text', filename: 'x.png' }) === 'text')
ok('outputUrl 用 host url', hooks.outputUrl({ url: '/api/dsh-comfy/view?a=1' }) === '/api/dsh-comfy/view?a=1')
const builtUrl = hooks.outputUrl({ filename: 'a b.png', subfolder: 'sub dir', type: 'output' })
ok('outputUrl 兜底拼 /view', builtUrl.indexOf('/api/dsh-comfy/view?filename=a%20b.png') === 0 && builtUrl.indexOf('subfolder=sub%20dir') !== -1)
ok('overrideKeyOf/set/read 往返', (() => {
  const key = hooks.overrideKeyOf(9, 'seed')
  const next = hooks.setOverrideValue({}, 9, 'seed', 42)
  return key === '9.seed' && next[key] === 42 && hooks.overrideValueOf(next, 9, 'seed', 1) === 42 && hooks.overrideValueOf(next, 9, 'cfg', 7) === 7
})())
ok('setOverrideValue undefined 删除键', Object.keys(hooks.setOverrideValue({ '1.x': 1 }, 1, 'x', undefined)).length === 0)
ok('coerceWidgetValue number/bool/text', hooks.coerceWidgetValue('number', '2.5') === 2.5 && hooks.coerceWidgetValue('number', '') === ''
  && hooks.coerceWidgetValue('bool', 'true') === true && hooks.coerceWidgetValue('text', 5) === '5')
ok('matchComboOption 保留原始类型', hooks.matchComboOption([1, 2, 3], '2') === 2 && hooks.matchComboOption(['a', 'b'], 'b') === 'b')
ok('editableWidgets 只留 4 种 kind', (() => {
  const widgets = hooks.editableWidgets({ widgets: [{ name: 'a', kind: 'text' }, { name: 'b', kind: 'link' }, { name: 'c', kind: 'combo' }, { name: '', kind: 'text' }] })
  return widgets.length === 2 && widgets[0].name === 'a' && widgets[1].name === 'c'
})())

section('纯函数：画布布局 / 缩放')
const size = hooks.normalizeNodeSize({ w: 10, h: 1000 })
ok('normalizeNodeSize 夹取尺寸', size.w >= 112 && size.w <= 420 && size.h >= 46 && size.h <= 340, JSON.stringify(size))
const accent = hooks.categoryAccentIndex('image/upscale')
ok('categoryAccentIndex 稳定且 0..7', accent === hooks.categoryAccentIndex('image/upscale') && accent >= 0 && accent <= 7)
ok('portOffset 在节点内且随 index 增大', (() => {
  const first = hooks.portOffset(0, 3, 200)
  const last = hooks.portOffset(2, 3, 200)
  return first > 22 && last < 200 && last > first
})())
const bezier = hooks.edgeBezierPath(0, 0, 100, 50)
ok('edgeBezierPath 形状正确', bezier.indexOf('M0 0') === 0 && bezier.indexOf(' C') !== -1 && bezier.indexOf('NaN') === -1)
ok('edgeBezierPath 同 x 也不 NaN', hooks.edgeBezierPath(10, 10, 10, 200).indexOf('NaN') === -1)

const bounds = hooks.contentBounds([{ x: 0, y: 0, w: 100, h: 50 }, { x: 200, y: 100, w: 100, h: 50 }])
ok('contentBounds 合并矩形', bounds !== null && bounds.minX === 0 && bounds.minY === 0 && bounds.maxX === 300 && bounds.maxY === 150)
ok('contentBounds 空输入 → null', hooks.contentBounds([]) === null)
const fitted = hooks.fitViewToBounds(bounds, 560, 980, 36)
ok('fitViewToBounds 小工作流被放大上限 0.85', fitted.k === hooks.FIT_MAX_ZOOM, JSON.stringify(fitted))
ok('fitViewToBounds 居中且缩放在 fit 范围内', (() => {
  if (fitted === null || !(fitted.k >= hooks.FIT_MIN_ZOOM && fitted.k <= hooks.FIT_MAX_ZOOM)) return false
  const screenX = fitted.x + bounds.minX * fitted.k
  const screenY = fitted.y + bounds.minY * fitted.k
  const screenMaxX = fitted.x + bounds.maxX * fitted.k
  const screenMaxY = fitted.y + bounds.maxY * fitted.k
  return screenX >= 34 && screenY >= 34 && screenMaxX <= 560 - 34 && screenMaxY <= 980 - 34
})(), JSON.stringify(fitted))

// 真实工作流常常很宽：fit 只算出 20-30%，必须被夹到 0.45（Lead 的真机验收项），且内容中心仍在视口中心。
const wideBounds = hooks.contentBounds([{ x: 0, y: 0, w: 1680, h: 840 }])
const wideFit = hooks.fitViewToBounds(wideBounds, 560, 980, 36)
ok('fitViewToBounds 宽工作流下限 0.45（不再缩成 23%）', wideFit.k === hooks.FIT_MIN_ZOOM, JSON.stringify(wideFit))
ok('fitViewToBounds 夹取后内容中心对齐视口中心', (() => {
  const centerX = wideFit.x + ((wideBounds.minX + wideBounds.maxX) / 2) * wideFit.k
  const centerY = wideFit.y + ((wideBounds.minY + wideBounds.maxY) / 2) * wideFit.k
  return Math.abs(centerX - 280) < 1 && Math.abs(centerY - 490) < 1
})(), JSON.stringify(wideFit))
ok('手动滚轮仍可缩到 0.15（fit 下限不限制手动）', (() => {
  let view = wideFit
  for (let index = 0; index < 20; index++) view = hooks.wheelZoom(view, 280, 490, 400)
  return view.k === hooks.ZOOM_MIN
})())
const small = hooks.fitViewToBounds(bounds, 0, 0, 36)
ok('fitViewToBounds 视口为 0（SSR/jsdom）时安全', small.k === 0.8 && small.x === 36 && small.y === 36)

const view0 = { x: 40, y: 30, k: 1.2 }
const worldBefore = hooks.screenToWorld(view0, 200, 300)
const view1 = hooks.zoomAtPoint(view0, 200, 300, 2)
const worldAfter = hooks.screenToWorld(view1, 200, 300)
ok('zoomAtPoint 指针下的世界点不动', Math.abs(worldBefore.x - worldAfter.x) < 0.001 && Math.abs(worldBefore.y - worldAfter.y) < 0.001,
  JSON.stringify({ worldBefore, worldAfter }))
const view2 = hooks.wheelZoom(view0, 200, 300, -120)
ok('wheelZoom 向上放大且不越界', view2.k > view0.k && view2.k <= hooks.ZOOM_MAX)
const view3 = hooks.wheelZoom({ x: 0, y: 0, k: 2.5 }, 0, 0, 10000)
ok('wheelZoom 缩放下限', view3.k === hooks.ZOOM_MIN)

section('纯函数：工作流分组 / 搜索 / graph 概要')
const items = [
  { id: 'user::a.json', source: 'user', name: 'a.json', relPath: 'a.json', kind: 'ui' },
  { id: 'templates::b.json', source: 'templates', name: 'b.json', relPath: 'b.json', kind: 'api' },
  { id: 'workspace::sub/c.json', source: 'workspace', name: 'c.json', relPath: 'sub/c.json', kind: 'ui' },
  { id: 'other::d.json', source: 'other', name: 'd.json', relPath: 'd.json', kind: 'ui' },
]
const groups = hooks.groupWorkflows(items, [{ id: 'user', label: '本机' }, { id: 'workspace', label: '工作区' }, { id: 'templates', label: '官方模板' }], { user: 'U' })
ok('groupWorkflows 固定来源顺序（user/workspace/templates）+ 未知来源后置',
  groups.length === 4 && groups[0].id === 'user' && groups[1].id === 'workspace' && groups[2].id === 'templates' && groups[3].id === 'other',
  groups.map((group) => group.id).join(','))
ok('groupWorkflows 用 provider label / 兜底 label', groups[0].label === '本机' && groups[1].label === '工作区' && groups[3].label === 'other')
ok('groupWorkflows 统计每组的 count', groups[0].count === 1 && groups[2].count === 1)
ok('filterWorkflows 大小写不敏感匹配 name/relPath/id', (() => {
  const byName = hooks.filterWorkflows(items, 'C.JSON')
  const byPath = hooks.filterWorkflows(items, 'sub/')
  const byId = hooks.filterWorkflows(items, 'workspace::')
  const empty = hooks.filterWorkflows(items, '   ')
  return byName.length === 1 && byPath.length === 1 && byId.length === 1 && empty.length === 4 && hooks.filterWorkflows(items, 'zzz').length === 0
})())
const summary = hooks.summarizeGraph({
  nodes: [
    { id: '1', type: 'KSampler', mode: 0 },
    { id: '2', type: 'MutedNode', mode: 2, widgets: [{ name: 'a' }, { name: 'b' }] },
    { id: '3', type: 'CustomThing', missing: true, widgets: [{ name: 'c' }] },
  ],
  edges: [{}, {}],
})
ok('summarizeGraph 本地统计', summary.nodeCount === 3 && summary.edgeCount === 2 && summary.mutedCount === 1
  && summary.missingTypes.length === 1 && summary.missingTypes[0] === 'CustomThing' && summary.widgetCount === 3, JSON.stringify(summary))
ok('summarizeGraph 优先 host stats', hooks.summarizeGraph({ nodes: [{ id: '1' }], edges: [], stats: { nodeCount: 9, edgeCount: 8, missingTypes: ['X'], mutedCount: 2 } }).nodeCount === 9)
ok('positionsFromGraph', (() => {
  const map = hooks.positionsFromGraph({ nodes: [{ id: 'a', x: 5, y: 6 }, { id: 'b', x: 7, y: 8 }] })
  return map.a.x === 5 && map.b.y === 8 && Object.keys(map).length === 2
})())
ok('largestGroupCenter 取面积最大的分组中心', (() => {
  const center = hooks.largestGroupCenter([{ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 200, w: 400, h: 300 }, { x: 0, y: 0, w: 10, h: 10 }])
  return center !== null && center.x === 300 && center.y === 350
})(), JSON.stringify(hooks.largestGroupCenter([{ x: 100, y: 200, w: 400, h: 300 }])))
ok('largestGroupCenter 无合法分组 → null', hooks.largestGroupCenter([]) === null && hooks.largestGroupCenter(null) === null
  && hooks.largestGroupCenter([{ x: 'a', y: 1, w: 2, h: 2 }, { x: 0, y: 0, w: 0, h: 5 }]) === null)
ok('可读优先常量：fit 下限 0.55 判定 / 聚焦 0.62', hooks.INITIAL_READABLE_MIN === 0.55 && hooks.INITIAL_FOCUS_ZOOM === 0.62)

// ── 打开工作流时的初始视图（可读优先） ─────────────────────────────
const wideGraph = {
  nodes: [
    { id: '1', type: 'A', x: 0, y: 0, w: 200, h: 100 },
    { id: '2', type: 'B', x: 900, y: 400, w: 200, h: 100 },
  ],
  groups: [
    { title: '小', x: 0, y: 0, w: 200, h: 100 },
    { title: '大', x: 800, y: 400, w: 400, h: 300 },
  ],
}
const wideInitial = hooks.initialViewForGraph(wideGraph, 560, 980, 36)
ok('initialViewForGraph 宽图 → 聚焦模式 k=0.62', wideInitial.mode === 'focus' && wideInitial.view.k === 0.62, JSON.stringify(wideInitial))
ok('initialViewForGraph 聚焦最大分组中心', Math.abs(wideInitial.view.x - (280 - 1000 * 0.62)) < 0.02
  && Math.abs(wideInitial.view.y - (490 - 550 * 0.62)) < 0.02, JSON.stringify(wideInitial))
ok('initialViewForGraph 聚焦视图数值有限', Number.isFinite(wideInitial.view.x) && Number.isFinite(wideInitial.view.y) && Number.isFinite(wideInitial.view.k))

const noGroupGraph = {
  nodes: [
    { id: '1', type: 'A', x: 0, y: 0, w: 400, h: 200 },
    { id: '2', type: 'B', x: 900, y: 500, w: 100, h: 100 },
  ],
  groups: [],
}
const noGroupInitial = hooks.initialViewForGraph(noGroupGraph, 560, 980, 36)
ok('initialViewForGraph 无分组 → 聚焦最大节点中心', noGroupInitial.mode === 'focus'
  && Math.abs(noGroupInitial.view.x - (280 - 200 * 0.62)) < 0.02
  && Math.abs(noGroupInitial.view.y - (490 - 100 * 0.62)) < 0.02, JSON.stringify(noGroupInitial))

const smallGraph = { nodes: [{ id: '1', type: 'A', x: 0, y: 0, w: 300, h: 150 }], groups: [] }
const smallInitial = hooks.initialViewForGraph(smallGraph, 560, 980, 36)
ok('initialViewForGraph 小图 → 整图 fit（k>=0.55）', smallInitial.mode === 'fit' && smallInitial.view.k === hooks.FIT_MAX_ZOOM, JSON.stringify(smallInitial))

// 真机 SF 工作流：最大分组是横跨 1780px 的稀疏链，bbox 中心会落在空档；
// 可读优先应落在“采样/导演节点”（H3SeamlessChainSampler）上。
const anchorGraph = {
  nodes: [
    { id: '1', type: 'UNETLoader', x: -900, y: 0, w: 300, h: 100 },
    { id: '10', type: 'H3SeamlessChainSampler', x: 900, y: 100, w: 300, h: 240 },
    { id: '2', type: 'BlockSparseAttention', x: -400, y: 500, w: 300, h: 250 },
  ],
  groups: [{ title: '大', x: -1000, y: -50, w: 2000, h: 900 }],
}
const anchorInitial = hooks.initialViewForGraph(anchorGraph, 560, 980, 36)
ok('initialViewForGraph 优先落在采样/导演节点', anchorInitial.mode === 'focus'
  && Math.abs(anchorInitial.view.x - (280 - 1050 * 0.62)) < 0.02
  && Math.abs(anchorInitial.view.y - (490 - 220 * 0.62)) < 0.02, JSON.stringify(anchorInitial))
ok('initialViewForGraph 零视口/空图安全', (() => {
  const zero = hooks.initialViewForGraph(wideGraph, 0, 0, 36)
  const empty = hooks.initialViewForGraph({ nodes: [], groups: [] }, 560, 980, 36)
  return Number.isFinite(zero.view.x) && Number.isFinite(zero.view.y) && zero.view.k > 0
    && Number.isFinite(empty.view.x) && Number.isFinite(empty.view.y)
})())

section('纯函数：结果卡片')
const resultGraph = {
  nodes: [
    { id: '9', type: 'SaveImage', x: 100, y: 200, w: 240, h: 120, widgets: [] },
    { id: '10', type: 'SaveAudio', x: 400, y: 200, w: 240, h: 120, widgets: [] },
  ],
  edges: [],
}
const cards = hooks.buildResultCards([
  { nodeId: '9', kind: 'image', filename: 'a.png', url: '/api/dsh-comfy/view?a=1' },
  { nodeId: '9', kind: 'image', filename: 'b.png', url: '/api/dsh-comfy/view?b=1' },
  { nodeId: '99', kind: 'file', filename: 'c.bin', url: '/api/dsh-comfy/view?c=1' },
], resultGraph, { '9': { x: 120, y: 210 } })
ok('buildResultCards 数量正确', cards.length === 3)
ok('buildResultCards 图片卡片挂在节点右侧', cards[0].x > 120 + 240 && cards[0].y >= 210 && cards[0].kind === 'image')
ok('buildResultCards 同节点第二个输出错开', cards[1].x !== cards[0].x || cards[1].y !== cards[0].y)
ok('buildResultCards key 唯一', new Set(cards.map((card) => card.key)).size === cards.length)
ok('buildResultCards 未知节点也给出位置', Number.isFinite(cards[2].x) && Number.isFinite(cards[2].y))

section('纯函数：框选 / 右键菜单')
ok('intersectsRect 相交/不相交', hooks.intersectsRect({ x0: 0, y0: 0, x1: 100, y1: 100 }, { x: 50, y: 50, w: 100, h: 100 }) === true
  && hooks.intersectsRect({ x0: 0, y0: 0, x1: 100, y1: 100 }, { x: 200, y: 200, w: 50, h: 50 }) === false
  && hooks.intersectsRect({ x0: 100, y0: 0, x1: 0, y1: 100 }, { x: 50, y: 50, w: 10, h: 10 }) === true, '反向框也要正确')
ok('intersectsRect 边界只接触不算相交', hooks.intersectsRect({ x0: 0, y0: 0, x1: 100, y1: 100 }, { x: 100, y: 0, w: 50, h: 50 }) === false)
ok('selectNodesInBox 命中相交节点', (() => {
  const entries = [
    { id: 'a', x: 0, y: 0, w: 100, h: 100 },
    { id: 'b', x: 200, y: 200, w: 100, h: 100 },
    { id: 'c', x: 90, y: 90, w: 40, h: 40 },
  ]
  const hits = hooks.selectNodesInBox(entries, { x0: 0, y0: 0, x1: 120, y1: 120 })
  return hits.length === 2 && hits.indexOf('a') !== -1 && hits.indexOf('c') !== -1 && hits.indexOf('b') === -1
})())
ok('selectNodesInBox 空/无效输入安全', hooks.selectNodesInBox([], { x0: 0, y0: 0, x1: 1, y1: 1 }).length === 0
  && hooks.selectNodesInBox(null, null).length === 0)
ok('boxFromPoints 归一化负向拖拽', (() => {
  const box = hooks.boxFromPoints(120, 90, 20, 30)
  return box.left === 20 && box.top === 30 && box.width === 100 && box.height === 60
})())
ok('clampContextMenuPosition 内部不移动', (() => {
  const position = hooks.clampContextMenuPosition(120, 90, 210, 200, 1024, 768)
  return position.x === 120 && position.y === 90
})())
ok('clampContextMenuPosition 贴边夹取', (() => {
  const right = hooks.clampContextMenuPosition(1000, 700, 210, 200, 1024, 768)
  const corner = hooks.clampContextMenuPosition(-50, -50, 210, 200, 1024, 768)
  return right.x === 1024 - 210 - 6 && right.y === 768 - 200 - 6 && corner.x === 6 && corner.y === 6
})(), JSON.stringify(hooks.clampContextMenuPosition(1000, 700, 210, 200, 1024, 768)))
ok('contextMenuItemsFor 三类菜单项顺序正确', (() => {
  const stage = hooks.contextMenuItemsFor('stage').map((item) => item.id)
  const node = hooks.contextMenuItemsFor('node').map((item) => item.id)
  const result = hooks.contextMenuItemsFor('result').map((item) => item.id)
  return stage.join(',') === 'fit,zoom100,deselect,params,refresh,run,picker'
    && node.join(',') === 'params,center,copyType,copyTitle'
    && result.join(',') === 'preview,download,open,remove'
    && hooks.contextMenuItemsFor('nope').length === 0
})())
ok('contextMenuItemsFor 返回副本（可安全修改）', (() => {
  const first = hooks.contextMenuItemsFor('node')
  first[0].labelKey = 'tampered'
  return hooks.contextMenuItemsFor('node')[0].labelKey === 'ctxOpenParams'
})())
ok('contextMenuHeight 估算含分隔线', hooks.contextMenuHeight(hooks.contextMenuItemsFor('stage')) === hooks.CONTEXT_MENU_PAD * 2 + 7 * hooks.CONTEXT_MENU_ITEM_H + hooks.CONTEXT_MENU_SEP_H)
ok('右键菜单文案键 ZH/EN 都存在', (() => {
  for (const kind of ['stage', 'node', 'result']) {
    for (const item of hooks.contextMenuItemsFor(kind)) {
      const zh = hooks.dictionaries.zh[item.labelKey]
      const en = hooks.dictionaries.en[item.labelKey]
      if (typeof zh !== 'string' || zh === '' || typeof en !== 'string' || en === '') return false
    }
  }
  return typeof hooks.dictionaries.zh.copied === 'string' && typeof hooks.dictionaries.en.copied === 'string'
})())
ok('提示条更新为 ComfyUI 鼠标习惯', hooks.dictionaries.zh.canvasHint.indexOf('框选') !== -1
  && hooks.dictionaries.zh.canvasHint.indexOf('右键菜单') !== -1 && hooks.dictionaries.zh.canvasHint.indexOf('中键') !== -1
  && hooks.dictionaries.en.canvasHint.indexOf('box-select') !== -1 && hooks.dictionaries.en.canvasHint.indexOf('right-click') !== -1)

section('纯函数：locale / 字典')
ok('localeIdOf 兼容 {active}', hooks.localeIdOf({ getLocale: () => ({ active: 'en-US' }) }) === 'en-US')
ok('localeIdOf 兼容 string', hooks.localeIdOf({ getLocale: () => 'zh-CN' }) === 'zh-CN')
ok('localeIdOf 兼容嵌套 active 对象', hooks.localeIdOf({ getLocale: () => ({ active: { id: 'en' } }) }) === 'en')
const zhKeys = Object.keys(hooks.dictionaries.zh).sort()
const enKeys = Object.keys(hooks.dictionaries.en).sort()
ok('ZH/EN 键集合一致（' + zhKeys.length + ' 键）', zhKeys.length === enKeys.length && zhKeys.every((key, index) => key === enKeys[index]),
  zhKeys.filter((key) => enKeys.indexOf(key) === -1).slice(0, 5).join(','))
ok('所有字典值非空字符串', zhKeys.every((key) => typeof hooks.dictionaries.zh[key] === 'string' && hooks.dictionaries.zh[key] !== '')
  && enKeys.every((key) => typeof hooks.dictionaries.en[key] === 'string' && hooks.dictionaries.en[key] !== ''))
ok('t() 回落到 ZH / 未知键原样', hooks.t('__nope__') === '__nope__')
ok('t() 支持 {n} 插值', hooks.t('workflowsTotal', { n: 12 }).indexOf('12') !== -1)

section('样式约束')
ok('CSS 含 --cmf-* 主题变量', hooks.CSS.indexOf('--cmf-bg:') !== -1 && hooks.CSS.indexOf('--cmf-accent:') !== -1)
ok('CSS 含框选遮罩 / 右键菜单 / toast', hooks.CSS.indexOf('.dsh-comfy-marquee') !== -1
  && hooks.CSS.indexOf('.dsh-comfy-ctx') !== -1 && hooks.CSS.indexOf('.dsh-comfy-toast') !== -1)
ok('CSS 含框选 crosshair 与平移 grabbing 光标', hooks.CSS.indexOf('.dsh-comfy-stage[data-boxing="1"]{cursor:crosshair}') !== -1
  && hooks.CSS.indexOf('.dsh-comfy-stage[data-panning="1"]{cursor:grabbing}') !== -1)
ok('CSS 跟随系统深色（prefers-color-scheme）', hooks.CSS.indexOf('prefers-color-scheme: dark') !== -1)
ok('CSS 不写死白底', hooks.CSS.indexOf('background:#fff') === -1 && hooks.CSS.indexOf('background:#ffffff') === -1)
ok('CSS 引用 DSH 令牌 --dsw-alias-*', hooks.CSS.indexOf('--dsw-alias-bg-base') !== -1 && hooks.CSS.indexOf('--dsw-alias-brand-primary') !== -1)
// 深色主题的 brand-primary 在 DSH 里是白色：on-accent 必须是深色墨，否则 primary 按钮白底白字（真机 P0）
ok('深色主题 --cmf-on-accent 用深色墨（非白）', hooks.CSS.indexOf('--cmf-on-accent:#151517') !== -1, 'missing --cmf-on-accent:#151517')
ok('primary 按钮文字色走 --cmf-on-accent', /\[data-primary="1"\]\{[^}]*color:var\(--cmf-on-accent\)/.test(hooks.CSS))
ok('ibtn 角标文字色走 --cmf-on-accent', /\.dsh-comfy-ibtn-badge\{[^}]*color:var\(--cmf-on-accent\)/.test(hooks.CSS))
ok('CSS 中没有写死 color:#fff 的文字', hooks.CSS.indexOf('color:#fff') === -1 && hooks.CSS.indexOf('color:#ffffff') === -1)
ok('所有样式类名带 .dsh-comfy- 前缀', (() => {
  const classes = [...hooks.CSS.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1])
  return classes.length > 0 && classes.every((name) => name.indexOf('dsh-comfy-') === 0 || name.indexOf('cmf-') === 0)
})(), (() => {
  const classes = [...hooks.CSS.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1])
  return classes.filter((name) => name.indexOf('dsh-comfy-') !== 0).slice(0, 5).join(',')
})())
ok('轮询间隔 800ms（CONTRACT §6）', hooks.PROGRESS_POLL_MS === 800)
ok('拖拽阈值 3px（懒捕获，避免 pointer capture 把 click 重定向到 stage）', hooks.DRAG_THRESHOLD_PX === 3)
ok('缩放范围 0.15–2.5', hooks.ZOOM_MIN === 0.15 && hooks.ZOOM_MAX === 2.5)
ok('fit 夹取 0.45–0.85 / 双击居中下限 0.6', hooks.FIT_MIN_ZOOM === 0.45 && hooks.FIT_MAX_ZOOM === 0.85 && hooks.CENTER_MIN_ZOOM === 0.6)

// ── 汇总 ──────────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────')
console.log((failed === 0 ? 'PASS' : 'FAIL') + '  ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) {
  console.log('\n失败项：')
  for (const failure of failures) console.log('  - ' + failure)
  process.exit(1)
}
process.exit(0)
