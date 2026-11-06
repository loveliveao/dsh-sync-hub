/**
 * 路径解析。所有落点都从 DSH_HOME 出发，不依赖插件包自己的位置。
 *
 * 桌面版把 DSH_HOME 固定为 %USERPROFILE%\.dsh；CLI 版可能用环境变量覆盖，
 * 所以两者都认。
 */
import { homedir, hostname } from 'node:os'
import { join, resolve, sep } from 'node:path'

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

/** 反方向：把 DSH_HOME 内的绝对路径转成 posix 风格相对路径。 */
export function toHomeRel(abs) {
  const home = resolve(dshHome())
  const full = resolve(abs)
  if (full === home) return ''
  if (!full.startsWith(home + sep)) return null
  return full.slice(home.length + 1).split(sep).join('/')
}
