# DSH 插件规范提要：服务端 + Web UI 可抄骨架

> 取证环境：desktop **0.2.2-rc.1** / node **24.21.0** / profile **desktop**，日期 2026-11-06。
> 每条结论后附来源：`文件名:行号`（取自本机安装包实测）或文档路径（KB）。
> KB 根：`C:/Users/HUAWEI/.dsh/profiles/desktop/node_modules/dsh-plugin-dev-kb/kb`。

## 0. 先看结论（TL;DR）

| 事项 | 结论 | 证据 |
|---|---|---|
| 入口形态 | 具名导出 `name` / `inject` / `apply(ctx, config)`，**不要加 default 导出** | `dsh-github-sync/index.js:18,20,211`；`extra/defensive-patterns/package-surface.zh.md` |
| 客户端入口 | `client.js` 必须自包一层 `window.__ModuleLoader__.load({id, factory})` | `dsh-github-sync/client.js:13-15` |
| 设置页 | `ctx.slots.inject('settings.section', () => ctx.slots.register({...}, Comp))` | `dsh-config-manager/lib/client.js:54081` |
| 侧边栏 | `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({name,id,order,label}, IconFn))` | `dsh-github-sync/client.js:1240` |
| 工具 | `ctx.tools.register({name,description,parameters,output,execute})`，返回 disposer | `index.js:1132-1158` |
| HTTP 路由 | `ctx.webServer.register({kind:'prefix', path, handler})`，返回 disposer | `index.js:1114`；webserver `lib/index.js:375` |
| 版本探测 | 读 `resources/app.asar/dsh/package.json` 的 `version`（**没有** env / API） | 实测，见 §4 |
| 配置持久化 | 零依赖插件自管 `$DSH_HOME/<id>/state.json`（github-sync 实证） | `lib/paths.mjs`；`index.js:2-3` 注释 |
| 依赖红线 | 本地 `file:`/link 安装解析不到 asar 内 `@deepseek-ai/*` → 按零依赖写 | `index.js:1-3` 注释 |

**最大的坑**：本地安装的插件是符号链接，`import '@deepseek-ai/dsh-tools'` 之类**会 MODULE_NOT_FOUND**（实测 plain node 从 profile 目录解析 `@deepseek-ai/dsh`/`-home-paths`/`-tools` 全部失败）。零依赖、只用 `node:*` 是唯一稳妥解。

---

## 1. 工程结构

```
dsh-sync-hub/
├── package.json          # 包的唯一登记处（dsh.bundle + dsh.client）
├── cordis.patch.yml      # 把本包插入 profile 层级栈
├── index.js              # 宿主半边（Node，服务端）
├── client.js             # 浏览器半边（Web UI）
├── icon.svg              # 插件页图标（icon 字段指向它）
├── lib/                  # 可选：纯 Node ESM 子模块（*.mjs）
│   ├── paths.mjs
│   └── store.mjs
├── locale/
│   ├── zh.json
│   └── en.json
└── README.md
```

### 1.1 `package.json`（可直接抄）

```json
{
  "name": "dsh-sync-hub",
  "version": "0.1.0",
  "description": "配置与会话跨机同步：盘点 / 打包 / 推送 / 拉取（DSH 插件）",
  "type": "module",
  "main": "./index.js",
  "icon": "./icon.svg",
  "license": "MIT",
  "keywords": ["dsh", "dsh-plugin", "cordis", "sync"],
  "engines": { "node": ">=22.0.0", "dsh": ">=0.2.2-rc.1 <0.3.0" },
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "files": [
    "index.js", "client.js", "cordis.patch.yml", "icon.svg",
    "lib/*.mjs", "locale/*.json", "README.md"
  ],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-layout"
      ]
    }
  }
}
```

字段语义（全部来自实装，不是推测）：

| 字段 | 作用 | 来源 |
|---|---|---|
| `type: "module"` | 主入口按 ESM 解析；index.js 用 `import` | `dsh-github-sync/package.json` |
| `exports["."]` / `["./client"]` | 浏览器半侧只在 `./client` 收；与 `dsh.client` 配对 | `site/reference/subsystems/client-modules.md` |
| `dsh.bundle.patch` | 声明这是**组合包**；无此字段仍可安装但不激活层（打警告） | `site/develop/basic/publish.md` |
| `dsh.client.platform` | `"web"` 才进 Web 插件表；`inject` 是加载顺序边（不是 npm 依赖） | 同上；`dsh-config-manager/package.json` |
| `engines.dsh` | 版本闸门：安装与启动都拒绝不满足范围的包 | `publish.md` |
| `icon` | 插件列表/详情页图标，`./icon.svg` | `package.json`（两包皆有） |
| `files` | 白名单；漏了 `lib/`，`files: ["*"]` 不会自动带上 `lib/*.mjs` | 实装 `files` 数组 |

> 规范说 `exports` 的标准键集合是 `.` / `./package.json` / `./src/*` / `./client` / `./types` / `./typert` / `./remote` / `./locale/*.json` / `./cordis.patch.yml`（`extra/defensive-patterns/package-surface.zh.md`）；实装只用了其中 4 个。**建议**：只用你真正提供的键，多导出一个没有文件的键会让 Node 解析报错。

