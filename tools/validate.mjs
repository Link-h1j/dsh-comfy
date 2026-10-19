#!/usr/bin/env node
/**
 * Offline converter validation for the dsh-comfy host half (CONTRACT.md §4/§7).
 *
 * Converts every discoverable workflow — user (must be 100%), workspace, and all
 * official templates — to an API prompt against the live `/object_info`, then
 * classifies failures:
 *
 *   unknown-node     ComfyUI does not have that class_type (missing custom node:
 *                    counts as "environment", not a converter bug)
 *   missing-required a class_type exists but the converted prompt lacks a required
 *                    input (converter bug or a genuinely broken file)
 *   convert-error    any other converter exception
 *   parse-error      file could not be read/parsed as JSON
 *   graph-error      /workflow normalization crashed (would 500 the endpoint)
 *   positional-mismatch  converted, but `widgets_values` counts disagree with
 *                    object_info (silent-misalignment risk; reported separately)
 *
 * Exit code 0 when user workflows are 100%, workspace workflows are 100%,
 * templates pass >= 90% after excluding unknown-node failures, and no graph errors.
 *
 * Usage: node tools/validate.mjs [--verbose]
 */
import { createRequire } from 'node:module'
import * as comfy from '../lib/comfy.js'
import * as sources from '../lib/sources.js'
import { ConvertError, uiToPrompt } from '../lib/convert.js'
import { toGraph } from '../lib/graph.js'

const VERBOSE = process.argv.includes('--verbose')
const SAMPLE_LIMIT = VERBOSE ? 200 : 12

/** Per-source counters. */
function emptyStats() {
  return {
    total: 0, ok: 0,
    unknownNode: 0, subgraphNode: 0, missingRequired: 0, convertError: 0, parseError: 0, graphError: 0,
    positionalMismatch: 0, namedUnknownParams: 0,
    failures: [], graphFailures: [], suspect: [],
  }
}

/** Classify a conversion exception. */
function classifyConversionError(error) {
  if (error instanceof ConvertError) {
    if (error.code === 'unknown-node') return 'unknownNode'
    if (error.code === 'subgraph-node') return 'subgraphNode'
    if (error.code === 'missing-required') return 'missingRequired'
    return 'convertError'
  }
  return 'convertError'
}

/** Convert one workflow with classification; `kind` comes from the file heuristic. */
function convertOne(itemId, workflow, objectInfo, stats) {
  let result
  try {
    result = uiToPrompt(workflow, objectInfo)
  } catch (error) {
    const bucket = classifyConversionError(error)
    stats[bucket] += 1
    stats.failures.push({
      id: itemId,
      bucket,
      message: error?.message ?? String(error),
      code: error?.code ?? '',
      nodeId: error?.details?.nodeId ?? '',
      nodeType: error?.details?.nodeType ?? '',
    })
    return { ok: false, warnings: [] }
  }
  stats.ok += 1
  const warnings = result.warnings ?? []
  const positional = warnings.filter(warning => /widget 数量不匹配/.test(warning))
  if (positional.length > 0) {
    stats.positionalMismatch += 1
    stats.suspect.push({ kind: 'positional-mismatch', id: itemId, message: positional.slice(0, 3).join('；') })
  }
  const unknownParams = warnings.filter(warning => /未定义参数/.test(warning))
  if (unknownParams.length > 0) stats.namedUnknownParams += 1
  return { ok: true, warnings }
}

/** Normalize one workflow and count graph failures (endpoint must never 500). */
function graphOne(itemId, workflow, objectInfo, stats) {
  try {
    return toGraph(workflow, objectInfo)
  } catch (error) {
    stats.graphError += 1
    stats.graphFailures.push({ id: itemId, message: error?.message ?? String(error) })
    return null
  }
}

/** Short summary line for one source. */
function printSourceSummary(label, stats) {
  const failures = stats.total - stats.ok
  // unknown-node = missing custom node (environment issue);
  // subgraph-node = frontend subgraph expansion, not implemented by contract.
  const adjustedDenominator = stats.total - stats.unknownNode - stats.subgraphNode
  const adjustedRate = adjustedDenominator > 0 ? (stats.ok / adjustedDenominator) * 100 : 100
  console.log(`\n[${label}]`)
  console.log(`  total=${stats.total} ok=${stats.ok} failed=${failures} passRate=${((stats.ok / Math.max(stats.total, 1)) * 100).toFixed(1)}%`)
  console.log(`  failures: unknown-node=${stats.unknownNode} subgraph-node=${stats.subgraphNode} missing-required=${stats.missingRequired} convert-error=${stats.convertError} parse-error=${stats.parseError}`)
  console.log(`  adjusted pass rate (excluding unknown-node/subgraph): ${adjustedRate.toFixed(1)}%  [${stats.ok}/${Math.max(adjustedDenominator, 1)}]`)
  console.log(`  warnings: positional-mismatch=${stats.positionalMismatch} unknown-named-params=${stats.namedUnknownParams} graph-errors=${stats.graphError}`)
  if (VERBOSE || failures > 0) {
    for (const [bucket, items] of Object.entries(groupBy(stats.failures, failure => failure.bucket))) {
      const ordered = bucket === 'unknownNode' ? items : items
      console.log(`  -- ${bucket}:`)
      for (const item of ordered.slice(0, SAMPLE_LIMIT)) {
        const where = item.nodeId ? ` [node ${item.nodeId} ${item.nodeType}]` : ''
        console.log(`     ${item.id}${where}: ${item.message}`)
      }
      if (ordered.length > SAMPLE_LIMIT) console.log(`     … ${ordered.length - SAMPLE_LIMIT} more`)
    }
    for (const item of stats.graphFailures.slice(0, SAMPLE_LIMIT)) {
      console.log(`  -- graph-error ${item.id}: ${item.message}`)
    }
  }
}

