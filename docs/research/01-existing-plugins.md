# 01 · 本机三个同步类插件的真实机制

调研对象与版本（均为本机已装/残留）：

| 对象 | 位置 | 版本 | 状态 |
|---|---|---|---|
| dsh-github-sync | `~/.dsh/profiles/desktop/node_modules/dsh-github-sync` | 0.5.1 | 已装，源码全读 |
| dsh-config-manager | `~/.dsh/profiles/desktop/node_modules/dsh-config-manager` | 0.4.2 | 已装，`lib/**/*.d.ts` 契约面 + 关键 `.js` 全读 |
| dsh-session-sync | 包已卸载，仅配置残留 + README 副本 | 未知（README 适配 dsh 0.2.1-alpha.1） | 以 README 为准 |

结论先行：**github-sync 的会话同步语义（append-only 字节链 + 头帧重写 + body 前缀比较）是对的，config-manager 的分区元数据模型（section-registry）与传输/加密抽象是对的，session-sync 的 keep-both 冲突观与「配置即授权」自动模式值得吸收**；三者的 manifest、状态文件、hash 口径彼此不兼容，新插件应当合并成「一层 manifest + 两类分区语义」，而不是照抄任何一个。

---

## A. 会话同步：dsh-github-sync

### A1 会话枚举：读哪些路径

`lib/paths.mjs:1-16` 是全部磁盘约定的唯一入口：

```js
// lib/paths.mjs:1-16（节选）
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
export const sessionsRoot = () => path.join(dshHome(), 'sessions');
export const attachmentsRoot = () => path.join(dshHome(), 'attachments', 'v1');
export const workspaceJsonPath = () => path.join(dshHome(), 'storages', 'workspace.json');
export const projcacheRoot = () => path.join(dshHome(), 'storages', 'session_projcache', 'sessions');
export const pluginDataDir = () => path.join(dshHome(), 'github-sync');
```

- 会话文件：`<sessionsRoot>/<projectKey>/<sessionId>/session.v4.jsonl.zstd`（`lib/sessionlog.mjs:6-7`：`SESSION_FILE='session.v4.jsonl.zstd'`、`SUPPORTED_VERSION=4`）。
- 项目目录名不是 cwd 的明文，而是投影键，算法在 `lib/projectkey.mjs:1-17`（实测行为）：cwd 里连续的 `/ \ :` 折叠成单个 `-`；非 `[A-Za-z0-9._-]` 的每个码元转 `~XXXX`（4 位大写 hex）；两端各补 `--`；总长截断到 251。**这条算法必须照抄**，否则跨机找不到对方的项目目录。
- 目录解析有兜底：`lib/sessiondir.mjs:31-49` 先 `join(sessionsRoot(), projectKey(cwd))` 命中即用；不命中则扫 sessions 根，逐个读每个目录**第一个会话的头帧**取其中的绝对 cwd 做 `samePath()` 比较（大小写不敏感、分隔符归一），结果缓存。这样即使 DSH 换了键算法也不会错配。
- 标题读取三级降级（`lib/localsessions.mjs`）：优先 `storages/session_projcache/sessions/<id>.json` 的 `record.rows.title.val`（:14-24，比解日志快两个数量级）→ 退化为 `readTitleFast(buf, maxFrames=48)` 从最后一帧倒找 `session/title` 事件（:27-44）→ 再退化用 header 里的时间戳。
- 附件：内容寻址，`<attachmentsRoot>/objects/<sha 前 2 位>/<sha>`（`lib/attachments.mjs:28-30`）。

### A2 解帧：DSH 会话文件是多帧 zstd 拼接

关键事实：**一个 `session.v4.jsonl.zstd` 不是单个 zstd 流，而是多个独立帧顺序拼接**；Node 的 `zstdDecompressSync` 只解第一帧，所以必须自己按帧头走。`lib/zstdframe.mjs:1-40`：

```js
// lib/zstdframe.mjs:1-28（节选）
// zstd 多帧读写：DSH 会话文件是"多个独立 zstd 帧顺序拼接"，不是单个流。
// Node 的 zstdDecompressSync 只解第一帧，必须自己按帧头切分。
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
export function walkFrames(buf) {
  ...
  const fhd = buf[off + 4];
  const fcsFlag = fhd >> 6;            // Frame_Content_Size 宽度
  const single = (fhd >> 5) & 1;       // 无 Window_Descriptor
  const checksum = (fhd >> 2) & 1;
  const didFlag = fhd & 3;             // Dictionary_ID 0/1/2/4 字节
  let p = off + 5;
  if (!single) p += 1;                 // Window_Descriptor
  p += [0, 1, 2, 4][didFlag];
  p += fcsFlag === 0 ? (single ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
```

block 头解析（`lib/zstdframe.mjs:30-40`）：3 字节小端，`bit0=Last_Block / bit1-2=Block_Type(0 raw,1 RLE,2 compressed,3 保留) / bit3-23=Block_Size`，raw 与 compressed 都推进 `size`，RLE 只推进 1。

依赖面：只用 `node:zlib` 的 `zstdCompressSync/zstdDecompressSync`（Node ≥22.15 内置），**零第三方依赖**；`encodeFrames` 每段一帧重压、`encodeOne` 单帧，保证写出后仍是多帧拼接。

### A3 跨机改写：只重压头帧

`lib/sessionlog.mjs:58-76`：拉取时目标机 cwd 不同，需要改 header 的 `cwd`，但**只重压第一帧**，其余帧字节原样保留：

```js
// lib/sessionlog.mjs:62-75（节选）
  // 只改 cwd（插件里唯一会走的路）：只重写头帧，其余帧字节原样保留，
  // 这样跨机之后两边的 body 仍然是同一条 append-only 字节链。
  if (!newId && !titleSuffix) {
    if (!newCwd || newCwd === old.cwd) return { buffer: buf, header: old, frames: frames.length };
    const first = decodeFrame(buf, frames[0]).toString('utf8');
    ...
    h.cwd = newCwd;
    const head = encodeOne(JSON.stringify(h) + rest);
    const tail = frames.length > 1 ? buf.subarray(frames[1].offset) : Buffer.alloc(0);
    const out = Buffer.concat([head, tail]);
```

这是整个插件最重要的设计点：**body（头帧之后的全部字节）= 会话的唯一身份与比较对象**。`sessionBody()`（:122-125）切掉头帧，`bodySha256()`（:128-130）只算 body，`compareSessions()`（:138-147）只看 body 且判据是「短者是长者的前缀」：

