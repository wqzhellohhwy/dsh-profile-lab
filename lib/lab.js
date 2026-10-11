/**
 * dsh-profile-lab —— 实验台核心：清单、克隆、安装、清理、归档、指纹。
 *
 * 「临时 profile」的生命周期在这里闭环：
 *   create（模板建 / 从现有 profile 克隆）→ install → run → session → clean
 *
 * 三条硬规则：
 *   1. 只有清单里登记过的 profile 才可被写/删（`assertManageable`）；
 *   2. 删除必须**链接感知**——`node_modules` 里逐项 junction 出链接复用源包，
 *      直接递归删有删进源仓库的风险（历史事故），所以先解链接再删目录；
 *   3. 克隆出来的是**独立**目录（`node_modules` 逐项链接，而不是整目录链接），
 *      这样随后 `pnpm add` 只动新 profile，不会污染源 profile。
 *
 * @module dsh-profile-lab/lab
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, relative } from 'node:path'
import {
  LOG_FILENAME,
  MANIFEST_FILENAME,
  LOCK_FILENAME,
  assertManageable,
  assertProfileName,
  findSessionDir,
  isLink,
  listDirNames,
  profileDir,
  profileManifestPath,
  profilesDir,
  resolveHome,
  sessionsRoot,
  withLock,
} from './guards.js'
import { latestSessionIn, runDshOnce } from './runner.js'
import { readSessionEvents, summarize } from './sessions.js'

/** 清单格式版本。 */
export const MANIFEST_VERSION = 1

/** 官方 profile 根配置（空条目列表）。 */
export const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** 官方 profile 用户层模板。 */
export const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/** 官方 pnpm 工作区设置（out-of-tree 插件需要）。 */
export const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** 丢弃目录名（overwrite 时旧 profile 挪到这里，而不是直接删）。 */
const TRASH_DIRNAME = 'profile-lab-trash'

/** 清单路径。 */
export function manifestPath(home) {
  return join(resolveHome(home), MANIFEST_FILENAME)
}

/** 审计日志路径。 */
export function logPath(home) {
  return join(resolveHome(home), LOG_FILENAME)
}

/** 跨进程锁路径。 */
export function labLockPath(home) {
  return join(resolveHome(home), LOCK_FILENAME)
}

/**
 * 读清单（不存在返回空清单；损坏时抛错而不是静默重置——那会丢失「哪些 profile 归我管」的信息）。
 * @param {string} [home] DSH home。
 * @returns {{version: number, profiles: Record<string, object>}} 清单。
 */
export function loadManifest(home) {
  const file = manifestPath(home)
  if (!existsSync(file)) return { version: MANIFEST_VERSION, profiles: {} }
  const raw = readFileSync(file, 'utf8')
  try {
    const parsed = JSON.parse(raw)
    return { version: parsed.version ?? MANIFEST_VERSION, profiles: parsed.profiles ?? {} }
  } catch (error) {
    throw new Error(`清单文件损坏，拒绝继续（请人工检查或删除）：${file}\n${String(error)}`)
  }
}

/**
 * 原子写清单（临时文件 + rename）。
 * @param {object} manifest 清单。
 * @param {string} [home] DSH home。
 */
