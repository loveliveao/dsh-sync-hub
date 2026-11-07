/**
 * Git 通道的安全加固自检。
 *
 *   node tests/git-guard.test.mjs
 *
 * 覆盖三件事（都是竞品 dsh-sync README 里踩过的坑）：
 *   1. 令牌走环境变量 GIT_CONFIG_*，不进命令行参数（argv 全机 ps 可见）
 *   2. 公开仓库闸门：开了「同步凭据与密钥」又用匿名可读的仓库 → 直接拦住
 *   3. 拦截时不泄露任何凭据
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileP } from '../lib/util.mjs'
import { gitTransport } from '../lib/transport/git.mjs'

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
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-sync-hub-guard-'))
  const fakeHome = await mkdtemp(join(tmpdir(), 'dsh-home-guard-'))
  process.env.DSH_HOME = fakeHome

  console.log('\n[1] 令牌不进命令行')
  const dummyToken = 'placeholder-not-a-real-token'
  const git = gitTransport({ remote: { repo: 'https://example.invalid/x/y.git' } }, { git: dummyToken })
  const env = await git.authEnv()
  check('authEnv 返回 GIT_CONFIG_COUNT', env.GIT_CONFIG_COUNT === '2', String(env.GIT_CONFIG_COUNT))
  check('认证头在环境变量里', String(env.GIT_CONFIG_VALUE_0 || '').includes('Authorization: Basic'))
  check('环境变量里是 base64 而不是明文令牌', !String(env.GIT_CONFIG_VALUE_0 || '').includes(dummyToken))
  check('credential.helper 被置空', env.GIT_CONFIG_VALUE_1 === '')
  check('新 git 不再往命令行塞认证头', git.authArgsFor(env).length === 0, git.authArgsFor(env).join(' '))
  const legacy = git.legacyAuthArgs()
  const legacyJoined = legacy.join(' ')
  check('老 git 退路里也只有 base64，没有明文令牌', !legacyJoined.includes(dummyToken))
  check(
    '不设置 MSYS2_ARG_CONV_EXCL（会弄坏 git 自己的 upload-pack 调用）',
    env.MSYS2_ARG_CONV_EXCL === undefined && env.MSYS_NO_PATHCONV === undefined,
    JSON.stringify({ MSYS2_ARG_CONV_EXCL: env.MSYS2_ARG_CONV_EXCL, MSYS_NO_PATHCONV: env.MSYS_NO_PATHCONV }),
  )

  console.log('\n[2] 公开仓库闸门')
  // 造一个本地裸仓库：它天然是「匿名可读」的，等价于公开仓库
  const bare = join(scratch, 'public.git')
  await execFileP('git', ['init', '-q', '--bare', bare], { cwd: scratch })
  const fileUrl = `file:///${bare.replace(/\\/g, '/').replace(/^\/+/, '')}`

  const guarded = gitTransport(
    { remote: { repo: fileUrl, branch: 'main' }, sections: { secrets: true } },
    {},
  )
  const blocked = await guarded.guardSecrets({ sections: { secrets: true } })
  check('公开仓库 + 开启凭据同步 → 拦截', blocked.ok === false, JSON.stringify(blocked))
  check('拦截理由是中文可读文本', /公开|匿名/.test(String(blocked.message || '')), String(blocked.message))
  check('拦截消息里不含任何凭据', !/SECRET|token|ghp_|sk-/.test(String(blocked.message || '')))

  console.log('\n[3] 不该拦的情况')
  const off = await guarded.guardSecrets({ sections: { secrets: false } })
  check('凭据同步关闭 → 放行', off.ok === true, JSON.stringify(off))
  const noRepo = gitTransport({ remote: {} }, {})
  const off2 = await noRepo.guardSecrets({ sections: { secrets: true } })
  check('没填仓库地址 → 放行（另一个错误单独报）', off2.ok === true, JSON.stringify(off2))

  await rm(scratch, { recursive: true, force: true })
  await rm(fakeHome, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('git 安全闸门自检崩溃：', err)
  process.exit(1)
})
