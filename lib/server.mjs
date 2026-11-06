/** HTTP 路由：全部挂在 /dsh-sync-hub 前缀下，只服务本机界面。 */
const PREFIX = '/dsh-sync-hub'

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
