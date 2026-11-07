/**
 * 跨机同步的端到端测试。
 *
 * 造两台「假机器」（各自独立的 DSH_HOME）和一个共享文件夹当远端：
 *   机器 A：会话在 D:\VibeCoding
 *   机器 B：同一个工作区在 E:\Code\VibeCoding（目录名相同 → 自动匹配）
 * 验证：
 *   1. A 推送后，远端 manifest 里的会话条目 id 不带本机路径（两台机器才对得上）；
 *   2. B 拉取后，会话落在 B 自己的 projectKey 目录下（DSH 才认）；
 *   3. 会话 header 里的 cwd 被改写成 B 的目录；
 *   4. 两台机器算出来的「逻辑 sha」相同（不会每次都判冲突）；
 *   5. 手动映射（目录名对不上时）也生效；
 *   6. 同步完再算一次计划，没有待推送/待拉取的条目。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import { buildPlan, runSync } from '../lib/engine.mjs'
import { normalizeSettings, defaultSettings } from '../lib/state.mjs'
import { createTransport } from '../lib/transport/index.mjs'
import { clearMetaCache } from '../lib/sections.mjs'
import { clearSessionCache } from '../lib/session-canon.mjs'
import { projectKey, SESSION_FILE_NAME } from '../lib/session-canon.mjs'

let failures = 0
let passes = 0

function check(name, ok, detail = '') {
  if (ok) {
    passes += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n[${title}]`)
}

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
      sessions: true,
      workspaces: false,
      pluginData: false,
      secrets: false,
    },
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
    lastPlan: null,
    lastSync: null,
    updatedAt: null,
  }
}

/** 造一个 DSH 认可布局的会话文件（目录名 = projectKey(cwd)）。 */
async function writeSession(home, cwd, sessionId, bodyLines = []) {
  const header = {
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt: Date.now(),
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  }
  const text = [JSON.stringify(header), ...bodyLines.map((line) => JSON.stringify(line))].join('\n') + '\n'
  const dir = join(home, 'sessions', projectKey(cwd), sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, SESSION_FILE_NAME), zstdCompressSync(Buffer.from(text, 'utf8')))
  return dir
}

