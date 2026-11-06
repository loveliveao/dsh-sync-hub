/**
 * lib/analysis.mjs 的单元测试：造一个假的 DSH_HOME，验证统计结果与降级行为。
 *
 *   node --test tests/analysis.test.mjs
 *
 * 只用 Node 内置模块，不碰真实 DSH_HOME。
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeLocal } from '../lib/analysis.mjs'

const UUID_A = '11111111-2222-3333-4444-555555555555'
const UUID_B = '66666666-7777-8888-9999-aaaaaaaaaaaa'

async function writeFileAt(root, rel, content) {
  const abs = join(root, ...rel.split('/'))
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, content)
  return abs
}

async function makeFakeHome() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-hub-analysis-'))
  await writeFileAt(root, 'storages/workspace.json', JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-1'] },
    tables: {
      workspaces: {
        'ws-1': {
          path: 'D:\\work\\demo',
          title: 'demo',
          sessionIds: ['session-a', 'session-b', 'session-c'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T03:04:05.000Z',
        },
      },
    },
  }))
  await writeFileAt(root, 'profiles/desktop/package.json', JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: { 'dsh-a': '1.0.0', 'dsh-b': '^2.0.0' },
    dsh: { profile: { bundles: ['dsh-a', 'dsh-not-installed'] } },
  }))
  await writeFileAt(root, 'skills/demo-skill/SKILL.md', 'hello skill')
  await writeFileAt(root, 'skills/other-skill/SKILL.md', 'x')
  await writeFileAt(root, `sessions/proj-a/session-${UUID_A}/session.v4.jsonl.zstd`, 'A'.repeat(100))
  await writeFileAt(root, `sessions/proj-a/${UUID_B}/session.v4.jsonl.zstd`, 'B'.repeat(20))
  await writeFileAt(root, 'sessions/proj-b/session-ccc/session.v4.jsonl.zstd', 'C'.repeat(30))
  await writeFileAt(root, '.credentials.yaml', 'token: secret-value')
  await writeFileAt(root, '.credentials.yaml.bak-20260101', 'token: old-secret')
  await writeFileAt(root, 'dsh-config-manager/vault/.credentials.yaml', 'token: vault-secret')
  await writeFileAt(root, 'openai-gateway/api-key', 'sk-live-secret')
  await writeFileAt(root, 'profiles/desktop/node_modules/pkg-a/index.js', 'x'.repeat(50))
  await writeFileAt(root, 'cache/blob.bin', 'y'.repeat(70))
  return root
}

test('统计工作区、插件、技能、会话、跳过目录与凭据', async (t) => {
  const home = await makeFakeHome()
  t.after(() => rm(home, { recursive: true, force: true }))

  const r = await analyzeLocal({ dshHome: home, profile: 'desktop' })

  assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
  assert.equal(r.profile, 'desktop')
  assert.equal(r.workspaces.count, 1)
  assert.equal(r.workspaces.items[0].title, 'demo')
  assert.equal(r.workspaces.items[0].path, 'D:/work/demo')
  assert.equal(r.workspaces.items[0].sessions, 3)
  assert.equal(typeof r.workspaces.items[0].updatedAt, 'number')

  assert.equal(r.plugins.count, 2)
  assert.equal(r.plugins.bundles, 2)
  assert.deepEqual(r.plugins.bundlesMissing, ['dsh-not-installed'])
  assert.ok(r.plugins.items.every((i) => typeof i.name === 'string' && typeof i.version === 'string'))

  assert.equal(r.skills.count, 2)
  assert.equal(r.skills.bytes, 12)

  // session-<uuid> 与裸 <uuid> 两种目录都算会话
  assert.equal(r.sessions.count, 3)
  assert.equal(r.sessions.projects, 2)
  assert.equal(r.sessions.bytes, 150)

  const skipped = Object.fromEntries(r.skipped.map((s) => [s.name, s]))
  assert.ok(skipped['profiles/desktop/node_modules'])
  assert.equal(skipped['profiles/desktop/node_modules'].bytes, 50)
  assert.ok(skipped.cache.bytes === 70)
  assert.ok(skipped['profiles/desktop/node_modules'].note.includes('不同步'))

  // 凭据：只有相对路径与体积，绝不出现明文
  assert.equal(r.secrets.files.length, 4)
  assert.equal(r.secrets.totalBytes, r.secrets.files.reduce((sum, f) => sum + f.bytes, 0))
  const serialized = JSON.stringify(r)
  assert.ok(!serialized.includes('secret-value'))
  assert.ok(!serialized.includes('sk-live-secret'))
  for (const f of r.secrets.files) {
    assert.ok(!f.rel.includes('\\'), '相对路径应是 posix 风格')
    assert.equal(typeof f.bytes, 'number')
  }
  assert.deepEqual(
    r.secrets.files.map((f) => f.rel),
    ['.credentials.yaml', '.credentials.yaml.bak-20260101', 'dsh-config-manager/vault/.credentials.yaml', 'openai-gateway/api-key'],
  )

  assert.equal(r.totals.bytes, r.sessions.bytes + r.skills.bytes)
  assert.equal(typeof r.generatedAt, 'number')
})

test('数据源损坏时降级，不抛异常', async (t) => {
  const home = await makeFakeHome()
  t.after(() => rm(home, { recursive: true, force: true }))
  await writeFileAt(home, 'storages/workspace.json', '{ this is not json')
  await writeFileAt(home, 'profiles/desktop/package.json', 'not json either')

  const r = await analyzeLocal({ dshHome: home, profile: 'desktop' })
  assert.equal(r.workspaces.count, 0)
  assert.deepEqual(r.workspaces.items, [])
  assert.equal(r.plugins.count, 0)
  assert.equal(r.errors.length, 2)
  assert.ok(r.errors.every((e) => typeof e === 'string' && e.length > 0))
  // 其他数据源照常
  assert.equal(r.sessions.count, 3)
})

test('DSH_HOME 不存在时整体降级，仍然 resolve', async () => {
  const r = await analyzeLocal({ dshHome: join(tmpdir(), 'dsh-sync-hub-not-exist-xyz') })
  assert.equal(r.workspaces.count, 0)
  assert.equal(r.plugins.count, 0)
  assert.equal(r.sessions.count, 0)
  assert.equal(r.skills.count, 0)
  assert.equal(r.secrets.files.length, 0)
  assert.deepEqual(r.skipped, [])
  assert.ok(r.errors.length > 0)
})
