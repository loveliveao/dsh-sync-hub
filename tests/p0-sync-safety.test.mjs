/**
 * P0-2 / P0-3 回归测试。
 *
 * P0-2：拉取挂起表 ignoreAfterPull 被状态白名单丢弃 + 基线记成本机 sha
 *       → 每轮都重复拉取 / 合并 / 覆写 / 备份。
 * P0-3：custom 分区拉取时整文件覆盖 → 用户真实值被 <redacted> 占位符顶掉。
 *
 * 造两台假机器（各自独立的 DSH_HOME）+ 一个共享文件夹当远端，
 * 只同步 custom 分区的三个文本配置文件。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPlan, runSync } from '../lib/engine.mjs'
import { defaultSettings, loadState, normalizeSettings, normalizeState, saveState } from '../lib/state.mjs'
import { createTransport } from '../lib/transport/index.mjs'
import { clearMetaCache } from '../lib/sections.mjs'

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
  console.log(`
[${title}]`)
}

/** 只开 custom 分区：其它 section 全关，避免会话/配置目录干扰断言。 */
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
    customPaths: [
      { rel: 'custom/app.yml', enabled: true },
      { rel: 'custom/other.yml', enabled: true },
      { rel: 'custom/only-a.yml', enabled: true },
    ],
    // 强制走「拉远端」，让冲突解析路径稳定可测。
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

async function writeFiles(home, files) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(home, ...rel.split('/'))
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, text, 'utf8')
  }
}

