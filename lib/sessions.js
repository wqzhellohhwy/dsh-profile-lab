/**
 * dsh-profile-lab —— 会话读取与摘要（零第三方依赖）。
 *
 * 背景：`session.v4.jsonl.zstd` 是**多帧** zstd（DSH 每追加一批事件就压一帧）。
 * Node 的 `zstdDecompressSync` 对多帧输入**只解第一帧且不报错**，也不暴露
 * 「剩余未消费字节」——所以"整段丢进去解一次"只会拿到 254 字节的 header。
 *
 * 官方 `@deepseek-ai/dsh-session-persistence-jsonl` 的做法是：先按 zstd 魔数
 * （`0xFD2FB528`，小端字节 `28 B5 2F FD`）扫描出所有帧起点，再逐帧解压。
 * 本模块采用同一思路，并利用「one-shot 只解第一帧」这一特性把实现压到最短：
 * 对每个魔数偏移都做一次 `zstdDecompressSync`，成功即得该帧内容，伪魔数直接跳过。
 *
 * @module dsh-profile-lab/sessions
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数（小端字节序）。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 单个字符串字段的默认截断长度。 */
export const DEFAULT_STRING_LIMIT = 400

/**
 * 按魔数逐帧解压一个多帧 zstd 缓冲。
 * @param {Buffer} buf 文件内容。
 * @returns {{offset: number, data: Buffer}[]} 各帧（按偏移升序）。
 */
export function decodeZstdFrames(buf) {
  const frames = []
  let index = buf.indexOf(ZSTD_MAGIC)
  while (index !== -1) {
    try {
      const data = zstdDecompressSync(buf.subarray(index))
      // 会话日志是 JSONL：第一帧是 `{"type":"session"...}`。以此过滤压缩数据里
      // 偶然出现的伪魔数（否则会解出无关字节）。
      const head = data.subarray(0, 1).toString('utf8')
      if (head === '{' || head === '\n' || head === '[') frames.push({ offset: index, data })
    } catch {
      /* 不是真正的帧起点，跳过 */
    }
    index = buf.indexOf(ZSTD_MAGIC, index + 4)
  }
  return frames
}

/**
 * 读一个会话日志文件（`.zstd` 多帧或明文 `.jsonl`）的全部事件。
 * @param {string} file 文件路径。
 * @returns {{events: object[], frames: number, bytes: number, text: string}} 解析结果。
 */
export function readSessionEvents(file) {
  if (!existsSync(file)) throw new Error(`会话日志不存在：${file}`)
  const buf = readFileSync(file)
  const frames = file.endsWith('.zstd') ? decodeZstdFrames(buf) : [{ offset: 0, data: buf }]
  const text = Buffer.concat(frames.map((frame) => frame.data)).toString('utf8')
  const events = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      events.push({ type: 'unparsed', raw: trimmed.slice(0, 200) })
    }
  }
  return { events, frames: frames.length, bytes: buf.length, text }
}

/**
 * 截断字符串，便于放进工具返回值。
 * @param {unknown} value 任意值。
 * @param {number} [limit] 上限。
 * @returns {string} 截断后的字符串。
 */
export function clip(value, limit = DEFAULT_STRING_LIMIT) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return text.length > limit ? `${text.slice(0, limit)}…(+${text.length - limit})` : text
}

/** 取事件的 type（容错）。 */
function typeOf(event) {
  return typeof event?.type === 'string' ? event.type : '(none)'
}

/** 取事件里可能承载 usage 的对象（新格式在 data.usage，旧格式在 data.message.usage）。 */
function usageOf(event) {
  const data = event?.data ?? {}
  return data.usage ?? data.message?.usage ?? event?.usage ?? undefined
}

/** 取事件的 cwd（header 事件）。 */
export function sessionCwdOf(events) {
  for (const event of events) {
    if (typeof event?.cwd === 'string') return event.cwd
  }
  return undefined
}

/** 取 header 事件。 */
export function sessionHeaderOf(events) {
  for (const event of events) {
    if (typeOf(event) === 'session') return event
  }
  return undefined
}

/**
 * 把会话事件投影成结构化摘要。
 *
 * 刻意做成「宽进」：未知事件类型只记账不报错，保证换 DSH 版本时仍能给出可用信息。
 * @param {object[]} events 会话事件。
 * @param {{sections?: string[], limit?: number, stringLimit?: number}} [options] 投影选项。
 * @returns {object} 摘要。
 */
