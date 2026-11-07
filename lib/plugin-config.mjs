/**
 * 解析 profile 的 cordis.patch.yml，抽出每个插件的 config 块（脱敏后）。
 *
 * 为什么不引 yaml 库：profile 的 node_modules 里没有 yaml/js-yaml，
 * 而插件不允许引入第三方依赖，所以这里自研一个「行级 YAML 子集」解析器。
 *
 * 支持：顶层 "- id:" / "- name:" / 缩进 "config:" 块；嵌套 map；标量；
 *       "!!js" 表达式（按字符串原样保留）；行内注释；数字/布尔/字符串自动识别；
 *       "- insert:" 包裹的列表；序列里嵌套 map。
 * 不支持（本仓库用不到）：锚点/别名、多文档、块标量（| 与 >）、非空流式集合。
 *
 * 约束（AGENTS.md）：公开函数不抛异常，坏数据降级成空结果。
 */
import { readFile } from 'node:fs/promises'
import { profilePatch } from './paths.mjs'

const MASK = '<redacted>'
/** 契约给定的敏感键名（大小写不敏感）。 */
const SENSITIVE_KEY = /(key|token|secret|password|passwd|cookie|auth|credential|apikey)/i
/** 环境变量名不是密钥：apiKeyEnv / some_TOKEN_ENV 这类要保留原样。 */
const ENV_KEY = /(env|var)$/i
const MAX_PATHS = 200
const BACKTICK = String.fromCharCode(96)

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/* ------------------------------------------------------------------ */
/* 行级解析                                                            */
/* ------------------------------------------------------------------ */

/** 去掉行内注释：# 前必须是空白或行首，且不在引号里。 */
function stripComment(text) {
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i)
  }
  return text
}

/** 把文本切成 { indent, text, lineNo } 的行序列（空行与注释行丢弃）。 */
function tokenize(text) {
  const out = []
  const rawLines = String(text || '').split(/\r?\n/)
  for (let n = 0; n < rawLines.length; n++) {
    const raw = String(rawLines[n]).replace(/\t/g, '  ')
    if (!raw.trim()) continue
    const withoutComment = stripComment(raw)
    if (!withoutComment.trim()) continue
    const indent = withoutComment.length - withoutComment.replace(/^ +/, '').length
    const content = withoutComment.slice(indent).replace(/\s+$/, '')
    if (!content) continue
    out.push({ indent, text: content, lineNo: n + 1 })
  }
  return out
}

function unquote(text) {
  if (typeof text !== 'string') return text
  const t = text.trim()
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'")
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  return t
}

/** 拆 "key: value"；不是键值行就返回 null。 */
function splitKey(text) {
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ':' && (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
      const key = text.slice(0, i).trim()
      if (!key) return null
      return { key: unquote(key), value: text.slice(i + 1).trim() }
    }
  }
  return null
}

/** 标量识别：字符串 / 数字 / 布尔 / null / !!js 表达式。 */
function parseScalar(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return null
  if (text.startsWith("'") || text.startsWith('"')) return unquote(text)
  if (text.startsWith('!!')) return text
  if (text === '[]') return []
  if (text === '{}') return {}
  if (text.startsWith('[') || text.startsWith('{')) return text
  if (text === 'null' || text === 'Null' || text === 'NULL' || text === '~') return null
  const lower = text.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  if (/^[-+]?\d+$/.test(text)) return Number(text)
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text)
  if (/^[-+]?\d+[eE][-+]?\d+$/.test(text)) return Number(text)
  return text
}

function isSeqLine(line) {
  return line.text === '-' || line.text.startsWith('- ')
}

/** 键后面没有值时，去下面找块；返回 { value, next }。 */
function parseValueAfterKey(lines, index, keyIndent, valueText) {
  if (valueText !== '') return { value: parseScalar(valueText), next: index }
  if (index < lines.length && lines[index].indent === keyIndent && isSeqLine(lines[index])) {
    const [value, next] = parseSeq(lines, index, keyIndent)
    return { value, next }
  }
  if (index < lines.length && lines[index].indent > keyIndent) {
    const [value, next] = parseBlock(lines, index, lines[index].indent)
    return { value, next }
  }
  return { value: null, next: index }
}

function parseMap(lines, index, indent) {
  const map = {}
  let i = index
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i]
    if (isSeqLine(line)) break
    const kv = splitKey(line.text)
    if (!kv) {
      i += 1
      continue
    }
    i += 1
    const r = parseValueAfterKey(lines, i, indent, kv.value)
    map[kv.key] = r.value
    i = r.next
  }
  return [map, i]
}

