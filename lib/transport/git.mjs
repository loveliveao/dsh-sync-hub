/**
 * Git 通道：把同步库做成一个 Git 仓库（GitHub / Gitee / 自建 Gitea / 本地裸仓库都行）。
 *
 * 令牌不进 .git/config：每次调用都用 `-c http.extraHeader` 临时带上，
 * 工作副本在 $DSH_HOME/sync-hub/remote-git，与用户自己的仓库无关。
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BaseTransport } from './base.mjs'
import { gitWorkdir } from '../paths.mjs'
import { execFileP, pathExists } from '../util.mjs'

export class GitTransport extends BaseTransport {
  constructor(settings, credentials = {}) {
    super(settings, credentials)
    this.workdir = gitWorkdir()
    this.url = String((settings.remote && settings.remote.repo) || '').trim()
    this.branch = String((settings.remote && settings.remote.branch) || 'main').trim() || 'main'
    this.token = String(credentials.git || '').trim()
    this.opened = false
  }

  get kind() {
    return 'git'
  }

  describe() {
    if (!this.url) return '（未设置仓库地址）'
    return `${this.url} @ ${this.branch}`
  }

  authArgs() {
    if (!this.token) return []
    const basic = Buffer.from(`x-access-token:${this.token}`, 'utf8').toString('base64')
    return ['-c', `http.extraHeader=Authorization: Basic ${basic}`, '-c', 'credential.helper=']
  }

  git(args) {
    return execFileP('git', [...this.authArgs(), ...args], { cwd: this.workdir, timeoutMs: 180000 })
  }

  async ensureRepo() {
    if (!this.url) throw new Error('还没有设置 Git 仓库地址')
    await mkdir(this.workdir, { recursive: true })
    const hasRepo = await pathExists(join(this.workdir, '.git'))
    if (!hasRepo) {
      await execFileP('git', ['init', '-q', '-b', this.branch], { cwd: this.workdir })
      await execFileP('git', ['remote', 'add', 'origin', this.url], { cwd: this.workdir })
    } else {
      const remote = await execFileP('git', ['remote', 'get-url', 'origin'], { cwd: this.workdir }).catch(() => null)
      if (!remote) await execFileP('git', ['remote', 'add', 'origin', this.url], { cwd: this.workdir })
      else if (remote.stdout.trim() !== this.url) {
        await execFileP('git', ['remote', 'set-url', 'origin', this.url], { cwd: this.workdir })
      }
    }
    await this.git(['config', 'user.name', 'dsh-sync-hub']).catch(() => {})
    await this.git(['config', 'user.email', 'sync-hub@dsh.local']).catch(() => {})
  }

  async remoteHasBranch() {
    try {
      const res = await this.git(['ls-remote', '--heads', 'origin', this.branch])
      return res.stdout.trim().length > 0
    } catch {
      return false
    }
  }

  async open() {
    if (this.opened) return
    await this.ensureRepo()
    if (await this.remoteHasBranch()) {
      await this.git(['fetch', '--depth=1', 'origin', this.branch])
      await this.git(['reset', '--hard', 'FETCH_HEAD'])
      await this.git(['clean', '-fdx'])
    } else {
      // 远端还是空的：保留现有文件，第一次 flush 会建分支。
      await this.git(['rm', '-r', '--cached', '.', '--ignore-unmatch']).catch(() => {})
    }
    this.opened = true
  }

  async getFile(rel, { head = false } = {}) {
    if (!this.opened) await this.open()
    const abs = join(this.workdir, ...rel.split('/'))
    const st = await stat(abs).catch(() => null)
    if (!st || !st.isFile()) return null
    if (head) return Buffer.alloc(0)
    return readFile(abs)
  }

  async putFile(rel, buf) {
    if (!this.opened) await this.open()
    const abs = join(this.workdir, ...rel.split('/'))
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, buf)
  }

  async flush() {
    if (!this.opened) return
    await this.git(['add', '-A'])
    const status = await this.git(['status', '--porcelain'])
    if (status.stdout.trim()) {
      const stamp = new Date().toISOString()
      const name = (this.settings.deviceName || 'device').replace(/[^\w.-]+/g, '-')
      await this.git(['commit', '-q', '-m', `sync: ${name} @ ${stamp}`])
    }
    const branchExists = await this.remoteHasBranch()
    if (!branchExists) {
      await this.git(['push', '-u', 'origin', `HEAD:refs/heads/${this.branch}`])
      return
    }
    try {
      await this.git(['push', 'origin', `HEAD:refs/heads/${this.branch}`])
    } catch (err) {
      const message = String((err && err.message) || err)
      if (/rejected|non-fast-forward|fetch first/i.test(message)) {
        throw new Error('远端在你同步期间有新提交，已被拒绝（本次改动未丢失）。再点一次同步即可，下次会先拉取再合并。')
      }
      throw err
    }
  }

  async test() {
    if (!this.url) return { ok: false, message: '未设置 Git 仓库地址' }
    try {
      await this.ensureRepo()
      const res = await this.git(['ls-remote', '--heads', 'origin'])
      const branches = res.stdout.split(/\r?\n/).filter(Boolean).length
      const hasBranch = res.stdout.includes(`refs/heads/${this.branch}`)
      return {
        ok: true,
        message: `可访问：${this.url}`,
        detail: hasBranch ? `分支 ${this.branch} 已存在` : `远端有 ${branches} 个分支，目标分支 ${this.branch} 尚未创建（首次同步会创建）`,
      }
    } catch (err) {
      return { ok: false, message: String((err && err.message) || err) }
    }
  }

  async dispose() {
    await rm(join(this.workdir, '.git', 'index.lock'), { force: true }).catch(() => {})
  }
}

export function gitTransport(settings, credentials) {
  return new GitTransport(settings, credentials)
}
