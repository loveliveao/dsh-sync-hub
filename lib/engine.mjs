/**
 * 同步引擎：扫描本机 → 与远端 manifest 三方比较（本机 / 远端 / 上次基线）→
 * 生成计划 → 执行（推送缺失 blob、拉取变更、写入前备份）。
 *
 * 不做「删除传播」：任何一端删了文件，都不会把另一端也删掉。宁可留一份多余
 * 的配置，也不要在多机之间连锁删数据。
 */
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  collectAll,
  isAdvisory,
  mergeRedacted,
  sectionDef,
  settingsSections,
} from './sections.mjs'
import { assertSyncableRel, isForbiddenRel, redactText } from './privacy.mjs'
import { secretsEnabled } from './state.mjs'
import { backupsRoot, resolveInsideHome, toHomeRel } from './paths.mjs'
import { deviceRecord, manifestEntry, manifestStats, normalizeManifest } from './manifest.mjs'
import { versionLabel } from './version.mjs'
import { atomicWrite, ensureDir, formatBytes, pathExists, readJson, sha256 } from './util.mjs'
import {
  analyzeSessionFile,
  materializeBlob,
  physicalRel,
  removeSessionCopies,
} from './session-canon.mjs'
import { resolveLocalCwd } from './workspaces.mjs'

const MAX_LIST = 400

function trimEntry(entry) {
  return {
    id: entry.id,
    section: entry.section,
    rel: entry.rel,
    bytes: entry.bytes,
    sha: entry.sha,
    mtimeMs: entry.mtimeMs,
  }
}

/**
 * 拉取用的条目：保留 meta。
 * 会话要靠 meta 里的 cwd / workspaceKey / workspaceSub 才知道该落到本机哪个目录，
 * 所以这里不能像 trimEntry 那样把 meta 丢掉。
 */
function pullEntry(entry) {
  const trimmed = trimEntry(entry)
  if (entry && entry.meta && entry.meta.kind === 'session') {
    trimmed.meta = entry.meta
  }
  return trimmed
}

export async function scan(state) {
  const { entries, errors } = await collectAll(state.settings)
  const byId = new Map()
  for (const entry of entries) byId.set(entry.id, entry)
  return { entries, byId, errors }
}

function decide(localEntry, remoteEntry, baseSha) {
  if (localEntry && remoteEntry) {
    if (localEntry.sha === remoteEntry.sha) return 'same'
    if (baseSha && baseSha === localEntry.sha && baseSha !== remoteEntry.sha) return 'pull'
    if (baseSha && baseSha === remoteEntry.sha && baseSha !== localEntry.sha) return 'push'
    return 'conflict'
  }
  if (localEntry && !remoteEntry) return 'push'
  if (!localEntry && remoteEntry) {
    if (baseSha && baseSha === remoteEntry.sha) return 'deleted-locally'
    return 'pull'
  }
  return 'same'
}

function resolveConflict(localEntry, remoteEntry, policy) {
  if (policy === 'local') return 'push'
  if (policy === 'remote') return 'pull'
  if (policy === 'skip') return 'skip'
  // newest：按文件 mtime 比新旧；远端没有 mtime 时按字节数兜底（保守：拉取）
  const localTime = Number(localEntry.mtimeMs) || 0
  const remoteTime = Number(remoteEntry.mtimeMs) || 0
  if (localTime && remoteTime && localTime !== remoteTime) {
    return localTime > remoteTime ? 'push' : 'pull'
  }
  return remoteEntry.bytes >= localEntry.bytes ? 'pull' : 'push'
}