```js
// lib/sessionlog.mjs:138-147
export function compareSessions(localBytes, remoteBytes) {
  const a = sessionBody(localBytes);
  const b = sessionBody(remoteBytes);
  if (a.equals(b)) return 'equal';
  const aShort = a.length <= b.length;
  const short = aShort ? a : b;
  const long = aShort ? b : a;
  if (long.subarray(0, short.length).equals(short)) return aShort ? 'remote-ahead' : 'local-ahead';
  return 'diverged';
}
```

推论：**会话同步不需要 mtime、不需要向量时钟、不需要三方合并**，前缀关系就够判定 ahead/behind/diverged；diverged 只是「同一会话被两台机各续写」，无法自动合并，只能 fork。

### A4 manifest：字段、版本、hash、去重

`lib/manifest.mjs:3-16`：`MANIFEST_PATH='manifest.json'`、`README_PATH='README.md'`、`SCHEMA=1`，结构只增不减：

```js
// lib/manifest.mjs:7-16
export function createManifest() {
  return {
    schema: SCHEMA,
    updatedAt: new Date().toISOString(),
    devices: {},     // deviceId -> {name, lastSeen}
    workspaces: {},  // 项目键 -> {cwd, name}
    sessions: {},    // sessionId -> 条目（见下）
    attachments: {}, // sha -> {path, mediaType, bytes}
  };
}
```

`sessions[id]` 条目的字段来自 `lib/sync.mjs:141-154`：`{id, path, project, originalCwd, title, createdAt, updatedAt, bytes, frames, sha256, bodyBytes, attachments[], uploadedBy, uploadedAt}`。注意 **`sha256` 是整文件 hash，`bodyBytes` 是 body 长度** —— 增量判定用后者 + 前缀，不用 mtime。

去重/增量三层（`lib/sync.mjs:43-194`）：

1. `state.lastSync[id].sha256 === 本地 sha256` → `skip`，零网络；
2. 否则先看 `prev.bodyBytes <= 本地 body.length` 且 `prev.sha256`/body 前缀关系成立 → 零网络判 `local-ahead`，直接上传；
3. 仍不确定才读远端 body 做 `compareSessions`：`equal→skip`、`local-ahead→upload`、`remote-ahead→blocked('远端更新，请先下载')`、`diverged→blocked`，除非该 id 在 `force` 集合里。

附件只在 `!manifest.attachments[sha]` 时上传（:129），单附件上限 `MAX_ATTACHMENT_BYTES = 25*1024*1024`（:21），远端路径 `${project}/attachments/${sha}.${ext}`，ext 由 8 种 mediaType 映射（`lib/attachments.mjs:9-18`）。manifest 与 `README.md` 与本次会话文件**进同一个提交**（`lib/sync.mjs:170-176`）。

README 是机器生成的投影：`renderReadme()`（`lib/manifest.mjs:135-180`）输出设备 × 项目 × 会话表，纯展示用，不参与判定。

### A5 远端布局与传输：GitHub REST + Git Data API，不用 git 命令

`lib/github.mjs` 全部走 REST：`API='https://api.github.com'`，用 `globalThis.fetch`（因此继承宿主代理 dispatcher），3 次重试、45s 超时、`Authorization: Bearer`、`X-GitHub-Api-Version: 2022-11-28`（:55-96）。`listFiles()` 用 `git/trees?recursive=1` 建 `path→{sha,size}` Map，`truncated` 直接抛错而不是静默截断（:126-138）。

原子提交 `commitBatch()`（:193-267）：空仓先用 Contents API 落一个种子文件 → 并发上传 blob（lane 数 `min(concurrency,6)`，单 blob 3 次重试）→ `createTree(base_tree)` → `createCommit` → `updateRef`/`createRef`。**一批文件 = 一个提交**，所以远端永远看不到半套 manifest；非快进（422/409）与网络错误**不重试**（:264-267），交给上层重新规划。

远端仓库结构（`lib/manifest.mjs:99-101` + `lib/sync.mjs:129`）：

```text
<project>/sessions/<sessionId>.jsonl.zstd
<project>/attachments/<sha>.<ext>
<project>/files/...          # 可选：工作区文件文本同步（enableFiles）
manifest.json
README.md
```

token 来源：**DSH credentials**，不是环境变量也不是仓库配置。`index.js:212-243`：`ctx.credentials.resolve('GITHUB_TOKEN')`，`sanitizeToken()` 要求 ≥20 字符且全可打印 ASCII（否则 fetch 会抛 ByteString 转换错误）。`/test` 路由强制 `info.private === true`（`index.js:601-606`），仓库必须私有 —— 这是隐私红线的落地。

### A6 状态文件与历史

`index.js:24-26`：`DATA_DIR=$DSH_HOME/github-sync`、`STATE_FILE=state.json`、`HISTORY_FILE=history.jsonl`。

`state.json`（`index.js:33-49`）：

```js
// index.js:33-49（结构，非原文全量）
{ deviceId: randomUUID(), deviceName: hostname(), repo, branch: 'main',
  enableFiles: false, skipPreview: false, excludes: [...],
  lastSync: { <sessionId>: { sha256, bodyBytes, at } },
  remoteCache: null,          // listFiles() 结果的缓存，省一次全树请求
  updatedAt }
```

`history.jsonl` 每行 `{at, ...entry}`，条目四种（`index.js`）：

| kind | 位置 | 字段 |
|---|---|---|
| upload | :696-703 | `project, commit, files, sessions[{id,title}], skippedFiles, device` |
| download | :952-959 | `targetCwd, files, sessions, failed, device` |
| delete-local | :821 | `id, cwd, freedAttachments, device` |
| delete-remote | :873-876 | `sessions, attachmentsDeleted, commit, device` |

保留策略：100 天，且**每天最多 prune 一次**（`index.js:70-96`）—— 避免每次写历史都重写整个文件。

### A7 冲突策略

| 场景 | 判定 | 动作 |
|---|---|---|
| body 相同 | `equal` | skip |
| 本地是远端前缀 | `local-ahead` | upload（force 不必要） |
| 远端是本地前缀 | `remote-ahead` | upload 被 blocked：先下载 |
| 双头分叉 | `diverged` | upload blocked；download 时 `fork` |

download 侧（`lib/sync.mjs:208-291`）动作枚举 `write|skip|blocked|fork`：先把远端 buf 的 header cwd 重写成目标机 cwd，再与本地比；`local-ahead` 默认 **skip（保留本地）**；`remote-ahead` 写盘；`diverged` 写 `fork` —— 本地文件不动，远端另存 `<id>.remote-fork-<stamp>-<device>.jsonl.zstd`。**没有任何路径会静默覆盖两侧都改过的会话**，与 session-sync 的 keep-both 是同一哲学。

删除没有墓碑传播：github-sync 的「删除」只删一侧（delete-local / delete-remote 显式动作），不像 config-manager 有 `deletedSessions` 墓碑。

