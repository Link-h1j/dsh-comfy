/**
 * Detached ComfyUI launcher for `POST /api/dsh-comfy/start` (CONTRACT.md §2).
 *
 * The plugin must never own/stop the ComfyUI process: it only spawns the
 * user's own start script detached, ignoring all stdio, and relies on the
 * regular /status probe to detect when ComfyUI is up. Repeated clicks are
 * idempotent: while ComfyUI is reachable or a launch is in flight, nothing is
 * spawned again.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import * as comfy from './comfy.js'
import { startScript } from './sources.js'

/** Minimum delay between two launch attempts (ms). */
const MIN_LAUNCH_INTERVAL_MS = 30_000

/** Error raised by the launcher; `status` maps to HTTP. */
export class StartError extends Error {
  constructor(message, { status = 500, code = 'start-error' } = {}) {
    super(message)
    this.name = 'StartError'
    this.status = status
    this.code = code
  }
}

/** Time of the last launch attempt and whether a spawn is currently in flight. */
let lastLaunchAt = 0
let launching = false

/** Where the start script is expected (also used by /status). */
export function startScriptInfo() {
  return startScript()
}

/**
 * Launch `the configured ComfyUI start script` detached, then return immediately.
 * @returns {Promise<{ started: boolean, message: string }>}
 * @throws {StartError}
 */
export async function startComfy() {
  const script = startScript()
  if (!script.exists) {
    throw new StartError(`找不到 ComfyUI 启动脚本：${script.path}`, { status: 500, code: 'start-script-missing' })
  }

  const reachable = await comfy.checkReachable()
  if (reachable.reachable) {
    return { started: false, message: 'ComfyUI 已在运行' }
  }

  const now = Date.now()
  if (launching || now - lastLaunchAt < MIN_LAUNCH_INTERVAL_MS) {
    return { started: false, message: 'ComfyUI 正在启动中，请稍候…' }
  }

  launching = true
  lastLaunchAt = now
  try {
    const isWindows = process.platform === 'win32'
    const command = isWindows ? 'powershell.exe' : 'pwsh'
    const args = isWindows
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script.path]
      : ['-NoProfile', '-File', script.path]
    const child = spawn(command, args, {
      cwd: path.dirname(script.path),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    // The child may live for hours; never let its handle keep this process alive.
    child.unref()
    child.on('error', (error) => {
      console.error('[dsh-comfy] 启动 ComfyUI 失败:', error?.message ?? String(error))
    })
    return { started: true, message: '已启动 ComfyUI，模型加载约需 10–30 秒' }
  } catch (error) {
    throw new StartError(`启动 ComfyUI 失败：${error?.message ?? String(error)}`, { status: 500, code: 'start-spawn-failed' })
  } finally {
    launching = false
  }
}
