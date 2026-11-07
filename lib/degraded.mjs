/**
 * 降级 Hub：当真正的 Hub 构造失败时接管所有对外接口。
 *
 * 目的：插件初始化失败不该把宿主的问题放大成崩溃或白屏。
 * 除「写操作」外，所有方法都返回结构化结果（不抛异常），
 * 界面与 Agent 工具都能拿到一句可读的说明。
 */
import { dshHome } from './paths.mjs'

function errorText(err) {
  if (err === null || err === undefined) return '未知错误'
  return String((err && err.message) || err)
}

/**
 * 造一个「只报错」的 Hub 替身。
 * @param {unknown} reason 初始化失败的原因
 */
export function degradedHub(reason, { name = 'dsh-sync-hub', version = '0.0.0' } = {}) {
  const message = `同步中心初始化失败：${errorText(reason)}`
  return {
    degraded: true,
    lastError: message,
    async status() {
      return {
        plugin: { name, version },
        dshHome: dshHome(),
        version: { version: null, edition: 'unknown', node: process.version },
        device: { id: '00000000', name: '未知' },
        transport: 'local',
        target: '',
        settings: {},
        sections: [],
        sectionDefs: [],
        local: { entries: 0, bytes: 0 },
        plugins: [],
        secrets: { git: false, webdav: false },
        secretFiles: { enabled: false, files: [] },
        remote: null,
        remoteError: message,
        lastPlan: null,
        lastSync: null,
        backups: [],
        updatedAt: null,
        lastError: message,
        bytesLabel: '—',
      }
    },
    async sessions() {
      return { sessions: [], total: 0, bytes: 0 }
    },
    async analysis() {
      return { ok: false, error: message }
    },
    async workspaces() {
      return { ok: false, error: message }
    },
    async backups() {
      return { folders: [] }
    },
    async plugins() {
      return {
        generatedAt: new Date().toISOString(),
        plugins: [],
        totals: { plugins: 0, withConfig: 0, enabled: 0 },
        error: message,
      }
    },
    async saveSettings() {
      throw new Error(message)
    },
    async setSecret() {
      throw new Error(message)
    },
    async test() {
      return { ok: false, error: message, steps: [] }
    },
    async plan() {
      return { ok: false, error: message }
    },
    async run() {
      return { ok: false, error: message }
    },
  }
}
