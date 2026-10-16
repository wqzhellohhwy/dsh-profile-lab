/**
 * dsh-profile-lab —— 驻留 web 实例：起 / 探 / 停 一个临时 profile 的真实 web 服务。
 *
 * 为什么需要它：headless 探针只能验 **host 侧装配**（entry 激不激活、工具面对不对），
 * 验不了「渲染端/HTTP 面」——那里没有 HTTP 服务。要看插件的 host 路由、要让页面真的
 * 跑起来，就得在临时 profile 上起一个真实的 web 实例。
 *
 * 这与本插件"同步、不驻留"的既有取向是**刻意破例**的，所以护栏加倍：
 *   1. 同一 profile 只允许一个实例（进程内表互斥），起之前先挑空闲端口；
 *   2. 实例进程留在宿主的 Job Object 里（不 detach）——宿主退出会连带杀掉；
 *      另外插件卸载时 `killAllWebInstances()` 会主动清一遍；
 *   3. stdout/stderr 只留尾部环形缓冲，避免长跑把内存吃光；
 *   4. 停止一律 `taskkill /T /F`（Windows 上 child.kill 带不走孙进程）；
 *   5. 探针只打 127.0.0.1，不跟随重定向。
 *
 * @module dsh-profile-lab/web
 */

import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { killTree, profileBundles } from './runner.js'

/** web 能力所需的 bundle。 */
const WEB_BUNDLE = '@deepseek-ai/dsh-web-app'

/** 探针 profile 用的 headless bundle（含它 = app 是 headless，不能起 web）。 */
const HEADLESS_BUNDLE = '@deepseek-ai/dsh-headless'

/**
 * 起 web 实例前的能力预检（2026-10-16 用户实测反馈）。
 *
 * 实测结论：**一个 profile 只能有一个 app**。往 headless 模板建的 profile 里补
 * `@deepseek-ai/dsh-web-app` 也没用 —— `dsh --profile <n> --help` 仍打印 headless app
 * 的用法，`--port` 被当成未知参数，端口上根本没有我们的服务。所以这里**不做自动补
 * bundle**，只做准确预检 + 可执行指引。
 * @param {string} profile profile 名。
 * @param {string} [home] DSH_HOME。
 * @returns {{ok: boolean, message?: string}} 结果。
 */
function assertWebCapable(profile, home) {
  const bundles = profileBundles(profile, home)
  if (bundles === null) return { ok: true } // 读不到就不拦（兼容非常规 profile）
  if (bundles.includes(HEADLESS_BUNDLE)) {
    return {
      ok: false,
      message: `profile ${JSON.stringify(profile)} 的 app 是 headless（bundles 含 ${HEADLESS_BUNDLE}），`
        + `不能起 web 实例 —— 一个 profile 只能有一个 app。`
        + `请用 tmpprofile_create({ template: 'web' }) 建 web 探针，或从 web 型 profile 克隆。`,
    }
  }
  if (!bundles.includes(WEB_BUNDLE)) {
    return {
      ok: false,
      message: `profile ${JSON.stringify(profile)} 缺 ${WEB_BUNDLE}，起不了 web 实例。`
        + `请用 tmpprofile_create({ template: 'web' }) 建 web 探针，或从 web 型 profile 克隆。`,
    }
  }
  return { ok: true }
}

/** 默认首选端口（本机习惯值；被占则自动往上找）。 */
export const DEFAULT_WEB_PORT = 19399

/** 起实例后等端口就绪的默认上限（毫秒）。 */
export const DEFAULT_READY_TIMEOUT_MS = 45_000

/** 每个实例保留的日志尾部字节数。 */
const LOG_TAIL_CHARS = 16 * 1024

/** 进程内实例表：profile 名 → 实例记录。 */
const instances = new Map()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 找一个空闲端口（从首选值往上试）。
 * @param {number} [preferred] 首选端口，默认 19399。
 * @param {number} [attempts] 最多往上试多少个。
 * @returns {Promise<number>} 可用端口。
 */
export function pickFreePort(preferred = DEFAULT_WEB_PORT, attempts = 100) {
  return new Promise((resolve, reject) => {
    const attempt = (port, left) => {
      const server = createServer()
      server.unref()
      server.on('error', (error) => {
        if (error?.code === 'EADDRINUSE' && left > 0) {
          attempt(port + 1, left - 1)
          return
        }
        reject(error)
      })
      server.listen({ port, host: '127.0.0.1' }, () => {
        const address = server.address()
        const actual = typeof address === 'object' && address !== null ? address.port : port
        server.close(() => resolve(actual))
      })
    }
    attempt(preferred, attempts)
  })
}

