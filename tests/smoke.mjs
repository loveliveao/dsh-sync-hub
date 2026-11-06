/**
 * 无宿主冒烟测试：只依赖 Node 内置模块，直接跑采集 / 计划 / 同步。
 *
 *   node tests/smoke.mjs
 *
 * 会在临时目录建一个「远端同步文件夹」，然后：
 *   1. 采集本机真实 DSH_HOME（只读）
 *   2. 首次同步（推送）
 *   3. 再次计划（应为 0 变更）
 *   4. 修改远端某个会话文件模拟另一台机器 → 计划里应出现拉取
 *   5. 检查隐私边界：凭据文件不在 entries 里
 */
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectAll } from '../lib/sections.mjs'
import { buildPlan, runSync } from '../lib/engine.mjs'
import { localTransport } from '../lib/transport/local.mjs'
import { defaultState, normalizeSettings } from '../lib/state.mjs'
import { detectVersion } from '../lib/version.mjs'
import { isForbiddenRel } from '../lib/privacy.mjs'
import { sha256 } from '../lib/util.mjs'

let failures = 0

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main() {
  const version = await detectVersion()
  console.log(`DSH ${version.version || '未知'}（${version.edition}）· node ${version.node}`)

  const state = defaultState()
  state.settings = normalizeSettings({ transport: 'local', sections: { sessions: true }, sessions: { maxBytes: 0 } })

  console.log('\n[1] 采集')
  const collected = await collectAll(state.settings)
  const sections = [...new Set(collected.entries.map((e) => e.section))]
  console.log(`  条目 ${collected.entries.length} 个，范围 ${sections.join(', ')}`)
  check('采集没有抛错', collected.errors.length === 0, JSON.stringify(collected.errors))
  check('没有任何凭据文件进入同步集合', collected.entries.every((e) => !isForbiddenRel(e.rel)))
  check('cordis 条目已脱敏', collected.entries.some((e) => e.section === 'cordis' && e.meta && e.meta.kind === 'redacted'))
  const cordis = collected.entries.find((e) => e.rel.endsWith('cordis.patch.yml'))
  if (cordis) {
    const text = cordis.blob.toString('utf8')
    check('脱敏后不残留可疑长密钥', !/(apiKey|token|secret):\s*["']?[A-Za-z0-9_\-]{20,}/i.test(text))
  }

  console.log('\n[2] 首次同步（推送）')
  const startedAt = Date.now()
  const remoteDir = await mkdtemp(join(tmpdir(), 'sync-hub-smoke-'))
  state.settings.remote.path = remoteDir
  const transport = localTransport(state.settings)
  const first = await runSync({ state, transport, version })
  check('首次同步成功', first.ok, JSON.stringify(first.failures.slice(0, 3)))
  check('推送条目等于采集条目', first.pushed.length === collected.entries.length, `${first.pushed.length} vs ${collected.entries.length}`)
  const manifest = JSON.parse(await readFile(join(remoteDir, 'manifest.json'), 'utf8'))
  check('manifest 有设备记录', Object.keys(manifest.devices).length === 1)
  check('manifest 条目数与推送数一致', Object.keys(manifest.entries).length === first.pushed.length)

  console.log('\n[3] 二次计划（应为空）')
  const second = await buildPlan({ state, transport, version, persist: false })
  // 本机正在运行的会话文件会在测试期间被持续写入，二次计划里必然还挂着它。
  // 这属于「活文件」，不是同步缺陷 —— 把它单独挑出来再断言。
  const live = second.plan.push.filter((e) => e.mtimeMs >= startedAt - 1000)
  const stable = second.plan.push.filter((e) => e.mtimeMs < startedAt - 1000)
  if (live.length) console.log(`  · 跳过 ${live.length} 个测试期间仍在写入的会话文件`)
  check('没有待推送（排除活文件）', stable.length === 0, JSON.stringify(stable.slice(0, 3)))
  check('没有待拉取', second.plan.totals.pull === 0, JSON.stringify(second.plan.pull.slice(0, 3)))
  check('没有冲突', second.plan.totals.conflicts === 0)

  console.log('\n[4] 远端出现新会话 → 应拉取')
  const sessionEntry = Object.values(manifest.entries).find((e) => e.section === 'sessions')
  if (!sessionEntry) {
    console.log('  - 跳过（本机没有会话条目）')
  } else {
    const remoteBlobDir = join(remoteDir, 'blobs', sessionEntry.sha.slice(0, 2))
    await writeFile(join(remoteBlobDir, sessionEntry.sha), Buffer.from('fake-session-bytes'))
    manifest.entries[sessionEntry.id].sha = sha256(Buffer.from('fake-session-bytes'))
    manifest.entries[sessionEntry.id].bytes = 17
    manifest.entries[sessionEntry.id].mtimeMs = Date.now() + 60000
    await writeFile(join(remoteDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    const plan3 = await buildPlan({ state, transport, version, persist: false })
    check('识别出 1 个待拉取', plan3.plan.totals.pull === 1, JSON.stringify(plan3.plan.totals))
    // 不真的拉取，避免覆盖真实会话文件
    check('待拉取条目属于 sessions', plan3.plan.pull[0] && plan3.plan.pull[0].section === 'sessions')
  }

  console.log('\n[5] 隐私：manifest 里不含密钥')
  const raw = await readFile(join(remoteDir, 'manifest.json'), 'utf8')
  check('manifest 不含 sk-/ghp_ 前缀的令牌', !/\b(sk|ghp|gho|github_pat)[-_A-Za-z0-9]{16,}\b/.test(raw))
  check('manifest 不含凭据文件路径', !raw.includes('.credentials'))

  await rm(remoteDir, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('冒烟测试崩溃：', err)
  process.exit(1)
})
