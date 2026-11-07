/**
 * P0-1 访问控制回归测试：/dsh-sync-hub 同步接口必须只服务本机同源请求。
 *
 *   node tests/security.test.mjs
 */
import { createHandler, checkAccess } from '../lib/server.mjs'

let failures = 0
function check(label, ok, detail = '') {
  if (ok) console.log('  \u2713 ' + label)
  else {
    failures += 1
    console.log('  \u2717 ' + label + (detail ? ' \u2014 ' + detail : ''))
  }
}

/** 假响应：只记录状态码与正文。 */
function fakeRes() {
  const res = { code: 0, headers: {}, body: '' }
  res.writeHead = (code, headers) => {
    res.code = code
    res.headers = headers || {}
    return res
  }
  res.end = (text) => {
    res.body = String(text ?? '')
    return res
  }
  return res
}

/** 假请求：body 以异步迭代器形式提供，兼容 readBody。 */
function fakeReq(method, { url = '/dsh-sync-hub/state', headers = {}, body = '' } = {}) {
  return {
    url,
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body)
    },
  }
}

/** 假 hub：只需要访问控制用到的 ctx 与被放行后才会碰到的读接口。 */
function fakeHub(connection) {
  return {
    ctx: {
      get(name) {
        if (name === 'connection' && connection) return connection
        throw new Error('service not found: ' + name)
      },
    },
    status: async () => ({ ok: true, plugin: { name: 'dsh-sync-hub', version: '0.5.0' } }),
    plugins: async () => ({ generatedAt: '2026-11-07', plugins: [], totals: {} }),
    backups: async () => [],
    plan: async () => ({ ok: false, error: '还没有设置同步文件夹路径' }),
    run: async () => ({ ok: false, error: '还没有设置同步文件夹路径' }),
    saveSettings: async (settings) => ({ settings, device: { id: '00000000' } }),
    setSecret: async () => ({ ok: true }),
  }
}

const GOOD = { host: '127.0.0.1:37657' }

async function call(hub, req) {
  const handler = createHandler(hub, () => {})
  const res = fakeRes()
  await handler(req, res)
  return res
}

/* 1. 无头请求（CLI / 内部调用）应放行 */
{
  const res = await call(fakeHub(null), fakeReq('GET', { headers: {} }))
  check('无头 GET 放行', res.code === 200, 'code=' + res.code)
}

/* 2. 同源浏览器请求放行 */
{
  const res = await call(
    fakeHub(null),
    fakeReq('GET', { headers: { ...GOOD, origin: 'http://127.0.0.1:37657', 'sec-fetch-site': 'same-origin' } }),
  )
  check('同源 GET 放行', res.code === 200, 'code=' + res.code)
}

/* 3. localhost 与 127.0.0.1 互通（同一端口） */
{
  const res = await call(
    fakeHub(null),
    fakeReq('GET', { headers: { host: '127.0.0.1:37657', origin: 'http://localhost:37657' } }),
  )
  check('localhost 同端口放行', res.code === 200, 'code=' + res.code)
}

/* 4. 跨站 Origin 拒绝 */
{
  const res = await call(
    fakeHub(null),
    fakeReq('GET', { headers: { ...GOOD, origin: 'http://evil.example' } }),
  )
  check('跨站 Origin 被拒（403）', res.code === 403, 'code=' + res.code)
}

/* 5. Sec-Fetch-Site: cross-site 拒绝 */
{
  const res = await call(
    fakeHub(null),
    fakeReq('GET', { headers: { ...GOOD, 'sec-fetch-site': 'cross-site' } }),
  )
  check('Sec-Fetch-Site cross-site 被拒（403）', res.code === 403, 'code=' + res.code)
}

/* 6. 非回环 Host 拒绝（DNS rebinding） */
{
  const res = await call(
    fakeHub(null),
    fakeReq('GET', { headers: { host: 'evil.example' } }),
  )
  check('非回环 Host 被拒（403）', res.code === 403, 'code=' + res.code)
}

/* 7. 跨站 Referer 拒绝 */
{
  const res = await call(
    fakeHub(null),
    fakeReq('GET', { headers: { ...GOOD, referer: 'http://evil.example/page' } }),
  )
  check('跨站 Referer 被拒（403）', res.code === 403, 'code=' + res.code)
}

