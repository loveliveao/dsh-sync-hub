/**
 * 会话归档：
 * - 优先用宿主服务 ctx.workspaceRegistry（权威、会持久化、客户端能立即刷新）；
 * - 宿主服务不可用（或不认识该会话）时，退回直接改 $DSH_HOME/storages/workspace.json。
 *
 * 约束（AGENTS.md）：
 * - 只增不减：归档是「加进去」，绝不在同步时删掉用户已有的归档记录；
 * - 写盘前先备份到 sync-hub/backups/<时间戳>/；
 * - 任何异常都降级成 { added, skipped, error }，绝不抛给调用方。
 */
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { backupsRoot, workspaceJson } from './paths.mjs'
import { atomicWrite, ensureDir, readJson } from './util.mjs'

function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function errorText(err) {
  const message = err && err.message ? err.message : String(err)
  return message
}

/** 归一化 id 列表：只留非空字符串，去重保序。 */
function normalizeIds(ids) {
  if (!Array.isArray(ids)) return []
  const out = []
  const seen = new Set()
  for (const item of ids) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * 取出宿主的 workspaceRegistry 服务（可能不存在 / 访问时抛错，都按「没有」处理）。
 * 绝不把它写进 inject 列表，避免该服务缺失时插件加载失败。
 */
export function registryOf(ctx) {
  if (!ctx) return null
  try {
    // Cordis 的 ctx.get(name) 返回真实服务实例；没注册就返回 undefined。
    // 这里必须以它为准：直接摸 ctx.workspaceRegistry 可能拿到 Cordis 的空服务代理，
    // 那样调用会「有函数但必然失败」，反而把文件兜底路径废掉。
    if (typeof ctx.get === 'function') {
      const svc = ctx.get('workspaceRegistry')
      return svc && typeof svc.archiveSession === 'function' ? svc : null
    }
    const reg = ctx.workspaceRegistry
    if (reg && typeof reg.archiveSession === 'function') return reg
  } catch {
    /* ignore */
  }
  return null
}

/**
 * 读取已归档的会话 id 列表。读不到就当没有归档过。
 *
 * @param {object} [ctx] 宿主 ctx（可选）；有 workspaceRegistry 时以它为准
 * @returns {Promise<string[]>}
 */
export async function readArchivedSessionIds(ctx) {
  const reg = registryOf(ctx)
  if (reg) {
    try {
      const ids = reg.archivedSessionIds
      if (Array.isArray(ids)) return normalizeIds(ids)
    } catch {
      /* ignore */
    }
  }
  try {
    const raw = await readJson(workspaceJson(), null)
    const list = raw && raw.global ? raw.global.archivedSessionIds : null
    if (!Array.isArray(list)) return []
    return normalizeIds(list)
  } catch {
    return []
  }
}

async function pruneBackups(keep) {
  const root = backupsRoot()
  const items = await readdir(root, { withFileTypes: true }).catch(() => [])
  const dirs = items
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort()
  const excess = dirs.slice(0, Math.max(0, dirs.length - keep))
  for (const name of excess) {
    await rm(join(root, name), { recursive: true, force: true }).catch(() => {})
  }
}

/** 把 workspace.json 备份进 sync-hub/backups/<时间戳>/storages/。 */
async function backupWorkspaceFile(abs, keep) {
  try {
    const buf = await readFile(abs)
    const folder = join(backupsRoot(), backupStamp())
    const target = join(folder, 'storages', 'workspace.json')
    await ensureDir(join(folder, 'storages'))
    await atomicWrite(target, buf)
    await pruneBackups(keep)
    return true
  } catch {
    return false
  }
}

/** 文件兜底：把 id 追加进 workspace.json 的归档列表（只增不减）。 */
async function applyViaFile(ids, options = {}) {
  try {
    const wanted = normalizeIds(ids)
    if (!wanted.length) return { added: 0, skipped: 0 }

    const file = typeof options.file === 'string' && options.file.trim() ? options.file : workspaceJson()
    const raw = await readJson(file, null)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { added: 0, skipped: 0, error: '工作区索引无法解析：' + file }
    }

    const global = raw.global && typeof raw.global === 'object' && !Array.isArray(raw.global) ? raw.global : {}
    const existing = Array.isArray(global.archivedSessionIds)
      ? global.archivedSessionIds.filter((item) => typeof item === 'string' && item.trim())
      : []
    const seen = new Set(existing.map((item) => item.trim()))
    const merged = existing.slice()
    let added = 0
    let skipped = 0
    for (const id of wanted) {
      if (seen.has(id)) {
        skipped += 1
        continue
      }
      seen.add(id)
      merged.push(id)
      added += 1
    }
    if (!added) return { added: 0, skipped }

    const keep = Number.isFinite(options.keep) && options.keep > 0 ? Math.floor(options.keep) : 20
    await backupWorkspaceFile(file, keep)

    const next = { ...raw, global: { ...global, archivedSessionIds: merged } }
    await atomicWrite(file, JSON.stringify(next, null, 2) + '\n')
    return { added, skipped }
  } catch (err) {
    return { added: 0, skipped: 0, error: errorText(err) }
  }
}

/**
 * 把会话 id 追加进归档集合（只增不减）。
 *
 * 优先走宿主 workspaceRegistry.archiveSession()：
 * - 宿主会持久化、推送 frame 给客户端，界面立刻刷新；
 * - 宿主自己会校验会话是否存在、是否在活动；
 * - 直接改文件会被宿主下次持久化覆盖。
 * 服务不可用时退回文件实现。
 *
 * @param {string[]} ids 要归档的会话 id
 * @param {{file?:string, keep?:number, ctx?:object}} [opts]
 * @returns {Promise<{added:number,skipped:number,via?:string,error?:string}>}
 */
export async function applyArchivedSessionIds(ids, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {}
  const wanted = normalizeIds(ids)
  if (!wanted.length) return { added: 0, skipped: 0 }

  const reg = registryOf(options.ctx)
  if (!reg) return { ...(await applyViaFile(wanted, options)), via: 'file' }

  try {
    const before = new Set(await readArchivedSessionIds(options.ctx))
    let added = 0
    let skipped = 0
    const fallbackIds = []
    const reasons = []
    for (const id of wanted) {
      if (before.has(id)) {
        skipped += 1
        continue
      }
      try {
        await reg.archiveSession(id)
        added += 1
      } catch (err) {
        // 宿主拒绝（会话在活动 / 还不认识）或服务整体不可用：
        // 一律用文件兜底补记（只增不减，最坏情况被宿主下次持久化覆盖），
        // 并把原因记进 error，界面上能看到「哪些没成功」。
        fallbackIds.push(id)
        reasons.push(id + '：' + errorText(err))
      }
    }

    let via = 'registry'
    let error
    if (fallbackIds.length) {
      const fallback = await applyViaFile(fallbackIds, options)
      via = 'registry+file'
      added += fallback.added
      if (fallback.error) reasons.push(fallback.error)
    }
    if (reasons.length) error = reasons.join('；')
    return error ? { added, skipped, via, error } : { added, skipped, via }
  } catch (err) {
    // 宿主服务整体不可用 → 退文件实现
    const fallback = await applyViaFile(wanted, options)
    const out = { ...fallback, via: 'file' }
    if (!fallback.added) out.error = fallback.error || errorText(err)
    return out
  }
}

export default { readArchivedSessionIds, applyArchivedSessionIds, registryOf }
