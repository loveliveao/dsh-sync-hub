/** HTTP 路由：全部挂在 /dsh-sync-hub 前缀下，只服务本机界面。 */
const PREFIX = '/dsh-sync-hub'

/* ---------- 访问控制（P0-1：接口零鉴权 + 无 Origin 校验） ---------- */

/** 只接受回环地址：宿主 webServer 只监听 127.0.0.1，挡掉 DNS rebinding 之类的伪造 Host。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
/** 浏览器同源标记：同源 / 同站 / 直接访问算合法，跨站一律拒绝。 */
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'same-site', 'none'])

function headersOf(req) {
  const headers = req && req.headers
  return headers && typeof headers === 'object' ? headers : {}
}

function hostOf(req) {
  const raw = String(headersOf(req).host || '').trim()
  if (!raw) return null
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw)
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : null }
  const index = raw.lastIndexOf(':')
  if (index === -1) return { host: raw, port: null }
  return { host: raw.slice(0, index), port: Number(raw.slice(index + 1)) || null }
}

function isLoopback(host) {
  const value = String(host || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  return LOOPBACK_HOSTS.has(value)
}

function portOf(url) {
  if (url.port) return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

/** 判断绝对地址是否指向本机、且与本请求同端口。 */
function sameLocalOrigin(value, req) {
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (!isLoopback(url.hostname)) return false
  const host = hostOf(req)
  if (!host || host.port == null) return true
  return portOf(url) === host.port
}

/** 除 JSON 外一律不收：跨站简单请求会带 text/plain，逼它走预检。 */
function isJsonContentType(req) {
  const raw = String(headersOf(req)['content-type'] || '').toLowerCase()
  const type = raw.split(';')[0].trim()
  return type === 'application/json' || type.endsWith('+json')
}

/** 宿主鉴权服务（可选）：拿不到就退回本地同源校验，绝不因此崩。 */
function connectionOf(hub) {
  try {
    const ctx = hub && hub.ctx
    if (!ctx || typeof ctx.get !== 'function') return null
    const connection = ctx.get('connection')
    return connection && typeof connection.requestRejection === 'function' ? connection : null
  } catch {
    return null
  }
}

/**
 * 访问控制：宿主鉴权优先，其次同源校验，最后 JSON 内容类型。
 * 返回 null 表示放行，否则返回 { code, error }。
 */
export function checkAccess(hub, req, method) {
  const connection = connectionOf(hub)
  if (connection) {
    try {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined && rejection !== null) {
        const code = Number(rejection) === 401 ? 401 : 403
        return { code, error: code === 401 ? '未授权访问本机同步接口' : '请求来源不被信任' }
      }
    } catch {
      /* 宿主服务异常时退回本地校验 */
    }
  }

  const headers = headersOf(req)
  const site = String(headers['sec-fetch-site'] || '').toLowerCase()
  if (site && !ALLOWED_FETCH_SITES.has(site)) {
    return { code: 403, error: '检测到跨站请求，已拒绝' }
  }
  const host = hostOf(req)
  if (host && !isLoopback(host.host)) {
    return { code: 403, error: '只接受本机访问' }
  }
  const origin = String(headers.origin || '').trim()
  if (origin) {
    if (!sameLocalOrigin(origin, req)) {
      return { code: 403, error: '请求来源不是本机同源地址，已拒绝' }
    }
  } else {
    const referer = String(headers.referer || '').trim()
    if (referer) {
      let refererOrigin = ''
      try {
        refererOrigin = new URL(referer).origin
      } catch {
        refererOrigin = ''
      }
      if (refererOrigin && !sameLocalOrigin(refererOrigin, req)) {
        return { code: 403, error: '请求来源不是本机同源地址，已拒绝' }
      }
    }
  }
  if (String(method || 'GET').toUpperCase() === 'POST' && !isJsonContentType(req)) {
    return { code: 415, error: '请求必须使用 application/json' }
  }
  return null
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

export function createHandler(hub, log = () => {}) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh')
    let path = url.pathname
    if (path.startsWith(PREFIX)) path = path.slice(PREFIX.length)
    if (!path || path === '/') path = '/state'
    const method = (req.method || 'GET').toUpperCase()

    const denied = checkAccess(hub, req, method)
    if (denied) {
      log(`[dsh-sync-hub] 拒绝 ${method} ${path}：${denied.error}`)
      sendJson(res, denied.code, { ok: false, error: denied.error })
      return
    }

    try {
      if (method === 'GET' && (path === '/state' || path === '/status')) {
        const probeRemote = url.searchParams.get('remote') === '1'
        sendJson(res, 200, { ok: true, data: await hub.status({ probeRemote }) })
        return
      }
      if (method === 'GET' && path === '/sessions') {
        sendJson(res, 200, { ok: true, data: await hub.sessions() })
        return
      }
      if (method === 'GET' && path === '/analysis') {
        const result = await hub.analysis()
        sendJson(res, result.ok ? 200 : 200, result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error })
        return
      }
      if (method === 'GET' && path === '/workspaces') {
        const result = await hub.workspaces()
        sendJson(res, 200, result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error })
        return
      }
      if (method === 'GET' && path === '/plugins') {
        sendJson(res, 200, { ok: true, data: await hub.plugins() })
        return
      }
      if (method === 'GET' && path === '/backups') {
        sendJson(res, 200, { ok: true, data: await hub.backups() })
        return
      }
      if (method === 'POST' && path === '/settings') {
        const body = await readBody(req)
        const state = await hub.saveSettings(body.settings || body)
        sendJson(res, 200, { ok: true, data: { settings: state.settings, device: state.device } })
        return
      }
      if (method === 'POST' && path === '/secret') {
        const body = await readBody(req)
        const result = await hub.setSecret(body.kind, body.value)
        sendJson(res, 200, { ok: true, data: result })
        return
      }
      if (method === 'POST' && path === '/test') {
        sendJson(res, 200, { ok: true, data: await hub.test() })
        return
      }
      if (method === 'POST' && path === '/plan') {
        const result = await hub.plan()
        sendJson(res, result.ok ? 200 : 500, result)
        return
      }
      if (method === 'POST' && path === '/run') {
        const result = await hub.run()
        sendJson(res, result.ok ? 200 : 500, result)
        return
      }
      sendJson(res, 404, { ok: false, error: `未知路由：${method} ${path}` })
    } catch (err) {
      const message = String((err && err.message) || err)
      log(`[dsh-sync-hub] ${method} ${path} 失败：${message}`)
      sendJson(res, 500, { ok: false, error: message })
    }
  }
}
