/**
 * dsh-profile-lab —— 面向模型的工具定义。
 *
 * 九个工具把「隔离测插件改动 / 会话测试 / 渲染端验证」固化成有护栏的动作：
 *
 *   tmpprofile_create     建（模板建 或 从现有 profile 克隆）＋按需装包
 *   tmpprofile_install    往已登记的临时 profile 里追加/移除包
 *   tmpprofile_run        跑一次 headless 探针会话（同步、带超时）
 *   tmpprofile_web_start  起一个**驻留 web 实例**（验 HTTP 面 / 渲染端）
 *   tmpprofile_web_probe  对驻留实例发一次 HTTP 探针
 *   tmpprofile_web_stop   停掉驻留实例（按 pid 收，跨插件重载也能收）
 *   tmpprofile_session    读会话并给结构化摘要（多帧 zstd 逐帧解码）
 *   tmpprofile_list       列出「本插件管的」与「未登记的」profile
 *   tmpprofile_clean      清理（默认 dry-run，必须 confirm；会先停实例）
 *
 * 设计取向：写操作默认保守（clean 要 confirm、create 拒绝覆盖未登记目录），
 * 返回值一律带上足够定位问题的信息（目录、bundles、会话 id、stderr 尾部）。
 *
 * @module dsh-profile-lab/tools
 */

import { findSessionDir, resolveHome, SHIPPED_TEMPLATE_NAMES } from './guards.js'
import { DEFAULT_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS, latestSessionIn, runDshOnce, runHeadless } from './runner.js'
import {
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_WEB_PORT,
  isWebRunning,
  listWebInstances,
  probeHttp,
  startWebInstance,
  stopWebInstance,
  stopWebInstanceByPid,
} from './web.js'
import {
  cleanTempProfiles,
  clearWebInstance,
  createTempProfile,
  fingerprintProfiles,
  inspectSession,
  installIntoProfile,
  listProfiles,
  loadManifest,
  readProfileMeta,
  recordSession,
  recordWebInstance,
} from './lab.js'

/** 纯文本渲染（JSON 便于模型继续加工）。 */
const renderJson = (value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }]

/**
 * 把返回值转成 **lossless JSON**。
 *
 * DSH 会校验工具返回值：只要值里出现 `undefined`（哪怕只是某个可选字段），
 * 就会以 `tool "x" returned invalid output: value is not lossless JSON` 整条拒绝——
 * 模型看到的是报错而不是结果。所以这里统一把 `undefined` 丢掉、非有限数转 `null`。
 * @param {unknown} value 任意值。
 * @returns {unknown} 可安全穿越工具返回通道的值。
 */
export function jsonSafe(value) {
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item))
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString()
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === 'function') continue
      out[key] = jsonSafe(item)
    }
    return out
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (value === undefined) return null
  return value
}

/** 统一输出 schema：宽松对象，保证 ok/message 始终存在。 */
const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean' },
      message: { type: 'string' },
    },
    required: ['ok', 'message'],
  },
  render: (_args, value) => renderJson(value),
}

/** `tmpprofile_create` 的 profile 名字段。 */
const NAME_PARAM = {
  type: 'string',
  description: '临时 profile 名：2–40 字符，小写字母数字开头，只含 a-z0-9._-；不能是 desktop/backup/web/headless/dsh-tui/rescue/reserve 等正式名。',
}

