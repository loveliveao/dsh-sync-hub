/**
 * P1 路径安全回归测试。
 *
 * 三件事：
 *   1. 读侧：DSH_HOME 里若有一个指向外面的联接（Windows junction），顺着它读到的
 *      外部文件不能被同步出去。
 *   2. 写侧：远端清单里的路径若经由联接指向 DSH_HOME 之外，拉取必须被拒绝，
 *      并且不能真的在外部目录里创建文件。
 *   3. 设置侧：remote.path 与 workspaces.map 只接受绝对路径；remote.path 落在
 *      DSH_HOME 里面要被清掉（避免同步库自己被同步一遍）。
 *
 * 另外单测工作区子路径的净化：远端带来的 workspaceSub 不能用 '..' 拼出去。
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPlan, runSync } from '../lib/engine.mjs'
import { assertRealInsideHome, isRealInsideHome } from '../lib/paths.mjs'
import { defaultSettings, normalizeSettings } from '../lib/state.mjs'
import { clearMetaCache, collectAll } from '../lib/sections.mjs'
import { createTransport } from '../lib/transport/index.mjs'
import { resolveLocalCwd, safeSubParts, sanitizeSub } from '../lib/workspaces.mjs'

let failures = 0
let passes = 0

function check(name, ok, detail = '') {
  if (ok) {
    passes += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

function section(title) {
  console.log(`\n[${title}]`)
}

/** 只留 custom 分区：其它 section 全关，避免会话/配置目录干扰断言。 */
function makeSettings(patch = {}) {
  const base = defaultSettings()
  return normalizeSettings({
    ...base,
    transport: 'local',
    remote: { ...base.remote, path: '' },
    sections: {
      cordis: false,
      plugins: false,
      skills: false,
      sessions: false,
      workspaces: false,
      pluginData: false,
      secrets: false,
      pluginConfig: false,
    },
    customPaths: [],
    conflictPolicy: 'remote',
    ...patch,
  })
}

function makeState(settings, id, name) {
  return {
    schema: 1,
    device: { id, name, createdAt: new Date().toISOString() },
    settings,
    base: {},
    shaCache: {},
    ignoreAfterPull: {},
    localSha: {},
    lastPlan: null,
    lastSync: null,
    updatedAt: null,
  }
}

