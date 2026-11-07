/**
 * 本机状态：设备身份 + 用户设置 + 上次同步的基线（sha 表）。
 *
 * 不用 schemastery 声明 Config：本地 link 安装的插件解析不到 asar 里的
 * @deepseek-ai/* 包，配置文件解析会直接失败（同类插件也这么做）。设置存在
 * 自己的 state.json 里，界面写、服务端读，两边同一份。
 */
import { randomUUID } from 'node:crypto'
import { defaultDeviceName, statePath } from './paths.mjs'
import { ensureDir, readJson, writeJson } from './util.mjs'

export const STATE_SCHEMA = 1

export const CREDENTIAL_REF = {
  git: 'sync-hub/git/token',
  webdav: 'sync-hub/webdav/password',
}

export function defaultSettings() {
  return {
    deviceName: '',
    transport: 'local',
    remote: {
      path: '',
      repo: '',
      branch: 'main',
      url: '',
      username: '',
    },
    sections: {
      cordis: true,
      plugins: true,
      skills: true,
      sessions: true,
      workspaces: false,
      pluginData: false,
      // 凭据与密钥默认不同步：用户手动开启后，明文密钥才会随同步上传。
      secrets: false,
      // 插件配置副本：默认不同步（真正的总开关是 pluginConfig.enabled）。
      pluginConfig: false,
    },
    // 插件配置副本（契约 1.3）：只以「副本」形式同步，绝不改写对方的 cordis.patch.yml。
    pluginConfig: {
      enabled: false,
      switches: {},
    },
    customPaths: [],
    sessions: {
      maxBytes: 32 * 1024 * 1024,
      maxAgeDays: 0,
      excludeIds: [],
    },
    // 工作区级开关：key 是工作区的目录名（跨机身份），值为 true/false。
    // 未出现在表里的工作区默认开启。
    workspaces: {
      switches: {},
      // 手动映射：目录名 → 本机实际路径。跨机目录不一样时用它指定对应关系。
      map: {},
    },
    conflictPolicy: 'newest',
    keepBackups: 20,
  }
}

