/**
 * WebDAV 通道：坚果云 / Nextcloud / 群晖 / Alist 都支持的通用协议。
 * 只用 GET / PUT / MKCOL / PROPFIND，不依赖第三方库。
 */
import { BaseTransport, buildTestResult, errText, makeStep, skipStep } from './base.mjs'

function trimBase(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

/** 把 HTTP 状态码翻译成可行动的原因。 */
function classifyDavStatus(status) {
  if (status === 401) return '认证失败：用户名或密码不对（或该服务器用其他认证方式）'
  if (status === 403) return '已认证但没有该目录的写权限'
  if (status === 405) return '这个服务器不允许 PUT 写入（可能不是 WebDAV 目录）'
  if (status === 404) return '目录不存在（首次同步创建目录后才会写入）'
  if (status === 507) return '服务器存储空间不足'
  if (status >= 500) return `服务器错误 HTTP ${status}`
  return `写入失败 HTTP ${status}`
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

  /**
   * WebDAV「测试连接」：分步说清楚在测什么、测到哪一步、为什么失败。
   * 绝不抛异常——任何一步失败都只会让结果变成 ok:false。
   */
  async test() {
    const steps = []
    let failReason = ''

    if (!this.base) {
      steps.push(makeStep('url', '地址格式与可达', false, '还没有设置 WebDAV 地址'))
      steps.push(skipStep('auth', '认证', '地址未设置'))
      steps.push(skipStep('dir', '目录存在', '地址未设置'))
      steps.push(skipStep('write', '可写', '地址未设置'))
      steps.push(skipStep('hub', '同步库状态', '地址未设置'))
      return buildTestResult(steps, { message: '未设置 WebDAV 地址' })
    }

    /* 1. 地址格式与可达 ------------------------------------------------- */
    let parsed = null
    try {
      parsed = new URL(this.base)
    } catch {
      parsed = null
    }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      steps.push(makeStep('url', '地址格式与可达', false, `地址必须以 http:// 或 https:// 开头：${this.base}`))
      steps.push(skipStep('auth', '认证', '地址格式不对'))
      steps.push(skipStep('dir', '目录存在', '地址格式不对'))
      steps.push(skipStep('write', '可写', '地址格式不对'))
      steps.push(skipStep('hub', '同步库状态', '地址格式不对'))
      return buildTestResult(steps, { message: `地址格式不对：${this.base}` })
    }

    let res = null
    let fetchError = ''
    try {
      res = await this.request(this.base, {
        method: 'PROPFIND',
        headers: { depth: '0', 'content-type': 'application/xml' },
      })
    } catch (err) {
      fetchError = errText(err)
    }
    if (!res) {
      const reason = /fetch failed/i.test(fetchError) ? '网络不通或域名解析失败' : fetchError
      failReason = reason
      steps.push(makeStep('url', '地址格式与可达', false, `连不上服务器：${reason}`))
      steps.push(skipStep('auth', '认证', '连不上服务器'))
      steps.push(skipStep('dir', '目录存在', '连不上服务器'))
      steps.push(skipStep('write', '可写', '连不上服务器'))
      steps.push(skipStep('hub', '同步库状态', '连不上服务器'))
      return buildTestResult(steps, { message: `连接失败：${reason}` })
    }
    steps.push(makeStep('url', '地址格式与可达', true, `服务器已响应：HTTP ${res.status}`))

    /* 2. 认证 ----------------------------------------------------------- */
    let authOk = true
    let authDetail = ''
    if (res.status === 401) {
      authOk = false
      authDetail = '认证失败：用户名或密码不对（或该服务器用其他认证方式）'
      failReason = '认证失败'
    } else if (res.status === 403) {
      authOk = false
      authDetail = '已认证但没有该目录的写权限'
      failReason = '没有该目录的写权限'
    } else {
      authDetail = this.username
        ? `已配置用户名「${this.username}」，服务器返回 HTTP ${res.status}`
        : '未配置用户名和密码，服务器允许匿名访问'
    }
    steps.push(makeStep('auth', '认证', authOk, authDetail, authOk ? 'info' : 'error'))

    /* 3. 目录存在 ------------------------------------------------------- */
    let dirOk = false
    let dirExists = false
    if (!authOk) {
      steps.push(skipStep('dir', '目录存在', '认证没过，无法继续检查目录'))
    } else if (res.status === 404) {
      dirOk = true
      dirExists = false
      steps.push(makeStep('dir', '目录存在', true, `目录不存在：${this.base}；首次同步会自动创建`, 'warn'))
    } else if (res.ok) {
      dirOk = true
      dirExists = true
      steps.push(makeStep('dir', '目录存在', true, `目录已存在：${this.base}`))
    } else {
      failReason = failReason || `服务器返回 HTTP ${res.status}`
      steps.push(makeStep('dir', '目录存在', false, `服务器返回 HTTP ${res.status}`))
    }

    /* 4. 可写 ----------------------------------------------------------- */
    const probeName = `.dsh-sync-hub-probe-${process.pid}`
    if (!authOk) {
      steps.push(skipStep('write', '可写', '认证没过，无法验证写入'))
    } else if (!dirOk) {
      steps.push(skipStep('write', '可写', '目录检查失败'))
    } else if (!dirExists) {
      steps.push(makeStep('write', '可写', true, '目录还不存在，未能实际写入（首次同步创建目录后再验证）', 'warn'))
    } else {
      const probeUrl = this.urlFor(probeName)
      let putRes = null
      let putErr = ''
      try {
        putRes = await this.request(probeUrl, {
          method: 'PUT',
          body: String(Date.now()),
          headers: { 'content-type': 'text/plain' },
        })
      } catch (err) {
        putErr = errText(err)
      }
      if (!putRes) {
        failReason = failReason || `写入失败：${putErr}`
        steps.push(makeStep('write', '可写', false, `写入失败：${putErr}`))
      } else if (![200, 201, 204].includes(putRes.status)) {
        failReason = failReason || classifyDavStatus(putRes.status)
        steps.push(makeStep('write', '可写', false, `${classifyDavStatus(putRes.status)}（HTTP ${putRes.status}）`))
      } else {
        let delRes = null
        try {
          delRes = await this.request(probeUrl, { method: 'DELETE' })
        } catch {
          delRes = null
        }
        if (delRes && [200, 202, 204].includes(delRes.status)) {
          steps.push(makeStep('write', '可写', true, `已写入并删除探针文件 ${probeName}`))
        } else {
          steps.push(
            makeStep(
              'write',
              '可写',
              true,
              `探针文件写入成功，但删除失败（HTTP ${delRes ? delRes.status : '网络错误'}），请手动删除 ${probeName}`,
              'warn',
            ),
          )
        }
      }
    }

    /* 5. 同步库状态 ----------------------------------------------------- */
    let hubDetail = ''
    if (!authOk) {
      steps.push(skipStep('hub', '同步库状态', '认证没过'))
    } else if (!dirOk) {
      steps.push(skipStep('hub', '同步库状态', '目录检查失败'))
    } else {
      try {
        const manifest = await this.readManifest()
        hubDetail = manifest
          ? `已有 ${Object.keys(manifest.entries || {}).length} 个条目，来自 ${Object.keys(manifest.devices || {}).length} 台设备`
          : '目录可访问，还没有同步库'
        steps.push(makeStep('hub', '同步库状态', true, hubDetail))
      } catch (err) {
        steps.push(makeStep('hub', '同步库状态', false, `无法读取远端 manifest：${errText(err)}`))
        failReason = failReason || '远端 manifest 读不出来'
      }
    }

    /* 汇总 -------------------------------------------------------------- */
    const result = buildTestResult(steps, { message: '', detail: hubDetail })
    if (result.ok) {
      result.message = dirExists ? `可访问：${this.base}` : `目录不存在，首次同步会自动创建：${this.base}`
    } else {
      result.message = `WebDAV 不可用：${failReason || '检查没通过'}`
    }
    return result
  }
}

export function webdavTransport(settings, credentials) {
  return new WebdavTransport(settings, credentials)
}
