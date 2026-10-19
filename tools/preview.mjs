/**
 * dsh-comfy 客户端视觉预览：jsdom 真渲染 → dump 成静态 HTML → 本机 Edge/Chrome 无头截图。
 *
 * 为什么需要：Contract §6 的验收重点是「右侧栏里看起来对不对」，而 jsdom 没有排版引擎。
 * 这里把 React 渲染出的真实 DOM（含面板自带的 <style data-dsh-comfy>）落盘，
 * 结果图换成 data URL，再用 tools/shot.mjs 以 560×980 截图 → 可以直接看像素。
 *
 * 覆盖状态：
 *   01-empty        未选择工作流（空态）
 *   02-picker       工作流选择浮层（搜索 + 来源分组）
 *   03-canvas       画布（节点/贝塞尔线/分组框/选中高亮/缺失类型/静音）
 *   04-params       参数抽屉（双击节点打开，focus KSampler）
 *   05-running      运行中（运行栏状态 / 耗时 / 队列位置）
 *   06-results      完成（结果条 + 画布结果卡片）
 *   07-preview      全屏预览（图片 + 下载/新标签打开）
 *   08-offline      离线态（启动 ComfyUI）
 *   09-canvas-dark  深色画布
 *   10-results-dark 深色结果态
 *
 * 依赖（本机路径，可用环境变量覆盖）：
 *   DSH_COMFY_JSDOM_ROOT     含 jsdom 的 node_modules 所在工程（默认 dsh-design-mode）
 *   DSH_COMFY_REACT_ROOT     含 react/react-dom 的 node_modules 所在工程（默认 infinite-canvas/web）
 *   DSH_COMFY_BROWSER        指定浏览器 exe（交给 shot.mjs 不直接使用；shot 自己找 Edge/Chrome）
 *
 * 用法：node tools/preview.mjs [--out <目录>] [--width 560] [--height 980]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_JSDOM_ROOT = path.join(ROOT, '..', 'apps', 'dsh-design-mode')
const DEFAULT_REACT_ROOT = path.join(ROOT, '..', 'apps', 'infinite-canvas', 'web')
const JSDOM_ROOT = process.env.DSH_COMFY_JSDOM_ROOT || DEFAULT_JSDOM_ROOT
const REACT_ROOT = process.env.DSH_COMFY_REACT_ROOT || DEFAULT_REACT_ROOT

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}
const OUT = path.resolve(arg('--out', path.join(ROOT, 'tools', 'preview-out')))
const WIDTH = Number(arg('--width', 560))
const HEIGHT = Number(arg('--height', 980))
const LIVE = String(arg('--live', '') || '')
const STAGE_HEIGHT = HEIGHT - 40 - 40

// ── 0. 依赖 ────────────────────────────────────────────────────────────
const requireJsdom = createRequire(path.join(JSDOM_ROOT, 'package.json'))
const requireReact = createRequire(path.join(REACT_ROOT, 'package.json'))
const { JSDOM } = requireJsdom('jsdom')
const React = requireReact('react')
const { createRoot } = requireReact('react-dom/client')
console.log('[preview] jsdom ' + requireJsdom('jsdom/package.json').version + ' / react ' + requireReact('react/package.json').version)

// ── 1. 结果图：用 zlib 现场编码 PNG（不依赖 canvas，也不读外部图片） ─────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}
function encodePng(width, height, pixelAt) {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelAt(x, y, width, height)
      const offset = y * stride + 1 + x * 4
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
      raw[offset + 3] = 255
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
/** 画一张带渐变 + 光斑 + 剪影的“生成图”，三张不同配色。 */
function makeArt(seed) {
  const W = 480
  const H = 700
  const palettes = [
    { top: [24, 30, 62], mid: [86, 74, 140], low: [236, 168, 108], orb: [255, 226, 168] },
    { top: [16, 42, 46], mid: [30, 108, 112], low: [172, 226, 178], orb: [230, 255, 214] },
    { top: [56, 22, 42], mid: [142, 58, 92], low: [250, 176, 152], orb: [255, 218, 196] },
  ]
  const palette = palettes[seed % palettes.length]
  const orbX = W * (0.32 + 0.18 * ((seed * 7) % 5) / 4)
  const orbY = H * 0.34
  const orbR = 96 + (seed % 3) * 16
  const mix = (a, b, t) => [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
  return 'data:image/png;base64,' + encodePng(W, H, (x, y) => {
    const v = y / H
    let color = v < 0.6 ? mix(palette.top, palette.mid, v / 0.6) : mix(palette.mid, palette.low, (v - 0.6) / 0.4)
    const dx = x - orbX
    const dy = y - orbY
    const distance = Math.sqrt(dx * dx + dy * dy)
    if (distance < orbR * 1.9) {
      const glow = Math.max(0, 1 - distance / (orbR * 1.9))
      color = mix(color, palette.orb, glow * glow * 0.85)
    }
    if (distance < orbR * 0.42) color = mix(color, palette.orb, 0.9)
    // 山脊剪影
    const ridge = H * 0.68 + Math.sin(x / 46 + seed) * 26 + Math.sin(x / 17 + seed * 2) * 7
    if (y > ridge) {
      const depth = Math.min(1, (y - ridge) / (H * 0.32))
      color = mix(color, [12 + seed * 6, 16 + seed * 4, 24], 0.35 + depth * 0.4)
    }
    // 轻微暗角
    const nx = (x / W - 0.5) * 2
    const ny = (y / H - 0.5) * 2
    const vignette = Math.min(1, Math.sqrt(nx * nx + ny * ny) * 0.5)
    color = color.map((channel) => Math.round(channel * (1 - vignette * 0.35)))
    return color
  }).toString('base64')
}
const ART_URLS = [makeArt(0), makeArt(1), makeArt(2)]
console.log('[preview] 生成结果图 ' + ART_URLS.length + ' 张（PNG data URL）')

// ── 2. 固定 fixtures（严格按 CONTRACT §2/§3 的形状） ────────────────────
const STATUS_ONLINE = {
  ok: true,
  reachable: true,
  baseUrl: 'http://127.0.0.1:8188',
  version: '0.40.0',
  python: '3.12.8',
  devices: [{ name: 'NVIDIA GeForce RTX 4090', type: 'cuda', vramTotal: 25757220864, vramFree: 18236100608 }],
  queue: { running: 0, pending: 0 },
  startScriptExists: true,
}
const STATUS_OFFLINE = {
  ok: true,
  reachable: false,
  baseUrl: 'http://127.0.0.1:8188',
  devices: [],
  queue: { running: 0, pending: 0 },
  startScriptExists: true,
  error: 'fetch failed: connect ECONNREFUSED 127.0.0.1:8188',
}
const WORKFLOW_ITEMS = [
  { id: 'user::example_workflow.json', source: 'user', relPath: 'example_workflow.json', name: 'example_workflow.json', kind: 'ui', size: 81234, mtime: 1792410000000 },
  { id: 'user::example_workflow_2.json', source: 'user', relPath: 'example_workflow_2.json', name: 'example_workflow_2.json', kind: 'ui', size: 23412, mtime: 1792400000000 },
  { id: 'user::example_workflow_3.json', source: 'user', relPath: 'example_workflow_3.json', name: 'example_workflow_3.json', kind: 'ui', size: 9120, mtime: 1792300000000 },
  { id: 'workspace::workspace_product_shots.json', source: 'workspace', relPath: 'workspace_product_shots.json', name: 'workspace_product_shots.json', kind: 'ui', size: 15600, mtime: 1792200000000 },
  { id: 'workspace::workspace_storyboard.json', source: 'workspace', relPath: 'workspace_storyboard.json', name: 'workspace_storyboard.json', kind: 'api', size: 20100, mtime: 1792100000000 },
  { id: 'templates::image_to_image.json', source: 'templates', relPath: 'image_to_image.json', name: 'image_to_image.json', kind: 'ui', size: 33021, mtime: 1791000000000 },
  { id: 'templates::text_to_image.json', source: 'templates', relPath: 'text_to_image.json', name: 'text_to_image.json', kind: 'ui', size: 28130, mtime: 1791000000000 },
  { id: 'templates::upscale_to_2k.json', source: 'templates', relPath: 'upscale_to_2k.json', name: 'upscale_to_2k.json', kind: 'ui', size: 12011, mtime: 1791000000000 },
  { id: 'templates::video_wan_i2v.json', source: 'templates', relPath: 'video_wan_i2v.json', name: 'video_wan_i2v.json', kind: 'ui', size: 44120, mtime: 1791000000000 },
  { id: 'templates::audio_stable_audio.json', source: 'templates', relPath: 'audio_stable_audio.json', name: 'audio_stable_audio.json', kind: 'ui', size: 39201, mtime: 1791000000000 },
]
const WORKFLOWS = {
  ok: true,
  sources: [
    { id: 'user', label: '本机', root: 'D:\\ComfyUI\\user\\default\\workflows', exists: true, count: 3 },
    { id: 'workspace', label: '工作区', root: 'D:\\ComfyUI\\workflows', exists: true, count: 2 },
    { id: 'templates', label: '官方模板', root: '…\\comfyui_workflow_templates_json\\templates', exists: true, count: 620 },
  ],
  items: WORKFLOW_ITEMS,
}
const GRAPH = {
  nodes: [
    {
      id: '1', type: 'CheckpointLoaderSimple', title: 'Load Checkpoint', x: 20, y: 60, w: 280, h: 150, category: 'loaders',
      widgets: [{ name: 'ckpt_name', kind: 'combo', value: 'example_model.safetensors', options: ['example_model.safetensors', 'another_example_model.safetensors', 'sd_xl_base_1.0.safetensors'] }],
      inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL' }, { name: 'CLIP', type: 'CLIP' }, { name: 'VAE', type: 'VAE' }],
    },
    {
      id: '2', type: 'CLIPTextEncode', title: 'Positive Prompt', x: 340, y: 30, w: 320, h: 180, category: 'conditioning',
      widgets: [{ name: 'text', kind: 'text', multiline: true, value: 'a quiet mountain lake at sunrise, soft mist, cinematic light' }],
      inputs: [{ name: 'clip', type: 'CLIP' }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }],
    },
    {
      id: '3', type: 'CLIPTextEncode', title: 'Negative Prompt', x: 340, y: 250, w: 320, h: 140, category: 'conditioning',
      widgets: [{ name: 'text', kind: 'text', multiline: true, value: 'lowres, blurry, watermark, bad anatomy, extra fingers' }],
      inputs: [{ name: 'clip', type: 'CLIP' }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }],
    },
    {
      id: '4', type: 'EmptyLatentImage', title: 'Empty Latent Image', x: 20, y: 250, w: 280, h: 160, category: 'latent',
      widgets: [
        { name: 'width', kind: 'number', value: 832, min: 64, max: 16384, step: 8 },
        { name: 'height', kind: 'number', value: 1216, min: 64, max: 16384, step: 8 },
        { name: 'batch_size', kind: 'number', value: 1, min: 1, max: 64, step: 1 },
      ],
      inputs: [], outputs: [{ name: 'LATENT', type: 'LATENT' }],
    },
    {
      id: '5', type: 'KSampler', title: 'KSampler（主线）', x: 700, y: 100, w: 340, h: 280, category: 'sampling',
      widgets: [
        { name: 'seed', kind: 'number', value: 123456789, min: 0, max: 18446744073709552000, step: 1 },
        { name: 'control_after_generate', kind: 'combo', value: 'randomize', options: ['fixed', 'increment', 'decrement', 'randomize'] },
        { name: 'steps', kind: 'number', value: 28, min: 1, max: 200, step: 1 },
        { name: 'cfg', kind: 'number', value: 6.5, min: 0, max: 100, step: 0.1 },
        { name: 'sampler_name', kind: 'combo', value: 'dpmpp_2m', options: ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_3m_sde', 'uni_pc'] },
        { name: 'scheduler', kind: 'combo', value: 'karras', options: ['normal', 'karras', 'exponential', 'sgm_uniform'] },
        { name: 'denoise', kind: 'number', value: 1, min: 0, max: 1, step: 0.01 },
      ],
      inputs: [
        { name: 'model', type: 'MODEL' }, { name: 'positive', type: 'CONDITIONING' },
        { name: 'negative', type: 'CONDITIONING' }, { name: 'latent_image', type: 'LATENT' },
      ],
      outputs: [{ name: 'LATENT', type: 'LATENT' }],
    },
    {
      id: '6', type: 'VAEDecode', title: 'VAE Decode', x: 1080, y: 120, w: 280, h: 110, category: 'latent',
      widgets: [],
      inputs: [{ name: 'samples', type: 'LATENT' }, { name: 'vae', type: 'VAE' }],
      outputs: [{ name: 'IMAGE', type: 'IMAGE' }],
    },
    {
      id: '7', type: 'SaveImage', title: 'Save Image（主线）', x: 1400, y: 50, w: 300, h: 200, category: 'image',
      widgets: [{ name: 'filename_prefix', kind: 'text', value: 'example' }],
      inputs: [{ name: 'images', type: 'IMAGE' }], outputs: [],
    },
    {
      id: '8', type: 'ImageScale', title: 'Upscale（2x）', x: 700, y: 420, w: 320, h: 200, category: 'image/upscale',
      widgets: [
        { name: 'upscale_method', kind: 'combo', value: 'lanczos', options: ['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos'] },
        { name: 'width', kind: 'number', value: 1664, min: 0, max: 16384, step: 8 },
        { name: 'height', kind: 'number', value: 2432, min: 0, max: 16384, step: 8 },
        { name: 'crop', kind: 'combo', value: 'disabled', options: ['disabled', 'center'] },
      ],
      inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }],
    },
    {
      id: '9', type: 'SaveImage', title: 'Save Image（放大）', x: 1080, y: 400, w: 300, h: 190, category: 'image',
      widgets: [{ name: 'filename_prefix', kind: 'text', value: 'example_up' }],
      inputs: [{ name: 'images', type: 'IMAGE' }], outputs: [],
    },
    {
      id: '10', type: 'Note', title: 'Notes', x: 20, y: 450, w: 280, h: 130, category: 'utils',
      widgets: [{ name: 'text', kind: 'text', multiline: true, value: '只改 seed / steps；采样器保持 dpmpp_2m + karras。自定义节点需要额外安装。' }],
      inputs: [], outputs: [],
    },
    {
      id: '11', type: 'VHS_VideoCombine', title: 'Video Combine', x: 1080, y: 640, w: 320, h: 180, category: 'video',
      widgets: [
        { name: 'frame_rate', kind: 'number', value: 12, min: 1, max: 120, step: 1 },
        { name: 'loop_count', kind: 'number', value: 0, min: 0, max: 100, step: 1 },
        { name: 'format', kind: 'combo', value: 'video/h264-mp4', options: ['video/h264-mp4', 'image/gif', 'image/webp'] },
        { name: 'filename_prefix', kind: 'text', value: 'example_anim' },
      ],
      inputs: [{ name: 'images', type: 'IMAGE' }], outputs: [],
    },
    {
      id: '12', type: 'SaveAudio', title: 'Save Audio', x: 1400, y: 640, w: 300, h: 170, category: 'audio',
      widgets: [{ name: 'format', kind: 'combo', value: 'flac', options: ['flac', 'mp3', 'wav', 'opus'] }],
      inputs: [{ name: 'audio', type: 'AUDIO' }], outputs: [],
    },
    {
      id: '13', type: 'CustomSamplerNode', title: '自定义采样节点', x: 1400, y: 290, w: 300, h: 190, category: 'sampling', missing: true,
      widgets: [
        { name: 'seed', kind: 'number', value: 42, min: 0, max: 4294967295, step: 1 },
        { name: 'chain_length', kind: 'number', value: 4, min: 1, max: 16, step: 1 },
        { name: 'prompt', kind: 'text', multiline: true, value: '继续生成下一段镜头' },
      ],
      inputs: [{ name: 'model', type: 'MODEL' }, { name: 'positive', type: 'CONDITIONING' }, { name: 'negative', type: 'CONDITIONING' }, { name: 'latent_image', type: 'LATENT' }],
      outputs: [{ name: 'LATENT', type: 'LATENT' }],
    },
    {
      id: '14', type: 'PreviewImage', title: 'Preview Image', x: 40, y: 640, w: 250, h: 120, category: 'image', mode: 2,
      widgets: [],
      inputs: [{ name: 'images', type: 'IMAGE' }], outputs: [],
    },
    {
      id: '15', type: 'FrameInterpolator', title: 'Frame Interpolator', x: 700, y: 700, w: 320, h: 170, category: 'postprocess',
      widgets: [
        { name: 'enable', kind: 'bool', value: true },
        { name: 'multiplier', kind: 'number', value: 2, min: 1, max: 8, step: 1 },
        { name: 'mode', kind: 'combo', value: 'rife', options: ['linear', 'rife', 'film'] },
        { name: 'quality', kind: 'number', value: 0.8, min: 0, max: 1, step: 0.01 },
      ],
      inputs: [{ name: 'images', type: 'IMAGE' }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }],
    },
  ],
  edges: [
    { from: { node: '1', slot: 0 }, to: { node: '5', slot: 0 }, type: 'MODEL' },
    { from: { node: '1', slot: 1 }, to: { node: '2', slot: 0 }, type: 'CLIP' },
    { from: { node: '1', slot: 1 }, to: { node: '3', slot: 0 }, type: 'CLIP' },
    { from: { node: '2', slot: 0 }, to: { node: '5', slot: 1 }, type: 'CONDITIONING' },
    { from: { node: '3', slot: 0 }, to: { node: '5', slot: 2 }, type: 'CONDITIONING' },
    { from: { node: '4', slot: 0 }, to: { node: '5', slot: 3 }, type: 'LATENT' },
    { from: { node: '5', slot: 0 }, to: { node: '6', slot: 0 }, type: 'LATENT' },
    { from: { node: '1', slot: 2 }, to: { node: '6', slot: 1 }, type: 'VAE' },
    { from: { node: '6', slot: 0 }, to: { node: '7', slot: 0 }, type: 'IMAGE' },
    { from: { node: '5', slot: 0 }, to: { node: '8', slot: 0 }, type: 'LATENT' },
    { from: { node: '8', slot: 0 }, to: { node: '9', slot: 0 }, type: 'IMAGE' },
    { from: { node: '8', slot: 0 }, to: { node: '11', slot: 0 }, type: 'IMAGE' },
    { from: { node: '8', slot: 0 }, to: { node: '15', slot: 0 }, type: 'IMAGE' },
    { from: { node: '1', slot: 0 }, to: { node: '13', slot: 0 }, type: 'MODEL' },
    { from: { node: '4', slot: 0 }, to: { node: '13', slot: 3 }, type: 'LATENT' },
    { from: { node: '6', slot: 0 }, to: { node: '14', slot: 0 }, type: 'IMAGE' },
  ],
  groups: [
    { title: '采样', x: 680, y: 60, w: 400, h: 340, color: '#3f789e' },
    { title: '后处理', x: 680, y: 390, w: 400, h: 280, color: '#6b8a5a' },
    { title: '输出', x: 1060, y: 30, w: 680, h: 800, color: '#8a6a3f' },
  ],
  stats: { nodeCount: 15, edgeCount: 16, missingTypes: ['CustomSamplerNode'], mutedCount: 1 },
}
const WORKFLOW_RESPONSE = {
  ok: true,
  id: 'user::example_workflow.json',
  name: 'example_workflow.json',
  source: 'user',
  relPath: 'example_workflow.json',
  kind: 'ui',
  graph: GRAPH,
  warnings: [],
}
const OUTPUTS = [
  { nodeId: '7', nodeType: 'SaveImage', kind: 'image', filename: 'example_00001_.png', subfolder: '', type: 'output', url: '/api/dsh-comfy/view?filename=example_00001_.png&subfolder=&type=output', label: 'example_00001_.png' },
  { nodeId: '9', nodeType: 'SaveImage', kind: 'image', filename: 'example_up_00001_.png', subfolder: '', type: 'output', url: '/api/dsh-comfy/view?filename=example_up_00001_.png&subfolder=&type=output', label: 'example_up_00001_.png' },
  { nodeId: '11', nodeType: 'VHS_VideoCombine', kind: 'video', filename: 'example_anim_00001.mp4', subfolder: '', type: 'output', url: '/api/dsh-comfy/view?filename=example_anim_00001.mp4&subfolder=&type=output', label: 'example_anim_00001.mp4' },
  { nodeId: '12', nodeType: 'SaveAudio', kind: 'audio', filename: 'example_theme.flac', subfolder: '', type: 'output', url: '/api/dsh-comfy/view?filename=example_theme.flac&subfolder=&type=output', label: 'example_theme.flac' },
]