### A8 并发保护（多机同时推）

**没有锁文件**。靠三件事：

1. `mergeRemoteManifest(fresh, ours)`（`lib/manifest.mjs:37-53`）：提交前重读远端 manifest，并集合并，`ours` 优先，`devices` 按 `lastSeen` 取新 —— 两台机同时推，谁后提交谁的 manifest 包含两边的条目。
2. Git Data API 的非快进语义：`updateRef` 在 base_tree 过期时返回 422/409，`commitBatch` 不重试，上层整轮重来（重读 manifest → 重规划 → 重提交）。
3. `lib/guard.mjs` 是**路径**守卫而非并发锁：`isSafeSegment` 只允许 `[A-Za-z0-9._-]`、拒绝 `.`/`..`（:7-14）、`isHex64`（:17-19）、`isInsideRoot/assertInsideRoot`（:22-35）。理由写在文件头（:2-3）：远端 manifest 来自 GitHub，被投毒可以塞 `../../`。落盘前还有 `safeRelPath`（`lib/sync.mjs:306-313`）拒绝对路径/盘符/`..`/空段/NUL；附件 sha 非 hex64 一律忽略（注释原文：「manifest 来自远端仓库，可能被篡改」）。

### A9 其余可复用件

- 工作区文件同步（可选 `enableFiles`）：`lib/folders.mjs:6-12` 硬阻断名单 `.env*`、`*.key|pem|pfx|p12|kdbx|keystore`、`id_rsa|ed25519|ecdsa`、`.npmrc`、`.netrc`；限额 `maxFileBytes=10MB, maxFiles=800, maxTotalBytes=120MB, maxDepth=12`（:14-19）。
- 附件 GC：`gcLocalAttachments()`（`index.js:304-337`）扫全部会话的引用集合，回收无引用对象；下载时先补附件再写会话（:385-427），写完 `assertInsideRoot(sessionsRoot(), file)` 才 `ws.attachSession(id)`。
- 工具面：3 个 `github_sync_status` / `github_sync_remote_list(project)` / `github_sync_transfer(direction, phase)`；transfer 是**两段式**，preview 返回 `previewToken`，execute 必须带同一个 token（`index.js:1132-1257`，`timeoutMs 240000`），预览计划只存内存 Map、10 分钟过期（:112-113）。
- 路由面：全部挂 `ctx.webServer.register({kind:'prefix', path:'/dsh-github-sync', handler})`（:1114-1115），16 个 `req.method === 'POST'` 分支 + 一组只读 GET（`/status` `/sessions` `/devices` `/diagnostics` `/history` `/workspaces` `/transfers` `/progress` `/remote` `/preview/last` `/folder/list`）。`publicPlan()`（:185-197）把 Buffer 与整份 manifest 剥掉再回浏览器。
- 客户端：手写 JS，`window.__ModuleLoader__.load({id, factory})`，`require('react')` 不打包（`client.js:13-15`）；注册两个槽位 —— 设置页主体 `slots.register({name:'main', key:PANEL_ID})`（:1231-1233）与侧栏入口 `slots.register({name:'sidebar.panellist', id:PANEL_ID, order:40})`（:1235-1237）；文案走 `ctx.locale.register(NS,{zh,en})` + `bind`（:1227-1229）；注册函数返回 dispose（:1239-1242）。

---

## B. 配置备份/恢复/同步：dsh-config-manager

### B1 分区模型：17 个 section 的单一事实源

`lib/schema/section-registry.js`（320 行）是全部导出/恢复/同步/UI 的唯一元数据源，`SECTION_DATA_VERSION=1`。每项字段：`id / displayName / group / payload{kind:namespaces|object|array|files|none, zipPath|filePrefix, key, extraArrayKeys} / dataVersion / applyOrder / riskTier / portability / syncOptIn / defaultIncluded / configSnapshot`。

| # | id | ZIP 内路径 | payload | portability | risk | syncOptIn | 默认包含 |
|---|---|---|---|---|---|---|---|
| 1 | settings | `config/settings.json` | namespaces | portable | low | off | 是 |
| 2 | ui | `config/ui.json` | namespaces | portable | low | off | 是 |
| 3 | providers | `ai/providers.json` | object(`providers`) | portable | med | off | 是 |
| 4 | plugins | `plugins/plugins.json` | array(`plugins`)+`patch` | portable | med | off | 是 |
| 5 | mcp | `mcp/servers.json` | array(`servers`) | platformSpecific | med | **auto** | 是 |
| 6 | prompts | `custom/prompts.json` | array | portable | low | off | 是 |
| 7 | skills | `custom/skills/` | files | portable | med | off | 是 |
| 8 | agentPresets | `agents/presets/` | files | portable | med | off | 是 |
| 9 | agentInstructions | `custom/agent-instructions/` | files | portable | low | off | 是 |
| 10 | workspaces | `workspaces/workspaces.json` | array | platformSpecific | med | off | 是 |
| 11 | pluginFiles | `plugin-files/` | files | portable | high | off | **否** |
| 12 | credentialsStatus | `security/credentials.json` | array(`credentials`) | deviceSpecific | high | off | 是 |
| 13 | secrets | —（无 adapter） | none | deviceSpecific | high | off | **否** |
| 14 | sessions | `sessions/` | files | deviceSpecific | high | **manual** | **否** |
| 15 | self | `self/` | files | portable | med | off | 是 |
| 16 | pluginData | `plugin-data/` | files | deviceSpecific | high | off | **否** |
| 17 | pluginAssets | `plugin-assets/` | files | portable | med | off | **否** |

派生视图由同一张表生成：`SECTION_IDS`（按 `applyOrder` 排序，决定恢复顺序）、`PORTABLE_SECTION_IDS`、`OPT_IN_SYNC_SECTION_IDS=['mcp','sessions']`、`AUTO_SYNC_OPT_IN_SECTION_IDS=['mcp']`、`DEFAULT_INCLUDED_SECTION_IDS`、`CONFIG_SNAPSHOT_SECTION_IDS`。注册表 :297-305 的注释把两条判断写死了：**sessions 是内容隐私 + 设备相关，永不自动同步；mcp 只是命令/路径可能不同，所以 auto**。

「secrets 为什么必须单独加密」在结构上就体现了：`payload.kind === 'none'`，它**没有 adapter、没有分区 JSON**，凭据值走独立容器（见 B4），导出时只生成 `security/secrets.enc`。

### B2 磁盘路径解析：JSON 类走门面，文件类走 baseDir

两类 adapter 的读法完全不同：

