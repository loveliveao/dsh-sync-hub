/**
 * 路径解析。所有落点都从 DSH_HOME 出发，不依赖插件包自己的位置。
 *
 * 桌面版把 DSH_HOME 固定为 %USERPROFILE%\.dsh；CLI 版可能用环境变量覆盖，
 * 所以两者都认。
 */
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'

const DEFAULT_PROFILE = 'desktop'

export function dshHome() {
  const fromEnv = (process.env.DSH_HOME || '').trim()
  return fromEnv || join(homedir(), '.dsh')
}

/** 插件自己的数据目录：state.json、备份、git 工作区都放这里。 */
export function hubDir() {
  return join(dshHome(), 'sync-hub')
}

export function statePath() {
  return join(hubDir(), 'state.json')
}

export function backupsRoot() {
  return join(hubDir(), 'backups')
}

/** git 通道的本地工作副本（不是用户仓库）。 */
export function gitWorkdir() {
  return join(hubDir(), 'remote-git')
}

export function profilesRoot() {
  return join(dshHome(), 'profiles')
}

export function currentProfile() {
  const fromEnv = (process.env.DSH_PROFILE || '').trim()
  if (fromEnv) return fromEnv
  // CLI 启动形如 `dsh --profile <name>`；桌面版由 env 指定，两者都拿不到时
  // 才回落到默认 profile 名。
  const argv = process.argv || []
  for (let i = 0; i < argv.length; i += 1) {
    const item = String(argv[i])
    if (item === '--profile' && argv[i + 1]) return String(argv[i + 1])
    if (item.startsWith('--profile=')) return item.slice('--profile='.length)
  }
  return DEFAULT_PROFILE
}

export function profileDir(profile = currentProfile()) {
  return join(profilesRoot(), profile)
}

export function profilePackageJson(profile = currentProfile()) {
  return join(profileDir(profile), 'package.json')
}

export function profilePatch(profile = currentProfile()) {
  return join(profileDir(profile), 'cordis.patch.yml')
}

export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

export function projcacheRoot() {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions')
}

export function workspaceJson() {
  return join(dshHome(), 'storages', 'workspace.json')
}

export function skillsRoot() {
  return join(dshHome(), 'skills')
}

export function defaultDeviceName() {
  try {
    return hostname() || 'dsh-device'
  } catch {
    return 'dsh-device'
  }
}

/**
 * 把相对路径解析到 DSH_HOME 内。越界（`..`、绝对路径、盘符）直接抛错，
 * 因为 pull 会按远端 manifest 写文件，必须挡住路径穿越。
 */
export function resolveInsideHome(rel) {
  const home = resolve(dshHome())
  const abs = resolve(home, rel)
  if (abs !== home && !abs.startsWith(home + sep)) {
    throw new Error(`路径越界，拒绝访问：${rel}`)
  }
  return abs
}

/* ------------------------------------------------------------------ */
/* 真实路径守卫（软链接 / Windows 联接）                                */
/* ------------------------------------------------------------------ */

/**
 * DSH_HOME 的真实路径（解析掉软链接与联接）。
 *
 * 用户自己的 .dsh 目录可能就是一个联接（很常见），所以比较时必须用真实路径，
 * 否则「在 DSH_HOME 内」这个判断会把合法路径误判成越界。
 */
export async function realHome() {
  const home = resolve(dshHome())
  try {
    return await realpath(home)
  } catch {
    return home
  }
}

/**
 * 目标是否**真的**在 DSH_HOME 内（解析软链接 / 联接之后）。
 *
 * 字面检查挡不住这种布局：DSH_HOME 里某个目录是联接、指向别处 ——
 * 顺着它读会把 DSH_HOME 之外的文件一起同步出去，顺着它写会写到外面去。
 *
 * 做法：找出目标最近的「已存在」的祖先，对它做 realpath，看它是不是还在
 * DSH_HOME 的真实路径内。Windows 的联接在 lstat 看来就是符号链接，能识破。
 */
export async function isRealInsideHome(abs) {
  const home = resolve(dshHome())
  const target = resolve(abs)
  if (target !== home && !target.startsWith(home + sep)) return false
  const real = await realHome()
  let cur = target
  for (let depth = 0; depth < 64; depth += 1) {
    let st = null
    try {
      st = await lstat(cur)
    } catch {
      st = null
    }
    if (st) {
      let realCur = cur
      try {
        realCur = await realpath(cur)
      } catch {
        realCur = cur
      }
      return realCur === real || realCur.startsWith(real + sep)
    }
    const parent = dirname(cur)
    if (!parent || parent === cur) break
    cur = parent
  }
  return true
}

/**
 * 写入前的守卫：目标必须真的在 DSH_HOME 内，否则抛错。
 *
 * 抛错会被拉取循环逐条捕获 → 记进 failures，用户能在界面上看到「哪一条被拒了」，
 * 不会静默把文件写到 DSH_HOME 之外。
 */
export async function assertRealInsideHome(abs) {
  if (await isRealInsideHome(abs)) return resolve(abs)
  throw new Error(`路径通过链接越出了配置目录，拒绝访问：${abs}`)
}
/** 反方向：把 DSH_HOME 内的绝对路径转成 posix 风格相对路径。 */
export function toHomeRel(abs) {
  const home = resolve(dshHome())
  const full = resolve(abs)
  if (full === home) return ''
  if (!full.startsWith(home + sep)) return null
  return full.slice(home.length + 1).split(sep).join('/')
}