// ── 3. 可选：--live <dev-server> 用真实端点生成的 graph/fixtures ──────
let STATUS_FIXTURE = STATUS_ONLINE
let WORKFLOWS_FIXTURE = WORKFLOWS
let WORKFLOW_FIXTURE = WORKFLOW_RESPONSE
let GRAPH_FIXTURE = GRAPH
let TARGET_ID = 'user::example_workflow.json'
let RESULT_OUTPUTS = OUTPUTS
if (LIVE !== '') {
  const base = LIVE.replace(/\/+$/, '')
  try {
    console.log('[preview] live: 从 ' + base + ' 读取真实 /status /workflows /workflow …')
    STATUS_FIXTURE = await (await fetch(base + '/api/dsh-comfy/status')).json()
    WORKFLOWS_FIXTURE = await (await fetch(base + '/api/dsh-comfy/workflows')).json()
    const items = Array.isArray(WORKFLOWS_FIXTURE.items) ? WORKFLOWS_FIXTURE.items : []
    const item = items.find((entry) => entry.source === 'user') || items.find((entry) => entry.kind === 'ui') || items[0]
    if (item === undefined) throw new Error('live /workflows 没有可用的工作流')
    WORKFLOW_FIXTURE = await (await fetch(base + '/api/dsh-comfy/workflow?id=' + encodeURIComponent(item.id))).json()
    GRAPH_FIXTURE = WORKFLOW_FIXTURE.graph || GRAPH
    TARGET_ID = item.id
    const nodes = Array.isArray(GRAPH_FIXTURE.nodes) ? GRAPH_FIXTURE.nodes : []
    const saves = nodes.filter((node) => /Save|Preview|Video|Audio|Combine/i.test(String(node.type)))
    const live = saves.slice(0, 5).map((node) => {
      const type = String(node.type)
      const kind = /Video|Combine|Animate|VHS/i.test(type) ? 'video' : /Audio/i.test(type) ? 'audio' : 'image'
      const ext = kind === 'video' ? 'mp4' : kind === 'audio' ? 'flac' : 'png'
      const filename = 'live_' + String(node.id) + '.' + ext
      return {
        nodeId: String(node.id),
        nodeType: type,
        kind,
        filename,
        subfolder: '',
        type: 'output',
        url: '/api/dsh-comfy/view?filename=' + encodeURIComponent(filename) + '&subfolder=&type=output',
        label: filename,
      }
    })
    if (live.length > 0) RESULT_OUTPUTS = live
    console.log('[preview] live: ' + (WORKFLOW_FIXTURE.name || TARGET_ID) + ' / ' + nodes.length + ' 节点 / ' + (Array.isArray(GRAPH_FIXTURE.edges) ? GRAPH_FIXTURE.edges.length : 0) + ' 连线')
  } catch (error) {
    console.error('[preview] live 读取失败，回落到内置 fixtures：' + String(error && error.message ? error.message : error))
    STATUS_FIXTURE = STATUS_ONLINE
    WORKFLOWS_FIXTURE = WORKFLOWS
    WORKFLOW_FIXTURE = WORKFLOW_RESPONSE
    GRAPH_FIXTURE = GRAPH
    TARGET_ID = 'user::example_workflow.json'
    RESULT_OUTPUTS = OUTPUTS
  }
}
const EXPECT_NODES = Array.isArray(GRAPH_FIXTURE.nodes) ? GRAPH_FIXTURE.nodes.length : 0
const EXPECT_EDGES = Array.isArray(GRAPH_FIXTURE.edges) ? GRAPH_FIXTURE.edges.length : 0
const EXPECT_RESULTS = RESULT_OUTPUTS.length
const TARGET_NODE = (() => {
  const nodes = Array.isArray(GRAPH_FIXTURE.nodes) ? GRAPH_FIXTURE.nodes : []
  const withWidgets = nodes.filter((node) => Array.isArray(node.widgets) && node.widgets.length > 0)
  return withWidgets.find((node) => /KSampler/i.test(String(node.type))) || withWidgets[0] || nodes[0] || { id: '5' }
})()
const TARGET_NODE_ID = String(TARGET_NODE.id)