- **JSON 类（settings/ui/providers/plugins/mcp/prompts/workspaces/credentialsStatus）不直接读盘**，走宿主服务门面 + 注入的 `namespaces`：`lib/adapters/workspaces.js:3` 读 `~/.dsh/storages/workspace.json` 的 `tables.workspaces`，但经 `ctx.workspace` 门面；`lib/adapters/plugins.js:3-6` 清单来自 `ctx.plugins.listInstalled()` + profile 的 `cordis.patch.yml` 用户 patch 层；`lib/adapters/mcp.js:10` 写宿主 `$DSH_HOME/cordis.patch.yml` 与 profile `$DSH_HOME/profiles/<p>/cordis.patch.yml` **两层**；mcp 还有第二数据源 `storages/mcp_connector.json`（`lib/core/mcp-connector-store.js:22`，用 `lib/adapters/mcp.js:156`）。
- **文件类（skills/presets/instructions/sessions/pluginFiles/pluginData/pluginAssets/self）** 继承 `FileCollectionAdapter`：`abstract baseDir`（相对 `homeDir`）、`listRelPaths()` 决定枚举面（`lib/adapters/file-collection.d.ts`）。硬约束两条：单分区 `MAX_FILE_SECTION_BYTES = 256 MiB`（:8-23，理由是「避免导出成功却传不回来」+ 内存峰值）；`baseDir=''` 的分区（仓库根就是 home 的项目）**必须覆写 `listRelPaths`**，否则递归整个 home（注释给实测：4016 文件 / 242MB / 4.8s，:94-97）。
- 具体路径：`sessions` → `join(homeDir,'sessions')`（`index.js:714`、`lib/core/rollback-point.js:938`）；插件自有数据 → `join(homeDir,'dsh-config-manager')`（`index.js:715`）；会话标题/活跃时间 → `storages/session_projcache.json`（`lib/adapters/sessions.js:151`）。

对新插件的直接含义：**零依赖目标下不能假设一定有 `ctx.plugins`/`ctx.workspace` 门面**，必须「门面优先 + 直读 fallback」双路，而直读路径要自己维护一份（`settings/ui` 在 DSH 里并不总是独立 JSON 文件，config-manager 之所以走门面就是为了躲开这个不确定性）。

### B3 导出包：ZIP + 双清单

文件名 `dsh-config-${YYYY-MM-DD}.zip`（`lib/core/exporter.js:502`）。条目顺序（:374-458）：

```text
config/settings.json …            # 各 JSON 分区（pretty JSON）
custom/skills/** …                # 各文件分区
security/secrets.enc              # 可选，见 B4
integrity/checksums.json          # 覆盖除 manifest/checksums 外的全部条目
manifest.json                     # 最后写，视作提交点
```

`lib/schema/manifest.js:9-10`：`MANIFEST_FILE='manifest.json'`、`CHECKSUMS_FILE='integrity/checksums.json'`。`buildManifest()`（:13-32）：

```js
// lib/schema/manifest.js:13-32（结构）
{
  schemaVersion,                     // CURRENT_SCHEMA_VERSION = 1
  exporter: { name: 'DSH Config Manager', version },
  source: { dshVersion, platform, arch },
  exportedAt,
  sourceHome?,                        // 跨机 home 前缀重定基用（issue #45）
  foreign?,                           // 外部工具导入信息，只 warning
  sections: { [id]: boolean },        // 包含标记，不是内容
  security: { containsSecrets, encrypted, encryption|null }
}
```

版本轴有两条（`lib/schema/versions.js`）：`CURRENT_SCHEMA_VERSION=1` / `MIN_SUPPORTED_SCHEMA_VERSION=1` 管整包格式；`sectionDataVersion(sectionId)` 管每分区内容格式，必须**恰好相等**（不是「≥」）。`validateManifest`（:99-165）宽容得有意为之：未知 section 键只 warning、`foreign` 只 warning，绝不因为你导出过我没听说过的分区就拒包。

### B4 凭据：状态 ≠ 值，值只进加密容器

`lib/adapters/credentials.js`（138 行）：

- `defaultCredentialRefs(namespaces)`（:10-52）只收「引用类字段」——`apiKeyEnv / api_key_env / apiKeyName / tokenEnv / accessTokenEnv / refreshTokenEnv / clientSecretEnv / passwordEnv` 以及 `providers[].apiKeyEnv`。**它扫的是「指向凭据的名字」，不是凭据本身。**
- 导出条目（:64-90）恒为 `{ref, required:true, configured, source:'file', hasValue:false}` —— `hasValue` 永远 false，值永不进包。
- 恢复时值只来自两处（:109-118）：`ctx.secretInputs[ref]`（UI 当场输入）或 `ctx.decryptedCredentials.get(ref)`（用户输密码解出来的），再 `ctx.target.credentials.set(ref, value)`。
- 安全不变量写成校验（:129-133）：**任何条目 `hasValue === true` 即报 error**，把「以后有人手改包把值塞回来」变成结构性失败。

加密（`lib/security/encryption.js:1-38`）：scrypt KDF + AES-256-GCM，`SCRYPT_PARAMS={N:16384,r:8,p:1,keyLength:32}`，salt 16B、iv 12B、authTag 16B：

```text
secrets.enc  = magic "DSC1"(4) | version(1) | salt(16) | iv(12) | authTag(16) | ciphertext
整包加密容器 = magic "DCA1"   （ARCHIVE_MAGIC，isArchiveBlob() 探测）
错误码      = UNSUPPORTED_FORMAT | TAMPERED | BAD_PASSWORD
```

`validateKdfParams` 把 N 限制在 `[2^14, 2^20]` 防 DoS（:48-59）；**产品决策不做密码强度校验**（:68-69，理由是不给用户「假的安全感」）；`info` 只把算法/参数写进 `manifest.security.encryption`（:82-90），密钥从不落盘。

`includeSecrets=true` 而没注入 EncryptionProvider 时直接抛 `export.encryptionRequired`（`exporter.js:227-229`）——不允许「静默明文导出」。`includeSecrets=false` 时仍会生成 `secrets.enc` 但内容是**空占位加密**（:397-421）：包仍标记 encrypted（导入需要密码），但 `containsSecrets=false`。明文来源固定是 `path.join(homeDir,'.credentials.yaml')` 的原文（:401），**绝不通过 `ctx.credentials` 回读值**。

### B5 传输层：四通道 + 统一错误面

枚举唯一源 `lib/utils/shared-constants.js:53`：`SYNC_CHANNELS=['git','webdav','s3','gist']`；`:64` `S3_COMPAT_PROVIDERS=['s3','oss','cos','minio','kodo']`；`:74-84` 凭据槽位名 `DSH_CONFIG_MANAGER_SYNC_<PROVIDER>_SECRET_ACCESS_KEY`（gist 是 `..._GIST_TOKEN`）。

