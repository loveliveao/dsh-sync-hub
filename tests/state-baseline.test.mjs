/**
 * P0-2：状态白名单 + 同步基线语义。
 *
 *   node tests/state-baseline.test.mjs
 *
 * 覆盖四件事：
 *  1. normalizeState 不再把 ignoreAfterPull / localSha 丢掉（老 state.json 也能读）
 *  2. 非法输入（数组 / null / 字符串）一律回落成 {}，不抛异常
 *  3. 拉取之后 base 记的是「远端这一版的 sha」，本机这一版的 sha 另存 localSha
 *  4. 远端没变就不再重复拉取 / 覆写 / 备份；
 *     远端有本机没有的脱敏键时 ignoreAfterPull 真的生效（挂起，不再反复拉）
 */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = await mkdtemp(join(tmpdir(), 'sync-hub-state-baseline-'))
process.env.DSH_HOME = SANDBOX

const { defaultState, normalizeSettings, normalizeState, saveState, loadState } = await import('../lib/state.mjs')
const { statePath, backupsRoot } = await import('../lib/paths.mjs')
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

console.log('[1] normalizeState 收敛')
{
  const empty = normalizeState({})
  const emptyIgnore = empty.ignoreAfterPull
  const emptyLocal = empty.localSha
  check(
    '缺字段时 ignoreAfterPull 是 {} 而不是 undefined',
    Boolean(emptyIgnore) && typeof emptyIgnore === 'object' && !Array.isArray(emptyIgnore) && Object.keys(emptyIgnore).length === 0,
    JSON.stringify(emptyIgnore),
  )
  check(
    '缺字段时 localSha 是 {} 而不是 undefined',
    Boolean(emptyLocal) && typeof emptyLocal === 'object' && !Array.isArray(emptyLocal) && Object.keys(emptyLocal).length === 0,
    JSON.stringify(emptyLocal),
  )

  const kept = normalizeState({
    ignoreAfterPull: { 'custom:a.yml': { localSha: 'aaa', remoteSha: 'bbb' } },
    localSha: { 'custom:a.yml': 'aaa' },
  })
  check(
    '合法的 ignoreAfterPull 被保留',
    Boolean(kept.ignoreAfterPull['custom:a.yml']) &&
      kept.ignoreAfterPull['custom:a.yml'].localSha === 'aaa' &&
      kept.ignoreAfterPull['custom:a.yml'].remoteSha === 'bbb',
    JSON.stringify(kept.ignoreAfterPull),
  )
  check('合法的 localSha 被保留', kept.localSha['custom:a.yml'] === 'aaa', JSON.stringify(kept.localSha))

  for (const bad of [null, 'x', 42, [1, 2], true]) {
    const n = normalizeState({ ignoreAfterPull: bad, localSha: bad })
    check(
      '非法容器回落成 {} \u2014 ' + JSON.stringify(bad),
      Object.keys(n.ignoreAfterPull).length === 0 && Object.keys(n.localSha).length === 0,
      JSON.stringify({ ignoreAfterPull: n.ignoreAfterPull, localSha: n.localSha }),
    )
  }

  const half = normalizeState({
    ignoreAfterPull: { x: { localSha: 'a' }, y: { localSha: 'a', remoteSha: 'b' }, z: 'garbage' },
  })
  check(
    '缺字段 / 形状不对的挂起项被丢掉',
    !half.ignoreAfterPull.x && Boolean(half.ignoreAfterPull.y) && !half.ignoreAfterPull.z,
    JSON.stringify(half.ignoreAfterPull),
  )

  const scalars = normalizeState({ localSha: { a: 'sha', b: 12, c: true, d: { nested: 1 }, e: null } })
  check(
    'localSha 只留字符串 / 数字 / 布尔',
    scalars.localSha.a === 'sha' && scalars.localSha.b === 12 && scalars.localSha.c === true &&
      !scalars.localSha.d && !scalars.localSha.e,
    JSON.stringify(scalars.localSha),
  )
}

console.log('\n[2] 老 state.json（没有这两个字段）也能读')
{
  await mkdir(join(SANDBOX, 'sync-hub'), { recursive: true })
  await writeFile(
    statePath(),
    JSON.stringify({
      schema: 1,
      device: { id: 'old-device', name: '旧机器' },
      settings: {},
      base: { 'custom:a.yml': 'oldsha' },
    }),
    'utf8',
  )
  let loaded = null
  let threw = null
  try {
    loaded = await loadState({ refresh: true })
  } catch (err) {
    threw = err
  }
  check('读老文件不抛异常', !threw, String(threw && threw.message))
  check(
    '老文件的 ignoreAfterPull 回落成 {}',
    Boolean(loaded && loaded.ignoreAfterPull) && Object.keys(loaded.ignoreAfterPull).length === 0,
    JSON.stringify(loaded && loaded.ignoreAfterPull),
  )
  check(
    '老文件的 localSha 回落成 {}',
    Boolean(loaded && loaded.localSha) && Object.keys(loaded.localSha).length === 0,
    JSON.stringify(loaded && loaded.localSha),
  )
  check('老文件的 base 没丢', Boolean(loaded) && loaded.base['custom:a.yml'] === 'oldsha')
}

