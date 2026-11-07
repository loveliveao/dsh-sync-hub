/**
 * 归档写入优先走宿主 workspaceRegistry（权威持久化 + 客户端能刷新），
 * 服务缺失 / 不认识该会话时退回文件实现。
 *
 *   node tests/archive-registry.test.mjs
 */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = await mkdtemp(join(tmpdir(), 'sync-hub-archive-reg-'))
process.env.DSH_HOME = SANDBOX

const { readArchivedSessionIds, applyArchivedSessionIds, registryOf } = await import('../lib/archive.mjs')

let failures = 0
function check(label, ok, detail = '') {
  if (ok) console.log('  ✓ ' + label)
  else {
    failures += 1
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''))
  }
}

const WS_DIR = join(SANDBOX, 'storages')
const WS_FILE = join(WS_DIR, 'workspace.json')
await mkdir(WS_DIR, { recursive: true })
await writeFile(
  WS_FILE,
  JSON.stringify({ global: { initialized: true, archivedSessionIds: ['s1'] } }, null, 2) + '\n',
  'utf8',
)

/** 假的宿主注册表：记录调用，能按需抛错。 */
function makeRegistry({ archived = ['s1'], throwFor = {} } = {}) {
  const calls = []
  return {
    calls,
    registry: {
      archivedSessionIds: archived,
      async archiveSession(id) {
        calls.push(id)
        if (throwFor[id]) {
          const err = new Error('boom')
          err.name = throwFor[id]
          throw err
        }
        if (!this.archivedSessionIds.includes(id)) this.archivedSessionIds.push(id)
      },
    },
  }
}

console.log('[1] 有宿主服务时优先走服务，不动文件')
{
  const { registry, calls } = makeRegistry()
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
  const before = await readFile(WS_FILE, 'utf8')
  const result = await applyArchivedSessionIds(['s1', 's2'], { ctx })
  check('added=1、skipped=1', result.added === 1 && result.skipped === 1, JSON.stringify(result))
  check('via=registry', result.via === 'registry', String(result.via))
  check('只对未归档的 s2 调用服务', JSON.stringify(calls) === JSON.stringify(['s2']), JSON.stringify(calls))
  check('文件没被改写', (await readFile(WS_FILE, 'utf8')) === before)
  check('读取也以服务为准', JSON.stringify(await readArchivedSessionIds(ctx)) === JSON.stringify(['s1', 's2']))
}

console.log('\n[2] 服务不认识该会话 → 退回文件兜底')
{
  const { registry, calls } = makeRegistry({ throwFor: { s3: 'WorkspaceUnknownSessionError' } })
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
  const result = await applyArchivedSessionIds(['s3'], { ctx })
  check('仍然写进文件', result.added === 1, JSON.stringify(result))
  check('via=registry+file', result.via === 'registry+file', String(result.via))
  check('服务确实被调用过', JSON.stringify(calls) === JSON.stringify(['s3']))
  const ids = await readArchivedSessionIds()
  check('文件里出现 s3', JSON.stringify(ids).includes('s3'), JSON.stringify(ids))
}

console.log('\n[3] 宿主拒绝（会话在活动）→ 文件兜底补记，并记录原因')
{
  const { registry } = makeRegistry({ throwFor: { s4: 'WorkspaceActiveSessionError' } })
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
  const before = await readFile(WS_FILE, 'utf8')
  const result = await applyArchivedSessionIds(['s4'], { ctx })
  check('文件兜底把它加进去了', result.added === 1, JSON.stringify(result))
  check('有 error 说明', typeof result.error === 'string' && result.error.includes('s4'), JSON.stringify(result))
  check('文件里出现 s4', JSON.stringify(await readArchivedSessionIds()).includes('s4'))
}

console.log('\n[4] 宿主没有这个服务 → 走文件实现')
{
  const ctx = { get: () => undefined }
  check('registryOf 返回 null', registryOf(ctx) === null)
  const result = await applyArchivedSessionIds(['s5'], { ctx })
  check('写进文件', result.added === 1, JSON.stringify(result))
  check('via=file', result.via === 'file', String(result.via))
}

console.log('\n[5] 服务整体抛错 → 兜底不中断')
{
  const ctx = {
    get: () => ({
      archivedSessionIds: [],
      async archiveSession() {
        throw new Error('registry down')
      },
    }),
  }
  let threw = false
  let result = null
  try {
    result = await applyArchivedSessionIds(['s6'], { ctx })
  } catch {
    threw = true
  }
  check('不抛异常', !threw)
  check('仍写进文件', result && result.added === 1, JSON.stringify(result))
  check('via=registry+file', result && result.via === 'registry+file', String(result && result.via))
}

console.log('\n[6] 没有 ctx 也能用（老调用方不受影响）')
{
  const result = await applyArchivedSessionIds(['s7'])
  check('added=1', result.added === 1, JSON.stringify(result))
  check('没有 via 之外的错误', !result.error, String(result.error))
}

await rm(SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})

console.log(failures === 0 ? '\n✓ 全部通过' : '\n✗ 失败 ' + failures + ' 项')
process.exit(failures === 0 ? 0 : 1)