配置（`lib/sync/sync-config.d.ts`）刻意不含任何密钥：`GitConfig={repoUrl}`（:40-42，git 用系统 PATH）、`WebDavConfig={url,username?}`（:44-49，拒绝 userinfo，password 走 DSH credentials）、`S3ChannelConfig={provider,endpoint,region?,bucket,prefix?,accessKeyId,secretStored?}`（:244-263）、`GistChannelConfig={gistId,apiBaseUrl?,filePrefix?,secretStored?}`（:266-274）。回传 UI 的视图只带 `secretStored: boolean`（:320-338），密钥值只存在 DSH credentials 槽位。`SYNC_CONFIG_SCHEMA_VERSION=3` 的设计目标是**双命名空间共存**（:35-38）：切到 webdav 不丢 git 的 repoUrl，切回来不用重填。

传输接口（`lib/sync/transport.d.ts:112-129`，新插件可直接照抄签名）：

```ts
export interface SyncTransport {
  readonly type: string;
  list(): Promise<SyncSnapshotMeta[]>;                 // 按 createdAt 升序
  upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta>;
  download(id: string): Promise<SyncSnapshot>;         // 不存在必须抛错
  delete(id: string): Promise<void>;                   // 不存在视为成功
  probe?(): Promise<SyncProbeResult>;                  // 只读自检，唯一允许的写副作用是 webdav 建目录
}
```

配套两条纪律：`isPreconditionFailedStatus(status) = status === 412`（:4-6/109-111，**条件写失败绝不静默覆盖**）；`SyncTransportError{kind,retryable,status?,code?}` 的 `kind ∈ network|timeout|server|auth|notfound|conflict|client|protocol|unknown`（:130-139），`classifyHttpStatus` 把 429/5xx 判可重试、401/403→auth、404→notfound、409/423→conflict 不可重试（:213-218）；`withSyncRetry` 只许包幂等读（:199-206）。

git 通道的工程细节（`lib/sync/git/git-transport.d.ts`，332 行）值得整段继承：

- token **只从 provider 读，绝不拼进 URL / argv / 配置**；写 `os.tmpdir()` 下 0600 的临时 credential store 文件，命令结束立即删（`buildCredentialArgs`，:278-283）；push 前预检（`requirePushToken`，:266-271）。
- 用 `spawn` + **进程树 kill**（POSIX 进程组 SIGKILL，Windows `taskkill /T /F`），不用 `execFile` —— 后者 timeout 只杀 `git.exe`，孙进程 `git-remote-https`/`index-pack` 继续写 `tmp_pack_*`，上层永久挂起（issue #122）。
- 工作副本用可重入锁 `withWorkdir`：并发 `pull --ff-only` 会留下多行 FETCH_HEAD，报 `fatal: Cannot fast-forward to multiple branches` 并把插件打进 SAFE MODE（真机 incident 2026-10-23，:159-169）。
- 首连用 `--filter=blob:none --no-checkout` + `sparse-checkout set --cone`（现场 1.8GB 仓库 / 6MB 实际内容），老 git 不认识就回落全量（:171-181）。
- `probe()` 复用 `ls-remote`，不建工作副本；`checkIsPrivate()` 用「匿名 ls-remote 成功=公开 / 匿名失败 + 凭据成功=私有」判定（:143-158）。
- 远端布局：`snapshots/<id>/`（散文件 + `manifest.json`）、`snapshots-encrypted/<id>.json`（整包密文单文件）、`blobs/<sha256>`（内容寻址共享区）。`put` 幂等 ⇒ 未变的会话不重传（:303-314）。`gcBlobStore` 只在能读全所有引用时才删，任一引用读不出就整轮放弃（「宁可留垃圾不可删在用」）。

### B6 冲突：两套策略并存，别混为一谈

**① 导入（restore）策略**：`import.conflictStrategy ∈ {merge, replace, skipExisting}`，缺省 `merge`。落地在 `lib/import/conflict-decisions.js:13-16`：`skipExisting` → 条目改判 `kind:'Skip'`（文案 `import.conflictSkipExisting`）；`replace` → 直接覆盖；`merge` → 进三方合并。工具侧 schema 在 `lib/core/model-tools.js:393`，非法值兜底 `'merge'`（:244）；client 缺省 `conflictStrategy:"merge"`（`client.js:6779`）。

**② 同步（sync）三方合并**：`lib/sync/merge.d.ts`（纯函数，无副作用）。决策枚举与意图写在 :31-40：

```ts
export type MergeDecision = 'useRemote' | 'keepLocal' | 'merge' | 'skip';
//  'skip'      双侧相对祖先都未改 → 不写
//  'useRemote' 仅远端改 → 远端整分区胜出
//  'keepLocal' 仅本地改 → 本地整分区胜出
//  'merge'     双侧都改但精细合并成功（≠ useRemote，否则 UI 谎报数据来源）
//  'conflict'  双侧都改且无法安全合并 → merged=undefined，只有 conflicts
```

冲突成因 `MergeConflictReason = 'both-modified'|'modify-delete'|'delete-modify'|'no-ancestor'|'binary'|'too-large'|'overlap'|'array'|'format'|'section'`（:42）；冲突定位精确到叶子：JSON 分区用点号路径（`'namespaces.general.value.theme'`，整分区为 `'$'`），文件分区用 `relativePath`（:44-55）。

三条安全约束必须照抄：**数组绝不按索引合并**（双侧都改且不逐字相等 → `conflict`，reason `'array'`）；二进制/超大文件不做文本合并（`'binary'`/`'too-large'`）；`merged === undefined` 时绝不交付半成品。分区缺失**不等于删除**，不判删除冲突。

### B7 状态文件与「基线纪律」

`lib/sync/sync-state.d.ts`（107 行）：`SYNC_STATE_FILE='sync-state.json'`、`SYNC_STATE_SCHEMA_VERSION=3`。版本演进本身是一条教训（:6-11）：v1 没有祖先指针；v2 把「远端快照 id」和「本地祖先副本目录名」塞进同一个 `lastSnapshotId`（P0-7，混用会让三方合并去 load 一个已被 prune 的目录，整轮 auto sync 永久 failed）；v3 拆成 `lastSnapshotId`（只=远端）与 `ancestorId`（只=本地目录名）。

```ts
// lib/sync/sync-state.d.ts:39-83（结构）
{ schemaVersion, lastSyncAt,
  sections: { [id]: { hash, updatedAt } },
  transport?: { type, ref },
  lastSnapshotId: string, ancestorId?: string,
  sessionUnits?: string[], deletedSessions?: string[],
  deviceId?: string, deviceName?: string,
  pendingMerge?: { remoteSnapshotId, sections: SectionId[], since } }
```

