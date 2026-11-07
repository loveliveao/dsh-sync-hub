/**
 * 分区模型回归测试（sections 模型收尾）。
 *
 * 覆盖三件事：
 *  1. custom（自定义路径）的开关在 customPaths 上，不在 settings.sections 上；
 *     设备记录 / 快照 / 计划三处都要能正确反映「custom 开着」。
 *  2. 推送后 state.localSha 要记下远端那一版的 sha。
 *  3. 开了「凭据与密钥」后 cordis 条目是明文（meta.kind='files'），
 *     拉取时必须整文件原样落地，不能走脱敏合并路径（否则会拿本机值替换远端内容）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPlan, runSync, snapshot } from '../lib/engine.mjs'
import { defaultSettings, normalizeSettings } from '../lib/state.mjs'
import { createTransport } from '../lib/transport/index.mjs'
import { clearMetaCache, customEnabled, settingsSections } from '../lib/sections.mjs'

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

/** 全部 section 关掉，只留 custom 由 customPaths 控制（cordis 场景另行覆盖）。 */
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
    customPaths: [{ rel: 'custom/app.yml', enabled: true }],
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-sections-'))
  const homeA = join(root, 'homeA')
  const homeB = join(root, 'homeB')
  const remote = join(root, 'remote')
  await mkdir(homeA, { recursive: true })
  await mkdir(homeB, { recursive: true })
  await mkdir(remote, { recursive: true })
  process.env.DSH_PROFILE = 'desktop'

  section('customEnabled：开关只认 customPaths')
  check('customPaths 里有启用项 → true', customEnabled({ customPaths: [{ rel: 'a', enabled: true }] }) === true)
  check('customPaths 里全部显式关闭 → false', customEnabled({ customPaths: [{ rel: 'a', enabled: false }] }) === false)
  check('customPaths 为空 → false', customEnabled({ customPaths: [] }) === false)
  check('settings 为空 → false', customEnabled(null) === false)

  section('custom 分区不依赖 settings.sections.custom')
  const settingsA = makeSettings({ remote: { ...defaultSettings().remote, path: remote } })
  check('分区模型里确实有 custom 这一项', Object.prototype.hasOwnProperty.call(settingsSections(settingsA), 'custom'), JSON.stringify(Object.keys(settingsSections(settingsA))))
  check('custom 的默认开关是 false（真开关在 customPaths）', settingsSections(settingsA).custom === false, JSON.stringify(settingsSections(settingsA)))
  check('settings.sections 里并不需要出现 custom 键', settingsA.sections.custom === undefined, JSON.stringify(settingsA.sections))

  await writeFiles(homeA, { 'custom/app.yml': 'name: alpha\nport: 8080\n' })
  await writeFiles(homeB, { 'custom/app.yml': 'name: beta\nport: 9090\n' })

  process.env.DSH_HOME = homeA
  clearMetaCache()
  const stateA = makeState(settingsA, 'device-a', '机器A')
  const transportA = createTransport(settingsA)
  const planA = await buildPlan({ state: stateA, transport: transportA, version: null, persist: false })
  const customPush = planA.plan.push.filter((item) => String(item.id).startsWith('custom:'))
  check('custom 条目仍然进了推送计划', customPush.length === 1, JSON.stringify(planA.plan.push.map((i) => i.id)))
  const runA = await runSync({ state: stateA, transport: transportA, version: null })
  check('custom 条目推送成功', runA.ok && runA.pushed.length === 1, JSON.stringify(runA.failures))

  const manifest = await transportA.readManifest()
  const entries = manifest.entries || {}
  const customId = Object.keys(entries).find((id) => entries[id].rel === 'custom/app.yml')
  check('远端 manifest 里有 custom 条目', Boolean(customId), JSON.stringify(Object.keys(entries)))

  section('推送后基线与本机 sha 都要记账')
  check('state.base 记的是远端条目的 sha', stateA.base[customId] === entries[customId].sha, `${stateA.base[customId]} vs ${entries[customId].sha}`)
  check('state.localSha 也记了同一版 sha', stateA.localSha[customId] === entries[customId].sha, JSON.stringify(stateA.localSha))

  section('设备记录：custom 开着就要出现在 sections 里')
  const device = (manifest.devices || {})['device-a']
  check('设备记录存在', Boolean(device), JSON.stringify(Object.keys(manifest.devices || {})))
  check('设备记录的 sections 包含 custom', Boolean(device && (device.sections || []).includes('custom')), JSON.stringify(device && device.sections))

  section('快照：custom 行的 enabled 跟随 customPaths')
  const snap = await snapshot({ state: stateA, version: null, transport: transportA })
  const customRow = (snap.sections || []).find((row) => row.id === 'custom')
  check('快照里有 custom 行', Boolean(customRow), JSON.stringify((snap.sections || []).map((r) => r.id)))
  check('custom 行 enabled 为 true', Boolean(customRow && customRow.enabled === true), JSON.stringify(customRow))
  check('custom 行 count 大于 0', Boolean(customRow && customRow.count >= 1), JSON.stringify(customRow))

  section('机器 B 拉取 custom')
  process.env.DSH_HOME = homeB
  clearMetaCache()
  const settingsB = makeSettings({ remote: { ...defaultSettings().remote, path: remote } })
  const stateB = makeState(settingsB, 'device-b', '机器B')
  const transportB = createTransport(settingsB)
  const planB = await buildPlan({ state: stateB, transport: transportB, version: null, persist: false })
  check('B 的计划里有 1 个待拉取', planB.plan.totals.pull === 1, JSON.stringify(planB.plan.totals))
  const runB = await runSync({ state: stateB, transport: transportB, version: null })
  check('B 拉取成功', runB.ok && runB.pulled.length === 1, JSON.stringify(runB.failures))
  const bText = await readText(homeB, 'custom/app.yml')
  check('B 拿到了 A 的内容', Boolean(bText && bText.includes('name: alpha')), String(bText))

  section('cordis 明文条目：开了密钥同步就整文件原样落地')
  const homeC = join(root, 'homeC')
  const homeD = join(root, 'homeD')
  await mkdir(homeC, { recursive: true })
  await mkdir(homeD, { recursive: true })
  // A 的 cordis.patch.yml 里字面写着 <redacted>：脱敏路径会把它换成占位符，
  // 整文件路径必须原样保留 —— 这就是区分两条路径的探针。
  const cordisA = 'name: plugin-x\ntoken: <redacted>\n'
  const cordisB = 'name: local\ntoken: local-secret\n'
  await writeFiles(homeC, { 'profiles/desktop/cordis.patch.yml': cordisA })
  await writeFiles(homeD, { 'profiles/desktop/cordis.patch.yml': cordisB })

  const cordisSettings = () => {
    const base = defaultSettings()
    return normalizeSettings({
      ...base,
      transport: 'local',
      remote: { ...base.remote, path: remote },
      sections: {
        cordis: true,
        plugins: false,
        skills: false,
        sessions: false,
        workspaces: false,
        pluginData: false,
        secrets: true,
        pluginConfig: false,
      },
      customPaths: [],
      conflictPolicy: 'remote',
    })
  }

  process.env.DSH_HOME = homeC
  clearMetaCache()
  const cordisStateC = makeState(cordisSettings(), 'device-c', '机器C')
  const transportC = createTransport(cordisSettings())
  const runC = await runSync({ state: cordisStateC, transport: transportC, version: null })
  check('C 推送了 cordis 条目', runC.ok && runC.pushed.length === 1, JSON.stringify(runC.failures))
  const manifestC = await transportC.readManifest()
  const cordisEntry = Object.values(manifestC.entries || {}).find((entry) => entry.rel === 'profiles/desktop/cordis.patch.yml')
  check('远端 cordis 条目标记为明文 files', Boolean(cordisEntry && cordisEntry.meta && cordisEntry.meta.kind === 'files'), JSON.stringify(cordisEntry && cordisEntry.meta))

  process.env.DSH_HOME = homeD
  clearMetaCache()
  const cordisStateD = makeState(cordisSettings(), 'device-d', '机器D')
  const transportD = createTransport(cordisSettings())
  const runD = await runSync({ state: cordisStateD, transport: transportD, version: null })
  check('D 拉取了 cordis 条目', runD.ok && runD.pulled.length === 1, JSON.stringify(runD.failures))
  const dText = await readText(homeD, 'profiles/desktop/cordis.patch.yml')
  check('D 的 cordis 文件与 C 完全一致（整文件落地）', dText === cordisA, JSON.stringify(dText))
  check('D 的 cordis 文件保留字面 <redacted>', Boolean(dText && dText.includes('token: <redacted>')), JSON.stringify(dText))
  check('D 的 cordis 文件没有被本机值顶掉', Boolean(dText && !dText.includes('local-secret')), JSON.stringify(dText))

  console.log(`
done: ${passes} passed, ${failures} failed`)
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
  if (failures) process.exit(1)
}

main().catch((err) => {
  console.error('section-model 测试异常：', err)
  process.exit(1)
})
