/**
 * 会话的规范化：让同一个会话在不同机器上能被认出是「同一个」。
 *
 * 为什么需要这一层
 * ----------------
 * DSH 把会话放在 `sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd`，
 * 其中 projectKey 是从会话 header 里的 cwd 推导出来的（见下 projectKey）。
 * 同一台机器上换台机器路径就变（`D:\VibeCoding` ↔ `D:\Code\VibeCoding`），
 * 于是：
 *   - 条目 id 变了 → 两台机器认不出这是同一个会话；
 *   - 文件字节变了（header 里的 cwd 不同）→ sha 不同 → 每次同步都判成冲突。
 *
 * 这里做的事
 * ----------
 * 1. 复刻 DSH 的 projectKey / encodeSegment 算法，保证我们算出来的落点
 *    和 DSH 期望的完全一致（不一致会被 DSH 判成 corrupt session log）。
 * 2. 会话的「逻辑内容」= 解压后的 JSONL，把 header 里的 cwd 换成占位符
 *    __DSH_SYNC_CWD__。逻辑内容的 sha 就是条目的 sha —— 两台机器路径不同
 *    也能对上。
 * 3. 写回本机时再把占位符换成本机实际目录，并落到本机 projectKey 目录下。
 *
 * 依据（DSH 桌面版 0.2.2-rc.1 源码）：
 *   @deepseek-ai/dsh-session-persistence-jsonl/lib/index.js
 *     :858-870  encodeSegment   —— ~XXXX 转义
 *     :880-899  projectKey      —— cwd → 目录名
 *     :907-933  projectDir / sessionDir / generationLogPath
 *     :3204     落盘路径由 meta.cwd 派生（cwd 与目录必须一致）
 *     :3476     assertStoredIdentity —— 路径与 header 不一致即判损坏
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import { sessionsRoot } from './paths.mjs'

/** header 里 cwd 的占位符。规范化时换掉它，比对时两台机器就一致了。 */
export const CWD_PLACEHOLDER = '__DSH_SYNC_CWD__'

/** 会话文件的固定名字（DSH 的 SESSION_FORMAT_VERSION = 4）。 */
export const SESSION_FILE_NAME = 'session.v4.jsonl.zstd'

/**
 * zstd 帧魔数。帧头字节是 28 b5 2f fd，
 * 用 readUInt32LE 读出来是 0xFD2FB528（别写成 0x28B52FFD，那是字节序反了）。
 */
const ZSTD_MAGIC = 0xfd2fb528

/* ------------------------------------------------------------------ */
/* DSH 的路径算法（必须逐字复刻，否则 DSH 会判会话损坏）                */
/* ------------------------------------------------------------------ */

/**
 * cwd → projectKey。
 * 规则来自 dsh-session-persistence-jsonl/lib/index.js:880-899：
 *   - 分隔符 / \ : 折叠成一个 '-'
 *   - [A-Za-z0-9._-] 原样保留（'~' 除外）
 *   - 其余码位转义成 ~XXXX（4 位大写十六进制）
 *   - 结果是 `--<readable>--`，readable 去掉开头的 '-'
 */
