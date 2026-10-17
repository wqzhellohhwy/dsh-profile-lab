/**
 * 工具层测试：直接调 `tmpprofile_*` 工具的 `execute`，验证
 *
 *   1. 五个写/读动作能串成完整闭环（建 → 装 → 跑 → 读回 → 清理）；
 *   2. 每个返回值都是 **lossless JSON**——DSH 会拒收含 `undefined` 的返回值
 *      （`value is not lossless JSON`），这是真实踩过的坑，必须回归防守；
 *   3. 同会话多轮：第二次 run 传 sessionId 能续上同一会话。
 *
 * 全部用假 dsh 夹具，不启动真实 dsh、不联网、不消耗 token。
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { buildTools, jsonSafe } from '../lib/tools.js'
import { tmproot } from './_tmp.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_DSH = join(HERE, 'fixtures', 'fake-dsh.mjs')
const fakeRunner = { execPath: process.execPath, asNode: false, binPath: FAKE_DSH, version: '0.0.0-test' }

/** DSH 的校验语义：序列化再解析必须与原值完全一致（含键集），否则含 undefined。 */
function assertLossless(value, label) {
  assert.deepEqual(
    JSON.parse(JSON.stringify(value)),
    value,
    `${label} 的返回值不是 lossless JSON（可能含 undefined，会被 DSH 整条拒收）`,
  )
}

function makeTools(home) {
  const tools = buildTools({
    getRunner: async () => fakeRunner,
    getHome: () => home,
    log: () => {},
  })
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  return { tools, byName }
}