### 1.2 `cordis.patch.yml`

最小形态（`dsh-github-sync/cordis.patch.yml` 全文 4 行）：

```yaml
# dsh bundle patch：把本插件插入 profile 的层级栈
- insert:
    - id: dsh-sync-hub
      name: 'dsh-sync-hub'
```

带配置 + 可停用（`disabled` 是 Loader 真实的行选项，布尔或 `!!js` 表达式）：

```yaml
- insert:
    - id: dsh-sync-hub
      name: 'dsh-sync-hub'
      disabled: false
      config:
        autoPullOnBoot: false
        transport: 'folder'
        remoteDir: ''
```

证据：`@deepseek-ai/cordis-plugin-loader/lib/index.js:462-477`（`get disabled()` / `_resolveDisabled`，支持 `!!js` 表达式）、`:781`（停用时写 `entry.options.disabled = true`）。

**注意**：`insert` 行的 `name` 必须是**包名**（Node 才能解析），`id` 才是行标识；两者可以同名。层序与覆盖语义见 `publish.md:125-137`——后应用的层按行胜出，且 **patch 替换整个 `config` 值而非深合并**。

---

## 2. 服务端入口 `index.js`

### 2.1 最小可用形态（零依赖）

```js
// dsh-sync-hub · 宿主半边：只依赖 Node 内置。
export const name = 'dsh-sync-hub'
export const inject = ['webServer', 'tools']

export function apply(ctx, config = {}) {
  const disposers = []
  ctx.effect(() => {
    // 同步初始化（读 state.json 等），返回清理函数
    return () => { /* 停表、关句柄 */ }
  }, 'dsh-sync-hub: init')

  // …注册路由与工具（见 §6 / §8），把 disposer 收进 disposers
  return () => { for (const off of disposers.splice(0)) try { off() } catch {} }
}
```

`inject` 是**服务依赖声明**：数组里每个键对应 `ctx.<key>`，Cordis 保证它们就绪后才 apply；缺失则该插件不激活（而不是崩溃）。实装：`dsh-github-sync/index.js:20` 声明 `['webServer','credentials','workspaceRegistry','tools']`。

`ctx.effect(fn, label)` 是唯一正确的资源归属：`fn` 立即执行，返回的清理函数在插件卸载/配置热替换时调用。`ctx.tools.register` / `ctx.webServer.register` 自己返回 disposer，包在 `ctx.effect` 里也行（实装两种都用：路由包 effect，工具收进数组手动释放，`index.js:1259-1262`）。

### 2.2 `Config`：规范 vs 实装的真实冲突

**规范**（`site/develop/basic/config.md`）：必须同时导出 `interface Config` 与同名 schemastery schema，普通对象不满足 Standards Schema 接口，会被 Loader 拒绝：

```ts
import Schema from '@deepseek-ai/schemastery'
export interface Config { autoPullOnBoot: boolean; transport: 'folder' | 'git' }
export const Config: Schema<Config> = Schema.object({
  autoPullOnBoot: Schema.boolean().default(false),
  transport: Schema.union(['folder', 'git']).default('folder'),
})
```

**实装**（`dsh-github-sync/index.js:1-3` 原文注释）：

> 只依赖 Node 内置。配置存在自己的状态文件里（`$DSH_HOME/github-sync/state.json`），不声明 Config——本地安装是符号链接，解析不到 asar 内的 `@deepseek-ai/*` 包。

两份实装的分歧正好说明了取舍：

- `dsh-github-sync`：**不声明 Config**，`apply(ctx, config = {})` 照样收到 cordis.yml 里写的 config（无 schema 即不校验），状态自己落盘。
- `dsh-config-manager`：把 `@deepseek-ai/dsh-settings`、`-home-paths`、`-tools` 全写成 **optional peerDependencies**，运行时从宿主解析；`lib/index.js:45-46` 直接 `import * as dshSettings from '@deepseek-ai/dsh-settings'`。

**建议（本插件）**：走 github-sync 路线——零依赖、无 Config、自管 state.json。理由：本地 `file:` 安装时 `@deepseek-ai/*` 解析不到（实测 MODULE_NOT_FOUND），而 Config 一旦声明又解析不到 schemastery，插件会**直接加载失败**，比“少一个配置项”严重得多。

> 补充实测：`desktop` profile 的 `node_modules/@deepseek-ai/` 下只 hoist 了 `schemastery@3.18.5` 与 `cosmokit`，因此 `import Schema from '@deepseek-ai/schemastery'` **在这个 profile 里**恰好可用；但这是 pnpm hoist 的偶然结果，换 profile 即失效，不要依赖。

### 2.3 注册服务（`ctx.provide` / Service）

规范写法（`site/develop/basic/index.md`）：类形态，`class MyService extends Service` + `super(ctx, 'myService')`，其他插件 `inject: ['myService']` 后 `ctx.myService`。

