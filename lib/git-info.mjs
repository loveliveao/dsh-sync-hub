/**
 * 只读探测工作区的 git 信息。
 *
 * 约束（AGENTS.md）：
 * - 不调用 git 命令、不 spawn 子进程、不碰用户仓库的任何状态；
 * - 只读 .git（目录或 worktree 指针文件）、.git/config、.git/HEAD；
 * - 任何异常都降级成「不是仓库」，绝不抛给调用方。
 */
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** 统一的「不是仓库」结果。 */
function emptyRepo() {
  return { isRepo: false, hasRemote: false, remote: null, branch: null, detached: false }
}

function existsFile(abs) {
  try {
    return statSync(abs).isFile()
  } catch {
    return false
  }
}

/**
 * 去掉 URL 里的凭据。
 *
 *   https://user:pass@host/x  ->  https://host/x
 *   ssh://git@host/x          ->  ssh://host/x
 *   git@host:owner/repo.git   ->  原样保留（scp 风格里的 SSH 用户名不是凭据）
 */
export function stripGitCredentials(url) {
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  if (!trimmed) return null
  const withScheme = /^([a-z][a-z0-9+.-]*):\/\/([^/@]*)@(.+)$/i.exec(trimmed)
  if (withScheme) return withScheme[1] + '://' + withScheme[3]
  const bare = /^([^/@\s:]+):([^/@\s]+)@(.+)$/.exec(trimmed)
  if (bare) return bare[3]
  return trimmed
}

/** 找到 .git 的真实目录（worktree / submodule 下 .git 是指针文件）。 */
function resolveGitDir(root) {
  const dotGit = join(root, '.git')
  let stat = null
  try {
    stat = statSync(dotGit)
  } catch {
    return null
  }
  if (stat.isDirectory()) return dotGit
  if (!stat.isFile()) return null
  let pointer = ''
  try {
    pointer = readFileSync(dotGit, 'utf8')
  } catch {
    return null
  }
  const match = /^\s*gitdir:\s*(.+)\s*$/m.exec(pointer)
  if (!match) return null
  const target = match[1].trim()
  const abs = isAbsolute(target) ? resolve(target) : resolve(root, target)
  try {
    return statSync(abs).isDirectory() ? abs : null
  } catch {
    return null
  }
}

/** config 文件位置；worktree 里 config 在主仓库（commondir 指向那里）。 */
function configPathFor(gitDir) {
  const direct = join(gitDir, 'config')
  if (existsFile(direct)) return direct
  try {
    const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
    if (common) {
      const abs = isAbsolute(common) ? resolve(common) : resolve(gitDir, common)
      const candidate = join(abs, 'config')
      if (existsFile(candidate)) return candidate
    }
  } catch {
    /* 普通仓库没有 commondir */
  }
  return null
}

/** 取第一个 [remote "x"] 的 url（已去凭据）。 */
function readFirstRemoteUrl(gitDir) {
  const file = configPathFor(gitDir)
  if (!file) return null
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let inRemote = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = /^\[([^\]]+)\]$/.exec(line)
    if (section) {
      const head = section[1].trim()
      inRemote = /^remote\s+"[^"]+"$/i.test(head) || /^remote\s+'[^']+'$/i.test(head)
      continue
    }
    if (!inRemote) continue
    const kv = /^url\s*=\s*(.*)$/i.exec(line)
    if (!kv) continue
    const url = stripGitCredentials(kv[1].trim())
    if (url) return url
  }
  return null
}

/** 解析 HEAD：ref -> 分支名；裸 sha -> detached。 */
function readHead(gitDir) {
  let text = ''
  try {
    text = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
  } catch {
    return { branch: null, detached: false }
  }
  const ref = /^ref:\s*(.+)$/i.exec(text)
  if (ref) {
    const full = ref[1].trim()
    let branch = full
    if (full.startsWith('refs/heads/')) branch = full.slice('refs/heads/'.length)
    else branch = full.split('/').pop()
    return { branch: branch || null, detached: false }
  }
  if (/^[0-9a-f]{7,64}$/i.test(text)) return { branch: null, detached: true }
  return { branch: null, detached: false }
}

/**
 * 探测目录是不是 git 仓库，并给出远端与当前分支。
 *
 * @param {string} rootDir 工作区目录
 * @returns {{isRepo:boolean,hasRemote:boolean,remote:string|null,branch:string|null,detached:boolean}}
 */
export function detectGitRepo(rootDir) {
  try {
    if (typeof rootDir !== 'string' || !rootDir.trim()) return emptyRepo()
    const root = resolve(rootDir)
    const gitDir = resolveGitDir(root)
    if (!gitDir) return emptyRepo()
    const remote = readFirstRemoteUrl(gitDir)
    const head = readHead(gitDir)
    return {
      isRepo: true,
      hasRemote: Boolean(remote),
      remote: remote || null,
      branch: head.branch,
      detached: head.detached,
    }
  } catch {
    return emptyRepo()
  }
}

export default detectGitRepo
