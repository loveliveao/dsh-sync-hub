/**
 * 工作区树：把本机的会话、技能、插件按「工作区」组织起来，并给每一行标出
 * 「会不会被同步」。
 *
 * 为什么单独一个模块：
 *  - 界面上要按工作区展开（工作区 → 它的会话），但 DSH 的 workspace.json 只记
 *    路径，不记会话归属；会话归属实际看的是会话自己的 cwd。
 *  - 路径跨机不一样，所以工作区的跨机身份用「目录名」当 key；用户也可以手动
 *    改（settings.workspaces.map）。
 *  - 「是否同步」要在不联网的前提下给出答案：拿本机文件的 sha 和上次同步基线
 *    比。远端那边要精确到条目时，由引擎的 plan 补充。
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import {
  currentProfile,
  dshHome,
  profilePackageJson,
  sessionsRoot,
  skillsRoot,
  workspaceJson,
} from './paths.mjs'
import { readJson, sha256, walkFiles } from './util.mjs'
import { analyzeSessionFile, sessionEntryId } from './session-canon.mjs'
import { detectGitRepo } from './git-info.mjs'
import { readArchivedSessionIds } from './archive.mjs'
import { loadPluginConfigs, normalizePluginVersion } from './plugin-config.mjs'

export const UNASSIGNED_GROUP = 'unassigned'

/* ------------------------------------------------------------------ */
/* 工作区身份                                                          */
/* ------------------------------------------------------------------ */

/**
 * 工作区的跨机身份：取路径最后一段（目录名）。
 * 目录名在两台机器上通常一致（VibeCoding ↔ VibeCoding），这是默认的匹配依据；
 * 匹配不上时用户可以在设置里手动指定（settings.workspaces.map）。
 */
export function workspaceKey(path) {
  const raw = String(path || '').trim().replace(/[\\/]+$/, '')
  const name = basename(raw)
  return name || 'root'
}

/** 路径比较：Windows 上不区分大小写，分隔符统一。 */
export function samePath(a, b) {
  if (!a || !b) return false
  const norm = (p) => String(p).trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
  return norm(a) === norm(b)
}

