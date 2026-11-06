/**
 * WebDAV 通道：坚果云 / Nextcloud / 群晖 / Alist 都支持的通用协议。
 * 只用 GET / PUT / MKCOL / PROPFIND，不依赖第三方库。
 */
import { BaseTransport } from './base.mjs'

function trimBase(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

export class WebdavTransport extends BaseTransport {
  constructor(settings, credentials = {}) {
    super(settings, credentials)
    this.base = trimBase(settings.remote && settings.remote.url)
    this.username = String((settings.remote && settings.remote.username) || '').trim()
    this.password = String(credentials.webdav || '')
  }

  get kind() {
    return 'webdav'
  }

  describe() {
    return this.base || '（未设置 WebDAV 地址）'
  }

  headers(extra = {}) {
    const headers = { ...extra }
    if (this.username || this.password) {
      headers.authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64')}`
    }
    return headers
  }

  urlFor(rel) {
    if (!this.base) throw new Error('还没有设置 WebDAV 地址')
    return `${this.base}/${rel.split('/').map(encodeURIComponent).join('/')}`
  }

  async request(url, init = {}) {
    const res = await fetch(url, {
      ...init,
      headers: this.headers(init.headers),
      signal: AbortSignal.timeout(30000),
    })
    return res
  }

  async getFile(rel, { head = false } = {}) {
    const res = await this.request(this.urlFor(rel), { method: head ? 'HEAD' : 'GET' })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`WebDAV 读取失败 ${res.status}：${rel}`)
    if (head) return Buffer.alloc(0)
    return Buffer.from(await res.arrayBuffer())
  }

  async ensureDir(rel) {
    const parts = rel.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      const res = await this.request(this.urlFor(current), { method: 'MKCOL' })
      if (![201, 405, 301].includes(res.status)) {
        // 409 = 父目录不存在（上一轮已建），其余视为失败
        if (res.status === 409) continue
        throw new Error(`WebDAV 建目录失败 ${res.status}：${current}`)
      }
    }
  }

  async putFile(rel, buf) {
    const slash = rel.lastIndexOf('/')
    if (slash > 0) await this.ensureDir(rel.slice(0, slash))
    const res = await this.request(this.urlFor(rel), { method: 'PUT', body: buf })
    if (![200, 201, 204].includes(res.status)) {
      throw new Error(`WebDAV 写入失败 ${res.status}：${rel}`)
    }
  }

  async test() {
    if (!this.base) return { ok: false, message: '未设置 WebDAV 地址' }
    try {
      const res = await this.request(this.base, {
        method: 'PROPFIND',
        headers: { depth: '0', 'content-type': 'application/xml' },
      })
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: '认证失败：检查用户名/密码（或应用专用密码）' }
      }
      if (res.status === 404) {
        await this.ensureDir('')
        return { ok: true, message: `目录不存在，已尝试创建：${this.base}` }
      }
      if (!res.ok && res.status !== 207) {
        return { ok: false, message: `连接失败：HTTP ${res.status}` }
      }
      const manifest = await this.readManifest()
      const detail = manifest
        ? `已有 ${Object.keys(manifest.entries || {}).length} 个条目，来自 ${Object.keys(manifest.devices || {}).length} 台设备`
        : '目录可访问，还没有同步库'
      return { ok: true, message: `可访问：${this.base}`, detail }
    } catch (err) {
      return { ok: false, message: String((err && err.message) || err) }
    }
  }
}

export function webdavTransport(settings, credentials) {
  return new WebdavTransport(settings, credentials)
}
