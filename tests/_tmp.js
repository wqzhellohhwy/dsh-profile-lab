/**
 * 测试临时目录统一管理。
 *
 * 背景：各测试文件原用 `mkdtempSync(join(tmpdir(), 'xxx-'))` 建目录、靠零散的
 * `rmSync` 手动删。一旦断言失败提前抛出或漏写，目录永久残留在 `%TEMP%`。
 * 累积数千个顶层条目后拖慢 Windows 登录（winlogon 通知订户 Profiles 超时 100+ 秒）。
 *
 * 用法：
 *   import { tmproot } from './_tmp.js'
 *   const dir = tmproot('dsh-memory-test-')
 *
 * 清理三层保障（异步测试友好）：
 *   1. `afterEach` —— 每个测试结束删；删前让出事件循环，等异步写盘（store flush
 *      定时器、fs/promises 队列）落定后再删，避免"删完又被写回来"
 *   2. `after`     —— 本文件全部测试结束再删一遍
 *   3. `process.on('exit')` —— 进程退出前同步兜底
 *
 * 另有「启动清扫」：回收上次运行遗留的孤儿目录（只删足够旧的，
 * 避免误删同一轮 `node --test` 并行执行的其他测试文件在用目录）。
 */
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

/** 本测试文件登记的临时目录（按创建顺序）。 */
const roots = []

/** 兜底前缀。 */
const PREFIX_DEFAULT = 'dsh-test-'

/** 孤儿判定阈值：早于该时长的目录视为上次运行遗留（毫秒）。 */
const ORPHAN_MIN_AGE_MS = 10 * 60 * 1000

/** 删除前等待异步写盘落定的时长（毫秒）。 */
const FLUSH_GRACE_MS = 30

/** 启动清扫识别的前缀（本测试套件用过的全部前缀）。 */
const SWEEP_PREFIXES = [
  'dsh-', 'dsh-test-', 'dsh-memory-', 'dsh-mem-', 'dsh-coi-', 'dsh-sync-',
  'dsh-advisor-', 'dsh-ws-coord-test-', 'dsh-session-orch-test-',
  'dsh-update-test-', 'dsh-skill', 'dsh-models-', 'dsh-notify-', 'dsh-review-',
  'dsh-search-', 'dsh-tools-', 'dsh-snapshot-', 'dsh-alias-', 'dsh-git-utf8-',
  'dsh-custom-tools-', 'dsh-library-test-', 'dsh-f6-', 'dsh-lab-',
  'vault-test-', 'i18n-test-', 'canvas-test-', 'bcast-img-', 'sd-test-',
  'memscan-', 'me-skills-',
]

/**
 * 启动清扫：删除 `%TEMP%` 下**上次运行**遗留的孤儿目录。
 * 只处理本套件前缀，且只删足够旧的（避免误删并行测试在用目录）。
 */
function sweepOrphans() {
  const cutoff = Date.now() - ORPHAN_MIN_AGE_MS
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!SWEEP_PREFIXES.some((p) => name.startsWith(p))) continue
      const full = join(tmpdir(), name)
      try {
        if (statSync(full).mtimeMs >= cutoff) continue
        rmSync(full, { recursive: true, force: true })
      } catch {
        /* 被占用/权限不足：留给下次清扫 */
      }
    }
  } catch {
    /* tmpdir 不可读：放弃清扫 */
  }
}

/** 同步删除登记表中的全部目录（用于 exit 钩子）。 */
function drainSync() {
  while (roots.length) {
    const dir = roots.pop()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 尽力而为：失败不得影响测试结果 */
    }
  }
}

/**
 * 异步删除登记表中的全部目录。
 * 先让出事件循环，等异步写盘任务的 microtask/宏任务队列清空，再删；
 * 删完复查一次，若目录又被写回来则重删（最多 3 轮）。
 */
async function drainAsync() {
  if (roots.length === 0) return
  await sleep(FLUSH_GRACE_MS)
  for (let round = 0; round < 3; round++) {
    const pending = roots.splice(0, roots.length)
    let recreated = false
    for (const dir of pending) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 忽略：下面复查 */
      }
      try {
        statSync(dir)
        recreated = true
        roots.push(dir)
      } catch {
        /* 已删除 */
      }
    }
    if (!recreated) return
    await sleep(FLUSH_GRACE_MS)
  }
}

sweepOrphans()

afterEach(async () => { await drainAsync() })
after(async () => { await drainAsync() })
process.on('exit', () => { drainSync() })

/**
 * 创建临时目录并登记，测试结束自动删除。
 * @param {string} [prefix] 目录名前缀，省略用 `dsh-test-`。
 * @returns {string} 新建目录的绝对路径。
 */
export function tmproot(prefix = PREFIX_DEFAULT) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

/** 立即删除一个已登记的目录（提前释放，避免长测试堆积）。 */
export function tmpremove(dir) {
  const i = roots.indexOf(dir)
  if (i >= 0) roots.splice(i, 1)
  rmSync(dir, { recursive: true, force: true })
}