export async function buildPlan({ state, transport, version, persist = true }) {
  const { byId: localById, errors } = await scan(state)
  await transport.open()
  const remoteManifest = normalizeManifest(await transport.readManifest())
  const base = state.base || {}
  const ignore = state.ignoreAfterPull || {}
  const policy = state.settings.conflictPolicy
  const sections = settingsSections(state.settings)

  // 安全闸门：开了「凭据与密钥」又用公开仓库，同步会被直接拦住。
  // 放在计划里算，好让用户在点同步之前就能看到原因。
  let guard = { ok: true, message: '' }
  if (typeof transport.guardSecrets === 'function') {
    try {
      const g = await transport.guardSecrets(state.settings)
      if (g && g.ok === false) guard = { ok: false, message: String(g.message || '') }
    } catch (err) {
      guard = { ok: true, message: '' }
    }
  }

  const push = []
  const pull = []
  const conflicts = []
  const skipped = []

  const ids = new Set([...localById.keys(), ...Object.keys(remoteManifest.entries)])
  for (const id of ids) {
    const localEntry = localById.get(id)
    const remoteEntry = remoteManifest.entries[id]
    const section = (localEntry && localEntry.section) || (remoteEntry && remoteEntry.section) || String(id).split(':')[0]
    if (!sections[section] && section !== 'custom') continue
    const baseSha = base[id]

    // 拉取后仍无法对齐的条目（远端有 <redacted> 而本机没有这个键）先挂起，
    // 等本机内容真的变化了再重新参与比较，避免每次同步都反复拉取。
    const ignored = ignore[id]
    if (ignored && localEntry && remoteEntry && ignored.localSha === localEntry.sha && ignored.remoteSha === remoteEntry.sha) {
      skipped.push({ ...trimEntry(localEntry), reason: 'redacted-unresolved' })
      continue
    }

    let action = decide(localEntry, remoteEntry, baseSha)
    if (action === 'conflict') {
      const resolved = resolveConflict(localEntry, remoteEntry, policy)
      conflicts.push({
        id,
        section,
        rel: (localEntry || remoteEntry).rel,
        localSha: localEntry ? localEntry.sha : null,
        remoteSha: remoteEntry ? remoteEntry.sha : null,
        localMtime: localEntry ? localEntry.mtimeMs : 0,
        remoteMtime: remoteEntry ? remoteEntry.mtimeMs : 0,
        resolution: resolved,
      })
      action = resolved
    }

    if (action === 'same' || action === 'skip') continue
    if (action === 'deleted-locally') {
      skipped.push({ ...trimEntry(remoteEntry), reason: '本地已删除（不自动恢复）' })
      continue
    }
    if (action === 'push' && localEntry) {
      // 私钥类文件永远不进同步集合（开关也救不了）；凭据类只有开了
      // 「凭据与密钥」才允许推送。
      if (isForbiddenRel(localEntry.rel, { allowSecrets: secretsEnabled(state.settings) })) {
        skipped.push({ ...trimEntry(localEntry), reason: '隐私边界拒绝（凭据类需开启「凭据与密钥」；私钥类永不导出）' })
        continue
      }
      if (isAdvisory(section) && !remoteEntry) {
        push.push({ ...trimEntry(localEntry), advisory: true })
      } else {
        push.push(trimEntry(localEntry))
      }
      continue
    }
    if (action === 'pull' && remoteEntry) {
      if (isAdvisory(section)) {
        skipped.push({ ...trimEntry(remoteEntry), reason: '只读上报，不自动写入' })
        continue
      }
      pull.push(pullEntry(remoteEntry))
    }
  }

  const plan = {
    createdAt: new Date().toISOString(),
    transport: transport.kind,
    target: transport.describe(),
    device: { id: state.device.id, name: state.device.name },
    version: version || null,
    localEntries: localById.size,
    remoteEntries: Object.keys(remoteManifest.entries).length,
    push: push.slice(0, MAX_LIST),
    pull: pull.slice(0, MAX_LIST),
    conflicts: conflicts.slice(0, MAX_LIST),
    skipped: skipped.slice(0, MAX_LIST),
    errors,
    guard,
    totals: {
      push: push.length,
      pull: pull.length,
      conflicts: conflicts.length,
      skipped: skipped.length,
      pushBytes: push.reduce((sum, item) => sum + (item.bytes || 0), 0),
      pullBytes: pull.reduce((sum, item) => sum + (item.bytes || 0), 0),
    },
    manifest: manifestStats(remoteManifest),
  }
  if (persist) {
    state.lastPlan = {
      ...plan,
      push: plan.push.slice(0, 50),
      pull: plan.pull.slice(0, 50),
      conflicts: plan.conflicts.slice(0, 50),
      skipped: plan.skipped.slice(0, 50),
    }
  }
  return { plan, localById, remoteManifest, push, pull, conflicts }
}

/* ------------------------------------------------------------------ */
/* 备份                                                                */
/* ------------------------------------------------------------------ */