/**
 * 能否连上某个端口。
 * @param {number} port 端口。
 * @param {number} [timeoutMs] 单次连接超时。
 * @returns {Promise<boolean>} 可连接返回 true。
 */
function canConnect(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* 已关闭 */
      }
      resolve(value)
    }
    const socket = connect({ port, host: '127.0.0.1' })
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.on('connect', () => finish(true))
    socket.on('error', () => finish(false))
  })
}

/**
 * 等端口就绪（同时盯着子进程有没有提前死掉）。
 * @param {number} port 端口。
 * @param {number} timeoutMs 上限。
 * @param {() => boolean} isAlive 子进程是否还活着。
 * @returns {Promise<{ok: boolean, reason?: string}>} 结果。
 */
async function waitForPort(port, timeoutMs, isAlive) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive()) return { ok: false, reason: 'process-exited' }
    if (await canConnect(port)) return { ok: true }
    await sleep(300)
  }
  return { ok: false, reason: 'timeout' }
}

/**
 * 等端口被释放（停止后的确认）。
 * @param {number} port 端口。
 * @param {number} timeoutMs 上限。
 * @returns {Promise<boolean>} 已释放返回 true。
 */
async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await canConnect(port, 400))) return true
    await sleep(200)
  }
  return !(await canConnect(port, 400))
}

/**
 * 起一个 web 实例（异步等到端口就绪再返回）。
 * @param {object} options 参数。
 * @param {{execPath: string, asNode: boolean, binPath: string, version?: string}} options.dsh dsh 运行器。
 * @param {string} options.profile 临时 profile 名（调用方负责确认已登记）。
 * @param {string} [options.home] DSH home（写进子进程 DSH_HOME）。
 * @param {number} [options.port] 指定端口；缺省自动挑空闲端口。
 * @param {number} [options.waitMs] 就绪等待上限。
 * @param {string} [options.probePath] 就绪后顺带探一次该路径。
 * @param {string} [options.cwd] 子进程工作目录。
 * @param {Record<string, string>} [options.env] 额外环境变量。
 * @returns {Promise<object>} 结果（ok=false 时带 reason 与日志尾部）。
 * @throws {Error} 同一 profile 已有实例在跑时。
 */
