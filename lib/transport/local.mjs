/**
 * 本地目录通道：一个普通的同步文件夹（OneDrive / 坚果云 / NAS 挂载 / U 盘都行）。
 * 不需要网络、不需要凭据，是默认通道。
 *
 * test() 返回「分步检查清单」：每一步都有中文名字和结论，失败时给出可操作的原因。
 */
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as fsp from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { BaseTransport, buildTestResult, errText, firstFailedStep, makeStep, skipStep } from './base.mjs'
import { formatBytes, pathExists } from '../util.mjs'

function expandPath(input) {
  let value = String(input || '').trim()
  if (!value) return ''
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = join(homedir(), value.slice(1))
  }
  value = value.replace(/%([A-Za-z_]+)%/g, (_, name) => process.env[name] || `%${name}%`)
  return isAbsolute(value) ? resolve(value) : resolve(value)
}

/** 向上找第一个真实存在的祖先目录（用来判断「路径不存在但能不能创建」）。 */
async function nearestExistingAncestor(target) {
  let current = target
  for (;;) {
    const st = await stat(current).catch(() => null)
    if (st) return { path: current, stat: st }
    const parent = dirname(current)
    if (!parent || parent === current) return null
    current = parent
  }
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

  /**
   * 共享文件夹「测试连接」：分五步说清楚在测什么、测到哪一步、为什么失败。
   * 绝不抛异常——任何一步失败都只会让结果变成 ok:false。
   */
  async test() {
    const steps = []

    if (!this.root) {
      steps.push(makeStep('path', '目标文件夹存在', false, '还没有设置同步文件夹路径'))
      steps.push(skipStep('readable', '可读', '目标文件夹路径未设置'))
      steps.push(skipStep('writable', '可写', '目标文件夹路径未设置'))
      steps.push(skipStep('space', '剩余空间', '目标文件夹路径未设置'))
      steps.push(skipStep('hub', '同步库状态', '目标文件夹路径未设置'))
      return buildTestResult(steps, { message: '未设置同步文件夹路径' })
    }

    /* 1. 目标文件夹存在 ------------------------------------------------- */
    let pathOk = false
    let pathReason = ''
    let pathDetail = ''
    let pathSeverity = 'error'
    let ancestor = null
    const st = await stat(this.root).catch(() => null)
    if (!st) {
      ancestor = await nearestExistingAncestor(this.root)
      if (ancestor && ancestor.stat.isDirectory()) {
        const writable = await access(ancestor.path, constants.W_OK).then(() => true, () => false)
        if (writable) {
          pathSeverity = 'warn'
          pathReason = '目标文件夹还不存在'
          pathDetail = `目标文件夹还不存在：${this.root}；首次同步会自动创建该文件夹`
        } else {
          pathReason = '路径不存在且无法创建'
          pathDetail = `路径不存在且无法创建：${this.root}（上级目录 ${ancestor.path} 不可写）`
        }
      } else {
        pathReason = '路径不存在且无法创建'
        pathDetail = `路径不存在且无法创建：${this.root}（找不到可用的上级目录）`
      }
    } else if (!st.isDirectory()) {
      pathReason = '这个路径是文件，不是文件夹'
      pathDetail = `这个路径是一个文件，不是文件夹：${this.root}`
    } else {
      pathOk = true
      pathSeverity = 'info'
      pathReason = ''
      pathDetail = `文件夹已存在：${this.root}`
    }
    steps.push(makeStep('path', '目标文件夹存在', pathOk, pathDetail, pathSeverity))

    /* 2. 可读 ----------------------------------------------------------- */
    let readableOk = false
    if (!pathOk) {
      steps.push(skipStep('readable', '可读', pathReason || '目标文件夹不存在'))
    } else {
      try {
        const items = await readdir(this.root)
        readableOk = true
        steps.push(makeStep('readable', '可读', true, `可以列出目录内容，共 ${items.length} 项`))
      } catch (err) {
        steps.push(makeStep('readable', '可读', false, `无法读取目录内容：${errText(err)}`))
      }
    }

    /* 3. 可写 ----------------------------------------------------------- */
    const probeName = `.dsh-sync-hub-probe-${process.pid}`
    if (!pathOk || !readableOk) {
      steps.push(skipStep('writable', '可写', pathOk ? '目录不可读' : pathReason || '目标文件夹不存在'))
    } else {
      const probe = join(this.root, probeName)
      try {
        await writeFile(probe, String(Date.now()))
        const exists = await pathExists(probe)
        await rm(probe, { force: true })
        if (exists) {
          steps.push(makeStep('writable', '可写', true, `已写入并删除探针文件 ${probeName}`))
        } else {
          steps.push(makeStep('writable', '可写', false, `探针文件 ${probeName} 写完却找不到，目录可能不可写`))
        }
      } catch (err) {
        await rm(probe, { force: true }).catch(() => {})
        steps.push(makeStep('writable', '可写', false, `无法写入文件：${errText(err)}`))
      }
    }

    /* 4. 剩余空间 ------------------------------------------------------- */
    const statfsFn = typeof fsp.statfs === 'function' ? fsp.statfs : null
    if (!statfsFn) {
      steps.push(makeStep('space', '剩余空间', true, '无法读取磁盘剩余空间：当前 Node 不支持 fs.statfs', 'warn'))
    } else {
      const probePath = st && st.isDirectory() ? this.root : (ancestor && ancestor.stat.isDirectory() ? ancestor.path : null)
      if (!probePath) {
        steps.push(makeStep('space', '剩余空间', true, '无法读取磁盘剩余空间：找不到可用的上级目录', 'warn'))
      } else {
        try {
          const fsInfo = await statfsFn(probePath)
          const avail = Number(fsInfo.bavail) * Number(fsInfo.bsize)
          const scope = probePath === this.root ? '' : `（按上级目录 ${probePath} 估算）`
          steps.push(makeStep('space', '剩余空间', true, `可用空间约 ${formatBytes(avail)}${scope}`))
        } catch (err) {
          steps.push(makeStep('space', '剩余空间', true, `无法读取磁盘剩余空间：${errText(err)}`, 'warn'))
        }
      }
    }

    /* 5. 同步库状态 ----------------------------------------------------- */
    let hubDetail = ''
    let entryCount = 0
    if (!pathOk) {
      steps.push(skipStep('hub', '同步库状态', pathReason || '目标文件夹不存在'))
    } else {
      try {
        const manifest = await this.readManifest()
        entryCount = manifest ? Object.keys(manifest.entries || {}).length : 0
        hubDetail = manifest
          ? `已有 ${entryCount} 个条目，来自 ${Object.keys(manifest.devices || {}).length} 台设备`
          : '空目录，将创建新的同步库'
        steps.push(makeStep('hub', '同步库状态', true, hubDetail))
      } catch (err) {
        hubDetail = ''
        steps.push(makeStep('hub', '同步库状态', false, `无法读取远端 manifest：${errText(err)}`))
      }
    }

    /* 汇总 -------------------------------------------------------------- */
    const failed = firstFailedStep(steps)
    const result = buildTestResult(steps, { message: '', detail: hubDetail })
    if (result.ok) {
      result.message = entryCount
        ? `共享文件夹可用：可读写，已存在 ${entryCount} 个同步条目`
        : '共享文件夹可用：可读写，将创建新的同步库'
    } else if (failed && failed.id === 'path') {
      result.message = `共享文件夹不可用：${pathReason}`
    } else if (failed) {
      result.message = `共享文件夹不可用：${failed.label}`
    }
    return result
  }
}

export function localTransport(settings) {
  return new LocalTransport(settings)
}
