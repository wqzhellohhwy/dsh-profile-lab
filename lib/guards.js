/**
 * dsh-profile-lab —— 守卫层：名称校验、保留名单、路径推导、并发锁。
 *
 * 设计取向（对齐 dsh-asar-patcher 的「默认保守」哲学）：
 *   - **只有本插件在清单里登记过的 profile 才可被写/删**；
 *   - 正式 profile（含内置模板名）一律硬拒；
 *   - 会话目录名不靠猜：先按 DSH 的编码规则推，推不到就全目录扫 header 比对 cwd。
 *
 * @module dsh-profile-lab/guards
 */

import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** DSH 内置 profile 模板名（`PROFILE_TEMPLATES` 的键）——不能作为自定义 profile 的目标名。 */
export const SHIPPED_TEMPLATE_NAMES = ['acp', 'web', 'headless', 'sdk', 'sdk-minimal']

/** 正式 profile：本插件永不创建、永不写入、永不删除。 */
export const RESERVED_PROFILE_NAMES = [
  'desktop', // Electron 独占
  'backup', // 灾备实例
  'rescue', // 灾难恢复
  'reserve', // 独立运行时副本
  'dsh-tui', // TUI 实例
  ...SHIPPED_TEMPLATE_NAMES,
]

const RESERVED = new Set(RESERVED_PROFILE_NAMES)

/** 允许的临时 profile 名：小写字母数字开头，2–40 字符，只含 `a-z0-9._-`。 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,39}$/

/** 清单文件名（放在 $DSH_HOME 下，便于人工审阅）。 */
export const MANIFEST_FILENAME = 'profile-lab.json'
/** 审计日志文件名。 */
export const LOG_FILENAME = 'profile-lab-log.jsonl'
/** 跨进程锁文件名。 */
export const LOCK_FILENAME = 'profile-lab.lock'

/** 会话日志候选文件名（新格式压缩、旧格式明文）。 */
const SESSION_FILE_NAMES = ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl']

/**
 * 解析 DSH home。
 * @param {string} [home] 显式覆盖（测试用）。
 * @returns {string} 绝对路径。
 */
