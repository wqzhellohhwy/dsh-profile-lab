import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { isLink } from '../lib/guards.js'
import {
  cleanTempProfiles,
  cloneProfile,
  createTempProfile,
  fingerprintProfiles,
  findSessionFileById,
  inspectSession,
  installIntoProfile,
  listProfiles,
  loadManifest,
  readProfileMeta,
  recordSession,
  removeProfileTree,
} from '../lib/lab.js'
import { tmproot } from './_tmp.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_DSH = join(HERE, 'fixtures', 'fake-dsh.mjs')

/** 指向假 dsh 的运行器：execPath 用当前 node，binPath 用夹具脚本。 */
const fakeRunner = { execPath: process.execPath, asNode: false, binPath: FAKE_DSH, version: '0.2.1-alpha.1-test' }

function tempHome() {
  return tmproot("dsh-lab-")
}

/** 造一个"看起来像真 profile"的源目录（含真实 node_modules 目录与 @scope）。 */
function seedSourceProfile(home, name, { withScope = true } = {}) {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: `dsh-profile-${name}`, private: true, dependencies: { 'dsh-focus-guard': 'link:C:/plugins/dsh-focus-guard' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, undefined, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(dir, 'cordis.patch.yml'), '# patch\n- id: x\n')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  const pkgDir = join(dir, 'node_modules', 'dsh-focus-guard')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), '{"name":"dsh-focus-guard"}\n')
  if (withScope) {
    const scopeDir = join(dir, 'node_modules', '@local', 'dsh-instance-badge')
    mkdirSync(scopeDir, { recursive: true })
    writeFileSync(join(scopeDir, 'package.json'), '{"name":"@local/dsh-instance-badge"}\n')
  }
  return dir
}

