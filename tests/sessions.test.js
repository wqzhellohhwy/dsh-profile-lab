import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { decodeZstdFrames, readSessionEvents, summarize, ZSTD_MAGIC } from '../lib/sessions.js'

/** 造一个多帧 zstd 会话日志（模拟 DSH 每追加一批事件压一帧）。 */
function multiFrameSession(rows) {
  return Buffer.concat(rows.map((row) => zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`, 'utf8'))))
}

const HEADER = { type: 'session', version: 4, id: 'session-test-1', createdAt: 1, cwd: 'C:\\work', agentPreset: 'clean-agent' }

test('多帧 zstd：每一帧都被解出来，且顺序正确', () => {
  const frames = [HEADER, { type: 'tool/call', seq: 1, data: { name: 'pwsh' } }, { type: 'tool/call', seq: 2, data: { name: 'read' } }]
  const buf = multiFrameSession(frames)
  const decoded = decodeZstdFrames(buf)
  assert.equal(decoded.length, 3)
  for (let i = 1; i < decoded.length; i += 1) assert.ok(decoded[i].offset > decoded[i - 1].offset)

  const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-sessions-'))
  try {
    const file = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(file, buf)
    const { events, frames: frameCount } = readSessionEvents(file)
    assert.equal(frameCount, 3)
    assert.deepEqual(events.map((event) => event.type), ['session', 'tool/call', 'tool/call'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('多帧 zstd：压缩数据里出现的伪魔数被跳过，不会污染事件流', () => {
  const good = zstdCompressSync(Buffer.from(`${JSON.stringify(HEADER)}\n`, 'utf8'))
  const junk = Buffer.concat([ZSTD_MAGIC, Buffer.from('这不是一帧 zstd 数据', 'utf8')])
  const decoded = decodeZstdFrames(Buffer.concat([good, junk, good]))
  assert.equal(decoded.length, 2)
})

test('明文 .jsonl 也能读（旧格式 / 未压缩）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-sessions-plain-'))
  try {
    const file = join(dir, 'session.v4.jsonl')
    writeFileSync(file, `${JSON.stringify(HEADER)}\n${JSON.stringify({ type: 'turn/end', seq: 9 })}\n`, 'utf8')
    const { events, frames } = readSessionEvents(file)
    assert.equal(frames, 1)
    assert.equal(events.length, 2)
    assert.equal(events[0].agentPreset, 'clean-agent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('summarize 提取 preset / 工具面 / token / 上下文', () => {
  const events = [
    HEADER,
    { type: 'system/message', seq: 1, data: { message: { content: 'runtime context …' } } },
    { type: 'developer/message', seq: 2, data: { message: { content: 'memory …' } } },
    { type: 'tool/call', seq: 3, data: { name: 'pwsh' } },
    { type: 'tool/call', seq: 4, data: { name: 'pwsh' } },
    { type: 'tool/call', seq: 5, data: { name: 'read' } },
    { type: 'tool/result', seq: 6, data: { name: 'read', message: { isError: true, content: [{ type: 'text', text: 'boom' }] } } },
    { type: 'assistant/message', seq: 7, data: { usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 20 } } },
    { type: 'assistant/message', seq: 8, data: { message: { usage: { inputTokens: 50, cacheReadTokens: 0, outputTokens: 5 } } } },
    { type: 'turn/end', seq: 9 },
  ]
  const summary = summarize(events, { sections: ['preset', 'tools', 'contexts', 'tokens', 'errors'] })
  assert.equal(summary.sessionId, 'session-test-1')
  assert.equal(summary.agentPreset, 'clean-agent')
  assert.equal(summary.preset.version, 4)
  assert.equal(summary.turns, 1)
  assert.deepEqual(
    summary.tools.map((tool) => [tool.name, tool.calls]),
    [
      ['pwsh', 2],
      ['read', 1],
    ],
  )
  assert.equal(summary.tools.find((tool) => tool.name === 'read').errors, 1)
  assert.equal(summary.tokens.uncachedInputTokens, 150)
  assert.equal(summary.tokens.cacheReadTokens, 900)
  assert.equal(summary.tokens.outputTokens, 25)
  assert.equal(summary.tokens.samples, 2)
  const contextTypes = summary.contexts.map((context) => context.type).sort()
  assert.deepEqual(contextTypes, ['developer/message', 'system/message'])
  assert.equal(summary.errors.length, 1)
})

test('summarize 对未知事件类型只记账不报错（跨版本宽容）', () => {
  const summary = summarize([HEADER, { type: 'brand/new-event', seq: 1 }, { seq: 2 }])
  assert.equal(summary.byType['brand/new-event'], 1)
  assert.equal(summary.byType['(none)'], 1)
  assert.equal(summary.eventCount, 3)
})

test('summarize 的 raw 分区按 limit 截断', () => {
  const events = [HEADER, ...Array.from({ length: 10 }, (_, index) => ({ type: 'x', seq: index }))]
  const summary = summarize(events, { sections: ['raw'], limit: 3 })
  assert.equal(summary.raw.length, 3)
  assert.equal(summary.raw[0].type, 'session')
})
