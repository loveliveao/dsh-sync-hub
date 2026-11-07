/**
 * P1 同步正确性回归测试。
 *
 * 覆盖三条缺陷：
 *  1. 合并按行做 → JSON 配置被拼坏、本机独有的键被抹掉；
 *  2. 写盘被跳过时也记基线 → 用户之后自建该文件，远端被静默覆盖；
 *  3. 基线只有一个数（远端 sha）→ 分不清「谁动了」，反复推送或误报冲突。
 *
 * 造两台假机器（各自独立的 DSH_HOME）+ 一个共享文件夹当远端，
 * 只同步 custom 分区的文本配置文件。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPlan, runSync } from '../lib/engine.mjs'
import { defaultSettings, normalizeSettings } from '../lib/state.mjs'
import { createTransport } from '../lib/transport/index.mjs'
import { clearMetaCache, mergeRedactedForPush, mergeRedactedText } from '../lib/sections.mjs'

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
      { rel: 'custom/app.json', enabled: true },
      { rel: 'custom/only-a.yml', enabled: true },
    ],
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

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function main() {
  section('合并函数：JSON 走结构化合并')
  const jsonMerged = mergeRedactedText(
    '{\n  "apiKey": "sk-bbbbbbbbbbbbbbbb",\n  "port": 8080\n}\n',
    '{\n  "apiKey": "<redacted>",\n  "model": "alpha"\n}\n',
  )
  const jsonObj = parseJson(jsonMerged.text)
  check('合并结果仍是合法 JSON', Boolean(jsonObj), jsonMerged.text)
  check('本机的真实值被回填', Boolean(jsonObj && jsonObj.apiKey === 'sk-bbbbbbbbbbbbbbbb'), jsonMerged.text)
  check('远端的非敏感键保留', Boolean(jsonObj && jsonObj.model === 'alpha'), jsonMerged.text)
  check('本机独有的键保留', Boolean(jsonObj && jsonObj.port === 8080), jsonMerged.text)
  check('输出里没有 <redacted> 占位符', !jsonMerged.text.includes('<redacted>'), jsonMerged.text)

  const jsonNoKey = mergeRedactedText('{\n  "model": "beta"\n}\n', '{\n  "apiKey": "<redacted>"\n}\n')
  const jsonNoKeyObj = parseJson(jsonNoKey.text)
  check('本机没有的脱敏键被丢掉', Boolean(jsonNoKeyObj && !('apiKey' in jsonNoKeyObj)), jsonNoKey.text)
  check('丢掉后仍是合法 JSON', Boolean(jsonNoKeyObj), jsonNoKey.text)

  const jsonMin = mergeRedactedText('{"apiKey":"sk-cccccccccccccccc","x":1}', '{"apiKey":"<redacted>","y":2}')
  const jsonMinObj = parseJson(jsonMin.text)
  check('本机是压缩成一行时结果仍是合法 JSON', Boolean(jsonMinObj), jsonMin.text)
  check(
    '压缩形态也能回填真实值',
    Boolean(jsonMinObj && jsonMinObj.apiKey === 'sk-cccccccccccccccc'),
    jsonMin.text,
  )

  section('合并函数：文本按行合并')
  const ymlMerged = mergeRedactedText(
    'name: beta\napi_key: sk-bbbbbbbbbbbbbbbb\nport: 8080\n',
    'name: alpha\napi_key: <redacted>\nmodel: gpt\n',
  )
  check('远端骨架生效', ymlMerged.text.includes('model: gpt'), ymlMerged.text)
  check('本机的真实值回填', ymlMerged.text.includes('api_key: sk-bbbbbbbbbbbbbbbb'), ymlMerged.text)
  check('本机独有的顶层键保留', ymlMerged.text.includes('port: 8080'), ymlMerged.text)
  check('输出里没有 <redacted>', !ymlMerged.text.includes('<redacted>'), ymlMerged.text)

  const ymlDrop = mergeRedactedText('name: beta\n', 'name: alpha\napi_key: <redacted>\n')
  check('本机没有的脱敏行被丢掉', !ymlDrop.text.includes('<redacted>'), ymlDrop.text)
  check('丢掉计数正确', ymlDrop.dropped === 1, JSON.stringify(ymlDrop))

  const ymlNested = mergeRedactedText(
    'top: 1\n  nested: keep\n',
    'top: 1\napi_key: <redacted>\n',
  )
  check('缩进的本机行不会被乱接到文件末尾', !ymlNested.text.includes('nested: keep'), ymlNested.text)

  section('合并函数：推送方向（本机为准，远端多出来的键保留）')
  const pushJson = mergeRedactedForPush(
    '{\n  "apiKey": "<redacted>",\n  "port": 8080\n}\n',
    '{\n  "apiKey": "<redacted>",\n  "model": "alpha"\n}\n',
  )
  const pushObj = parseJson(pushJson.text)
  check('推送合并结果仍是合法 JSON', Boolean(pushObj), pushJson.text)
  check('本机的值覆盖同名键', Boolean(pushObj && pushObj.port === 8080), pushJson.text)
  check('远端多出来的键保留', Boolean(pushObj && pushObj.model === 'alpha'), pushJson.text)

  const pushYml = mergeRedactedForPush(
    'name: beta\nport: 8080\n',
    'name: alpha\nmodel: gpt\n',
  )
  check('文本推送合并：本机为准', pushYml.text.includes('name: beta'), pushYml.text)
  check('文本推送合并：远端独有的键保留', pushYml.text.includes('model: gpt'), pushYml.text)

  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-merge-'))
  const homeA = join(root, 'homeA')
  const homeB = join(root, 'homeB')
  const remote = join(root, 'remote')
  await mkdir(homeA, { recursive: true })
  await mkdir(homeB, { recursive: true })
  await mkdir(remote, { recursive: true })

  section('端到端：A 推送')
  await writeFiles(homeA, {
    'custom/app.yml': 'name: alpha\napi_key: sk-aaaaaaaaaaaaaaaaaaaa\nonly_a: 1\n',
    'custom/app.json': '{\n  "apiKey": "sk-aaaaaaaaaaaaaaaaaaaa",\n  "model": "alpha"\n}\n',
    'custom/only-a.yml': 'name: only-a\napi_key: sk-dddddddddddddddddddd\n',
  })
  await writeFiles(homeB, {
    'custom/app.yml': 'name: beta\napi_key: sk-bbbbbbbbbbbbbbbb\nport: 8080\n',
    'custom/app.json': '{\n  "apiKey": "sk-bbbbbbbbbbbbbbbb",\n  "port": 8080\n}\n',
  })

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
  const appYmlId = Object.keys(manifestEntries).find((id) => manifestEntries[id].rel === 'custom/app.yml')
  const appJsonId = Object.keys(manifestEntries).find((id) => manifestEntries[id].rel === 'custom/app.json')
  const onlyAId = Object.keys(manifestEntries).find((id) => manifestEntries[id].rel === 'custom/only-a.yml')
  check('远端 manifest 有三个条目', Boolean(appYmlId && appJsonId && onlyAId))
  check(
    '远端存的是脱敏副本（不含明文密钥）',
    manifestEntries[appYmlId] && manifestEntries[appYmlId].meta && manifestEntries[appYmlId].meta.kind === 'redacted',
    JSON.stringify(manifestEntries[appYmlId] && manifestEntries[appYmlId].meta),
  )
  const remoteYmlBlob = await transportA.getBlob(manifestEntries[appYmlId].sha)
  check(
    '远端内容里没有明文密钥',
    Boolean(remoteYmlBlob && !remoteYmlBlob.toString('utf8').includes('sk-aaaa')),
    remoteYmlBlob ? remoteYmlBlob.toString('utf8') : 'null',
  )

  section('端到端：B 首次同步（冲突按「取远端」策略 → 走拉取合并路径）')
  process.env.DSH_HOME = homeB
  clearMetaCache()
  const settingsB = makeSettings({ remote: { path: remote }, conflictPolicy: 'remote' })
  const stateB = makeState(settingsB, 'device-b', '机器B')
  const transportB = createTransport(settingsB)
  const planB = await buildPlan({ state: stateB, transport: transportB, version: null, persist: false })
  check('B 的计划里有 2 个待拉取', planB.plan.totals.pull === 2, JSON.stringify(planB.plan.totals))
  check(
    '本机没有的文件不进拉取列表',
    !planB.plan.pull.some((item) => item.id === onlyAId),
    JSON.stringify(planB.plan.pull.map((item) => item.id)),
  )
  const runB = await runSync({ state: stateB, transport: transportB, version: null })
  check('B 拉取成功', runB.ok && runB.pulled.length === 2, JSON.stringify(runB.failures))

  const bYml = await readText(homeB, 'custom/app.yml')
  check('B 的 YAML 真值还在', Boolean(bYml && bYml.includes('sk-bbbbbbbbbbbbbbbb')), String(bYml))
  check('B 的 YAML 没有占位符', Boolean(bYml && !bYml.includes('<redacted>')), String(bYml))
  check('B 的 YAML 拿到了远端骨架', Boolean(bYml && bYml.includes('only_a: 1')), String(bYml))
  check('B 本机独有的键没被抹掉', Boolean(bYml && bYml.includes('port: 8080')), String(bYml))

  const bJson = await readText(homeB, 'custom/app.json')
  const bJsonObj = parseJson(bJson)
  check('B 的 JSON 仍是合法 JSON', Boolean(bJsonObj), String(bJson))
  check('B 的 JSON 真值还在', Boolean(bJsonObj && bJsonObj.apiKey === 'sk-bbbbbbbbbbbbbbbb'), String(bJson))
  check('B 的 JSON 拿到了远端骨架', Boolean(bJsonObj && bJsonObj.model === 'alpha'), String(bJson))
  check('B 的 JSON 本机独有的键没被抹掉', Boolean(bJsonObj && bJsonObj.port === 8080), String(bJson))

  section('端到端：第二轮必须稳定（不重复拉取、不把本机版本推回去）')
  clearMetaCache()
  const planB2 = await buildPlan({ state: stateB, transport: transportB, version: null, persist: false })
  check('第二轮没有待拉取', planB2.plan.totals.pull === 0, JSON.stringify(planB2.plan.totals))
  check('第二轮没有待推送', planB2.plan.totals.push === 0, JSON.stringify(planB2.plan.totals))
  const manifestAfter = await transportB.readManifest()
  check(
    '远端条目没被本机版本覆盖',
    manifestAfter.entries[appYmlId] && manifestAfter.entries[appYmlId].sha === manifestEntries[appYmlId].sha,
    JSON.stringify(manifestAfter.entries[appYmlId]),
  )

  section('端到端：B 改了共享键再推送 → 远端保留 A 独有的键（并集推送）')
  await writeFiles(homeB, { 'custom/app.yml': 'name: beta2\napi_key: sk-bbbbbbbbbbbbbbbb\nport: 8080\n' })
  clearMetaCache()
  const settingsB2 = makeSettings({ remote: { path: remote }, conflictPolicy: 'local' })
  // 真实场景：B 已经同步过一次（stateB 里有基线），之后才改的文件。
  // 这里必须继承 stateB 的 base/localSha —— 用全新 state 会因为「没有基线」
  // 把所有条目判成冲突（首次同步的既有语义），测的就不是「改了共享键」了。
  const stateB2 = {
    ...makeState(settingsB2, 'device-b', '机器B'),
    base: { ...stateB.base },
    localSha: { ...stateB.localSha },
  }
  const transportB2 = createTransport(settingsB2)
  const planB3 = await buildPlan({ state: stateB2, transport: transportB2, version: null, persist: false })
  check('B 改完有 1 个待推送', planB3.plan.totals.push === 1, JSON.stringify(planB3.plan.totals))
  const runB2 = await runSync({ state: stateB2, transport: transportB2, version: null })
  check('B 推送成功', runB2.ok, JSON.stringify(runB2.failures))
  const manifestB2 = await transportB2.readManifest()
  const pushedBlob = await transportB2.getBlob(manifestB2.entries[appYmlId].sha)
  const pushedText = pushedBlob ? pushedBlob.toString('utf8') : ''
  check('远端保留了 A 独有的键', pushedText.includes('only_a: 1'), pushedText)
  check('远端拿到了 B 的独有键', pushedText.includes('port: 8080'), pushedText)
  check('远端拿到了 B 改过的共享键', pushedText.includes('name: beta2'), pushedText)
  check('远端不含任何明文密钥', !pushedText.includes('sk-bbbb') && !pushedText.includes('sk-aaaa'), pushedText)

  section('端到端：跳过的文件用户自己建了 → 必须报冲突，不能静默覆盖远端')
  await writeFiles(homeB, { 'custom/only-a.yml': 'name: mine\napi_key: sk-eeeeeeeeeeeeeeee\n' })
  clearMetaCache()
  const planB4 = await buildPlan({ state: stateB2, transport: transportB2, version: null, persist: false })
  check(
    '自建文件后计划里出现冲突',
    planB4.plan.conflicts.some((item) => item.id === onlyAId),
    JSON.stringify(planB4.plan.conflicts.map((item) => item.id)),
  )
  const manifestBefore = await transportB2.readManifest()
  check(
    '远端那条没被本机版本直接覆盖',
    manifestBefore.entries[onlyAId] && manifestBefore.entries[onlyAId].sha === manifestEntries[onlyAId].sha,
    JSON.stringify(manifestBefore.entries[onlyAId]),
  )

  section('端到端：冲突按策略解决后，两边的键都在')
  const runB3 = await runSync({ state: stateB2, transport: transportB2, version: null })
  check('冲突处理完成', runB3.ok, JSON.stringify(runB3.failures))
  const manifestFinal = await transportB2.readManifest()
  const finalEntry = manifestFinal.entries[onlyAId]
  check('远端条目还在', Boolean(finalEntry), JSON.stringify(finalEntry))
  if (finalEntry) {
    const remoteBlob = await transportB2.getBlob(finalEntry.sha)
    const text = remoteBlob ? remoteBlob.toString('utf8') : ''
    check('远端保留了本机自建的内容', text.includes('mine'), text)
    check('远端内容不含明文密钥', !text.includes('sk-eeee'), text)
    const mineLocal = await readText(homeB, 'custom/only-a.yml')
    check('本机文件里的真实密钥没被占位符顶掉', Boolean(mineLocal && mineLocal.includes('sk-eeeeeeeeeeeeeeee')), String(mineLocal))
    check('本机文件里没有占位符', Boolean(mineLocal && !mineLocal.includes('<redacted>')), String(mineLocal))
  }

  await rm(root, { recursive: true, force: true, maxRetries: 5 })
  console.log(`
结果：${passes} 通过 / ${failures} 失败`)
  if (failures > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('测试异常：', err)
  process.exitCode = 1
})
