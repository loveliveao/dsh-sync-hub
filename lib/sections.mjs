/**
 * 同步范围的定义与采集。
 *
 * 每个 section 声明：默认开不开、是否只读上报（advisory）、是否需要脱敏、
 * 以及怎么把自己变成一组 entry（id + 相对路径 + 字节）。
 *
 * 采集是幂等的：只读文件，不写任何东西。
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  currentProfile,
  dshHome,
  projcacheRoot,
  profileDir,
  profilePackageJson,
  profilePatch,
  resolveInsideHome,
  sessionsRoot,
  skillsRoot,
  toHomeRel,
  workspaceJson,
} from './paths.mjs'
import { isForbiddenRel, redactJson, redactText, SECRET_FILES } from './privacy.mjs'
import { detectGitRepo } from './git-info.mjs'
import { readArchivedSessionIds } from './archive.mjs'
import { loadPluginConfigs, pluginFileKey, renderPluginConfigYaml } from './plugin-config.mjs'
import { analyzeSessionFile, canonicalRel, sessionEntryId } from './session-canon.mjs'
import { secretsEnabled } from './state.mjs'
import { isTextBuffer, readJson, sha256, statOrNull, walkFiles } from './util.mjs'
import { buildWorkspaceIndex } from './workspaces.mjs'

export const SECTION_DEFS = [
  {
    id: 'cordis',
    label: { zh: 'DSH 配置', en: 'DSH config' },
    desc: {
      zh: 'profiles/<profile>/cordis.patch.yml：模型提供商、界面、插件参数。字面量密钥会被脱敏，环境变量引用原样保留。',
      en: 'cordis.patch.yml: providers, UI and plugin settings. Literal secrets are redacted; env references kept.',
    },
    default: true,
    kind: 'redacted',
  },
  {
    id: 'skills',
    label: { zh: '技能库', en: 'Skills' },
    desc: {
      zh: '$DSH_HOME/skills 整棵目录。技能里如果写了密钥，会在预览里被标记。',
      en: '$DSH_HOME/skills (whole tree). Secrets inside are flagged in preview.',
    },
    default: true,
    kind: 'files',
  },
  {
    id: 'plugins',
    label: { zh: '插件清单', en: 'Plugin set' },
    desc: {
      zh: '已装插件与版本（只读上报，不自动安装）。用于发现两台机器的插件差异。',
      en: 'Installed plugins and versions (report only, never auto-installed).',
    },
    default: true,
    kind: 'advisory',
  },
  {
    id: 'pluginConfig',
    label: { zh: '插件配置副本', en: 'Plugin config copies' },
    desc: {
      zh: '插件配置副本（不会改写对方 DSH 配置）。把 cordis.patch.yml 里各插件的 config 解析、脱敏后，作为副本同步到 sync-hub/reports/plugin-config/。',
      en: 'Plugin config copies (never rewrite the other machine DSH config). Parsed and redacted configs are synced as copies under sync-hub/reports/plugin-config/.',
    },
    default: false,
    kind: 'files',
  },
  {
    id: 'workspaces',
    label: { zh: '工作区列表', en: 'Workspaces' },
    desc: {
      zh: '工作区路径与标题（只读上报）。路径在不同机器上通常不同，不自动写入。',
      en: 'Workspace paths/titles (report only; paths rarely make sense across machines).',
    },
    default: false,
    kind: 'advisory',
  },
  {
    id: 'sessions',
    label: { zh: '会话', en: 'Sessions' },
    desc: {
      zh: '会话记录（session.v4.jsonl.zstd），按会话合并，不会删除对方机器的会话。',
      en: 'Session logs merged per session; never deletes sessions from the other machine.',
    },
    default: true,
    kind: 'files',
  },
  {
    id: 'secrets',
    label: { zh: '凭据与密钥', en: 'Credentials & secrets' },
    desc: {
      zh: '本机凭据与 API 密钥文件（.credentials.yaml、密钥库、网关 key）。默认关闭；开启后这些文件与配置里的明文密钥都会随同步上传到远端，另一台机器也要开着这个开关才会写入。',
      en: 'Local credential / API-key files. Off by default; when on, these files and inline plaintext keys are uploaded, and the other machine must also enable it to write them.',
    },
    default: false,
    kind: 'files',
  },
  {
    id: 'pluginData',
    label: { zh: '插件数据目录', en: 'Plugin data' },
    desc: {
      zh: '插件自己的状态目录（市场、插件管理器等）。可能含本机路径，默认关闭。',
      en: 'Per-plugin state directories. May contain machine-specific paths; off by default.',
    },
    default: false,
    kind: 'files',
  },
]

const PLUGIN_DATA_TREES = [
  'profiles/<profile>/.plugin-manager',
  'profiles/<profile>/.dsh-market',
  'dsh-market',
  'model-router',
]

/** 凭据文件的中文名，只给界面看，不含任何内容。 */
const SECRET_LABELS = {
  '.credentials.yaml': 'DSH 凭据文件',
  'dsh-config-manager/vault/.credentials.yaml': '配置管理器密钥库',
  'openai-gateway/api-key': 'OpenAI 网关 API Key',
}

