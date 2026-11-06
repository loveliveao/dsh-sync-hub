/**
 * 传输通道「测试连接」的分步清单自检。
 *
 *   node tests/transport.test.mjs
 *
 * 覆盖：
 *   1. local —— 目录存在时：步骤齐全、字段齐全、ok 是布尔
 *   2. local —— 路径不存在时：resolve 而不是抛异常，ok===false 且有失败步骤
 *   3. git / webdav —— 无凭据、连不上时也 resolve（不抛异常），带 steps 数组
 *   4. 凭据不外泄：令牌和 base64 认证头都不出现在返回值里
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localTransport } from '../lib/transport/local.mjs'
import { gitTransport } from '../lib/transport/git.mjs'
import { webdavTransport } from '../lib/transport/webdav.mjs'
import { pathExists } from '../lib/util.mjs'

let failures = 0

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 每个步骤都必须是 { id, label, ok, detail, severity }。 */
function stepsWellFormed(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return false
  return steps.every(
    (step) =>
      step &&
      typeof step.id === 'string' &&
      step.id.length > 0 &&
      typeof step.label === 'string' &&
      step.label.length > 0 &&
      typeof step.ok === 'boolean' &&
      typeof step.detail === 'string' &&
      ['info', 'warn', 'error'].includes(step.severity),
  )
}

function printSteps(title, res) {
  console.log(`\n  ${title}`)
  for (const step of res.steps || []) {
    const mark = step.ok ? (step.severity === 'warn' ? '!' : '✓') : '✗'
    console.log(`   ${mark} [${step.id}] ${step.label} —— ${step.detail || '（无补充）'}`)
  }
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-sync-hub-transport-'))
  // git 通道的本地工作副本挂在 DSH_HOME 下，指到临时目录，别污染真实 home
  const fakeHome = await mkdtemp(join(tmpdir(), 'dsh-home-'))
  process.env.DSH_HOME = fakeHome

  console.log('\n[1] local：文件夹存在')
  const dir = join(scratch, 'shared')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ entries: { a: { sha: 'x' } }, devices: { d: {} } }))

  const local = localTransport({ remote: { path: dir } })
  const res = await local.test()
  printSteps('local 步骤清单：', res)
  check('local test() resolve 出对象', Boolean(res) && typeof res === 'object')
  check('local 有 steps 数组', Array.isArray(res.steps))
  check('local 至少 3 步', (res.steps || []).length >= 3, `实际 ${(res.steps || []).length} 步`)
  check('local 每步字段齐全', stepsWellFormed(res.steps))
  check('local ok 是布尔', typeof res.ok === 'boolean')
  check('local ok === true', res.ok === true, res.message)
  check('local message 是非空字符串', typeof res.message === 'string' && res.message.length > 0)
  check('local detail 是字符串', typeof res.detail === 'string')
  check('local 步骤 id 是小写英文', res.steps.every((s) => /^[a-z][a-z0-9-]*$/.test(s.id)))
  check('local 报出了已有条目', res.detail.includes('已有') || res.detail.includes('空目录'), res.detail)
  const leftovers = (await readdir(dir)).filter((n) => n.includes('probe'))
  check('local 探针文件已清理', leftovers.length === 0, leftovers.join(','))

  console.log('\n[2] local：路径不存在')
  const missing = join(dir, 'not-created-yet', 'nested')
  const local2 = localTransport({ remote: { path: missing } })
  const res2 = await local2.test()
  printSteps('local 步骤清单：', res2)
  check('local 不存在的路径也 resolve', Boolean(res2))
  check('local 不存在的路径 ok === false', res2.ok === false, res2.message)
  check('local 有一步 ok === false', res2.steps.some((s) => s.ok === false))
  check('local 失败步骤说了原因', res2.steps.filter((s) => !s.ok).every((s) => s.detail.length > 0))
  check('local 失败步骤提到自动创建或无法创建', /自动创建|无法创建/.test(res2.steps.map((s) => s.detail).join(' ')))
  check('local 测试不偷偷建目录', !(await pathExists(missing)))

  console.log('\n[3] git：无凭据 / 连不上')
  const gitEmpty = gitTransport({ remote: {} }, {})
  const gitRes0 = await gitEmpty.test()
  check('git 没填仓库地址时 resolve', Boolean(gitRes0))
  check('git 没填仓库地址时有 steps', Array.isArray(gitRes0.steps) && gitRes0.steps.length > 0)
  check('git 没填仓库地址时 ok === false', gitRes0.ok === false)

  const gitBad = gitTransport({ remote: { repo: 'http://127.0.0.1:9/x/y.git', branch: 'main' } }, {})
  const gitRes = await gitBad.test()
  printSteps('git 步骤清单：', gitRes)
  check('git 连不上时 resolve 而不是抛异常', Boolean(gitRes))
  check('git 连不上时 ok === false', gitRes.ok === false)
  check('git 失败步骤有说明', gitRes.steps.some((s) => !s.ok && s.detail.length > 0))
  check('git message 是非空字符串', typeof gitRes.message === 'string' && gitRes.message.length > 0)

  console.log('\n[4] webdav：无凭据 / 连不上')
  const davEmpty = webdavTransport({ remote: {} }, {})
  const davRes0 = await davEmpty.test()
  check('webdav 没填地址时 resolve', Boolean(davRes0))
  check('webdav 没填地址时有 steps', Array.isArray(davRes0.steps) && davRes0.steps.length > 0)
  check('webdav 没填地址时 ok === false', davRes0.ok === false)

  const davBad = webdavTransport({ remote: { url: 'http://127.0.0.1:9/dav' } }, {})
  const davRes = await davBad.test()
  printSteps('webdav 步骤清单：', davRes)
  check('webdav 连不上时 resolve 而不是抛异常', Boolean(davRes))
  check('webdav 连不上时 ok === false', davRes.ok === false)
  check('webdav 有一步说明连不上', davRes.steps.some((s) => /连不上|网络/.test(s.detail)))
  check('webdav 失败步骤被跳过时写明原因', davRes.steps.filter((s) => !s.ok).every((s) => s.detail.length > 0))

  console.log('\n[5] 凭据不外泄')
  const secret = 'SECRET-TOKEN-abc123'
  const gitSecret = gitTransport({ remote: { repo: 'http://127.0.0.1:9/x/y.git' } }, { git: secret })
  const gitResSecret = await gitSecret.test()
  const dumped = JSON.stringify(gitResSecret)
  check('返回值里不出现令牌明文', !dumped.includes(secret))
  check('返回值里不出现 base64 认证头', !dumped.includes(Buffer.from(`x-access-token:${secret}`, 'utf8').toString('base64')))
  const davSecret = webdavTransport({ remote: { url: 'http://127.0.0.1:9/dav', username: 'me' } }, { webdav: 'p@ssw0rd-secret' })
  const davResSecret = await davSecret.test()
  check('webdav 返回值里不出现密码', !JSON.stringify(davResSecret).includes('p@ssw0rd-secret'))

  await rm(scratch, { recursive: true, force: true })
  await rm(fakeHome, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('传输通道自检崩溃：', err)
  process.exit(1)
})
