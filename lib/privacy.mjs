/**
 * 隐私边界。这是插件的硬约束，不做成可选项：
 *   · .credentials.yaml / 凭据库导出 / token 文件永不读取、永不写入、永不上传；
 *   · 同步文本配置时把字面量密钥替换为 <redacted>，环境变量引用保持原样；
 *   · 远端 manifest 里不出现任何密钥，只出现路径与 sha256。
 *
 * 只做「能确定的」脱敏：拿不准的一律按密钥处理，宁可多抹掉一行配置，
 * 也不把 token 传出去。
 */

const NEVER_REL = [
  /(^|\/)\.credentials(\.|$)/i,
  /(^|\/)credentials\.(ya?ml|json)$/i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)(auth|oauth|token|tokens|secrets?)\.json$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.|$)/i,
  /\.(pem|p12|pfx|key)$/i,
  /(^|\/)sync-hub(\/|$)/i,
]

const SENSITIVE_KEY = /^(api[_-]?key|apikey|access[_-]?key|secret[_-]?key|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|password|passwd|pwd|authorization|cookie|private[_-]?key|session[_-]?key|encryption[_-]?key|webhook[_-]?secret)$/i

const ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$|^[A-Z][A-Z0-9_]{2,}$/

export function isForbiddenRel(rel) {
  if (!rel) return true
  const normalized = String(rel).replace(/\\/g, '/')
  return NEVER_REL.some((re) => re.test(normalized))
}

export function assertSyncableRel(rel) {
  if (isForbiddenRel(rel)) {
    throw new Error(`隐私边界：${rel} 属于凭据/密钥文件，不同步`)
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
 * 行级脱敏，适合 YAML / dotenv / TOML。返回替换后的文本与命中数。
 * 只处理 `key: value` 与 `key = value` 两种形态，保留缩进与行尾。
 */
export function redactText(text) {
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
  return { text: out.join('\n'), redacted, changed: redacted > 0 }
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
