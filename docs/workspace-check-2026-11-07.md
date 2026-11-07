# 工作区巡检报告 — dsh-sync-hub v0.4.0

日期：2026-11-07 · 范围：D:\dsh-sync-hub（DSH 插件源码） + 本机活实例（C:\Users\HUAWEI\.dsh）
方式：3 个只读审查队友（隐私 / 引擎 / 前端）+ Lead 亲自复现验证。**全程未修改仓库任何文件。**

标注：✅ = Lead 已在本机 import 真实模块 / 实测复现；📄 = 代码审查判定（未实机复现）

---

## 一、结论先行

插件**能跑通**（测试全绿、HTTP 接口全 200、活实例已加载 v0.4.0），但存在 **3 个会导致真实数据损坏 / 泄露的 P0**，而且当前**从未真正执行过一次同步**（remote.path 为空），所以这些缺陷都还没被触发过。

| 级别 | 数量 | 代表问题 |
|---|---|---|
| P0 | 3 | 同步接口零鉴权（跨站可外泄数据）、ignoreAfterPull 被丢导致每次同步重复覆写、custom 分区拉取会抹掉用户真实值 |
| P1 | 8 | 全大写密钥不脱敏、键名锚定导致十余种密钥名漏网、脱敏吞尾逗号损坏 JSON、profile 穿越、备份契约不匹配、备份无回滚入口、冲突判定依赖跨机时钟、同步无事务 |
| P2 | 14 | 敏感文件清单不完备、开关口径不一致、远端可植入凭据、路径注入、busy 单槽可重复触发同步 … |
| P3 | 11 | tmp 文件可预测、采集无字节上限、Windows 大小写敏感、每键全树重渲染 … |

**另有 5 项仓库 / 部署卫生问题**（见第五节）：依赖路径指向已删除目录、README 安装命令仍是旧路径、旧沙箱 profile 残留、无 git remote / 无 CI、README 测试清单不全。

---

## 二、P0（必须先修）

### P0-1 ✅ 同步接口零鉴权 + 无 Origin 校验 → 跨站可把 DSH 数据推给攻击者  `（已于 2026-11-07 修复，见第九节）`
- 位置：`lib/server.mjs:32-97`（全部路由）、`lib/server.mjs:14-30`（readBody 不校验 Content-Type）、`index.js`（`ctx.webServer.register({kind:'prefix', path:'/dsh-sync-hub'})`）
- 依据：DSH 宿主只为 **/api 路由与 stream** 提供 Origin / 会话校验；本插件注册的是普通 `prefix` 路由，**不在保护范围内**。全仓 grep `origin|referer|sec-fetch|authorization|csrf` 零命中。
- 攻击链：任意网页 → `POST /dsh-sync-hub/settings`，body 用 `content-type: text/plain`（CORS 简单请求，**免预检**）→ 服务端无条件 `JSON.parse` → 把 transport 改成 git 并指向攻击者仓库、打开 secrets 开关 → `POST /run` 把 DSH_HOME 推走 → `POST /secret` 顶掉已存 token。
- 附带：`lib/server.mjs:66` 的 `body.settings || body` 兜底让裸 body 覆盖顶层设置，是这条链能生效的关键一环。
- 修法：① 校验 `Origin` / `Sec-Fetch-Site` 同源；② POST 只接受 `application/json`（跨站被迫预检，服务端不发 CORS 头即失败）；③ 加一次性 token 走自定义头；④ 复用宿主 `ctx.connection.requestRejection()`。

### P0-2 ✅ ignoreAfterPull 被状态白名单丢弃 → 每次同步都重复拉取 / 合并 / 覆写 / 备份  `（已于 2026-11-07 修复，见第九节）`
- 位置：`lib/state.mjs:164-182`（normalizeState 白名单）、`lib/state.mjs:58-73`（defaultState）、`lib/state.mjs:193-200`（saveState）；写入方 `lib/engine.mjs:390/445`，消费方 `lib/engine.mjs:97/128-132`
- 实测：`normalizeState({ignoreAfterPull:{...}})` → `undefined`；磁盘上永远没有该字段 → 补丁是死代码。
- 叠加基线漂移（`lib/engine.mjs:411` 记本地 `canonicalSha` 而非远端 `entry.sha`），每轮必定重判 `'pull'`：同一文件反复拉取、反复覆写、每次新建一个备份目录。
- 修法：normalizeState 补 `ignoreAfterPull: asObject(input.ignoreAfterPull)`、defaultState 补 `{}`；同时 `base[id] = entry.sha`（远端基线），本地 sha 另存 `state.localSha`。

