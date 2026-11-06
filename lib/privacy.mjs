/**
 * 隐私边界。默认是硬约束：
 *   · .credentials.yaml / 凭据库导出 / token 文件默认永不读取、永不写入、永不上传；
 *   · 同步文本配置时把字面量密钥替换为 <redacted>，环境变量引用保持原样；
 *   · 远端 manifest 里不出现任何密钥，只出现路径与 sha256。
 *
 * 「同步凭据与密钥」开关打开后，凭据类文件（见 SECRET_FILES）可以随同步上传，
 * 配置里的内联明文密钥也一并迁移。但私钥类文件（*.pem / id_rsa / sync-hub/ 自身
 * 目录）永远禁止 —— 这条不接受开关。
 *
 * 只做「能确定的」脱敏：拿不准的一律按密钥处理，宁可多抹掉一行配置，
 * 也不把 token 传出去。
 */

/** 明确列入「凭据/密钥」的已知文件（相对 DSH_HOME，posix 风格）。 */
export const SECRET_FILES = [
  '.credentials.yaml',
  'dsh-config-manager/vault/.credentials.yaml',
  'openai-gateway/api-key',
]

/** 凭据类：开关打开后可以同步。 */
const SECRET_REL = [
  /(^|\/)\.credentials(\.|$)/i,
  /(^|\/)credentials\.(ya?ml|json)$/i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)(auth|oauth|token|tokens|secrets?)\.json$/i,
  /(^|\/)\.netrc$/i,
]

/** 私钥类：永远禁止，开关也救不了。 */
const PRIVATE_REL = [
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.|$)/i,
  /\.(pem|p12|pfx|key)$/i,
  /(^|\/)sync-hub(\/|$)/i,
]

const SENSITIVE_KEY = /^(api[_-]?key|apikey|access[_-]?key|secret[_-]?key|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|password|passwd|pwd|authorization|cookie|private[_-]?key|session[_-]?key|encryption[_-]?key|webhook[_-]?secret)$/i

const ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$|^[A-Z][A-Z0-9_]{2,}$/

function normalizeRel(rel) {
  return String(rel).replace(/\\/g, '/')
}

/** 是否属于「凭据/密钥」类文件（凭据清单 + .credentials* + .env* + token 类 json + .netrc）。 */
export function isSecretRel(rel) {
  if (!rel) return false
  const normalized = normalizeRel(rel)
  if (SECRET_FILES.some((name) => normalized === name || normalized.endsWith(`/${name}`))) return true
  return SECRET_REL.some((re) => re.test(normalized))
}

/** 私钥类文件（永不上传，开关无效）。 */
function isPrivateRel(rel) {
  if (!rel) return false
  const normalized = normalizeRel(rel)
  return PRIVATE_REL.some((re) => re.test(normalized))
}

/**
 * 这个相对路径能不能进同步集合。
 *
 * `options.allowSecrets === true` 时凭据类文件放行（用户在「同步范围」里开了
 * 「凭据与密钥」），但私钥类文件永远禁止。
 */
export function isForbiddenRel(rel, options = {}) {
  if (!rel) return true
  const normalized = normalizeRel(rel)
  if (isPrivateRel(normalized)) return true
  if (options && options.allowSecrets === true) return false
  return isSecretRel(normalized)
}

/**
 * 写入前的硬断言。私钥类文件永不导出；凭据类文件只有开了开关才允许上传。
 */
export function assertSyncableRel(rel, options = {}) {
  if (isPrivateRel(rel)) {
    throw new Error(`隐私边界：${rel} 属于私钥类文件，永不导出`)
  }
  if (options && options.allowSecrets === true) return rel
  if (isSecretRel(rel)) {
    throw new Error(
      `隐私边界：${rel} 属于凭据/密钥文件，不同步（在「同步范围」里开启「凭据与密钥」后允许上传）`,
    )
  }
  return rel
}

function redactValue(rawValue) {
  const value = rawValue.trim()
  if (!value) return rawValue
  const unquoted = value.replace(/^['"]|['"]$/g, '')
  if (ENV_REF.test(unquoted)) return rawValue
  if (unquoted.startsWith('${') && unquoted.endsWith('}')) return rawValue
  // 短值可能是枚举（如 "auto"），不当密钥；8 字符以上才动手。
  if (unquoted.length < 8) return rawValue
  const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : ''
  return `${quote}<redacted>${quote}`
}

/**
 * 行级脱敏，适合 YAML / dotenv / TOML。返回替换后的文本与命中情况。
 * 只处理 `key: value` 与 `key = value` 两种形态，保留缩进与行尾。
 *
 * `options.keepInlineSecrets === true` 时不动内联明文密钥（原文返回，
 * redacted=false）：这是「同步凭据与密钥」开关打开后的行为 —— 配置里的
 * 明文 API Key 要完整迁移过去，而不是换成占位符。
 *
 * 返回值：`redacted` 是布尔（有没有脱敏），`count` 是被替换的行数。
 */
export function redactText(text, options = {}) {
  if (options && options.keepInlineSecrets === true) {
    return { text: String(text), redacted: false, count: 0, changed: false }
  }
  let redacted = 0
  const lines = String(text).split(/\r?\n/)
  const out = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return line
    const match = /^(\s*(?:-\s+)?["']?)([A-Za-z0-9_.-]+)(["']?\s*[:=]\s*)(.*)$/.exec(line)
    if (!match) return line
    const [, lead, key, sep, value] = match
    if (!SENSITIVE_KEY.test(key)) return line
    if (/env$/i.test(key) || /ref$/i.test(key) || /(^|_)env(s)?$/i.test(key)) return line
    const next = redactValue(value)
    if (next === value) return line
    redacted += 1
    return `${lead}${key}${sep}${next}`
  })
  return { text: out.join('\n'), redacted: redacted > 0, count: redacted, changed: redacted > 0 }
}

/** JSON 形态的脱敏：递归替换敏感键，保留结构。 */
export function redactJson(value, seen = new WeakSet()) {
  let redacted = 0
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return node
    if (seen.has(node)) return node
    seen.add(node)
    if (Array.isArray(node)) return node.map((item) => walk(item))
    const out = {}
    for (const [key, item] of Object.entries(node)) {
      if (SENSITIVE_KEY.test(key) && !/env$|ref$/i.test(key) && typeof item === 'string') {
        const next = redactValue(item)
        if (next !== item) redacted += 1
        out[key] = next
      } else {
        out[key] = walk(item)
      }
    }
    return out
  }
  const result = walk(value)
  return { value: result, redacted }
}

/** 报告里出现的设备信息也要过一遍，避免把路径里的用户名以外的秘密带出去。 */
export function maskSecretString(text) {
  return String(text || '')
    .replace(/\b(sk|pk|ghp|gho|ghs|github_pat|xoxb|xoxp)[-_A-Za-z0-9]{12,}\b/g, '<redacted>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b(?=\s*$)/g, '<redacted>')
}
