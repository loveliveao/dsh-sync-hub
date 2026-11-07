/**
 * P0-3：custom 分区拉取不能抹掉用户真实值。
 *
 *   node tests/custom-section.test.mjs
 *
 * 覆盖：
 *  1. SECTION_DEFS 里有 custom 段（kind=redacted，中英文案齐，默认关闭）
 *  2. collectAll 收 custom 时每条都带 meta.kind，配置文件是 redacted、普通文件是 files
 *  3. 拉取远端的脱敏副本时，本机真实值不被 <redacted> 覆盖（走合并路径）
 *  4. 本机没有这个文件时，不落地一份内容是 <redacted> 的占位文件
 *  5. snapshot 的分区列表里 custom 只出现一次，且 enabled 跟 customPaths 走
 */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME_A = await mkdtemp(join(tmpdir(), 'sync-hub-custom-a-'))
const HOME_B = await mkdtemp(join(tmpdir(), 'sync-hub-custom-b-'))
const HOME_C = await mkdtemp(join(tmpdir(), 'sync-hub-custom-c-'))
const REMOTE = await mkdtemp(join(tmpdir(), 'sync-hub-custom-remote-'))

process.env.DSH_HOME = HOME_A

const { defaultState, normalizeSettings } = await import('../lib/state.mjs')
const { SECTION_DEFS, collectAll, settingsSections, customEnabled, sectionDef } = await import('../lib/sections.mjs')
const { buildPlan, runSync, snapshot } = await import('../lib/engine.mjs')
const { localTransport } = await import('../lib/transport/local.mjs')
const { redactText } = await import('../lib/privacy.mjs')
const { sha256 } = await import('../lib/util.mjs')

let failures = 0
function check(label, ok, detail = '') {
  if (ok) {
    console.log('  \u2713 ' + label)
  } else {
    failures += 1
    console.log('  \u2717 ' + label + (detail ? ' \u2014 ' + detail : ''))
  }
}

const REL = 'notes/app.yml'
const MD_REL = 'notes/readme.md'
const ID = 'custom:' + REL
const MANIFEST_PATH = join(REMOTE, 'manifest.json')

const ALL_OFF = {
  cordis: false,
  skills: false,
  plugins: false,
  pluginConfig: false,
  workspaces: false,
  sessions: false,
  secrets: false,
  pluginData: false,
}

function makeState(home) {
  process.env.DSH_HOME = home
  const state = defaultState()
  state.settings = normalizeSettings({
    transport: 'local',
    sections: { ...ALL_OFF },
    customPaths: [{ rel: 'notes', enabled: true }],
  })
  state.settings.remote.path = REMOTE
  return state
}

function transportFor(state) {
  return localTransport(state.settings)
}

async function readRemoteBlob(sha) {
  return readFile(join(REMOTE, 'blobs', sha.slice(0, 2), sha), 'utf8')
}

async function setRemoteBlob(id, text) {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const sha = sha256(Buffer.from(text, 'utf8'))
  await mkdir(join(REMOTE, 'blobs', sha.slice(0, 2)), { recursive: true })
  await writeFile(join(REMOTE, 'blobs', sha.slice(0, 2), sha), text, 'utf8')
  manifest.entries[id] = {
    ...manifest.entries[id],
    sha,
    bytes: Buffer.byteLength(text),
    mtimeMs: Date.now(),
  }
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8')
  return sha
}

console.log('[1] custom 分区定义')
{
  const def = SECTION_DEFS.find((item) => item.id === 'custom')
  check('SECTION_DEFS 里有 custom 段', Boolean(def))
  check('custom 段 kind 是 redacted', Boolean(def) && def.kind === 'redacted', def && def.kind)
  check('custom 段中英文案齐', Boolean(def && def.label && def.label.zh && def.label.en && def.desc && def.desc.zh && def.desc.en))
  check('custom 段默认关闭', Boolean(def) && def.default === false)
  check('sectionDef(\'custom\') 能查到', Boolean(sectionDef('custom')))
  check('settingsSections 里 custom 默认是 false', settingsSections({}).custom === false)
  check('customEnabled：没有 customPaths 时是 false', customEnabled({}) === false)
  check('customEnabled：customPaths 缺失也不抛异常', customEnabled({ customPaths: null }) === false)
  check('customEnabled：有启用的自定义路径时是 true', customEnabled({ customPaths: [{ rel: 'notes', enabled: true }] }) === true)
  check('customEnabled：自定义路径全禁用时是 false', customEnabled({ customPaths: [{ rel: 'notes', enabled: false }] }) === false)
}