// ── 3. jsdom 环境 ──────────────────────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:19388/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.Element = window.Element
globalThis.Node = window.Node
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : (fn) => window.setTimeout(fn, 16)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame ? window.cancelAnimationFrame.bind(window) : (id) => window.clearTimeout(id)

// 无排版引擎：给 stage/root 一个确定的矩形，fitView 才有真实视口可用。
function rectOf(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() { return this } }
}
const originalGetRect = window.Element.prototype.getBoundingClientRect
window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  const className = typeof this.className === 'string' ? this.className : ''
  if (className.indexOf('dsh-comfy-stage') !== -1) return rectOf(0, 40, WIDTH, STAGE_HEIGHT)
  if (className.indexOf('dsh-comfy-root') !== -1) return rectOf(0, 0, WIDTH, HEIGHT)
  return originalGetRect.call(this)
}

// fetch mock：严格按 §2 的响应形状
let previewMode = 'online'
let progressMode = 'running'
let progressCalls = 0
let promptNumber = 0
let fetchLog = []
window.fetch = async (url, options = {}) => {
  const target = String(url)
  const method = String(options.method || 'GET').toUpperCase()
  fetchLog.push(method + ' ' + target)
  const respond = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
  if (target.indexOf('/api/dsh-comfy/status') === 0) return respond(previewMode === 'offline' ? STATUS_OFFLINE : STATUS_FIXTURE)
  if (target.indexOf('/api/dsh-comfy/workflows') === 0) return respond(WORKFLOWS_FIXTURE)
  if (target.indexOf('/api/dsh-comfy/workflow') === 0) return respond(WORKFLOW_FIXTURE)
  if (target.indexOf('/api/dsh-comfy/run') === 0) {
    promptNumber += 1
    return respond({ ok: true, promptId: 'prompt-' + promptNumber, number: promptNumber, warnings: [], queued: false })
  }
  if (target.indexOf('/api/dsh-comfy/progress') === 0) {
    if (progressMode === 'done') return respond({ ok: true, state: 'done', promptId: 'prompt-1', elapsedMs: 8342, outputs: RESULT_OUTPUTS })
    progressCalls += 1
    if (progressCalls <= 1) return respond({ ok: true, state: 'queued', promptId: 'prompt-1', elapsedMs: 420, queuePosition: 2, outputs: [] })
    return respond({ ok: true, state: 'running', promptId: 'prompt-1', elapsedMs: 1200 + progressCalls * 800, outputs: [] })
  }
  if (target.indexOf('/api/dsh-comfy/interrupt') === 0) return respond({ ok: true })
  if (target.indexOf('/api/dsh-comfy/start') === 0) return respond({ ok: true, started: true, message: '已请求启动 ComfyUI，等待就绪…' })
  if (target.indexOf('/api/dsh-comfy/view') === 0) return respond({ ok: true })
  return { ok: false, status: 404, json: async () => ({ ok: false, error: 'mock 404: ' + target }), text: async () => '' }
}
window.AbortController = globalThis.AbortController
window.setTimeout = setTimeout
window.clearTimeout = clearTimeout