零依赖插件**不要**这么做（`Service` 来自 `@deepseek-ai/cordis`）。用模块级单例 + 工具/路由暴露能力即可；插件内部跨模块共享状态用 `lib/state.mjs` 的模块级对象：

```js
// lib/runtime.mjs —— 进程内单例，apply 时装配
export const runtime = { bus: null }
export function install(hub) { runtime.bus = hub; return () => { runtime.bus = null } }
```

客户端侧惰取服务的写法（宿主环境里存在 `ctx.get`）：`dsh-config-manager/lib/client.js:54117`：

```js
const readService = (key) => {
  const get = ctx.get
  return typeof get === 'function' ? get.call(ctx, key) : void 0
}
```

---

## 3. 读写本机文件：路径与 Node API

**Node 内置全可用**，无沙箱裁剪（`dsh-github-sync/index.js:4-9` 直接 import `node:fs` / `node:os` / `node:path` / `node:crypto`；`dsh-config-manager/lib/index.js:37-44` 还用了 `node:child_process`、`node:util`）。

### 3.1 不要硬编码 `~/.dsh`

首选 `@deepseek-ai/dsh-home-paths`（若你能解析它）：

```js
import { resolveDshHome, dshHomePath } from '@deepseek-ai/dsh-home-paths'
const home = resolveDshHome()          // 显式参数 > $DSH_HOME > ~/.dsh
const statePath = dshHomePath('sync-hub', 'state.json')
const cache = dshHomePath('cache', 'sync-hub')
```

它的完整导出（asar `@deepseek-ai/dsh-home-paths/lib/index.js`，无 `.d.ts`）：`resolveDshHome(configured?, env?)`、`dshHomePath(...segs)`、`dshCachePath(optionsOrSegment?, ...segs)`、`resolveAgentsHome`、`dshHomeDisplay`、`agentsHomeDisplay`、`expandHomePath`、`canonicalizeWatchPath`、`defaultDshHome`、`defaultAgentsHome`，常量 `DSH_HOME_ENV='DSH_HOME'`、`AGENTS_HOME_ENV='DSH_AGENTS_HOME'`。**没有版本 API**。

零依赖等价实现（github-sync 现成 16 行，`lib/paths.mjs`，照抄即可）：

```js
import { homedir } from 'node:os'
import { join } from 'node:path'

export function dshHome() {
  const v = process.env.DSH_HOME
  return v && v.trim() ? v : join(homedir(), '.dsh')
}
export const sessionsRoot = () => join(dshHome(), 'storages', 'sessions')
export const workspaceJsonPath = () => join(dshHome(), 'storages', 'workspace.json')
export const pluginDataDir = () => join(dshHome(), 'sync-hub')   // 自己独占的目录
```

### 3.2 profile 目录

实测环境变量（宿主进程注入，可直接读）：

```
DSH_HOME=C:\Users\HUAWEI\.dsh
DSH_PROFILE=desktop
DSH_PROFILE_DIR=C:\Users\HUAWEI\.dsh\profiles\desktop
DSH_SESSION_ID=<uuid>
DSH_WEB_URL=http://127.0.0.1:40067
```

`DSH_PROFILE_DIR/package.json` 里有 `dsh.profile.bundles` 数组（实测 21 个包）——盘点“装了哪些插件”读它，别去扫 `node_modules`。

### 3.3 常用落点

| 用途 | 路径 | 证据 |
|---|---|---|
| 插件私有状态 | `$DSH_HOME/<plugin-id>/state.json` | `lib/paths.mjs` `pluginDataDir()` |
| 全局 patch 层 | `$DSH_HOME/cordis.patch.yml` | `publish.md:125-137` |
| 凭据 | `$DSH_HOME/.credentials.yaml` | `extra/upgrade-guide/v0.2.1-alpha.2/stored-credentials-precedence` |
| 工作区注册表 | `$DSH_HOME/storages/workspace.json` | `lib/paths.mjs` |
| 会话日志 | `$DSH_HOME/storages/sessions/**` | `lib/paths.mjs` `sessionsRoot()` |
| 会话选择偏好 | profile 的 `cordis.patch.yml`（`locale.preference` 同款） | `dsh-client-locale/README.zh.md` |

---

## 4. 版本探测（本机实测结论）

| 方案 | 结果 | 说明 |
|---|---|---|
| `process.env.DSH_VERSION` | ❌ 不存在 | 实测枚举 `DSH*` 只有 HOME/PROFILE/PROFILE_DIR/SESSION_ID/SHELL/WEB_URL |
| `ctx.<something>.version` | ❌ 无此 API | `home-paths` 明确无版本 API；KB 未记载任何 ctx 版本面 |
| `createRequire(...).resolve('@deepseek-ai/dsh/package.json')` | ❌ MODULE_NOT_FOUND（plain node） | 宿主内可能被解析钩子救回，但**不可依赖** |
| `$DSH_HOME` 下版本文件 | ❌ 不存在 | 实测 home 根只有 `.anonymous-user-id`、`.credentials.yaml`、日志 |
| **`resources/app.asar/dsh/package.json` 的 `version`** | ✅ **0.2.2-rc.1** | 实测可读；该文件 `name` 是 `@deepseek-ai/dsh-desktop-runtime` |