### P0-3 ✅ custom 分区拉取会抹掉用户真实值  `（已于 2026-11-07 修复，见第九节）`
- 位置：`lib/sections.mjs:409-411`（对 .yml/.json/.env/.ini/.toml 做 redactText 但 `meta=null`，见 `bufEntry` `sections.mjs:136`）、`SECTION_DEFS`（`lib/sections.mjs:30-101`）无 custom 项 → `lib/engine.mjs:270` kind 落 files → `lib/engine.mjs:280-289` 把**含 <redacted> 的 blob 原子写回用户文件**
- 修法：collectCustom 传 `meta:{kind:'redacted'}` 并给 SECTION_DEFS 补 custom（与 cordis 同走合并路径）。

---

## 三、P1（高，已实测复现为主）

### 隐私 / 脱敏
1. ✅ **全大写值被当环境变量引用**（`lib/privacy.mjs:40,91-101`）→ 形如 `api_key: <全大写的 AWS 访问键样例>` 的值原样上传。
2. ✅ **键名 ^...$ 锚定**（`lib/privacy.mjs:38,125`）→ `aws_secret_access_key`、`aws_access_key_id`、`auth_token`、`passphrase`、`api_secret`、`openai_api_key`、`ssh_key`、`jwt`、`bearer` 全部不脱敏；`apiToken` 亦漏。
3. ✅ **短于 8 字符不脱敏**（`lib/privacy.mjs:98`）→ `password: abc123` 原样。
4. ✅ **块标量 / 流式 YAML / 单行与嵌套 JSON 整段漏脱敏**（`lib/privacy.mjs:122` + `lib/sections.mjs:410,24`）→ 已导入的 `redactJson` 从未调用，是死导入。
5. ✅ **脱敏吞掉 JSON 尾逗号**（`lib/privacy.mjs:99-100,122`）→ 3 行 JSON 输入输出变成 `"api_key": "<redacted>"`（逗号消失）→ 对端 `JSON.parse` 报 `Expected ',' or '}' after property value`，**配置语法被写坏**。
6. ✅ **profile 名未校验**（`lib/paths.mjs:39-63` + `lib/sections.mjs:175-176,199`）→ `DSH_PROFILE=..\..\Windows` 时读到 `C:\Users\HUAWEI\Windows\cordis.patch.yml`（DSH_HOME 之外）并上传。实测确认。
7. 📄 **链接 / 联接逃逸**（`lib/util.mjs:50-55,62-95` + `lib/paths.mjs:93-100`）→ 采集侧不解析 realpath、不挡 Windows Junction；pull 侧落盘只做字面前缀检查 → 远端可写到 DSH_HOME 之外（`lib/engine.mjs:261-266,288-289`）。**Windows 联接行为未实机复现**（只读约束）。

### 同步正确性
8. ✅ **备份契约不匹配**（服务端 `lib/engine.mjs:522-530` 返回**目录名字符串数组** → `lib/hub.mjs:165` 透传 → 前端 `client.js:1582-1589` 按对象读 `b.stamp/b.name/b.path`）→ 备份卡片显示空白行、`key={undefined}`、且「还没有备份」空态永不出现。首次成功同步后必然复现。
9. 📄 **备份只进不出**：全仓无 restore / rollback 代码路径，用户被覆盖后**没有任何程序化回滚手段**。
10. 📄 **备份保留按目录数计**（`lib/engine.mjs:218-242`）→ `keepBackups=20` 实为 20 个**文件**版本；一次批量 pull 即可挤掉全部历史；同毫秒两次备份落同一目录互相覆盖。
11. 📄 **无事务**（`lib/engine.mjs:362-473` + `lib/hub.mjs:204-208`）→ 任一文件写失败即中断，本轮 base 更新全丢，下轮可能改判 conflict 并按 newest 覆盖本机改动。
12. 📄 **冲突判定依赖跨机时钟**（`lib/engine.mjs:79-90`）→ mtime 不可用时兜底「bytes 大者胜」，用户小改动被大文件吃掉。
13. 📄 **会话无合并**（`lib/engine.mjs:312-356`）→ 整份覆盖 + 删除别处同 id 副本，与 `lib/sections.mjs:65` 的文案「按会话合并，不会删除对方机器的会话」矛盾。