- `hashSection(data)`（:84-90）：JSON 分区 = **键序规范化**序列化后 SHA-256；文件类分区 = 「相对路径 + 文件字节 sha256」的有序清单再 SHA-256（文件数组顺序无关，`contentHash` 字段不参与，以字节为准）。
- **基线纪律**（:20-37）：`pendingMerge` 非空时 `lastSnapshotId` **刻意不推进**，让远端最新快照下一轮仍被当作「比基线新」而重新合并、冲突重新出现，直到用户裁决。若冲突未裁决就推进基线，冲突内容会在下一轮静默消失。这是整个插件最值钱的一条经验。
- `resolveDeviceIdentity(dir, hostName)`（:96-105）：`deviceId` 首次生成 `randomUUID` 后持久化（换主机名不变），`deviceName` 缺省取主机名，取不到用兜底文案，绝不写空串；**只在首次生成时写盘**。
- 会话删除用墓碑：`sessionUnits`（上次推送实际带走的集合）与 `deletedSessions`（累积墓碑，上限见 `MAX_SESSION_TOMBSTONES`）。缺省/空数组 = **不做删除检测**，绝不把「没记录」当成「全删了」（:58-69）。

### B8 快照、保留与回滚

三套东西彼此独立，别混：

| 机制 | 目录/文件 | 规模约束 | 用途 |
|---|---|---|---|
| 远端快照 | `snapshots/<id>/`、`snapshots-encrypted/<id>.json` | `RetentionPolicy` 分层保留 | 跨机交换单位 |
| 本地祖先副本 | `<localSnapshotsDir>/<ancestorId>/`（密文时 `sections.encrypted.json`） | `DEFAULT_ANCESTOR_KEEP=10`（`lib/sync/ancestor.d.ts:4`） | 三方合并的祖先 |
| 回滚点 | `rollback-points/{index.json, objects/}` | `ROLLBACK_MAX_RECORDS=50`、每会话 20 | 本地「后悔药」 |

回滚点（`lib/core/rollback-point.d.ts`）：`ROLLBACK_SCHEMA_VERSION=2`、`ROLLBACK_POINTS_DIR_NAME='rollback-points'`、`ROLLBACK_LEDGER_NAME='index.json'`、`ROLLBACK_OBJECTS_DIR_NAME='objects'`（内容寻址对象仓）、`ROLLBACK_IGNORE_FILE_NAME='.dsh-rollback-ignore'`、捕获预算默认 30s（10s~120s 可调）、并发 16、`ROLLBACK_MAX_RECORDS=50`。它属于「会话内自动留点 + 一键回退」的另一条产品线，对新插件的价值只有一条：**同步前的自动备份点应当是独立于同步快照的东西**，别把两者揉成一个目录。

保留策略（`lib/sync/retention-policy.d.ts`）：`RetentionPolicy / DEFAULT_RETENTION_POLICY / RETENTION_LIMITS / selectRetentionKeepers / selectPruneCandidatesByPolicy / retentionPolicySummary`，分层（近期全留 + 远期稀疏）。

### B9 UI 结构（只给信息架构）

设置页注册（`lib/client.js:54081-54101`）：

```js
// lib/client.js:54081-54101（节选）
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section", id: "config-manager", order: 60,
  label: () => t("section.label"), locale: NS,
  inject: () => ({ api, syncApi, syncT, marketApi, marketT,
                   myConfigsApi, recoveryApi, recoveryT,
                   historyApi, historyT, incidentApi, uiT })
}, ConfigManagerSection));
```

一个 section 内部是多页（`client.js:50396-50449` 的 `switch (panel)`）：`home`（总览/快捷入口）、`library`（快照库，来源分 `snapshot | backup-file | remote-snapshot | market`，见 :50340-50354）、`sync`（通道配置 + 状态 + 历史，`SyncPanel`）、`environment`（环境/维护/诊断）。任务型视图以「打开任务」的方式叠加：`export / import / market / runs / history / about`，另有 `maintenance` 聚合 `recovery / rescue / rollback`（:50355-50390）。整体是「一个设置 section + 四页 + 七个任务视图」，所有 API 走 `ConfigManagerApi / SyncApi / MarketApi / MyConfigsApi / RecoveryApi / HistoryApi / IncidentApi` 七个客户端封装（:54046-54061），组件绝不直接 fetch。

对我们最有用的三条：① 一个设置 `section` 就够，别学它开七个；② 页面切换用 `switch(panel)` + 任务叠加，不用路由；③ 服务一律**惰取**（`ctx.get(name)`，:54117-54124），因为服务可能比本插件晚挂载 —— 这是 DSH 插件的真实约束，不是洁癖。

---

## C. dsh-session-sync（仅 README，包已卸载）

配置残留在 `~/.dsh/profiles/desktop/cordis.patch.yml:164-170`：`id: session-sync / name: dsh-session-sync / config: {remote: https://github.com/loveliveao/DeepSeekHarness-session.git, branch: main, autoPullOnStart: false, autoPushOnEnd: false}`。包本体在其 node_modules 里已不存在（只搜到 `dsh-github-sync`），本机也没有它的 `import` 报错 —— 说明当前配置只是**孤儿行**，不加载。

README（398 行）的定位一句话：「a dedicated git mirror of your session store」(:55-57)。与 github-sync 的根本差异：

| 维度 | dsh-session-sync | dsh-github-sync |
|---|---|---|
| 同步单位 | 整个 `$DSH_HOME/sessions` 目录 | 单会话文件 + 项目/附件，带 manifest 索引 |
| 冲突观 | append-only **keep-both**：本地保留、远端另存 fork，fork 永不删，git 永不 force-push/reset/rebase/switch | 同哲学但以 manifest 为索引，diverged 才 fork |
| 传输 | `git` 子进程 + 工作副本（真实 git 仓库） | GitHub REST/Git Data API，无工作副本 |
| 加密 | 可选 `backend:'encrypted'`，**age 外部二进制**，密文 `encrypted/**/*.age`，三方合并在本地明文上做 | 无（依赖私有仓库） |
| 权限 | `pull/push` 过确认门（`confirmVia: auto|userQuestions|approval`），无应答 fail closed；`status/diff/log` 只读不问 | 纯手动按钮 + 预览确认（`skipPreview` 可跳） |
| 自动 | `autoPullOnStart`、`autoPushOnTurnEnd`、`pullIntervalMinutes`(0~10080)，**配置即授权，不再重复确认** | 明确不做后台定时 |
| 会话文件处理 | 当**不透明字节**，从不解析（对 zstd 多帧完全无依赖） | 解帧、改头帧、按 body 前缀比较 |
| 元数据 | storage domain（deviceId/lastPull/lastPush/head/error）+ 仓库里 `device.txt` 归因 | `~/.dsh/github-sync/{state.json,history.jsonl}` |

