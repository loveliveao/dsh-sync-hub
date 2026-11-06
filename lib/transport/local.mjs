/**
 * 本地目录通道：一个普通的同步文件夹（OneDrive / 坚果云 / NAS 挂载 / U 盘都行）。
 * 不需要网络、不需要凭据，是默认通道。
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { BaseTransport } from './base.mjs'
import { pathExists } from '../util.mjs'

function expandPath(input) {
  let value = String(input || '').trim()
  if (!value) return ''
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = join(homedir(), value.slice(1))
  }
  value = value.replace(/%([A-Za-z_]+)%/g, (_, name) => process.env[name] || `%${name}%`)
  return isAbsolute(value) ? resolve(value) : resolve(value)
}

export class LocalTransport extends BaseTransport {
  constructor(settings) {
    super(settings)
    this.root = expandPath(settings.remote && settings.remote.path)
  }

  get kind() {
    return 'local'
  }

  describe() {
    return this.root || '（未设置同步文件夹）'
  }

  targetFile(rel) {
    if (!this.root) throw new Error('还没有设置同步文件夹路径')
    return join(this.root, ...rel.split('/'))
  }

  async getFile(rel, { head = false } = {}) {
    const abs = this.targetFile(rel)
    const st = await stat(abs).catch(() => null)
    if (!st || !st.isFile()) return null
    if (head) return Buffer.alloc(0)
    return readFile(abs)
  }

  async putFile(rel, buf) {
    const abs = this.targetFile(rel)
    await mkdir(dirname(abs), { recursive: true })
    const tmp = `${abs}.tmp-${process.pid}`
    await writeFile(tmp, buf)
    await rm(abs, { force: true })
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, buf)
    await rm(tmp, { force: true })
  }

  async open() {
    if (!this.root) throw new Error('还没有设置同步文件夹路径')
    await mkdir(this.root, { recursive: true })
  }

  async test() {
    if (!this.root) return { ok: false, message: '未设置同步文件夹路径' }
    try {
      await mkdir(this.root, { recursive: true })
      const probe = join(this.root, '.dsh-sync-hub-probe')
      await writeFile(probe, String(Date.now()))
      const ok = await pathExists(probe)
      await rm(probe, { force: true })
      if (!ok) return { ok: false, message: '目录不可写' }
      const manifest = await this.readManifest()
      const detail = manifest
        ? `已有 ${Object.keys(manifest.entries || {}).length} 个条目，来自 ${Object.keys(manifest.devices || {}).length} 台设备`
        : '空目录，将创建新的同步库'
      return { ok: true, message: `可读写：${this.root}`, detail }
    } catch (err) {
      return { ok: false, message: String((err && err.message) || err) }
    }
  }
}

export function localTransport(settings) {
  return new LocalTransport(settings)
}
