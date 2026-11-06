/**
 * Git 通道：把同步库做成一个 Git 仓库（GitHub / Gitee / 自建 Gitea / 本地裸仓库都行）。
 *
 * 令牌不进 .git/config：每次调用都用 `-c http.extraHeader` 临时带上，
 * 工作副本在 $DSH_HOME/sync-hub/remote-git，与用户自己的仓库无关。
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BaseTransport, buildTestResult, errText, firstLine, makeStep, skipStep } from './base.mjs'
import { gitWorkdir } from '../paths.mjs'
import { execFileP, pathExists } from '../util.mjs'

/**
 * 把 git 的原始报错翻译成人能直接行动的原因。
 * 注意：调用前必须先 scrub 掉令牌，否则 base64 认证头里的随机数字会命中 401/404。
 */
function classifyRepoError(raw) {
  const text = String(raw || '')
  if (/401|403|authentication failed|access denied|invalid username or password|bad credentials|terminal prompts disabled/i.test(text)) {
    return '认证失败：令牌没粘全、已过期，或没有该仓库权限'
  }
  if (/404|not found|does not exist|repository .* not found/i.test(text)) {
    return '仓库名或所属账号写错，或令牌没有访问这个仓库的权限'
  }
  if (/could not resolve host|failed to connect|connection refused|connection timed out|network is unreachable|no route to host|name or service not known|temporary failure in name resolution/i.test(text)) {
    return '网络不通或域名解析失败'
  }
  if (/does not appear to be a git repository|not a git repository/i.test(text)) {
    return '这个地址不是一个 Git 仓库'
  }
  return '无法访问远端仓库'
}

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
    return `${this.scrubUrl(this.url)} @ ${this.branch}`
  }

  /**
   * 抹掉凭据再往外说：git 的报错里会带上完整命令行（里面有 base64 认证头），
   * 直接抛给界面等于把令牌亮出来。
   */
  scrub(text) {
    let out = String(text == null ? '' : text)
    if (this.token) {
      out = out.split(this.token).join('***')
      const basic = Buffer.from(`x-access-token:${this.token}`, 'utf8').toString('base64')
      out = out.split(basic).join('***')
    }
    return out
  }

  /** 抹掉地址里可能带的 user:pass@ 或 token 查询参数。 */
  scrubUrl(url) {
    return String(url == null ? '' : url)
      .replace(/\/\/[^/@\s]+@/, '//***@')
      .replace(/([?&](?:access_token|token|password|private_token|auth)=)[^&]*/gi, '$1***')
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

  /** 不带任何凭据访问一次远端：用来判断仓库是不是公开的。 */
  async probeAnonymous() {
    try {
      const res = await execFileP('git', ['-c', 'credential.helper=', 'ls-remote', '--heads', 'origin'], {
        cwd: this.workdir,
        timeoutMs: 60000,
      })
      // 命令没报错 = 不带凭据也能读到（空仓库也是公开的）
      return { ok: true, stdout: res.stdout }
    } catch (err) {
      return { ok: false, error: this.scrub(errText(err)) }
    }
  }

  /**
   * 仓库「测试连接」：分四步说清楚在测什么、测到哪一步、为什么失败。
   * 绝不抛异常——任何一步失败都只会让结果变成 ok:false。
   */
  async test() {
    const steps = []

    if (!this.url) {
      steps.push(makeStep('repo', '仓库可访问', false, '还没有设置 Git 仓库地址'))
      steps.push(skipStep('auth', '认证方式', '仓库地址未设置'))
      steps.push(skipStep('branch', '目标分支', '仓库地址未设置'))
      steps.push(skipStep('private', '仓库可见性', '仓库地址未设置'))
      return buildTestResult(steps, { message: '未设置 Git 仓库地址' })
    }

    /* 1. 仓库可访问 ----------------------------------------------------- */
    let stdout = ''
    let branches = 0
    let repoOk = false
    let rawError = ''
    let reason = ''
    try {
      await this.ensureRepo()
    } catch (err) {
      rawError = this.scrub(errText(err))
      reason = '本地工作副本准备失败'
    }
    if (!reason) {
      try {
        const res = await this.git(['ls-remote', '--heads', 'origin'])
        stdout = res.stdout
        branches = stdout.split(/\r?\n/).filter(Boolean).length
        repoOk = true
      } catch (err) {
        rawError = this.scrub(errText(err))
        reason = classifyRepoError(rawError)
      }
    }
    steps.push(
      repoOk
        ? makeStep('repo', '仓库可访问', true, `远端可访问，共 ${branches} 个分支`)
        : makeStep('repo', '仓库可访问', false, `${reason}（git 输出：${firstLine(rawError) || '无输出'}）`),
    )

    /* 2. 认证方式 ------------------------------------------------------- */
    const tokenSet = Boolean(this.token)
    let authDetail = tokenSet
      ? '已配置令牌（认证头只在每次命令里临时带上，不会写进仓库配置）'
      : '未配置令牌，将使用匿名访问或本机 Git 凭据'
    let authOk = true
    if (!repoOk && /认证失败/.test(reason)) {
      authOk = false
      authDetail = tokenSet
        ? '已配置令牌但认证失败：可能没粘全、已过期，或没有该仓库权限'
        : '未配置令牌：私有仓库需要令牌，请到凭据里补一个 Git 令牌'
    } else if (!repoOk && /权限/.test(reason)) {
      authOk = false
      authDetail = tokenSet
        ? '已配置令牌但仍然看不到这个仓库：令牌没有访问它的权限'
        : '未配置令牌：这个仓库需要凭据才能访问'
    }
    steps.push(makeStep('auth', '认证方式', authOk, authDetail, authOk ? 'info' : 'error'))

    /* 3. 目标分支 ------------------------------------------------------- */
    let detail = ''
    if (!repoOk) {
      steps.push(skipStep('branch', '目标分支', reason || '仓库不可访问'))
    } else {
      const hasBranch = stdout.includes(`refs/heads/${this.branch}`)
      detail = hasBranch
        ? `分支 ${this.branch} 已存在`
        : `远端有 ${branches} 个分支，目标分支 ${this.branch} 尚未创建（首次同步会创建）`
      steps.push(makeStep('branch', '目标分支', true, detail, hasBranch ? 'info' : 'warn'))
    }

    /* 4. 仓库可见性 ----------------------------------------------------- */
    if (!repoOk) {
      steps.push(skipStep('private', '仓库可见性', reason || '仓库不可访问'))
    } else {
      const anon = await this.probeAnonymous()
      if (anon.ok) {
        steps.push(
          makeStep('private', '仓库可见性', true, '这个仓库似乎不需要认证即可访问，强烈建议改为私有仓库', 'warn'),
        )
      } else {
        steps.push(makeStep('private', '仓库可见性', true, '不带令牌访问失败，仓库看起来是私有的', 'info'))
      }
    }

    /* 汇总 -------------------------------------------------------------- */
    const result = buildTestResult(steps, { message: '', detail })
    if (result.ok) {
      result.message = `可访问：${this.scrubUrl(this.url)}`
    } else {
      result.message = `仓库不可访问 — ${reason}`
      result.detail = firstLine(rawError)
    }
    return result
  }

  async dispose() {
    await rm(join(this.workdir, '.git', 'index.lock'), { force: true }).catch(() => {})
  }
}

export function gitTransport(settings, credentials) {
  return new GitTransport(settings, credentials)
}