值得吸收的四点（README 明写，非我推断）：

1. **keep-both 是全序而不是兜底**：删除/修改并存时「保留改后字节 + 尊重删除意图」（:231），fork 文件永不删。
2. **配置即授权**（:225）：自动模式由配置授权，不再每轮弹确认；手动 `pull/push` 才过门。这解决了 github-sync「必须人工点」与「想要自动」之间的取舍。
3. **降级必须吵**（:251）：`backend:'encrypted'` 但缺 age / recipient / identity 时回落明文，**并在 status/log 显式警告**，绝不假装加密。
4. **运行态文件不是可同步内容**（:263）：`session.lock`、`session.migration.*.tmp` 永不镜像；可同步载荷只有 `session.jsonl` 与 `session.v[1-9]*.jsonl[.zstd]`。这条比 github-sync 更谨慎。

不吸收的：age 外部二进制（多一个运行时依赖，且口令身份会在 TTY 上阻塞）；「整个 sessions 目录当仓库树」（没有索引就没有增量与跨机改名，1.8GB 仓库的教训在 config-manager 那边）。

---

## D. 融合建议（给 dsh-sync-hub）

### D1 保留 / 弃用

| 决定 | 做法 | 理由 |
|---|---|---|
| ✅ 保留 | zstd 多帧 `walkFrames` 自研 | 零依赖、Node≥22.15 内置；不自己切帧就只能拿到第一帧 |
| ✅ 保留 | 头帧重写 + body 前缀比较 | 会话跨机 cwd 必然不同；只有 body 稳定，才能判 ahead/behind 而不误判 diverged |
| ✅ 保留 | 分区元数据表（照 section-registry 但只留 4-6 项） | 一张表生成导出/恢复/同步/UI，改一处不漏一处 |
| ✅ 保留 | 凭据「只导 ref + configured，hasValue 恒 false」 | 隐私红线的结构性落地，不靠自觉 |
| ✅ 保留 | 独立加密容器 + 只把算法元信息写 manifest | 备份可加密而 manifest 仍可读，导入前就能提示「需要密码」 |
| ✅ 保留 | `isPathInside` 单一越界判定 + 保留前缀黑名单 | 远端数据不可信，`startsWith('..')` 曾三次误判（paths.js:61-70） |
| ✅ 保留 | 条件写失败（412/409）绝不覆盖 + 错误分类 kind | 多机并发必须失败得可解释 |
| ✅ 保留 | git：token 不落 argv/URL、临时 credential store、进程树 kill、workdir 锁 | 全是真机事故换来的 |
| ✅ 保留 | 基线纪律（冲突未裁决不推进） | 否则冲突下一轮静默消失 |
| ✅ 保留 | 内容寻址 blob（未变会话不重传）+ GC 只在引用可读全时删 | 会话是最大体量，重复传输是主要成本 |
| ✅ 保留 | deviceId 持久化（randomUUID，换主机名不变） | 多机历史/归因/墓碑都依赖它 |
| ✅ 保留 | 易变运行态字段剔除后再比 hash（self.js:43-52） | 否则每轮都「有变化」，同步永不收敛 |
| ⚠️ 有条件 | keep-both + fork；配置即授权的自动模式 | keep-both 保留；自动模式必须默认关、且 UI 明示 |
| ❌ 弃用 | GitHub REST 作为唯一传输 | 新插件产品基线是本地文件夹/Git/WebDAV，GitHub 降级为可选 provider |
| ❌ 弃用 | 17 分区 + 40+ 外部会话读取器 + 2.4MB client | 范围爆炸，首版只做 settings/sessions/prompts/skills/plugins/mcp |
| ❌ 弃用 | 完全依赖 `ctx.plugins`/`ctx.workspace` 门面读配置 | 门面缺失即失能；改成「门面优先 + 直读 fallback」 |
| ❌ 弃用 | rollback-points 那套事务回滚（50 条台账 + 对象仓 + 捕获预算） | 对新插件过重；「同步前自动本地快照 + 一键还原」够用 |
| ❌ 弃用 | age 外部二进制 | 与零依赖目标冲突；加密只做 scrypt+AES-GCM 内建 |
| ❌ 弃用 | 把整个 sessions 目录当仓库树 | 无索引 = 无增量、无跨机改名、仓库膨胀 |

### D2 manifest 草案（`manifest.json`，仓库根）

```jsonc
{
  "schema": 1,                       // 整包格式版本
  "updatedAt": "2026-11-06T12:00:00.000Z",
  "producer": { "name": "dsh-sync-hub", "version": "0.1.0", "dshVersion": "0.2.2-rc.1" },
  "devices":  { "<deviceId>": { "name": "DESKTOP-XXX", "lastSeen": "..." } },

  "sections": {                      // 与 section-registry 同构；kind 决定语义
    "settings": { "kind": "json", "path": "config/settings.json", "dataVersion": 1,
                  "sha256": "…", "bytes": 1234, "updatedAt": "…" },
    "skills":   { "kind": "files", "prefix": "custom/skills/", "count": 7,
                  "sha256": "…", "bytes": 54321 }        // sha256 = 路径+字节的有序清单 hash
  },

  "sessions": {                      // 会话分区专用索引（不塞进 sections）
    "<sessionId>": {
      "project": "<projectKey>", "originalCwd": "D:\\VibeCoding",
      "title": "…", "createdAt": "…", "updatedAt": "…",
      "path": "sessions/<projectKey>/<sessionId>.jsonl.zstd",
      "headSha256": "…",             // 头帧 hash（跨机 cwd 不同，仅诊断用）
      "bodySha256": "…",             // ★ 判定身份
      "bodyBytes": 88213,            // ★ 前缀比较的长度锚
      "attachments": ["<sha256>"], "uploadedBy": "<deviceId>", "uploadedAt": "…"
    }
  },

  "objects": { "<sha256>": { "bytes": 4096, "path": "blobs/<sha256>" } },  // 附件/大文件内容寻址
  "tombstones": { "sessions": ["<sessionId>"] },                          // 删除意图，随 manifest 传播
  "encrypted": null                                                       // 或 {alg:"scrypt-aes-256-gcm",N,r,p,salt,iv}
}
```

规则（都能从上面两份实现里找到出处）：