function fillProfile(rel) {
  return rel.replace('<profile>', currentProfile())
}

function entryId(section, rel) {
  return `${section}:${rel}`
}

function bufEntry({ section, rel, abs, buf, mtimeMs, meta }) {
  const blob = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  return {
    id: entryId(section, rel),
    section,
    rel,
    abs,
    bytes: blob.length,
    sha: sha256(blob),
    mtimeMs: Math.round(mtimeMs || Date.now()),
    blob,
    meta: meta || null,
  }
}

async function collectFile({ section, abs, rel, transform }) {
  const st = await statOrNull(abs)
  if (!st || !st.isFile()) return null
  let buf = await readFile(abs)
  if (transform) buf = transform(buf)
  return bufEntry({ section, rel: rel || toHomeRel(abs), abs, buf, mtimeMs: st.mtimeMs })
}

async function collectTree({ section, root, ignore = [] }) {
  const st = await statOrNull(root)
  if (!st || !st.isDirectory()) return []
  const files = await walkFiles(root, { ignore })
  const out = []
  for (const file of files) {
    const rel = toHomeRel(file.abs)
    if (!rel || isForbiddenRel(rel)) continue
    const buf = await readFile(file.abs)
    out.push(bufEntry({ section, rel, abs: file.abs, buf, mtimeMs: file.mtimeMs }))
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 各 section 的采集                                                    */
/* ------------------------------------------------------------------ */

/**
 * DSH 配置。默认脱敏（明文密钥换成 <redacted>，环境变量引用原样保留）；
 * 开了「凭据与密钥」开关则原样同步（kind 变成 files）—— 这样配置里的
 * 明文 API Key 能完整迁移到另一台机器。
 */
async function collectCordis(settings) {
  const keepInline = secretsEnabled(settings)
  const out = []
  for (const [file, rel] of [
    [profilePatch(), `profiles/${currentProfile()}/cordis.patch.yml`],
    [join(profileDir(), 'cordis.yml'), `profiles/${currentProfile()}/cordis.yml`],
  ]) {
    const st = await statOrNull(file)
    if (!st || !st.isFile()) continue
    const raw = await readFile(file, 'utf8')
    const { text, redacted, count } = keepInline
      ? redactText(raw, { keepInlineSecrets: true })
      : redactText(raw)
    out.push(
      bufEntry({
        section: 'cordis',
        rel,
        abs: file,
        buf: text,
        mtimeMs: st.mtimeMs,
        meta: { redacted, redactedCount: count, kind: keepInline ? 'files' : 'redacted' },
      }),
    )
  }
  return out
}

export async function collectPlugins() {
  const pkg = await readJson(profilePackageJson())
  if (!pkg) return []
  const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  const bundles = pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)
    ? pkg.dsh.profile.bundles
    : pkg.dsh && Array.isArray(pkg.dsh.bundles)
      ? pkg.dsh.bundles
      : []
  // 不要放时间戳：这个文件是「本机事实」的快照，内容必须稳定，否则每次扫描
  // 都会得到新 sha，永远在推送。
  const summary = {
    profile: currentProfile(),
    dependencies: Object.fromEntries(
      Object.entries(deps)
        .map(([k, v]) => [k, String(v)])
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    bundles: bundles.map((b) => (typeof b === 'string' ? b : b && b.id)).filter(Boolean).sort(),
  }
  const abs = profilePackageJson()
  const st = await statOrNull(abs)
  return [
    bufEntry({
      section: 'plugins',
      rel: `profiles/${currentProfile()}/plugin-set.json`,
      abs,
      buf: JSON.stringify(summary, null, 2) + '\n',
      mtimeMs: st ? st.mtimeMs : Date.now(),
      meta: { kind: 'advisory' },
    }),
  ]
}

export async function collectSkills() {
  return collectTree({ section: 'skills', root: skillsRoot(), ignore: ['node_modules', '.git'] })
}

/**
 * 会话（sessions）。
 *
 * 会话是这个插件里最需要「跨机认得出同一个」的东西，所以这里的口径和别的段不同：
 *   - 条目 id 用 `sessions:<sessionId>`，不带本机路径 —— 两台机器才认得出是同一个会话；
 *   - 条目 sha 用「逻辑 sha」：把 header 里的 cwd 换成占位符之后算的 sha，
 *     所以 `D:\VibeCoding` 和 `D:\Code\VibeCoding` 下的同一个会话 sha 相同；
 *   - 条目 rel 用 `sessions/<sessionId>/session.v4.jsonl.zstd`（与机器无关）；
 *     真正落到本机哪个目录，由引擎在写回时按本机的工作区映射决定。
 *   - meta 里带 kind:'session'，引擎据此走会话专用的写回路径。
 */
async function collectSessions(settings) {
  const root = sessionsRoot()
  const st = await statOrNull(root)
  if (!st || !st.isDirectory()) return []
  const maxBytes = Number(settings.sessions && settings.sessions.maxBytes) || 0
  const maxAgeDays = Number(settings.sessions && settings.sessions.maxAgeDays) || 0
  const excluded = new Set((settings.sessions && settings.sessions.excludeIds) || [])
  const cutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86400000 : 0
  // 工作区级开关：关掉的工作区，它的会话不进同步集合。
  const switches = (settings.workspaces && settings.workspaces.switches) || {}
  const { resolveDetail } = await buildWorkspaceIndex()
  // 已归档会话（契约 2.4）：meta 里带 archived，跨机后引擎据此把本机也标成归档。
  let archivedSet = new Set()
  try {
    archivedSet = new Set(await readArchivedSessionIds())
  } catch {
    archivedSet = new Set()
  }
  const files = await walkFiles(root, { ignore: ['node_modules'], maxFiles: 50000 })
  const out = []
  for (const file of files) {
    if (!/\.(zstd|jsonl)$/i.test(file.rel)) continue
    if (maxBytes > 0 && file.size > maxBytes) continue
    if (cutoff > 0 && file.mtimeMs < cutoff) continue
    const info = await analyzeSessionFile(file.abs, file.size, file.mtimeMs)
    if (!info.ok || !info.sessionId) continue
    const sessionId = info.sessionId
    if (excluded.has(sessionId)) continue
    const meta = await sessionMeta(sessionId)
    const cwd = info.cwd || meta.cwd || ''
    const detail = resolveDetail(cwd)
    const workspaceKey = detail.key
    if (workspaceKey && switches[workspaceKey] === false) continue
    out.push({
      id: sessionEntryId(sessionId),
      section: 'sessions',
      rel: canonicalRel(sessionId),
      abs: file.abs,
      bytes: file.size,
      sha: info.logicalSha,
      mtimeMs: file.mtimeMs,
      blob: info.blob,
      meta: {
        kind: 'session',
        sessionId,
        cwd,
        workspaceKey,
        // cwd 相对工作区根的子路径：跨机改写时只换根目录，子路径照旧。
        workspaceSub: detail.sub,
        project: info.project,
        title: meta.title || '',
        createdAt: meta.createdAt || 0,
        archived: archivedSet.has(sessionId),
      },
    })
  }
  return out
}

/** 工作区路径归一化（Windows 下不区分大小写、分隔符统一）。 */
function sameDir(a, b) {
  if (!a || !b) return false
  const norm = (p) => String(p).replace(/\//g, '\\').replace(/[\\/]+$/, '').toLowerCase()
  const x = norm(a)
  const y = norm(b)
  return x === y || x.startsWith(y + '\\')
}

/**
 * 归档会话按目录计数（会话归属看自己的 cwd，不看 workspace.json）。
 * 只读 projcache，最多统计 500 条，失败不报错。
 */
async function archivedCountsByDir(ids) {
  const counts = new Map()
  for (const id of (ids || []).slice(0, 500)) {
    try {
      const meta = await sessionMeta(id)
      if (!meta || !meta.cwd) continue
      const dir = dirname(String(meta.cwd))
      counts.set(dir, (counts.get(dir) || 0) + 1)
    } catch {
      /* ignore */
    }
  }
  return counts
}

/**
 * 工作区上报（契约 2.4）：报告里带上 git 信息与归档计数。
 * 仍然是「只读上报」，落到对方的 storages/workspaces.report.json，不会写回配置。
 */
async function collectWorkspaces() {
  const abs = workspaceJson()
  const data = await readJson(abs)
  if (!data) return []
  const table = (data.tables && data.tables.workspaces) || {}
  const list = Object.values(table)
    .map((item) => ({ path: item && item.path, title: item && item.title, updatedAt: item && item.updatedAt }))
    .filter((item) => item.path)
    .sort((a, b) => String(a.path).localeCompare(String(b.path)))
  let archivedIds = []
  try {
    archivedIds = await readArchivedSessionIds()
  } catch {
    archivedIds = []
  }
  const byDir = await archivedCountsByDir(archivedIds)
  const workspaces = list.map((item) => {
    let git = null
    try {
      git = detectGitRepo(item.path)
    } catch {
      git = null
    }
    let archivedCount = 0
    for (const [dir, count] of byDir) {
      if (sameDir(dir, item.path)) archivedCount += count
    }
    return { ...item, git, archivedCount }
  })
  const st = await statOrNull(abs)
  return [
    bufEntry({
      section: 'workspaces',
      rel: 'storages/workspaces.report.json',
      abs,
      buf: JSON.stringify({ workspaces, archived: { count: archivedIds.length } }, null, 2) + '\n',
      mtimeMs: st ? st.mtimeMs : Date.now(),
      meta: { kind: 'advisory', count: workspaces.length, archivedCount: archivedIds.length },
    }),
  ]
}

/**
 * 插件配置副本（契约 2.4）。
 *
 * 只有「同步插件配置」总开关 + 该插件单独开关都打开时才采集。
 * 产出的是**副本**：rel = sync-hub/reports/plugin-config/<key>.yml，
 * 内容 = 解析并脱敏后的 YAML 文本；绝不写回任何机器的 cordis.patch.yml。
 */
export async function collectPluginConfig(settings) {
  const conf = (settings && settings.pluginConfig) || {}
  if (!conf.enabled) return []
  const switches = conf.switches && typeof conf.switches === 'object' ? conf.switches : {}
  let items = []
  try {
    items = await loadPluginConfigs()
  } catch {
    return []
  }
  const out = []
  for (const item of items) {
    try {
      if (!item || !item.key || !item.hasConfig) continue
      if (switches[item.key] !== true) continue
      const rel = `sync-hub/reports/plugin-config/${pluginFileKey(item.key)}.yml`
      const text = renderPluginConfigYaml(item)
      const buf = Buffer.from(text, 'utf8')
      let abs = ''
      try {
        abs = resolveInsideHome(rel)
      } catch {
        abs = ''
      }
      out.push({
        id: `plugin-config:${item.key}`,
        section: 'pluginConfig',
        rel,
        abs,
        bytes: buf.length,
        sha: sha256(buf),
        mtimeMs: Date.now(),
        blob: buf,
        meta: {
          kind: 'files',
          pluginKey: item.key,
          pluginName: item.name,
          redacted: Boolean(item.redacted),
          configKeys: item.configKeys || [],
        },
      })
    } catch {
      /* 单个插件失败不影响其它插件 */
    }
  }
  return out
}

async function collectPluginData() {
  const out = []
  for (const template of PLUGIN_DATA_TREES) {
    const rel = fillProfile(template)
    const abs = resolveInsideHome(rel)
    const st = await statOrNull(abs)
    if (!st) continue
    if (st.isDirectory()) {
      out.push(...(await collectTree({ section: 'pluginData', root: abs, ignore: ['node_modules', '.git', 'cache', 'logs'] })))
    } else if (st.isFile()) {
      const entry = await collectFile({ section: 'pluginData', abs })
      if (entry) out.push(entry)
    }
  }
  return out
}

/**
 * 凭据与密钥。只有开了「同步凭据与密钥」开关才采集。
 *
 * 这些文件是「这台机器的真实身份」，上传即等于把 API Key 交出去，所以：
 *   · 默认不采集（开关关闭时 collectAll 里不会出现它们）；
 *   · 文件不存在就跳过，不报错；
 *   · meta 里只放路径、字节数、中文标签，绝不把文件内容塞进 meta。
 */
export async function collectSecrets(settings) {
  if (!secretsEnabled(settings)) return []
  const out = []
  for (const rel of SECRET_FILES) {
    let abs
    try {
      abs = resolveInsideHome(rel)
    } catch {
      continue
    }
    const st = await statOrNull(abs)
    if (!st || !st.isFile()) continue
    const buf = await readFile(abs)
    out.push(
      bufEntry({
        section: 'secrets',
        rel,
        abs,
        buf,
        mtimeMs: st.mtimeMs,
        meta: {
          kind: 'secret',
          bytes: buf.length,
          sensitive: true,
          label: SECRET_LABELS[rel] || rel,
        },
      }),
    )
  }
  return out
}

/**
 * 给界面用：这份配置开启密钥同步后会涉及哪些文件。
 * `files` 是「会真的上传」的清单，`candidates` 是候选清单（关着开关时也给界面
 * 一个提示「打开会上传这些」）。
 */
export function secretsManifest(settings) {
  const enabled = secretsEnabled(settings)
  return {
    enabled,
    files: enabled ? [...SECRET_FILES] : [],
    candidates: [...SECRET_FILES],
  }
}

async function collectCustom(settings) {
  const paths = Array.isArray(settings.customPaths) ? settings.customPaths : []
  const out = []
  for (const item of paths) {
    if (!item || item.enabled === false) continue
    const rel = String(typeof item === 'string' ? item : item.rel || '').trim()
    if (!rel || isForbiddenRel(rel)) continue
    let abs
    try {
      abs = resolveInsideHome(rel)
    } catch {
      continue
    }
    const st = await statOrNull(abs)
    if (!st) continue
    if (st.isDirectory()) {
      out.push(...(await collectTree({ section: 'custom', root: abs, ignore: ['node_modules', '.git'] })))
    } else if (st.isFile()) {
      let transform
      if (/\.(ya?ml|json|env|ini|toml)$/i.test(rel)) transform = (buf) => (isTextBuffer(buf) ? Buffer.from(redactText(buf.toString('utf8')).text) : buf)
      const entry = await collectFile({ section: 'custom', abs, rel, transform })
      if (entry) out.push(entry)
    }
  }
  return out
}

const COLLECTORS = {
  cordis: collectCordis,
  skills: collectSkills,
  plugins: collectPlugins,
  pluginConfig: collectPluginConfig,
  workspaces: collectWorkspaces,
  sessions: collectSessions,
  secrets: collectSecrets,
  pluginData: collectPluginData,
}

/** 采集当前设置下所有启用的 section。 */
export async function collectAll(settings) {
  const entries = []
  const errors = []
  for (const def of SECTION_DEFS) {
    if (!settingsSections(settings)[def.id]) continue
    try {
      const collected = await COLLECTORS[def.id](settings)
      entries.push(...collected)
    } catch (err) {
      errors.push({ section: def.id, message: String((err && err.message) || err) })
    }
  }
  try {
    entries.push(...(await collectCustom(settings)))
  } catch (err) {
    errors.push({ section: 'custom', message: String((err && err.message) || err) })
  }
  return { entries, errors }
}

export function settingsSections(settings) {
  const fromSettings = (settings && settings.sections) || {}
  const merged = {}
  for (const def of SECTION_DEFS) {
    merged[def.id] = fromSettings[def.id] === undefined ? def.default : Boolean(fromSettings[def.id])
  }
  return merged
}

/* ------------------------------------------------------------------ */
/* 会话元数据（标题/工作区）                                            */
/* ------------------------------------------------------------------ */

const metaCache = new Map()

export async function sessionMeta(sessionId) {
  if (!sessionId) return {}
  if (metaCache.has(sessionId)) return metaCache.get(sessionId)
  const file = join(projcacheRoot(), `${sessionId}.json`)
  const data = await readJson(file)
  let meta = {}
  if (data && data.record) {
    const identity = data.record.identity || {}
    const rows = data.record.rows || {}
    meta = {
      title: rows.title && rows.title.val ? String(rows.title.val) : '',
      cwd: identity.cwd || '',
      createdAt: identity.createdAt || 0,
    }
  }
  metaCache.set(sessionId, meta)
  return meta
}

export function clearMetaCache() {
  metaCache.clear()
}

/* ------------------------------------------------------------------ */
/* 会话列表（界面用，不读会话内容）                                      */
/* ------------------------------------------------------------------ */

export async function listSessions({ limit = 300 } = {}) {
  const root = sessionsRoot()
  const st = await statOrNull(root)
  if (!st || !st.isDirectory()) return []
  const projects = await walkFiles(root, { maxFiles: 50000 })
  const byDir = new Map()
  for (const file of projects) {
    if (!/\.(zstd|jsonl)$/i.test(file.rel)) continue
    const parts = file.rel.split('/')
    const project = parts.length > 1 ? parts[0] : '_'
    const sessionId = parts.length > 2 ? parts[parts.length - 2] : basename(file.rel).replace(/\.(zstd|jsonl)$/i, '')
    const prev = byDir.get(sessionId)
    if (prev && prev.size >= file.size) continue
    byDir.set(sessionId, { sessionId, project, size: file.size, mtimeMs: file.mtimeMs, rel: `sessions/${file.rel}` })
  }
  const out = []
  for (const item of byDir.values()) {
    const meta = await sessionMeta(item.sessionId)
    out.push({
      sessionId: item.sessionId,
      project: item.project,
      rel: item.rel,
      bytes: item.size,
      updatedAt: item.mtimeMs,
      title: meta.title || '',
      cwd: meta.cwd || '',
      createdAt: meta.createdAt || 0,
    })
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out.slice(0, limit)
}

/* ------------------------------------------------------------------ */
/* 回写                                                                */
/* ------------------------------------------------------------------ */

function buildKeyMap(text) {
  const map = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(\s*(?:-\s+)?["']?)([A-Za-z0-9_.-]+)(["']?\s*[:=]\s*)(.*)$/.exec(line)
    if (m) map.set(m[2], line)
  }
  return map
}

/**
 * 远端文本里出现 `<redacted>` 的行，用本机同名键的真实值替换；本机没有这个
 * 键就整行丢弃（宁可少一行，也不把 `<redacted>` 写进真实配置）。按「键名」
 * 匹配而不是按位置 —— patch 文件里的键基本全局唯一。
 */
export function mergeRedactedText(localText, remoteText) {
  const localByKey = buildKeyMap(localText || '')
  let kept = 0
  let dropped = 0
  const out = []
  for (const line of String(remoteText || '').split(/\r?\n/)) {
    if (!line.includes('<redacted>')) {
      out.push(line)
      continue
    }
    const m = /^(\s*(?:-\s+)?["']?)([A-Za-z0-9_.-]+)(["']?\s*[:=]\s*)(.*)$/.exec(line)
    const local = m ? localByKey.get(m[2]) : null
    if (local) {
      out.push(local)
      kept += 1
    } else {
      dropped += 1
    }
  }
  return { text: out.join('\n'), kept, dropped }
}

export { mergeRedactedText as mergeRedacted }

/** 只读上报的 section 永远不写回。 */
export function isAdvisory(defId) {
  const def = SECTION_DEFS.find((d) => d.id === defId)
  return Boolean(def && def.kind === 'advisory')
}

export function sectionDef(id) {
  return SECTION_DEFS.find((d) => d.id === id) || null
}

export function homeLabel() {
  return dshHome()
}