function parseSeq(lines, index, indent) {
  const arr = []
  let i = index
  while (i < lines.length && lines[i].indent === indent && isSeqLine(lines[i])) {
    const raw = lines[i].text
    const after = raw.slice(1)
    const trimmed = after.trimStart()
    const contentIndent = indent + 1 + (after.length - trimmed.length)
    i += 1
    if (!trimmed) {
      if (i < lines.length && lines[i].indent > indent) {
        const [value, next] = parseBlock(lines, i, lines[i].indent)
        arr.push(value)
        i = next
      } else {
        arr.push(null)
      }
      continue
    }
    const kv = splitKey(trimmed)
    if (!kv) {
      arr.push(parseScalar(trimmed))
      continue
    }
    const item = {}
    const first = parseValueAfterKey(lines, i, contentIndent, kv.value)
    item[kv.key] = first.value
    i = first.next
    while (i < lines.length && lines[i].indent === contentIndent && !isSeqLine(lines[i])) {
      const kv2 = splitKey(lines[i].text)
      if (!kv2) {
        i += 1
        continue
      }
      i += 1
      const r2 = parseValueAfterKey(lines, i, contentIndent, kv2.value)
      item[kv2.key] = r2.value
      i = r2.next
    }
    arr.push(item)
  }
  return [arr, i]
}

function parseBlock(lines, index, indent) {
  if (index >= lines.length) return [null, index]
  const line = lines[index]
  if (isSeqLine(line)) return parseSeq(lines, index, indent)
  return parseMap(lines, index, indent)
}

/* ------------------------------------------------------------------ */
/* 脱敏                                                                */
/* ------------------------------------------------------------------ */

/** 键名像不像密钥。环境变量名（apiKeyEnv）不算。 */
export function isSensitiveKey(key) {
  if (typeof key !== 'string' || !key) return false
  if (ENV_KEY.test(key)) return false
  if (/^env[A-Z_]/i.test(key)) return false
  return SENSITIVE_KEY.test(key)
}

/** 深拷贝 + 敏感值替换成掩码。返回脱敏后的值，state.redacted 标记是否命中过。 */
export function redactPluginConfig(value, state = { redacted: false }) {
  if (Array.isArray(value)) return value.map((item) => redactPluginConfig(item, state))
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        out[key] = MASK
        state.redacted = true
        continue
      }
      out[key] = redactPluginConfig(item, state)
    }
    return out
  }
  return value
}