function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function pruneBackups(keep) {
  const root = backupsRoot()
  const items = await readdir(root, { withFileTypes: true }).catch(() => [])
  const dirs = items.filter((item) => item.isDirectory()).map((item) => item.name).sort()
  const excess = dirs.slice(0, Math.max(0, dirs.length - keep))
  for (const name of excess) {
    await rm(join(root, name), { recursive: true, force: true }).catch(() => {})
  }
}

async function backupFile(abs, rel, keep) {
  const st = await stat(abs).catch(() => null)
  if (!st || !st.isFile()) return null
  const folder = join(backupsRoot(), backupStamp())
  const target = join(folder, ...rel.split('/'))
  await ensureDir(join(folder, ...rel.split('/').slice(0, -1)))
  const buf = await readFile(abs)
  await atomicWrite(target, buf)
  await pruneBackups(keep)
  return toHomeRel(target)
}

/* ------------------------------------------------------------------ */
/* 写入一个条目                                                        */
/* ------------------------------------------------------------------ */

/**
 * 写回一个条目。
 *
 * 会话（meta.kind === 'session'）走单独一条路：
 *  - 清单里的 rel 是与机器无关的 `sessions/<sessionId>/...`，落盘位置要另算；
 *  - 落盘位置必须落在 DSH 期望的 `sessions/<projectKey(cwd)>/<sessionId>/` 下，
 *    否则 DSH 会判「corrupt session log」（磁盘路径由 header 的 cwd 派生）；
 *  - 跨机时 header 里的 cwd 要换成本机目录，否则两台机器永远对不上；
 *  - 同一个 session id 不能同时存在于两个 project 目录，写之前要把旧副本挪掉。
 */
async function writeEntry({ entry, blob, state, notes }) {
  // 开了「同步凭据与密钥」才放行凭据类文件；私钥类永远拒绝。
  const allowSecrets = secretsEnabled(state.settings)
  assertSyncableRel(entry.rel, { allowSecrets })
  if (isForbiddenRel(entry.rel, { allowSecrets })) throw new Error(`隐私边界拒绝了 ${entry.rel}`)
  if (entry.meta && entry.meta.kind === 'session') {
    return writeSessionEntry({ entry, blob, state, notes, allowSecrets })
  }
  const abs = resolveInsideHome(entry.rel)
  const def = sectionDef(entry.section)
  // 条目自己的 kind 优先：开了密钥同步后 cordis 段不再脱敏（kind='files'），
  // 不能再走 mergeRedacted。
  const kind = (entry.meta && entry.meta.kind) || (def && def.kind) || 'files'
  const existing = await readFile(abs).catch(() => null)
  const incomingSha = sha256(blob)
  if (existing && sha256(existing) === incomingSha) {
    return { written: false, same: true, abs }
  }
  const backup = existing ? await backupFile(abs, entry.rel, state.settings.keepBackups) : null

  let finalBuf = blob
  let mergeInfo = null
  if (kind === 'redacted' && existing) {
    const merged = mergeRedacted(existing.toString('utf8'), blob.toString('utf8'))
    finalBuf = Buffer.from(merged.text, 'utf8')
    mergeInfo = merged
    if (merged.dropped > 0) {
      notes.push(`${entry.rel}：远端有 ${merged.dropped} 个脱敏键本机不存在，已跳过这些行`)
    }
  }
  await ensureDir(join(abs, '..'))
  await atomicWrite(abs, finalBuf)

  // 规范形态（脱敏后）的 sha 才是「同步完成」的基线。
  let canonicalSha = sha256(finalBuf)
  if (kind === 'redacted') {
    canonicalSha = sha256(Buffer.from(redactText(finalBuf.toString('utf8')).text, 'utf8'))
  }
  return { written: true, same: false, abs, backup, canonicalSha, mergeInfo }
}

/* ------------------------------------------------------------------ */
/* 会话专用写回                                                        */
/* ------------------------------------------------------------------ */

/**
 * 把远端会话落到本机。
 *
 * 步骤：
 *  1. 按工作区映射算出本机该落在哪个目录（手动映射 → 本机同名工作区 → 远端原路径）；
 *  2. 把 blob 里 header 的 cwd 换成本机目录（blob 里可能是占位符，也可能是远端原路径）；
 *  3. 落到本机 `sessions/<projectKey(本机 cwd)>/<sessionId>/` 下；
 *  4. 清掉同 id 的其它副本（DSH 不允许一个 id 出现在多个 project 目录）。
 */