async function readText(home, rel) {
  return readFile(join(home, ...rel.split('/')), 'utf8').catch(() => null)
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-p0-'))
  const homeA = join(root, 'homeA')
  const homeB = join(root, 'homeB')
  const remote = join(root, 'remote')
  await mkdir(homeA, { recursive: true })
  await mkdir(homeB, { recursive: true })
  await mkdir(remote, { recursive: true })

  section('准备：机器 A 有密钥，机器 B 有自己的一份真实密钥')
  await writeFiles(homeA, {
    // A 的 app.yml：远端会变成脱敏副本
    'custom/app.yml': 'name: alpha\napi_key: sk-aaaaaaaaaaaaaaaaaaaa\n',
    // A 的 other.yml：B 本机没有 api_key 这一行 → 合并后该行被丢弃
    'custom/other.yml': 'name: only-on-a\napi_key: sk-cccccccccccccccccccc\n',
    // A 独有的文件：B 本机根本没有
    'custom/only-a.yml': 'name: only-a\napi_key: sk-dddddddddddddddddddd\n',
  })
  await writeFiles(homeB, {
    'custom/app.yml': 'name: beta\napi_key: sk-bbbbbbbbbbbbbbbb\nport: 8080\n',
    'custom/other.yml': 'name: only-on-b\n',
  })
  check('两台机器各就位', true)

  section('机器 A 推送')
  process.env.DSH_HOME = homeA
  clearMetaCache()
  const settingsA = makeSettings({ remote: { path: remote } })
  const stateA = makeState(settingsA, 'device-a', '机器A')
  const transportA = createTransport(settingsA)
  const planA = await buildPlan({ state: stateA, transport: transportA, version: null, persist: false })
  check('A 有 3 个待推送', planA.plan.totals.push === 3, JSON.stringify(planA.plan.totals))
  const runA = await runSync({ state: stateA, transport: transportA, version: null })
  check('A 推送成功', runA.ok && runA.pushed.length === 3, JSON.stringify(runA.failures))

  const manifest = await transportA.readManifest()
  const manifestEntries = manifest.entries || {}
  const appId = Object.keys(manifestEntries).find((id) => manifestEntries[id].rel === 'custom/app.yml')
  const otherId = Object.keys(manifestEntries).find((id) => manifestEntries[id].rel === 'custom/other.yml')
  const onlyAId = Object.keys(manifestEntries).find((id) => manifestEntries[id].rel === 'custom/only-a.yml')
  check('远端 manifest 里有三个条目', Boolean(appId && otherId && onlyAId), JSON.stringify(Object.keys(manifestEntries)))
  check(
    '远端 manifest 保留了脱敏标记 meta.kind=redacted',
    manifestEntries[appId] && manifestEntries[appId].meta && manifestEntries[appId].meta.kind === 'redacted',
    JSON.stringify(manifestEntries[appId] && manifestEntries[appId].meta),
  )

  section('机器 B 拉取（P0-3：真实值不能被占位符顶掉）')
  process.env.DSH_HOME = homeB
  clearMetaCache()
  const settingsB = makeSettings({ remote: { path: remote } })
  const stateB = makeState(settingsB, 'device-b', '机器B')
  const transportB = createTransport(settingsB)
  const planB = await buildPlan({ state: stateB, transport: transportB, version: null, persist: false })
  check('B 的计划里有 2 个待拉取', planB.plan.totals.pull === 2, JSON.stringify(planB.plan.totals))
  check(
    '本机没有的那个文件不进拉取列表（不写占位文件）',
    !planB.plan.pull.some((item) => item.id === onlyAId),
    JSON.stringify(planB.plan.pull.map((item) => item.id)),
  )
  const runB = await runSync({ state: stateB, transport: transportB, version: null })
  check('B 拉取成功', runB.ok && runB.pulled.length === 2, JSON.stringify(runB.failures))

  const appText = await readText(homeB, 'custom/app.yml')
  check('app.yml 里 B 自己的真实密钥还在', Boolean(appText && appText.includes('sk-bbbbbbbbbbbbbbbb')), appText)
  check('app.yml 里没有 <redacted> 占位符', Boolean(appText && !appText.includes('<redacted>')), appText)
  check('app.yml 拿到了远端的非敏感内容', Boolean(appText && appText.includes('name: alpha')), appText)

  const otherText = await readText(homeB, 'custom/other.yml')
  check('other.yml 合并后不含 <redacted>', Boolean(otherText && !otherText.includes('<redacted>')), otherText)
  check('other.yml 用上了远端骨架', Boolean(otherText && otherText.includes('name: only-on-a')), otherText)

  const onlyAText = await readText(homeB, 'custom/only-a.yml')
  check('本机没有的文件不会被生成为占位文件', onlyAText === null, String(onlyAText))

  section('基线（P0-2：基线必须是远端那一版的 sha）')
  const remoteAppSha = manifestEntries[appId].sha
  check('state.base 记的是远端条目的 sha', stateB.base[appId] === remoteAppSha, `${stateB.base[appId]} vs ${remoteAppSha}`)
  check('本机规范形态 sha 单独存在 localSha 里', Boolean(stateB.localSha[appId]), JSON.stringify(stateB.localSha))

  section('状态往返（P0-2a：ignoreAfterPull 不能被白名单丢掉）')
  const saved = await saveState(stateB)
  check('saveState 后 ignoreAfterPull 仍在', Object.keys(saved.ignoreAfterPull || {}).length > 0, JSON.stringify(saved.ignoreAfterPull))
  check('saveState 后 localSha 仍在', Object.keys(saved.localSha || {}).length > 0, JSON.stringify(saved.localSha))
  const reloaded = await loadState({ refresh: true })
  check(
    'loadState 后 ignoreAfterPull 仍在（白名单修复）',
    Object.keys(reloaded.ignoreAfterPull || {}).length > 0,
    JSON.stringify(reloaded.ignoreAfterPull),
  )
  check(
    'loadState 后 localSha 仍在',
    Object.keys(reloaded.localSha || {}).length > 0,
    JSON.stringify(reloaded.localSha),
  )
  const normalized = normalizeState({
    ignoreAfterPull: { good: { localSha: 'a', remoteSha: 'b' }, bad: { localSha: 1 }, half: { localSha: 'a' } },
  })
  check('归一化保留合法挂起项', Boolean(normalized.ignoreAfterPull.good), JSON.stringify(normalized.ignoreAfterPull))
  check('归一化丢掉非法挂起项', !normalized.ignoreAfterPull.bad && !normalized.ignoreAfterPull.half, JSON.stringify(normalized.ignoreAfterPull))

  section('第二轮：不能重复拉取 / 不能把本机版本推回去')
  clearMetaCache()
  const planB2 = await buildPlan({ state: reloaded, transport: transportB, version: null, persist: false })
  check('第二轮没有待拉取', planB2.plan.totals.pull === 0, JSON.stringify(planB2.plan.totals))
  check('第二轮没有待推送', planB2.plan.totals.push === 0, JSON.stringify(planB2.plan.totals))
  check(
    '解不开的脱敏键进入挂起（而不是反复拉取）',
    planB2.plan.skipped.some((item) => item.reason === 'redacted-unresolved'),
    JSON.stringify(planB2.plan.skipped.map((item) => item.reason)),
  )
  const manifestAfter = await transportB.readManifest()
  check(
    '远端条目没被本机版本覆盖',
    manifestAfter.entries[appId] && manifestAfter.entries[appId].sha === remoteAppSha,
    JSON.stringify(manifestAfter.entries[appId]),
  )

  await rm(root, { recursive: true, force: true, maxRetries: 5 })
  console.log(`
结果：${passes} 通过 / ${failures} 失败`)
  if (failures > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('测试异常：', err)
  process.exitCode = 1
})