// ── 4. 载入产物，注册面板 ─────────────────────────────────────────────
const clientCode = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
let registration = null
window.__ModuleLoader__ = { load: (value) => { registration = value } }
window.eval(clientCode)
const plugin = registration.factory((spec) => {
  if (spec === 'react') return React
  throw new Error('unexpected require: ' + spec)
})
const registeredBodies = []
plugin.apply({
  effect: (callback) => {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get: (name) => ({
    slots: {
      register: (options, Body) => {
        registeredBodies.push({ options, Body })
        return () => {}
      },
      inject: (_name, factory) => factory(),
    },
    sidebarRightTabs: { register: () => () => {} },
    locale: { register: () => () => {}, getLocale: () => ({ active: 'zh-CN' }), subscribe: () => () => {} },
  }[name]),
})
const PaneBody = registeredBodies[0] && registeredBodies[0].Body
if (typeof PaneBody !== 'function') {
  console.error('没能从 client.js 里取到右侧栏面板组件')
  process.exit(2)
}
// 打开工作流后的初始视图（可读优先）：整图 fit >=0.55 用 fit，否则 0.62 聚焦最大分组/节点
const EXPECT_INITIAL = (() => {
  try {
    return plugin.__testHooks.initialViewForGraph(GRAPH_FIXTURE, WIDTH, STAGE_HEIGHT, 36)
  } catch (error) {
    return { mode: 'focus', view: { k: 0.62 } }
  }
})()
const EXPECT_ZOOM = Math.round(EXPECT_INITIAL.view.k * 100) + '%'
console.log('[preview] 预期初始缩放 ' + EXPECT_ZOOM + '（可读优先，mode=' + EXPECT_INITIAL.mode + '）')

// ── 5. 渲染 + 交互驱动 ─────────────────────────────────────────────────
globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.IS_REACT_ACT_ENVIRONMENT = true
const act = React.act

async function actRun(fn) {
  await act(async () => {
    await fn()
  })
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function settle(ms = 120) {
  await actRun(async () => {
    await sleep(ms)
  })
}

let host = null
let root = null
async function mount() {
  if (root !== null) {
    await actRun(async () => root.unmount())
    root = null
  }
  if (host !== null) host.remove()
  host = window.document.createElement('div')
  window.document.body.appendChild(host)
  root = createRoot(host)
  await actRun(async () => {
    root.render(React.createElement(PaneBody, {}))
    await sleep(200)
  })
  await settle(180)
}
const $ = (selector) => (host === null ? null : host.querySelector(selector))
const $$ = (selector) => (host === null ? [] : Array.from(host.querySelectorAll(selector)))
/** jsdom+React19 的组合在「焦点元素随事件被卸载」时会踩到 attachEvent 兼容分支，派发前先失焦。 */
function blurActive() {
  try {
    const active = window.document.activeElement
    if (active !== null && active !== window.document.body && typeof active.blur === 'function') active.blur()
  } catch {
    /* ignore */
  }
}
function fire(element, type, EventClass, init) {
  if (element === null || element === undefined) throw new Error('未找到元素: ' + type)
  const event = new EventClass(type, Object.assign({ bubbles: true, cancelable: true }, init))
  element.dispatchEvent(event)
}
async function click(element) {
  await actRun(async () => {
    blurActive()
    fire(element, 'click', window.MouseEvent)
  })
  await settle()
}
async function dblclick(element) {
  await actRun(async () => {
    blurActive()
    fire(element, 'dblclick', window.MouseEvent, { clientX: 300, clientY: 300 })
  })
  await settle()
}
async function pointer(element, type, init = {}) {
  await actRun(async () => {
    blurActive()
    fire(element, type, window.PointerEvent, Object.assign({ button: 0, pointerId: 1, clientX: 300, clientY: 300 }, init))
  })
}
/** 右键：返回是否调用了 preventDefault（不能弹浏览器菜单）。 */
async function contextmenu(element, init = {}) {
  let prevented = false
  await actRun(async () => {
    blurActive()
    const event = new window.MouseEvent('contextmenu', Object.assign({ bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 300 }, init))
    element.dispatchEvent(event)
    prevented = event.defaultPrevented
  })
  await settle(100)
  return prevented
}
async function pressKey(key) {
  await actRun(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
  await settle(90)
}
const worldTransform = () => {
  const world = host === null ? null : host.querySelector('.dsh-comfy-world')
  return world === null ? '' : String(world.style.transform || '')
}
const selectedCount = () => (host === null ? 0 : host.querySelectorAll('[data-sel="1"]').length)
/** 交互断言（不依赖截图，直接查渲染后的 DOM 状态）。 */
const interactionChecks = []
function check(name, condition, detail) {
  interactionChecks.push({ name, ok: condition === true, detail: detail === undefined ? '' : String(detail) })
  console.log((condition === true ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : '  ' + String(detail)))
}

// 结果图替换：把 /api/dsh-comfy/view 的 img src 换成 data URL（截图里看得见）
let imageSequence = 0
/** 静态 HTML 不会保留 select/checkbox 的运行时状态（React 写的是 property），dump 前同步成属性。 */
function syncFormState() {
  for (const select of host.querySelectorAll('select')) {
    for (const option of Array.from(select.options)) {
      if (option.selected) option.setAttribute('selected', '')
      else option.removeAttribute('selected')
    }
  }
  for (const input of host.querySelectorAll('input[type="checkbox"]')) {
    if (input.checked) input.setAttribute('checked', '')
    else input.removeAttribute('checked')
  }
}
function renderHtml() {
  syncFormState()
  let html = host.innerHTML
  html = html.replace(/src="\/api\/dsh-comfy\/view[^"]*"/g, () => {
    const url = ART_URLS[imageSequence % ART_URLS.length]
    imageSequence += 1
    return 'src="' + url + '"'
  })
  return html
}
const states = []
function dump(state, options = {}) {
  const theme = options.theme === 'dark' ? 'dark' : 'light'
  const rootElement = host.querySelector('.dsh-comfy-root')
  if (rootElement !== null) rootElement.setAttribute('data-cmf-theme', theme)
  const background = theme === 'dark' ? '#141518' : '#f6f7f9'
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>dsh-comfy ' + state + '</title></head>'
    + '<body style="margin:0;background:' + background + ';-webkit-font-smoothing:antialiased">'
    + '<div id="panel" style="position:relative;width:' + WIDTH + 'px;height:' + HEIGHT + 'px;overflow:hidden;background:' + background + '">'
    + renderHtml()
    + '</div></body></html>'
  const file = path.join(OUT, state + '.html')
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(file, html)
  states.push(file)
  return file
}

// ── 6. 状态序列 ────────────────────────────────────────────────────────
console.log('[preview] 01-empty')
previewMode = 'online'
await mount()
dump('01-empty')

console.log('[preview] 02-picker')
await click($('[data-cmf="picker-toggle"]'))
await settle(80)
dump('02-picker')

console.log('[preview] 03-canvas')
const workflowId = TARGET_ID
const workflowItem = $('[data-cmf="workflow-item"][data-cmf-id="' + workflowId + '"]')
if (workflowItem === null) throw new Error('选择器里没找到目标工作流')
await click(workflowItem)
await settle(260) // fetch + fitView(60ms)
// 点选目标节点（fixture 里是 KSampler；live 模式从真实 graph 里挑），看高亮 + 连线强调
const node5 = $('[data-cmf-node="' + TARGET_NODE_ID + '"]')
if (node5 === null) throw new Error('画布上没有目标节点 ' + TARGET_NODE_ID)
await pointer(node5, 'pointerdown', { clientX: 260, clientY: 360 })
await pointer($('[data-cmf="stage"]'), 'pointerup', { clientX: 260, clientY: 360 })
await settle(80)
dump('03-canvas')

console.log('[preview] 04-params')
// 真机点击路径回归：pointerdown 落在节点标题 → pointerup 时（未拖动）走 headHit 分支打开参数。
// 注：jsdom 不实现 setPointerCapture 的重定向，所以这里验的是指针状态机（headHit/pointerup），
// 真机上“pointerup 被 stage 捕获”导致的 click 丢失由 lazy-capture 修复，见 client.body.js 注释。
const head5 = $('[data-cmf-node="' + TARGET_NODE_ID + '"] .dsh-comfy-node-head')
if (head5 === null) throw new Error('目标节点没有标题区域')
await pointer(head5, 'pointerdown', { clientX: 300, clientY: 320 })
await pointer($('[data-cmf="stage"]'), 'pointerup', { clientX: 300, clientY: 320 })
await settle(140)
dump('04-params')

console.log('[preview] 05-queued')
// 关掉参数抽屉 → 适应视图 → 跑（第一次轮询返回 queued，展示队列位置）
await click($('[data-cmf="params-toggle"]'))
await settle(60)
await click($('[data-cmf="zoom-fit"]'))
await settle(60)
progressMode = 'queued'
progressCalls = 0
await click($('[data-cmf="run"]'))
await settle(500)
dump('05-queued')

console.log('[preview] 06-results')
progressMode = 'done'
await settle(1300) // 等下一次 800ms 轮询返回 done + 结果卡片落位
const fitButton = $('[data-cmf="zoom-fit"]')
if (fitButton !== null) {
  await click(fitButton)
  await settle(80)
}
dump('06-results')

console.log('[preview] 07-preview')
// 结果卡片：pointerdown→pointerup（未拖动）→ 打开预览（真机同样不再依赖被捕获重定向的 click）
const firstCard = $('[data-cmf-result]')
if (firstCard === null) throw new Error('画布上没有结果卡片')
await pointer(firstCard, 'pointerdown', { clientX: 470, clientY: 560 })
await pointer($('[data-cmf="stage"]'), 'pointerup', { clientX: 470, clientY: 560 })
await settle(140)
dump('07-preview')

// 结果卡片右键菜单：预览关闭后，从画布移除一张
await pressKey('Escape')
const cardForMenu = $$('[data-cmf-result]')[0]
if (cardForMenu !== undefined) {
  const beforeCards = $$('[data-cmf-result]').length
  await contextmenu(cardForMenu, { clientX: 470, clientY: 560 })
  check('[菜单] 结果卡片右键出现菜单', $('[data-cmf="context-menu"]') !== null)
  const removeItem = $('[data-cmf="ctx-item"][data-cmf-id="remove"]')
  if (removeItem !== null) await click(removeItem)
  await settle(140)
  check('[菜单] 结果卡片「从画布移除」生效', $$('[data-cmf-result]').length === beforeCards - 1,
    beforeCards + ' -> ' + $$('[data-cmf-result]').length)
} else {
  check('[菜单] 结果卡片右键出现菜单', false, '没有结果卡片可测')
}

console.log('[preview] 08-offline')
previewMode = 'offline'
await mount()
await settle(120)
dump('08-offline')

console.log('[preview] 09-canvas-dark')
previewMode = 'online'
progressMode = 'running'
await mount()
await click($('[data-cmf="picker-toggle"]'))
await settle(80)
const workflowItem2 = $('[data-cmf="workflow-item"][data-cmf-id="' + workflowId + '"]')
if (workflowItem2 !== null) await click(workflowItem2)
await settle(260)
await pointer($('[data-cmf-node="' + TARGET_NODE_ID + '"]'), 'pointerdown', { clientX: 260, clientY: 360 })
await pointer($('[data-cmf="stage"]'), 'pointerup', { clientX: 260, clientY: 360 })
await settle(80)
dump('09-canvas-dark', { theme: 'dark' })

console.log('[preview] 10-results-dark')
progressMode = 'done'
await click($('[data-cmf="run"]'))
await settle(1400)
const fitButton2 = $('[data-cmf="zoom-fit"]')
if (fitButton2 !== null) await click(fitButton2)
await settle(80)
dump('10-results-dark', { theme: 'dark' })

// ── 6b. 画布交互：左键框选 / 中键平移 / 右键菜单（task-3） ─────────────
console.log('\n[preview] 11-box-select-light')
previewMode = 'online'
progressMode = 'running'
await mount()
await click($('[data-cmf="picker-toggle"]'))
await settle(80)
const workflowItem3 = $('[data-cmf="workflow-item"][data-cmf-id="' + workflowId + '"]')
if (workflowItem3 !== null) await click(workflowItem3)
await settle(260)
await click($('[data-cmf="zoom-fit"]'))
await settle(100)
const stageEl = () => $('[data-cmf="stage"]')
const beforeBoxTransform = worldTransform()
await pointer(stageEl(), 'pointerdown', { clientX: 20, clientY: 220 })
await pointer(stageEl(), 'pointermove', { clientX: 540, clientY: 760 })
await settle(100)
check('[框选] 拖动中出现半透明遮罩', $('[data-cmf="marquee"]') !== null)
dump('11-box-select-light')
await pointer(stageEl(), 'pointerup', { clientX: 540, clientY: 760 })
await settle(140)
const boxSelected = selectedCount()
check('[框选] 松开后命中多个节点', boxSelected >= 2, 'selected=' + boxSelected)
check('[框选] 左键拖拽不再平移画布', worldTransform() === beforeBoxTransform, beforeBoxTransform + ' -> ' + worldTransform())
// 框选后拖任意已选节点 = 整组移动（复用现有 group drag）
const selectedNodeEls = $$('[data-cmf-node][data-sel="1"]')
if (selectedNodeEls.length >= 2) {
  const beforeLefts = [selectedNodeEls[0].style.left, selectedNodeEls[1].style.left]
  await pointer(selectedNodeEls[0], 'pointerdown', { clientX: 300, clientY: 300, pointerId: 13 })
  await pointer(stageEl(), 'pointermove', { clientX: 330, clientY: 318, pointerId: 13 })
  await pointer(stageEl(), 'pointerup', { clientX: 330, clientY: 318, pointerId: 13 })
  await settle(120)
  const afterLefts = [selectedNodeEls[0].style.left, selectedNodeEls[1].style.left]
  check('[框选] 框选后整组拖动生效', beforeLefts[0] !== afterLefts[0] && beforeLefts[1] !== afterLefts[1],
    beforeLefts.join('/') + ' -> ' + afterLefts.join('/'))
} else {
  check('[框选] 框选后整组拖动生效', false, 'selected=' + selectedNodeEls.length)
}
// 空白单击（未拖动）= 取消选择
await pointer(stageEl(), 'pointerdown', { clientX: 24, clientY: 880, pointerId: 11 })
await pointer(stageEl(), 'pointerup', { clientX: 24, clientY: 880, pointerId: 11 })
await settle(100)
check('[框选] 空白单击取消选择', selectedCount() === 0, 'selected=' + selectedCount())

console.log('\n[preview] 12-context-menu-light')
// 先放大一点，确保「适应画布」菜单项真的改变了视图
await click($('[data-cmf="zoom-in"]'))
await click($('[data-cmf="zoom-in"]'))
await settle(100)
const zoomBeforeFit = $('[data-cmf="zoom-reset"]') === null ? '' : $('[data-cmf="zoom-reset"]').textContent
const contextPrevented = await contextmenu(stageEl(), { clientX: 300, clientY: 520 })
check('[菜单] 空白右键出现上下文菜单', $('[data-cmf="context-menu"]') !== null)
check('[菜单] 阻止浏览器默认右键菜单', contextPrevented === true)
dump('12-context-menu-light')
const fitItem = $('[data-cmf="ctx-item"][data-cmf-id="fit"]')
if (fitItem !== null) await click(fitItem)
await settle(160)
const zoomAfterFit = $('[data-cmf="zoom-reset"]') === null ? '' : $('[data-cmf="zoom-reset"]').textContent
check('[菜单] 「适应画布」动作生效', zoomBeforeFit !== '45%' && zoomAfterFit === '45%', zoomBeforeFit + ' -> ' + zoomAfterFit)
check('[菜单] 动作后菜单关闭', $('[data-cmf="context-menu"]') === null)
// Esc 关闭
await contextmenu(stageEl(), { clientX: 260, clientY: 560 })
check('[菜单] Esc 前菜单已打开', $('[data-cmf="context-menu"]') !== null)
await pressKey('Escape')
check('[菜单] Esc 关闭菜单', $('[data-cmf="context-menu"]') === null)
// 节点右键 → 打开参数
const nodeElement = $('[data-cmf-node="' + TARGET_NODE_ID + '"]')
if (nodeElement === null) throw new Error('没有目标节点，无法测节点右键菜单')
await contextmenu(nodeElement, { clientX: 300, clientY: 360 })
check('[菜单] 节点右键出现菜单', $('[data-cmf="context-menu"]') !== null)
const nodeParamsItem = $('[data-cmf="ctx-item"][data-cmf-id="params"]')
if (nodeParamsItem !== null) await click(nodeParamsItem)
await settle(160)
check('[菜单] 节点「打开参数」生效', $('[data-cmf="params-drawer"]') !== null)
await pressKey('Escape')

console.log('\n[preview] 中键平移')
const beforePanTransform = worldTransform()
await pointer(stageEl(), 'pointerdown', { button: 1, clientX: 300, clientY: 400, pointerId: 7 })
await pointer(stageEl(), 'pointermove', { button: 1, clientX: 350, clientY: 430, pointerId: 7 })
await pointer(stageEl(), 'pointerup', { button: 1, clientX: 350, clientY: 430, pointerId: 7 })
await settle(120)
check('[平移] 中键拖拽生效', worldTransform() !== beforePanTransform, beforePanTransform + ' -> ' + worldTransform())

console.log('\n[preview] 13-box-select-dark')
await mount()
await click($('[data-cmf="picker-toggle"]'))
await settle(80)
const workflowItem4 = $('[data-cmf="workflow-item"][data-cmf-id="' + workflowId + '"]')
if (workflowItem4 !== null) await click(workflowItem4)
await settle(260)
await click($('[data-cmf="zoom-fit"]'))
await settle(100)
await pointer(stageEl(), 'pointerdown', { clientX: 20, clientY: 220, pointerId: 9 })
await pointer(stageEl(), 'pointermove', { clientX: 540, clientY: 760, pointerId: 9 })
await settle(100)
dump('13-box-select-dark', { theme: 'dark' })
await pointer(stageEl(), 'pointerup', { clientX: 540, clientY: 760, pointerId: 9 })
await settle(140)

console.log('\n[preview] 14-context-menu-dark')
await contextmenu(stageEl(), { clientX: 300, clientY: 520 })
dump('14-context-menu-dark', { theme: 'dark' })

// ── 7. 截图 + 自证 ─────────────────────────────────────────────────────
console.log('\n[preview] 生成 ' + states.length + ' 个状态 HTML：')
for (const state of states) console.log('  ' + path.relative(ROOT, state))
console.log('\n[preview] 截图（Edge headless / CDP）…')
const shot = path.join(ROOT, 'tools', 'shot.mjs')
const shotOutput = execFileSync(process.execPath, [shot, String(WIDTH), String(HEIGHT), OUT, ...states], { encoding: 'utf8' })
console.log(shotOutput)
let shotResult = null
try {
  shotResult = JSON.parse(shotOutput)
} catch {
  console.error('[preview] shot.mjs 输出不是 JSON，无法自证')
}
if (shotResult !== null) {
  const byState = new Map(shotResult.results.map((item) => [item.state, item]))
  /** WCAG 相对亮度对比（简单版）：用来断言 primary 按钮不会白底白字。 */
  const parseRgb = (text) => {
    const numbers = String(text || '').match(/(\d+(?:\.\d+)?)/g)
    return numbers !== null && numbers.length >= 3 ? numbers.slice(0, 3).map(Number) : null
  }
  const relativeLuminance = (rgb) => {
    const channels = rgb.map((value) => {
      const channel = value / 255
      return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  }
  const readableContrast = (foreground, background) => {
    const fg = parseRgb(foreground)
    const bg = parseRgb(background)
    if (fg === null || bg === null) return false
    const a = relativeLuminance(fg)
    const b = relativeLuminance(bg)
    const high = Math.max(a, b)
    const low = Math.min(a, b)
    return (high + 0.05) / (low + 0.05) >= 3
  }
  const expect = [
    ['03-canvas', (probe) => probe.root === true && probe.nodes === EXPECT_NODES && probe.edges === Math.min(EXPECT_EDGES, 500) && probe.zoom === EXPECT_ZOOM
      && readableContrast(probe.runFg, probe.runBg)],
    ['04-params', (probe) => probe.drawer === true && probe.nodes === EXPECT_NODES],
    ['05-queued', (probe) => probe.nodes === EXPECT_NODES],
    ['06-results', (probe) => probe.results === EXPECT_RESULTS && probe.rcards >= Math.min(1, EXPECT_RESULTS) && readableContrast(probe.runFg, probe.runBg)],
    ['07-preview', (probe) => probe.preview === true],
    ['08-offline', (probe) => probe.root === true && probe.status === 'offline' && readableContrast(probe.runFg, probe.runBg)],
    ['09-canvas-dark', (probe) => probe.theme === 'dark' && probe.nodes === EXPECT_NODES && probe.zoom === EXPECT_ZOOM],
    ['10-results-dark', (probe) => probe.theme === 'dark' && probe.results === EXPECT_RESULTS && readableContrast(probe.runFg, probe.runBg)],
    ['11-box-select-light', (probe) => probe.theme === 'light' && probe.marquee === true && probe.nodes === EXPECT_NODES],
    ['12-context-menu-light', (probe) => probe.theme === 'light' && probe.menu === true],
    ['13-box-select-dark', (probe) => probe.theme === 'dark' && probe.marquee === true],
    ['14-context-menu-dark', (probe) => probe.theme === 'dark' && probe.menu === true],
  ]
  let failed = 0
  console.log('\n== 截图自证 ==')
  for (const [name, check_] of expect) {
    const item = byState.get(name)
    const probe = item === undefined ? undefined : item.probe
    const passed = probe !== undefined && check_(probe)
    if (!passed) failed += 1
    console.log((passed ? '  ✓ ' : '  ✗ ') + name + '  ' + JSON.stringify(probe))
  }
  const interactionFailures = interactionChecks.filter((item) => item.ok !== true).length
  console.log('\n== 交互断言 ==  ' + (interactionChecks.length - interactionFailures) + '/' + interactionChecks.length + ' 通过')
  for (const item of interactionChecks) {
    if (item.ok !== true) console.log('  ✗ ' + item.name + (item.detail === '' ? '' : '  ' + item.detail))
  }
  failed += interactionFailures
  console.log('\nPNG 输出目录：' + OUT)
  if (failed > 0) {
    console.error('FAIL ' + failed + ' 个状态截图自证不通过')
    process.exit(1)
  }
  console.log('PASS 全部 ' + expect.length + ' 个状态自证通过')
}
process.exit(0)