async function writeSessionEntry({ entry, blob, state, notes, allowSecrets }) {
  const meta = entry.meta || {}
  const sessionId = meta.sessionId || String(entry.id || '').split(':')[1] || ''
  if (!sessionId) throw new Error('会话条目缺少 sessionId')

  const local = await resolveLocalCwd({
    key: meta.workspaceKey || '',
    sub: meta.workspaceSub || '',
    cwd: meta.cwd || '',
    settings: state.settings,
  })
  const localCwd = local.cwd
  if (!localCwd) throw new Error(`无法确定工作区「${meta.workspaceKey || sessionId}」在本机的目录`)

  // blob 里存的可能是占位符形态（我们推送时写的就是这个），
  // 也可能是远端机器的真实路径（老版本推的）—— 两种都能处理。
  const materialized = materializeBlob(blob, localCwd, { compressed: true })
  if (!materialized.ok) throw new Error(`会话 ${sessionId} 内容无法解析`)

  const rel = physicalRel(localCwd, sessionId)
  assertSyncableRel(rel, { allowSecrets })
  if (isForbiddenRel(rel, { allowSecrets })) throw new Error(`隐私边界拒绝了 ${rel}`)
  const abs = resolveInsideHome(rel)

  // 判断「本机是不是已经是这个会话」要比较逻辑 sha，而不是文件字节 ——
  // 压缩参数稍有差异，字节就不同，但内容其实一样。
  const existingStat = await stat(abs).catch(() => null)
  if (existingStat && existingStat.isFile()) {
    const existing = await analyzeSessionFile(abs, existingStat.size, existingStat.mtimeMs)
    if (existing.ok && existing.logicalSha === materialized.logicalSha) {
      return { written: false, same: true, abs }
    }
  }
  const backup = existingStat ? await backupFile(abs, rel, state.settings.keepBackups) : null

  // 同 id 的旧副本必须清掉，否则 DSH 启动时报「duplicate JSONL session id」。
  const removed = await removeSessionCopies(sessionId, dirname(abs))
  for (const dir of removed) {
    notes.push(`会话 ${sessionId}：已移除旧副本 ${dir}（跨机目录不同，本机落在 ${localCwd}）`)
  }

  await ensureDir(dirname(abs))
  await atomicWrite(abs, materialized.blob)
  return { written: true, same: false, abs, backup, canonicalSha: materialized.logicalSha }
}

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

