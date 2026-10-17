/**
 * 清除 `%TEMP%` 下本插件测试遗留的临时目录。
 *
 * 为什么需要它：`tests/_tmp.js` 的 `afterEach`/`after`/`exit` 三层钩子能清掉
 * 绝大多数目录，但 `node --test` 的收尾阶段仍会在个别文件（coi 系列）留下
 * 少量目录——它们出现在测试钩子跑完之后。这个脚本作为最后一道保险，
 * 在 `npm test` 结束时执行。
 *
 * 只删名字形如 `<已知前缀>-<6 位随机>` 的目录，避免误伤。
 */
import { readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 本插件测试用过的全部前缀。 */
const PREFIXES = [
  'dsh-memory-', 'dsh-mem-', 'dsh-coi-', 'dsh-sync-', 'dsh-advisor-',
  'dsh-ws-coord-test-', 'dsh-session-orch-test-', 'dsh-update-test-',
  'dsh-skill', 'dsh-models-', 'dsh-notify-', 'dsh-review-', 'dsh-search-',
  'dsh-tools-', 'dsh-snapshot-', 'dsh-alias-', 'dsh-git-utf8-',
  'dsh-custom-tools-', 'dsh-library-test-', 'dsh-f6-', 'dsh-library-',
  'dsh-memory-kb-', 'dsh-mem-tool-schema-', 'dsh-tools-reset-', 'dsh-test-',
  'vault-test-', 'i18n-test-', 'canvas-test-', 'bcast-img-', 'sd-test-',
  'memscan-', 'me-skills-',
]

/** mkdtemp 追加的后缀形状：6 位 [A-Za-z0-9]。 */
const SUFFIX_RE = /^[A-Za-z0-9]{6}$/

let removed = 0
let failed = 0
try {
  for (const name of readdirSync(tmpdir())) {
    const p = PREFIXES.find((x) => name.startsWith(x))
    if (!p) continue
    const suffix = name.slice(p.length)
    // coi 系列的 mock 名字可能带额外段，统一按"前缀 + 6 位随机"或"含 6 位随机结尾"判定
    if (!SUFFIX_RE.test(suffix) && !/[A-Za-z0-9]{6}$/.test(suffix)) continue
    const full = join(tmpdir(), name)
    try {
      if (!statSync(full).isDirectory()) continue
      rmSync(full, { recursive: true, force: true })
      removed++
    } catch {
      failed++
    }
  }
} catch {
  /* tmpdir 不可读：静默放弃 */
}

if (removed > 0 || failed > 0) {
  console.log(`clean-tmp: 清理 ${removed} 个残留临时目录${failed ? `（${failed} 个被占用跳过）` : ''}`)
}
