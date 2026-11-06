/**
 * 传输通道基类。三条实现（local / git / webdav）共用这里的读写接口：
 *
 *   open()            拉取远端最新状态（git 是 fetch+reset，其余空操作）
 *   readManifest()    远端 manifest（没有则 null）
 *   writeManifest(m)  写 manifest
 *   hasBlob(sha)      blob 是否已存在
 *   getBlob(sha)      读 blob
 *   putBlob(sha, buf) 写 blob
 *   flush()           提交（git 是 commit+push，其余空操作）
 *   test()            连通性检查，返回 { ok, message, detail, steps }
 *   describe()        界面上显示的目标描述
 *
 * blob 布局：blobs/<sha 前两位>/<sha>，内容寻址，天然去重。
 */

/**
 * 造一个检查步骤。三个通道的 test() 共用同一套形状，UI 才能统一渲染。
 *
 * @param {string} id       步骤 id（小写英文短名，供 UI 做图标/排序/测试用）
 * @param {string} label    中文短语，说明这一步在做什么
 * @param {boolean} ok      这一步是否通过
 * @param {string} detail   具体证据（路径、条目数、HTTP 状态码、分支名……）
 * @param {string} [severity] 'info'（默认，按 ok 自动推断）| 'warn' | 'error'
 */
export function makeStep(id, label, ok, detail = '', severity) {
  const passed = Boolean(ok)
  return {
    id: String(id),
    label: String(label),
    ok: passed,
    detail: String(detail == null ? '' : detail),
    severity: severity || (passed ? 'info' : 'error'),
  }
}

/**
 * 前一步失败时用它占位：ok=false + 说明「因上一步失败未执行」。
 */
export function skipStep(id, label, reason = '') {
  return makeStep(id, label, false, `因上一步失败未执行${reason ? `：${reason}` : ''}`)
}

/**
 * 汇总步骤 → 统一返回结构。
 * ok 的口径：没有任何一步失败（severity='warn' 的提醒不影响 ok）。
 */
export function buildTestResult(steps, { message, detail = '' } = {}) {
  const list = (steps || []).filter(Boolean)
  return {
    ok: list.every((step) => step.ok),
    message: String(message == null ? '' : message),
    detail: String(detail == null ? '' : detail),
    steps: list,
  }
}

/** 取第一个失败的步骤（用来拼一句人话总结）。 */
export function firstFailedStep(steps) {
  return (steps || []).find((step) => step && !step.ok) || null
}

/** 错误对象 → 一行可读文本。 */
export function errText(err) {
  if (!err) return '未知错误'
  const text = String((err && err.message) || err)
  return text.trim() || '未知错误'
}

/** 取第一行并截断，给步骤 detail 当证据用（原始报错可能很长）。 */
export function firstLine(text, max = 300) {
  const line = String(text == null ? '' : text).split(/\r?\n/).map((s) => s.trim()).find(Boolean) || ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}
export class BaseTransport {
  constructor(settings, credentials) {
    this.settings = settings
    this.credentials = credentials || {}
  }

  get kind() {
    return 'base'
  }

  async open() {}
  async flush() {}
  async dispose() {}

  async readManifest() {
    const buf = await this.getFile('manifest.json')
    if (!buf) return null
    try {
      return JSON.parse(buf.toString('utf8'))
    } catch {
      throw new Error('远端 manifest.json 不是合法 JSON（可能被截断），请检查同步目录')
    }
  }

  async writeManifest(manifest) {
    await this.putFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))
  }

  blobPath(sha) {
    return `blobs/${sha.slice(0, 2)}/${sha}`
  }

  async hasBlob(sha) {
    return Boolean(await this.getFile(this.blobPath(sha), { head: true }))
  }

  async getBlob(sha) {
    return this.getFile(this.blobPath(sha))
  }

  async putBlob(sha, buf) {
    await this.putFile(this.blobPath(sha), buf)
  }

  /* 子类实现 */
  async getFile() {
    throw new Error('未实现 getFile')
  }

  async putFile() {
    throw new Error('未实现 putFile')
  }

  async test() {
    return { ok: false, message: '未实现 test()', detail: '', steps: [] }
  }

  describe() {
    return this.kind
  }
}
