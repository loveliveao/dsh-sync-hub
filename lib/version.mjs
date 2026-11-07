/**
 * DSH 版本与运行环境探测。
 *
 * 插件运行在宿主进程里，拿不到宿主包的 package.json 导出（asar 未解包），
 * 桌面版却能读到 resources 下的 runtime.json —— 那里有 desktopVersion 与
 * 内置 node/pnpm 版本。CLI 部署则回落到环境变量与 profile 依赖。
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome, profileDir, profilePackageJson, currentProfile } from './paths.mjs'
import { readJson } from './util.mjs'

/**
 * 插件自身版本（读同目录的 package.json）。
 * 之前 index.js 里写死了一个字符串，每次改版本号都会漏掉界面显示。
 */
export function pluginVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf8')
    const version = JSON.parse(raw).version
    return typeof version === 'string' && version ? version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function resourceRoots() {
  const roots = new Set()
  const push = (value) => {
    if (value && typeof value === 'string') roots.add(value)
  }
  // 桌面版：<安装目录>\DeepSeek Harness.exe → <安装目录>\resources
  if (process.execPath) push(join(dirname(process.execPath), 'resources'))
  if (process.env.DSH_RESOURCES_DIR) push(process.env.DSH_RESOURCES_DIR)
  if (process.argv[1]) {
    const dir = dirname(process.argv[1])
    push(join(dir, 'resources'))
    push(join(dir, '..', 'resources'))
    // CLI 部署：<包根>/lib/bin.js → <包根>/../resources 不是安装目录，
    // 但 npx 缓存里没有 resources，这里只是兜底探测，读不到会自然跳过。
    push(join(dir, '..', '..', 'resources'))
  }
  return [...roots]
}

async function readRuntimeInfo() {
  for (const root of resourceRoots()) {
    const file = join(root, 'runtime', 'primary-runtime', 'runtime.json')
    const data = await readJson(file)
    if (data && (data.desktopVersion || data.version || data.nodeVersion)) {
      return {
        source: file,
        desktopVersion: data.desktopVersion || data.version || null,
        nodeVersion: data.nodeVersion || data.node || null,
        pnpmVersion: data.pnpmVersion || data.pnpm || null,
        pythonVersion: data.pythonVersion || data.python || null,
        platform: data.platform || null,
        arch: data.arch || null,
      }
    }
  }
  return null
}

async function readPackageVersion() {
  const candidates = [
    // 桌面版最权威的一处：asar 内的宿主包（Electron 的 fs 能读 asar 路径）
    ...resourceRoots().map((root) => join(root, 'app.asar', 'dsh', 'package.json')),
    // CLI 部署：node <包根>/lib/bin.js → <包根>/package.json
    ...(process.argv[1] ? [join(dirname(process.argv[1]), '..', 'package.json')] : []),
    join(dshHome(), 'package.json'),
    join(profileDir(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(dshHome(), 'cache', 'dsh', 'package.json'),
  ]
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(await readFile(candidate, 'utf8'))
      if (data && data.name && String(data.name).includes('dsh') && data.version) {
        return { version: String(data.version), source: candidate }
      }
    } catch {
      /* 下一个候选 */
    }
  }
  return null
}

/** 已装插件清单（profile 依赖 + bundles），给「设备」页做跨机对比。 */
export async function installedPlugins() {
  const pkg = await readJson(profilePackageJson())
  const deps = pkg && pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  const bundles = (pkg && pkg.dsh && Array.isArray(pkg.dsh.profile && pkg.dsh.profile.bundles)
    ? pkg.dsh.profile.bundles
    : (pkg && pkg.dsh && Array.isArray(pkg.dsh.bundles) ? pkg.dsh.bundles : [])) || []
  return {
    dependencies: Object.entries(deps)
      .map(([name, version]) => ({ name, version: String(version) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    bundles: bundles.map((item) => (typeof item === 'string' ? item : String(item && item.id || item))).filter(Boolean),
  }
}

let versionCache = null

export async function detectVersion({ refresh = false } = {}) {
  if (versionCache && !refresh) return versionCache
  const envVersion = [process.env.DSH_DESKTOP_VERSION, process.env.DSH_VERSION]
    .map((v) => (v || '').trim())
    .find(Boolean)
  const runtime = await readRuntimeInfo()
  const fromPkg = runtime ? null : await readPackageVersion()
  const version = envVersion || (runtime && runtime.desktopVersion) || (fromPkg && fromPkg.version) || null
  versionCache = {
    version,
    versionSource: envVersion ? 'env' : runtime ? 'desktop-runtime' : fromPkg ? fromPkg.source : null,
    edition: runtime ? 'desktop' : fromPkg ? 'cli' : 'unknown',
    desktop: runtime,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    profile: currentProfile(),
    dshHome: dshHome(),
    appVersion: await readAppVersion(),
  }
  return versionCache
}

async function readAppVersion() {
  for (const root of resourceRoots()) {
    const data = await readJson(join(root, 'app-update.yml'))
    if (data) return null
    const pkg = await readJson(join(root, 'app', 'package.json'))
    if (pkg && pkg.version) return { version: String(pkg.version), source: join(root, 'app', 'package.json') }
  }
  return null
}

export function versionLabel(info) {
  if (!info) return '未知'
  if (!info.version) return `未知（${info.edition}）`
  return `${info.version} · ${info.edition}`
}
