/**
 * 会话跨机口径自检。
 *
 *   node tests/session-canon.test.mjs
 *
 * 覆盖四件事：
 *   1. projectKey / encodeSegment 与 DSH 的算法一致（不一致会被判 corrupt session log）
 *   2. 规范化只动 header 的 cwd，正文里的绝对路径不动
 *   3. 同一个会话在两台不同路径的机器上算出同一个逻辑 sha
 *   4. 改写 cwd 后的落点目录符合 DSH 期望，且同 id 不会留在两个 project 目录下
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import {
  CWD_PLACEHOLDER,
  SESSION_FILE_NAME,
  canonicalRel,
  cwdKey,
  encodeSegment,
  findSessionCopies,
  logicalSha,
  materializeBlob,
  normalizeSessionText,
  physicalRel,
  projectKey,
  removeSessionCopies,
  sessionEntryId,
} from '../lib/session-canon.mjs'

let failures = 0

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function makeSessionText(sessionId, cwd, extraLines = []) {
  const header = {
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt: 1793861730962,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  }
  const lines = [JSON.stringify(header)]
  for (const line of extraLines) lines.push(JSON.stringify(line))
  return lines.join('\n') + '\n'
}

async function main() {
  console.log('\n[1] projectKey / encodeSegment 与 DSH 一致')
  check('D:\\VibeCoding → --D-VibeCoding--', projectKey('D:\\VibeCoding') === '--D-VibeCoding--', projectKey('D:\\VibeCoding'))
  check(
    'C:\\Users\\HUAWEI\\.dsh\\bot\\workspace → --C-Users-HUAWEI-.dsh-bot-workspace--',
    projectKey('C:\\Users\\HUAWEI\\.dsh\\bot\\workspace') === '--C-Users-HUAWEI-.dsh-bot-workspace--',
    projectKey('C:\\Users\\HUAWEI\\.dsh\\bot\\workspace'),
  )
  check('空 cwd → _no-cwd', projectKey('') === '_no-cwd', projectKey(''))
  check("'.' → ~002E", encodeSegment('.') === '~002E', encodeSegment('.'))
  check("'..' → ~002E~002E", encodeSegment('..') === '~002E~002E', encodeSegment('..'))
  check('普通 id 原样保留', encodeSegment('session-abc-123') === 'session-abc-123', encodeSegment('session-abc-123'))
  check('空格 → ~0020', encodeSegment('a b') === 'a~0020b', encodeSegment('a b'))
  check('跨机 id 与机器无关', sessionEntryId('session-x') === 'sessions:session-x', sessionEntryId('session-x'))
  check(
    '清单里的 rel 不含本机路径',
    canonicalRel('session-x') === 'sessions/session-x/session.v4.jsonl.zstd',
    canonicalRel('session-x'),
  )

  console.log('\n[2] 规范化只动 header 的 cwd')
  const bodyPath = 'D:\\VibeCoding\\notes.md'
  const bodyPathJson = JSON.stringify(bodyPath).slice(1, -1)
  const text = makeSessionText('session-a', 'D:\\VibeCoding', [
    { type: 'message', data: { text: `看看 ${bodyPath} 这个文件` } },
  ])
  const norm = normalizeSessionText(text)
  check('识别到会话 id', norm.sessionId === 'session-a', norm.sessionId)
  check('识别到原始 cwd', norm.cwd === 'D:\\VibeCoding', norm.cwd)
  check('header 的 cwd 换成占位符', norm.text.includes(`"cwd":"${CWD_PLACEHOLDER}"`), norm.text.slice(0, 120))
  check('正文里的绝对路径保持原样', norm.text.includes(bodyPathJson), '正文路径被误改')
  check('正文里没有混入占位符', !norm.text.split('\n').slice(1).join('\n').includes(CWD_PLACEHOLDER), '正文被误改')

  console.log('\n[3] 两台机器算出同一个逻辑 sha')
  const sessionId = 'session-cross-machine'
  const textA = makeSessionText(sessionId, 'D:\\VibeCoding', [{ type: 'message', data: { text: 'hello' } }])
  const textB = makeSessionText(sessionId, 'E:\\Code\\VibeCoding', [{ type: 'message', data: { text: 'hello' } }])
  const normA = normalizeSessionText(textA)
  const normB = normalizeSessionText(textB)
  const shaA = logicalSha(normA.text)
  const shaB = logicalSha(normB.text)
  check('不同 cwd 的同一会话 sha 相同', shaA === shaB, `${shaA.slice(0, 12)} vs ${shaB.slice(0, 12)}`)
  check('原始字节确实不同', textA !== textB)
  check('正文变了 sha 就变', logicalSha(normalizeSessionText(makeSessionText(sessionId, 'D:\\VibeCoding', [{ type: 'message', data: { text: 'hi' } }])).text) !== shaA)

  console.log('\n[4] 改写 cwd 后的落点与副本清理')
  const fakeHome = await mkdtemp(join(tmpdir(), 'dsh-home-session-'))
  process.env.DSH_HOME = fakeHome
  const blob = zstdCompressSync(Buffer.from(normA.text, 'utf8'))
  const localCwd = 'E:\\Code\\VibeCoding'
  const materialized = materializeBlob(blob, localCwd, { compressed: true })
  check('物化成功', materialized.ok)
  const materializedText = zstdDecompressSync(materialized.blob).toString('utf8')
  check('物化后 header 指向本机目录', materializedText.includes(JSON.stringify(localCwd)), materializedText.slice(0, 140))
  check('物化后的逻辑 sha 与远端一致', materialized.logicalSha === shaA, `${materialized.logicalSha.slice(0, 12)} vs ${shaA.slice(0, 12)}`)

  // 在本机造一份旧副本（落在旧 projectKey 目录下），模拟「之前同步到别的目录」
  const oldCwd = 'D:\\VibeCoding'
  const oldRel = physicalRel(oldCwd, sessionId)
  const oldDir = join(fakeHome, ...oldRel.split('/').slice(0, -1))
  await mkdir(oldDir, { recursive: true })
  await writeFile(join(oldDir, SESSION_FILE_NAME), zstdCompressSync(Buffer.from(textA, 'utf8')))
  const copies = await findSessionCopies(sessionId)
  check('找到本机的会话副本', copies.length === 1, `copies=${copies.length}`)

  const newRel = physicalRel(localCwd, sessionId)
  const newDir = join(fakeHome, ...newRel.split('/').slice(0, -1))
  await mkdir(newDir, { recursive: true })
  await writeFile(join(newDir, SESSION_FILE_NAME), materialized.blob)
  check('新落点符合 DSH 期望（projectKey 目录）', newRel.startsWith(`sessions/${projectKey(localCwd)}/`), newRel)

  const removed = await removeSessionCopies(sessionId, newDir)
  check('旧副本被清掉', removed.length === 1, `removed=${removed.length}`)
  const after = await findSessionCopies(sessionId)
  check('同 id 只剩一个目录', after.length === 1, `copies=${after.length}`)

  const written = await readFile(join(newDir, SESSION_FILE_NAME)).catch(() => null)
  const writtenText = written ? zstdDecompressSync(written).toString('utf8') : ''
  check('新目录里的文件写的是本机目录', writtenText.includes(JSON.stringify(localCwd)), writtenText.slice(0, 140))

  await rm(fakeHome, { recursive: true, force: true })

  console.log('\n[5] 工作区跨机身份 = 目录名')
  check('cwdKey 取目录名', cwdKey('D:\\VibeCoding') === 'VibeCoding', cwdKey('D:\\VibeCoding'))
  check('尾部分隔符被去掉', cwdKey('D:\\VibeCoding\\') === 'VibeCoding', cwdKey('D:\\VibeCoding\\'))

  console.log(failures === 0 ? '\n全部通过\n' : `\n${failures} 项失败\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
