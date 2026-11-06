/**
 * 本机现状分析。回答一个问题：这台机器上到底有多少东西值得同步、哪些故意跳过、
 * 哪些文件属于凭据红线。
 *
 * 返回结构（Promise<对象>）：
 * {
 *   generatedAt: number,                    // 生成时间（epoch ms）
 *   dshHome: string,                        // DSH_HOME 绝对路径（返回值里唯一的绝对路径）
 *   profile: string,                        // profile 名
 *   workspaces: { count, items: [{ id?, path, title?, updatedAt?, sessions? }] },
 *   plugins:    { count, items: [{ name, version? }], bundles, bundlesMissing? },
 *   skills:     { count, bytes },
 *   sessions:   { count, bytes, projects },
 *   skipped:    [{ name, bytes, note }],     // 顶层大目录：体积大、故意不同步
 *   secrets:    { files: [{ rel, bytes }], totalBytes },  // 只列路径与体积，绝不读内容
 *   totals:     { bytes, files },           // 真正值得同步的体积与文件数
 *   errors:     string[],                   // 逐项降级原因，永不抛异常
 * }
 *
 * 约定：
 *   · 任何单个数据源读失败都不抛异常：该项降级成 { count: 0, items: [] }，
 *     失败原因写进 errors，整个 Promise 一定会 resolve；
 *   · 顶层大目录只做限深估算（文件数上限 + 时间上限 + 深度上限），
 *     不为了算体积把 1.3GB 全遍历一遍；
 *   · 凭据文件只取路径与大小，绝不读内容；
 *   · 返回值里的相对路径统一 posix 风格（正斜杠）。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** profile 缺省名，与 DSH 桌面版保持一致。 */
const DEFAULT_PROFILE = 'desktop'

/** 单次扫描的文件数上限：超过就当作估算截断。 */
const MAX_SCAN_FILES = 20000

/**
 * 单次扫描的深度上限（从目标目录算起，第 0 层是目标目录本身）。
 * 不能只扫第一层：pnpm 的 node_modules 里有大量 junction，真正的大文件在
 * .pnpm/<pkg>@<ver>/node_modules/<pkg>/ 深处，只扫第一层会得到 0MB 的假数字。
 * 深度只是兜底，真正的闸门是文件数上限与时间上限。
 */
const MAX_SCAN_DEPTH = 12

/** 单个目录扫描的时间上限（毫秒）：保证整个函数 3 秒内返回。 */
const SCAN_BUDGET_MS = 1000

/** 「顶层大目录」整轮扫描的总时间上限（毫秒）。 */
const SKIP_PHASE_BUDGET_MS = 2000

/** 并发 stat 的批大小：Windows 上小批并发比逐个 await 快 3 倍左右。 */
const STAT_CHUNK = 64

/** 会话目录名有两种形态：session-<uuid> 与裸 <uuid>。 */
const SESSION_DIR_RE = /^session-/i
const UUID_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 凭据红线：固定规则匹配，只看路径与大小，绝不读内容。 */
const SECRET_RULES = [
  { rel: '.credentials.yaml' },
  { rel: '.credentials.yaml.bak-*', glob: true },
  { rel: 'dsh-config-manager/vault/.credentials.yaml' },
  { rel: 'openai-gateway/api-key' },
]

/** 顶层大目录：体积大且故意不同步，只统计不细看。 */
function skippedCandidates(profile) {
  return [
    { rel: 'node_modules', note: '依赖目录，体积大，故意不同步' },
    { rel: `profiles/${profile}/node_modules`, note: '依赖目录，体积大，故意不同步' },
    { rel: 'dsh-ops/bash-ipc', note: 'bash IPC 运行时，体积大，故意不同步' },
    { rel: 'cache', note: '缓存目录，体积大，故意不同步' },
    { rel: 'logs', note: '日志目录，体积大，故意不同步' },
    { rel: 'attachments', note: '附件目录，体积大，故意不同步' },
    { rel: 'data', note: '运行数据目录，体积大，故意不同步' },
  ]
}