export async function runSync({ state, transport, version }) {
  const started = Date.now()

  const built = await buildPlan({ state, transport, version, persist: false })

  // 安全闸门：开了「凭据与密钥」又用公开仓库，会把明文 key 推给所有人。
  // 由通道自己判断（Git 看仓库可见性，其余通道直接放行）。
  if (built.plan.guard && built.plan.guard.ok === false) {
    return {
      ok: false,
      pushed: [],
      pulled: [],
      conflicts: [],
      failures: [{ id: '*', rel: '*', message: built.plan.guard.message || '同步被安全策略阻止' }],
      notes: [],
      lastSync: state.lastSync || null,
      manifest: { schema: 1, entries: {}, devices: {} },
      blocked: true,
    }
  }

  const notes = []
  const pushDone = []
  const pullDone = []
  const failures = []
  const manifest = built.remoteManifest
  const deviceId = state.device.id
  const deviceName = state.device.name
  const ignore = { ...(state.ignoreAfterPull || {}) }

  for (const entry of built.push) {
    try {
      const local = built.localById.get(entry.id)
      if (!local) continue
      const exists = await transport.hasBlob(entry.sha)
      if (!exists) await transport.putBlob(entry.sha, local.blob)
      manifest.entries[entry.id] = manifestEntry(local, { deviceId, deviceName })
      state.base[entry.id] = entry.sha
      pushDone.push(trimEntry(entry))
    } catch (err) {
      failures.push({ id: entry.id, rel: entry.rel, message: String((err && err.message) || err) })
    }
  }

  for (const entry of built.pull) {
    try {
      const blob = await transport.getBlob(entry.sha)
      if (!blob) throw new Error('远端缺少该文件内容（manifest 与 blobs 不一致）')
      const result = await writeEntry({ entry, blob, state, notes })
      state.base[entry.id] = result.canonicalSha || entry.sha
      if (result.canonicalSha && result.canonicalSha !== entry.sha) {
        ignore[entry.id] = { localSha: result.canonicalSha, remoteSha: entry.sha }
      } else {
        delete ignore[entry.id]
      }
      pullDone.push({ ...trimEntry(entry), backup: result.backup || null, written: result.written })
    } catch (err) {
      failures.push({ id: entry.id, rel: entry.rel, message: String((err && err.message) || err) })
    }
  }

  // 冲突里被判定为「保留本机」的条目不计入 push，但要更新基线，避免每次都报同样的冲突。
  for (const conflict of built.conflicts) {
    if (conflict.resolution === 'push' && built.localById.has(conflict.id)) {
      state.base[conflict.id] = built.localById.get(conflict.id).sha
    } else if (conflict.resolution === 'pull') {
      state.base[conflict.id] = conflict.remoteSha
    }
  }

  const entryCount = Object.keys(manifest.entries).length
  manifest.devices[deviceId] = deviceRecord({
    deviceId,
    deviceName,
    version: versionLabel(version),
    sections: Object.entries(settingsSections(state.settings)).filter(([, on]) => on).map(([id]) => id),
  })
  manifest.updatedAt = new Date().toISOString()
  if (pushDone.length || pullDone.length || !entryCount) {
    await transport.writeManifest(manifest)
  }
  await transport.flush()

  state.ignoreAfterPull = ignore
  state.lastSync = {
    at: new Date().toISOString(),
    transport: transport.kind,
    target: transport.describe(),
    pushed: pushDone.length,
    pulled: pullDone.length,
    conflicts: built.conflicts.length,
    failures: failures.length,
    bytes: pushDone.reduce((sum, item) => sum + (item.bytes || 0), 0) + pullDone.reduce((sum, item) => sum + (item.bytes || 0), 0),
    durationMs: Date.now() - started,
  }
  state.lastPlan = {
    ...built.plan,
    push: pushDone.slice(0, 50),
    pull: pullDone.slice(0, 50),
  }

  return {
    ok: failures.length === 0,
    pushed: pushDone,
    pulled: pullDone,
    conflicts: built.conflicts,
    failures,
    notes,
    lastSync: state.lastSync,
    manifest: manifestStats(manifest),
  }
}

/** 状态快照，给状态页和工具用。 */
export async function snapshot({ state, version, transport }) {
  const local = await scan(state)
  const bySection = {}
  let bytes = 0
  for (const entry of local.entries) {
    bySection[entry.section] = (bySection[entry.section] || 0) + 1
    bytes += entry.bytes
  }
  const sections = settingsSections(state.settings)
  return {
    device: { id: state.device.id, name: state.device.name },
    version,
    profile: process.env.DSH_PROFILE || 'desktop',
    transport: transport.kind,
    target: transport.describe(),
    settings: state.settings,
    sections: [
      ...Object.keys(sections).map((id) => {
        const def = sectionDef(id)
        return {
          id,
          enabled: Boolean(sections[id]),
          label: def ? def.label : { zh: id, en: id },
          desc: def ? def.desc : null,
          advisory: def ? def.kind === 'advisory' : false,
          kind: def ? def.kind : 'files',
          count: bySection[id] || 0,
        }
      }),
      {
        id: 'custom',
        enabled: (state.settings.customPaths || []).some((item) => item.enabled !== false),
        label: { zh: '自定义路径', en: 'Custom paths' },
        desc: { zh: '按相对 DSH_HOME 的路径额外同步文件或目录。', en: 'Extra paths (relative to DSH_HOME).' },
        advisory: false,
        kind: 'files',
        count: bySection.custom || 0,
      },
    ],
    local: { entries: local.entries.length, bytes, bySection, errors: local.errors },
    baseEntries: Object.keys(state.base || {}).length,
    lastPlan: state.lastPlan,
    lastSync: state.lastSync,
  }
}

export async function readBackupIndex() {
  const root = backupsRoot()
  const items = await readdir(root, { withFileTypes: true }).catch(() => [])
  return items
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort()
    .reverse()
}

export { pathExists, readJson }