export function projectKey(cwd) {
  if (!cwd) return '_no-cwd'
  let readable = ''
  let separatorRun = false
  for (const ch of String(cwd)) {
    const code = ch.codePointAt(0)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * 路径片段转义（dsh-session-persistence-jsonl/lib/index.js:858-870）。
 * '.' → ~002E，'..' → ~002E~002E，'~' 与非安全字符 → ~XXXX。
 */
export function encodeSegment(raw) {
  const text = String(raw == null ? '' : raw)
  if (text === '.') return '~002E'
  if (text === '..') return '~002E~002E'
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (ch === '~' || !/^[A-Za-z0-9._-]$/.test(ch)) {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    } else {
      out += ch
    }
  }
  return out
}

/** 会话在本机的物理落点（相对 DSH_HOME）。 */
export function physicalRel(cwd, sessionId, fileName = SESSION_FILE_NAME) {
  return `sessions/${projectKey(cwd)}/${encodeSegment(sessionId)}/${fileName}`
}

/**
 * 会话在清单里的稳定 rel（与机器无关）。
 * 只用会话 id，不用本机路径 —— 这样两台机器的条目 id 才对得上。
 */
export function canonicalRel(sessionId, fileName = SESSION_FILE_NAME) {
  return `sessions/${sessionId}/${fileName}`
}

/* ------------------------------------------------------------------ */
/* 读写与规范化                                                        */
/* ------------------------------------------------------------------ */

export function isZstd(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC
}

/** 解压（.zstd）或直接读（.jsonl），返回 UTF-8 文本。 */
export function decodeSession(buf) {
  if (isZstd(buf)) return zstdDecompressSync(buf).toString('utf8')
  return buf.toString('utf8')
}

/** 编码回磁盘格式：压缩过就压回去，没压过就保持纯文本。 */
export function encodeSession(text, compressed) {
  const buf = Buffer.from(text, 'utf8')
  return compressed ? zstdCompressSync(buf) : buf
}

function splitHeader(text) {
  const idx = text.indexOf('\n')
  if (idx === -1) return { head: text, rest: '' }
  return { head: text.slice(0, idx), rest: text.slice(idx) }
}

/**
 * header 里 cwd 字段的正则。只认 `"cwd": "值"` 这种成对写法，
 * 避免误伤正文里的同名字符串。
 */
const CWD_FIELD_RE = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/g

/**
 * 在 header 里定点替换 cwd 的值，保持其余字节（键序、空白）完全不变。
 * 返回 null 表示没找到可替换的位置。
 */
function replaceCwdLiteral(head, expectedLiteral, toLiteral) {
  CWD_FIELD_RE.lastIndex = 0
  let match
  while ((match = CWD_FIELD_RE.exec(head)) !== null) {
    const literal = match[1]
    if (expectedLiteral && literal !== expectedLiteral) continue
    const at = match.index + match[0].length - literal.length
    return head.slice(0, at) + toLiteral + head.slice(at + literal.length)
  }
  return null
}

/**
 * 把 header 里的 cwd 换成占位符。
 * 只动 header 的 cwd 字段；会话正文里出现的绝对路径是聊天内容，不改。
 * 返回 { text, cwd, sessionId, ok }。ok=false 表示这不是可识别的会话文件。
 */
export function normalizeSessionText(text) {
  const { head, rest } = splitHeader(text)
  let header
  try {
    header = JSON.parse(head)
  } catch {
    return { text, cwd: '', sessionId: '', ok: false }
  }
  if (!header || typeof header !== 'object' || !header.id) {
    return { text, cwd: '', sessionId: '', ok: false }
  }
  const cwd = typeof header.cwd === 'string' ? header.cwd : ''
  let normalizedHead = head
  if (cwd) {
    // 定点替换，保留 header 里其余字节（键序、空白都不动）。
    const replaced = replaceCwdLiteral(head, JSON.stringify(cwd), JSON.stringify(CWD_PLACEHOLDER))
    if (replaced !== null) {
      normalizedHead = replaced
    } else {
      // 兜底：整个 header 重新序列化（键序保持不变）。
      header.cwd = CWD_PLACEHOLDER
      normalizedHead = JSON.stringify(header)
    }
  }
  return {
    text: normalizedHead + rest,
    cwd,
    sessionId: String(header.id),
    ok: true,
  }
}

/**
 * 把占位符换回本机实际目录。
 * 同样走定点替换 —— 字节保持一致，两台机器算出来的逻辑 sha 才对得上。
 */
export function materializeSessionText(normalizedText, localCwd) {
  const { head, rest } = splitHeader(normalizedText)
  let header
  try {
    header = JSON.parse(head)
  } catch {
    return normalizedText
  }
  if (!header || typeof header !== 'object' || header.cwd !== CWD_PLACEHOLDER) return normalizedText
  const replaced = replaceCwdLiteral(head, JSON.stringify(CWD_PLACEHOLDER), JSON.stringify(localCwd))
  if (replaced !== null) return replaced + rest
  header.cwd = localCwd
  return JSON.stringify(header) + rest
}

export function logicalSha(normalizedText) {
  return createHash('sha256').update(normalizedText, 'utf8').digest('hex')
}

/* ------------------------------------------------------------------ */
/* 文件级分析（带缓存）                                                */
/* ------------------------------------------------------------------ */

const analysisCache = new Map()

export function clearSessionCache() {
  analysisCache.clear()
}

/**
 * 读一个会话文件，得出它的逻辑 sha、cwd、会话 id。
 * 缓存键含 mtime 与大小，文件不变就不重复解压。
 */
export async function analyzeSessionFile(abs, size, mtimeMs) {
  const key = `${abs}:${mtimeMs}:${size}`
  const hit = analysisCache.get(key)
  if (hit) return hit
  let result
  try {
    const raw = await readFile(abs)
    const compressed = isZstd(raw)
    const text = decodeSession(raw)
    const norm = normalizeSessionText(text)
    const normalizedText = norm.ok ? norm.text : text
    const blob = encodeSession(normalizedText, compressed)
    result = {
      ok: norm.ok,
      cwd: norm.cwd,
      sessionId: norm.sessionId,
      project: projectKey(norm.cwd),
      logicalSha: logicalSha(normalizedText),
      normalizedText,
      blob,
      compressed,
      bytes: size,
      title: '',
      createdAt: 0,
    }
  } catch (err) {
    result = {
      ok: false,
      error: String((err && err.message) || err),
      cwd: '',
      sessionId: '',
      project: '',
      logicalSha: '',
      normalizedText: '',
      blob: null,
      compressed: false,
      bytes: size || 0,
      title: '',
      createdAt: 0,
    }
  }
  analysisCache.set(key, result)
  if (analysisCache.size > 2000) analysisCache.clear()
  return result
}

/**
 * 本机工作区的跨机身份：取目录名。
 * 与 workspaces.mjs 的 workspaceKey 同源（这里放一份是为了避免循环依赖）。
 */
export function cwdKey(cwd) {
  const raw = String(cwd || '').trim().replace(/[\\/]+$/, '')
  return basename(raw) || 'root'
}

/** 会话在 DSH_HOME 里的实际文件路径。 */
export function sessionFilePath(dshHome, cwd, sessionId, fileName = SESSION_FILE_NAME) {
  return join(dshHome, 'sessions', projectKey(cwd), encodeSegment(sessionId), fileName)
}

/**
 * 会话在清单里的稳定 id（与机器无关）。
 * 只用会话 id —— 两台机器上同一个会话，id 必须一致，否则认不出是同一个。
 */
export function sessionEntryId(sessionId) {
  return `sessions:${sessionId}`
}

/**
 * 把规范形态的 blob 还原成本机目录，并给出落盘用的逻辑 sha。
 *
 * 传入的 blob 里 cwd 可能是占位符（我们推送时存的就是这个），
 * 也可能是别的机器的真实目录（老版本推的）—— 两种都能处理：
 * 先归一化成占位符，再物化成本机目录，最后再归一化一次算 sha。
 * 这样得到的 sha 与远端条目里的 sha 一定是同一个值。
 */
export function materializeBlob(blob, localCwd, { compressed: forceCompressed } = {}) {
  const compressed = forceCompressed === undefined ? isZstd(blob) : Boolean(forceCompressed)
  const text = decodeSession(blob)
  const norm = normalizeSessionText(text)
  if (!norm.ok) return { blob, logicalSha: logicalSha(text), ok: false }
  const materialized = materializeSessionText(norm.text, localCwd)
  const reNorm = normalizeSessionText(materialized)
  const canonical = reNorm.ok ? reNorm.text : materialized
  return {
    blob: encodeSession(materialized, compressed),
    logicalSha: logicalSha(canonical),
    ok: true,
  }
}

/**
 * 找出本机所有存放该 session id 的位置。
 * DSH 不允许同一个 session id 出现在多个 project 目录
 * （dsh-session-persistence-jsonl:3462 "duplicate JSONL session id ... appears in
 * multiple project directories"），所以重写 cwd 时必须先把旧副本清掉。
 */
export async function findSessionCopies(sessionId) {
  const root = sessionsRoot()
  const out = []
  let projects = []
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = join(root, project.name, encodeSegment(sessionId))
    const file = join(dir, SESSION_FILE_NAME)
    const st = await stat(file).catch(() => null)
    if (st && st.isFile()) {
      out.push({ project: project.name, dir, file, bytes: st.size, mtimeMs: st.mtimeMs })
    }
  }
  return out
}

/** 删掉某个会话在本机的旧副本（保留 keepDir 那一份）。 */
export async function removeSessionCopies(sessionId, keepDir) {
  const copies = await findSessionCopies(sessionId)
  const removed = []
  for (const copy of copies) {
    if (keepDir && copy.dir === keepDir) continue
    await rm(copy.dir, { recursive: true, force: true }).catch(() => {})
    removed.push(copy.dir)
  }
  return removed
}

export { dirname }
