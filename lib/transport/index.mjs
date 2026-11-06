/** 传输通道工厂。引擎只认 base.mjs 定义的接口。 */
import { localTransport } from './local.mjs'
import { gitTransport } from './git.mjs'
import { webdavTransport } from './webdav.mjs'

export { BaseTransport } from './base.mjs'

export function createTransport(settings, credentials = {}) {
  const kind = (settings && settings.transport) || 'local'
  if (kind === 'git') return gitTransport(settings, credentials)
  if (kind === 'webdav') return webdavTransport(settings, credentials)
  return localTransport(settings, credentials)
}
