/**
 * dsh-profile-lab —— 运行器：dsh 可执行文件探测 + 同步 headless 子进程 + 事件解析。
 *
 * 两个已实测的事实决定了这里的形状：
 *
 * 1. **Desktop 的宿主是 Electron**：`process.execPath` 不是 node，但加上
 *    `ELECTRON_RUN_AS_NODE=1` 就能当 node 用（实测 `node v24.18.1`），且能加载
 *    `app.asar` 内的 `lib/bin.js`（实测 `-V` → `0.2.0-rc.2`，与宿主同版本）。
 * 2. **子进程在宿主的 Job Object 内**：宿主进程退出会连带杀掉它（历史事故已验证），
 *    所以这里只提供**同步、带超时**的调用，不做后台/脱离宿主的任务。
 *
 * @module dsh-profile-lab/runner
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 单次 headless 运行的默认超时（毫秒）。 */
export const DEFAULT_RUN_TIMEOUT_MS = 300_000
/** 允许的最大超时（毫秒）。 */
export const MAX_RUN_TIMEOUT_MS = 900_000
/** stdout/stderr 的收集上限，防止异常输出吃光内存。 */
const OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024

/** 探测结果缓存（键为候选路径，值为 `{version, ok}`）。 */
const probeCache = new Map()

/** 同一 profile 的运行互斥（进程内）。 */
const runningProfiles = new Set()

/**
 * 判断一个可执行文件是否需要 `ELECTRON_RUN_AS_NODE=1` 才能当 node 用。
 *
 * 两种情况：① 我们的进程本身就是 Electron（插件跑在 Desktop 宿主里）；
 * ② 调用方显式把 Electron 可执行文件当 node 传进来（`nodePath` 配置 / 测试）。
 * @param {string} execPath 可执行文件路径。
 * @returns {boolean} 需要 `ELECTRON_RUN_AS_NODE` 返回 true。
 */
export function isElectronRuntime(execPath = process.execPath) {
  if (typeof process.versions?.electron === 'string') return true
  return /(^|[\\/])(electron|DeepSeek Harness)\.exe$/i.test(execPath)
}

/**
 * 列出 dsh bin.js 的候选路径（按优先级）。
 * @param {{dshBin?: string, installAnchor?: string, home?: string}} [options] 线索。
 * @returns {{binPath: string, source: string}[]} 候选列表。
 */
