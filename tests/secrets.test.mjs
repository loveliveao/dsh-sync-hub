/**
 * 「同步凭据与密钥」开关自检。
 *
 *   node tests/secrets.test.mjs
 *
 * 只读真实 DSH_HOME，不写任何文件；也不会把任何密钥内容打印到终端 ——
 * 断言失败时只报自己的中文描述，不打印实际值。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  assertSyncableRel,
  isForbiddenRel,
  isSecretRel,
  redactText,
  SECRET_FILES,
} from '../lib/privacy.mjs'
import { defaultSettings, normalizeSettings, secretsEnabled } from '../lib/state.mjs'
import { collectAll, collectSecrets, secretsManifest } from '../lib/sections.mjs'
import { dshHome, profilePatch } from '../lib/paths.mjs'
import { sha256 } from '../lib/util.mjs'

let failures = 0

function check(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.log(`  ✗ ${name} — ${err && err.message ? err.message : err}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.log(`  ✗ ${name} — ${err && err.message ? err.message : err}`)
  }
}

/** 只留必要的段，采集快一点，也不会碰会话/技能目录。 */
function settingsWith(secrets) {
  return normalizeSettings({
    sections: {
      cordis: true,
      plugins: false,
      skills: false,
      sessions: false,
      secrets,
      workspaces: false,
      pluginData: false,
    },
  })
}

const SAMPLE = 'apiKey: dummy-inline-value-0001'