export function saveManifest(manifest, home) {
  const file = manifestPath(home)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomUUID()}`
  writeFileSync(tmp, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/**
 * 追加一条审计日志（一行 JSON）。
 * @param {object} entry 日志条目。
 * @param {string} [home] DSH home。
 */
export function appendLog(entry, home) {
  const file = logPath(home)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { flag: 'a', encoding: 'utf8' })
}

/**
 * 读一个 profile 的 package.json 关键字段。
 * @param {string} name profile 名。
 * @param {string} [home] DSH home。
 * @returns {{name?: string, dependencies: Record<string,string>, bundles: string[]}|undefined} 结果。
 */
export function readProfileMeta(name, home) {
  const file = profileManifestPath(name, home)
  if (!existsSync(file)) return undefined
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'))
    return {
      name: json.name,
      dependencies: json.dependencies ?? {},
      bundles: json.dsh?.profile?.bundles ?? [],
    }
  } catch {
    return undefined
  }
}

/**
 * 列出所有 profile，分成「本插件管的」与「未登记的」。
 * @param {string} [home] DSH home。
 * @returns {{managed: object[], unmanaged: object[]}} 列表。
 */
export function listProfiles(home) {
  const manifest = loadManifest(home)
  const root = profilesDir(home)
  const all = listDirNames(root).filter((name) => {
    const dir = join(root, name)
    try {
      return statSync(dir).isDirectory() && !name.startsWith('.')
    } catch {
      return false
    }
  })
  const managed = []
  const unmanaged = []
  for (const name of all) {
    const meta = readProfileMeta(name, home)
    const entry = manifest.profiles[name]
    const info = {
      name,
      dir: join(root, name),
      bundles: meta?.bundles ?? [],
      dependencyCount: Object.keys(meta?.dependencies ?? {}).length,
      nodeModulesLinked: isLink(join(root, name, 'node_modules')),
      sessionsRecorded: (entry?.sessions ?? []).length,
    }
    if (entry === undefined) unmanaged.push(info)
    else managed.push({ ...info, purpose: entry.purpose, createdAt: entry.createdAt, template: entry.template, clonedFrom: entry.clonedFrom })
  }
  return { managed, unmanaged }
}

/** 在 node_modules 里建一个目录链接（Windows 用 junction，免管理员权限）。 */
function linkDir(target, path) {
  try {
    symlinkSync(target, path, 'junction')
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return true
    return false
  }
}

/**
 * 逐项把源 `node_modules` 链接到目标 `node_modules`。
 *
 * 逐项（而不是整目录一个链接）是刻意的：随后 `pnpm add` 只会改写新 profile 里
 * 的这些链接，源 profile 一个字节都不动。`@scope` 目录展开一层，避免 pnpm
 * 想往共享的 scope 目录里写新包。
 * @param {string} srcDir 源 node_modules。
 * @param {string} dstDir 目标 node_modules。
 * @returns {{linked: number, failed: string[]}} 统计。
 */
export function linkNodeModules(srcDir, dstDir) {
  const failed = []
  let linked = 0
  if (!existsSync(srcDir)) return { linked, failed }
  mkdirSync(dstDir, { recursive: true })
  for (const entry of readdirSync(srcDir)) {
    const src = join(srcDir, entry)
    const dst = join(dstDir, entry)
    const isScopeDir = entry.startsWith('@') && !isLink(src) && statSync(src).isDirectory()
    if (isScopeDir) {
      mkdirSync(dst, { recursive: true })
      for (const sub of readdirSync(src)) {
        if (linkDir(join(src, sub), join(dst, sub))) linked += 1
        else failed.push(`${entry}/${sub}`)
      }
    } else if (linkDir(src, dst)) {
      linked += 1
    } else {
      failed.push(entry)
    }
  }
  return { linked, failed }
}

/**
 * 从现有 profile 克隆出一个独立目录。
 * @param {string} source 源 profile 名。
 * @param {string} target 目标 profile 名。
 * @param {string} [home] DSH home。
 * @returns {{linked: number, failed: string[], bundles: string[], dependencies: Record<string,string>}} 克隆结果。
 */
export function cloneProfile(source, target, home) {
  const srcDir = profileDir(source, home)
  const dstDir = profileDir(target, home)
  if (!existsSync(join(srcDir, 'package.json'))) throw new Error(`源 profile ${JSON.stringify(source)} 还没有 package.json，无法克隆`)
  const srcJson = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8'))
  const next = { ...srcJson, name: `dsh-profile-${target}` }
  mkdirSync(dstDir, { recursive: true })
  writeFileSync(join(dstDir, 'package.json'), `${JSON.stringify(next, undefined, 2)}\n`, 'utf8')

  const copyOrTemplate = (filename, template) => {
    const src = join(srcDir, filename)
    writeFileSync(join(dstDir, filename), existsSync(src) ? readFileSync(src, 'utf8') : template, 'utf8')
  }
  copyOrTemplate('cordis.patch.yml', PROFILE_PATCH_TEMPLATE)
  copyOrTemplate('pnpm-workspace.yaml', PROFILE_PNPM_WORKSPACE)
  writeFileSync(join(dstDir, 'cordis.yml'), PROFILE_ROOT_CONFIG, 'utf8')

  const { linked, failed } = linkNodeModules(join(srcDir, 'node_modules'), join(dstDir, 'node_modules'))
  return {
    linked,
    failed,
    bundles: next.dsh?.profile?.bundles ?? [],
    dependencies: next.dependencies ?? {},
  }
}

/**
 * 创建一个临时 profile。
 * @param {object} options 参数。
 * @param {string} options.name 名字。
 * @param {string} [options.template] 内置模板（默认 headless）。
 * @param {string} [options.clone] 源 profile 名（给了它就忽略 template）。
 * @param {string[]} [options.packages] 建好后立刻安装的包。
 * @param {string} [options.purpose] 用途说明。
 * @param {object} options.dsh dsh 运行器（见 runner.resolveDshRunner）。
 * @param {string} [options.home] DSH home。
 * @param {boolean} [options.overwrite] 允许覆盖同名（仅限已登记的）。
 * @returns {Promise<object>} 结果。
 */
export async function createTempProfile(options) {
  const home = resolveHome(options.home)
  const name = assertProfileName(options.name)
  const template = options.template ?? 'headless'
  const dir = profileDir(name, home)
  return withLock(labLockPath(home), async () => {
    const manifest = loadManifest(home)
    if (existsSync(dir)) {
      if (manifest.profiles[name] === undefined) {
        throw new Error(`profile 目录已存在且不在本插件清单里，拒绝覆盖：${dir}`)
      }
      if (options.overwrite !== true) {
        throw new Error(`profile ${JSON.stringify(name)} 已存在（请传 overwrite: true 覆盖，或换名字）`)
      }
      const trash = join(resolveHome(home), TRASH_DIRNAME, `${name}-${Date.now()}`)
      mkdirSync(dirname(trash), { recursive: true })
      renameSync(dir, trash)
    }

    let cloned
    if (typeof options.clone === 'string' && options.clone !== '') {
      cloned = cloneProfile(options.clone, name, home)
    } else {
      const result = await runDshOnce(
        options.dsh,
        [name, '--from-default-profile', template, '--dump-config'],
        { home, cwd: resolveHome(home), timeoutMs: 180_000 },
      )
      if (!result.ok) {
        throw new Error(`初始化 profile 失败（exit ${result.exitCode}）：${result.stderr.trim().slice(0, 800)}`)
      }
    }
    if (!existsSync(join(dir, 'package.json'))) throw new Error(`profile 初始化后仍找不到 package.json：${dir}`)

    // 先登记再装包：这样即使随后的安装失败，这个临时 profile 也在清单里，
    // 能被 tmpprofile_clean 回收（失败留痕好过留下无法管理的垃圾目录）。
    const initialMeta = readProfileMeta(name, home)
    manifest.profiles[name] = {
      createdAt: new Date().toISOString(),
      purpose: options.purpose ?? '',
      template: cloned === undefined ? template : undefined,
      clonedFrom: cloned === undefined ? undefined : options.clone,
      withJunction: cloned !== undefined,
      bundles: initialMeta?.bundles ?? [],
      sessions: [],
      status: 'creating',
    }
    saveManifest(manifest, home)
    appendLog({ action: 'create', name, template: cloned === undefined ? template : undefined, clone: cloned === undefined ? undefined : options.clone, linked: cloned?.linked, failedLinks: cloned?.failed }, home)

    let installResult
    if (Array.isArray(options.packages) && options.packages.length > 0) {
      installResult = await installIntoProfile({ name, packages: options.packages, dsh: options.dsh, home })
    }

    const finalManifest = loadManifest(home)
    const meta = readProfileMeta(name, home)
    finalManifest.profiles[name] = {
      ...finalManifest.profiles[name],
      bundles: meta?.bundles ?? [],
      status: installResult === undefined || installResult.ok ? 'ready' : 'install-failed',
      updatedAt: new Date().toISOString(),
    }
    saveManifest(finalManifest, home)
    return {
      ok: true,
      name,
      dir,
      template: cloned === undefined ? template : undefined,
      clonedFrom: cloned === undefined ? undefined : options.clone,
      withJunction: cloned !== undefined,
      linkedPackages: cloned?.linked,
      failedLinks: cloned?.failed ?? [],
      bundles: meta?.bundles ?? [],
      dependencies: meta?.dependencies ?? {},
      install: installResult,
    }
  })
}

/**
 * 往已登记的临时 profile 里装包（`dsh plugin --profile <n> add ...`）。
 *
 * 带 `dsh.bundle` 的包会被 dsh 自动写进 `dsh.profile.bundles`（官方 reconcile 行为），
 * 返回值里给出装前/装后差异。
 * @param {{name: string, packages: string[], dsh: object, home?: string, timeoutMs?: number}} options 参数。
 * @returns {Promise<object>} 结果。
 */
export async function installIntoProfile(options) {
  const home = resolveHome(options.home)
  const name = assertProfileName(options.name)
  const manifest = loadManifest(home)
  assertManageable(name, manifest)
  const before = readProfileMeta(name, home)
  const result = await runDshOnce(
    options.dsh,
    ['plugin', '--profile', name, 'add', ...options.packages],
    { home, cwd: profileDir(name, home), timeoutMs: options.timeoutMs ?? 300_000 },
  )
  const after = readProfileMeta(name, home)
  const addedBundles = (after?.bundles ?? []).filter((bundle) => !(before?.bundles ?? []).includes(bundle))
  if (result.ok) {
    manifest.profiles[name] = {
      ...manifest.profiles[name],
      bundles: after?.bundles ?? [],
      updatedAt: new Date().toISOString(),
    }
    saveManifest(manifest, home)
    appendLog({ action: 'install', name, packages: options.packages, addedBundles }, home)
  }
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    packages: options.packages,
    addedBundles,
    bundles: after?.bundles ?? [],
    dependencies: after?.dependencies ?? {},
    stdoutTail: result.stdout.trim().slice(-1200),
    stderrTail: result.stderr.trim().slice(-1200),
  }
}

/** 删掉一个链接（junction 用 rmdir，符号链接用 unlink）。 */
function removeLink(path) {
  try {
    unlinkSync(path)
    return true
  } catch {
    try {
      rmdirSync(path)
      return true
    } catch {
      return false
    }
  }
}

/**
 * 解掉 profile 的 `node_modules` 里所有链接，然后删掉整个目录。
 *
 * 关键：**绝不**跟随链接递归删除——那会删进源仓库。
 * @param {string} dir profile 目录。
 * @returns {{unlinked: number, failed: string[]}} 统计。
 */
export function removeProfileTree(dir) {
  const failed = []
  let unlinked = 0
  const nodeModules = join(dir, 'node_modules')
  if (existsSync(nodeModules) && !isLink(nodeModules)) {
    for (const entry of listDirNames(nodeModules)) {
      const entryPath = join(nodeModules, entry)
      let isScope = false
      try {
        isScope = entry.startsWith('@') && !isLink(entryPath) && statSync(entryPath).isDirectory()
      } catch {
        isScope = false
      }
      const paths = isScope ? listDirNames(entryPath).map((sub) => join(entryPath, sub)) : [entryPath]
      for (const path of paths) {
        if (!isLink(path)) continue
        if (removeLink(path)) unlinked += 1
        else failed.push(path)
      }
    }
  } else if (isLink(nodeModules)) {
    if (removeLink(nodeModules)) unlinked += 1
  }
  rmSync(dir, { recursive: true, force: true })
  return { unlinked, failed }
}

/**
 * 清理临时 profile（默认先 dry-run，必须 `confirm: true` 才真删）。
 * @param {object} options 参数。
 * @param {string[]} options.names 要清理的名字。
 * @param {boolean} [options.confirm] 是否真删。
 * @param {boolean} [options.sessions] 是否连同登记的探针会话目录一起删（默认 true）。
 * @param {string} [options.archiveTo] 删除前把配置归档到该目录。
 * @param {string} [options.home] DSH home。
 * @returns {Promise<object>} 结果。
 */
export async function cleanTempProfiles(options) {
  const home = resolveHome(options.home)
  const names = (options.names ?? []).map((name) => assertProfileName(name))
  const withSessions = options.sessions ?? true
  return withLock(labLockPath(home), async () => {
    const manifest = loadManifest(home)
    const plan = []
    for (const name of names) {
      assertManageable(name, manifest)
      const dir = profileDir(name, home)
      const entry = manifest.profiles[name]
      plan.push({
        name,
        dir,
        exists: existsSync(dir),
        sessions: entry.sessions ?? [],
        purpose: entry.purpose ?? '',
      })
    }
    if (options.confirm !== true) {
      return { ok: true, dryRun: true, plan, message: '未执行删除；确认后传 confirm: true' }
    }

    const removed = []
    const residue = []
    const sessionsRemoved = []
    let archivedTo
    for (const item of plan) {
      if (typeof options.archiveTo === 'string' && options.archiveTo !== '') {
        const destination = join(options.archiveTo, item.name)
        mkdirSync(destination, { recursive: true })
        if (item.exists) {
          for (const entry of listDirNames(item.dir)) {
            if (entry === 'node_modules') continue
            const src = join(item.dir, entry)
            if (isLink(src) || statSync(src).isDirectory()) continue
            writeFileSync(join(destination, entry), readFileSync(src))
          }
        }
        writeFileSync(
          join(destination, 'ARCHIVE-NOTE.md'),
          `# 归档：${item.name}\n\n- 归档时间：${new Date().toISOString()}\n- 用途：${item.purpose || '(未填写)'}\n- 来源：${manifest.profiles[item.name]?.clonedFrom ?? manifest.profiles[item.name]?.template ?? '(未知)'}\n- 会话：${(item.sessions ?? []).map((s) => s.id).join(', ') || '(无)'}\n\n> 只归档了 profile 的配置文件（node_modules 是链接，未归档）。\n`,
          'utf8',
        )
        archivedTo = options.archiveTo
      }
      if (item.exists) {
        const { failed } = removeProfileTree(item.dir)
        for (const path of failed) residue.push(`链接未删除：${path}`)
      }
      if (withSessions) {
        for (const session of item.sessions ?? []) {
          const sessionRoot = session.cwd === undefined ? undefined : findSessionDir(session.cwd, home)
          const sessionDir = session.dir ?? (sessionRoot === undefined ? undefined : join(sessionRoot, session.id))
          if (sessionDir === undefined || !existsSync(sessionDir)) continue
          rmSync(sessionDir, { recursive: true, force: true })
          sessionsRemoved.push(session.id)
        }
      }
      if (existsSync(item.dir)) residue.push(`目录仍存在：${item.dir}`)
      delete manifest.profiles[item.name]
      removed.push(item.name)
    }

    // 清理空掉的会话目录壳（只在确实空的时候）
    for (const session of plan.flatMap((item) => item.sessions ?? [])) {
      if (session.cwd === undefined) continue
      const dir = findSessionDir(session.cwd, home)
      if (dir !== undefined && listDirNames(dir).length === 0) {
        try {
          rmdirSync(dir)
        } catch {
          /* 非空或占用，留着 */
        }
      }
    }

    saveManifest(manifest, home)
    appendLog({ action: 'clean', names: removed, sessionsRemoved, archivedTo, residue }, home)
    return {
      ok: residue.length === 0,
      dryRun: false,
      removed,
      sessionsRemoved,
      archivedTo,
      residue,
      profilesLeft: listProfiles(home),
    }
  })
}