const REMOTE = await mkdtemp(join(tmpdir(), 'sync-hub-baseline-remote-'))
const REL = 'notes/app.yml'
const ID = 'custom:' + REL
const LOCAL_ABS = join(SANDBOX, 'notes', 'app.yml')
const MANIFEST_PATH = join(REMOTE, 'manifest.json')
let remoteSha = ''

async function setRemoteBlob(text) {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const sha = sha256(Buffer.from(text, 'utf8'))
  await mkdir(join(REMOTE, 'blobs', sha.slice(0, 2)), { recursive: true })
  await writeFile(join(REMOTE, 'blobs', sha.slice(0, 2), sha), text, 'utf8')
  manifest.entries[ID] = {
    ...manifest.entries[ID],
    sha,
    bytes: Buffer.byteLength(text),
    mtimeMs: Date.now(),
  }
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8')
  return sha
}

console.log('\n[3] 拉取之后基线记远端 sha')
{
  await mkdir(join(SANDBOX, 'notes'), { recursive: true })
  await writeFile(LOCAL_ABS, 'apiKey: my-real-secret-value\ngreeting: hello\n', 'utf8')

  const state = defaultState()
  state.settings = normalizeSettings({
    transport: 'local',
    sections: {
      cordis: false,
      skills: false,
      plugins: false,
      sessions: false,
      workspaces: false,
      pluginData: false,
      secrets: false,
      pluginConfig: false,
    },
    customPaths: [{ rel: REL, enabled: true }],
  })
  state.settings.remote.path = REMOTE
  const transport = localTransport(state.settings)

  console.log('  \u00b7 首轮：推送')
  const first = await runSync({ state, transport, version: 'test' })
  check('首轮同步成功', first.ok, JSON.stringify(first.failures))
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const pushed = manifest.entries[ID]
  check('自定义路径条目进了 manifest', Boolean(pushed), JSON.stringify(Object.keys(manifest.entries)))
  check(
    'manifest 条目标了 meta.kind=redacted',
    Boolean(pushed && pushed.meta) && pushed.meta.kind === 'redacted',
    JSON.stringify(pushed && pushed.meta),
  )
  const blob = pushed ? await readFile(join(REMOTE, 'blobs', pushed.sha.slice(0, 2), pushed.sha), 'utf8') : ''
  check('上传的 blob 是脱敏副本', blob.includes('<redacted>') && !blob.includes('my-real-secret-value'), blob)

  console.log('  \u00b7 3a：模拟另一台机器改了远端（键集合与本机一致）')
  remoteSha = await setRemoteBlob('apiKey: <redacted>\ngreeting: hello\nadded: by-remote\n')

  const plan = await buildPlan({ state, transport, version: 'test', persist: false })
  check('计划里出现 1 个待拉取', plan.plan.totals.pull === 1, JSON.stringify(plan.plan.totals))

  const pulled = await runSync({ state, transport, version: 'test' })
  check('拉取同步成功', pulled.ok, JSON.stringify(pulled.failures))
  check('确实拉了 1 个条目', pulled.pulled.length === 1, JSON.stringify(pulled.pulled))

  const localText = await readFile(LOCAL_ABS, 'utf8')
  check('本机真实值没被 <redacted> 顶掉', localText.includes('my-real-secret-value') && !localText.includes('<redacted>'), localText)

  check('base 记的是远端这一版的 sha', state.base[ID] === remoteSha, String(state.base[ID]) + ' vs ' + remoteSha)
  const canonical = sha256(Buffer.from(redactText(localText).text, 'utf8'))
  check('localSha 记的是本机规范形态 sha', state.localSha[ID] === canonical, String(state.localSha[ID]) + ' vs ' + canonical)
  check('本机已经收敛到远端的规范形态（不会反复拉）', state.localSha[ID] === remoteSha, String(state.localSha[ID]) + ' vs ' + remoteSha)

  console.log('  \u00b7 3a：第二轮，远端没变，不该再拉 / 再覆写 / 再备份')
  const mtimeBefore = (await stat(LOCAL_ABS)).mtimeMs
  const backupsBefore = (await readdir(backupsRoot()).catch(() => [])).length
  const plan2 = await buildPlan({ state, transport, version: 'test', persist: false })
  check('第二轮没有待拉取', plan2.plan.totals.pull === 0, JSON.stringify(plan2.plan.totals))
  check('第二轮没有待回推', plan2.plan.totals.push === 0, JSON.stringify(plan2.plan.totals))
  const second = await runSync({ state, transport, version: 'test' })
  check('第二轮没有真的拉取', second.pulled.length === 0, JSON.stringify(second.pulled))
  check('第二轮没有回推本机文件', second.pushed.length === 0, JSON.stringify(second.pushed))
  const mtimeAfter = (await stat(LOCAL_ABS)).mtimeMs
  const backupsAfter = (await readdir(backupsRoot()).catch(() => [])).length
  check('本机文件没有被重复覆写', mtimeAfter === mtimeBefore, mtimeBefore + ' -> ' + mtimeAfter)
  check('没有多出备份目录', backupsAfter === backupsBefore, backupsBefore + ' -> ' + backupsAfter)

  console.log('  \u00b7 3b：远端多了一个本机没有的脱敏键（合并无法收敛）')
  const remoteSha3b = await setRemoteBlob('apiKey: <redacted>\ngreeting: hello\nadded: by-remote\napiSecret: <redacted>\n')
  const plan3 = await buildPlan({ state, transport, version: 'test', persist: false })
  check('3b 计划里出现 1 个待拉取', plan3.plan.totals.pull === 1, JSON.stringify(plan3.plan.totals))
  const pulled3b = await runSync({ state, transport, version: 'test' })
  check('3b 拉取同步成功', pulled3b.ok, JSON.stringify(pulled3b.failures))
  const localText3b = await readFile(LOCAL_ABS, 'utf8')
  check('3b 本机真实值仍然没被顶掉', localText3b.includes('my-real-secret-value') && !localText3b.includes('<redacted>'), localText3b)
  check('3b base 记的是远端这一版的 sha', state.base[ID] === remoteSha3b, String(state.base[ID]) + ' vs ' + remoteSha3b)
  const hung = state.ignoreAfterPull[ID]
  check(
    '3b 这一条被挂起（localSha / remoteSha 都在）',
    Boolean(hung) && hung.remoteSha === remoteSha3b && typeof hung.localSha === 'string' && hung.localSha.length > 0,
    JSON.stringify(hung),
  )

  console.log('  \u00b7 3b：再下一轮，挂起的条目不该被反复拉')
  const plan4 = await buildPlan({ state, transport, version: 'test', persist: false })
  check('3b 第二轮没有待拉取', plan4.plan.totals.pull === 0, JSON.stringify(plan4.plan.totals))
  check(
    '3b 第二轮该条目被挂起（redacted-unresolved）',
    plan4.plan.skipped.some((item) => item.id === ID && item.reason === 'redacted-unresolved'),
    JSON.stringify(plan4.plan.skipped),
  )
  const mtimeBefore4 = (await stat(LOCAL_ABS)).mtimeMs
  const third = await runSync({ state, transport, version: 'test' })
  check('3b 第二轮没有真的拉取', third.pulled.length === 0, JSON.stringify(third.pulled))
  check('3b 第二轮没有回推本机文件', third.pushed.length === 0, JSON.stringify(third.pushed))
  check('3b 第二轮本机文件没有被覆写', (await stat(LOCAL_ABS)).mtimeMs === mtimeBefore4)
}