export function defaultState() {
  return {
    schema: STATE_SCHEMA,
    device: {
      id: randomUUID(),
      name: defaultDeviceName(),
      createdAt: new Date().toISOString(),
    },
    settings: defaultSettings(),
    base: {},
    shaCache: {},
    lastPlan: null,
    lastSync: null,
    updatedAt: null,
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export function normalizeSettings(raw) {
  const base = defaultSettings()
  const input = asObject(raw)
  const remote = asObject(input.remote)
  const sections = asObject(input.sections)
  const sessions = asObject(input.sessions)
  const workspaces = asObject(input.workspaces)
  // 插件配置：类型收敛，非法值回落到默认，绝不抛异常（契约 1.3）。
  const pluginConfigRaw = asObject(input.pluginConfig)
  const pluginConfig = {
    enabled: asBool(pluginConfigRaw.enabled, false),
    switches: Object.fromEntries(
      Object.entries(asObject(pluginConfigRaw.switches))
        .filter(([key, value]) => typeof key === 'string' && key && typeof value === 'boolean')
        .slice(0, 500),
    ),
  }
  const transport = ['local', 'git', 'webdav'].includes(input.transport) ? input.transport : base.transport
  const policy = ['newest', 'local', 'remote', 'skip'].includes(input.conflictPolicy)
    ? input.conflictPolicy
    : base.conflictPolicy
  const out = {
    deviceName: asString(input.deviceName, base.deviceName).slice(0, 64),
    transport,
    remote: {
      path: asString(remote.path, '').trim(),
      repo: asString(remote.repo, '').trim(),
      branch: asString(remote.branch, base.remote.branch).trim() || 'main',
      url: asString(remote.url, '').trim(),
      username: asString(remote.username, '').trim(),
    },
    sections: {},
    customPaths: [],
    sessions: {
      maxBytes: asInt(sessions.maxBytes, base.sessions.maxBytes, 0, 4 * 1024 * 1024 * 1024),
      maxAgeDays: asInt(sessions.maxAgeDays, 0, 0, 3650),
      excludeIds: Array.isArray(sessions.excludeIds)
        ? sessions.excludeIds.filter((item) => typeof item === 'string' && item).slice(0, 5000)
        : [],
    },
    workspaces: {
      // 工作区开关：只保留布尔值，键是目录名。
      switches: Object.fromEntries(
        Object.entries(asObject(workspaces.switches))
          .filter(([key, value]) => typeof key === 'string' && key && typeof value === 'boolean')
          .slice(0, 200),
      ),
      // 手动映射：目录名 → 本机路径。
      map: Object.fromEntries(
        Object.entries(asObject(workspaces.map))
          .filter(([key, value]) => typeof key === 'string' && key && typeof value === 'string' && value.trim())
          .map(([key, value]) => [key, value.trim().slice(0, 512)])
          .slice(0, 200),
      ),
    },
    pluginConfig,
    conflictPolicy: policy,
    keepBackups: asInt(input.keepBackups, base.keepBackups, 1, 200),
  }
  for (const key of Object.keys(base.sections)) {
    // 白名单 + 夹紧：sections.secrets 默认 false；旧 state.json 没有这个键
    // 时 asBool 回落成 false，等同于「没开过开关」。
    out.sections[key] = asBool(sections[key], base.sections[key])
  }
  // pluginConfig 的总开关只有一个来源：pluginConfig.enabled。
  // sections.pluginConfig 只是它的镜像（前端「同步范围」页读这个字段）。
  out.sections.pluginConfig = pluginConfig.enabled
  if (Array.isArray(input.customPaths)) {
    out.customPaths = input.customPaths
      .map((item) => {
        if (typeof item === 'string') return { rel: item.trim(), enabled: true }
        const rel = asString(asObject(item).rel, '').trim()
        return { rel, enabled: asBool(asObject(item).enabled, true) }
      })
      .filter((item) => item.rel)
      .slice(0, 50)
  }
  return out
}

/** 「同步凭据与密钥」开关。其它模块统一走这里判断，别处不要重复写路径。 */
export function secretsEnabled(settings) {
  return Boolean(settings && settings.sections && settings.sections.secrets)
}

export function normalizeState(raw) {
  const base = defaultState()
  const input = asObject(raw)
  const device = asObject(input.device)
  return {
    schema: STATE_SCHEMA,
    device: {
      id: asString(device.id, '') || base.device.id,
      name: asString(device.name, '') || defaultDeviceName(),
      createdAt: asString(device.createdAt, base.device.createdAt),
    },
    settings: normalizeSettings(input.settings),
    base: asObject(input.base),
    shaCache: asObject(input.shaCache),
    lastPlan: input.lastPlan && typeof input.lastPlan === 'object' ? input.lastPlan : null,
    lastSync: input.lastSync && typeof input.lastSync === 'object' ? input.lastSync : null,
    updatedAt: asString(input.updatedAt, '') || null,
  }
}

let cached = null

export async function loadState({ refresh = false } = {}) {
  if (cached && !refresh) return cached
  const raw = await readJson(statePath(), null)
  cached = raw ? normalizeState(raw) : defaultState()
  return cached
}

export async function saveState(state) {
  const next = normalizeState(state)
  next.updatedAt = new Date().toISOString()
  cached = next
  await ensureDir(statePath().replace(/[\\/][^\\/]+$/, ''))
  await writeJson(statePath(), next)
  return next
}

/** 只更新设置，保留设备身份与基线。 */
export async function updateSettings(patch) {
  const state = await loadState()
  const incoming = patch || {}
  const merged = {
    ...state.settings,
    ...incoming,
    remote: { ...state.settings.remote, ...(incoming && incoming.remote) },
    // pluginConfig.switches 是「每个插件一个开关」，必须按 key 合并：
    // 前端只发一个 key 时，不能把其它开关抹掉。
    pluginConfig: {
      ...(state.settings.pluginConfig || {}),
      ...(incoming && incoming.pluginConfig ? incoming.pluginConfig : {}),
      switches: {
        ...((state.settings.pluginConfig && state.settings.pluginConfig.switches) || {}),
        ...((incoming && incoming.pluginConfig && incoming.pluginConfig.switches) || {}),
      },
    },
  }
  state.settings = normalizeSettings(merged)
  const name = state.settings.deviceName.trim()
  if (name) state.device.name = name
  return saveState(state)
}

export function stateSummary(state) {
  const sections = Object.entries(state.settings.sections)
    .filter(([, on]) => on)
    .map(([id]) => id)
  return {
    deviceId: state.device.id,
    deviceName: state.device.name,
    transport: state.settings.transport,
    sections,
    entries: Object.keys(state.base).length,
    lastSync: state.lastSync,
    updatedAt: state.updatedAt,
  }
}
