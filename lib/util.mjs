/** 通用工具：摘要、原子写、目录遍历、JSON、进程调用。 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

/** 先写临时文件再 rename，避免半截文件被下一次扫描读到。 */
export async function atomicWrite(abs, data) {
  await ensureDir(dirname(abs))
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, data)
  try {
    await rename(tmp, abs)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
  return abs
}

export async function readJson(abs, fallback = null) {
  try {
    return JSON.parse(await readFile(abs, 'utf8'))
  } catch {
    return fallback
  }
}

export async function writeJson(abs, value) {
  await atomicWrite(abs, JSON.stringify(value, null, 2) + '\n')
}

export async function pathExists(abs) {
  try {
    await stat(abs)
    return true
  } catch {
    return false
  }
}

export async function statOrNull(abs) {
  try {
    return await stat(abs)
  } catch {
    return null
  }
}

/**
 * 递归遍历，跳过符号链接与忽略目录。返回 posix 风格的相对路径。
 * 用于 skills/ 与 sessions/ 这种「整棵树都同步」的目录。
 */
export async function walkFiles(root, { ignore = [], maxFiles = 20000 } = {}) {
  const out = []
  const skip = new Set(ignore)
  async function visit(dir) {
    if (out.length >= maxFiles) return
    let items
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (skip.has(item.name)) continue
      const abs = join(dir, item.name)
      if (item.isSymbolicLink()) continue
      if (item.isDirectory()) {
        await visit(abs)
        continue
      }
      if (!item.isFile()) continue
      const st = await statOrNull(abs)
      if (!st) continue
      out.push({
        rel: relative(root, abs).split(sep).join('/'),
        abs,
        size: st.size,
        mtimeMs: st.mtimeMs,
      })
      if (out.length >= maxFiles) return
    }
  }
  await visit(root)
  return out
}

export function execFileP(file, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env || {}), GIT_TERMINAL_PROMPT: '0' },
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: opts.timeoutMs || 120000,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || '').trim()
          err.message = `${file} ${args.join(' ')} 失败：${detail || err.message}`
          reject(err)
          return
        }
        resolvePromise({ stdout: String(stdout || ''), stderr: String(stderr || '') })
      },
    )
  })
}

export function isTextBuffer(buf) {
  if (!buf || buf.length === 0) return true
  const probe = buf.subarray(0, Math.min(buf.length, 4096))
  for (const byte of probe) {
    if (byte === 0) return false
  }
  return true
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** 只允许安全字符作为远端 blob 名（sha256 十六进制）。 */
export function isShaName(name) {
  return typeof name === 'string' && /^[a-f0-9]{64}$/.test(name)
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export async function chmodSafe(abs, mode) {
  try {
    await chmod(abs, mode)
  } catch {
    /* Windows 上基本是 no-op，忽略 */
  }
}