推荐实现（多级回退，全部 try/catch，失败返回 `null` 而不是抛）：

```js
// lib/version.mjs —— 只依赖 node:fs / node:path
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

export function detectDshVersion() {
  // 1) Electron 打包态：<install>/resources/app.asar/dsh/package.json
  const res = process.resourcesPath
  if (res) {
    const v = readJson(join(res, 'app.asar', 'dsh', 'package.json'))?.version
    if (v) return v
  }
  // 2) 兼容 dev / 解包布局：<install>/dsh/package.json
  for (const rel of ['dsh/package.json', '../dsh/package.json']) {
    try {
      const v = readJson(join(process.execPath, '..', '..', 'resources', rel))?.version
      if (v) return v
    } catch {}
  }
  // 3) 宿主解析钩子在场时最省事的一条（失败即跳过）
  try {
    const req = createRequire(import.meta.url)
    const v = readJson(req.resolve('@deepseek-ai/dsh/package.json'))?.version
    if (v) return v
  } catch {}
  return null
}
```

（`createRequire` 从 `node:module` 导入；把它写进第 3 条之前先 `try`。）

**用法**：manifest 里落 `dshVersion: detectDshVersion() ?? 'unknown'`，跨机对比时只做“相同/不同”提示，不要拿它做严格 semver 闸门——闸门交给 `engines.dsh`。

---

## 5. 设置与配置持久化

三条路，按“零依赖优先级”排序：

| 方案 | 写入位置 | 代价 | 适用 |
|---|---|---|---|
| **A. 自管 state.json**（推荐） | `$DSH_HOME/<id>/state.json` | 自己写 schema、自己校验 | 零依赖插件，全部业务配置 |
| B. cordis `config:` + schemastery | profile 的 `cordis.patch.yml` 行 `config:` | 需要 `@deepseek-ai/schemastery` | 部署期参数（端口、路径） |
| C. `ctx.settings` 表单投影 | 同上（写回 patch 层） | 需要 Settings 服务 + `.volatile()` 字段 | 想白拿一个自动生成的设置表单 |

B/C 的机制（`dsh-settings/README.zh.md` 原文要点）：表单只展示 **`.volatile()`** 字段；写入**通过当前 profile 的 Cordis patch 持久化**；带修订号，过期写入被拒；秘密字段不下发客户端，只给存在性标记；自带页面的插件在 `apply` 里用子级注册策略：

```js
ctx.inject(['settings'], (sctx) => {
  sctx.settings.configure({ auto: false }, sctx.fiber)   // 关掉自动生成表单，我自己画
})
```

A 方案的完整读写（`node:fs` 同步写 + 原子替换，避免半截文件）：

```js
// lib/store.mjs
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './paths.mjs'

const DEFAULTS = { transport: 'folder', remoteDir: '', autoPullOnBoot: false, lastRunAt: null }

export function statePath() { return join(dshHome(), 'sync-hub', 'state.json') }

export function readState() {
  const p = statePath()
  if (!existsSync(p)) return { ...DEFAULTS }
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(p, 'utf8')) } }
  catch { return { ...DEFAULTS } }
}

export function writeState(next) {
  const p = statePath()
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, p)                       // 原子替换
  return next
}
```

设置页（客户端）读它 → `GET /dsh-sync-hub/state`；保存 → `POST /dsh-sync-hub/state`（见 §6/§7）。

---

## 6. HTTP 路由（后端接口）

服务：`@deepseek-ai/dsh-host-webserver` → `ctx.webServer`（`inject` 里写 `'webServer'`）。

### 6.1 签名（实装源码）

```js
// @deepseek-ai/dsh-host-webserver/lib/index.js:375-382
register(route) {                                   // route = { kind, path, handler } 或 { kind, path, resource }
  const table = route.kind === 'exact' ? this.exact : this.prefixes
  if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
  table.set(route.path, route)
  return () => { table.delete(route.path) }         // disposer
}
```

- `kind`：`'exact'` | `'prefix'`。
- 前缀匹配语义（`lib/index.js:580-585`）：`pathname === prefix || pathname.startsWith(prefix + '/')`——所以 `/dsh-sync-hubx` **不会**命中 `/dsh-sync-hub`。
- `handler(req, res)` 直接拥有整个响应生命周期（`lib/index.js:471`：`await responder.handler(req, res)`），用 Node 原生 `res.writeHead(...)/res.end(...)`。
- `resource(request, peer)` 是 Fetch 形态，但**只有 GET/HEAD** 会到达（其他方法 405 且不读 body，`lib/index.js:599-601`）——要收 POST 就用 handler。
- handler 抛错 → 客户端收到 **400**（不是 500），并记 warning，不会退出进程（README「失败时的行为」）。
- 其他可用成员：`ctx.webServer.port`（`:342`）、`ctx.webServer.protocol`（`:354`，`'http:'`/`'https:'`）、`ctx.webServer.getOrigin()`（`:363`，`http://127.0.0.1:3080` 形态）。