/**
 * 采集 `profiles/` 的指纹（顶层文件 hash + 目录 mtime，不递归 node_modules）。
 *
 * 用途：集成测试断言「一次临时 profile 操作**不触碰任何其他 profile**」。
 * @param {string} [home] DSH home。
 * @returns {Record<string, {size: number, mtime: string, sha256: string}>} 指纹表。
 */
export function fingerprintProfiles(home) {
  const root = profilesDir(home)
  const out = {}
  const record = (path, kind) => {
    try {
      const stat = statSync(path)
      out[relative(root, path)] = {
        size: kind === 'file' ? stat.size : -1,
        mtime: stat.mtime.toISOString(),
        sha256: kind === 'file' ? createHash('sha256').update(readFileSync(path)).digest('hex') : '',
      }
    } catch {
      /* 读不到就跳过 */
    }
  }
  for (const name of listDirNames(root)) {
    const dir = join(root, name)
    record(dir, 'dir')
    for (const entry of listDirNames(dir)) {
      const path = join(dir, entry)
      if (entry === 'node_modules') {
        record(path, 'dir')
        continue
      }
      let isDir = false
      try {
        isDir = statSync(path).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        record(path, 'dir')
        for (const sub of listDirNames(path)) {
          const subPath = join(path, sub)
          let subIsDir = false
          try {
            subIsDir = statSync(subPath).isDirectory()
          } catch {
            continue
          }
          record(subPath, subIsDir ? 'dir' : 'file')
        }
      } else {
        record(path, 'file')
      }
    }
  }
  return out
}