async function main() {
  console.log(`DSH_HOME=${dshHome()}`)

  console.log('\n[1] 开关默认关闭')
  check('defaultSettings().sections.secrets === false', () => {
    assert.strictEqual(defaultSettings().sections.secrets, false)
  })
  check('旧 state.json（没有 sections.secrets）按 false 处理', () => {
    assert.strictEqual(normalizeSettings({}).sections.secrets, false)
    assert.strictEqual(normalizeSettings({ sections: { cordis: true } }).sections.secrets, false)
  })
  check('normalizeSettings 把 secrets 夹紧成布尔', () => {
    assert.strictEqual(normalizeSettings({ sections: { secrets: true } }).sections.secrets, true)
    assert.strictEqual(normalizeSettings({ sections: { secrets: 'yes' } }).sections.secrets, false)
    assert.strictEqual(normalizeSettings({ sections: { secrets: 1 } }).sections.secrets, false)
  })
  check('secretsEnabled 与设置一致', () => {
    assert.strictEqual(secretsEnabled(settingsWith(true)), true)
    assert.strictEqual(secretsEnabled(settingsWith(false)), false)
    assert.strictEqual(secretsEnabled(null), false)
    assert.strictEqual(secretsEnabled({}), false)
  })

  console.log('\n[2] 隐私边界：凭据类可放开，私钥类永远禁止')
  check('isForbiddenRel(".credentials.yaml") 为 true', () => {
    assert.strictEqual(isForbiddenRel('.credentials.yaml'), true)
  })
  check('isForbiddenRel(".credentials.yaml", {allowSecrets:true}) 为 false', () => {
    assert.strictEqual(isForbiddenRel('.credentials.yaml', { allowSecrets: true }), false)
  })
  check('allowSecrets 下私钥类仍然禁止', () => {
    assert.strictEqual(isForbiddenRel('keys/private.pem', { allowSecrets: true }), true)
    assert.strictEqual(isForbiddenRel('keys/id_rsa', { allowSecrets: true }), true)
    assert.strictEqual(isForbiddenRel('keys/server.pfx', { allowSecrets: true }), true)
    assert.strictEqual(isForbiddenRel('sync-hub/state.json', { allowSecrets: true }), true)
  })
  check('不带参数时旧行为不变', () => {
    assert.strictEqual(isForbiddenRel('notes/todo.md'), false)
    assert.strictEqual(isForbiddenRel('.env'), true)
    assert.strictEqual(isForbiddenRel('auth.json'), true)
    assert.strictEqual(isForbiddenRel('.netrc'), true)
    assert.strictEqual(isForbiddenRel('id_ed25519'), true)
  })
  check('isSecretRel 认得凭据清单里的文件', () => {
    for (const rel of SECRET_FILES) {
      assert.strictEqual(isSecretRel(rel), true, rel)
    }
    assert.strictEqual(isSecretRel('docs/readme.md'), false)
  })
  check('assertSyncableRel 区分两类报错', () => {
    assert.throws(() => assertSyncableRel('.credentials.yaml'), /凭据\/密钥文件/)
    assert.throws(() => assertSyncableRel('keys/private.pem', { allowSecrets: true }), /私钥类文件/)
    assert.strictEqual(assertSyncableRel('.credentials.yaml', { allowSecrets: true }), '.credentials.yaml')
  })

  console.log('\n[3] 内联密钥：开关打开时不脱敏')
  check('keepInlineSecrets 时 redacted 为 false', () => {
    assert.strictEqual(redactText(SAMPLE, { keepInlineSecrets: true }).redacted, false)
    assert.strictEqual(redactText(SAMPLE, { keepInlineSecrets: true }).changed, false)
  })
  check('不传 options 时仍然脱敏', () => {
    assert.strictEqual(redactText(SAMPLE).redacted, true)
    assert.strictEqual(redactText(SAMPLE).changed, true)
  })
  check('keepInlineSecrets 时原文保留（不打印内容）', () => {
    const out = redactText(SAMPLE, { keepInlineSecrets: true })
    assert.strictEqual(out.text, SAMPLE)
  })

  console.log('\n[4] collectSecrets：关着不采集，打开才采集')
  await checkAsync('开关关闭时 collectSecrets 返回 0 条', async () => {
    const entries = await collectSecrets(settingsWith(false))
    assert.strictEqual(entries.length, 0)
  })
  await checkAsync('开关打开时只采集存在的凭据文件', async () => {
    const entries = await collectSecrets(settingsWith(true))
    for (const entry of entries) {
      assert.strictEqual(entry.section, 'secrets')
      assert.strictEqual(entry.meta.kind, 'secret')
      assert.strictEqual(entry.meta.sensitive, true)
      assert.strictEqual(entry.meta.bytes, entry.bytes)
      assert.ok(entry.meta.label, '缺少中文标签')
      assert.ok(SECRET_FILES.includes(entry.rel), `意外的文件：${entry.rel}`)
      assert.ok(!('blob' in entry.meta), 'meta 里不能带文件内容')
    }
  })
  await checkAsync('meta 里不含文件内容（抽查）', async () => {
    const entries = await collectSecrets(settingsWith(true))
    for (const entry of entries) {
      const raw = await readFile(entry.abs, 'utf8')
      const head = raw.trim().slice(0, 12)
      if (head.length < 8) continue
      assert.ok(!JSON.stringify(entry.meta).includes(head), 'meta 里出现了文件内容片段')
    }
  })

  const existing = await collectSecrets(settingsWith(true))
  if (existing.length === 0) {
    console.log('  - 跳过「开启时 ≥1 条」：本机 DSH_HOME 下没有凭据文件')
  } else {
    await checkAsync('开启时至少采集到 1 条', async () => {
      const entries = await collectSecrets(settingsWith(true))
      assert.ok(entries.length >= 1)
    })
  }

  console.log('\n[5] collectAll：关闭时凭据不进集合')
  await checkAsync('开关关闭时条目里没有 .credentials.yaml', async () => {
    const { entries } = await collectAll(settingsWith(false))
    assert.ok(!entries.some((e) => e.rel === '.credentials.yaml'))
    assert.ok(!entries.some((e) => e.section === 'secrets'))
    for (const entry of entries) {
      assert.ok(!isForbiddenRel(entry.rel), `不该出现的路径：${entry.rel}`)
    }
  })
  await checkAsync('开关打开时凭据进入集合、cordis 不再脱敏', async () => {
    const { entries } = await collectAll(settingsWith(true))
    const secretsEntries = entries.filter((e) => e.section === 'secrets')
    assert.ok(secretsEntries.length === existing.length, 'secrets 条目数不一致')
    const cordis = entries.find((e) => e.section === 'cordis')
    if (cordis) {
      assert.strictEqual(cordis.meta.kind, 'files', '开了开关后 cordis 不该再走脱敏')
      const raw = await readFile(profilePatch(), 'utf8')
      assert.strictEqual(cordis.sha, sha256(Buffer.from(raw, 'utf8')), 'cordis 内容应与原文一致')
    }
  })

  console.log('\n[6] secretsManifest：给界面用')
  check('关闭时 files 为空', () => {
    const m = secretsManifest(settingsWith(false))
    assert.strictEqual(m.enabled, false)
    assert.strictEqual(m.files.length, 0)
    assert.strictEqual(m.candidates.length, SECRET_FILES.length)
  })
  check('打开时列出将上传的文件', () => {
    const m = secretsManifest(settingsWith(true))
    assert.strictEqual(m.enabled, true)
    assert.deepStrictEqual(m.files, [...SECRET_FILES])
  })

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('自检崩溃：', err && err.message ? err.message : err)
  process.exit(1)
})
