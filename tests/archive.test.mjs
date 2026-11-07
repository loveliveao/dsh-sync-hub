/**
 * 归档列表读写：只增不减、失败降级、写盘前留备份。
 *
 *   node tests/archive.test.mjs
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = await mkdtemp(join(tmpdir(), 'sync-hub-archive-'))
process.env.DSH_HOME = SANDBOX

const { readArchivedSessionIds, applyArchivedSessionIds } = await import('../lib/archive.mjs')

let failures = 0

function check(label, ok, detail = '') {
  if (ok) {
    console.log('  ✓ ' + label)
  } else {
    failures += 1
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''))
  }
}

const WS_DIR = join(SANDBOX, 'storages')
const WS_FILE = join(WS_DIR, 'workspace.json')

await mkdir(WS_DIR, { recursive: true })
await writeFile(
  WS_FILE,
  JSON.stringify(
    {
      unit: { keep: '原样保留' },
      global: { initialized: true, archivedSessionIds: ['s1', 's2'], workspaceIds: ['w1'] },
      tables: { workspaces: { w1: { path: 'D:/demo', title: 'demo' } } },
    },
    null,
    2,
  ) + '\n',
  'utf8',
)

console.log('[1] 读取归档列表')
{
  const ids = await readArchivedSessionIds()
  check(
    '读到两个已归档会话',
    Array.isArray(ids) && ids.length === 2 && ids[0] === 's1' && ids[1] === 's2',
    JSON.stringify(ids),
  )
}

console.log('\n[2] 只增不减')
{
  const result = await applyArchivedSessionIds(['s2', 's3', 's3'])
  check('added 为 1', result.added === 1, JSON.stringify(result))
  check('skipped 为 1', result.skipped === 1, JSON.stringify(result))
  check('没有 error', !result.error, String(result.error))
  const ids = await readArchivedSessionIds()
  check('归档列表变成 s1,s2,s3', JSON.stringify(ids) === JSON.stringify(['s1', 's2', 's3']), JSON.stringify(ids))
  const raw = JSON.parse(await readFile(WS_FILE, 'utf8'))
  check(
    '其它字段原样保留',
    raw.unit.keep === '原样保留' &&
      raw.global.initialized === true &&
      raw.global.workspaceIds[0] === 'w1' &&
      raw.tables.workspaces.w1.path === 'D:/demo',
  )
  check('文件保持 2 空格缩进', (await readFile(WS_FILE, 'utf8')).includes('\n  "global"'))
}

console.log('\n[3] 重复归档只跳过，不删除')
{
  const result = await applyArchivedSessionIds(['s1', 's2'])
  check('added 为 0', result.added === 0, JSON.stringify(result))
  check('skipped 为 2', result.skipped === 2, JSON.stringify(result))
  const ids = await readArchivedSessionIds()
  check('列表没有被删减', JSON.stringify(ids) === JSON.stringify(['s1', 's2', 's3']), JSON.stringify(ids))
}

console.log('\n[4] 写盘前有备份')
{
  const backups = join(SANDBOX, 'sync-hub', 'backups')
  const dirs = await readdir(backups).catch(() => [])
  check('备份目录存在', dirs.length >= 1, JSON.stringify(dirs))
  const found = await readFile(join(backups, dirs[dirs.length - 1], 'storages', 'workspace.json'), 'utf8').catch(() => '')
  check('备份里有 workspace.json', found.includes('archivedSessionIds'))
}

console.log('\n[5] 失败降级，不抛异常')
{
  const missing = join(SANDBOX, 'not-exist', 'workspace.json')
  let threw = false
  let result = null
  try {
    result = await applyArchivedSessionIds(['s9'], { file: missing })
  } catch {
    threw = true
  }
  check('不抛异常', !threw)
  check('返回 error 字段', Boolean(result) && typeof result.error === 'string' && result.error.length > 0, JSON.stringify(result))
  const ids = await readArchivedSessionIds()
  check('原文件没被动过', JSON.stringify(ids) === JSON.stringify(['s1', 's2', 's3']), JSON.stringify(ids))
}

console.log('\n[6] 读不到 workspace.json 时返回空数组')
{
  const other = await mkdtemp(join(tmpdir(), 'sync-hub-archive-empty-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = other
  const ids = await readArchivedSessionIds()
  check('返回空数组', Array.isArray(ids) && ids.length === 0, JSON.stringify(ids))
  process.env.DSH_HOME = saved
  await rm(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

await rm(SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
console.log(failures ? '\n✗ ' + failures + ' 项未通过' : '\n✓ 全部通过')
process.exitCode = failures ? 1 : 0