console.log('\n[2] collectAll 收 custom')
{
  const state = makeState(HOME_A)
  await mkdir(join(HOME_A, 'notes'), { recursive: true })
  const localText = 'apiKey: machine-a-secret-value\ngreeting: hello\n'
  await writeFile(join(HOME_A, REL), localText, 'utf8')
  await writeFile(join(HOME_A, MD_REL), 'readme\n', 'utf8')

  const collected = await collectAll(state.settings)
  check('collectAll 没有报错', collected.errors.length === 0, JSON.stringify(collected.errors))
  const customEntries = collected.entries.filter((entry) => entry.section === 'custom')
  check('收集到了 custom 条目', customEntries.length === 2, JSON.stringify(customEntries.map((e) => e.rel)))
  const yml = customEntries.find((entry) => entry.rel.endsWith('app.yml'))
  const md = customEntries.find((entry) => entry.rel.endsWith('readme.md'))
  check('yml 条目 meta.kind=redacted', Boolean(yml && yml.meta) && yml.meta.kind === 'redacted', JSON.stringify(yml && yml.meta))
  check('md 条目 meta.kind=files', Boolean(md && md.meta) && md.meta.kind === 'files', JSON.stringify(md && md.meta))
  check(
    'yml 条目的 sha 是脱敏之后算的',
    Boolean(yml) && yml.sha === sha256(Buffer.from(redactText(localText).text, 'utf8')),
    (yml && yml.sha) + ' vs ' + sha256(Buffer.from(redactText(localText).text, 'utf8')),
  )
  check(
    'yml 条目的 sha 不等于明文内容的 sha',
    Boolean(yml) && yml.sha !== sha256(Buffer.from(localText, 'utf8')),
  )
  check('md 条目的 sha 是原文 sha', Boolean(md) && md.sha === sha256(Buffer.from('readme\n', 'utf8')))

  const noCustom = makeState(HOME_A)
  noCustom.settings.customPaths = []
  const collected2 = await collectAll(noCustom.settings)
  check('没有自定义路径时不收 custom 条目', collected2.entries.filter((e) => e.section === 'custom').length === 0)
  check('没有自定义路径时也不报错', collected2.errors.length === 0, JSON.stringify(collected2.errors))
}

console.log('\n[3] 机器 A 推送：上传的必须是脱敏副本')
{
  const state = makeState(HOME_A)
  const transport = transportFor(state)
  const pushed = await runSync({ state, transport, version: 'test' })
  check('A 同步成功', pushed.ok, JSON.stringify(pushed.failures))
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const entry = manifest.entries[ID]
  check('manifest 里有 custom 条目', Boolean(entry), JSON.stringify(Object.keys(manifest.entries)))
  check('manifest 条目 meta.kind=redacted', Boolean(entry && entry.meta) && entry.meta.kind === 'redacted', JSON.stringify(entry && entry.meta))
  const mdEntry = manifest.entries['custom:' + MD_REL]
  check('普通文件的 meta.kind=files', Boolean(mdEntry && mdEntry.meta) && mdEntry.meta.kind === 'files', JSON.stringify(mdEntry && mdEntry.meta))
  const blob = entry ? await readRemoteBlob(entry.sha) : ''
  check('上传的 blob 是脱敏副本', blob.includes('<redacted>') && !blob.includes('machine-a-secret-value'), blob)
}