test('createTempProfile：从模板建出 profile 并登记清单', async () => {
  const home = tempHome()
  try {
    const result = await createTempProfile({ name: 'probe1', template: 'headless', purpose: '单测', dsh: fakeRunner, home })
    assert.equal(result.ok, true)
    assert.equal(result.clonedFrom, undefined)
    assert.ok(existsSync(join(home, 'profiles', 'probe1', 'package.json')))
    assert.ok(result.bundles.includes('@deepseek-ai/dsh-headless'))

    const manifest = loadManifest(home)
    assert.equal(manifest.profiles.probe1.purpose, '单测')
    assert.equal(manifest.profiles.probe1.template, 'headless')
    const { managed } = listProfiles(home)
    assert.deepEqual(managed.map((item) => item.name), ['probe1'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('createTempProfile：拒绝覆盖未登记的目录', async () => {
  const home = tempHome()
  try {
    seedSourceProfile(home, 'desktop')
    await assert.rejects(
      createTempProfile({ name: 'desktop', dsh: fakeRunner, home }),
      /正式 profile/,
    )
    mkdirSync(join(home, 'profiles', 'stray'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'stray', 'package.json'), '{}\n')
    await assert.rejects(createTempProfile({ name: 'stray', dsh: fakeRunner, home }), /不在本插件清单里/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('createTempProfile：packages 参数在建好后立刻安装，并自动进 bundles', async () => {
  const home = tempHome()
  try {
    const result = await createTempProfile({
      name: 'probe2',
      template: 'headless',
      packages: ['link:C:/plugins/dsh-focus-guard'],
      dsh: fakeRunner,
      home,
    })
    assert.equal(result.install.ok, true)
    assert.deepEqual(result.install.addedBundles, ['dsh-focus-guard'])
    assert.ok(result.bundles.includes('dsh-focus-guard'))
    const meta = readProfileMeta('probe2', home)
    assert.equal(meta.dependencies['dsh-focus-guard'], 'link:C:/plugins/dsh-focus-guard')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('installIntoProfile：追加与移除都反映到 bundles', async () => {
  const home = tempHome()
  try {
    await createTempProfile({ name: 'probe3', template: 'headless', dsh: fakeRunner, home })
    const added = await installIntoProfile({ name: 'probe3', packages: ['link:C:/plugins/dsh-focus-guard'], dsh: fakeRunner, home })
    assert.equal(added.ok, true)
    assert.deepEqual(added.addedBundles, ['dsh-focus-guard'])
    const { runDshOnce } = await import('../lib/runner.js')
    const removed = await runDshOnce(fakeRunner, ['plugin', '--profile', 'probe3', 'remove', 'dsh-focus-guard'], { home })
    assert.equal(removed.ok, true)
    assert.ok(!readProfileMeta('probe3', home).bundles.includes('dsh-focus-guard'))
    await assert.rejects(
      installIntoProfile({ name: 'nope', packages: ['x'], dsh: fakeRunner, home }),
      /不在本插件清单里/,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('createTempProfile：要建 junction 时拒绝 %TEMP% 下的 home，显式放行才建', async () => {
  const home = tempHome()
  const saved = process.env.DSH_PROFILE_LAB_ALLOW_TEMP_HOME
  delete process.env.DSH_PROFILE_LAB_ALLOW_TEMP_HOME
  try {
    seedSourceProfile(home, 'desktop')
    await assert.rejects(
      createTempProfile({ name: 'probe9', clone: 'desktop', dsh: fakeRunner, home }),
      /%TEMP%/,
    )
    await createTempProfile({ name: 'probe8', template: 'headless', dsh: fakeRunner, home })
    await assert.rejects(
      installIntoProfile({ name: 'probe8', packages: ['link:C:/plugins/dsh-focus-guard'], dsh: fakeRunner, home }),
      /%TEMP%/,
    )
    process.env.DSH_PROFILE_LAB_ALLOW_TEMP_HOME = '1'
    const allowed = await createTempProfile({ name: 'probe10', clone: 'desktop', dsh: fakeRunner, home })
    assert.equal(allowed.ok, true)
    assert.ok(existsSync(join(home, 'profiles', 'probe10', 'node_modules', 'dsh-focus-guard')))
  } finally {
    if (saved === undefined) delete process.env.DSH_PROFILE_LAB_ALLOW_TEMP_HOME
    else process.env.DSH_PROFILE_LAB_ALLOW_TEMP_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
})

test('cloneProfile：node_modules 逐项链接复用，源 profile 一个字节都不改', () => {
  const home = tempHome()
  try {
    const srcDir = seedSourceProfile(home, 'desktop')
    const before = fingerprintProfiles(home)
    const result = cloneProfile('desktop', 'clone1', home)
    assert.ok(result.linked >= 2)
    assert.deepEqual(result.failed, [])

    const dstDir = join(home, 'profiles', 'clone1')
    const cloned = JSON.parse(readFileSync(join(dstDir, 'package.json'), 'utf8'))
    assert.equal(cloned.name, 'dsh-profile-clone1')
    assert.equal(cloned.dependencies['dsh-focus-guard'], 'link:C:/plugins/dsh-focus-guard')
    assert.deepEqual(cloned.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    assert.equal(readFileSync(join(dstDir, 'cordis.patch.yml'), 'utf8'), readFileSync(join(srcDir, 'cordis.patch.yml'), 'utf8'))

    // 逐项链接：目标是链接，且 node_modules 目录本身是真实目录（不是整目录链接）
    assert.equal(isLink(join(dstDir, 'node_modules')), false)
    assert.equal(isLink(join(dstDir, 'node_modules', 'dsh-focus-guard')), true)
    assert.equal(isLink(join(dstDir, 'node_modules', '@local')), false)
    assert.equal(isLink(join(dstDir, 'node_modules', '@local', 'dsh-instance-badge')), true)

    const after = fingerprintProfiles(home)
    for (const [path, value] of Object.entries(before)) {
      if (path.startsWith('clone1')) continue
      assert.deepEqual(after[path], value, `源 profile 被改动了：${path}`)
    }
    assert.equal(statSync(join(srcDir, 'node_modules', 'dsh-focus-guard', 'package.json')).isFile(), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('removeProfileTree：先解链接再删目录，绝不删进源仓库', () => {
  const home = tempHome()
  try {
    const srcDir = seedSourceProfile(home, 'desktop')
    cloneProfile('desktop', 'clone2', home)
    const dstDir = join(home, 'profiles', 'clone2')
    const { unlinked, failed } = removeProfileTree(dstDir)
    assert.ok(unlinked >= 2)
    assert.deepEqual(failed, [])
    assert.equal(existsSync(dstDir), false)
    // 源包实体还在
    assert.equal(existsSync(join(srcDir, 'node_modules', 'dsh-focus-guard', 'package.json')), true)
    assert.equal(existsSync(join(srcDir, 'node_modules', '@local', 'dsh-instance-badge', 'package.json')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('cleanTempProfiles：默认 dry-run，confirm 后才删；只动登记的', async () => {
  const home = tempHome()
  try {
    seedSourceProfile(home, 'desktop')
    await createTempProfile({ name: 'probe4', template: 'headless', dsh: fakeRunner, home })

    const dry = await cleanTempProfiles({ names: ['probe4'], home })
    assert.equal(dry.dryRun, true)
    assert.equal(existsSync(join(home, 'profiles', 'probe4')), true)

    await assert.rejects(cleanTempProfiles({ names: ['desktop'], confirm: true, home }), /正式 profile/)

    const done = await cleanTempProfiles({ names: ['probe4'], confirm: true, home })
    assert.equal(done.ok, true)
    assert.deepEqual(done.removed, ['probe4'])
    assert.deepEqual(done.residue, [])
    assert.equal(existsSync(join(home, 'profiles', 'probe4')), false)
    assert.equal(loadManifest(home).profiles.probe4, undefined)
    assert.equal(existsSync(join(home, 'profiles', 'desktop', 'package.json')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('cleanTempProfiles：归档 profile 配置（含说明），且回收登记的探针会话', async () => {
  const home = tempHome()
  try {
    await createTempProfile({ name: 'probe5', template: 'headless', purpose: '归档测试', dsh: fakeRunner, home })
    const cwd = 'C:\\work\\probe5'
    const sessionDir = join(home, 'sessions', '--C-work-probe5--', 'session-abcdef')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'session.v4.jsonl.zstd'),
      zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: 'session-abcdef', cwd })}\n`, 'utf8')),
    )
    recordSession('probe5', { id: 'session-abcdef', cwd, at: new Date().toISOString() }, home)
    assert.equal(loadManifest(home).profiles.probe5.sessions.length, 1)

    const archiveTo = join(home, 'archive')
    const result = await cleanTempProfiles({ names: ['probe5'], confirm: true, archiveTo, home })
    assert.deepEqual(result.sessionsRemoved, ['session-abcdef'])
    assert.equal(existsSync(sessionDir), false)
    assert.equal(existsSync(join(archiveTo, 'probe5', 'package.json')), true)
    assert.equal(existsSync(join(archiveTo, 'probe5', 'package.json.bak')), false)
    const note = readFileSync(join(archiveTo, 'probe5', 'ARCHIVE-NOTE.md'), 'utf8')
    assert.match(note, /归档测试/)
    assert.match(note, /session-abcdef/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('inspectSession：按 sessionId 全库定位并出摘要', async () => {
  const home = tempHome()
  try {
    const sessionDir = join(home, 'sessions', '--C-work--', 'session-deadbeef')
    mkdirSync(sessionDir, { recursive: true })
    const rows = [
      { type: 'session', version: 4, id: 'session-deadbeef', cwd: 'C:\\work', agentPreset: 'clean-agent' },
      { type: 'tool/call', seq: 1, data: { name: 'pwsh' } },
      { type: 'system/message', seq: 2, data: { message: { content: 'ctx' } } },
      { type: 'assistant/message', seq: 3, data: { usage: { inputTokens: 7, outputTokens: 3 } } },
    ]
    writeFileSync(
      join(sessionDir, 'session.v4.jsonl.zstd'),
      Buffer.concat(rows.map((row) => zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`, 'utf8')))),
    )
    assert.equal(findSessionFileById('session-deadbeef', home), join(sessionDir, 'session.v4.jsonl.zstd'))
    const summary = inspectSession({ sessionId: 'session-deadbeef', home })
    assert.equal(summary.frames, 4)
    assert.equal(summary.agentPreset, 'clean-agent')
    assert.equal(summary.toolCount, 1)
    assert.equal(summary.tokens.uncachedInputTokens, 7)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('fingerprintProfiles 能发现被改动的文件', async () => {
  const home = tempHome()
  try {
    seedSourceProfile(home, 'desktop')
    const before = fingerprintProfiles(home)
    const key = Object.keys(before).find((path) => path.includes('cordis.patch.yml'))
    assert.ok(key, '指纹里应包含 cordis.patch.yml')
    writeFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), '# changed\n')
    const after = fingerprintProfiles(home)
    assert.notEqual(after[key].sha256, before[key].sha256)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
