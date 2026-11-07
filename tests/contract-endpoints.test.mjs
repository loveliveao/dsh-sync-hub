/**
 * 契约形状自检：GET /plugins 与 GET /workspaces 的字段是否符合
 * docs/design/ui-redesign-contract-2026-11-07.md。
 *
 *   node tests/contract-endpoints.test.mjs
 *
 * 全程在临时 DSH_HOME 里跑，不碰用户真实的配置。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = await mkdtemp(join(tmpdir(), 'sync-hub-contract-'))
process.env.DSH_HOME = SANDBOX
process.env.DSH_PROFILE = 'desktop'

const { Hub } = await import('../lib/hub.mjs')
const { createHandler } = await import('../lib/server.mjs')
const { buildTree } = await import('../lib/workspaces.mjs')
const { loadState } = await import('../lib/state.mjs')

let failures = 0

function check(label, ok, detail = '') {
  if (ok) {
    console.log('  ✓ ' + label)
  } else {
    failures += 1
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''))
  }
}

function fakeRes() {
  return {
    code: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.code = code
      this.headers = headers
    },
    end(text) {
      this.body = text
    },
  }
}

// 造一个 profile：两个插件 + 一段带敏感键的配置。
const PROFILE_DIR = join(SANDBOX, 'profiles', 'desktop')
await mkdir(PROFILE_DIR, { recursive: true })
await writeFile(
  join(PROFILE_DIR, 'package.json'),
  JSON.stringify(
    {
      name: 'demo-profile',
      dependencies: {
        'dsh-context': '0.82.0',
        'dsh-local': 'file:local-plugins/dsh-local',
        'dsh-other': '^1.6.0',
      },
    },
    null,
    2,
  ) + '\n',
  'utf8',
)
await writeFile(
  join(PROFILE_DIR, 'cordis.patch.yml'),
  [
    '- id: dsh-context',
    '  name: dsh-context',
    '  config:',
    '    model: gpt-5',
    '    apiKey: sk-should-not-leak',
    '',
  ].join('\n'),
  'utf8',
)

// 造一个带 git 的工作区 + 一份 workspace.json。
const REPO = join(SANDBOX, 'workspace-demo')
await mkdir(join(REPO, '.git'), { recursive: true })
await writeFile(
  join(REPO, '.git', 'config'),
  '[remote "origin"]\n\turl = https://user:pass@example.com/demo.git\n',
  'utf8',
)
await writeFile(join(REPO, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
await mkdir(join(SANDBOX, 'storages'), { recursive: true })
await writeFile(
  join(SANDBOX, 'storages', 'workspace.json'),
  JSON.stringify(
    {
      global: { initialized: true, archivedSessionIds: ['s-archived'] },
      tables: { workspaces: { w1: { path: REPO, title: 'demo' } } },
    },
    null,
    2,
  ) + '\n',
  'utf8',
)

const hub = new Hub(
  {
    logger: { info() {}, warn() {} },
    credentials: { resolve: async () => null, set: async () => {}, unset: async () => {} },
  },
  { name: 'dsh-sync-hub', version: '0.4.0' },
)

console.log('[1] GET /plugins 的返回结构')
{
  await hub.saveSettings({ pluginConfig: { enabled: true, switches: { 'dsh-context': true } } })
  const data = await hub.plugins()
  check('有 generatedAt', typeof data.generatedAt === 'string' && data.generatedAt.length > 0)
  check('plugins 是数组', Array.isArray(data.plugins), String(typeof data.plugins))
  check(
    'totals 三个计数都在',
    data.totals && typeof data.totals.plugins === 'number' && typeof data.totals.withConfig === 'number' && typeof data.totals.enabled === 'number',
    JSON.stringify(data.totals),
  )

  const ctx = (data.plugins || []).find((item) => item.key === 'dsh-context') || {}
  const fields = ['key', 'name', 'version', 'installed', 'hasConfig', 'configKeys', 'configPaths', 'config', 'redacted', 'state', 'syncEnabled', 'bytes']
  check('插件条目字段齐全', fields.every((key) => key in ctx), JSON.stringify(Object.keys(ctx)))
  check('version 取自依赖', ctx.version === '0.82.0', String(ctx.version))
  check('installed 为 true', ctx.installed === true)
  check('hasConfig 为 true', ctx.hasConfig === true)
  check('configKeys 有内容', Array.isArray(ctx.configKeys) && ctx.configKeys.includes('model'), JSON.stringify(ctx.configKeys))
  check('config 已脱敏', ctx.config && ctx.config.apiKey === '<redacted>', JSON.stringify(ctx.config))
  check('redacted 标记为 true', ctx.redacted === true)
  check('state 是 pending（开关开着但不在基线）', ctx.state === 'pending', String(ctx.state))
  check('syncEnabled 为 true', ctx.syncEnabled === true)
  check('bytes 大于 0', typeof ctx.bytes === 'number' && ctx.bytes > 0, String(ctx.bytes))

  const local = (data.plugins || []).find((item) => item.key === 'dsh-local') || {}
  check('file: 依赖版本为 null', local.version === null, String(local.version))
  check('没有配置的插件 state 为 off', local.state === 'off', String(local.state))

  const other = (data.plugins || []).find((item) => item.key === 'dsh-other') || {}
  check('^1.6.0 归一成 1.6.0', other.version === '1.6.0', String(other.version))

  check('totals.plugins 是插件总数', data.totals.plugins === data.plugins.length, JSON.stringify(data.totals))
  check('totals.withConfig 统计有配置的', data.totals.withConfig === 1, JSON.stringify(data.totals))
  check('totals.enabled 统计开了开关的', data.totals.enabled === 1, JSON.stringify(data.totals))
}

console.log('\n[2] HTTP 路由 GET /plugins')
{
  const handler = createHandler(hub, () => {})
  const res = fakeRes()
  await handler({ url: '/dsh-sync-hub/plugins', method: 'GET' }, res)
  check('状态码 200', res.code === 200, String(res.code))
  const body = JSON.parse(res.body || '{}')
  check('body.ok 为 true', body.ok === true)
  check('body.data.plugins 是数组', Array.isArray(body.data && body.data.plugins))
}

console.log('\n[3] 路由异常转 500 JSON，不崩')
{
  const broken = {
    async plugins() {
      throw new Error('故意炸的')
    },
  }
  const handler = createHandler(broken, () => {})
  const res = fakeRes()
  await handler({ url: '/dsh-sync-hub/plugins', method: 'GET' }, res)
  check('状态码 500', res.code === 500, String(res.code))
  const body = JSON.parse(res.body || '{}')
  check('body.ok 为 false', body.ok === false)
  check('body.error 有说明', typeof body.error === 'string' && body.error.length > 0, JSON.stringify(body))
}

console.log('\n[4] /workspaces 的字段形状')
{
  const state = await loadState()
  const tree = await buildTree({ settings: state.settings, base: state.base })
  const ws = (tree.workspaces || [])[0] || {}
  check('工作区有 git 信息', Boolean(ws.git) && typeof ws.git === 'object', JSON.stringify(ws.git))
  check('git.isRepo 为 true', Boolean(ws.git) && ws.git.isRepo === true)
  check('git.remote 去掉了凭据', Boolean(ws.git) && ws.git.remote === 'https://example.com/demo.git', String(ws.git && ws.git.remote))
  check('git.branch 是 main', Boolean(ws.git) && ws.git.branch === 'main', String(ws.git && ws.git.branch))
  check('有 archivedCount', typeof ws.archivedCount === 'number', String(ws.archivedCount))
  check('有 pendingCount', typeof ws.pendingCount === 'number', String(ws.pendingCount))
  check('totals 里有 archived', typeof tree.totals.archived === 'number', JSON.stringify(tree.totals))
  const plugin = (tree.plugins || [])[0] || {}
  check(
    'plugins[] 有 key/name/version/state/hasConfig/configKeys/syncEnabled',
    ['key', 'name', 'version', 'state', 'hasConfig', 'configKeys', 'syncEnabled'].every((key) => key in plugin),
    JSON.stringify(Object.keys(plugin)),
  )
  const ctxPlugin = (tree.plugins || []).find((item) => item.key === 'dsh-context') || {}
  check('插件 hasConfig 为 true', ctxPlugin.hasConfig === true)
  check('插件 configKeys 有内容', Array.isArray(ctxPlugin.configKeys) && ctxPlugin.configKeys.length > 0)
  check('插件 syncEnabled 为 true', ctxPlugin.syncEnabled === true)
}

await rm(SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
console.log(failures ? '\n✗ ' + failures + ' 项未通过' : '\n✓ 全部通过')
process.exitCode = failures ? 1 : 0
