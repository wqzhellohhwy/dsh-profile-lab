/**
 * 驻留 web 实例测试：`tmpprofile_web_start` / `web_probe` / `web_stop` 的闭环与护栏。
 *
 * 全部用假 dsh 夹具（`fixtures/fake-dsh.mjs` 支持 `--port`，会真的监听一个 HTTP 端口），
 * 所以能确定性验证「起得来、探得到、停得掉」，不启动真实 dsh、不联网。
 *
 * 这一层补的是 headless 验不了的面：**HTTP 服务真的在监听**。
 */
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { buildTools } from '../lib/tools.js'
import { isWebRunning, killAllWebInstances, pickFreePort, probeHttp, startWebInstance, stopWebInstance } from '../lib/web.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_DSH = join(HERE, 'fixtures', 'fake-dsh.mjs')
const fakeRunner = { execPath: process.execPath, asNode: false, binPath: FAKE_DSH, version: '0.0.0-test' }

function assertLossless(value, label) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label} 的返回值不是 lossless JSON`)
}

function makeTools(home) {
  const tools = buildTools({ getRunner: async () => fakeRunner, getHome: () => home, log: () => {} })
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]))
}

/**
 * 删临时目录（带重试）。
 *
 * Windows 上刚被 taskkill 的子进程会短暂占着目录句柄，立刻 rmSync 会吃 EPERM——
 * 这是系统行为，不是产品缺陷，所以测试侧重试几次即可。
 * @param {string} dir 目录。
 */
async function rmWithRetry(dir) {
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (i === 9) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

test('pickFreePort 返回一个能真正绑定的端口', async () => {
  const port = await pickFreePort(19399)
  assert.equal(typeof port, 'number')
  assert.ok(port >= 1024 && port <= 65535)
  // 能绑定即证明空闲
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port, host: '127.0.0.1' }, resolve)
  })
  await new Promise((resolve) => server.close(resolve))
})

test('probeHttp 拿到状态码与 body 预览，超时/拒连给出 ok:false', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404)
    res.end('nope')
  })
  const port = await new Promise((resolve) => {
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(server.address().port))
  })
  try {
    const ok = await probeHttp({ port, path: '/json' })
    assert.equal(ok.ok, true)
    assert.equal(ok.status, 200)
    assert.equal(ok.bodyPreview, '{"ok":true}')
    assertLossless(ok, 'probeHttp(200)')

    const missing = await probeHttp({ port, path: '/missing' })
    assert.equal(missing.ok, true, '4xx 也是一次成功的探针（能拿到状态码）')
    assert.equal(missing.status, 404)

    const dead = await probeHttp({ port: port + 1, path: '/', timeoutMs: 1200 })
    assert.equal(dead.ok, false)
    assert.equal(typeof dead.error, 'string')
    assertLossless(dead, 'probeHttp(拒连)')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('web 实例闭环：start → probe → 重复 start 被拒 → stop → 端口释放', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-lab-web-'))
  try {
    const byName = makeTools(home)
    const created = await byName.tmpprofile_create.execute({ name: 'webprobe', template: 'web', purpose: 'web 实例闭环' })
    assert.equal(created.ok, true)

    // 直接用底层 API 起（不经工具层），顺带验证 probePath 短路
    const started = await startWebInstance({ dsh: fakeRunner, profile: 'webprobe', home, probePath: '/' })
    assert.equal(started.ok, true)
    assert.equal(typeof started.pid, 'number')
    assert.ok(started.port >= 1024)
    assert.equal(isWebRunning('webprobe'), true)
    assert.equal(started.probe.status, 200)

    // 同一 profile 不允许第二个实例
    await assert.rejects(
      () => startWebInstance({ dsh: fakeRunner, profile: 'webprobe', home }),
      /已有一个 web 实例在跑/,
    )

    const stopped = await stopWebInstance('webprobe', { waitMs: 15000 })
    assert.equal(stopped.ok, true)
    assert.equal(stopped.portFreed, true, `端口应被释放（port=${stopped.port}）`)
    assert.equal(isWebRunning('webprobe'), false)
    assertLossless(stopped, 'stopWebInstance')
  } finally {
    killAllWebInstances()
    await rmWithRetry(home)
  }
})

test('工具层：web_start / web_probe / web_stop 与 list 的 webInstance 字段', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-lab-web-tools-'))
  try {
    const byName = makeTools(home)
    assert.equal(byName.tmpprofile_web_start !== undefined, true, '应注册 web_start')
    await byName.tmpprofile_create.execute({ name: 'webtool', template: 'web' })

    const started = await byName.tmpprofile_web_start.execute({ name: 'webtool', probePath: '/' })
    assertLossless(started, 'web_start')
    assert.equal(started.ok, true)
    assert.equal(started.ready, true)
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)

    const listed = await byName.tmpprofile_list.execute({})
    const managed = listed.managed.find((item) => item.name === 'webtool')
    assert.equal(managed.webInstance.pid, started.pid)
    assert.equal(managed.webInstance.port, started.port)

    const probe = await byName.tmpprofile_web_probe.execute({ name: 'webtool', path: '/api/anything' })
    assertLossless(probe, 'web_probe')
    assert.equal(probe.ok, true)
    assert.equal(probe.status, 200)
    assert.match(probe.bodyPreview, /"fake":true/)

    const stopped = await byName.tmpprofile_web_stop.execute({ name: 'webtool' })
    assertLossless(stopped, 'web_stop')
    assert.equal(stopped.ok, true)
    assert.equal(stopped.portFreed, true)

    const after = await byName.tmpprofile_list.execute({})
    assert.equal(after.managed.find((item) => item.name === 'webtool').webInstance, null, '停掉后清单里的登记应清空')

    const cleaned = await byName.tmpprofile_clean.execute({ names: ['webtool'], confirm: true })
    assert.deepEqual(cleaned.residue, [])
  } finally {
    killAllWebInstances()
    await rmWithRetry(home)
  }
})

test('clean 会先停掉还在跑的 web 实例（不留孤儿进程）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-lab-web-clean-'))
  try {
    const byName = makeTools(home)
    await byName.tmpprofile_create.execute({ name: 'webclean', template: 'web' })
    const started = await byName.tmpprofile_web_start.execute({ name: 'webclean' })
    assert.equal(started.ok, true)

    const cleaned = await byName.tmpprofile_clean.execute({ names: ['webclean'], confirm: true })
    assertLossless(cleaned, 'clean(带实例)')
    assert.equal(cleaned.ok, true)
    assert.equal(cleaned.stoppedInstances.length, 1, 'clean 应记录被停掉的实例')
    assert.equal(cleaned.stoppedInstances[0].pid, started.pid)
    assert.deepEqual(cleaned.residue, [])
    assert.equal(isWebRunning('webclean'), false)
  } finally {
    killAllWebInstances()
    await rmWithRetry(home)
  }
})

test('工具层：web 相关错误路径也是 lossless JSON（ok:false + message）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-lab-web-err-'))
  try {
    const byName = makeTools(home)
    const cases = [
      [await byName.tmpprofile_web_start.execute({ name: 'nope' }), 'web_start(未登记)'],
      [await byName.tmpprofile_web_probe.execute({ name: 'nope' }), 'web_probe(未登记)'],
      [await byName.tmpprofile_web_stop.execute({ name: 'nope' }), 'web_stop(未登记)'],
    ]
    for (const [result, label] of cases) {
      assertLossless(result, label)
      assert.equal(result.ok, false, `${label} 应失败`)
      assert.equal(typeof result.message, 'string', `${label} 应给出 message`)
    }

    // 登记了但没起实例
    await byName.tmpprofile_create.execute({ name: 'weberr', template: 'web' })
    const probe = await byName.tmpprofile_web_probe.execute({ name: 'weberr' })
    assertLossless(probe, 'web_probe(无实例)')
    assert.equal(probe.ok, false)
    const stop = await byName.tmpprofile_web_stop.execute({ name: 'weberr' })
    assertLossless(stop, 'web_stop(无实例)')
    assert.equal(stop.ok, false)
  } finally {
    killAllWebInstances()
    await rmWithRetry(home)
  }
})

test('killAllWebInstances 一次收掉全部实例', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-lab-web-all-'))
  try {
    const byName = makeTools(home)
    for (const name of ['weball1', 'weball2']) {
      await byName.tmpprofile_create.execute({ name, template: 'web' })
      const started = await byName.tmpprofile_web_start.execute({ name })
      assert.equal(started.ok, true)
    }
    const killed = killAllWebInstances()
    assert.equal(killed.length, 2)
    assert.equal(isWebRunning('weball1'), false)
    assert.equal(isWebRunning('weball2'), false)
  } finally {
    killAllWebInstances()
    await rmWithRetry(home)
  }
})