export function dshBinCandidates(options = {}) {
  const candidates = []
  const fromConfig = options.dshBin ?? process.env.DSH_LAB_DSH_BIN
  if (typeof fromConfig === 'string' && fromConfig !== '') {
    candidates.push({ binPath: fromConfig, source: 'DSH_LAB_DSH_BIN/配置' })
  }
  if (typeof options.installAnchor === 'string' && options.installAnchor !== '') {
    // installAnchor 形如 `<...>/@deepseek-ai/dsh/package.json`
    candidates.push({ binPath: join(dirname(options.installAnchor), 'lib', 'bin.js'), source: '宿主安装锚点' })
  }
  const appData = process.env.APPDATA
  if (typeof appData === 'string' && appData !== '') {
    candidates.push({
      binPath: join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      source: 'npm 全局安装',
    })
  }
  const runtimeRoot = process.env.DSH_RUNTIME_DIR ?? 'C:\\dsh-runtime'
  try {
    for (const entry of readdirSync(runtimeRoot)) {
      candidates.push({
        binPath: join(runtimeRoot, entry, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        source: `dsh-runtime/${entry}`,
      })
    }
  } catch {
    /* 目录不存在就算了 */
  }
  return candidates
}

/**
 * 用 `-V` 试跑一个候选，确认它真的能被加载。
 *
 * 注意：`app.asar` 是文件，`existsSync` 看不到内部路径（返回 false），
 * 但 Electron 的 node 能加载——所以判定必须靠**试跑**，不能靠 `existsSync`。
 * @param {{execPath: string, asNode: boolean, binPath: string}} candidate 候选。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<string|undefined>} 版本号；不可用返回 undefined。
 */
export function probeCandidate(candidate, timeoutMs = 25_000) {
  const key = `${candidate.execPath}|${candidate.asNode}|${candidate.binPath}`
  if (probeCache.has(key)) return Promise.resolve(probeCache.get(key))
  return new Promise((resolve) => {
    const env = { ...process.env }
    if (candidate.asNode) env.ELECTRON_RUN_AS_NODE = '1'
    let child
    try {
      child = spawn(candidate.execPath, [candidate.binPath, '-V'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      probeCache.set(key, undefined)
      resolve(undefined)
      return
    }
    const chunks = []
    const timer = setTimeout(() => killTree(child.pid), timeoutMs)
    child.stdout?.on('data', (chunk) => chunks.push(chunk))
    child.stderr?.on('data', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      probeCache.set(key, undefined)
      resolve(undefined)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = Buffer.concat(chunks).toString('utf8').trim()
      const version = code === 0 && /^\d/.test(text) ? text.split(/\s+/)[0] : undefined
      probeCache.set(key, version)
      resolve(version)
    })
  })
}

/**
 * 解析当前可用的 dsh 可执行文件。
 *
 * 优先级：显式配置 → 宿主安装锚点（版本与宿主一致，兼容性最好）→ npm 全局 → dsh-runtime。
 * @param {{dshBin?: string, nodePath?: string, installAnchor?: string}} [options] 线索。
 * @returns {Promise<{execPath: string, asNode: boolean, binPath: string, version: string, source: string}>} 结果。
 * @throws {Error} 全部候选都不可用时。
 */
export async function resolveDshRunner(options = {}) {
  const execPath = options.nodePath ?? process.env.DSH_LAB_NODE ?? process.execPath
  const asNode = isElectronRuntime(execPath)
  const tried = []
  for (const candidate of dshBinCandidates(options)) {
    const full = { execPath, asNode, binPath: candidate.binPath }
    const version = await probeCandidate(full)
    if (version !== undefined) return { ...full, version, source: candidate.source }
    tried.push(`${candidate.source}: ${candidate.binPath}`)
  }
  throw new Error(`找不到可用的 dsh 可执行文件；已尝试：\n  - ${tried.join('\n  - ')}`)
}

/**
 * 杀掉一个进程及其整棵子树。
 *
 * Windows 上 `child.kill()` 不会带走孙进程（历史事故：重启脚本被连带杀死过，
 * 反向也一样要防），所以用 `taskkill /T /F`。
 * @param {number|undefined} pid 进程号。
 */
export function killTree(pid) {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      /* 忽略 */
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
}

/**
 * 解析 headless `--json` 输出的 NDJSON 事件流。
 * @param {string} stdout 标准输出。
 * @returns {{events: object[], malformed: number}} 解析结果。
 */
export function parseJsonEvents(stdout) {
  const events = []
  let malformed = 0
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || !trimmed.startsWith('{')) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      malformed += 1
    }
  }
  return { events, malformed }
}

/**
 * 从 headless 事件流里取最终回答文本。
 * @param {object[]} events 事件。
 * @returns {string|undefined} 最终文本。
 */
export function finalTextOf(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'final') {
      if (typeof event.text === 'string') return event.text
      if (typeof event.message === 'string') return event.message
    }
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'assistant/message') {
      const content = event?.data?.message?.content
      if (Array.isArray(content)) {
        const text = content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
        if (text !== '') return text
      }
    }
  }
  return undefined
}

/**
 * 从 headless 事件流里取会话 id。
 * @param {object[]} events 事件。
 * @returns {string|undefined} 会话 id。
 */
export function sessionIdOf(events) {
  for (const event of events) {
    const id = event?.sessionId ?? event?.session?.id ?? event?.data?.sessionId
    if (typeof id === 'string' && id.startsWith('session-')) return id
    if (event?.type === 'session' && typeof event.id === 'string') return event.id
  }
  return undefined
}

/**
 * 在某个 cwd 的会话目录里找最近的会话文件（无 `--json` 时用来回捞 sessionId）。
 * @param {string} sessionDir 会话目录。
 * @returns {{sessionId: string, file: string}|undefined} 最近的会话。
 */
