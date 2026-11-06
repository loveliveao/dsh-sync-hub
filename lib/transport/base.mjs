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
 *   test()            连通性检查，返回 { ok, message }
 *   describe()        界面上显示的目标描述
 *
 * blob 布局：blobs/<sha 前两位>/<sha>，内容寻址，天然去重。
 */
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
    return { ok: false, message: '未实现 test()' }
  }

  describe() {
    return this.kind
  }
}