async function exists(abs) {
  const buf = await readFile(abs).catch(() => null)
  if (buf) return true
  const { stat } = await import('node:fs/promises')
  return Boolean(await stat(abs).catch(() => null))
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-path-'))
  const home = join(root, 'home')
  const outside = join(root, 'outside')
  const remote = join(root, 'remote')
  await mkdir(home, { recursive: true })
  await mkdir(outside, { recursive: true })
  await mkdir(remote, { recursive: true })
  process.env.DSH_HOME = home

  // DSH_HOME 里放一个指向外面的联接（Windows 的 junction，不需要管理员权限）。
  const link = join(home, 'linked')
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(outside, 'secret.txt'), 'TOP-SECRET-DO-NOT-SYNC\n', 'utf8')
  await writeFile(join(home, 'inside.txt'), 'inside\n', 'utf8')
  await mkdir(join(home, 'custom'), { recursive: true })
  await writeFile(join(home, 'custom', 'app.yml'), 'name: app\n', 'utf8')

  section('真实路径判定')
  check('DSH_HOME 内的普通文件算在内', await isRealInsideHome(join(home, 'inside.txt')))
  check('联接指向的外部文件不算在内', !(await isRealInsideHome(join(link, 'secret.txt'))))
  check('DSH_HOME 之外的绝对路径不算在内', !(await isRealInsideHome(outside)))
  let threw = null
  try {
    await assertRealInsideHome(join(link, 'evil.txt'))
  } catch (err) {
    threw = err
  }
  check('写外部路径时守卫会抛错', Boolean(threw), String(threw && threw.message))
  check('抛错信息里说清了原因', threw && /越出了配置目录/.test(String(threw.message)), String(threw && threw.message))

  section('读侧：联接外的文件不会被同步出去')
  clearMetaCache()
  const readSettings = makeSettings({
    customPaths: [
      { rel: 'custom/app.yml', enabled: true },
      { rel: 'linked/secret.txt', enabled: true },
    ],
  })
  const collected = await collectAll(readSettings)
  const rels = collected.entries.map((item) => item.rel)
  check('普通文件正常采集', rels.includes('custom/app.yml'), rels.join(','))
  check('联接外的文件被跳过', !rels.includes('linked/secret.txt'), rels.join(','))

  section('写侧：远端清单借联接写到外面会被拒绝')
  const payload = Buffer.from('PWNED\n', 'utf8')
  const sha = createHash('sha256').update(payload).digest('hex')
  await mkdir(join(remote, 'blobs', sha.slice(0, 2)), { recursive: true })
  await writeFile(join(remote, 'blobs', sha.slice(0, 2), sha), payload)
  const entryId = 'custom:linked/evil.txt'
  await writeFile(
    join(remote, 'manifest.json'),
    JSON.stringify(
      {
        schema: 1,
        hub: 'dsh-sync-hub',
        updatedAt: new Date().toISOString(),
        devices: {
          evil: {
            name: 'evil',
            platform: 'win32',
            dshVersion: '0.0.0',
            profile: 'desktop',
            sections: ['custom'],
            lastSeen: new Date().toISOString(),
          },
        },
        entries: {
          [entryId]: {
            id: entryId,
            section: 'custom',
            rel: 'linked/evil.txt',
            sha,
            bytes: payload.length,
            mtimeMs: Date.now(),
            updatedBy: 'evil',
            updatedAt: new Date().toISOString(),
            meta: null,
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  )

  const writeSettings = makeSettings({ remote: { path: remote } })
  const state = makeState(writeSettings, 'device-b', '机器B')
  const transport = createTransport(writeSettings)
  const plan = await buildPlan({ state, transport, version: null, persist: false })
  check('计划里确实有一条待拉取', plan.plan.totals.pull === 1, JSON.stringify(plan.plan.totals))
  const run = await runSync({ state, transport, version: null })
  check('拉取被拒绝（没有当成成功）', run.pulled.length === 0, JSON.stringify(run.pulled))
  check('失败原因里有明确说明', run.failures.length === 1 && /越出了配置目录/.test(run.failures[0].message), JSON.stringify(run.failures))
  check('外部目录里没有生成文件', !(await exists(join(outside, 'evil.txt'))), join(outside, 'evil.txt'))

  section('设置侧：路径净化')
  const rel = normalizeSettings({ remote: { path: 'relative/folder' } })
  check('相对路径的 remote.path 被清掉', rel.remote.path === '', rel.remote.path)
  const insideHome = normalizeSettings({ remote: { path: join(home, 'sync-folder') } })
  check('落在 DSH_HOME 里的 remote.path 被清掉', insideHome.remote.path === '', insideHome.remote.path)
  const outsidePath = normalizeSettings({ remote: { path: outside } })
  check('DSH_HOME 之外的绝对路径保留', outsidePath.remote.path === outside, outsidePath.remote.path)
  const relMap = normalizeSettings({ workspaces: { map: { ws: 'relative/dir' } } })
  check('相对路径的工作区映射被丢掉', Object.keys(relMap.workspaces.map).length === 0, JSON.stringify(relMap.workspaces.map))
  const absMap = normalizeSettings({ workspaces: { map: { ws: outside } } })
  check('绝对路径的工作区映射保留', absMap.workspaces.map.ws === outside, JSON.stringify(absMap.workspaces.map))

  section('工作区子路径净化')
  check("含 '..' 的子路径整体作废", sanitizeSub('../evil').unsafe === true, JSON.stringify(sanitizeSub('../evil')))
  check("片段里不残留 '..'", !safeSubParts('../evil').includes('..'), JSON.stringify(safeSubParts('../evil')))
  check('中间的 .. 被丢掉', JSON.stringify(safeSubParts('a/../../b')) === JSON.stringify(['a', 'b']), JSON.stringify(safeSubParts('a/../../b')))
  check('. 被丢掉', JSON.stringify(safeSubParts('a/./b')) === JSON.stringify(['a', 'b']), JSON.stringify(safeSubParts('a/./b')))
  check('盘符片段算不可信', sanitizeSub('C:\\Windows').unsafe === true, JSON.stringify(sanitizeSub('C:\\Windows')))
  const cwd = await resolveLocalCwd({
    key: 'ws',
    sub: '../evil',
    cwd: 'D:\\somewhere',
    settings: { workspaces: { map: { ws: outside } } },
  })
  check('resolveLocalCwd 不会拼到映射目录之外', cwd.cwd === outside, cwd.cwd)

  await rm(root, { recursive: true, force: true })

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}（${passes} 项通过）`)
  if (failures) process.exit(1)
}

main().catch((err) => {
  console.error('测试崩了：', err)
  process.exit(1)
})