export function summarize(events, options = {}) {
  const sections = new Set(options.sections ?? ['preset', 'tools', 'contexts', 'tokens'])
  const limit = options.limit ?? 200
  const stringLimit = options.stringLimit ?? DEFAULT_STRING_LIMIT

  const byType = {}
  const tools = new Map()
  const callNames = new Map() // callId -> 工具名
  const contexts = new Map()
  const errors = []
  let tokens = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, samples: 0 }
  let turns = 0

  for (const event of events) {
    const type = typeOf(event)
    byType[type] = (byType[type] ?? 0) + 1

    if (type === 'tool/call') {
      const name = event?.data?.name ?? '(unnamed)'
      const callId = event?.data?.callId
      if (typeof callId === 'string') callNames.set(callId, name)
      const entry = tools.get(name) ?? { name, calls: 0, errors: 0 }
      entry.calls += 1
      tools.set(name, entry)
    } else if (type === 'tool/result') {
      // 真实的 tool/result 事件里没有工具名，只有 callId（`data.message.toolCallId`），
      // 所以用 tool/call 建的表反查归属；查不到就记到 `(unattributed)`。
      const message = event?.data?.message ?? {}
      const callId = message.toolCallId ?? event?.data?.toolCallId ?? event?.data?.callId
      const name = (typeof callId === 'string' ? callNames.get(callId) : undefined) ?? event?.data?.name ?? '(unattributed)'
      const entry = tools.get(name) ?? { name, calls: 0, errors: 0 }
      const isError = message.isError === true
      if (isError) entry.errors += 1
      tools.set(name, entry)
      if (isError) {
        errors.push({ seq: event.seq, tool: name, text: clip(message.content ?? [], stringLimit) })
      }
    } else if (type === 'turn/end') {
      turns += 1
    }

    // 上下文类事件：DSH 的注入以 system/developer 消息与 runtime-context 形式出现。
    if (/^(system|developer)\//.test(type) || /context/i.test(type)) {
      const entry = contexts.get(type) ?? { type, count: 0, sample: undefined }
      entry.count += 1
      if (entry.sample === undefined) {
        entry.sample = clip(event?.data?.message?.content ?? event?.data ?? event, stringLimit)
      }
      contexts.set(type, entry)
    }

    const usage = usageOf(event)
    if (usage !== undefined && typeof usage === 'object') {
      tokens.samples += 1
      tokens.uncachedInputTokens += Number(usage.inputTokens ?? usage.uncachedInputTokens ?? 0)
      tokens.cacheReadTokens += Number(usage.cacheReadTokens ?? usage.cache_read_input_tokens ?? 0)
      tokens.cacheWriteTokens += Number(usage.cacheWriteTokens ?? 0)
      tokens.outputTokens += Number(usage.outputTokens ?? 0)
    }
  }

  const header = sessionHeaderOf(events)
  const result = {
    sessionId: header?.id ?? undefined,
    agentPreset: header?.agentPreset ?? undefined,
    cwd: sessionCwdOf(events),
    createdAt: header?.createdAt ?? undefined,
    eventCount: events.length,
    byType,
    turns,
  }
  if (sections.has('preset')) {
    result.preset = {
      agentPreset: header?.agentPreset ?? undefined,
      version: header?.version ?? undefined,
      isSeeded: header?.isSeeded ?? undefined,
      delegationDepth: header?.delegationDepth ?? undefined,
    }
  }
  if (sections.has('tools')) {
    result.tools = [...tools.values()].sort((a, b) => b.calls - a.calls)
    result.toolCount = result.tools.length
  }
  if (sections.has('contexts')) {
    result.contexts = [...contexts.values()].sort((a, b) => b.count - a.count)
  }
  if (sections.has('tokens')) {
    result.tokens = { ...tokens, turns }
  }
  if (sections.has('errors')) result.errors = errors
  if (sections.has('raw')) {
    result.raw = events.slice(0, limit).map((event) => ({
      seq: event?.seq,
      type: typeOf(event),
      preview: clip(event?.data ?? event, 240),
    }))
  }
  return result
}

/**
 * 只读会话文件的基本信息（帧数、体积、事件数），用于诊断多帧解码是否正常。
 * @param {string} file 会话日志文件。
 * @returns {{bytes: number, mtime: string, frames: number, events: number, compressed: boolean}} 基本信息。
 */
export function describeSessionFile(file) {
  const stat = statSync(file)
  const buf = readFileSync(file)
  const compressed = file.endsWith('.zstd')
  const frames = compressed ? decodeZstdFrames(buf).length : 1
  const { events } = readSessionEvents(file)
  return {
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
    frames,
    events: events.length,
    compressed,
  }
}
