/**
 * 插件配置解析：自研行级 YAML 解析器、脱敏、坏数据降级。
 *
 *   node tests/plugin-config.test.mjs
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = await mkdtemp(join(tmpdir(), 'sync-hub-plugin-config-'))
process.env.DSH_HOME = SANDBOX
process.env.DSH_PROFILE = 'desktop'

const {
  parsePluginConfigs,
  loadPluginConfigs,
  renderPluginConfigYaml,
  pluginFileKey,
  isSensitiveKey,
  normalizePluginVersion,
} = await import('../lib/plugin-config.mjs')

let failures = 0

function check(label, ok, detail = '') {
  if (ok) {
    console.log('  ✓ ' + label)
  } else {
    failures += 1
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''))
  }
}

const PATCH = [
  '- id: llm-pi-ai',
  "  name: '@deepseek-ai/dsh-llm-pi-ai'",
  '  config:',
  '    apiKey: sk-live-secret',
  '    apiKeyEnv: DSH_LLM_API_KEY',
  '    endpoint: https://example.com/v1 # 主地址',
  '    timeout: 30',
  '    enabled: true',
  '    nested:',
  '      depth: 2',
  '      items:',
  '        - alpha',
  '        - beta',
  '    models:',
  '      - id: gpt',
  "        label: 'GPT #1'",
  '      - id: claude',
  '        label: Claude',
  '- id: cc-safety-net',
  '  disabled: true',
  '- id: broken-entry',
  '  config: not-a-map',
  '',
].join('\n')

console.log('[1] 解析真实形状的 cordis.patch.yml')
{
  const items = parsePluginConfigs(PATCH)
  check('解析出三条', items.length === 3, String(items.length))

  const first = items[0] || {}
  check('id 是 llm-pi-ai', first.id === 'llm-pi-ai', String(first.id))
  check('name 是包名', first.name === '@deepseek-ai/dsh-llm-pi-ai', String(first.name))
  check('key 取包名', first.key === '@deepseek-ai/dsh-llm-pi-ai', String(first.key))
  check('hasConfig 为 true', first.hasConfig === true)
  check(
    'configKeys 列出顶层键',
    Array.isArray(first.configKeys) &&
      ['apiKey', 'apiKeyEnv', 'endpoint', 'timeout', 'enabled', 'nested', 'models'].every((key) =>
        first.configKeys.includes(key),
      ),
    JSON.stringify(first.configKeys),
  )

  const config = first.config || {}
  check('嵌套 map 解析正确', config.nested && config.nested.depth === 2, JSON.stringify(config.nested))
  check(
    '标量列表解析正确',
    Array.isArray(config.nested.items) && config.nested.items[0] === 'alpha' && config.nested.items[1] === 'beta',
    JSON.stringify(config.nested && config.nested.items),
  )
  check(
    '序列里的 map 解析正确',
    Array.isArray(config.models) && config.models[0] && config.models[0].id === 'gpt' && config.models[0].label === 'GPT #1',
    JSON.stringify(config.models),
  )
  check('数字识别成 number', config.timeout === 30, String(config.timeout))
  check('布尔识别成 boolean', config.enabled === true, String(config.enabled))
  check('行内注释被去掉', config.endpoint === 'https://example.com/v1', String(config.endpoint))
  check('configPaths 含二级路径', Array.isArray(first.configPaths) && first.configPaths.includes('nested.depth'), JSON.stringify(first.configPaths))
}

console.log('\n[2] 敏感键脱敏')
{
  const items = parsePluginConfigs(PATCH)
  const config = (items[0] || {}).config || {}
  check('apiKey 被掩码', config.apiKey === '<redacted>', String(config.apiKey))
  check('redacted 标记为 true', items[0].redacted === true)
  check('apiKeyEnv 不脱敏', config.apiKeyEnv === 'DSH_LLM_API_KEY', String(config.apiKeyEnv))
  check('脱敏后仍可 JSON 序列化', typeof JSON.stringify(config) === 'string')
  check('isSensitiveKey 认得 token', isSensitiveKey('accessToken') === true)
  check('isSensitiveKey 放行 apiKeyEnv', isSensitiveKey('apiKeyEnv') === false)
  check('isSensitiveKey 放行普通键', isSensitiveKey('model') === false)
}

console.log('\n[3] 坏数据降级，不影响其它条目')
{
  const items = parsePluginConfigs(PATCH)
  const second = items[1] || {}
  check('没有 config 的条目 hasConfig 为 false', second.hasConfig === false)
  check('没有 config 的条目 config 为 null', second.config === null)
  const third = items[2] || {}
  check('config 不是 map 的条目降级', third.hasConfig === false && third.config === null)
  check('降级条目仍保留 id', third.id === 'broken-entry', String(third.id))
  check('其它条目不受影响', items[0].hasConfig === true)
  check('空文本返回空数组', parsePluginConfigs('').length === 0)
  check('非字符串返回空数组', parsePluginConfigs(null).length === 0)
}

console.log('\n[4] !!js 表达式与空集合')
{
  const patch = [
    '- id: expr-plugin',
    '  config:',
    '    handler: !!js process.env.FOO',
    '    list: []',
    '    empty: {}',
    '    nothing:',
    '',
  ].join('\n')
  const items = parsePluginConfigs(patch)
  const config = (items[0] || {}).config || {}
  check('!!js 表达式按原样保留', config.handler === '!!js process.env.FOO', String(config.handler))
  check('空列表是 []', Array.isArray(config.list) && config.list.length === 0)
  check('空 map 是 {}', config.empty && typeof config.empty === 'object' && !Array.isArray(config.empty))
  check('空值是 null', config.nothing === null, String(config.nothing))
}

console.log('\n[5] 渲染副本文本')
{
  const items = parsePluginConfigs(PATCH)
  const text = renderPluginConfigYaml(items[0])
  check('带插件名注释', text.includes('# plugin: @deepseek-ai/dsh-llm-pi-ai'))
  check('带配置键', text.includes('apiKeyEnv: DSH_LLM_API_KEY'), text.split('\n').slice(0, 6).join(' | '))
  check('输出是确定性的', renderPluginConfigYaml(items[0]) === text)
  check('文件名安全化', pluginFileKey('@deepseek-ai/dsh-llm-pi-ai') === 'deepseek-ai-dsh-llm-pi-ai', pluginFileKey('@deepseek-ai/dsh-llm-pi-ai'))
}

console.log('\n[6] 版本号归一化')
{
  check('^1.6.0 -> 1.6.0', normalizePluginVersion('^1.6.0') === '1.6.0')
  check('0.82.0 原样', normalizePluginVersion('0.82.0') === '0.82.0')
  check('file: 视为未知', normalizePluginVersion('file:local-plugins/dsh-sync-hub') === null)
  check('空值视为未知', normalizePluginVersion('') === null)
}

console.log('\n[7] loadPluginConfigs 读 profile（临时 DSH_HOME）')
{
  const dir = join(SANDBOX, 'profiles', 'desktop')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'cordis.patch.yml'), PATCH, 'utf8')
  const items = await loadPluginConfigs()
  check('读到三条', items.length === 3, String(items.length))
  check('第一条是 llm-pi-ai', items[0] && items[0].id === 'llm-pi-ai', JSON.stringify(items[0] && items[0].id))
}

await rm(SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
console.log(failures ? '\n✗ ' + failures + ' 项未通过' : '\n✓ 全部通过')
process.exitCode = failures ? 1 : 0