export function resolveHome(home) {
  return home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * 校验并规范化一个临时 profile 名。
 * @param {unknown} name 候选名。
 * @returns {string} 规范化后的名字。
 * @throws {Error} 名字非法或命中保留名单。
 */
export function assertProfileName(name) {
  if (typeof name !== 'string' || name.length === 0) throw new Error('profile 名必须是字符串')
  const value = name.trim()
  if (value !== name) throw new Error(`profile 名不能有首尾空白：${JSON.stringify(name)}`)
  if (!NAME_PATTERN.test(value)) {
    throw new Error(`profile 名非法：${JSON.stringify(name)}；要求 2–40 字符、小写字母数字开头、只含 a-z0-9._-`)
  }
  if (value === '.' || value === '..' || value === 'node_modules') {
    throw new Error(`profile 名非法：${JSON.stringify(name)}`)
  }
  if (RESERVED.has(value)) {
    throw new Error(`profile ${JSON.stringify(value)} 是正式 profile（或内置模板名），本插件不接管；请换一个名字`)
  }
  return value
}

/**
 * 断言一个 profile 可以被本插件写入/删除（必须登记在清单里、且不在保留名单）。
 * @param {string} name profile 名。
 * @param {{profiles?: Record<string, unknown>}} manifest 清单。
 * @returns {string} 规范化后的名字。
 * @throws {Error} 未登记或命中保留名单。
 */
export function assertManageable(name, manifest) {
  const value = assertProfileName(name)
  if (manifest?.profiles?.[value] === undefined) {
    throw new Error(
      `profile ${JSON.stringify(value)} 不在本插件清单里，拒绝操作（只允许动 tmpprofile_create 建出来的临时 profile）`,
    )
  }
  return value
}

/**
 * 不跟随链接地判断路径是否为符号链接/交接点。
 * @param {string} target 路径。
 * @returns {boolean} 是链接返回 true。
 */
export function isLink(target) {
  try {
    return lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

/** `$DSH_HOME/profiles`。 */
export function profilesDir(home) {
  return join(resolveHome(home), 'profiles')
}

/** `$DSH_HOME/profiles/<name>`。 */
export function profileDir(name, home) {
  return join(profilesDir(home), name)
}

/** `$DSH_HOME/profiles/<name>/package.json`。 */
export function profileManifestPath(name, home) {
  return join(profileDir(name, home), 'package.json')
}

/** `$DSH_HOME/sessions`。 */
export function sessionsRoot(home) {
  return join(resolveHome(home), 'sessions')
}

/**
 * 把一个 cwd 编码成 DSH 的会话目录名。
 *
 * 实测规则（样本见单元测试）：
 *   - `[A-Za-z0-9._-]` 原样保留；
 *   - 其余 ASCII 字符（路径分隔符、冒号、空格等）先转成 `-`，并且**连续的一段合并成一个 `-`**
 *     （所以 `C:\Users` → `C-Users`，而不是 `C--Users`）；
 *   - 每个非 ASCII UTF-16 code unit → `~` + 4 位大写十六进制（`未分组` → `~672A~5206~7EC4`）；
 *   - 整体用 `--` 包住。
 *
 * 推不出来时由 {@link findSessionDir} 兜底全扫并比对 header 里的 cwd，所以这里只求「常见情况正确」。
 * @param {string} cwd 工作目录绝对路径。
 * @returns {string} 会话目录名。
 */
export function cwdToSessionDirName(cwd) {
  let out = ''
  let pendingSeparator = false
  for (let i = 0; i < cwd.length; i += 1) {
    const ch = cwd[i]
    const code = cwd.charCodeAt(i)
    if (code < 128 && /[A-Za-z0-9._-]/.test(ch)) {
      if (pendingSeparator) {
        out += '-'
        pendingSeparator = false
      }
      out += ch
    } else if (code < 128) {
      pendingSeparator = true // 折叠连续的非安全字符
    } else {
      if (pendingSeparator) {
        out += '-'
        pendingSeparator = false
      }
      out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  return `--${out}--`
}

/**
 * 列出目录下的条目名（目录不存在或不可读时返回空数组）。
 * @param {string} dir 目录。
 * @returns {string[]} 条目名。
 */
export function listDirNames(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * 读一个会话日志文件的第一帧（header）里的 cwd。只解第一帧，代价极低。
 * @param {string} file 会话日志文件路径。
 * @returns {string|undefined} header 里的 cwd。
 */
export function readHeaderCwd(file) {
  try {
    const buf = readFileSync(file)
    const text = file.endsWith('.zstd') ? zstdDecompressSync(buf).toString('utf8') : buf.toString('utf8')
    const first = text.split('\n').find((line) => line.trim() !== '')
    const event = JSON.parse(first)
    return typeof event?.cwd === 'string' ? event.cwd : undefined
  } catch {
    return undefined
  }
}

/** 在会话目录里找会话日志文件。 */
export function findSessionFile(sessionDir) {
  for (const name of SESSION_FILE_NAMES) {
    const file = join(sessionDir, name)
    if (existsSync(file)) return file
  }
  return undefined
}

/**
 * 在 `$DSH_HOME/sessions` 下定位某个 cwd 对应的会话目录。
 *
 * 先按 {@link cwdToSessionDirName} 直接命中；未命中则扫描全部 `--*--` 目录，
 * 用每个会话文件 header 里的 cwd 做精确比对（不猜、不误配）。
 * @param {string} cwd 工作目录。
 * @param {string} [home] DSH home。
 * @returns {string|undefined} 会话目录绝对路径。
 */
export function findSessionDir(cwd, home) {
  const root = sessionsRoot(home)
  if (!existsSync(root)) return undefined
  const guess = join(root, cwdToSessionDirName(cwd))
  if (existsSync(guess)) return guess
  for (const dir of listDirNames(root)) {
    if (!dir.startsWith('--')) continue
    const candidate = join(root, dir)
    for (const sessionId of listDirNames(candidate)) {
      const sessionDir = join(candidate, sessionId)
      const file = findSessionFile(sessionDir)
      if (file !== undefined && readHeaderCwd(file) === cwd) return candidate
    }
  }
  return undefined
}

/**
 * 跨进程互斥：用 `$DSH_HOME/profile-lab.lock` 做独占创建。
 *
 * - 持锁期间写入 `{pid, at}`，便于人工排障；
 * - 锁文件超过 `staleMs` 视为陈旧（进程被强杀），自动抢占；
 * - 超时未拿到则抛错，绝不「假装拿到了」。
 * @template T
 * @param {string} lockPath 锁文件路径。
 * @param {() => Promise<T>} fn 临界区。
 * @param {{waitMs?: number, staleMs?: number, pollMs?: number}} [options] 超时参数。
 * @returns {Promise<T>} 临界区返回值。
 */
export async function withLock(lockPath, fn, options = {}) {
  const waitMs = options.waitMs ?? 30_000
  const staleMs = options.staleMs ?? 120_000
  const pollMs = options.pollMs ?? 120
  mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + waitMs
  let fd
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let ageMs = Number.POSITIVE_INFINITY
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs
      } catch {
        continue // 锁刚好被别人释放，重试
      }
      if (ageMs > staleMs) {
        try {
          unlinkSync(lockPath)
        } catch {
          /* 别人先抢走了 */
        }
        continue
      }
      if (Date.now() > deadline) throw new Error(`等待 profile-lab 锁超时（${waitMs}ms）：${lockPath}`)
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
  try {
    return await fn()
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* 已关闭 */
    }
    try {
      unlinkSync(lockPath)
    } catch {
      /* 已被清理 */
    }
  }
}
