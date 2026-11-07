/**
 * git 信息探测：只读 .git，不调 git 命令，任何异常都降级。
 *
 *   node tests/git-info.test.mjs
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { detectGitRepo, stripGitCredentials } = await import('../lib/git-info.mjs')

let failures = 0

function check(label, ok, detail = '') {
  if (ok) {
    console.log('  ✓ ' + label)
  } else {
    failures += 1
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''))
  }
}

const SANDBOX = await mkdtemp(join(tmpdir(), 'sync-hub-git-info-'))

async function makeRepo(name, opts = {}) {
  const root = join(SANDBOX, name)
  await mkdir(root, { recursive: true })
  if (opts.pointer) {
    const real = join(SANDBOX, name + '-gitdir')
    await mkdir(real, { recursive: true })
    await writeFile(join(root, '.git'), 'gitdir: ' + real + '\n', 'utf8')
    await writeFile(join(real, 'config'), opts.config || '', 'utf8')
    await writeFile(join(real, 'HEAD'), opts.head || '', 'utf8')
    return root
  }
  const gitDir = join(root, '.git')
  await mkdir(gitDir, { recursive: true })
  await writeFile(join(gitDir, 'config'), opts.config || '', 'utf8')
  await writeFile(join(gitDir, 'HEAD'), opts.head || '', 'utf8')
  return root
}

console.log('[1] 普通仓库：远端去凭据 + 分支解析')
{
  const root = await makeRepo('repo-normal', {
    config: [
      '[core]',
      '\trepositoryformatversion = 0',
      '[remote "origin"]',
      '\turl = https://user:pass@example.com/owner/repo.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    ].join('\n'),
    head: 'ref: refs/heads/main\n',
  })
  const info = detectGitRepo(root)
  check('isRepo 为 true', info.isRepo === true)
  check('hasRemote 为 true', info.hasRemote === true)
  check('remote 去掉了凭据', info.remote === 'https://example.com/owner/repo.git', String(info.remote))
  check('branch 解析成 main', info.branch === 'main', String(info.branch))
  check('detached 为 false', info.detached === false)
}

console.log('\n[2] 没有远端的仓库')
{
  const root = await makeRepo('repo-no-remote', {
    config: '[core]\n\tbare = false\n',
    head: 'ref: refs/heads/dev\n',
  })
  const info = detectGitRepo(root)
  check('isRepo 为 true', info.isRepo === true)
  check('hasRemote 为 false', info.hasRemote === false)
  check('remote 为 null', info.remote === null)
  check('branch 是 dev', info.branch === 'dev', String(info.branch))
}

console.log('\n[3] detached HEAD')
{
  const root = await makeRepo('repo-detached', {
    config: '[core]\n',
    head: '9fceb02b1b0e6b1c2d3e4f5a6b7c8d9e0f1a2b3c\n',
  })
  const info = detectGitRepo(root)
  check('detached 为 true', info.detached === true)
  check('branch 为 null', info.branch === null, String(info.branch))
}

console.log('\n[4] 非仓库 / 不存在的路径 / 非法入参')
{
  const plain = join(SANDBOX, 'plain')
  await mkdir(plain, { recursive: true })
  const info = detectGitRepo(plain)
  check('普通目录 isRepo 为 false', info.isRepo === false)
  check('普通目录 remote 为 null', info.remote === null)
  let threw = false
  let info2 = null
  try {
    info2 = detectGitRepo(join(SANDBOX, 'does-not-exist'))
  } catch {
    threw = true
  }
  check('不存在的路径不抛异常', !threw)
  check('不存在的路径 isRepo 为 false', Boolean(info2) && info2.isRepo === false)
  let threw2 = false
  try {
    detectGitRepo(null)
    detectGitRepo(123)
  } catch {
    threw2 = true
  }
  check('非法入参不抛异常', !threw2)
}

console.log('\n[5] worktree（.git 是指针文件）')
{
  const root = await makeRepo('repo-worktree', {
    pointer: true,
    config: '[remote "origin"]\n\turl = git@github.com:owner/repo.git\n',
    head: 'ref: refs/heads/feature/x\n',
  })
  const info = detectGitRepo(root)
  check('worktree 也算仓库', info.isRepo === true)
  check('scp 风格 remote 保留原样', info.remote === 'git@github.com:owner/repo.git', String(info.remote))
  check('branch 是 feature/x', info.branch === 'feature/x', String(info.branch))
}

console.log('\n[6] 凭据剥离')
{
  check('https 凭据被去掉', stripGitCredentials('https://user:pass@example.com/x.git') === 'https://example.com/x.git')
  check('ssh 凭据被去掉', stripGitCredentials('ssh://git@example.com/x.git') === 'ssh://example.com/x.git')
  check('scp 风格原样保留', stripGitCredentials('git@example.com:owner/x.git') === 'git@example.com:owner/x.git')
  check('空串返回 null', stripGitCredentials('') === null)
  check('非字符串返回 null', stripGitCredentials(null) === null)
}

await rm(SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
console.log(failures ? '\n✗ ' + failures + ' 项未通过' : '\n✓ 全部通过')
process.exitCode = failures ? 1 : 0