/** Group array items by a key function (plain object result). */
function groupBy(items, keyOf) {
  const out = {}
  for (const item of items) {
    const key = keyOf(item)
    if (out[key] === undefined) out[key] = []
    out[key].push(item)
  }
  return out
}

async function main() {
  const startedAt = Date.now()
  console.log('dsh-comfy converter validation')
  console.log('ComfyUI base:', comfy.configuredBaseUrl())

  let objectInfo
  try {
    objectInfo = await comfy.getObjectInfo()
  } catch (error) {
    console.error('\n无法读取 ComfyUI /object_info —— 请先启动 ComfyUI（B:\\ComfyUI\\start_comfyui.ps1）。')
    console.error('错误：', error?.message ?? String(error))
    process.exitCode = 2
    return
  }
  console.log('object_info nodes:', Object.keys(objectInfo).length)

  const listed = await sources.listWorkflows()
  console.log('sources:', listed.sources.map(source => `${source.id}=${source.count}`).join(', '))

  const statsBySource = new Map([
    ['user', emptyStats()],
    ['workspace', emptyStats()],
    ['templates', emptyStats()],
  ])
  const perItem = []

  for (const item of listed.items) {
    const stats = statsBySource.get(item.source) ?? (statsBySource.set(item.source, emptyStats()), statsBySource.get(item.source))
    stats.total += 1
    const record = { id: item.id, source: item.source, kind: item.kind }
    let workflow
    try {
      const loaded = await sources.readWorkflow(item.id)
      workflow = loaded.json
    } catch (error) {
      stats.parseError += 1
      stats.failures.push({ id: item.id, bucket: 'parseError', message: error?.message ?? String(error), nodeId: '', nodeType: '' })
      perItem.push({ ...record, ok: false, bucket: 'parseError' })
      continue
    }
    const converted = convertOne(item.id, workflow, objectInfo, stats)
    graphOne(item.id, workflow, objectInfo, stats)
    perItem.push({ ...record, ok: converted.ok })
  }

  let userStats
  let workspaceStats
  let templateStats
  for (const [sourceId, stats] of statsBySource) {
    const label = sourceId === 'user' ? 'user（本机工作流，必须 100%）'
      : sourceId === 'workspace' ? 'workspace（工作区）'
        : sourceId === 'templates' ? 'templates（官方模板）' : sourceId
    userStats = sourceId === 'user' ? stats : userStats
    workspaceStats = sourceId === 'workspace' ? stats : workspaceStats
    templateStats = sourceId === 'templates' ? stats : templateStats
    printSourceSummary(label, stats)
  }

  const templateAdjustedDenominator = (templateStats?.total ?? 0) - (templateStats?.unknownNode ?? 0) - (templateStats?.subgraphNode ?? 0)
  const templateAdjustedRate = templateAdjustedDenominator > 0
    ? ((templateStats?.ok ?? 0) / templateAdjustedDenominator) * 100
    : 100

  const userRate = userStats && userStats.total > 0 ? (userStats.ok / userStats.total) * 100 : 100
  const workspaceRate = workspaceStats && workspaceStats.total > 0 ? (workspaceStats.ok / workspaceStats.total) * 100 : 100

  console.log('\n================ result ================')
  console.log(`user      : ${userStats?.ok ?? 0}/${userStats?.total ?? 0} (${userRate.toFixed(1)}%)`)
  console.log(`workspace : ${workspaceStats?.ok ?? 0}/${workspaceStats?.total ?? 0} (${workspaceRate.toFixed(1)}%)`)
  console.log(`templates : ${templateStats?.ok ?? 0}/${templateStats?.total ?? 0} raw=${(((templateStats?.ok ?? 0) / Math.max(templateStats?.total ?? 1, 1)) * 100).toFixed(1)}% adjusted=${templateAdjustedRate.toFixed(1)}%`)
  console.log(`elapsed   : ${((Date.now() - startedAt) / 1000).toFixed(2)}s`)

  const problems = []
  if (userRate < 100) problems.push('本机工作流转换未达到 100%')
  if (workspaceRate < 100) problems.push('工作区工作流转换未达到 100%')
  if (templateAdjustedRate < 90) problems.push('官方模板调整后通过率低于 90%')
  if ((userStats?.graphError ?? 0) + (workspaceStats?.graphError ?? 0) > 0) problems.push('本机/工作区工作流 Graph 归一化失败')

  if (problems.length === 0) {
    console.log('VALIDATE: PASS')
  } else {
    console.log('VALIDATE: FAIL —', problems.join('；'))
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('validate 崩溃：', error)
  process.exitCode = 3
})
