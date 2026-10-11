/**
 * 自检：把本插件装进一个临时 profile，跑一次真实 headless 会话，
 * 确认插件能被 DSH 加载、`tmpprofile_*` 工具被注册且可被模型调用，然后清理。
 *
 * 用法：
 *   node scripts/selfcheck.mjs                # 用 $DSH_HOME 或 ~/.dsh
 *   DSH_HOME=C:/path/to/home node scripts/selfcheck.mjs
 *
 * 退出码 0 = 插件工作正常；1 = 有问题（详情打印在 stdout）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')

const lab = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'lab.js')).href)
const runner = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'runner.js')).href)

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const dsh = await runner.resolveDshRunner({})
console.log(`dsh       : ${dsh.version}（来源：${dsh.source}）`)
console.log(`bin       : ${dsh.binPath}`)
console.log(`DSH_HOME  : ${HOME}`)

const name = `selfcheck${Date.now().toString(36)}`
const cwd = mkdtempSync(join(tmpdir(), 'dsh-profile-lab-selfcheck-'))
let failed = false
try {
  const created = await lab.createTempProfile({
    name,
    template: 'headless',
    purpose: '插件自检',
    packages: [`link:${PACKAGE_ROOT.replaceAll('\\', '/')}`],
    dsh,
    home: HOME,
  })
  console.log(`create    : ok=${created.ok} bundles=${JSON.stringify(created.bundles)}`)
  if (created.install?.addedBundles?.length === 0) {
    failed = true
    console.log('  ✗ 本包没有作为 profile 层被挂上（bundles 里没有它）——检查 package.json 的 dsh.bundle.patch')
  }

  const run = await runner.runHeadless({
    dsh,
    profile: name,
    task: '请调用 tmpprofile_list 工具，然后只回复四个字：检查完毕',
    json: true,
    cwd,
    timeoutMs: 300_000,
  })
  console.log(`run       : exit=${run.exitCode} ${(run.durationMs / 1000).toFixed(1)}s session=${run.sessionId}`)
  console.log(`finalText : ${JSON.stringify(run.finalText)}`)

  const summary = run.sessionId === undefined ? undefined : lab.inspectSession({ sessionId: run.sessionId, home: HOME, sections: ['tools'] })
  const probeTools = (summary?.tools ?? []).filter((tool) => tool.name.startsWith('tmpprofile_'))
  if (probeTools.length === 0) {
    failed = true
    console.log('  ✗ 没有观察到 tmpprofile_* 工具被调用；stderr 尾部：')
    console.log(run.stderr.split('\n').slice(-15).map((line) => `    ${line}`).join('\n'))
  } else {
    console.log(`  ✓ 工具已注册且可被模型调用：${probeTools.map((tool) => `${tool.name}×${tool.calls}`).join(', ')}`)
  }
} catch (error) {
  failed = true
  console.log(`异常：${String(error?.message ?? error)}`)
} finally {
  const cleaned = await lab.cleanTempProfiles({ names: [name], confirm: true, sessions: true, home: HOME })
  rmSync(cwd, { recursive: true, force: true })
  console.log(`clean     : removed=${JSON.stringify(cleaned.removed)} residue=${JSON.stringify(cleaned.residue)}`)
  if (cleaned.residue.length > 0) failed = true
}
console.log(failed ? '\n结果：✗ 自检未通过' : '\n结果：✓ 自检通过')
process.exit(failed ? 1 : 0)
