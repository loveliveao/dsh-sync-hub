/**
 * 同步库 manifest。所有设备共用一份，结构刻意保持扁平：
 *
 * {
 *   schema: 1,
 *   hub: 'dsh-sync-hub',
 *   updatedAt,
 *   devices: { <deviceId>: { name, platform, dshVersion, profile, sections, lastSeen } },
 *   entries: {
 *     <entryId>: { id, section, rel, sha, bytes, mtimeMs, updatedBy, updatedAt, meta }
 *   }
 * }
 *
 * entries 里永远不出现文件内容，只有路径与 sha256。
 */

export const SCHEMA = 1
export const HUB_ID = 'dsh-sync-hub'

export function emptyManifest() {
  return { schema: SCHEMA, hub: HUB_ID, updatedAt: new Date().toISOString(), devices: {}, entries: {} }
}

export function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object') return emptyManifest()
  const entries = {}
  const source = raw.entries && typeof raw.entries === 'object' ? raw.entries : {}
  for (const [id, value] of Object.entries(source)) {
    if (!value || typeof value !== 'object') continue
    if (typeof value.sha !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha)) continue
    if (typeof value.rel !== 'string' || !value.rel) continue
    entries[id] = {
      id,
      section: typeof value.section === 'string' ? value.section : String(id).split(':')[0],
      rel: value.rel,
      sha: value.sha,
      bytes: Number(value.bytes) || 0,
      mtimeMs: Number(value.mtimeMs) || 0,
      updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy : '',
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
      meta: value.meta && typeof value.meta === 'object' ? value.meta : null,
    }
  }
  const devices = {}
  const rawDevices = raw.devices && typeof raw.devices === 'object' ? raw.devices : {}
  for (const [id, value] of Object.entries(rawDevices)) {
    if (!value || typeof value !== 'object') continue
    devices[id] = {
      name: String(value.name || ''),
      platform: String(value.platform || ''),
      dshVersion: String(value.dshVersion || ''),
      profile: String(value.profile || ''),
      sections: Array.isArray(value.sections) ? value.sections : [],
      lastSeen: String(value.lastSeen || ''),
    }
  }
  return {
    schema: SCHEMA,
    hub: HUB_ID,
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
    devices,
    entries,
  }
}

/** 浅拷贝一条 entry（不含 blob），用于写进 manifest。 */
export function manifestEntry(entry, { deviceId, deviceName }) {
  const now = new Date().toISOString()
  return {
    id: entry.id,
    section: entry.section,
    rel: entry.rel,
    sha: entry.sha,
    bytes: entry.bytes,
    mtimeMs: entry.mtimeMs,
    updatedBy: deviceName ? `${deviceName} (${deviceId})` : deviceId,
    updatedAt: now,
    meta: entry.meta || null,
  }
}

/** 本机在 manifest 里的设备记录。 */
export function deviceRecord({ deviceId, deviceName, version, sections }) {
  return {
    name: deviceName,
    platform: `${process.platform}/${process.arch}`,
    dshVersion: version || 'unknown',
    profile: process.env.DSH_PROFILE || 'desktop',
    sections,
    lastSeen: new Date().toISOString(),
  }
}

export function manifestStats(manifest) {
  const entries = Object.values(manifest.entries || {})
  const bySection = {}
  let bytes = 0
  for (const entry of entries) {
    bySection[entry.section] = (bySection[entry.section] || 0) + 1
    bytes += entry.bytes || 0
  }
  return {
    entries: entries.length,
    bytes,
    devices: Object.keys(manifest.devices || {}).length,
    bySection,
  }
}
