/**
 * Hub：把 state / 凭据 / 通道 / 引擎粘在一起，HTTP 路由与工具都只调它。
 * 所有写操作都串行化，避免两个请求同时跑同步把 files 写花。
 */
import { createTransport } from './transport/index.mjs'
import { CREDENTIAL_REF, loadState, saveState, updateSettings } from './state.mjs'
import { buildPlan, readBackupIndex, runSync, snapshot } from './engine.mjs'
import { detectVersion, installedPlugins } from './version.mjs'
import { listSessions, SECTION_DEFS } from './sections.mjs'
import { manifestStats, normalizeManifest } from './manifest.mjs'
import { currentProfile, dshHome } from './paths.mjs'
import { formatBytes } from './util.mjs'

export class Hub {
  constructor(ctx, { name = 'dsh-sync-hub', version = '0.1.0' } = {}) {
    this.ctx = ctx
    this.name = name
    this.pluginVersion = version
    this.queue = Promise.resolve()
    this.lastError = null
  }

  /** 串行执行，避免并发同步。 */
  serialize(fn) {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async versionInfo(refresh = false) {
    return detectVersion({ refresh })
  }

  async secrets() {
    const out = { git: '', webdav: '' }
    for (const [kind, ref] of Object.entries(CREDENTIAL_REF)) {
      try {
        const resolved = await this.ctx.credentials.resolve(ref)
        out[kind] = resolved && resolved.value ? String(resolved.value) : ''
      } catch {
        out[kind] = ''
      }
    }
    return out
  }

  async secretStatus() {
    const secrets = await this.secrets()
    return { git: Boolean(secrets.git), webdav: Boolean(secrets.webdav) }
  }

  async setSecret(kind, value) {
    const ref = CREDENTIAL_REF[kind]
    if (!ref) throw new Error(`未知的凭据类型：${kind}`)
    const trimmed = String(value || '').trim()
    if (!trimmed) {
      await this.ctx.credentials.unset(ref)
      return { ok: true, cleared: true }
    }
    await this.ctx.credentials.set(ref, trimmed)
    return { ok: true, saved: true, length: trimmed.length }
  }

  async context() {
    const state = await loadState()
    const secrets = await this.secrets()
    const transport = createTransport(state.settings, secrets)
    return { state, transport }
  }

  /**
   * 本机现状分析（工作区 / 插件 / 技能 / 会话 / 跳过的体积 / 凭据文件）。
   * 用动态 import：analysis 模块是可选增强，缺席时不影响其它功能。
   */
  async analysis() {
    try {
      const mod = await import('./analysis.mjs')
      if (mod && typeof mod.analyzeLocal === 'function') {
        const result = await mod.analyzeLocal({ dshHome: dshHome(), profile: currentProfile() })
        return { ok: true, data: result }
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
    return { ok: false, error: '本机分析模块不可用' }
  }

  /** 密钥同步清单：开了哪些、会连哪些文件一起传过去。 */
  async secretsManifest(settings) {
    try {
      const mod = await import('./sections.mjs')
      if (mod && typeof mod.secretsManifest === 'function') {
        return mod.secretsManifest(settings)
      }
    } catch {
      /* ignore */
    }
    return { enabled: Boolean(settings && settings.sections && settings.sections.secrets), files: [] }
  }

  /**
   * 工作区树：工作区 → 下面的会话，每条标「同步 / 不同步」和原因。
   * 界面用它渲染「本机现状」清单。
   */
  async workspaces() {
    try {
      const state = await loadState()
      const mod = await import('./workspaces.mjs')
      if (mod && typeof mod.buildTree === 'function') {
        const tree = await mod.buildTree({ settings: state.settings, base: state.base })
        return { ok: true, data: tree }
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
    return { ok: false, error: '工作区模块不可用' }
  }

  async status({ probeRemote = false } = {}) {
    const state = await loadState()
    const secrets = await this.secrets()
    const transport = createTransport(state.settings, secrets)
    const version = await this.versionInfo()
    const snap = await snapshot({ state, version, transport })
    const plugins = await installedPlugins()
    let remote = null
    let remoteError = null
    if (probeRemote) {
      try {
        await transport.open()
        const manifest = normalizeManifest(await transport.readManifest())
        remote = {
          stats: manifestStats(manifest),
          devices: manifest.devices,
          updatedAt: manifest.updatedAt,
          sample: Object.values(manifest.entries)
            .map((entry) => ({ section: entry.section, rel: entry.rel, bytes: entry.bytes, updatedAt: entry.updatedAt }))
            .slice(0, 200),
        }
      } catch (err) {
        remoteError = String((err && err.message) || err)
      }
    }
    return {
      plugin: { name: this.name, version: this.pluginVersion },
      dshHome: dshHome(),
      version,
      device: { id: state.device.id, name: state.device.name },
      transport: transport.kind,
      target: transport.describe(),
      settings: state.settings,
      sections: snap.sections,
      sectionDefs: SECTION_DEFS,
      local: snap.local,
      plugins,
      secrets: await this.secretStatus(),
      secretFiles: await this.secretsManifest(state.settings),
      remote,
      remoteError,
      lastPlan: state.lastPlan,
      lastSync: state.lastSync,
      backups: (await readBackupIndex()).slice(0, 10),
      updatedAt: state.updatedAt,
      lastError: this.lastError,
      bytesLabel: formatBytes(snap.local.bytes),
    }
  }

  async saveSettings(patch) {
    const state = await updateSettings(patch || {})
    return state
  }

  async test() {
    const { state, transport } = await this.context()
    const result = await transport.test()
    return { ...result, transport: transport.kind, target: transport.describe(), settings: state.settings }
  }

  plan() {
    return this.serialize(async () => {
      let transport = null
      try {
        const context = await this.context()
        transport = context.transport
        const version = await this.versionInfo()
        const built = await buildPlan({ state: context.state, transport, version, persist: true })
        await saveState(context.state)
        return { ok: true, plan: built.plan }
      } catch (err) {
        this.lastError = String((err && err.message) || err)
        return { ok: false, error: this.lastError }
      } finally {
        if (transport) await transport.dispose().catch(() => {})
      }
    })
  }

  run() {
    return this.serialize(async () => {
      let transport = null
      try {
        const context = await this.context()
        transport = context.transport
        const version = await this.versionInfo()
        const result = await runSync({ state: context.state, transport, version })
        await saveState(context.state)
        this.lastError = result.ok ? null : result.failures.map((item) => `${item.rel}: ${item.message}`).join('; ')
        return { ok: result.ok, result }
      } catch (err) {
        this.lastError = String((err && err.message) || err)
        return { ok: false, error: this.lastError }
      } finally {
        if (transport) await transport.dispose().catch(() => {})
      }
    })
  }

  async sessions() {
    const state = await loadState()
    const list = await listSessions({})
    const synced = new Set(
      Object.keys(state.base || {})
        .filter((id) => id.startsWith('sessions:'))
        .map((id) => id.split('/').slice(-2, -1)[0]),
    )
    return {
      sessions: list.map((item) => ({ ...item, synced: synced.has(item.sessionId) })),
      total: list.length,
      bytes: list.reduce((sum, item) => sum + item.bytes, 0),
    }
  }

  async backups() {
    const folders = await readBackupIndex()
    return { folders: folders.slice(0, 30) }
  }
}