test('jsonSafe 丢掉 undefined、保留 null、非有限数转 null', () => {
  const value = jsonSafe({ a: 1, b: undefined, c: null, d: Number.NaN, e: [1, undefined, 2], f: { g: undefined, h: 'x' } })
  assert.deepEqual(value, { a: 1, c: null, d: null, e: [1, null, 2], f: { h: 'x' } })
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

test('jsonSafe 兜住 lossless JSON 的全部拒绝项（-0 / 稀疏数组 / 环 / BigInt / Symbol / 类实例）', () => {
  const sparse = [1, , 3] // eslint-disable-line no-sparse-arrays
  assert.equal(sparse.length, 3)
  assert.equal(1 in sparse, false, '前提：确实是稀疏数组')

  const cyclic = { name: 'root' }
  cyclic.self = cyclic

  class Thing {
    constructor() { this.kind = 'thing'; this.n = 1 }
    method() { return 1 }
  }

  const value = jsonSafe({
    negZero: -0,
    sparse,
    cyclic,
    big: 10n,
    sym: Symbol('s'),
    map: new Map([['k', 'v']]),
    set: new Set([1, 2]),
    date: new Date('2026-10-13T00:00:00.000Z'),
    badDate: new Date(Number.NaN),
    err: new Error('boom'),
    inst: new Thing(),
  })

  assert.equal(Object.is(value.negZero, -0), false, '-0 必须被转成 0（规则显式拒绝 -0）')
  assert.equal(value.negZero, 0)
  assert.equal(1 in value.sparse, true, '稀疏数组必须被填实（空洞补 null）')
  assert.deepEqual(value.sparse, [1, null, 3])
  assert.equal(value.cyclic.self, null, '环必须降级为 null 而不是抛栈溢出')
  assert.equal(value.big, '10')
  assert.equal(typeof value.sym, 'string')
  assert.deepEqual(value.map, { k: 'v' })
  assert.deepEqual(value.set, [1, 2])
  assert.equal(value.date, '2026-10-13T00:00:00.000Z')
  assert.equal(value.badDate, null)
  assert.deepEqual(value.err, { name: 'Error', message: 'boom' })
  assert.deepEqual(value.inst, { kind: 'thing', n: 1 }, '类实例摊平成 plain object，函数字段被丢弃')

  // 全部可无损往返
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

test('工具层完整闭环：create → install → run → session → list → fingerprint → clean', async () => {
  const home = tmproot("dsh-lab-tools-")
  try {
    const { tools, byName } = makeTools(home)
    assert.equal(tools.length, 10, '应注册 10 个工具')

    const created = await byName.tmpprofile_create.execute({ name: 'toolprobe', template: 'headless', purpose: '工具层闭环' })
    assertLossless(created, 'create')
    assert.equal(created.ok, true)
    assert.equal(created.clonedFrom, undefined, 'create 返回值里不该出现 undefined 字段')
    assert.ok(created.bundles.includes('@deepseek-ai/dsh-headless'))

    const installed = await byName.tmpprofile_install.execute({ name: 'toolprobe', packages: ['link:C:/plugins/dsh-focus-guard'] })
    assertLossless(installed, 'install')
    assert.equal(installed.ok, true)
    assert.deepEqual(installed.results[0].addedBundles, ['dsh-focus-guard'])

    const run = await byName.tmpprofile_run.execute({ name: 'toolprobe', task: '只回复两个字：OK' })
    assertLossless(run, 'run')
    assert.equal(run.ok, true)
    assert.equal(run.exitCode, 0)
    assert.ok(typeof run.sessionId === 'string' && run.sessionId.startsWith('session-'))
    // 工具面必须来自磁盘上的完整会话日志（--json 投影里没有 tool/call）
    assert.ok(run.session, `run 应带上会话摘要：${JSON.stringify(run.session)}`)
    assert.equal(run.session.toolCount, 1)
    assert.deepEqual(run.session.tools.map((tool) => tool.name), ['tmpprofile_list'])
    assert.equal(run.session.tokens.cacheReadTokens, 22)

    const session = await byName.tmpprofile_session.execute({ name: 'toolprobe', sections: ['preset', 'tools', 'tokens'] })
    assertLossless(session, 'session')
    assert.equal(session.ok, true)
    assert.equal(session.agentPreset, 'fake-preset')
    assert.equal(session.toolCount, 1)

    const listed = await byName.tmpprofile_list.execute({})
    assertLossless(listed, 'list')
    assert.equal(listed.ok, true)
    assert.deepEqual(listed.managed.map((item) => item.name), ['toolprobe'])

    const fingerprint = await byName.tmpprofile_fingerprint.execute({ exclude: ['toolprobe'] })
    assertLossless(fingerprint, 'fingerprint')
    assert.equal(fingerprint.ok, true)

    const dry = await byName.tmpprofile_clean.execute({ names: ['toolprobe'] })
    assertLossless(dry, 'clean(dry)')
    assert.equal(dry.dryRun, true)
    assert.equal(existsSync(join(home, 'profiles', 'toolprobe')), true)

    const cleaned = await byName.tmpprofile_clean.execute({ names: ['toolprobe'], confirm: true, sessions: true })
    assertLossless(cleaned, 'clean')
    assert.equal(cleaned.ok, true)
    assert.deepEqual(cleaned.residue, [])
    assert.equal(existsSync(join(home, 'profiles', 'toolprobe')), false)

    const after = await byName.tmpprofile_list.execute({})
    assert.equal(after.managed.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('工具层：同会话多轮（第二次传 sessionId 续上同一会话）', async () => {
  const home = tmproot("dsh-lab-tools-multi-")
  try {
    const { byName } = makeTools(home)
    await byName.tmpprofile_create.execute({ name: 'multiprobe', template: 'headless' })

    const first = await byName.tmpprofile_run.execute({ name: 'multiprobe', task: '第一轮' })
    assert.equal(first.ok, true)
    const firstId = first.sessionId
    assert.ok(firstId)

    const second = await byName.tmpprofile_run.execute({ name: 'multiprobe', task: '第二轮', sessionId: firstId })
    assertLossless(second, 'run(2nd)')
    assert.equal(second.ok, true)
    assert.equal(second.sessionId, firstId, '第二轮应续上同一会话')

    const session = await byName.tmpprofile_session.execute({ sessionId: firstId, sections: ['tools', 'tokens'] })
    assert.equal(session.ok, true)
    // 两轮各写了一次 tool/call 与 usage
    assert.equal(session.tools[0].calls, 2)
    assert.equal(session.tokens.cacheReadTokens, 44)
    assert.equal(session.turns, 2)

    const cleaned = await byName.tmpprofile_clean.execute({ names: ['multiprobe'], confirm: true, sessions: true })
    assert.deepEqual(cleaned.residue, [])
    assert.equal(cleaned.sessionsRemoved.length >= 1, true, '登记的探针会话应被回收')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('工具层：错误路径也必须是 lossless JSON（ok:false + message）', async () => {
  const home = tmproot("dsh-lab-tools-err-")
  try {
    const { byName } = makeTools(home)
    const cases = [
      [await byName.tmpprofile_create.execute({ name: 'desktop' }), 'create(保留名)'],
      [await byName.tmpprofile_create.execute({ name: 'BAD NAME' }), 'create(非法名)'],
      [await byName.tmpprofile_run.execute({ name: 'nope', task: 'x' }), 'run(未登记)'],
      [await byName.tmpprofile_install.execute({ name: 'nope' }), 'install(空参数)'],
      [await byName.tmpprofile_session.execute({}), 'session(缺参数)'],
      [await byName.tmpprofile_clean.execute({ names: ['nope'], confirm: true }), 'clean(未登记)'],
    ]
    for (const [result, label] of cases) {
      assertLossless(result, label)
      assert.equal(result.ok, false, `${label} 应失败`)
      assert.equal(typeof result.message, 'string', `${label} 应给出 message`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('工具层：tools.disabled 能按名字关掉工具（做工具面验证时用）', () => {
  const home = tmproot("dsh-lab-tools-off-")
  try {
    const tools = buildTools({
      getRunner: async () => fakeRunner,
      getHome: () => home,
      toolConfig: { disabled: ['tmpprofile_fingerprint', 'tmpprofile_list'] },
    })
    assert.equal(tools.length, 8)
    assert.equal(tools.some((tool) => tool.name === 'tmpprofile_fingerprint'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
