/**
 * 测试用假 dsh：模拟 CLI 面（-V / --from-default-profile --dump-config / plugin add|remove）。
 *
 * 目的：让 `createTempProfile` / `installIntoProfile` 能在**不启动真实 dsh、不联网**
 * 的前提下被确定性测试。行为刻意与真实 dsh 对齐：
 *   - `<name> --from-default-profile <tpl> --dump-config` → 建出最小 profile 目录（不 boot）
 *   - `plugin --profile <n> add <pkg...>` → 写进 dependencies；包名以 `dsh-` 开头则同时进 bundles
 *     （模拟官方 reconcile 对声明了 `dsh.bundle` 的包的处理）
 *   - `plugin --profile <n> remove <pkg...>` → 从 dependencies 与 bundles 移除
 *   - `-V` → 版本号
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
const profiles = join(home, 'profiles')

function writeProfile(name, bundles) {
  const dir = join(profiles, name)
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ name: `dsh-profile-${name}`, private: true, dependencies: {}, dsh: { profile: { bundles } } }, undefined, 2)}\n`,
      'utf8',
    )
  }
  for (const [file, content] of [
    ['cordis.patch.yml', '# patch layer\n[]\n'],
    ['pnpm-workspace.yaml', 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'],
    ['cordis.yml', '# root\n[]\n'],
  ]) {
    const path = join(dir, file)
    if (!existsSync(path)) writeFileSync(path, content, 'utf8')
  }
  return dir
}

function readManifest(name) {
  return JSON.parse(readFileSync(join(profiles, name, 'package.json'), 'utf8'))
}

function saveManifest(name, json) {
  writeFileSync(join(profiles, name, 'package.json'), `${JSON.stringify(json, undefined, 2)}\n`, 'utf8')
}

if (args.length === 0) {
  process.stderr.write('fake-dsh: 需要参数\n')
  process.exit(2)
}

if (args[0] === '-V' || args[0] === '--version') {
  process.stdout.write('0.2.1-alpha.1\n')
  process.exit(0)
}

if (args[0] === 'plugin') {
  let name
  const rest = []
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--profile') {
      name = args[i + 1]
      i += 1
    } else rest.push(args[i])
  }
  if (name === undefined) {
    process.stderr.write('fake-dsh: 缺 --profile\n')
    process.exit(1)
  }
  const action = rest[0]
  const packages = rest.slice(1)
  if (!existsSync(join(profiles, name, 'package.json'))) writeProfile(name, ['@deepseek-ai/dsh-base'])
  const json = readManifest(name)
  json.dependencies = json.dependencies ?? {}
  json.dsh = json.dsh ?? { profile: { bundles: [] } }
  json.dsh.profile = json.dsh.profile ?? { bundles: [] }
  const bundles = json.dsh.profile.bundles ?? []
  if (action === 'add') {
    for (const spec of packages) {
      const pkgName = spec.replace(/^link:/, '').split(/[\\/]/).pop()
      json.dependencies[pkgName] = spec
      if (pkgName.startsWith('dsh-') && !bundles.includes(pkgName)) bundles.push(pkgName)
    }
  } else if (action === 'remove') {
    for (const pkgName of packages) {
      delete json.dependencies[pkgName]
      const index = bundles.indexOf(pkgName)
      if (index >= 0) bundles.splice(index, 1)
    }
  } else {
    process.stderr.write(`fake-dsh: 不支持的 pnpm 动作 ${action}\n`)
    process.exit(1)
  }
  json.dsh.profile.bundles = bundles
  saveManifest(name, json)
  process.stdout.write(`dependencies:\n+ ${packages.join('\n+ ')}\nDone\n`)
  process.exit(0)
}

// 形如 `<name> --from-default-profile <tpl> --dump-config`
const name = args[0]
const templateIndex = args.indexOf('--from-default-profile')
const template = templateIndex >= 0 ? args[templateIndex + 1] : 'headless'
if (!existsSync(join(profiles, name, 'package.json'))) {
  writeProfile(name, ['@deepseek-ai/dsh-base', template === 'headless' ? '@deepseek-ai/dsh-headless' : '@deepseek-ai/dsh-web-app'])
}
process.stdout.write(`# fake dump-config for ${name}\n- id: fake\n  name: 'fake'\n`)
process.exit(0)