export async function startWebInstance(options) {
  const { dsh, profile } = options
  const existing = instances.get(profile)
  if (existing !== undefined) {
    if (!existing.exited) {
      throw new Error(`profile ${JSON.stringify(profile)} 已有一个 web 实例在跑（pid=${existing.pid}，端口 ${existing.port}）；先 tmpprofile_web_stop`)
    }
    instances.delete(profile)
  }

  const port = options.port ?? (await pickFreePort(DEFAULT_WEB_PORT))
  if (options.port !== undefined && (await canConnect(port, 300))) {
    return { ok: false, reason: 'port-in-use', port, message: `端口 ${port} 已被占用；换一个或省掉 port 让它自动挑` }
  }

  // 起 web 实例前的能力预检（2026-10-16 用户实测）：headless 型 profile 起不了 web。
  const webReady = assertWebCapable(profile, options.home)
  if (!webReady.ok) {
    return { ok: false, reason: 'not-a-web-profile', port, message: webReady.message }
  }

  const env = { ...process.env, ...(options.env ?? {}) }
  if (dsh.asNode) env.ELECTRON_RUN_AS_NODE = '1'
  if (typeof options.home === 'string' && options.home !== '') env.DSH_HOME = options.home
  const cwd = options.cwd ?? process.env.DSH_LAB_CWD ?? process.cwd()
  const args = [dsh.binPath, '--profile', profile, '--port', String(port)]

  const record = { profile, pid: undefined, port, at: new Date().toISOString(), log: '', exited: false, exitCode: null, child: undefined }
  let child
  try {
    child = spawn(dsh.execPath, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return { ok: false, reason: 'spawn-failed', port, message: String(error?.message ?? error) }
  }
  record.child = child
  record.pid = child.pid
  instances.set(profile, record)

  const append = (chunk) => {
    record.log += chunk.toString('utf8')
    if (record.log.length > LOG_TAIL_CHARS) record.log = record.log.slice(-LOG_TAIL_CHARS)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.on('error', (error) => {
    record.exited = true
    record.exitCode = -1
    append(`\n[spawn error] ${String(error?.message ?? error)}\n`)
  })
  child.on('close', (code) => {
    record.exited = true
    record.exitCode = code
  })

  const ready = await waitForPort(port, options.waitMs ?? DEFAULT_READY_TIMEOUT_MS, () => !record.exited)
  if (!ready.ok) {
    killTree(child.pid)
    record.exited = true
    instances.delete(profile)
    return {
      ok: false,
      reason: ready.reason,
      port,
      pid: child.pid,
      exitCode: record.exitCode,
      logTail: record.log.trim().slice(-1500),
      message: ready.reason === 'timeout'
        ? `等 ${port} 就绪超时（${options.waitMs ?? DEFAULT_READY_TIMEOUT_MS}ms）；已杀进程树`
        : '子进程在端口就绪前退出',
    }
  }

  const result = {
    ok: true,
    profile,
    pid: child.pid,
    port,
    url: `http://127.0.0.1:${port}/`,
    ready: true,
    logTail: record.log.trim().slice(-1200),
  }
  if (typeof options.probePath === 'string' && options.probePath !== '') {
    result.probe = await probeHttp({ port, path: options.probePath, timeoutMs: 15_000 })
  }
  return result
}

/**
 * 探一次 HTTP（只打 127.0.0.1，不跟随重定向）。
 * @param {object} options 参数。
 * @param {number} options.port 端口。
 * @param {string} [options.path] 路径，默认 `/`。
 * @param {string} [options.method] 方法，默认 GET。
 * @param {number} [options.timeoutMs] 超时，默认 15s。
 * @param {number} [options.previewChars] body 预览字符数，默认 2000。
 * @returns {Promise<object>} 结果。
 */
export async function probeHttp(options) {
  const rawPath = typeof options.path === 'string' && options.path !== '' ? options.path : '/'
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  const url = `http://127.0.0.1:${options.port}${path}`
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? 15_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      redirect: 'manual',
      signal: controller.signal,
    })
    const text = await response.text()
    const limit = options.previewChars ?? 2000
    return {
      ok: true,
      url,
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      bytes: Buffer.byteLength(text, 'utf8'),
      bodyPreview: text.length > limit ? `${text.slice(0, limit)} …` : text,
    }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return { ok: false, url, error: aborted ? `超时（${timeoutMs}ms）` : String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 停掉一个 profile 的 web 实例（进程内表里的）。
 * @param {string} profile profile 名。
 * @param {{waitMs?: number}} [options] 选项。
 * @returns {Promise<object>} 结果。
 */
export async function stopWebInstance(profile, options = {}) {
  const record = instances.get(profile)
  if (record === undefined) return { ok: false, reason: 'not-running', message: `进程内没有 ${profile} 的 web 实例记录` }
  killTree(record.pid)
  const portFreed = await waitForPortFree(record.port, options.waitMs ?? 8000)
  instances.delete(profile)
  return {
    ok: true,
    profile,
    pid: record.pid,
    port: record.port,
    portFreed,
    logTail: record.log.trim().slice(-800),
  }
}

/**
 * 按 pid 停掉一个实例。
 *
 * 用途：插件被重载/重启后，进程内表是空的，但清单里还留着上次起的实例
 * （pid/port），这时只能按 pid 收。
 * @param {{pid?: number, port?: number}} info 实例信息。
 * @param {{waitMs?: number, profile?: string}} [options] 选项。
 * @returns {Promise<object>} 结果。
 */
export async function stopWebInstanceByPid(info, options = {}) {
  if (typeof info?.pid !== 'number') return { ok: false, reason: 'no-pid', message: '清单里没有该实例的 pid' }
  killTree(info.pid)
  const portFreed = typeof info.port === 'number' ? await waitForPortFree(info.port, options.waitMs ?? 8000) : undefined
  if (typeof options.profile === 'string') instances.delete(options.profile)
  return { ok: true, profile: options.profile, pid: info.pid, port: info.port, portFreed, recovered: true }
}

/**
 * 列出进程内已知实例（含已退出的，便于诊断）。
 * @returns {object[]} 实例摘要。
 */
export function listWebInstances() {
  return [...instances.values()].map((record) => ({
    profile: record.profile,
    pid: record.pid,
    port: record.port,
    at: record.at,
    exited: record.exited,
    exitCode: record.exitCode,
    route: `http://127.0.0.1:${record.port}/`,
  }))
}

/**
 * 某 profile 是否有活着的实例。
 * @param {string} profile profile 名。
 * @returns {boolean} 有活实例返回 true。
 */
export function isWebRunning(profile) {
  const record = instances.get(profile)
  return record !== undefined && !record.exited
}

/**
 * 同步杀掉本插件起的全部实例（插件卸载 / 宿主收尾时调用）。
 * @returns {number[]} 被杀掉的 pid 列表。
 */
export function killAllWebInstances() {
  const killed = []
  for (const record of instances.values()) {
    if (record.exited) continue
    killTree(record.pid)
    killed.push(record.pid)
  }
  instances.clear()
  return killed
}
