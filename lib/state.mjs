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
    },
    customPaths: [],
    sessions: {
      maxBytes: 32 * 1024 * 1024,
      maxAgeDays: 0,
      excludeIds: [],
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
    conflictPolicy: policy,
    keepBackups: asInt(input.keepBackups, base.keepBackups, 1, 200),
  }
  for (const key of Object.keys(base.sections)) {
    out.sections[key] = asBool(sections[key], base.sections[key])
  }
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
  state.settings = normalizeSettings({ ...state.settings, ...(patch || {}), remote: { ...state.settings.remote, ...(patch && patch.remote) } })
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