/** 写一份 workspace.json，把某个目录登记成 DSH 工作区。 */
async function writeRegistry(home, entries) {
  const tables = { workspaces: {} }
  for (const item of entries) {
    tables.workspaces[item.id] = { path: item.path, title: item.title || '', updatedAt: new Date().toISOString() }
  }
  const file = join(home, 'storages', 'workspace.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ version: 2, global: {}, tables }, null, 2))
}

async function readHeaderAsync(abs) {
  const raw = zstdDecompressSync(await readFile(abs)).toString('utf8')
  return JSON.parse(raw.split('\n')[0])
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-xmachine-'))
  const homeA = join(root, 'homeA')
  const homeB = join(root, 'homeB')
  const remote = join(root, 'remote')
  await mkdir(homeA, { recursive: true })
  await mkdir(homeB, { recursive: true })
  await mkdir(remote, { recursive: true })

  const sessionId = 'session-cross-001'
  const cwdA = 'D:\\VibeCoding'
  const cwdB = 'E:\\Code\\VibeCoding'

  section('准备两台机器')
  await writeSession(homeA, cwdA, sessionId, [{ type: 'message', seq: 1, time: Date.now(), data: { text: '你好' } }])
  await writeRegistry(homeA, [{ id: 'ws-a', path: cwdA, title: 'VibeCoding' }])
  await writeRegistry(homeB, [{ id: 'ws-b', path: cwdB, title: 'VibeCoding' }])
  check('机器 A 上有会话文件', true)
  check('机器 B 的工作区目录名与 A 相同', 'VibeCoding' === 'VibeCoding')

  section('机器 A 推送')
  process.env.DSH_HOME = homeA
  clearMetaCache()
  clearSessionCache()
  const settingsA = makeSettings({ remote: { path: remote } })
  const stateA = makeState(settingsA, 'device-a', '机器A')
  const transportA = createTransport(settingsA)
  const planA = await buildPlan({ state: stateA, transport: transportA, version: null, persist: false })
  check('A 的计划里有 1 个待推送', planA.plan.totals.push === 1, JSON.stringify(planA.plan.totals))
  const entryA = planA.plan.push[0]
  check('会话条目 id 不带本机路径', entryA.id === `sessions:${sessionId}`, entryA.id)
  check('会话条目 rel 与机器无关', entryA.rel === `sessions/${sessionId}/${SESSION_FILE_NAME}`, entryA.rel)

  const runA = await runSync({ state: stateA, transport: transportA, version: null })
  check('A 推送成功', runA.ok && runA.pushed.length === 1, JSON.stringify(runA.failures))
  const shaA = entryA.sha

  section('机器 B 拉取（目录名自动匹配）')
  process.env.DSH_HOME = homeB
  clearMetaCache()
  clearSessionCache()
  const settingsB = makeSettings({ remote: { path: remote } })
  const stateB = makeState(settingsB, 'device-b', '机器B')
  const transportB = createTransport(settingsB)
  const planB = await buildPlan({ state: stateB, transport: transportB, version: null, persist: false })
  check('B 的计划里有 1 个待拉取', planB.plan.totals.pull === 1, JSON.stringify(planB.plan.totals))

  const runB = await runSync({ state: stateB, transport: transportB, version: null })
  check('B 拉取成功', runB.ok && runB.pulled.length === 1, JSON.stringify(runB.failures))

  const expectDir = join(homeB, 'sessions', projectKey(cwdB), sessionId)
  const landed = await readFile(join(expectDir, SESSION_FILE_NAME)).catch(() => null)
  check('会话落在 B 自己的 projectKey 目录下', Boolean(landed), expectDir)
  if (landed) {
    const header = JSON.parse(zstdDecompressSync(landed).toString('utf8').split('\n')[0])
    check('会话 header 的 cwd 被改写成 B 的目录', header.cwd === cwdB, header.cwd)
    check('会话 id 保持不变', header.id === sessionId, header.id)
    const normText = zstdDecompressSync(landed).toString('utf8').replace(JSON.stringify(cwdB), '"__DSH_SYNC_CWD__"')
    const { createHash } = await import('node:crypto')
    const shaB = createHash('sha256').update(normText, 'utf8').digest('hex')
    check('两台机器的逻辑 sha 相同（不会反复冲突）', shaB === shaA, `${shaB.slice(0, 10)} vs ${shaA.slice(0, 10)}`)
  }
  check('B 的同步基线记下了这个会话', Boolean(stateB.base[`sessions:${sessionId}`]))

  section('再算一次计划：应该没有待办')
  clearMetaCache()
  clearSessionCache()
  const planB2 = await buildPlan({ state: stateB, transport: transportB, version: null, persist: false })
  check('B 没有待推送', planB2.plan.totals.push === 0, JSON.stringify(planB2.plan.totals))
  check('B 没有待拉取', planB2.plan.totals.pull === 0, JSON.stringify(planB2.plan.totals))

  section('目录名对不上时：手动映射生效')
  const homeC = join(root, 'homeC')
  await mkdir(homeC, { recursive: true })
  // C 上没有同名工作区，只有手动映射能对上
  process.env.DSH_HOME = homeC
  clearMetaCache()
  clearSessionCache()
  const cwdC = 'F:\\Work\\VibeCoding'
  const settingsC = makeSettings({
    remote: { path: remote },
    workspaces: { switches: {}, map: { VibeCoding: cwdC } },
  })
  const stateC = makeState(settingsC, 'device-c', '机器C')
  const transportC = createTransport(settingsC)
  const planC = await buildPlan({ state: stateC, transport: transportC, version: null, persist: false })
  check('C 的计划里有 1 个待拉取', planC.plan.totals.pull === 1, JSON.stringify(planC.plan.totals))
  const runC = await runSync({ state: stateC, transport: transportC, version: null })
  check('C 拉取成功', runC.ok && runC.pulled.length === 1, JSON.stringify(runC.failures))
  const landedC = await readFile(join(homeC, 'sessions', projectKey(cwdC), sessionId, SESSION_FILE_NAME)).catch(() => null)
  check('C 的会话落在手动映射指定的目录', Boolean(landedC), join(homeC, 'sessions', projectKey(cwdC), sessionId))
  if (landedC) {
    const header = JSON.parse(zstdDecompressSync(landedC).toString('utf8').split('\n')[0])
    check('C 的会话 header cwd 是映射目录', header.cwd === cwdC, header.cwd)
  }

  section('工作区开关：关掉的工作区不进同步集合')
  process.env.DSH_HOME = homeB
  clearMetaCache()
  clearSessionCache()
  const settingsOff = makeSettings({
    remote: { path: remote },
    workspaces: { switches: { VibeCoding: false }, map: {} },
  })
  const stateOff = makeState(settingsOff, 'device-b2', '机器B2')
  const planOff = await buildPlan({ state: stateOff, transport: createTransport(settingsOff), version: null, persist: false })
  check('关掉后没有待推送的会话', !planOff.plan.push.some((item) => item.section === 'sessions'))

  await rm(root, { recursive: true, force: true })

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}（${passes} 项通过）`)
  if (failures) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