console.log('\n[4] 机器 B 拉取：本机真实值不能被 <redacted> 顶掉')
{
  const state = makeState(HOME_B)
  await mkdir(join(HOME_B, 'notes'), { recursive: true })
  await writeFile(join(HOME_B, REL), 'apiKey: machine-b-secret-value\ngreeting: hello\n', 'utf8')
  await writeFile(join(HOME_B, MD_REL), 'readme\n', 'utf8')
  const transport = transportFor(state)

  // B 先把自己的版本推上去（基线 = B 自己的 sha）。
  const first = await runSync({ state, transport, version: 'test' })
  check('B 首轮同步成功', first.ok, JSON.stringify(first.failures))

  // 模拟另一台机器改了远端。
  const remoteSha = await setRemoteBlob(ID, 'apiKey: <redacted>\ngreeting: hello\nadded: by-remote\n')

  const plan = await buildPlan({ state, transport, version: 'test', persist: false })
  check('B 的计划里出现 1 个待拉取', plan.plan.totals.pull === 1, JSON.stringify(plan.plan.totals))

  const pulled = await runSync({ state, transport, version: 'test' })
  check('B 拉取同步成功', pulled.ok, JSON.stringify(pulled.failures))
  check('B 确实拉了 1 个条目', pulled.pulled.length === 1, JSON.stringify(pulled.pulled))

  const localText = await readFile(join(HOME_B, REL), 'utf8')
  check('B 的真实值没被 <redacted> 覆盖', localText.includes('machine-b-secret-value'), localText)
  check('B 的文件里没有 <redacted> 占位', !localText.includes('<redacted>'), localText)
  check('远端带来的新行合并进来了', localText.includes('added: by-remote'), localText)
  check('base 记的是远端这一版的 sha', state.base[ID] === remoteSha, String(state.base[ID]) + ' vs ' + remoteSha)

  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const blob = await readRemoteBlob(manifest.entries[ID].sha)
  check('B 的真实值没有泄漏到远端', !blob.includes('machine-b-secret-value'), blob)
}

console.log('\n[5] 机器 C 没有这个文件：不能落地一份 <redacted> 占位文件')
{
  const state = makeState(HOME_C)
  const transport = transportFor(state)

  const plan = await buildPlan({ state, transport, version: 'test', persist: false })
  check(
    'C 的计划里这一条被跳过（远端是脱敏副本）',
    plan.plan.skipped.some((item) => item.id === ID && String(item.reason).includes('脱敏副本')),
    JSON.stringify(plan.plan.skipped),
  )
  const synced = await runSync({ state, transport, version: 'test' })
  check('C 同步成功', synced.ok, JSON.stringify(synced.failures))
  check('C 没有拉取那个脱敏的 yml（普通文件该拉还是拉）', synced.pulled.every((item) => item.id !== ID), JSON.stringify(synced.pulled))
  const exists = await stat(join(HOME_C, REL)).then(() => true, () => false)
  check('C 本机没有多出这个文件', !exists)

  console.log('  \u00b7 老 manifest（没有 meta）时也要挡住')
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  manifest.entries[ID] = { ...manifest.entries[ID], meta: null }
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8')

  const state2 = makeState(HOME_C)
  const transport2 = transportFor(state2)
  const synced2 = await runSync({ state: state2, transport: transport2, version: 'test' })
  check('C 老 manifest 场景同步不报错', synced2.ok, JSON.stringify(synced2.failures))
  const stillMissing = await stat(join(HOME_C, REL)).then(() => true, () => false)
  check('C 老 manifest 场景也没有落地占位文件', !stillMissing)
  const written = synced2.pulled.length === 1 ? synced2.pulled[0].written : null
  check('C 老 manifest 场景这一条没被写下去', synced2.pulled.length === 0 || written === false, JSON.stringify(synced2.pulled))
}

console.log('\n[6] snapshot 里的 custom 段')
{
  const state = makeState(HOME_A)
  const transport = transportFor(state)
  const snap = await snapshot({ state, version: 'test', transport })
  const customs = snap.sections.filter((item) => item.id === 'custom')
  check('分区列表里有 custom', customs.length === 1, JSON.stringify(snap.sections.map((s) => s.id)))
  check('custom 只出现一次（没有重复条目）', customs.length === 1, String(customs.length))
  check('custom.enabled 跟着 customPaths 走', Boolean(customs[0]) && customs[0].enabled === true, JSON.stringify(customs[0]))
  check('custom.kind 是 redacted', Boolean(customs[0]) && customs[0].kind === 'redacted', customs[0] && customs[0].kind)
  check('custom 有中英文 label', Boolean(customs[0] && customs[0].label && customs[0].label.zh && customs[0].label.en))
  check('custom 的 count 统计到了条目', Boolean(customs[0]) && customs[0].count >= 2, String(customs[0] && customs[0].count))

  const off = makeState(HOME_A)
  off.settings.customPaths = []
  const snapOff = await snapshot({ state: off, version: 'test', transport })
  const customsOff = snapOff.sections.filter((item) => item.id === 'custom')
  check('没有自定义路径时 custom.enabled=false', Boolean(customsOff[0]) && customsOff[0].enabled === false, JSON.stringify(customsOff[0]))
}

await rm(REMOTE, { recursive: true, force: true })
await rm(HOME_A, { recursive: true, force: true })
await rm(HOME_B, { recursive: true, force: true })
await rm(HOME_C, { recursive: true, force: true })
console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
