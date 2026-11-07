/**
 * 防御性自检：插件无论遇到什么异常，都不能把宿主带崩。
 *
 *   node tests/defensive.test.mjs
 *
 * 覆盖：
 *   1. 工具执行体：hub 方法抛异常时，工具返回可读文本而不是 reject
 *   2. 降级 Hub：读接口都不抛异常，写接口抛出可读错误
 *   3. apply()：宿主 webServer / tools 注册抛异常时，apply 仍不抛，卸载也不抛
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 所有落点都在临时目录里，绝不碰用户真实的 DSH_HOME。
const SANDBOX = await mkdtemp(join(tmpdir(), 'sync-hub-defensive-'))
process.env.DSH_HOME = SANDBOX

const { registerTools } = await import('../lib/tools.mjs')
const { degradedHub } = await import('../lib/degraded.mjs')
const { apply } = await import('../index.js')

let failures = 0

function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`)
  }
}

function fakeCtx(overrides = {}) {
  return {
    logger: { info() {}, warn() {} },
    credentials: { resolve: async () => null, set: async () => {}, unset: async () => {} },
    effect(fn) {
      fn()
    },
    webServer: { register: () => () => {} },
    tools: { register: () => () => {} },
    ...overrides,
  }
}

console.log('[1] 工具执行体兜底')
{
  const defs = []
  registerTools(
    {
      tools: {
        register(def) {
          defs.push(def)
          return () => {}
        },
      },
    },
    {
      async status() {
        throw new Error('状态炸了')
      },
      async plan() {
        throw new Error('计划炸了')
      },
      async run() {
        throw new Error('同步炸了')
      },
      async sessions() {
        throw new Error('会话炸了')
      },
    },
  )
  check('注册了 4 个工具', defs.length === 4, String(defs.length))
  for (const def of defs) {
    let threw = false
    let result = null
    try {
      result = await def.execute({})
    } catch {
      threw = true
    }
    check(`${def.name} 遇到 hub 异常不 reject`, !threw)
    check(
      `${def.name} 返回可读文本`,
      Boolean(result && typeof result.text === 'string' && result.text.includes('失败')),
      JSON.stringify(result).slice(0, 120),
    )
  }
}

console.log('\n[2] 降级 Hub')
{
  const degraded = degradedHub('构造失败')
  for (const method of ['status', 'sessions', 'analysis', 'workspaces', 'backups', 'test', 'plan', 'run']) {
    let threw = false
    let value = null
    try {
      value = await degraded[method]()
    } catch {
      threw = true
    }
    check(`降级 Hub 的 ${method}() 不抛异常`, !threw)
    check(`降级 Hub 的 ${method}() 有结构化返回`, value !== null && value !== undefined)
  }
  for (const method of ['saveSettings', 'setSecret']) {
    let message = ''
    try {
      await degraded[method]()
    } catch (err) {
      message = String((err && err.message) || err)
    }
    check(`降级 Hub 的 ${method}() 抛出可读错误`, message.includes('初始化失败'), message)
  }
  const defs = []
  registerTools(
    {
      tools: {
        register(def) {
          defs.push(def)
          return () => {}
        },
      },
    },
    degraded,
  )
  for (const def of defs) {
    let threw = false
    try {
      await def.execute({})
    } catch {
      threw = true
    }
    check(`${def.name} 在降级 Hub 下不 reject`, !threw)
  }
}

console.log('\n[3] apply() 面对坏宿主')
{
  const ctx = fakeCtx({
    webServer: {
      register() {
        throw new Error('webServer 坏了')
      },
    },
    tools: {
      register() {
        throw new Error('tools 坏了')
      },
    },
  })
  let threw = false
  let disposer = null
  try {
    disposer = apply(ctx, {})
  } catch {
    threw = true
  }
  check('apply() 不抛异常', !threw)
  check('apply() 返回卸载函数', typeof disposer === 'function')
  let disposeThrew = false
  try {
    if (typeof disposer === 'function') disposer()
  } catch {
    disposeThrew = true
  }
  check('卸载不抛异常', !disposeThrew)
}

console.log('\n[4] apply() 正常宿主')
{
  const routes = []
  const defs = []
  const ctx = fakeCtx({
    webServer: {
      register(def) {
        routes.push(def)
        return () => {}
      },
    },
    tools: {
      register(def) {
        defs.push(def)
        return () => {}
      },
    },
  })
  let threw = false
  let disposer = null
  try {
    disposer = apply(ctx, {})
  } catch {
    threw = true
  }
  check('apply() 正常路径不抛异常', !threw)
  check('注册了 1 条 HTTP 路由', routes.length === 1, String(routes.length))
  check('HTTP 路由前缀是 /dsh-sync-hub', Boolean(routes[0]) && routes[0].path === '/dsh-sync-hub')
  check('注册了 4 个 Agent 工具', defs.length === 4, String(defs.length))
  check('apply() 返回卸载函数', typeof disposer === 'function')
}

// seedFromConfig 还在后台往沙箱里写 state.json，先等它落定再删（否则 rmdir 撞上 ENOTEMPTY）。
await new Promise((resolve) => setTimeout(resolve, 500))
await rm(SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })

console.log(failures ? `\n✗ ${failures} 项未通过` : '\n✓ 全部通过')
process.exitCode = failures ? 1 : 0