1. `sections[id].sha256` 是**内容指纹**，JSON 分区键序规范化后算，文件分区按「相对路径 + 文件字节 hash」有序清单算（`sync-state.d.ts:84-90`）。
2. `sessions[id].bodySha256` 是**会话身份**；`bodyBytes` 让「本地更长且前缀相同」可以零网络判 ahead（`lib/sync.mjs:79-109`）。
3. manifest 与本次数据**必须同一提交/同一批写入**（`lib/sync.mjs:170-176`）。
4. 合并远端 manifest 时做并集、本机优先、`devices` 按 lastSeen 取新（`lib/manifest.mjs:37-53`）。
5. 任何来自远端的 path 都要过 `isSafeSegment` + `isPathInside`（`lib/guard.mjs:7-35`、`lib/sync.mjs:306-313`）。

### D3 状态文件草案（`$DSH_HOME/sync-hub/state.json` + `history.jsonl`）

```jsonc
{
  "schema": 1,
  "deviceId": "uuid-v4", "deviceName": "DESKTOP-XXX",       // 首次生成后持久化
  "transport": { "kind": "git", "ref": "main" },           // kind: folder|git|webdav|s3
  "sections":  { "settings": { "hash": "…", "updatedAt": "…" } },
  "baseline":  { "snapshotId": "…", "ancestorId": "…" },   // 两者语义不同，不许混用
  "sessions":  { "<sessionId>": { "bodySha256": "…", "bodyBytes": 0, "uploadedAt": "…" } },
  "sessionUnits":   ["<sessionId>"],                       // 上次推送实际带走的集合（墓碑基数）
  "deletedSessions": ["<sessionId>"],
  "pendingMerge": null,                                    // 或 {snapshotId, sections[], since}
  "lastSyncAt": "…", "updatedAt": "…"
}
```

配套：`history.jsonl` 每行 `{at, kind: plan|push|pull|resolve|error, summary...}`，保留 100 天、每天最多 prune 一次（照 `github-sync/index.js:70-96`）。

### D4 传输层抽象（零依赖可实现的四个实现）

```ts
export type TransportKind = 'folder' | 'git' | 'webdav' | 's3';

export interface ProbeResult {
  ok: boolean;
  message: string;          // 可直接展示（中文）
  hint?: string;
  remoteSnapshotCount?: number;   // 读不到就省略，绝不猜 0
}

export interface SnapshotMeta { id: string; createdAt: string; sections: Record<string, string>; }

export interface Transport {
  readonly kind: TransportKind;
  probe(): Promise<ProbeResult>;                                  // 只读，零副作用
  list(): Promise<SnapshotMeta[]>;
  get(id: string): Promise<{ manifest: HubManifest; files: Map<string, Buffer> }>;
  put(manifest: HubManifest, files: Map<string, Buffer>,
      opts?: { ifNoneMatch?: string }): Promise<SnapshotMeta>;    // 412 必须抛，不许覆盖
  del(id: string): Promise<void>;                                 // 不存在视为成功
}

export type ErrKind = 'network' | 'timeout' | 'server' | 'auth'
                    | 'notfound' | 'conflict' | 'client' | 'protocol' | 'unknown';
export class TransportError extends Error {
  constructor(readonly kind: ErrKind, readonly retryable: boolean,
              message: string, readonly status?: number) { super(message); }
}
export declare function withRetry<T>(fn: () => Promise<T>,
  policy?: { attempts: number; baseDelayMs: number; maxDelayMs: number }): Promise<T>; // 只包幂等读
```

落地要点：`folder` = 本地同步目录（用户指定，支持 USB/网盘挂载）；`git` = `child_process.spawn`，凭据走临时 credential store，**进程树 kill**，`withWorkdir` 锁；`webdav` = `fetch` + `PUT`/`PROPFIND`/`MKCOL`，`If-None-Match: *` 拿 412；`s3`（可选）= SigV4 手写，不引 SDK。

### D5 会话同步与配置同步能否共用一套 manifest？

**能共用外层容器，不能共用分区语义。** 结论分三层：

1. **共用**：manifest 外壳（`schema/producer/devices/sections/objects/tombstones/encrypted`）、`Transport` 接口、状态文件的 `deviceId/transport/baseline/history`、以及「同一提交写数据 + manifest」的原子性要求。二者都只是「一批相对路径 → 一份索引」，没必要两套。
2. **分语义**：`sections` 下的 config 分区走**三方合并**（需要 `ancestorId` + `pendingMerge` + `hashSection`），`sessions` 分区走**append-only 前缀比较**（需要 `bodySha256/bodyBytes` + fork）。理由有三条，都是硬的：
   - 会话是多帧 zstd 的追加式字节链，任何「文本行级合并」都会产出无法解帧的文件（`sessionlog.mjs:62-63` 的注释就是这个意思）；
   - 会话没有 ancestor 概念也能判胜负（前缀全序），引入三方合并只会制造假冲突；
   - 二者的变化检测成本不同：config 分区必须剔除易变运行态字段才收敛（`self.js:43-52`），会话根本不需要 mtime。
3. **实现建议**：`sections[id].kind` 二分（`'json' | 'files'`）不够，加一个 `sectionClass: 'config' | 'session'`，同步引擎按 `sectionClass` 分派到 `mergeThreeWay()` 或 `compareSessionBodies()`。UI 上仍是两个开关（配置同步 / 会话同步），但只有一个传输通道、一个状态文件、一份历史 —— 这正是 dsh-sync-hub 相对三个前作的产品价值。

---

## E. 未解项与证据缺口

- `dsh-session-sync` 的**源码不存在**（包已卸载），C 节全部由 README 副本 `D:\VibeCoding\scratch\readme-dsh-session-sync.md` 得出；其配置行仍在 `cordis.patch.yml:164-170` 但没有模块加载，属无害残留。
- config-manager 的 `lib/core/analyzer.js`（76KB）、`lib/core/rollback-point.js`（279KB）、`lib/routes/*.js`（合计 300KB+）、`lib/ui/*.js`（i18n 71KB 等）**只读了 `.d.ts` 导出面**，未逐行读实现；B8 的语义以契约注释为准，可能与实现细节有出入。
- config-manager 的 `lib/security/secret-scanner.js`（25KB）与 `redaction.js`（9.8KB）只知存在与用途（导出前扫描明文凭据并打码），未读实现；新插件若要做「导出前泄漏扫描」需另开一轮。
- github-sync 的 `README.en/TUTORIAL/CHANGELOG/PUBLISHING` 与 `locale/*.json` 未读（对本报告结论无影响）。
- 两条待实测：① DSH 0.2.2-rc.1 的 `settings/ui` 到底落在哪个文件（config-manager 走门面绕开了，零依赖直读需要验证）；② `node:zlib` 的 zstd 在本机 Node 24.21.0 上 `zstdCompressSync` 的默认 level 与 DSH 自身写出的帧参数是否一致（不一致不影响正确性，只影响体积）。