/* 8. 同源 Referer 放行 */
{
  const res = await call(
    fakeHub(null),
    fakeReq('GET', { headers: { ...GOOD, referer: 'http://127.0.0.1:37657/' } }),
  )
  check('同源 Referer 放行', res.code === 200, 'code=' + res.code)
}

/* 9. 端口不同的同机 Origin 拒绝 */
{
  const res = await call(
    fakeHub(null),
    fakeReq('GET', { headers: { ...GOOD, origin: 'http://127.0.0.1:9999' } }),
  )
  check('端口不一致的 Origin 被拒（403）', res.code === 403, 'code=' + res.code)
}

/* 10. POST 缺 Content-Type 拒绝 */
{
  const res = await call(fakeHub(null), fakeReq('POST', { url: '/dsh-sync-hub/settings', headers: { ...GOOD } }))
  check('POST 缺 Content-Type 被拒（415）', res.code === 415, 'code=' + res.code)
}

/* 11. POST text/plain 拒绝（CORS 简单请求） */
{
  const res = await call(
    fakeHub(null),
    fakeReq('POST', { url: '/dsh-sync-hub/settings', headers: { ...GOOD, 'content-type': 'text/plain' } }),
  )
  check('POST text/plain 被拒（415）', res.code === 415, 'code=' + res.code)
}

/* 12. POST application/json 放行并进入路由 */
{
  const res = await call(
    fakeHub(null),
    fakeReq('POST', {
      url: '/dsh-sync-hub/settings',
      headers: { ...GOOD, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { transport: 'local' } }),
    }),
  )
  check('POST JSON 放行（200）', res.code === 200, 'code=' + res.code + ' body=' + res.body.slice(0, 120))
}

/* 13. 宿主鉴权返回 401 */
{
  const hub = fakeHub({ requestRejection: () => 401 })
  const res = await call(hub, fakeReq('GET', { headers: { ...GOOD } }))
  check('宿主鉴权 401 直通', res.code === 401, 'code=' + res.code)
}

/* 14. 宿主鉴权返回 403 */
{
  const hub = fakeHub({ requestRejection: () => 403 })
  const res = await call(hub, fakeReq('GET', { headers: { ...GOOD } }))
  check('宿主鉴权 403 直通', res.code === 403, 'code=' + res.code)
}

/* 15. 宿主鉴权返回 undefined 表示放行 */
{
  const hub = fakeHub({ requestRejection: () => undefined })
  const res = await call(hub, fakeReq('GET', { headers: { ...GOOD } }))
  check('宿主鉴权 undefined 放行', res.code === 200, 'code=' + res.code)
}

/* 16. 宿主鉴权抛异常时退回本地校验（不能崩） */
{
  const hub = fakeHub({
    requestRejection: () => {
      throw new Error('boom')
    },
  })
  const denied = await call(hub, fakeReq('GET', { headers: { ...GOOD, origin: 'http://evil.example' } }))
  check('宿主鉴权异常后仍做本地校验（403）', denied.code === 403, 'code=' + denied.code)
  const allowed = await call(hub, fakeReq('GET', { headers: { ...GOOD } }))
  check('宿主鉴权异常后本机请求仍放行', allowed.code === 200, 'code=' + allowed.code)
}

/* 17. checkAccess 单独可用：放行返回 null，拒绝返回 code */
{
  check('checkAccess 放行返回 null', checkAccess(fakeHub(null), fakeReq('GET', { headers: { ...GOOD } }), 'GET') === null)
  const denied = checkAccess(fakeHub(null), fakeReq('GET', { headers: { ...GOOD, origin: 'http://evil.example' } }), 'GET')
  check('checkAccess 拒绝返回 code', denied && denied.code === 403)
}

/* 18. 拒绝响应是结构化 JSON */
{
  const res = await call(
    fakeHub(null),
    fakeReq('GET', { headers: { ...GOOD, origin: 'http://evil.example' } }),
  )
  let parsed = null
  try {
    parsed = JSON.parse(res.body)
  } catch {
    parsed = null
  }
  check('拒绝响应是 {ok:false,error}', parsed && parsed.ok === false && typeof parsed.error === 'string', res.body.slice(0, 120))
}

console.log(failures ? '\n安全测试失败：' + failures + ' 项' : '\n安全测试全部通过')
process.exitCode = failures ? 1 : 0