/** 默认运行 cwd（决定 headless 会话落在哪个 sessions 子目录下）。 */
function defaultRunCwd() {
  return process.env.DSH_LAB_CWD ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\Documents` : undefined)
}

/**
 * 构造全部工具。
 * @param {object} deps 依赖。
 * @param {() => Promise<object>} deps.getRunner 懒解析 dsh 运行器。
 * @param {() => string} deps.getHome 取当前 DSH home。
 * @param {(entry: object) => void} [deps.log] 追加审计日志。
 * @param {{disabled?: string[]}} [deps.toolConfig] 工具开关。
 * @returns {object[]} 工具定义数组。
 */
export function buildTools(deps) {
  const { getRunner, getHome } = deps
  const disabled = new Set(deps.toolConfig?.disabled ?? [])
  const tools = []

  tools.push({
    name: 'tmpprofile_create',
    description: [
      '建一个【隔离的临时 profile】用来测插件改动或跑探针会话，避免直接改主力 profile 把本体改坏。',
      '两种来源：① `template` 从 DSH 内置模板初始化（headless/web/acp/sdk/sdk-minimal，默认 headless）；',
      '② `clone` 从现有 profile 克隆（复制 package.json / cordis.patch.yml，并把 node_modules 逐项链接复用——',
      '新 profile 有自己的 node_modules 目录，之后装包不会污染源 profile）。',
      '可选 `packages` 在建好后立刻安装（`link:C:/path/to/plugin` 或 npm 包名）。',
      '建出来的 profile 会登记在 $DSH_HOME/profile-lab.json 里，只有登记过的才能被本插件清理。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        name: NAME_PARAM,
        template: { type: 'string', enum: SHIPPED_TEMPLATE_NAMES, description: '内置模板名（默认 headless，适合一次性任务与探针会话）。' },
        clone: { type: 'string', description: '从哪个现有 profile 克隆（给了它就忽略 template）；例如 desktop / backup。' },
        packages: { type: 'array', items: { type: 'string' }, description: '建好立刻安装的包（pnpm 规格，支持 link:<本地目录>）。' },
        purpose: { type: 'string', description: '一句话用途，写进清单便于日后辨认。' },
        overwrite: { type: 'boolean', description: '默认 false；true 时只允许覆盖本插件登记过的同名 profile（旧的挪到 $DSH_HOME/profile-lab-trash）。' },
      },
      required: ['name'],
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const dsh = await getRunner()
        const home = getHome()
        const result = await createTempProfile({
          name: args.name,
          template: args.template,
          clone: args.clone,
          packages: args.packages,
          purpose: args.purpose,
          overwrite: args.overwrite,
          dsh,
          home,
        })
        deps.log?.({ action: 'tool:create', name: args.name })
        return {
          ok: true,
          message: `临时 profile ${result.name} 已就绪（${result.clonedFrom ? `克隆自 ${result.clonedFrom}` : `模板 ${result.template}`}）${result.withJunction ? `，node_modules 链接 ${result.linkedPackages} 项` : ''}。`,
          ...result,
          dshVersion: dsh.version,
        }
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
    },
  })

  tools.push({
    name: 'tmpprofile_install',
    description: '往一个【已登记的临时 profile】里追加安装（或移除）插件包：`packages` 用 pnpm 规格（`link:<本地目录>` / 包名@版本）。带 dsh.bundle 的包会被 dsh 自动挂进 bundles，返回值给出前后差异。移除时传 `remove: ["包名"]`。',
    parameters: {
      type: 'object',
      properties: {
        name: NAME_PARAM,
        packages: { type: 'array', items: { type: 'string' }, description: '要安装的包（pnpm 规格）。' },
        remove: { type: 'array', items: { type: 'string' }, description: '要移除的包名。' },
        timeoutMs: { type: 'integer', description: '安装超时（默认 300000ms）。' },
      },
      required: ['name'],
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const dsh = await getRunner()
        const home = getHome()
        const results = []
        if (Array.isArray(args.packages) && args.packages.length > 0) {
          results.push(await installIntoProfile({ name: args.name, packages: args.packages, dsh, home, timeoutMs: args.timeoutMs }))
        }
        if (Array.isArray(args.remove) && args.remove.length > 0) {
          const manifest = loadManifest(home)
          if (manifest.profiles[args.name] === undefined) throw new Error(`profile ${JSON.stringify(args.name)} 不在清单里`)
          const run = await runDshOnce(dsh, ['plugin', '--profile', args.name, 'remove', ...args.remove], {
            home,
            cwd: getHome(),
            timeoutMs: args.timeoutMs ?? 300_000,
          })
          results.push({ ok: run.ok, exitCode: run.exitCode, removed: args.remove, stdoutTail: run.stdout.trim().slice(-800), stderrTail: run.stderr.trim().slice(-800) })
        }
        if (results.length === 0) return { ok: false, message: '要么给 packages，要么给 remove' }
        const meta = readProfileMeta(args.name, home)
        return {
          ok: results.every((item) => item.ok),
          message: `已更新 ${args.name}：bundles=${(meta?.bundles ?? []).join(', ') || '(空)'}`,
          results,
          bundles: meta?.bundles ?? [],
          dependencies: meta?.dependencies ?? {},
        }
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
    },
  })

  tools.push({
    name: 'tmpprofile_run',
    description: [
      '在临时 profile 里跑一次 headless 探针会话（同步等待、带超时），把结果连同会话 id 一起返回，',
      '用来验证「插件在真实装配下能不能加载 / 报不报错 / 工具面对不对」。',
      '同一 profile 不允许并发；同一会话多轮对照传 `sessionId`（KV 缓存之类实验要用）。',
      '额外环境变量用 `env` 传（探针插件常用它做开关）。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        name: NAME_PARAM,
        task: { type: 'string', description: '任务文本。探针用极短任务即可（例如「只回复两个字：OK」）。' },
        sessionId: { type: 'string', description: '复用已有会话（`--session-id`），做多轮对照。' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: '额外环境变量（传给子进程）。' },
        timeoutMs: { type: 'integer', description: `超时毫秒（默认 ${DEFAULT_RUN_TIMEOUT_MS}，上限 ${MAX_RUN_TIMEOUT_MS}）。` },
        json: { type: 'boolean', description: '默认 true：解析 headless 的 NDJSON 事件流并给结构化摘要。' },
        cwd: { type: 'string', description: '子进程工作目录（决定会话落在哪个 sessions 子目录），默认用户 Documents。' },
      },
      required: ['name', 'task'],
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const dsh = await getRunner()
        const home = getHome()
        const manifest = loadManifest(home)
        if (manifest.profiles[args.name] === undefined) {
          return { ok: false, message: `profile ${JSON.stringify(args.name)} 不在本插件清单里，拒绝运行（请先用 tmpprofile_create 建）` }
        }
        const cwd = args.cwd ?? defaultRunCwd()
        const run = await runHeadless({
          dsh,
          profile: args.name,
          task: args.task,
          sessionId: args.sessionId,
          // DSH_HOME 必须显式跟本插件认定的 home 一致：插件的 home 可能来自 config，
          // 不一定等于宿主进程的 $DSH_HOME。漏了它，子进程会把会话写进另一个 home。
          env: { DSH_HOME: home, ...(args.env ?? {}) },
          timeoutMs: args.timeoutMs,
          json: args.json ?? true,
          cwd,
        })
        // 回捞 sessionId（无 --json 时事件流里没有）
        let sessionId = run.sessionId
        const sessionDir = cwd === undefined ? undefined : findSessionDir(cwd, home)
        if (sessionId === undefined && sessionDir !== undefined) sessionId = latestSessionIn(sessionDir)?.sessionId
        if (sessionId !== undefined && cwd !== undefined) recordSession(args.name, { id: sessionId, cwd, at: new Date().toISOString() }, home)

        // `--json` 是**投影**（不含 tool/call 之类的日志事件），所以工具面必须从磁盘上的
        // 完整会话日志里读——否则这里会永远报"没调用任何工具"，误导排查。
        let session
        if (sessionId !== undefined) {
          try {
            const summary = inspectSession({ sessionId, sections: ['preset', 'tools', 'tokens'], home })
            session = {
              agentPreset: summary.agentPreset,
              eventCount: summary.eventCount,
              frames: summary.frames,
              toolCount: summary.toolCount,
              tools: summary.tools,
              tokens: summary.tokens,
            }
          } catch (error) {
            session = { error: String(error?.message ?? error) }
          }
        }

        const jsonEventTypes = {}
        for (const event of run.events) {
          const type = typeof event?.type === 'string' ? event.type : '(none)'
          jsonEventTypes[type] = (jsonEventTypes[type] ?? 0) + 1
        }
        return {
          ok: run.ok,
          message: run.ok
            ? `headless 运行完成（${(run.durationMs / 1000).toFixed(1)}s）${sessionId ? `，会话 ${sessionId}` : ''}${session?.toolCount ? `，调用工具 ${session.toolCount} 种` : ''}。`
            : `headless 运行失败：exit=${run.exitCode}${run.timedOut ? '（超时，已杀进程树）' : ''}`,
          profile: args.name,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          durationMs: run.durationMs,
          sessionId,
          finalText: run.finalText,
          session,
          jsonEventTypes,
          malformedEvents: run.malformedEvents,
          stderrTail: run.stderr.trim().slice(-1500),
          dshVersion: dsh.version,
        }
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
    },
  })

  tools.push({
    name: 'tmpprofile_web_start',
    description: [
      '在一个【已登记的临时 profile】上起一个**驻留 web 实例**（真实 HTTP 服务），用来验证 headless 验不了的那一面：',
      '插件的 host 路由是否注册、页面能不能真的加载起来（渲染端）。',
      '⚠️ 目标 profile 的 bundles 里必须有 `@deepseek-ai/dsh-web-app`（用 `template: "web"` 建的，或从带 web-app 的 profile 克隆）；',
      'headless 模板上没有 HTTP 服务，起不来。',
      '实例**驻留**在后台（与 headless 探针的"同步跑完就退"不同），所以用完必须 `tmpprofile_web_stop`；',
      '进程留在宿主 Job Object 内（宿主退出会连带杀掉），插件卸载时也会主动清一遍。',
      '端口缺省从 19399 起自动挑空闲的；`probePath` 可在就绪后顺带探一次（例如插件的自检路由）。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        name: NAME_PARAM,
        port: { type: 'integer', description: `指定端口（缺省从 ${DEFAULT_WEB_PORT} 起自动挑空闲的）。` },
        probePath: { type: 'string', description: '就绪后顺带探一次该路径，例如 /api/your-plugin/status。' },
        waitMs: { type: 'integer', description: `等端口就绪的上限毫秒（默认 ${DEFAULT_READY_TIMEOUT_MS}）。` },
        cwd: { type: 'string', description: '子进程工作目录（缺省 DSH home）。' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: '额外环境变量（传给子进程）。' },
      },
      required: ['name'],
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const dsh = await getRunner()
        const home = getHome()
        const manifest = loadManifest(home)
        if (manifest.profiles[args.name] === undefined) {
          return { ok: false, message: `profile ${JSON.stringify(args.name)} 不在本插件清单里，拒绝启动（请先用 tmpprofile_create 建）` }
        }
        const result = await startWebInstance({
          dsh,
          profile: args.name,
          home,
          port: args.port,
          waitMs: args.waitMs,
          probePath: args.probePath,
          cwd: args.cwd,
          env: args.env,
        })
        if (result.ok !== true) {
          return { ok: false, message: result.message ?? `启动失败（${result.reason}）`, ...result }
        }
        recordWebInstance(args.name, { pid: result.pid, port: result.port, url: result.url }, home)
        deps.log?.({ action: 'tool:web-start', name: args.name, pid: result.pid, port: result.port })
        return {
          ok: true,
          message: `web 实例已就绪：${result.url}（pid ${result.pid}，profile ${args.name}）`
            + (result.probe === undefined ? '' : `；探针 ${result.probe.ok ? `HTTP ${result.probe.status}` : `失败（${result.probe.error}）`}`),
          ...result,
          dshVersion: dsh.version,
        }
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
    },
  })

  tools.push({
    name: 'tmpprofile_web_probe',
    description: [
      '对某个 profile 的驻留 web 实例发一次 HTTP 探针（只打 127.0.0.1，不跟随重定向），',
      '返回状态码与 body 预览。用来确认「插件的 host 路由真的注册了」——',
      '例如 client 插件常见的自检路由 `/api/<plugin>/status`。',
      '注意：页面侧（渲染端）的执行只有真页面才会发生，这里拿到的是服务端应答。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        name: NAME_PARAM,
        path: { type: 'string', description: '要探的路径，默认 /。' },
        method: { type: 'string', description: 'HTTP 方法，默认 GET。' },
        timeoutMs: { type: 'integer', description: '超时毫秒（默认 15000）。' },
      },
      required: ['name'],
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const home = getHome()
        const manifest = loadManifest(home)
        const entry = manifest.profiles[args.name]
        if (entry === undefined) return { ok: false, message: `profile ${JSON.stringify(args.name)} 不在本插件清单里` }
        const live = listWebInstances().find((item) => item.profile === args.name && item.exited !== true)
        const port = live?.port ?? entry.web?.port
        if (typeof port !== 'number') {
          return { ok: false, message: `profile ${args.name} 没有在跑的 web 实例（先 tmpprofile_web_start）` }
        }
        const probe = await probeHttp({ port, path: args.path, method: args.method, timeoutMs: args.timeoutMs })
        return {
          ok: probe.ok === true,
          message: probe.ok === true ? `HTTP ${probe.status}（${probe.bytes} 字节）` : `探针失败：${probe.error}`,
          profile: args.name,
          port,
          ...probe,
        }
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
    },
  })

  tools.push({
    name: 'tmpprofile_web_stop',
    description: [
      '停掉某个 profile 的驻留 web 实例（`taskkill /T /F` 杀整棵进程树）并确认端口释放。',
      '优先收进程内的实例；插件被重载过、进程内表已空时，改用清单里登记的 pid 收（`recovered: true` 就是这种情况）。',
      '再 `tmpprofile_list` 看该 profile 的 webInstance 应变成 null。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        name: NAME_PARAM,
        waitMs: { type: 'integer', description: '等端口释放的上限毫秒（默认 8000）。' },
      },
      required: ['name'],
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const home = getHome()
        const manifest = loadManifest(home)
        const entry = manifest.profiles[args.name]
        if (entry === undefined) return { ok: false, message: `profile ${JSON.stringify(args.name)} 不在本插件清单里` }
        let result
        if (isWebRunning(args.name)) {
          result = await stopWebInstance(args.name, { waitMs: args.waitMs })
        } else if (entry.web !== undefined && typeof entry.web.pid === 'number') {
          result = await stopWebInstanceByPid({ pid: entry.web.pid, port: entry.web.port }, { waitMs: args.waitMs, profile: args.name })
        } else {
          return { ok: false, message: `profile ${args.name} 没有在跑的 web 实例（清单里也没有登记）` }
        }
        clearWebInstance(args.name, home)
        deps.log?.({ action: 'tool:web-stop', name: args.name, pid: result.pid, recovered: result.recovered === true })
        return {
          ok: result.ok === true,
          message: result.ok === true
            ? `已停 web 实例（pid ${result.pid}，端口 ${result.port}${result.portFreed === false ? ' ⚠ 仍被占用' : ' 已释放'}）${result.recovered === true ? '；按清单 pid 回收' : ''}`
            : `停止失败：${result.message ?? result.reason}`,
          profile: args.name,
          ...result,
        }
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
    },
  })

  tools.push({
    name: 'tmpprofile_session',
    description: [
      '读一个探针会话的完整日志并给结构化摘要：agentPreset、工具面（每次工具调用与错误）、',
      '上下文注入（system/developer 消息、runtime-context）、token 用量（未命中/缓存读/输出）。',
      '`session.v4.jsonl.zstd` 是多帧 zstd，本工具内部逐帧解码，不需要你再写脚本。',
      '不传 sessionId 时用该 profile 最近登记的一次会话。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id（session-<uuid>）。' },
        name: { type: 'string', description: '临时 profile 名（不传 sessionId 时，取它最近一次运行的会话）。' },
        sections: {
          type: 'array',
          items: { type: 'string', enum: ['preset', 'tools', 'contexts', 'tokens', 'errors', 'raw'] },
          description: '需要哪些分区（默认 preset/tools/contexts/tokens）。',
        },
        limit: { type: 'integer', description: 'raw 分区返回多少条事件（默认 200）。' },
      },
      required: [],
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const home = getHome()
        let sessionId = args.sessionId
        if (sessionId === undefined) {
          if (typeof args.name !== 'string') return { ok: false, message: '要么给 sessionId，要么给 name' }
          const manifest = loadManifest(home)
          const sessions = manifest.profiles[args.name]?.sessions ?? []
          sessionId = sessions[sessions.length - 1]?.id
          if (sessionId === undefined) return { ok: false, message: `profile ${args.name} 还没有登记过会话；先用 tmpprofile_run 跑一次` }
        }
        const summary = inspectSession({ sessionId, sections: args.sections, limit: args.limit, home })
        return { ok: true, message: `会话 ${sessionId}：${summary.eventCount} 个事件，${summary.frames} 帧，preset=${summary.agentPreset ?? '(未记录)'}`, ...summary }
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
    },
  })

  tools.push({
    name: 'tmpprofile_list',
    description: '列出 profile 现状：`managed` 是本插件登记的临时 profile（带用途/来源/关联会话数），`unmanaged` 是目录里其他 profile（正式实例或历史残留，本插件不碰，需要人工判断）。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: OUTPUT,
    async execute() {
      try {
        const home = getHome()
        const { managed, unmanaged } = listProfiles(home)
        return {
          ok: true,
          message: `本插件管辖 ${managed.length} 个临时 profile；另有 ${unmanaged.length} 个未登记目录（不归本插件管）。`,
          home,
          managed,
          unmanaged,
        }
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
    },
  })

  tools.push({
    name: 'tmpprofile_clean',
    description: [
      '清理临时 profile：解掉 node_modules 里的链接（绝不跟随链接递归删，避免删进源仓库）→ 删目录 → ',
      '回收登记过的探针会话目录 → 自检残留。默认**只演练**（dry-run），必须传 `confirm: true` 才真删。',
      '只能清本插件登记过的 profile；正式 profile 一律拒绝。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: '要清理的临时 profile 名。' },
        confirm: { type: 'boolean', description: 'true 才真删；缺省只返回将要删除什么。' },
        sessions: { type: 'boolean', description: '是否连同登记的探针会话一起删（默认 true）。' },
        archiveTo: { type: 'string', description: '删除前把 profile 配置文件归档到该目录（不含 node_modules）。' },
      },
      required: ['names'],
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const home = getHome()
        const result = await cleanTempProfiles({
          names: args.names,
          confirm: args.confirm === true,
          sessions: args.sessions,
          archiveTo: args.archiveTo,
          home,
        })
        deps.log?.({ action: 'tool:clean', names: args.names, confirm: args.confirm === true })
        return {
          ok: result.ok,
          message: result.dryRun
            ? `演练：将删除 ${result.plan.length} 个临时 profile（未执行；确认后传 confirm: true）。`
            : `已删除 ${result.removed.length} 个临时 profile${result.sessionsRemoved.length > 0 ? `，回收 ${result.sessionsRemoved.length} 个探针会话` : ''}${result.residue.length > 0 ? `；⚠ 残留 ${result.residue.length} 项` : '；无残留'}`,
          ...result,
        }
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
    },
  })

  tools.push({
    name: 'tmpprofile_fingerprint',
    description: '采集 profiles/ 的指纹（顶层文件 hash + 目录 mtime），用于自查「刚才那次临时 profile 操作有没有碰到别的 profile」。配合 tmpprofile_list 使用；数值相同即未被触碰。',
    parameters: {
      type: 'object',
      properties: {
        exclude: { type: 'array', items: { type: 'string' }, description: '要排除的 profile 名（例如刚建的那个）。' },
      },
      required: [],
    },
    output: OUTPUT,
    async execute(args) {
      try {
        const home = getHome()
        const table = fingerprintProfiles(home)
        const excluded = new Set(args.exclude ?? [])
        const filtered = {}
        for (const [path, value] of Object.entries(table)) {
          const top = path.split(/[\\/]/)[0]
          if (excluded.has(top)) continue
          filtered[path] = value
        }
        return {
          ok: true,
          message: `采集了 ${Object.keys(filtered).length} 条指纹（已排除 ${excluded.size} 个 profile）。`,
          home,
          fingerprints: filtered,
        }
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
    },
  })

  // 出口统一净化：DSH 拒绝含 undefined 的工具返回值（lossless JSON 校验），
  // 在这里兜一次，避免每个工具各自漏掉可选字段。
  return tools
    .filter((tool) => !disabled.has(tool.name))
    .map((tool) => ({ ...tool, execute: async (args) => jsonSafe(await tool.execute(args)) }))
}

export { resolveHome }
