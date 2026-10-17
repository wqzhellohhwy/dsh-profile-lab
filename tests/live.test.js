/**
 * 真实环境闭环测试（默认跳过；`DSH_LAB_LIVE=1` 才跑）。
 *
 * 会真的建 profile、真的跑一次 headless 会话（消耗极少量 token）、真的清理。
 * 关键断言：**除本次建的临时 profile 外，profiles/ 里其他 profile 一个字节都没变**。
 *
 * 用法：
 *   $env:DSH_LAB_LIVE='1'; node --test tests/live.test.js
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveDshRunner } from '../lib/runner.js'
import {
  cleanTempProfiles,
  createTempProfile,
  fingerprintProfiles,
  inspectSession,
  installIntoProfile,
  listProfiles,
  loadManifest,
  recordSession,
} from '../lib/lab.js'
import { tmproot } from './_tmp.js'

const LIVE = process.env.DSH_LAB_LIVE === '1'
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** 把我们操作期间的变化与其他 profile 的噪声分开。 */
function diffFingerprints(before, after, excludePrefix) {
  const changes = []
  for (const [path, value] of Object.entries(after)) {
    if (path.startsWith(excludePrefix)) continue
    const previous = before[path]
    if (previous === undefined) changes.push({ path, kind: 'new' })
    else if (previous.sha256 !== value.sha256 || previous.mtime !== value.mtime) changes.push({ path, kind: 'changed' })
  }
  for (const path of Object.keys(before)) {
    if (path.startsWith(excludePrefix)) continue
    if (after[path] === undefined) changes.push({ path, kind: 'removed' })
  }
  return changes
}

test('live：建 → 跑 headless → 读回摘要 → 清理，且不触碰其他 profile', { skip: !LIVE, timeout: 600_000 }, async () => {
  const dsh = await resolveDshRunner({})
  assert.ok(dsh.version, 'dsh 版本探测应成功')
  console.log(`    [live] dsh ${dsh.version} @ ${dsh.binPath}（来源：${dsh.source}）`)

  const name = `liveprobe${Date.now().toString(36)}`
  const cwd = tmproot("dsh-lab-live-cwd-")
  const before = fingerprintProfiles(HOME)
  let sessionId
  let cleaned
  try {
    const created = await createTempProfile({ name, template: 'headless', purpose: 'live 闭环验证', dsh, home: HOME })
    assert.equal(created.ok, true)
    assert.ok(existsSync(created.dir), 'profile 目录应存在')
    assert.ok(created.bundles.includes('@deepseek-ai/dsh-headless'))

    const { runHeadless } = await import('../lib/runner.js')
    const run = await runHeadless({
      dsh,
      profile: name,
      task: '只回复两个字：OK',
      json: true,
      cwd,
      timeoutMs: 300_000,
    })
    assert.equal(run.timedOut, false, '不应超时')
    assert.equal(run.exitCode, 0, `headless 应 exit 0，stderr：${run.stderr.slice(0, 500)}`)
    sessionId = run.sessionId
    assert.ok(typeof sessionId === 'string' && sessionId.startsWith('session-'), `应拿到 sessionId，实际 ${sessionId}`)
    console.log(`    [live] headless ${(run.durationMs / 1000).toFixed(1)}s → ${sessionId}，事件 ${run.events.length} 条`)

    recordSession(name, { id: sessionId, cwd, at: new Date().toISOString() }, HOME)
    const summary = inspectSession({ sessionId, home: HOME, sections: ['preset', 'tools', 'tokens'] })
    assert.ok(summary.eventCount >= 3, `会话事件应 >= 3，实际 ${summary.eventCount}`)
    assert.ok(summary.frames >= 1)
    console.log(`    [live] 会话摘要：preset=${summary.agentPreset} 事件=${summary.eventCount} 帧=${summary.frames} 工具=${JSON.stringify(summary.tools?.map((t) => t.name))}`)
    assert.match(JSON.stringify(summary.tokens), /outputTokens/)
  } finally {
    cleaned = await cleanTempProfiles({ names: [name], confirm: true, sessions: true, home: HOME })
    rmSync(cwd, { recursive: true, force: true })
  }

  assert.deepEqual(cleaned.residue, [], `清理后有残留：${JSON.stringify(cleaned.residue)}`)
  assert.equal(existsSync(join(HOME, 'profiles', name)), false)
  assert.equal(loadManifest(HOME).profiles[name], undefined)
  assert.equal(listProfiles(HOME).managed.some((item) => item.name === name), false)

  const after = fingerprintProfiles(HOME)
  const changes = diffFingerprints(before, after, name)
  assert.deepEqual(changes, [], `其他 profile 被触碰了：${JSON.stringify(changes, undefined, 1)}`)
})

test('live：装一个本地插件后 bundles 自动带上它，跑完能读回工具面', { skip: !LIVE, timeout: 600_000 }, async () => {
  const dsh = await resolveDshRunner({})
  const pluginDir = process.env.DSH_LAB_LIVE_PLUGIN ?? 'C:/repository/dsh-system-prompts'
  if (!existsSync(pluginDir)) {
    console.log(`    [live] 跳过：夹具插件不存在 ${pluginDir}`)
    return
  }
  const name = `liveplug${Date.now().toString(36)}`
  const cwd = tmproot("dsh-lab-live-plug-")
  try {
    const created = await createTempProfile({ name, template: 'headless', purpose: 'live 装插件验证', dsh, home: HOME })
    assert.equal(created.ok, true)
    const installed = await installIntoProfile({ name, packages: [`link:${pluginDir}`], dsh, home: HOME })
    assert.equal(installed.ok, true, `装插件应成功：${installed.stderrTail}`)
    assert.ok(installed.addedBundles.length >= 1, `插件的 bundle 应被自动挂上：${JSON.stringify(installed.bundles)}`)

    const { runHeadless } = await import('../lib/runner.js')
    const run = await runHeadless({ dsh, profile: name, task: '只回复两个字：OK', json: true, cwd, timeoutMs: 300_000 })
    assert.equal(run.exitCode, 0, `装了插件的 profile 也应能起来：${run.stderr.slice(0, 800)}`)
    console.log(`    [live] 装插件后运行 OK，addedBundles=${JSON.stringify(installed.addedBundles)}`)
  } finally {
    const cleaned = await cleanTempProfiles({ names: [name], confirm: true, sessions: true, home: HOME })
    rmSync(cwd, { recursive: true, force: true })
    assert.deepEqual(cleaned.residue, [])
  }
})