### 6.2 最小可用路由（可直接抄）

```js
const PREFIX = '/dsh-sync-hub'                       // 必须与 client.js 里的 PREFIX 一致

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function readJsonBody(req, limit = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Error('body too large')
    chunks.push(c)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function registerRoutes(ctx, hub) {
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const path = url.pathname.slice(PREFIX.length) || '/'

      if (req.method === 'GET' && path === '/state')  return sendJson(res, 200, hub.readState())
      if (req.method === 'POST' && path === '/state') {
        const body = await readJsonBody(req)
        return sendJson(res, 200, hub.writeState({ ...hub.readState(), ...body }))
      }
      if (req.method === 'GET' && path === '/status') return sendJson(res, 200, await hub.status())

      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    } catch (error) {
      sendJson(res, 400, { error: String(error?.message ?? error) })
    }
  }
  return ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }),
    'dsh-sync-hub: routes',
  )
}
```

**认证**：webserver 不做鉴权，路由对任何能访问监听地址的人开放（默认 `127.0.0.1`）。客户端是同源 `fetch`，天然带 cookie，**不要**自己发明 token。要更严就校验 `Origin`/`Host`（README 提示：按运输层制定请求策略时读 `ctx.webServer.protocol`，别信转发头）。

---

## 7. 客户端 UI（`client.js`）

### 7.1 导出形状：必须自己包 `__ModuleLoader__`