/**
 * 按 session id 在全库定位会话日志文件。
 * @param {string} sessionId 会话 id。
 * @param {string} [home] DSH home。
 * @returns {string|undefined} 文件路径。
 */
export function findSessionFileById(sessionId, home) {
  const root = sessionsRoot(home)
  for (const dir of listDirNames(root)) {
    const file = join(root, dir, sessionId, 'session.v4.jsonl.zstd')
    if (existsSync(file)) return file
    const plain = join(root, dir, sessionId, 'session.v4.jsonl')
    if (existsSync(plain)) return plain
  }
  return undefined
}

/**
 * 读一个会话并给结构化摘要。
 * @param {object} options 参数。
 * @param {string} options.sessionId 会话 id。
 * @param {string[]} [options.sections] 需要的分区。
 * @param {number} [options.limit] raw 分区条数上限。
 * @param {string} [options.home] DSH home。
 * @returns {object} 摘要（含 file / frames / events）。
 */
export function inspectSession(options) {
  const file = findSessionFileById(options.sessionId, resolveHome(options.home))
  if (file === undefined) throw new Error(`找不到会话 ${JSON.stringify(options.sessionId)} 的日志文件`)
  const { events, frames, bytes } = readSessionEvents(file)
  const summary = summarize(events, { sections: options.sections, limit: options.limit })
  return { file, frames, bytes, ...summary }
}