console.log('\n[4] 落盘后这两个字段还在')
{
  const state = defaultState()
  state.base = { [ID]: remoteSha }
  state.localSha = { [ID]: 'local-sha-placeholder' }
  state.ignoreAfterPull = { [ID]: { localSha: 'local-sha-placeholder', remoteSha } }
  await saveState(state)
  const onDisk = JSON.parse(await readFile(statePath(), 'utf8'))
  check(
    'state.json 里有 ignoreAfterPull',
    Boolean(onDisk.ignoreAfterPull) && typeof onDisk.ignoreAfterPull === 'object',
    JSON.stringify(onDisk.ignoreAfterPull),
  )
  check(
    'state.json 里有 localSha',
    Boolean(onDisk.localSha) && typeof onDisk.localSha === 'object',
    JSON.stringify(onDisk.localSha),
  )
  check('state.json 里的挂起项没丢', Boolean(onDisk.ignoreAfterPull[ID]), JSON.stringify(onDisk.ignoreAfterPull))
  check('state.json 里的 localSha 没丢', onDisk.localSha[ID] === 'local-sha-placeholder', JSON.stringify(onDisk.localSha))
  check('state.json 里的 base 没丢', onDisk.base[ID] === remoteSha, JSON.stringify(onDisk.base))
}

console.log('\n[5] snapshot 不崩')
{
  const state = defaultState()
  const transport = localTransport(state.settings)
  const snap = await snapshot({ state, version: 'test', transport })
  check('snapshot 正常返回', Boolean(snap) && Array.isArray(snap.sections))
}

await rm(REMOTE, { recursive: true, force: true })
await rm(SANDBOX, { recursive: true, force: true })
console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