规范说的「客户端入口不导出实现值」，实装长这样（`dsh-github-sync/client.js:13-15`，`dsh-config-manager/lib/client.js:1-5` 同一形态）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-sync-hub',                    // 必须等于包名
  factory(require) {
    const React = require('react')       // 只 guarantee react / react-dom / react/jsx-runtime / ui-primitives
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    function Panel(props) { /* … */ }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 注册字典 + 面板（见下）
        return () => { /* 释放 */ }
      },
    }
  },
})
```

`require` 里能拿到什么（实测：`dsh-config-manager/lib/client.js:17110` 与全文件 require 清单）：

- `react`、`react-dom`、`react/jsx-runtime` ✅
- `@deepseek-ai/dsh-client-ui-primitives` ✅（但有版本风险，见 §7.6）
- 其他 `@deepseek-ai/*`：**不要假设**（旧宿主没有这张模块表，顶层 require 会把整个浏览器半侧打挂）

### 7.2 设置页（settings.section）

```js
const NS = 'dsh-sync-hub'

function SyncSection(props) {
  const { t } = props
  return h('div', { className: 'dsh-sync-hub-section' }, h('h3', null, t('section.label')))
}

// —— 在 apply 里 ——
ctx.slots.inject('settings.section', () =>
  ctx.slots.register(
    {
      name: 'settings.section',
      id: 'sync-hub',
      order: 60,
      label: () => t('section.label'),
      locale: NS,
      inject: () => ({ api: hubApi, t }),        // 组件经 inject 面拿数据与回调
    },
    SyncSection,
  ),
)
```

（`dsh-config-manager/lib/client.js:54081-54101` 同款；`order` 决定设置页里的先后。）

### 7.3 侧边栏入口（sidebar.panellist）

```js
const PANEL_ID = 'dsh-sync-hub'

ctx.slots.inject('sidebar.panellist', () =>
  ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => t('nav'), locale: NS },
    (owner) => h(SyncIcon, { size: (owner && owner.size) || 16 }),
  ),
)
```

（`dsh-github-sync/client.js:1240-1244`；`owner` 是父组件传下来的数据，只有 `size` 之类稳定值，别在里面造对象。）

### 7.4 主面板（main + key）

```js
ctx.slots.inject('main', () =>
  ctx.slots.register(
    { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) },
    () => h(SyncPanel, { api: hubApi, t }),
  ),
)
```

`sidebar.panellist` 的条目点开后在 `main` 里找同 `key` 的 cell 渲染（github-sync 用 `key: PANEL_ID`，`client.js:1230-1236`）。

### 7.5 locale

```js
const ZH = { 'nav': '同步中心', 'section.label': '同步中心' }
const EN = { 'nav': 'Sync Hub', 'section.label': 'Sync Hub' }

ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), NS + ': dictionaries')

let t
try { t = ctx.locale.bind(NS) } catch { t = (k) => k }   // 老宿主没有 locale 时降级
```

规范要求（`dsh-client-locale/README.zh.md`「注册字典」）：`ctx.locale.register(ns, { zh, en, ja })`，**`zh` 与 `en` 两个基础 locale 必须齐全**，其余语言可选；UI 已挂载后再注册也能无刷新生效。当前语言可用 `ctx.locale.getLocale().active`（`config-manager/lib/client.js:54043`）。

`locale/zh.json` 是**分发约定**（`exports["./locale/*.json"]`），浏览器端不要 `import` json——把字典内联在 `client.js` 里最省事（两个实装都这么做）。

### 7.6 宿主组件（primitives）的正确取法

**不要**顶层 `require`，要在函数里惰取并缓存、失败返回 `null` 走自己的画法（`dsh-config-manager/lib/client.js:17104-17116` 原文逻辑）：

```js
let cached
function hostPrimitives() {
  if (cached !== undefined) return cached
  cached = null
  try {
    const loaded = typeof require === 'function' ? require('@deepseek-ai/dsh-client-ui-primitives') : null
    if (loaded !== null && typeof loaded === 'object') cached = loaded
  } catch { cached = null }
  return cached
}
const hostIcon = (name) => {
  const icon = hostPrimitives()?.[name]
  return (typeof icon === 'function' || typeof icon === 'object') ? icon : null
}
```

已知存在的导出（`config-manager` 实际取用）：`FileTypeIcon`、`Tag`、各类 `Icon*` 组件。**未知的先探测再回落**，别硬编码一堆 import。

### 7.7 调后端

```js
const PREFIX = '/dsh-sync-hub'                       // 与 index.js 一致
const api = (p) => new URL(String(p).replace(/^\/+/, ''), document.baseURI).pathname
const getJson = async (p) => (await fetch(api(PREFIX + p), { cache: 'no-store' })).json()
const postJson = async (p, body) =>
  (await fetch(api(PREFIX + p), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).json()
```

（`dsh-github-sync/client.js:47-54` 原文；`document.baseURI` 保证 Electron `file://` 与 Web `http://` 两种宿主都对。）

**样式**：没有 CSS 注入机制给你用。两个实装的做法是**内联 style + 自己的 className**（github-sync 全文件零样式注入、零 CSS 文件）。要跟宿主视觉一致就取 primitives 组件，别猜 CSS 变量名。

---

## 8. 注册 Agent 工具

零依赖形态（实装 `dsh-github-sync/index.js:1120-1158`），**不用** `defineTool`：

```js
const toolOutput = (extra = {}) => ({
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: { text: { type: 'string' }, ...extra },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
})

function registerTools(ctx, hub, sinks) {
  const off = ctx.tools.register({
    name: 'sync_hub_status',
    description: '汇报同步中心当前状态：传输方式、远端、上次运行时间、待同步文件数。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: toolOutput(),
    isConcurrencySafe: () => true,
    timeoutMs: 20000,
    async execute() {
      const s = await hub.status()
      return { text: `transport=${s.transport} files=${s.pending} last=${s.lastRunAt ?? 'never'}` }
    },
  })
  sinks.push(off)
}
```

带参数的完整 schema（`index.js:1187-1198` 同款写法）：

```js
parameters: {
  type: 'object',
  additionalProperties: false,
  required: ['direction', 'phase'],
  properties: {
    direction: { type: 'string', enum: ['upload', 'download'] },
    phase: { type: 'string', enum: ['preview', 'execute'] },
    sessionIds: { type: 'array', items: { type: 'string' }, description: '限定会话 id' },
    targetWorkspace: { type: 'string', description: '下载落地的工作区绝对路径' },
    previewToken: { type: 'string', description: 'execute 阶段必须回传' },
  },
}
```

要点：`execute` 的**返回值必须满足 `output.schema`**（`{ text, ... }`），模型看到的是 `output.render` 产出的内容块数组。注册返回 disposer（停用/卸载时释放）。

> 规范路线（`site/develop/basic/tool.md`）用 `defineTool(...)` 包一层做校验推导；它需要 `@deepseek-ai/dsh-tools`。零依赖插件传裸对象同样被接受——两份实装都不 import `defineTool`。

---

## 9. 打包与发布

```bash
# 本地目录安装（转发给 pnpm；首次会初始化 profile）
dsh plugin --profile demo add ./dsh-sync-hub
# 本地产物安装（不触发构建授权）
pnpm pack && dsh plugin --profile demo add ./dsh-sync-hub-0.1.0.tgz
# 验证层真的进了栈
dsh --profile demo --dump-config | Select-String 'dsh-sync-hub'
# 卸载（同时移除依赖与层）
dsh plugin --profile demo remove dsh-sync-hub
```

- `files` 白名单必须覆盖 `index.js` / `client.js` / `cordis.patch.yml` / `icon.svg` / `lib/*.mjs` / `locale/*.json`；漏 `lib/` 是本地能跑、装到别人机器就炸的经典原因。
- 版本闸门两处：`engines.dsh`（组合包，安装与启动都拦）+ `engines.node`。没有 `engines.dsh` 时 DSH 改查 `@deepseek-ai/dsh*` 的 peer 依赖范围（`publish.md`）。
- git 安装拉源码**不跑 build**，需要 `prepare` 且用户要在 profile 的 `pnpm-workspace.yaml` 写 `allowBuilds`——所以**分发只给 npm 包或 tarball**，别让人从 git 装。
- 发布 npm 的必需元数据：`name`（唯一）、`version`、`description`、`license`、`repository`、`files`、`engines`、`exports`、`icon`、`keywords`、`dsh.bundle`、`dsh.client`（`dsh-config-manager/package.json` 是完整范例）。发布前 `pnpm pack --dry-run` 核对 ls 出来的文件清单。

---

## 10. 测试与崩溃清单

### 10.1 官方推荐路径（对第三方插件可落地的部分）

1. **沙箱 profile**：`dsh --profile <sandbox> ...` 装插件跑，插件崩只崩沙箱；开发期绝不往主力 profile 装未验证版本（技能 `dsh-dev-sandbox`）。
2. **层级闸门**：`dsh --profile <sandbox> --dump-config` 能看到 `# == dsh-sync-hub` 层才算装对。
3. **smoke 三件套**（真实入口，不用 mock）：① 起 profile 不报错；② `ctx.tools.schemas()` 里出现你的工具；③ 浏览器打开设置页，`GET /dsh-sync-hub/state` 返回 200 JSON。
4. **真实入口原则**（`extra/testing.md`）：只 mock 昂贵/不确定的边界（网络、时钟），下游保持真实；“验证世界，不验自述”——断言落盘文件、断言 `dump-config`，而不是断言插件自己打印的日志。
5. 资源归属每个测试都要验：卸载插件后路由/工具/定时器是否真消失（`ctx.effect` 的清理函数有没有跑到）。

### 10.2 常见崩溃原因（按踩坑概率排序）

| # | 症状 | 根因 | 正确做法 |
|---|---|---|---|
| 1 | `MODULE_NOT_FOUND '@deepseek-ai/...'`，插件整体不激活 | 本地 `file:`/link 安装是符号链接，解析不到 asar 内的包 | 零依赖，只用 `node:*` |
| 2 | 客户端整块空白，控制台报模块表缺项 | `client.js` 顶层 `require('@deepseek-ai/dsh-client-ui-*')` | 惰取 + try/catch + 回落（§7.6） |
| 3 | 插件加载失败，日志提 Standards Schema | 导出了普通对象当 `Config` | 不声明 Config，或提供 schemastery schema |
| 4 | 工具/设置页全没了 | 在四件套旁边加了 `export default`，Loader 丢弃函数插件的命名空间 | 函数插件不要 default 导出 |
| 5 | 设置页点了没反应 / 路由 404 | 客户端 `PREFIX` 与服务端不一致；或用了 `/dsh-sync-hubx` 这种前缀 | 常量单一来源，前缀匹配是 `prefix + '/'` |
| 6 | 保存设置后刷新丢失 | 写到了插件目录或 `process.cwd()`（安装目录会被覆盖/不可写） | 写 `$DSH_HOME/<id>/state.json` |
| 7 | 配置文件只写了一半，插件起不来 | 直接 `writeFileSync` 就地覆盖 | 写 `.tmp` 再 `renameSync` 原子替换 |
| 8 | 用户卸载插件后宿主 CPU 100% | 定时器/监听器没有归属到 `ctx.effect` | 所有资源走 `ctx.effect` 返回清理函数 |
| 9 | 别人的 `config` 丢了 | patch 覆盖整行 `config` 而非深合并 | 覆盖他人行时重述该行全部键 |
| 10 | 装上但插件页里没有 | 漏了 `dsh.bundle.patch`，或 patch 里 `name` 写成路径而非包名 | `name` 用包名；`files` 带上 `cordis.patch.yml` |

---

## 11. 骨架模板（可改名直接跑）

四文件最小插件：服务端工具 + 一个设置页面板 + 一个 HTTP 路由。

### 11.1 `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-sync-hub
      name: 'dsh-sync-hub'
```

### 11.2 `index.js`

```js
// dsh-sync-hub · 宿主半边。只依赖 Node 内置。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-sync-hub'
export const inject = ['webServer', 'tools']

const PREFIX = '/dsh-sync-hub'
const DEFAULTS = { transport: 'folder', remoteDir: '', lastRunAt: null }

const dshHome = () => (process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : join(homedir(), '.dsh'))
const statePath = () => join(dshHome(), 'sync-hub', 'state.json')

function readState() {
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(statePath(), 'utf8')) } }
  catch { return { ...DEFAULTS } }
}

function writeState(patch) {
  const next = { ...readState(), ...patch }
  const p = statePath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(`${p}.tmp`, JSON.stringify(next, null, 2), 'utf8')
  renameSync(`${p}.tmp`, p)
  return next
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req, limit = 1 << 20) {
  const chunks = []; let size = 0
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('body too large'); chunks.push(c) }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

export function apply(ctx, config = {}) {
  const disposers = []

  const status = async () => ({
    dshVersion: detectVersion(), home: dshHome(), transport: readState().transport,
    pending: 0, lastRunAt: readState().lastRunAt, configKeys: Object.keys(config),
  })

  // —— HTTP 路由 ——
  const handler = async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname.slice(PREFIX.length) || '/'
      if (req.method === 'GET' && path === '/state') return sendJson(res, 200, readState())
      if (req.method === 'POST' && path === '/state') return sendJson(res, 200, writeState(await readBody(req)))
      if (req.method === 'GET' && path === '/status') return sendJson(res, 200, await status())
      return sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 400, { error: String(error?.message ?? error) })
    }
  }
  disposers.push(ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }),
    'dsh-sync-hub: routes',
  ))

  // —— Agent 工具 ——
  const output = {
    schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }
  disposers.push(ctx.tools.register({
    name: 'sync_hub_status',
    description: '汇报同步中心当前状态：传输方式、远端目录、上次运行时间。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output, isConcurrencySafe: () => true, timeoutMs: 20000,
    async execute() {
      const s = await status()
      return { text: `transport=${s.transport} remote=${s.remoteDir || '-'} last=${s.lastRunAt ?? 'never'} dsh=${s.dshVersion}` }
    },
  }))

  return () => { for (const off of disposers.splice(0)) try { off() } catch {} }
}

// 版本探测：Electron 打包态读 app.asar 内的 package.json（见 §4）
function detectVersion() {
  try {
    const p = join(process.resourcesPath ?? '', 'app.asar', 'dsh', 'package.json')
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).version
  } catch {}
  return 'unknown'
}
```

### 11.3 `client.js`

```js
// dsh-sync-hub · 浏览器半边。
window.__ModuleLoader__.load({
  id: 'dsh-sync-hub',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    const NS = 'dsh-sync-hub'
    const PREFIX = '/dsh-sync-hub'
    const PANEL_ID = 'dsh-sync-hub'

    const api = (p) => new URL(String(p).replace(/^\/+/, ''), document.baseURI).pathname
    const getJson = async (p) => (await fetch(api(PREFIX + p), { cache: 'no-store' })).json()
    const postJson = async (p, body) => (await fetch(api(PREFIX + p), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })).json()

    function SyncPanel({ t }) {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      useEffect(() => { getJson('/state').then(setState).catch((e) => setError(String(e))) }, [])
      if (error) return h('div', { style: { padding: 16, color: '#c00' } }, error)
      if (!state) return h('div', { style: { padding: 16, opacity: .6 } }, t('loading'))
      return h('div', { style: { padding: 16, display: 'grid', gap: 12 } },
        h('h3', { style: { margin: 0, fontSize: 15 } }, t('section.label')),
        h('label', { style: { display: 'grid', gap: 4 } }, t('field.transport'),
          h('input', {
            value: state.remoteDir ?? '',
            onChange: (e) => setState({ ...state, remoteDir: e.target.value }),
            style: { padding: '6px 8px' },
          })),
        h('button', {
          onClick: async () => setState(await postJson('/state', { remoteDir: state.remoteDir, lastRunAt: new Date().toISOString() })),
          style: { padding: '6px 12px', cursor: 'pointer' },
        }, t('action.save')))
    }

    const SyncIcon = (props) => h('span', { title: 'Sync Hub', style: { fontSize: (props.size || 16) - 2 } }, '⇄')

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const ZH = { 'nav': '同步中心', 'section.label': '同步中心', 'field.transport': '远端目录', 'action.save': '保存', 'loading': '加载中…' }
        const EN = { 'nav': 'Sync Hub', 'section.label': 'Sync Hub', 'field.transport': 'Remote folder', 'action.save': 'Save', 'loading': 'Loading…' }

        try { ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), NS + ': dictionaries') } catch {}
        let t
        try { t = ctx.locale.bind(NS) } catch { t = (k) => k }

        const offSection = ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: PANEL_ID, order: 60, label: () => t('section.label'), locale: NS, inject: () => ({ t }) },
          SyncPanel,
        ))
        const offRow = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => t('nav'), locale: NS },
          (owner) => h(SyncIcon, { size: (owner && owner.size) || 16 }),
        ))
        const offPanel = ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) },
          () => h(SyncPanel, { t }),
        ))

        return () => { offPanel(); offRow(); offSection() }
      },
    }
  },
})
```

### 11.4 `package.json`

用 §1.1 那份，改 `name` / `version` / `description` / `icon` 即可。

### 11.5 自检顺序

```bash
dsh plugin --profile sandbox add ./dsh-sync-hub
dsh --profile sandbox --dump-config | Select-String 'dsh-sync-hub'     # 层在
# 起 sandbox → 设置页出现「同步中心」→ 保存一次 → 重启仍在（$DSH_HOME/sync-hub/state.json）
# 工具列表里出现 sync_hub_status
```

---

## 附：本机取证备忘

- 安装目录 `C:\Users\HUAWEI\AppData\Local\Programs\DeepSeek Harness\resources\`：`app.asar`（~300 个 `@deepseek-ai/*`，**0 个 `.d.ts`**）、`app.asar.unpacked`（**空**）、`app-update.yml`。
- 因此**没有 `.d.ts` 可查**：权威签名只能读 `lib/index.js` 的 JSDoc + 各包 `README.zh.md`（同版本随包分发，比 KB 更新）。
- `resources/app.asar/dsh/package.json` → `{ "name": "@deepseek-ai/dsh-desktop-runtime", "version": "0.2.2-rc.1" }`。
- 读 asar 内文件的小工具（本仓库 `scratch/asar.mjs`）：`node scratch/asar.mjs list <regex>` / `node scratch/asar.mjs cat <asar内路径>`。
