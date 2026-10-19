/**
 * 把可读源码 client.body.js 包成 DSH 浏览器半边要求的 client.js。
 *
 * 为什么必须包一层：浏览器侧加载器只认 `window.__ModuleLoader__.load({ id, factory })` 这种闭包工厂；
 * 正文里的 `module.exports` / `require` 只有放进 factory 的参数里才存在。
 *
 * 三道闸门（磁盘上的 client.js 永远保持上一个能跑的版本，绝不把坏包喂给 HMR）：
 *   1. vm.Script 只编译不执行 —— 语法错误直接拒绝写盘；
 *   2. 正文里不许有 ESM 顶层 import/export（浏览器加载器只支持 CJS 形态）；
 *   3. 正文里只允许 require('react')（平台模块表里本插件只声明了这一项）。
 *
 * 用法：
 *   node tools/build-client.mjs          生成 client.js
 *   node tools/build-client.mjs --check  只比对（CI / 自检用），不一致 exit 1
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BODY = path.join(ROOT, 'client.body.js')
const OUT = path.join(ROOT, 'client.js')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

if (!fs.existsSync(BODY)) {
  console.error('找不到 client.body.js：' + BODY)
  process.exit(1)
}
const body = fs.readFileSync(BODY, 'utf8').replace(/^\uFEFF/, '')

/** 失败时统一说明磁盘状态，避免有人以为已经写进去了。 */
function reject(message) {
  console.error('client.body.js 校验不过，拒绝生成 client.js：' + message)
  console.error('（磁盘上的 client.js 保持原样，HMR 不会拿到坏包）')
  process.exit(1)
}

// 闸门 1：语法（CJS 形态下编译，捕获 SyntaxError）
try {
  new vm.Script('(function (module, exports, require) {\n' + body + '\n})', { filename: 'client.body.js' })
} catch (error) {
  reject(error?.message ?? String(error))
}

// 闸门 2：正文里不许残留 ESM import/export
for (const [label, pattern] of [
  ['顶层 import 语句', /^\s*import\s+[^(]/m],
  ['顶层 export 语句', /^\s*export\s+(const|let|var|function|class|default|\{)/m],
]) {
  if (pattern.test(body)) {
    reject(`正文里有${label}，浏览器半边只支持 CJS 形态（require / module.exports）`)
  }
}

// 闸门 3：只允许 require('react')
const requireIds = new Set()
for (const match of body.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) requireIds.add(match[2])
const disallowed = [...requireIds].filter((id) => id !== 'react')
if (disallowed.length > 0) {
  reject('正文 require 了平台模块表以外的包：' + disallowed.join(', ') + '（本插件只允许 require(\'react\')）')
}

const indented = body.split('\n').map((line) => (line.trim() === '' ? line : '\t\t' + line)).join('\n')

const generated = `/**
 * 生成物 —— 不要手改。可读源码在 client.body.js，改完跑：node tools/build-client.mjs
 * 包名 ${PKG.name} 必须与 __ModuleLoader__.load({ id }) 以及 profile 里的 loader 行一致。
 */
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PKG.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${indented}
\t\treturn module.exports;
\t},
});
`

// 闸门 4：包出来的产物也必须能编译（防止缩进/拼接引入语法问题）
try {
  new vm.Script(generated, { filename: 'client.js' })
} catch (error) {
  reject('wrapper 产物语法错误：' + (error?.message ?? String(error)))
}

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
  if (current !== generated) {
    console.error('client.js 与 client.body.js 不一致，请跑一次 node tools/build-client.mjs')
    process.exit(1)
  }
  console.log('client.js 是最新的 ✅（' + generated.length + ' 字节）')
  process.exit(0)
}

fs.writeFileSync(OUT, generated)
console.log(`已生成 ${path.relative(ROOT, OUT)}（正文 ${body.split('\n').length} 行 → 产物 ${generated.length} 字节）`)