export function latestSessionIn(sessionDir) {
  try {
    let best
    for (const sid of readdirSync(sessionDir)) {
      const file = join(sessionDir, sid, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      const mtime = statSync(file).mtimeMs
      if (best === undefined || mtime > best.mtime) best = { sessionId: sid, file, mtime }
    }
    return best === undefined ? undefined : { sessionId: best.sessionId, file: best.file }
  } catch {
    return undefined
  }
}

/**
 * 同步跑一次 headless 会话。
 * @param {object} options 运行参数。
 * @param {{execPath: string, asNode: boolean, binPath: string, version: string}} options.dsh 运行器。
 * @param {string} options.profile 目标 profile。
 * @param {string} options.task 任务文本。
 * @param {string} [options.sessionId] 复用会话。
 * @param {boolean} [options.json] 是否要 NDJSON 事件流（默认 true）。
 * @param {Record<string, string>} [options.env] 额外环境变量。
 * @param {number} [options.timeoutMs] 超时。
 * @param {string} [options.cwd] 子进程工作目录（决定会话落在哪个 cwd 目录下）。
 * @returns {Promise<object>} 运行结果。
 * @throws {Error} 同一 profile 已在运行时。
 */
export function runHeadless(options) {
  const { dsh, profile, task } = options
  if (runningProfiles.has(profile)) throw new Error(`profile ${JSON.stringify(profile)} 已有一次 headless 运行在进行，拒绝并发`)
  const json = options.json ?? true
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS)
  const cwd = options.cwd ?? join(process.env.USERPROFILE ?? homedir(), 'Documents')
  const args = [
    dsh.binPath,
    '--profile',
    profile,
    ...(typeof options.sessionId === 'string' && options.sessionId !== '' ? ['--session-id', options.sessionId] : []),
    ...(json ? ['--json'] : []),
    task,
  ]
  const env = { ...process.env, ...(options.env ?? {}) }
  if (dsh.asNode) env.ELECTRON_RUN_AS_NODE = '1'
  if (typeof env.DSH_HOME !== 'string' || env.DSH_HOME === '') env.DSH_HOME = join(homedir(), '.dsh')

  runningProfiles.add(profile)
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(dsh.execPath, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      runningProfiles.delete(profile)
      reject(error)
      return
    }
    const stdoutChunks = []
    const stderrChunks = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= OUTPUT_LIMIT_BYTES) stdoutChunks.push(chunk)
      else truncated = true
    })
    child.stderr?.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes <= OUTPUT_LIMIT_BYTES) stderrChunks.push(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      runningProfiles.delete(profile)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      runningProfiles.delete(profile)
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      const { events, malformed } = json ? parseJsonEvents(stdout) : { events: [], malformed: 0 }
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
        stdoutBytes,
        stderrBytes,
        stdout,
        stderr,
        events,
        malformedEvents: malformed,
        finalText: json ? finalTextOf(events) : stdout.trim(),
        sessionId: json ? sessionIdOf(events) : undefined,
        pid: child.pid,
      })
    })
  })
}

/**
 * 跑一次 dsh 子命令并把输出收集回来（不跑 agent，只用 CLI 面）。
 *
 * 用于 `--from-default-profile ... --dump-config`（建 profile 而不启动）与
 * `plugin --profile <n> add ...`（装插件）这类**非 agent** 调用。
 * @param {{execPath: string, asNode: boolean, binPath: string}} dsh 运行器。
 * @param {string[]} args bin.js 之后的参数。
 * @param {{cwd?: string, env?: Record<string, string>, timeoutMs?: number, home?: string}} [options] 选项。
 * @returns {Promise<{ok: boolean, exitCode: number|null, stdout: string, stderr: string, timedOut: boolean, durationMs: number}>} 结果。
 */
export function runDshOnce(dsh, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000
  const env = { ...process.env, ...(options.env ?? {}) }
  if (dsh.asNode) env.ELECTRON_RUN_AS_NODE = '1'
  if (typeof options.home === 'string' && options.home !== '') env.DSH_HOME = options.home
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(dsh.execPath, [dsh.binPath, ...args], {
        cwd: options.cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }
    const out = []
    const err = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => out.push(chunk))
    child.stderr?.on('data', (chunk) => err.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        durationMs: Date.now() - startedAt,
      })
    })
  })
}

/**
 * 读一个 JSON 文件（容错）。
 * @param {string} file 路径。
 * @returns {object|undefined} 解析结果。
 */
export function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}