/**
 * 把一个 profile 名登记进清单（供外部在别处建好 profile 后纳管）。
 * @param {{name: string, purpose?: string, home?: string}} options 参数。
 * @returns {object} 清单条目。
 */
export function adoptProfile(options) {
  const home = resolveHome(options.home)
  const name = assertProfileName(options.name)
  if (!existsSync(join(profileDir(name, home), 'package.json'))) {
    throw new Error(`profile ${JSON.stringify(name)} 不存在或没有 package.json，无法纳管`)
  }
  const manifest = loadManifest(home)
  const meta = readProfileMeta(name, home)
  manifest.profiles[name] = {
    ...(manifest.profiles[name] ?? {}),
    createdAt: manifest.profiles[name]?.createdAt ?? new Date().toISOString(),
    purpose: options.purpose ?? manifest.profiles[name]?.purpose ?? '',
    adopted: true,
    bundles: meta?.bundles ?? [],
    sessions: manifest.profiles[name]?.sessions ?? [],
  }
  saveManifest(manifest, home)
  return manifest.profiles[name]
}

/** 记录一次探针会话归属（供 clean 时回收）。 */
export function recordSession(name, session, home) {
  const manifest = loadManifest(home)
  if (manifest.profiles[name] === undefined) return
  const sessions = manifest.profiles[name].sessions ?? []
  if (!sessions.some((item) => item.id === session.id)) sessions.push(session)
  manifest.profiles[name] = { ...manifest.profiles[name], sessions, updatedAt: new Date().toISOString() }
  saveManifest(manifest, home)
}

/** 工具目录名（备查）。 */
export function describeDir(name, home) {
  return { name: basename(profileDir(name, home)), dir: profileDir(name, home) }
}

export { latestSessionIn }