/** cwd 是否落在工作区路径下面（工作区本身或它的子目录都算）。 */
export function pathUnder(cwd, workspacePath) {
  if (!cwd || !workspacePath) return false
  const norm = (p) => String(p).trim().replace(/\//g, '\\').replace(/[\\/]+$/, '').toLowerCase()
  const c = norm(cwd)
  const w = norm(workspacePath)
  if (!c || !w) return false
  return c === w || c.startsWith(w + sep.replace(/\//g, '\\').toLowerCase())
}

/* ------------------------------------------------------------------ */
/* DSH 已注册的工作区                                                  */
/* ------------------------------------------------------------------ */

/** 读 DSH 自己的工作区注册表。读不到就返回空数组，不报错。 */
export async function loadRegistry() {
  const data = await readJson(workspaceJson())
  const table = (data && data.tables && data.tables.workspaces) || {}
  return Object.entries(table)
    .map(([id, item]) => ({
      id,
      path: (item && item.path) || '',
      title: (item && item.title) || '',
      updatedAt: (item && item.updatedAt) || '',
    }))
    .filter((item) => item.path)
    .sort((a, b) => String(a.path).localeCompare(String(b.path)))
}

/**
 * 建一份「cwd → 工作区 key」的索引，并给出判定函数。
 * 采集会话时要用它把会话归到工作区（会话的归属看自己的 cwd，不看 workspace.json）。
 *
 * resolveDetail 除了给出 key，还给出 cwd 相对工作区根的子路径 ——
 * 跨机改写时要靠它把 `D:\VibeCoding\tools\x` 映射到
 * `E:\VibeCoding\tools\x`（只换根目录，子路径照旧）。
 */
export async function buildWorkspaceIndex() {
  const registry = await loadRegistry()
  const entries = registry.map((ws) => ({ key: workspaceKey(ws.path), path: ws.path }))
  const resolveDetail = (cwd) => {
    if (!cwd) return { key: '', root: '', sub: '' }
    for (const item of entries) {
      if (!pathUnder(cwd, item.path)) continue
      const rel = relative(item.path, cwd)
      return {
        key: item.key,
        root: item.path,
        sub: rel && !rel.startsWith('..') ? rel.split(/[\\/]/).filter(Boolean).join('/') : '',
      }
    }
    // 没落在任何已注册工作区下：按 cwd 自己的目录名成组（未归属工作区）。
    return { key: workspaceKey(cwd), root: '', sub: '' }
  }
  const resolve = (cwd) => resolveDetail(cwd).key
  return { registry, entries, resolve, resolveDetail }
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

const shaCache = new Map()

async function fileSha(abs, mtimeMs, size) {
  const key = `${abs}:${mtimeMs}:${size}`
  if (shaCache.has(key)) return shaCache.get(key)
  let sha = ''
  try {
    sha = sha256(await readFile(abs))
  } catch {
    sha = ''
  }
  shaCache.set(key, sha)
  if (shaCache.size > 4000) shaCache.clear()
  return sha
}

export function clearShaCache() {
  shaCache.clear()
}

/**
 * 扫会话目录，返回每个会话的基本信息（不读会话内容）。
 * 与 sections.collectSessions 的字段命名保持一致，便于界面复用。
 */
export async function listSessionRows() {
  const root = sessionsRoot()
  const st = await stat(root).catch(() => null)
  if (!st || !st.isDirectory()) return []
  const files = await walkFiles(root, { ignore: ['node_modules'], maxFiles: 50000 })
  const rows = []
  for (const file of files) {
    if (!/\.(zstd|jsonl)$/i.test(file.rel)) continue
    const parts = file.rel.split('/')
    const project = parts.length > 1 ? parts[0] : '_'
    const sessionId =
      parts.length > 2 ? parts[parts.length - 2] : basename(file.rel).replace(/\.(zstd|jsonl)$/i, '')
    rows.push({
      sessionId,
      project,
      rel: `sessions/${file.rel}`,
      abs: file.abs,
      bytes: file.size,
      mtimeMs: file.mtimeMs,
    })
  }
  return rows
}

/* ------------------------------------------------------------------ */
/* 同步判定                                                            */
/* ------------------------------------------------------------------ */

function sessionFilters(settings) {
  const sessions = (settings && settings.sessions) || {}
  const maxBytes = Number(sessions.maxBytes) || 0
  const maxAgeDays = Number(sessions.maxAgeDays) || 0
  const excludeIds = new Set(sessions.excludeIds || [])
  const cutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86400000 : 0
  return { maxBytes, maxAgeDays, cutoff, excludeIds }
}

/** 这个会话会不会被同步？返回 { sync, reason }。 */
export function sessionSyncState(session, settings, { workspaceEnabled = true, sectionEnabled = true } = {}) {
  const f = sessionFilters(settings)
  if (!sectionEnabled) return { sync: 'off', reason: '会话同步已关闭' }
  if (!workspaceEnabled) return { sync: 'off', reason: '所属工作区已关闭同步' }
  if (f.excludeIds.has(session.sessionId)) return { sync: 'off', reason: '在排除名单里' }
  if (f.maxBytes > 0 && session.bytes > f.maxBytes) return { sync: 'off', reason: '超过单会话大小上限' }
  if (f.cutoff > 0 && session.mtimeMs < f.cutoff) return { sync: 'off', reason: '超过保留天数' }
  return { sync: 'pending', reason: '' }
}

/** 本地内容与上次同步基线相比的状态。 */
export function compareWithBase(id, sha, base) {
  const known = (base || {})[id]
  if (!known) return 'new'
  if (known === sha) return 'synced'
  return 'changed'
}

/* ------------------------------------------------------------------ */
/* 树                                                                  */
/* ------------------------------------------------------------------ */

/** 探测工作区是不是 git 仓库；任何异常都降级成 null（不影响整棵树）。 */
function safeGit(path) {
  if (!path) return null
  try {
    const info = detectGitRepo(path)
    if (!info || !info.isRepo) return null
    return info
  } catch {
    return null
  }
}

/**
 * 构建工作区树。
 *
 * 返回：
 * {
 *   generatedAt, profile, dshHome,
 *   workspaces: [{ key, path, title, registered, enabled, git, sessionCount, archivedCount, pendingCount, bytes, sessions: [...] }],
 *   unassigned: [{ key, path, title, registered:false, enabled, git, sessionCount, archivedCount, pendingCount, bytes, sessions: [...] }],
 *   plugins: [{ key, name, version, state, hasConfig, configKeys, syncEnabled }],
 *   skills: [{ name, files, bytes, state }],
 *   totals: { workspaces, unassigned, sessions, bytes, pending, synced, off, archived }
 * }
 */
export async function buildTree({ settings, base, ctx } = {}) {
  const cfg = settings || {}
  const registry = await loadRegistry()
  const rows = await listSessionRows()

  // 已归档会话（契约 1.2）：会话行带 archived，工作区带 archivedCount。
  let archivedIds = []
  try {
    archivedIds = await readArchivedSessionIds(ctx)
  } catch {
    archivedIds = []
  }
  const archivedSet = new Set(archivedIds)

  // 会话的元信息（标题 / cwd / 创建时间）从 projcache 读，和 sections 用的是同一份。
  const { sessionMeta } = await import('./sections.mjs')
  const switches = (cfg.workspaces && cfg.workspaces.switches) || {}
  const sessions = []
  for (const row of rows) {
    const meta = await sessionMeta(row.sessionId)
    // sha 用「逻辑 sha」（cwd 占位化后的内容摘要），和真正进 manifest 的条目一致，
    // 这样「已同步 / 有改动」才准。id 用 sessionId，两台机器认得出是同一个会话。
    const info = await analyzeSessionFile(row.abs, row.bytes, row.mtimeMs)
    const sha = info.ok ? info.logicalSha : await fileSha(row.abs, row.mtimeMs, row.bytes)
    sessions.push({
      id: sessionEntryId(row.sessionId),
      sessionId: row.sessionId,
      project: row.project,
      rel: row.rel,
      title: meta.title || '',
      cwd: info.ok && info.cwd ? info.cwd : meta.cwd || '',
      bytes: row.bytes,
      updatedAt: row.mtimeMs,
      mtimeMs: row.mtimeMs,
      createdAt: meta.createdAt || 0,
      sha,
      sync: 'pending',
      reason: '',
      archived: archivedSet.has(row.sessionId),
    })
  }

  // 先按「已注册工作区路径」归属，剩下的按 cwd 各自成组（未归属工作区）。
  const groups = new Map()
  const ensureGroup = (key, extra) => {
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        path: '',
        title: '',
        registered: false,
        enabled: true,
        sessionCount: 0,
        archivedCount: 0,
        pendingCount: 0,
        bytes: 0,
        git: null,
        sessions: [],
        ...extra,
      })
    }
    return groups.get(key)
  }

  for (const ws of registry) {
    const key = workspaceKey(ws.path)
    const g = ensureGroup(key, { path: ws.path, title: ws.title || key, registered: true, id: ws.id })
    g.enabled = switches[key] !== false
    g.git = safeGit(ws.path)
  }

  for (const s of sessions) {
    let group = null
    for (const ws of registry) {
      if (pathUnder(s.cwd, ws.path)) {
        group = ensureGroup(workspaceKey(ws.path), {
          path: ws.path,
          title: ws.title || workspaceKey(ws.path),
          registered: true,
          id: ws.id,
        })
        break
      }
    }
    if (!group) {
      // 未归属：按 cwd 的目录名独立成组，界面里统一放在「未归属工作区」下面。
      const key = s.cwd ? workspaceKey(s.cwd) : UNASSIGNED_GROUP
      group = ensureGroup(key, { path: s.cwd || '', title: key })
      group.registered = false
    }
    group.enabled = switches[group.key] !== false
    // 「是否同步」在这里才判定：归属定了，工作区开关才知道该不该生效。
    const state = sessionSyncState(s, cfg, {
      sectionEnabled: cfg.sections ? cfg.sections.sessions !== false : true,
      workspaceEnabled: group.enabled,
    })
    if (state.sync === 'off') {
      s.sync = 'off'
      s.reason = state.reason
    } else {
      // compareWithBase 只会给 synced/changed/new；界面上把 new 统一叫「待推送」。
      const cmp = compareWithBase(s.id, s.sha, base)
      s.sync = cmp === 'new' ? 'pending' : cmp
      s.reason = ''
    }
    group.sessions.push(s)
    group.sessionCount = group.sessions.length
    group.bytes += s.bytes
  }

  // 每个分组的统计：归档数、待推送数、git 信息（未注册分组没有路径就留 null）。
  for (const g of groups.values()) {
    g.archivedCount = g.sessions.filter((s) => s.archived).length
    g.pendingCount = g.sessions.filter((s) => s.sync === 'pending').length
    if (!g.git && g.path) g.git = safeGit(g.path)
  }

  const workspaces = []
  const unassigned = []
  for (const g of groups.values()) {
    g.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    if (g.registered) workspaces.push(g)
    else unassigned.push(g)
  }
  workspaces.sort((a, b) => a.key.localeCompare(b.key))
  unassigned.sort((a, b) => a.key.localeCompare(b.key))

  // 插件与技能：直接复用采集层的结果，保证 id 与 sha 和真正进 manifest 的完全一致
  // （id 格式是 `section:rel`，base 里就是用它做键的）。
  const { collectPlugins, collectSkills } = await import('./sections.mjs')
  const pluginEntries = await collectPlugins()
  const pluginCmp = pluginEntries.length ? compareWithBase(pluginEntries[0].id, pluginEntries[0].sha, base) : 'pending'
  const pluginState = pluginCmp === 'new' ? 'pending' : pluginCmp
  // 插件清单的 dep 名字从 package.json 取（只读，不读 node_modules）。
  const pkg = await readJson(profilePackageJson())
  const deps = (pkg && pkg.dependencies) || {}
  const depNames = Object.entries(deps)
    .map(([name, version]) => ({ key: name, name, version: normalizePluginVersion(version) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  // 插件配置解析结果（契约 1.2：plugins[] 增加 hasConfig / configKeys / syncEnabled）。
  let pluginConfigs = []
  try {
    pluginConfigs = await loadPluginConfigs()
  } catch {
    pluginConfigs = []
  }
  const configByKey = new Map()
  for (const item of pluginConfigs) {
    if (!item || !item.key) continue
    configByKey.set(item.key, item)
  }
  const pluginSwitches = (cfg.pluginConfig && cfg.pluginConfig.switches) || {}
  const plugins = depNames.map((item) => {
    const conf = configByKey.get(item.key) || configByKey.get(item.name)
    return {
      ...item,
      state: pluginState,
      hasConfig: Boolean(conf && conf.hasConfig),
      configKeys: (conf && conf.configKeys) || [],
      syncEnabled: pluginSwitches[item.key] === true,
    }
  })

  const skillEntries = await collectSkills()
  const skillByName = new Map()
  for (const entry of skillEntries) {
    const name = entry.rel.split('/')[1] || 'root'
    if (!skillByName.has(name)) {
      skillByName.set(name, {
        name,
        files: 0,
        bytes: 0,
        state: 'synced',
        changed: 0,
        pending: 0,
      })
    }
    const item = skillByName.get(name)
    item.files += 1
    item.bytes += entry.bytes
    const cmp = compareWithBase(entry.id, entry.sha, base)
    if (cmp === 'changed') item.changed += 1
    else if (cmp === 'new') item.pending += 1
  }
  const skills = [...skillByName.values()].map((item) => ({
    ...item,
    state: item.changed ? 'changed' : item.pending ? 'pending' : 'synced',
  }))
  skills.sort((a, b) => a.name.localeCompare(b.name))

  const allSessions = sessions
  const totals = {
    workspaces: workspaces.length,
    unassigned: unassigned.length,
    sessions: allSessions.length,
    bytes: allSessions.reduce((sum, s) => sum + s.bytes, 0),
    synced: allSessions.filter((s) => s.sync === 'synced').length,
    changed: allSessions.filter((s) => s.sync === 'changed').length,
    pending: allSessions.filter((s) => s.sync === 'pending').length,
    off: allSessions.filter((s) => s.sync === 'off').length,
    archived: allSessions.filter((s) => s.archived).length,
  }

  return {
    generatedAt: new Date().toISOString(),
    profile: currentProfile(),
    dshHome: dshHome(),
    workspaces,
    unassigned,
    plugins,
    skills,
    totals,
  }
}

/** 给某个工作区找本机对应的目录：先看手动映射，再看已注册工作区，最后按目录名找。 */
export async function resolveLocalPath(key, map) {
  const manual = map && map[key]
  if (manual) return { path: manual, source: 'manual' }
  const registry = await loadRegistry()
  const hit = registry.find((ws) => workspaceKey(ws.path) === key)
  if (hit) return { path: hit.path, source: 'registered' }
  return { path: '', source: 'none' }
}

/**
 * 把「远端会话的工作区」翻译成「本机该落在哪个目录」。
 *
 * 跨机时同一个工作区的绝对路径往往不同（`D:\VibeCoding` ↔ `E:\VibeCoding`），
 * 拉取时必须把会话 header 里的 cwd 改成目标机的目录，否则 DSH 会因为
 * 「文件所在目录与 header 不一致」判定会话损坏。
 *
 * 匹配顺序（用户已确认）：
 *   1. 用户手动指定的映射（settings.workspaces.map，键是工作区目录名）；
 *   2. 本机已注册、目录名相同的工作区；
 *   3. 都找不到就沿用远端原路径（同一台机器或路径恰好一致时就是对的）。
 *
 * @param {object} args
 * @param {string} args.key      工作区跨机身份（目录名）
 * @param {string} args.sub      cwd 相对工作区根的子路径
 * @param {string} args.cwd      远端原始 cwd（兜底用）
 * @param {object} args.settings 本机设置（含 workspaces.map）
 * @returns {Promise<{cwd:string, source:string}>}
 */
export async function resolveLocalCwd({ key, sub = '', cwd = '', settings = {} } = {}) {
  const map = (settings.workspaces && settings.workspaces.map) || {}
  const local = await resolveLocalPath(key, map)
  if (local.path) {
    const parts = String(sub || '').split('/').filter(Boolean)
    return { cwd: parts.length ? join(local.path, ...parts) : local.path, source: local.source }
  }
  return { cwd: cwd || '', source: 'remote-path' }
}