/** 二级路径（最多两层），给人看。 */
export function configPathsOf(config) {
  const out = []
  if (!isPlainObject(config)) return out
  for (const [key, value] of Object.entries(config)) {
    if (isPlainObject(value)) {
      const children = Object.keys(value)
      if (!children.length) {
        out.push(key)
      } else {
        for (const child of children) out.push(key + '.' + child)
      }
    } else {
      out.push(key)
    }
    if (out.length >= MAX_PATHS) break
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

function collectEntries(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return
  if (Array.isArray(node)) {
    for (const item of node) collectEntries(item, out, depth + 1)
    return
  }
  if (node.insert && typeof node.insert === 'object') collectEntries(node.insert, out, depth + 1)
  if (typeof node.id === 'string' || typeof node.name === 'string') out.push(node)
}

function buildEntry(raw) {
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const key = name || id
  const hasConfig = isPlainObject(raw.config) && Object.keys(raw.config).length > 0
  if (!hasConfig) {
    return { id, name: name || id, key, hasConfig: false, configKeys: [], configPaths: [], config: null, redacted: false }
  }
  try {
    const state = { redacted: false }
    const config = redactPluginConfig(raw.config, state)
    return {
      id,
      name: name || id,
      key,
      hasConfig: true,
      configKeys: Object.keys(config),
      configPaths: configPathsOf(config),
      config,
      redacted: state.redacted,
    }
  } catch {
    return { id, name: name || id, key, hasConfig: false, configKeys: [], configPaths: [], config: null, redacted: false }
  }
}

/**
 * 解析 cordis.patch.yml 文本，返回每个插件的 id / name / key / config。
 * 单条解析失败只降级这一条，不影响其它条目。
 *
 * @param {string} patchText
 * @returns {Array<{id:string,name:string,key:string,hasConfig:boolean,configKeys:string[],configPaths:string[],config:object|null,redacted:boolean}>}
 */
export function parsePluginConfigs(patchText) {
  const out = []
  try {
    if (typeof patchText !== 'string' || !patchText.trim()) return out
    const lines = tokenize(patchText)
    if (!lines.length) return out
    const [root] = parseBlock(lines, 0, lines[0].indent)
    const rawEntries = []
    collectEntries(root, rawEntries)
    for (const raw of rawEntries) {
      try {
        const item = buildEntry(raw)
        if (item && (item.id || item.name)) out.push(item)
      } catch {
        out.push({ id: '', name: '', key: '', hasConfig: false, configKeys: [], configPaths: [], config: null, redacted: false })
      }
    }
    return out
  } catch {
    return out
  }
}

/**
 * 读当前 profile 的 cordis.patch.yml 并解析。读不到就返回空数组。
 *
 * @returns {Promise<Array>}
 */
export async function loadPluginConfigs() {
  try {
    const text = await readFile(profilePatch(), 'utf8')
    return parsePluginConfigs(text)
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ */
/* 渲染（副本文本）                                                    */
/* ------------------------------------------------------------------ */

function startsWithYamlSpecial(text) {
  const first = text.charAt(0)
  if (first === BACKTICK) return true
  return /^[\s>|*&!%@"'{[]/.test(first)
}

function yamlNeedsQuote(text) {
  if (!text) return true
  if (startsWithYamlSpecial(text)) return true
  if (/:\s/.test(text)) return true
  if (/\s#/.test(text)) return true
  if (/[\n\r\t]/.test(text)) return true
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(text)) return true
  if (/^-?\d+(\.\d+)?$/.test(text)) return true
  if (/\s$/.test(text)) return true
  return false
}

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  const text = String(value)
  if (!yamlNeedsQuote(text)) return text
  return "'" + text.replace(/'/g, "''") + "'"
}

function yamlKey(key) {
  const text = String(key)
  if (!yamlNeedsQuote(text)) return text
  return "'" + text.replace(/'/g, "''") + "'"
}

function stringifyMap(map, depth) {
  const pad = '  '.repeat(depth)
  const out = []
  for (const [key, value] of Object.entries(map || {})) {
    const k = yamlKey(key)
    if (isPlainObject(value)) {
      if (!Object.keys(value).length) {
        out.push(pad + k + ': {}')
        continue
      }
      out.push(pad + k + ':')
      out.push(...stringifyMap(value, depth + 1))
      continue
    }
    if (Array.isArray(value)) {
      if (!value.length) {
        out.push(pad + k + ': []')
        continue
      }
      out.push(pad + k + ':')
      out.push(...stringifyArray(value, depth + 1))
      continue
    }
    out.push(pad + k + ': ' + yamlScalar(value))
  }
  return out
}

function stringifyArray(arr, depth) {
  const pad = '  '.repeat(depth)
  const out = []
  for (const item of arr) {
    if (isPlainObject(item)) {
      const keys = Object.keys(item)
      if (!keys.length) {
        out.push(pad + '- {}')
        continue
      }
      const body = stringifyMap(item, depth + 1)
      out.push(pad + '- ' + body[0].slice((depth + 1) * 2))
      out.push(...body.slice(1))
      continue
    }
    if (Array.isArray(item)) {
      out.push(pad + '-')
      out.push(...stringifyArray(item, depth + 1))
      continue
    }
    out.push(pad + '- ' + yamlScalar(item))
  }
  return out
}

/**
 * 把插件配置渲染成「副本」文本（确定性输出，不含时间戳）。
 * 这份文本就是同步到 sync-hub/reports/plugin-config/<key>.yml 的内容。
 *
 * @param {{name?:string,id?:string,config?:object|null}} item
 * @returns {string}
 */
export function renderPluginConfigYaml(item) {
  const safe = item && typeof item === 'object' ? item : {}
  const lines = [
    '# dsh-sync-hub 插件配置副本（只读副本，不会写回任何 DSH 配置）',
    '# plugin: ' + (safe.name || ''),
    '# id: ' + (safe.id || ''),
  ]
  const config = isPlainObject(safe.config) ? safe.config : {}
  lines.push(...stringifyMap(config, 0))
  return lines.join('\n') + '\n'
}

/**
 * 依赖版本号归一化：把 "^1.6.0" / "~2.0.0" 剥成 "1.6.0" / "2.0.0"；
 * file: / workspace: 这类非语义化版本按「未知」处理，返回 null。
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizePluginVersion(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  if (/^(file|workspace|link|git|https?):/i.test(text)) return null
  const m = /^(\^|~|>=|>|<=|<)?\s*v?(\d+(?:\.\d+)*)/.exec(text)
  return m ? m[2] : null
}

/** 文件名安全化：把 @ / 等字符换成 -，避免写盘路径越界。 */
export function pluginFileKey(key) {
  const text = typeof key === 'string' ? key : ''
  const safe = text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '').replace(/-+$/, '')
  return safe || 'plugin'
}

export default { parsePluginConfigs, loadPluginConfigs, renderPluginConfigYaml, pluginFileKey }
