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
    id: 'custom',
    label: { zh: '自定义路径', en: 'Custom paths' },
    desc: {
      zh: '按相对 DSH_HOME 的路径额外同步文件或目录。文本型配置（yml/json/env/ini/toml）上传前会脱敏，落地时走合并，不会用远端的 <redacted> 覆盖本机真实值。',
      en: 'Extra paths (relative to DSH_HOME). Text configs (yml/json/env/ini/toml) are redacted before upload and merged on landing — a remote <redacted> never overwrites the local real value.',
    },
    default: false,
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

async function collectFile({ section, abs, rel, transform, meta }) {
  const st = await statOrNull(abs)
  if (!st || !st.isFile()) return null
  let buf = await readFile(abs)
  if (transform) buf = transform(buf)
  return bufEntry({ section, rel: rel || toHomeRel(abs), abs, buf, mtimeMs: st.mtimeMs, meta: meta || null })
}

async function collectTree({ section, root, ignore = [], transform = null, metaFor = null }) {
  const st = await statOrNull(root)
  if (!st || !st.isDirectory()) return []
  const files = await walkFiles(root, { ignore })
  const out = []
  for (const file of files) {
    const rel = toHomeRel(file.abs)
    if (!rel || isForbiddenRel(rel)) continue
    const raw = await readFile(file.abs)
    const buf = transform ? transform(raw, rel) : raw
    const meta = metaFor ? metaFor(rel, buf) : null
    out.push(bufEntry({ section, rel, abs: file.abs, buf, mtimeMs: file.mtimeMs, meta: meta || null }))
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

/**
 * 自定义路径里的文本型配置（yml/json/env/ini/toml）。
 *
 * 这类文件按脱敏口径进同步集合：远端拿到的是去掉明文密钥的副本。
 * 落地时必须走「合并」而不是「整文件覆盖」—— 否则远端副本里的
 * <redacted> 会把本机的真实值顶掉（这是 P0-3 的根因）。
 */
function isTextConfigRel(rel) {
  return /\.(ya?ml|json|env|ini|toml)$/i.test(rel)
}

/** 文本型配置：脱敏后再进同步集合。 */
function redactConfigBuffer(buf) {
  if (!isTextBuffer(buf)) return buf
  return Buffer.from(redactText(buf.toString('utf8')).text, 'utf8')
}

/**
 * 自定义路径分区是否启用。
 *
 * 注意：这个分区不走 settings.sections 开关（界面把自定义路径放在单独的
 * 一组里管，settings.sections.custom 恒为 undefined）。真正的门是
 * customPaths 里有没有启用的项。
 */
export function customEnabled(settings) {
  const paths = settings && Array.isArray(settings.customPaths) ? settings.customPaths : []
  return paths.some((item) => item && item.enabled !== false)
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
      out.push(
        ...(await collectTree({
          section: 'custom',
          root: abs,
          ignore: ['node_modules', '.git'],
          transform: (buf, fileRel) => (isTextConfigRel(fileRel) ? redactConfigBuffer(buf) : buf),
          metaFor: (fileRel, buf) =>
            // 脱敏过的文本配置走「合并」路径；其余文件按普通文件整份写。
            // 一律给 redacted 会让普通文件也被合并，用户文件结构会被改掉。
            isTextConfigRel(fileRel) && isTextBuffer(buf) ? { kind: 'redacted' } : { kind: 'files' },
        })),
      )
    } else if (st.isFile()) {
      const isConfig = isTextConfigRel(rel)
      const entry = await collectFile({
        section: 'custom',
        abs,
        rel,
        transform: isConfig ? redactConfigBuffer : null,
        meta: isConfig ? { kind: 'redacted' } : { kind: 'files' },
      })
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
  custom: collectCustom,
}

/** 采集当前设置下所有启用的 section。 */
export async function collectAll(settings) {
  const entries = []
  const errors = []
  const sections = settingsSections(settings)
  for (const def of SECTION_DEFS) {
    // custom 不听 settings.sections（那把开关恒为 undefined），听 customPaths。
    const enabled = def.id === 'custom' ? customEnabled(settings) : sections[def.id]
    if (!enabled) continue
    try {
      const collected = await COLLECTORS[def.id](settings)
      entries.push(...collected)
    } catch (err) {
      errors.push({ section: def.id, message: String((err && err.message) || err) })
    }
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

const REDACTED_VALUE = '<redacted>'

/** 键值行：`key: value` / `key = value`（带缩进、引号、列表短横线都认）。 */
const KEY_LINE = /^(\s*(?:-\s+)?["']?)([A-Za-z0-9_.-]+)(["']?\s*[:=]\s*)(.*)$/

function buildKeyMap(text) {
  const map = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const m = KEY_LINE.exec(line)
    if (m) map.set(m[2], line)
  }
  return map
}

/** 值是不是脱敏占位符（可能带引号）。 */
function isRedactedValue(value) {
  if (typeof value !== 'string') return false
  return value.trim().replace(/^['"]|['"]$/g, '') === REDACTED_VALUE
}

/** 解析 JSON；不是 JSON 对象/数组就返回 null（走文本合并）。 */
function parseJsonObject(text) {
  const t = String(text || '').trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null
  try {
    const v = JSON.parse(t)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/**
 * 拉取方向的结构化合并（远端是骨架）。
 *
 * - 远端值是 `<redacted>` 的键：用本机同名键的真实值回填；
 * - 本机没有这个键：整个键丢掉（绝不把占位符写进用户的真实配置）；
 * - 本机独有的键：保留（远端没有的键不该被远端骨架抹掉）。
 */
function mergeJsonForPull(remoteNode, localNode, stats) {
  if (Array.isArray(remoteNode)) {
    const localArr = Array.isArray(localNode) ? localNode : []
    return remoteNode.map((item, idx) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return mergeJsonForPull(item, localArr[idx], stats)
      }
      return item
    })
  }
  if (!remoteNode || typeof remoteNode !== 'object') return remoteNode
  const out = {}
  const localObj = localNode && typeof localNode === 'object' && !Array.isArray(localNode) ? localNode : {}
  for (const [key, value] of Object.entries(remoteNode)) {
    if (isRedactedValue(value)) {
      if (Object.prototype.hasOwnProperty.call(localObj, key)) {
        out[key] = localObj[key]
        stats.kept += 1
      } else {
        stats.dropped += 1
      }
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeJsonForPull(value, localObj[key], stats)
      continue
    }
    out[key] = value
  }
  // 本机独有的键保留。
  for (const [key, value] of Object.entries(localObj)) {
    if (Object.prototype.hasOwnProperty.call(remoteNode, key)) continue
    if (Object.prototype.hasOwnProperty.call(out, key)) continue
    out[key] = value
    stats.kept += 1
  }
  return out
}

/**
 * 拉取方向的 JSON 合并。
 *
 * 按行合并会把 JSON 拼坏（缩进不同、键换行、甚至整份文件被压成一行），
 * 所以 JSON 一律按结构合并：远端骨架 + 本机真实值 + 本机独有键。
 */
function mergeRedactedJson(localText, remoteText) {
  const remote = parseJsonObject(remoteText)
  const local = parseJsonObject(localText)
  if (!remote || !local) return null
  const stats = { kept: 0, dropped: 0 }
  const merged = mergeJsonForPull(remote, local, stats)
  if (JSON.stringify(merged) === JSON.stringify(local)) {
    // 合并结果和本机一样 → 原样保留本机文本，不重新格式化用户的文件。
    return { text: String(localText), kept: stats.kept, dropped: stats.dropped, mode: 'json' }
  }
  return { text: JSON.stringify(merged, null, 2) + '\n', kept: stats.kept, dropped: stats.dropped, mode: 'json' }
}

/**
 * 拉取方向的文本合并（YAML / dotenv / TOML / ini 等）。
 *
 * 远端是骨架；远端值是 `<redacted>` 的行用本机同名键的真实值回填，
 * 本机没有这个键就丢掉这一行（宁可少一行，也不把占位符写进真实配置）。
 * 本机独有的顶层键保留 —— 远端没有的键不该被抹掉。
 */
function mergeRedactedLines(localText, remoteText) {
  const localByKey = buildKeyMap(localText || '')
  const remoteKeys = new Set()
  let kept = 0
  let dropped = 0
  const out = []
  for (const line of String(remoteText || '').split(/\r?\n/)) {
    const m = KEY_LINE.exec(line)
    if (m) remoteKeys.add(m[2])
    if (!line.includes(REDACTED_VALUE)) {
      out.push(line)
      continue
    }
    const m2 = m
    const local = m2 ? localByKey.get(m2[2]) : null
    if (local) {
      out.push(local)
      kept += 1
    } else {
      dropped += 1
    }
  }
  // 本机独有的顶层键保留。缩进行不补：嵌套片段接到文件末尾会破坏结构。
  for (const [key, line] of localByKey) {
    if (remoteKeys.has(key)) continue
    if (/^[ \t]/.test(line)) continue
    out.push(line)
    kept += 1
  }
  return { text: out.join('\n'), kept, dropped, mode: 'lines' }
}

/**
 * 拉取方向的合并入口。
 *
 * JSON 走结构化合并，其它文本按行合并。
 */
export function mergeRedactedText(localText, remoteText) {
  const json = mergeRedactedJson(localText, remoteText)
  if (json) return json
  return mergeRedactedLines(localText, remoteText)
}

/** 推送方向的结构化合并：本机为准，远端多出来的键保留。 */
function mergeJsonForPush(remoteNode, localNode) {
  if (!remoteNode || typeof remoteNode !== 'object' || Array.isArray(remoteNode)) return remoteNode
  const out = { ...remoteNode }
  if (!localNode || typeof localNode !== 'object' || Array.isArray(localNode)) return out
  for (const [key, value] of Object.entries(localNode)) {
    const rv = out[key]
    if (value && typeof value === 'object' && !Array.isArray(value) && rv && typeof rv === 'object' && !Array.isArray(rv)) {
      out[key] = mergeJsonForPush(rv, value)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * 推送方向的合并：本机为准，远端多出来的键保留。
 *
 * 远端那份是脱敏副本，本机版本整份盖上去会把远端多出来的配置抹掉；
 * 合并后推送的是「两边的并集」——远端多出来的键还在，本机的改动也带过去。
 */
export function mergeRedactedForPush(localText, remoteText) {
  const local = parseJsonObject(localText)
  const remote = parseJsonObject(remoteText)
  if (local && remote) {
    const merged = mergeJsonForPush(remote, local)
    if (JSON.stringify(merged) === JSON.stringify(local)) {
      return { text: String(localText), changed: false }
    }
    return { text: JSON.stringify(merged, null, 2) + '\n', changed: true }
  }
  const localByKey = buildKeyMap(localText || '')
  const remoteByKey = buildKeyMap(remoteText || '')
  const out = []
  const used = new Set()
  for (const line of String(remoteText || '').split(/\r?\n/)) {
    const m = KEY_LINE.exec(line)
    if (m && !used.has(m[2])) {
      used.add(m[2])
      const local = localByKey.get(m[2])
      if (local) {
        out.push(local)
        continue
      }
    }
    out.push(line)
  }
  for (const [key, line] of localByKey) {
    if (used.has(key) || remoteByKey.has(key)) continue
    if (/^[ \t]/.test(line)) continue
    out.push(line)
  }
  const text = out.join('\n')
  return { text, changed: text !== String(localText || '') }
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
