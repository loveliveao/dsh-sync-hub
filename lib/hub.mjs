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
import { currentProfile, dshHome, profilePackageJson } from './paths.mjs'
import { formatBytes, readJson, sha256 } from './util.mjs'

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
        const tree = await mod.buildTree({ settings: state.settings, base: state.base, ctx: this.ctx })
        return { ok: true, data: tree }
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
    return { ok: false, error: '工作区模块不可用' }
  }


  /**
   * 插件清单（契约 1.1）：每个插件一行，含配置摘要与「配置副本」的同步状态。
   *
   * 注意：这里只**读** profile 的 cordis.patch.yml 与 package.json，
   * 不会写回任何 DSH 配置。
   */
  async plugins() {
    const empty = {
      generatedAt: new Date().toISOString(),
      plugins: [],
      totals: { plugins: 0, withConfig: 0, enabled: 0 },
    }
    try {
      const state = await loadState()
      const settings = state.settings || {}
      const conf = settings.pluginConfig || {}
      const switches = conf.switches && typeof conf.switches === 'object' ? conf.switches : {}
      const mod = await import('./plugin-config.mjs')
      const { loadPluginConfigs, renderPluginConfigYaml, normalizePluginVersion } = mod
      const configs = await loadPluginConfigs()
      const pkg = await readJson(profilePackageJson())
      const deps = pkg && pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
      const byKey = new Map()
      for (const item of configs) {
        if (item && item.key) byKey.set(item.key, item)
      }
      const ws = await import('./workspaces.mjs')
      const compareWithBase = typeof ws.compareWithBase === 'function' ? ws.compareWithBase : null
      const base = state.base || {}
      const keys = new Set([...Object.keys(deps), ...byKey.keys()])
      const list = []
      for (const key of keys) {
        const item = byKey.get(key) || null
        const hasConfig = Boolean(item && item.hasConfig)
        const syncEnabled = switches[key] === true
        let bytes = 0
        let text = ''
        if (hasConfig) {
          try {
            text = renderPluginConfigYaml(item)
            bytes = Buffer.byteLength(text, 'utf8')
          } catch {
            text = ''
            bytes = 0
          }
        }
        // 状态：没配置 / 没开开关 -> off；开了就拿本地 sha 和基线比。
        let pluginState = 'off'
        if (hasConfig && conf.enabled && syncEnabled && compareWithBase) {
          const cmp = compareWithBase('plugin-config:' + key, sha256(Buffer.from(text, 'utf8')), base)
          // 契约 3.6 的徽章只有 synced/changed/pending/off，没有 new。
          pluginState = cmp === 'new' ? 'pending' : cmp
        }
        list.push({
          key,
          name: (item && item.name) || key,
          version: normalizePluginVersion(deps[key]),
          installed: Object.prototype.hasOwnProperty.call(deps, key),
          hasConfig,
          configKeys: (item && item.configKeys) || [],
          configPaths: (item && item.configPaths) || [],
          config: (item && item.config) || null,
          redacted: Boolean(item && item.redacted),
          state: pluginState,
          syncEnabled,
          bytes,
        })
      }
      list.sort((a, b) => String(a.name).localeCompare(String(b.name)))
      return {
        generatedAt: new Date().toISOString(),
        plugins: list,
        totals: {
          plugins: list.length,
          withConfig: list.filter((item) => item.hasConfig).length,
          enabled: list.filter((item) => item.syncEnabled).length,
        },
      }
    } catch (err) {
      return { ...empty, error: String((err && err.message) || err) }
    }
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
        const result = await runSync({ state: context.state, transport, version, ctx: this.ctx })
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
