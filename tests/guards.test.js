import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import {
  assertManageable,
  assertProfileName,
  cwdToSessionDirName,
  findSessionDir,
  isLink,
  RESERVED_PROFILE_NAMES,
  withLock,
} from '../lib/guards.js'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-lab-guards-'))
}

test('assertProfileName 接受合法名', () => {
  for (const name of ['probe', 'tm-verify', 'a1', 'exp.cache', 'x_y-z']) {
    assert.equal(assertProfileName(name), name)
  }
})

test('assertProfileName 拒绝非法名与保留名', () => {
  for (const bad of ['', 'A', 'a', 'a b', 'a/b', 'a\\b', '..', '.', 'node_modules', 'a'.repeat(41), '-lead']) {
    assert.throws(() => assertProfileName(bad), /非法|必须是字符串|空白/)
  }
  for (const reserved of RESERVED_PROFILE_NAMES) {
    assert.throws(() => assertProfileName(reserved), /正式 profile/)
  }
})

test('assertManageable 只放行清单里登记过的 profile', () => {
  const manifest = { version: 1, profiles: { probe: {} } }
  assert.equal(assertManageable('probe', manifest), 'probe')
  assert.throws(() => assertManageable('other', manifest), /不在本插件清单里/)
  assert.throws(() => assertManageable('desktop', manifest), /正式 profile/)
})

test('cwdToSessionDirName 与实测样本一致', () => {
  assert.equal(
    cwdToSessionDirName('C:\\Users\\53518\\Documents\\DSH\\2026-10-11\\session-01-26-31-a3e641b5'),
    '--C-Users-53518-Documents-DSH-2026-10-11-session-01-26-31-a3e641b5--',
  )
  assert.equal(
    cwdToSessionDirName('C:\\Users\\53518\\Documents\\DSH\\未分组'),
    '--C-Users-53518-Documents-DSH-~672A~5206~7EC4--',
  )
  assert.equal(
    cwdToSessionDirName('C:\\Users\\53518\\Documents\\DSH\\2026-10-11\\session-01-26-31-a3e641b5\\_evidence\\tmv'),
    '--C-Users-53518-Documents-DSH-2026-10-11-session-01-26-31-a3e641b5-_evidence-tmv--',
  )
})

test('findSessionDir 命中按编码推出的目录', () => {
  const home = tempHome()
  try {
    const cwd = 'C:\\work\\proj'
    const dir = join(home, 'sessions', cwdToSessionDirName(cwd), 'session-abc')
    mkdirSync(dir, { recursive: true })
    assert.equal(findSessionDir(cwd, home), join(home, 'sessions', cwdToSessionDirName(cwd)))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('findSessionDir 在编码推不中时按 header 的 cwd 兜底扫描', () => {
  const home = tempHome()
  try {
    const cwd = 'C:\\somewhere\\else'
    // 故意用一个与编码规则不符的目录名
    const dir = join(home, 'sessions', '--not-the-encoded-name--', 'session-xyz')
    mkdirSync(dir, { recursive: true })
    const header = Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: 'session-xyz', cwd })}\n`, 'utf8')
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(header))
    assert.equal(findSessionDir(cwd, home), join(home, 'sessions', '--not-the-encoded-name--'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('isLink 不跟随链接（对普通目录返回 false）', () => {
  const home = tempHome()
  try {
    mkdirSync(join(home, 'plain'), { recursive: true })
    assert.equal(isLink(join(home, 'plain')), false)
    assert.equal(isLink(join(home, 'missing')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('withLock 串行化临界区并在结束后释放锁', async () => {
  const home = tempHome()
  try {
    const lock = join(home, 'x.lock')
    const order = []
    await Promise.all([
      withLock(lock, async () => {
        order.push('a-start')
        await new Promise((resolve) => setTimeout(resolve, 60))
        order.push('a-end')
      }, { pollMs: 10 }),
      withLock(lock, async () => {
        order.push('b-start')
        order.push('b-end')
      }, { pollMs: 10 }),
    ])
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'])
    assert.equal(existsSync(lock), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('withLock 抢占陈旧锁（进程被强杀的场景）', async () => {
  const home = tempHome()
  try {
    const lock = join(home, 'x.lock')
    mkdirSync(home, { recursive: true })
    writeFileSync(lock, JSON.stringify({ pid: 999999, at: '2000-01-01T00:00:00Z' }))
    const stamp = new Date(Date.now() - 10 * 60 * 1000)
    const { utimesSync } = await import('node:fs')
    utimesSync(lock, stamp, stamp)
    const value = await withLock(lock, async () => 'acquired', { staleMs: 1000, waitMs: 2000 })
    assert.equal(value, 'acquired')
    assert.equal(existsSync(lock), false, '临界区结束后锁文件应被释放')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