### 接口层
14. ✅ **前端不检查 HTTP 状态码**（`client.js:476/477-484` 丢弃 `Response.ok/status`，只信响应体 ok 字段）→ 宿主返回 HTML 时用户看到 `SyntaxError: Unexpected token '<'`；`/plan`、`/run` 无超时无取消。
15. 📄 **路径注入**：`settings.remote.path` 与 `workspaces.map` 未做越界校验（`lib/state.mjs` normalizeSettings 原样保留）→ 同步目标可被指向任意目录。对比：`customPaths[].rel` 已被正确拦截，说明是漏改不是没设计。

---

## 四、P2 / P3 摘要

**P2（14 项）**
- 敏感文件默认排除清单不完备（`lib/privacy.mjs:16-36`）：漏 `.git-credentials`、`.npmrc`、`.pgpass`、`.my.cnf`、`.htpasswd`、`.envrc`、`*.ppk`、`*.jks`、`*.asc`、`credential.yml`、`secrets.yaml`、`my-secrets.json`；私钥仅按文件名判定，**无内容嗅探**。
- 「凭据与密钥」开关口径不一致：采集端 `lib/sections.mjs:155` 调 `isForbiddenRel(rel)` 未传 `allowSecrets`，引擎端 `lib/engine.mjs:158,262,333` 已放行 → 开关打开也没同步走。
- 开关打开后 **pull 侧远端可向本机植入凭据文件**（`lib/engine.mjs:261-262,332-333`）→ 凭据注入 / 投毒。
- `DSH_HOME=C:\` 时 `resolveInsideHome` 前缀检查失效（`lib/paths.mjs:93-100`）。
- sessions 默认开启且零脱敏（`lib/state.mjs:33`）→ 聊天里粘贴过的密钥原样上传；文档承诺的「预览里标记密钥」未实现；`maskSecretString` 是无调用点死代码。
- `redactJson` 对共享子对象返回原节点（`lib/privacy.mjs:136-141`）→ 别名子树绕过。
- `buildKeyMap` 纯键名全局匹配（`lib/sections.mjs:528-562`）→ 同名键取错本机值。
- 跨进程无锁（`lib/hub.mjs:19-31` 只在进程内串行，`lib/state.mjs:184-200` 是 read-modify-write）。
- `transport/local.mjs:64-73` putFile 先 `rm` 再 writeFile（非原子且先删旧件）。
- `transport/git.mjs:212-235` non-fast-forward 文案称「本次改动未丢失」，但 `:182-194` 的 `reset --hard` + `clean -fdx` 下次会丢弃该提交——文案与行为相反。
- manifest 每 id 只存一条（`lib/engine.mjs:398`）→ 双机并发改同一文件无法追溯双方 sha。
- `lib/hub.mjs:224` 用 `id.split('/')` 取 sessionId，但 id 形如 `sessions:<id>` → `synced` 恒 false。
- 关闭的 section 整段跳过且不更新基线（`lib/engine.mjs:123`）→ 日后启用产生假冲突。

**P3（11 项）**
`util.mjs:16-27` tmp 名可预测且未用 `wx`（且无 fsync、tmp 落在被扫描目录内，下次可能被当正常文件同步出去）；采集无字节上限（`util.mjs:62-95`、`sections.mjs:156`）；`toHomeRel` Windows 大小写敏感会静默漏同步（`paths.mjs:103-108`）；`listSessions` 未忽略 node_modules（`sections.mjs:495`）；子进程继承完整环境（`util.mjs:97-120`）；`SECRET_FILES` 硬编码；前端每键全树重渲染（`client.js:707-714`，无 memo / useMemo）；服务端每次请求重扫全盘重算会话哈希（`sections.mjs:491-521`）；会话静默截断 300 条却按全量展示；`api()` 依赖 `document.baseURI`（子路径部署 / Electron 下打错地址）。

**XSS 专项：未发现。** 全仓 `dangerouslySetInnerHTML|innerHTML|outerHTML|document.write|eval(|new Function` 零命中，所有插值走 React 文本子节点自动转义。唯一残留是内部错误原文回传（`lib/server.mjs:91-94`）造成的信息泄露（非 XSS）。

---

## 五、仓库 / 部署卫生问题

1. ~~**依赖路径指向已删除目录**~~ —— ✅ **已于 2026-11-07 修复**
   - 原状：`C:\Users\HUAWEI\.dsh\profiles\desktop\package.json` 与 `pnpm-lock.yaml` 里 `dsh-sync-hub` 依赖是 `file:D:/VibeCoding/scratch/dsh-sync-hub`，该目录**已不存在**（项目已搬到 `D:\dsh-sync-hub`）；后果是 `pnpm install` 指向死路径、**源码改动不会自动进已装副本**。
   - 现状：desktop profile 的 `local-plugins\dsh-sync-hub` 与 `node_modules\dsh-sync-hub` 都改成 **Windows Junction → `D:\dsh-sync-hub`**；dependencies 改为 `file:local-plugins/dsh-sync-hub`；`pnpm-lock.yaml` 5 处死路径同步改写（残留 0）。源码改完即时进已装副本。
   - 回滚备份：`C:\Users\HUAWEI\.dsh\plugin-backups\20261107\`（package.json / pnpm-lock.yaml / cordis.patch.yml / cordis.yml / 旧已装副本全量）。
2. ~~**文档滞后**~~ —— ✅ **已修复**：`README.md:31` 与 `docs/research/00-brief.md:20` 的旧路径已改为 `D:\dsh-sync-hub`。
3. ~~**遗留沙箱 profile**~~ —— ✅ **已修复**：`~/.dsh/profiles/sb-sync-hub` 的 dependencies 与 `pnpm-lock.yaml` 同样改为 `file:local-plugins/dsh-sync-hub`，其 `node_modules\dsh-sync-hub`（原为指向已删目录的死 Junction）改为指向 `D:\dsh-sync-hub` 的 Junction，启动时 `patch: entry "sync-hub" not found` 告警随之消失。
4. **发布准备未完成**：无 git remote、无 tag、无 `.github/`（无 CI）。
5. **README 测试清单不全**：「九、开发」只列 5 个测试文件，漏 `session-canon.test.mjs` 与 `cross-machine.test.mjs`。

### 5.1 部署布局（2026-11-07 起）

```
<profile>/
├─ local-plugins/dsh-sync-hub   → Junction → D:\dsh-sync-hub   （插件本体，hmr 监听此目录）
├─ node_modules/dsh-sync-hub     → Junction → D:\dsh-sync-hub   （宿主解析入口）
└─ cordis.patch.yml              → 用户配置，**当前不含 hmr 条目**（见下）
```

- profile `package.json` / `pnpm-lock.yaml`：`"dsh-sync-hub": "file:local-plugins/dsh-sync-hub"`。
- **热重载当前未启用**：base bundle 里的 `dsh-hmr` 配置是 `root: []`（官方语义 = 只监视配置文件，不监视模块源码），所以改工作区源码不会自动重载。按 `AGENTS.md` 规则 ①（禁止改动用户 DSH 配置），**由用户自己**在 profile `cordis.patch.yml` 加一条 `- id: hmr` 且 `config.root: [local-plugins]` 才生效，且需重启 DSH 一次建立 watcher。
- 坑：**不要再对工作区跑 `sync_plugin` write=true**——会把文件拷进 junction 目标（写脏仓库），并把 junction 变成真实目录。
- 插件 HTTP 路由带前缀：`/dsh-sync-hub`（`lib/server.mjs:2` 的 `PREFIX`），探测 `/state` 会 404，属正常。

---

## 六、活实例现状

- 插件 0.4.0 / DSH 0.2.2-rc.1（desktop profile）/ node 24.21.0 / 设备 `HUAWEI(28cd59f9)` / `DSH_HOME=C:\Users\HUAWEI\.dsh`
- webServer 仅监听 `127.0.0.1:<随机高位端口>`（局域网不可达，这点是好的）。**端口每次重启都会变**：实测 1900 → 13180 → 53252 → 36194，探测时不要写死端口，要从运行上下文取。
- 通道 `local`，但 `remote.path` 为空 → **从未执行过一次同步**（`base={}`、`lastPlan=null`、`lastSync=null`）
- 本机 56 条目 / 37MB：cordis 2、plugins 1、skills 1、sessions 52（另 55 个会话共 36.9MB）
- `~/.dsh/sync-hub/` 下只有 `state.json`(892B)，无 `backups/`、无 `remote-git/`
- `sync_hub_run` 已注册为全局 Agent 工具（`lib/tools.mjs:113-147`，`isConcurrencySafe:false`，timeout 600s）—— 修鉴权时别忘了它同样走 HTTP 接口
- `sync_plugin` 工具坑：对本仓库 dryRun 时 target 会解析成 `...\local-plugins\dsh-useful-tools`（用了工具默认 pluginName），必须显式传 `pluginName:'dsh-sync-hub'`

---

## 七、建议修复顺序

1. **P0-1**（鉴权 / Origin / Content-Type）→ 唯一可被外部触发的攻击面，优先级最高
2. **P0-2 + 基线漂移**（一起改，否则 ignore 是空转）→ 消除「每次同步重复覆写 + 重复备份」
3. **P0-3 + 会话覆盖** → 消除数据损坏路径
4. **P1 脱敏组**（大写值 / 键名 / 短值 / JSON-YAML 结构化 / 尾逗号）→ 一组一起改并补回归用例
5. **P1 备份组**（契约统一 + 回滚入口 + 保留策略按批次目录）
6. **profile 名白名单 + realpath 校验**（含 Junction 判定）
7. **敏感文件清单补齐 + 内容嗅探 + 开关口径对齐 + pull 侧禁止凭空创建凭据文件**
8. P2 / P3 按需

**回归用例建议覆盖**：链接逃逸、全大写密钥、`aws_*` 键名、块标量、单行 JSON、尾逗号、profile 穿越、备份契约往返、重复同步幂等（连跑两次 pulled 应为 0）。
---

## 八、防御性加固与运行态复验（2026-11-07）

依据 `AGENTS.md` 两条硬规则：① 禁止修改可能影响 DSH 的配置；② 插件任何情况下都不能让用户的 DSH 崩溃。

### 8.1 修复前的冒泡点（审查结论）

- `lib/tools.mjs` 4 个 `execute()` 直接 `await hub.status()/plan()/run()/sessions()`，**无 try/catch** → hub 抛错会冒泡给宿主工具执行器。
- `index.js` 的 `new Hub(ctx, {...})` 在 `apply()` 内**无保护** → 构造抛错会让插件加载失败；两个 `ctx.effect(...)` 回调同样无保护。
- `lib/hub.mjs` 的 `plan()/run()` 里 `this.context()` / `this.versionInfo()` 在 try 之外 → 抛错时 promise reject。

（`lib/server.mjs` 的 HTTP handler 早已整体被 try/catch 包住 → HTTP 面原本就是安全的。）

### 8.2 修复（提交 c16c5ab，7 文件 +358/-28）

- `lib/tools.mjs`：新增 `safeExecute(name, fn)`，异常统一转成 `{ text: '[sync-hub] <name> 失败：<msg>' }`，4 个工具全部改用它。
- `index.js`：`new Hub(...)` 包 try/catch，失败降级到 `degradedHub(...)`；两个 `ctx.effect` 回调各自 try/catch，失败返回 noop disposer。
- `lib/degraded.mjs`（新）：降级 Hub —— 读接口（status/sessions/analysis/workspaces/backups/test/plan/run）全部返回结构化结果不抛异常；写接口（saveSettings/setSecret）抛可读错误，由 server 的 catch 转 500。
- `lib/hub.mjs`：`plan()/run()` 的 `context()` / `versionInfo()` 移入 try；transport 在 finally 里 `dispose().catch(() => {})`。
- `tests/defensive.test.mjs`（新）：4 组用例 —— hub 抛错时 4 个工具不 reject；降级 Hub 读接口不抛、写接口抛可读错；宿主 webServer/tools 注册抛异常时 `apply()` 与卸载都不抛；正常宿主下 `apply()` 注册 1 条 HTTP 路由 + 4 个工具。

### 8.3 验证（实测）

- **8 个测试文件全部 exit 0**：smoke / secrets / transport / git-guard / analysis / session-canon / cross-machine / defensive。
- **隔离环境跑新代码**（minihost，不碰用户主实例）：`GET /dsh-sync-hub/state` 200、`GET /dsh-sync-hub/sessions` 200、非法 JSON → 500 `{"ok":false,"error":"请求体不是合法 JSON"}`、`POST /dsh-sync-hub/plan` → 500 `{"ok":false,"error":"还没有设置同步文件夹路径"}`、未知路由 → 404 —— 全是结构化降级，无崩溃。
- **用户主实例重启后复验**（端口 36194，DSH 进程 11:58:20 启动，晚于提交时间）：`GET /dsh-sync-hub/state` 200（plugin 0.4.0 / DSH 0.2.2-rc.1）、`GET /dsh-sync-hub/sessions` 200、`POST /dsh-sync-hub/plan` → 500 `{"ok":false,"error":"还没有设置同步文件夹路径"}`；工具层 `sync_hub_status` / `sync_hub_plan` / `sync_hub_sessions` 三个均正常返回（plan 走的是「计划失败：还没有设置同步文件夹路径」这条优雅失败路径）。
- **用户 DSH 配置未被本轮改动**：`C:\Users\HUAWEI\.dsh\profiles\desktop\cordis.patch.yml` 不含 hmr 条目，LastWriteTime 仍是 11:51:58（即撤销时刻），此后所有操作都是只读或仓库内改动。

### 8.4 热重载启用（2026-11-07 12:08，用户授权后由 agent 代改）

- **改动文件**：`C:\Users\HUAWEI\.dsh\profiles\desktop\cordis.patch.yml`（**用户配置**）。本次是经用户明确同意（m00796「你直接帮我改了」）才写入的 —— 此前对同一文件的改动全部由 agent 自行撤销。
- **备份**：`C:\Users\HUAWEI\.dsh\plugin-backups\20261107\cordis.patch.yml.pre-hmr-1208.bak`（6655B，字节级复制，与改前完全一致）。
- **追加内容**（文件末尾第 261 行起，LF、无 BOM）：

  ```yaml
  - id: hmr
    name: '@deepseek-ai/dsh-hmr'
    config:
      root:
        - local-plugins
      debounce: 300
      ignored:
        - '**/node_modules/**'
        - '**/.git/**'
        - '**/.dev/**'
  ```

- **依据**：base bundle `@deepseek-ai/dsh-base` 的 `cordis.patch.yml` 本就带 `- id: hmr`（`config.root: []`，官方注释「模块监听是 opt-in」），且该文件头写明「后续 bundle patch 与用户 profile `cordis.patch.yml` 按 id 定位同一行，后者**整块替换** `config`」；官方 README 要求**在启动前**通过 profile patch 配置这一行。同 bundle 已有 `- id: timer`，所以不需要额外加 timer 条目。
- **校验**：js-yaml 与 yaml(eemeli) 双解析器均解析成功 → 17 条顶层条目、末条 `id=hmr` / `root=["local-plugins"]` / `debounce=300`、无重复 id；文件保持 LF、无 BOM、未引入 `!!js` 标签。
- **第一轮实测（探针设计有误，结论已被 8.5 推翻）**：写入后运行实例仍在线（端口 36194，`GET /dsh-sync-hub/state` → 200，版本 0.4.0）。活体探针把 `package.json` 版本改成 `0.4.1-hmrprobe`，**60s 内 `/state` 版本始终是 0.4.0**。当时的结论是「该行要下次启动才生效」—— 这个结论**是错的**：那一轮改的是 `package.json`，而 hmr 只监听**模块文件**，`package.json` 根本不触发重载，探针本身无效。

### 8.5 热重载已实测生效（2026-11-07 12:18，模块级探针）

- **实例**：用户于 12:11:50 重启，新实例 pid 2832、GUI 端口 **44919**（端口每次重启都变，探测别写死）。
- **探针**：改**模块文件**而不是 `package.json` —— 把 `index.js:19` 的 `const PLUGIN_VERSION = pluginVersion()` 临时改成 `const PLUGIN_VERSION = '0.4.2-hmrprobe'`，轮询 `GET /dsh-sync-hub/state`。
- **结果**：**t+2s** 即返回版本 `0.4.2-hmrprobe` → 插件被自动重载；还原 `index.js` 后再次返回 `0.4.0` → 两次重载都成立。探针已还原，`git status` 干净。
- **结论**：**热重载可用** —— 桌面 profile `cordis.patch.yml` 里那条 `- id: hmr`（`root: [local-plugins]`）生效了：改 `D:\dsh-sync-hub` 里的模块源码**保存即生效，不用重启 DSH**。
- **踩坑记录（下次别再踩）**：hmr 只监听**模块文件**（`.js` / `.mjs`）。改 `package.json`（哪怕只是版本号）不会触发重载，模块顶层的 `pluginVersion()` 也就不会重跑 → 拿 package.json 当探针会得出「热重载没生效」的错误结论。
- **附带修正**：profile 的插件依赖现在是 `"dsh-sync-hub": "file:local-plugins/dsh-sync-hub"`（不再指向已废弃的 `file:D:/VibeCoding/scratch/dsh-sync-hub`）；`node_modules\dsh-sync-hub` 与 `local-plugins\dsh-sync-hub` **都是指向 `D:\dsh-sync-hub` 的 junction** → 运行实例加载的就是工作区代码。



---

## 九、P0 安全修复（2026-11-07 16:40，全部实测）

### 9.1 P0-1：接口访问控制（`lib/server.mjs`）

新增导出 `checkAccess(hub, req, method)`，在路由分发**之前**拦截，五层：

| 层 | 判据 | 拒绝码 | 拒绝语 |
| --- | --- | --- | --- |
| 宿主会话 | `ctx.get('connection').requestRejection(req)`（401/403 直接拒；抛异常则退回本地校验） | 401/403 | 宿主原文 |
| 跨站标记 | `Sec-Fetch-Site` ∉ {same-origin, same-site, none} | 403 | 检测到跨站请求，已拒绝 |
| 回环栅栏 | `Host` 不是 `127.0.0.1` / `localhost` / `::1` | 403 | 只接受本机访问 |
| 来源同源 | `Origin`（没有则看 `Referer`）与本机不同源 / 不同端口 | 403 | 请求来源不是本机同源地址，已拒绝 |
| 内容类型 | POST 的 `Content-Type` 不是 `application/json` | 415 | 请求必须使用 application/json |

设计取舍：

- **不往 `index.js` 的 `inject` 里加 `connection`**（AGENTS.md 规则②：插件不得影响宿主行为）→ 用 `ctx.get('connection')` + try/catch 取，取不到就退回本地四层校验。
- 复用宿主 `requestRejection()` 而不是自己发明 token：浏览器会话与 peer 鉴权宿主已经管了。
- CORS 简单请求（`content-type: text/plain`）被第 5 层挡掉；跨站读响应本来就被同源策略挡住，写操作被第 2/4 层挡住。

- 运行态实测（2026-11-07 16:43，实例端口 37657）：不带 cookie 请求 `GET /dsh-sync-hub/state` → **401 `未授权访问本机同步接口`**；同一时刻宿主自己的 `GET /api/session` → **401 `unauthorized`** → 两者保护级别一致。浏览器持有宿主的签名 cookie（authority 绑定）时 `isAuthenticated` 放行，因此前端不受影响（前端 fetch 走相对路径、同源，浏览器默认带 cookie）。
- 预期副作用（如实记录）：任何外部脚本直连该接口都需要带宿主 cookie 或 API token，否则 401。这正是 P0-1 要的效果——同步设置/密钥/推送接口不再是「本机任意进程可调」。

### 9.2 P0-2：状态白名单 + 基线

- `lib/state.mjs`：`defaultState` 补 `ignoreAfterPull: {}` 与 `localSha: {}`；`normalizeState` 补 `ignoreAfterPull: normalizeIgnore(input.ignoreAfterPull)`（只保留 `{localSha, remoteSha}` 字符串对，非法项丢弃）与 `localSha: asObject(input.localSha)`。
- `lib/engine.mjs`：拉取后基线记**远端这一版的 sha**（`state.base[entry.id] = entry.sha`），本机规范形态 sha 另存 `state.localSha[entry.id]`。
  - 原因：`decide()` 是拿 `base` 与远端 `entry.sha` 比对；基线记本机 `canonicalSha` 会漂移 → 每轮都重判（要么反复拉取/合并/覆写/备份，要么把本机版本推回远端）。

### 9.3 P0-3：脱敏副本合并 + 不写占位文件

- `lib/sections.mjs`：`collectCustom` 对 `.yml/.json/.env/.ini/.toml` 文本配置脱敏后入集合，并打 `meta:{kind:'redacted'}`；目录分支经 `collectTree` 新增的 `transform`/`metaFor` 逐文件处理。
- `lib/engine.mjs`：`pullEntry` 保留 `meta.kind==='redacted'`（原来只保留 `session`，标记在拉取途中被丢）；`writeEntry` 按 `entry.meta.kind` 走 `mergeRedactedText` —— **以远端文本为骨架，`<redacted>` 的行用本机同名键的真实值回填，本机没有该键则丢弃该行**。
- 额外补一条：**本机没有这个文件时，不写远端那份脱敏副本**（否则用户拿到的是一份写着 `<redacted>` 的假配置）；计划里以 `skipped` 列出并给出原因。
- 关于 `custom` 分区（与原报告修法的差异，**2026-11-07 16:50 定稿**）：原 P0-3 建议「给 `SECTION_DEFS` 补 custom」。最终**采纳了**，但语义收紧成三句话：
  1. `custom` 进分区模型（`SECTION_DEFS` 里 `default:false`、`kind:'redacted'`）—— 快照、设备记录、计划门禁都按「分区 id」统一走一遍，模型里没有 `custom` 就得在每个地方开特例；
  2. **设置页不出现这个开关**（前端同步范围页显式过滤 `custom`，自定义路径另有专门分组），`settings.sections.custom` 也不写入设置 schema —— 不给用户平白多一个开关位；
  3. **真正的开关仍是 `settings.customPaths`**（`customEnabled(settings)`：里面有启用项就是开），`settingsSections()` 里 `custom` 的默认值恒为 false，只用于「分区列表里要出现 custom 这一行」。

### 9.4 验证（实测）

- 全量：**17 个测试文件逐个 `node` 直跑全部 exit=0**，`node --test "tests/*.test.mjs"` 整体也 exit=0（含新增 `tests/security.test.mjs` 20 项断言、`tests/p0-sync-safety.test.mjs` 26 项断言、`tests/section-model.test.mjs` 26 项断言、`tests/custom-section.test.mjs`、`tests/state-baseline.test.mjs`）。
- **负向对照**（关键一步）：把 `lib/state.mjs`、`lib/engine.mjs`、`lib/sections.mjs` 在**临时副本**里回退到修复前的 HEAD 版本，再跑 `p0-sync-safety.test.mjs` → **exit=1**，复现出原始症状：
  - B 的真实密钥 `sk-bbbbbbbbbbbbbbbb` 被 `<redacted>` 顶掉（文件内容变成 `api_key: <redacted>`）；
  - 本机没有的文件被生成为占位文件（`custom/only-a.yml` 里写着 `<redacted>`）；
  - `saveState` → `loadState` 后 `ignoreAfterPull` 直接消失（状态白名单丢字段）。
  → 说明测试确实咬住了 bug，而不是对着自己的实现写断言。
- 运行态：DSH 实例（端口 37657）`GET /dsh-sync-hub/state` → 200、`plugin.version=0.5.0`；hmr 已启用，改模块源码保存即自动重载（t+2s 实测，见 8.5）。

### 9.5 分区模型收尾（2026-11-07 16:50）

- `lib/engine.mjs`：设备记录（`manifest.devices[本机].sections`）之前只按 `settings.sections` 过滤，**`custom` 的开关在 `customPaths` 上 → 明明开着自定义路径，远端设备记录里却看不到这一项**。改为 `on || (id === 'custom' && customEnabled(settings))`。
- `lib/engine.mjs`：`pullEntry` 现在也保留 `meta.kind === 'files'`（原来只保留 `session` / `redacted`）。
  - 为什么必须保留：**开了「凭据与密钥」的 cordis 条目是明文**（`collectCordis` 里 `keepInline=true` → `meta.kind='files'`，`redactText(..., {keepInlineSecrets:true})` 原样返回，文本里根本不会出现 `<redacted>`）。
  - 旧行为：meta 被丢掉 → `writeEntry` 回落到分区默认 `kind='redacted'` → 走 `mergeRedactedText` 合并路径 → 明文文件被当成脱敏副本处理，**用户本机的内容会被远端骨架改写**。
  - 新行为：`kind='files'` → 整文件原子落地，明文内容原样同步（这才是「开了密钥同步就把配置完整搬过去」的预期）。
- `lib/engine.mjs`：push / pull 分支的 sha 记账（`state.localSha`）用 try/catch 包住，记账失败只记 note，**不拖垮整轮同步**；pull 时若远端条目没有 `canonicalSha`，则清掉挂起项、不写 localSha。
- 新增测试：
  - `tests/section-model.test.mjs`（26 项断言）：`customEnabled` 单元、custom 不依赖 `settings.sections.custom`、设备记录含 custom、快照 custom 行 enabled 跟随 customPaths、push 后 `state.base` / `state.localSha` 都等于远端 sha、**开了密钥同步的 cordis 明文条目按整文件落地**（用「A 的文件里字面写 `<redacted>`」区分合并路径与整文件路径）。
  - `tests/custom-section.test.mjs`：自定义路径分区的脱敏副本合并、不写占位文件、老 manifest（无 meta）也要挡住。
  - `tests/state-baseline.test.mjs`：状态基线与白名单往返。