function resolveDshHome(explicit) {
  const fromOption = typeof explicit === 'string' ? explicit.trim() : ''
  if (fromOption) return resolve(fromOption)
  const fromEnv = (process.env.DSH_HOME || '').trim()
  if (fromEnv) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

function resolveProfile(explicit) {
  const fromOption = typeof explicit === 'string' ? explicit.trim() : ''
  if (fromOption) return fromOption
  const fromEnv = (process.env.DSH_PROFILE || '').trim()
  return fromEnv || DEFAULT_PROFILE
}

/** 绝对路径 → 相对 DSH_HOME 的 posix 风格路径；越界返回 null。 */
function toHomeRel(dshHome, abs) {
  const home = resolve(dshHome)
  const full = resolve(abs)
  if (full === home) return ''
  if (!full.startsWith(home + sep)) return null
  return full.slice(home.length + 1).split(sep).join('/')
}

/** 把 Windows 绝对路径显示成 posix 风格（斜杠）。 */
function toPosixPath(p) {
  return String(p || '').split(sep).join('/')
}

async function statOrNull(abs) {
  try {
    return await stat(abs)
  } catch {
    return null
  }
}

/**
 * 限深估算一个目录的体积。
 *
 * 三道闸门任一触发就停：文件数上限、时间上限、深度上限。
 * 深度上限存在的原因：pnpm 的 node_modules 里大量是 junction，
 * 只扫第一层会得到 0MB 的假数字，扫太深又会拖垮整体耗时。
 *
 * 返回 { bytes, files, dirs, truncated }。
 */
async function scanDirSize(root, { maxFiles = MAX_SCAN_FILES, maxDepth = MAX_SCAN_DEPTH, budgetMs = SCAN_BUDGET_MS } = {}) {
  const deadline = Date.now() + budgetMs
  let bytes = 0
  let files = 0
  let dirs = 0
  let truncated = false

  async function visit(dir, depth) {
    if (files >= maxFiles || Date.now() > deadline) {
      truncated = true
      return
    }
    let items
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const fileList = []
    const dirList = []
    for (const item of items) {
      if (item.isSymbolicLink()) continue
      const child = join(dir, item.name)
      if (item.isDirectory()) dirList.push(child)
      else if (item.isFile()) fileList.push(child)
    }
    dirs += dirList.length

    for (let i = 0; i < fileList.length; i += STAT_CHUNK) {
      const part = fileList.slice(i, i + STAT_CHUNK)
      const sizes = await Promise.all(part.map(async (abs) => {
        const st = await statOrNull(abs)
        return st ? st.size : 0
      }))
      for (const size of sizes) {
        bytes += size
        files += 1
      }
      if (files >= maxFiles) {
        truncated = true
        break
      }
      if (Date.now() > deadline) {
        truncated = true
        break
      }
    }

    if (depth < maxDepth) {
      for (const child of dirList) {
        await visit(child, depth + 1)
        if (files >= maxFiles) {
          truncated = true
          return
        }
        if (Date.now() > deadline) {
          truncated = true
          return
        }
      }
    } else if (dirList.length) {
      truncated = true
    }
  }

  await visit(root, 0)
  return { bytes, files, dirs, truncated }
}

/** 列出目录下的直接子目录名，失败返回空数组。 */
async function listDirs(abs) {
  try {
    const items = await readdir(abs, { withFileTypes: true })
    return items.filter((it) => it.isDirectory()).map((it) => it.name)
  } catch {
    return []
  }
}

/** 列出目录下的直接子文件条目（含大小），失败返回空数组。 */
async function listFiles(abs) {
  try {
    const items = await readdir(abs, { withFileTypes: true })
    const out = []
    for (const item of items) {
      if (!item.isFile()) continue
      const st = await statOrNull(join(abs, item.name))
      out.push({ name: item.name, bytes: st ? st.size : 0 })
    }
    return out
  } catch {
    return []
  }
}

/** 工作区：读 storages/workspace.json 的 tables.workspaces。 */
async function analyzeWorkspaces(dshHome) {
  const abs = join(dshHome, 'storages', 'workspace.json')
  let raw
  try {
    raw = await readFile(abs, 'utf8')
  } catch (err) {
    throw new Error(`读取 workspace.json 失败：${err.message}`)
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new Error(`解析 workspace.json 失败：${err.message}`)
  }
  const table = data && data.tables && data.tables.workspaces ? data.tables.workspaces : {}
  const items = Object.entries(table).map(([id, ws]) => {
    const item = {
      id,
      path: toPosixPath(ws && ws.path ? ws.path : ''),
    }
    if (ws && ws.title) item.title = String(ws.title)
    if (ws && ws.updatedAt) {
      const ts = Date.parse(String(ws.updatedAt))
      if (Number.isFinite(ts)) item.updatedAt = ts
    }
    if (ws && Array.isArray(ws.sessionIds)) item.sessions = ws.sessionIds.length
    return item
  })
  return { count: items.length, items }
}

/** 插件：profile 的 package.json。dependencies = 已安装，bundles = 声明。 */
async function analyzePlugins(dshHome, profile) {
  const abs = join(dshHome, 'profiles', profile, 'package.json')
  let raw
  try {
    raw = await readFile(abs, 'utf8')
  } catch (err) {
    throw new Error(`读取 profile/package.json 失败：${err.message}`)
  }
  let pkg
  try {
    pkg = JSON.parse(raw)
  } catch (err) {
    throw new Error(`解析 profile/package.json 失败：${err.message}`)
  }
  const deps = pkg && pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  const items = Object.entries(deps)
    .map(([name, version]) => ({ name, version: version == null ? undefined : String(version) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const bundlesRaw = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)
    ? pkg.dsh.profile.bundles
    : []
  const bundles = bundlesRaw.map((b) => String(b))
  const installed = new Set(items.map((i) => i.name))
  const bundlesMissing = bundles.filter((b) => !installed.has(b))
  return { count: items.length, items, bundles: bundles.length, bundlesMissing }
}

/** 技能：skills/ 下每个子目录一个技能，整棵树算体积。 */
async function analyzeSkills(dshHome) {
  const root = join(dshHome, 'skills')
  const names = await listDirs(root)
  const scan = await scanDirSize(root, { maxFiles: MAX_SCAN_FILES, maxDepth: MAX_SCAN_DEPTH })
  return { count: names.length, bytes: scan.bytes, files: scan.files }
}

/** 会话：sessions/<projectKey>/<session 目录>/session.v4.jsonl.zstd。只算压缩后体积，不解压。 */
async function analyzeSessions(dshHome) {
  const root = join(dshHome, 'sessions')
  const projects = await listDirs(root)
  let count = 0
  let bytes = 0
  let files = 0
  for (const project of projects) {
    const projectDir = join(root, project)
    const sessionDirs = await listDirs(projectDir)
    for (const name of sessionDirs) {
      if (!SESSION_DIR_RE.test(name) && !UUID_DIR_RE.test(name)) continue
      count += 1
      const entries = await listFiles(join(projectDir, name))
      for (const entry of entries) {
        bytes += entry.bytes
        files += 1
      }
    }
  }
  return { count, bytes, files, projects: projects.length }
}

/** 凭据红线：固定规则匹配，只取路径与大小。 */
async function analyzeSecrets(dshHome) {
  const files = []
  for (const rule of SECRET_RULES) {
    if (rule.glob) {
      const slash = rule.rel.lastIndexOf('/')
      const dir = slash >= 0 ? join(dshHome, ...rule.rel.slice(0, slash).split('/')) : dshHome
      const prefix = (slash >= 0 ? rule.rel.slice(slash + 1) : rule.rel).replace('*', '')
      const entries = await listFiles(dir)
      for (const entry of entries) {
        if (!entry.name.startsWith(prefix)) continue
        const rel = toHomeRel(dshHome, join(dir, entry.name))
        if (rel) files.push({ rel, bytes: entry.bytes })
      }
      continue
    }
    const abs = join(dshHome, ...rule.rel.split('/'))
    const st = await statOrNull(abs)
    if (!st || !st.isFile()) continue
    const rel = toHomeRel(dshHome, abs)
    if (rel) files.push({ rel, bytes: st.size })
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0)
  return { files, totalBytes }
}

/**
 * 顶层大目录：体积大且故意不同步，只做限深估算。
 *
 * 逐个扫而不是并发扫：Windows 上并发 stat 会互相抢磁盘，实测并发比串行还慢
 * （同样 7 个目录，并发 2.9s、串行约 1s）。
 */
async function analyzeSkipped(dshHome, profile) {
  const out = []
  const phaseDeadline = Date.now() + SKIP_PHASE_BUDGET_MS
  for (const candidate of skippedCandidates(profile)) {
    const abs = join(dshHome, ...candidate.rel.split('/'))
    const st = await statOrNull(abs)
    if (!st || !st.isDirectory()) continue
    const left = phaseDeadline - Date.now()
    if (left <= 0) {
      out.push({ name: candidate.rel, bytes: 0, note: `${candidate.note}（估算值：统计时间预算已用完，未统计）` })
      continue
    }
    const scan = await scanDirSize(abs, {
      maxFiles: MAX_SCAN_FILES,
      maxDepth: MAX_SCAN_DEPTH,
      budgetMs: Math.min(SCAN_BUDGET_MS, left),
    })
    const note = scan.truncated
      ? `${candidate.note}（估算值：扫描已按文件数/深度上限截断）`
      : candidate.note
    out.push({ name: candidate.rel, bytes: scan.bytes, note })
  }
  return out
}

/**
 * 统计本机现状。
 *
 * @param {{ dshHome?: string, profile?: string }} [options]
 *   dshHome 缺省取环境变量 DSH_HOME，再缺省 ~/.dsh；
 *   profile 缺省取环境变量 DSH_PROFILE，再缺省 desktop。
 * @returns {Promise<object>} 见文件头部的返回结构说明。
 */
export async function analyzeLocal(options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const dshHome = resolveDshHome(opts.dshHome)
  const profile = resolveProfile(opts.profile)
  const errors = []

  const fail = (label, err) => {
    errors.push(`${label}：${err && err.message ? err.message : String(err)}`)
  }

  const safe = async (label, fallback, fn) => {
    try {
      return await fn()
    } catch (err) {
      fail(label, err)
      return fallback
    }
  }

  const [workspaces, plugins, skills, sessions, secrets, skipped] = await Promise.all([
    safe('工作区', { count: 0, items: [] }, () => analyzeWorkspaces(dshHome)),
    safe('插件', { count: 0, items: [], bundles: 0, bundlesMissing: [] }, () => analyzePlugins(dshHome, profile)),
    safe('技能', { count: 0, bytes: 0, files: 0 }, () => analyzeSkills(dshHome)),
    safe('会话', { count: 0, bytes: 0, files: 0, projects: 0 }, () => analyzeSessions(dshHome)),
    safe('凭据', { files: [], totalBytes: 0 }, () => analyzeSecrets(dshHome)),
    safe('跳过目录', [], () => analyzeSkipped(dshHome, profile)),
  ])

  const totals = {
    bytes: (sessions.bytes || 0) + (skills.bytes || 0),
    files: (sessions.files || 0) + (skills.files || 0),
  }

  return {
    generatedAt: Date.now(),
    dshHome,
    profile,
    workspaces,
    plugins,
    skills: { count: skills.count, bytes: skills.bytes },
    sessions: { count: sessions.count, bytes: sessions.bytes, projects: sessions.projects },
    skipped,
    secrets,
    totals,
    errors,
  }
}

export default analyzeLocal
