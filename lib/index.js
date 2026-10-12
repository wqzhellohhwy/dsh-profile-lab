/**
 * dsh-profile-lab —— DSH 插件入口。
 *
 * 装上之后，模型拿到九个 `tmpprofile_*` 工具，把「隔离测插件改动 / 跑探针会话 / 验渲染端」
 * 从"每次现写 pwsh + python"变成有护栏的标准动作：
 *
 *   建（模板 / 克隆）→ 装包 → 跑 headless（host 面）→ 起 web 实例（HTTP/渲染面）
 *   → 读回会话摘要 → 清理
 *
 * 配置（cordis 行 config，全部可选）：
 *   - `home`：DSH home（缺省 `$DSH_HOME` 或 `~/.dsh`）
 *   - `dshBin`：显式指定 dsh 的 `lib/bin.js`（缺省自动探测：宿主安装锚点 → npm 全局 → dsh-runtime）
 *   - `nodePath`：显式指定跑子进程用的 node（缺省 `process.execPath`；Electron 宿主会自动加 `ELECTRON_RUN_AS_NODE=1`）
 *   - `tools.disabled`：按名字关掉某些工具（例如做「工具面验证」时先关掉本插件的工具）
 *
 * 只注册宿主侧工具，不声明 `dsh.client`；`inject` 只写 `'tools'`——不写 `'webServer'`，
 * 这样在 headless / tui 这类没有 HTTP 服务的 profile 里插件也不会整体 pending。
 *
 * @module dsh-profile-lab
 */

import { appendLog, listProfiles, loadManifest } from './lab.js'
import { resolveHome } from './guards.js'
import { resolveDshRunner } from './runner.js'
import { buildTools } from './tools.js'
import { killAllWebInstances } from './web.js'

/** Cordis 插件名。 */
export const name = 'profile-lab'

/** 只依赖 tools 服务（注册工具，不注册模型可见的上下文）。 */
export const inject = ['tools']

/**
 * 注册全部 tmpprofile_* 工具。
 * @param {import('cordis').Context} ctx 宿主上下文。
 * @param {{home?: string, dshBin?: string, nodePath?: string, tools?: {disabled?: string[]}}} [config] 插件配置。
 */
export function apply(ctx, config = {}) {
  const home = () => resolveHome(config.home)

  /** dsh 运行器懒解析并缓存：探测要试跑 `-V`，不该在插件装配期阻塞。 */
  let runnerPromise
  const getRunner = () => {
    if (runnerPromise === undefined) {
      runnerPromise = (async () => {
        const profileContext = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined
        return resolveDshRunner({
          dshBin: config.dshBin,
          nodePath: config.nodePath,
          installAnchor: profileContext?.installAnchor,
        })
      })().catch((error) => {
        runnerPromise = undefined // 下次调用重试（例如用户先补上 DSH_LAB_DSH_BIN）
        throw error
      })
    }
    return runnerPromise
  }

  const log = (entry) => {
    try {
      appendLog(entry, home())
    } catch {
      /* 审计日志失败不影响主流程 */
    }
  }

  const tools = buildTools({ getRunner, getHome: home, log, toolConfig: config.tools })
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `profile-lab: ${tool.name}`)
  }

  // 驻留 web 实例的兜底清理：插件被卸载/重载时把本插件起的实例全杀掉。
  // （正常情况下子进程在宿主 Job Object 内，宿主退出会连带杀死；这一层是防插件单独热重载留下孤儿。）
  ctx.effect(() => () => {
    const killed = killAllWebInstances()
    if (killed.length > 0) log({ action: 'dispose:kill-web-instances', pids: killed })
  }, 'profile-lab: web instances')

  // 供其它插件/测试复用同一份实现（不注册模型可见的上下文）。
  if (typeof ctx.provide === 'function') {
    ctx.provide('profileLab', { home, listProfiles, loadManifest })
  }
}

export { buildTools } from './tools.js'
export { decodeZstdFrames, readSessionEvents, summarize } from './sessions.js'
export { resolveDshRunner, runHeadless } from './runner.js'
export {
  DEFAULT_WEB_PORT,
  killAllWebInstances,
  listWebInstances,
  pickFreePort,
  probeHttp,
  startWebInstance,
  stopWebInstance,
  stopWebInstanceByPid,
} from './web.js'
export * from './lab.js'
