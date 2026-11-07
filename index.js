/**
 * dsh-sync-hub —— 多机 DSH 配置与会话同步中心。
 *
 * 服务端职责：盘点多机可同步的内容 → 生成 manifest → 经由 local/git/webdav
 * 任一通道推送/拉取 → 写入前备份、冲突可解释。界面在 client.js。
 */
import { createHandler } from './lib/server.mjs'
import { Hub } from './lib/hub.mjs'
import { degradedHub } from './lib/degraded.mjs'
import { registerTools } from './lib/tools.mjs'
import { loadState, saveState, defaultState } from './lib/state.mjs'
import { detectVersion, pluginVersion } from './lib/version.mjs'
import { statePath } from './lib/paths.mjs'
import { pathExists } from './lib/util.mjs'

export const name = 'dsh-sync-hub'
export const inject = ['webServer', 'credentials', 'tools']

const PLUGIN_VERSION = pluginVersion()

export function apply(ctx, config = {}) {
  const logger = {
    info: (message) => {
      try {
        ctx.logger?.info?.(message)
      } catch {
        /* 宿主 logger 不一定有 info */
      }
    },
    warn: (message) => {
      try {
        ctx.logger?.warn?.(message)
      } catch {
        /* 忽略 */
      }
    },
  }
  // Hub 构造失败也不能让插件加载失败 —— 退化成只报错的空壳，界面与工具仍然可用。
  let hub
  try {
    hub = new Hub(ctx, { name, version: PLUGIN_VERSION })
  } catch (err) {
    const message = String((err && err.message) || err)
    logger.warn(`[sync-hub] 初始化失败，已降级为只读模式：${message}`)
    hub = degradedHub(message, { name, version: PLUGIN_VERSION })
  }

  // 首次加载：把 cordis.patch.yml 里的 config 播种成 state.json，之后界面改动为准。
  seedFromConfig(config, logger).catch((err) => logger.warn(`[sync-hub] 初始化设置失败：${err && err.message}`))

  ctx.effect(
    () => {
      try {
        return ctx.webServer.register({
          kind: 'prefix',
          path: '/dsh-sync-hub',
          handler: createHandler(hub, (message) => logger.warn(message)),
        })
      } catch (err) {
        logger.warn(`[sync-hub] HTTP 路由注册失败：${String((err && err.message) || err)}`)
        return () => {}
      }
    },
    'dsh-sync-hub: http routes',
  )

  ctx.effect(
    () => {
      try {
        return registerTools(ctx, hub)
      } catch (err) {
        logger.warn(`[sync-hub] 工具注册失败：${String((err && err.message) || err)}`)
        return () => {}
      }
    },
    'dsh-sync-hub: agent tools',
  )

  detectVersion()
    .then((info) => logger.info(`[sync-hub] 已加载：DSH ${info.version || '未知'}（${info.edition}）`))
    .catch(() => {})

  return () => {
    logger.info('[sync-hub] 已卸载')
  }
}

async function seedFromConfig(config, logger) {
  if (!config || typeof config !== 'object') return
  if (await pathExists(statePath())) return
  const state = defaultState()
  const patch = {
    ...config,
    remote: { ...(config.remote || {}) },
  }
  delete patch.autorun
  const { normalizeSettings } = await import('./lib/state.mjs')
  state.settings = normalizeSettings({ ...state.settings, ...patch, remote: { ...state.settings.remote, ...(patch.remote || {}) } })
  if (state.settings.deviceName) state.device.name = state.settings.deviceName
  await saveState(state)
  logger.info(`[sync-hub] 已写入初始设置：${statePath()}`)
}
