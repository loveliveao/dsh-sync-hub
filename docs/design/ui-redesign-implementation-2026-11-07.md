# 同步中心 UI 重设计 · 实现说明（用户 8 条需求第 1–7 条）

- 日期：2026-11-07
- 契约：`docs/design/ui-redesign-contract-2026-11-07.md`
- 状态：第 1–7 条已实现并实测通过；第 8 条（本机标签）等 Q1HY 装好后另做。

## 一、需求对照

| # | 需求 | 落地方式 | 位置 |
|---|------|---------|------|
| 1 | 左侧栏入口要有实际作用，能看到是否同步、同步了多少 | 侧栏改成一级面板图标（图标内嵌状态圆点）；面板本体改成「概览」仪表盘：6 块 KPI（已同步 / 待同步 / 会话 / 工作区 / 插件 / 占用）+ 5 张卡片 | `client.js`（`SyncIcon` / `KpiTile` / `Dashboard*Card` / `Panel`） |
| 2 | 配置中心要看出工作区有没有 git 仓库、能否自己推送 | 工作区新增 `git{isRepo,hasRemote,remote,branch,detached}`，卡片上挂 `GitBadge`（可自行推送 / 需靠本插件同步） | `lib/git-info.mjs`、`lib/workspaces.mjs`、`client.js` |
| 3 | 会话要显示是否归档，同步后归档会话也要进归档 | 会话行新增 `archived`；同步拉取后回写归档集合 | `lib/archive.mjs`、`lib/engine.mjs`、`lib/workspaces.mjs` |
| 4 | 删掉「这台机器现在怎么样」，直接写「概览」 | ZH/EN 文案都改成「概览」 | `client.js` 文案区 |
| 5 | 每个插件一行，最好能解析插件配置 | 新增 `GET /plugins`：每个插件一行，含 `hasConfig / configKeys / config / redacted / state / syncEnabled` | `lib/plugin-config.mjs`、`lib/server.mjs`、`client.js` |
| 6 | 概览顺序：DSH 配置 → skill → 插件 → 工作区 → 会话 | `SECTION_DEFS` 顺序改为 cordis → skills → plugins → pluginConfig → workspaces → sessions → secrets → pluginData；主面板卡片顺序与 MachineTree 一致 | `lib/sections.mjs`、`client.js` |
| 7 | 同步范围页要重排，把插件解析、工作区纳入 | 设置区范围页分三组：DSH 自身 / 插件 / 工作区 | `client.js` |

## 二、后端新增与改动

- `lib/git-info.mjs`：`detectGitRepo(rootDir)`、`stripGitCredentials(url)`。只读 `.git/config`、`.git/HEAD`，不调 git 命令；异常降级为 `{isRepo:false,...}`。
- `lib/archive.mjs`：归档集合读写（见第三节）。
- `lib/plugin-config.mjs`：自研行级 YAML 解析器（不依赖 yaml / js-yaml），解析 profile `cordis.patch.yml` 里每个插件的 `config` 块，支持嵌套 map、列表（含列表里的 map）、`!!js` 原样保留、行内注释；敏感键脱敏（`apiKeyEnv` 这类环境变量名不脱敏）。
- `lib/sections.mjs`：段顺序调整 + 新增 `pluginConfig` 段（kind=files、默认关）+ `collectPluginConfig`（只同步**副本**，落到 `sync-hub/reports/plugin-config/<key>.yml`）+ 会话 `meta.archived`。
- `lib/state.mjs`：`sections.pluginConfig=false`、`pluginConfig{enabled:false,switches:{}}`，`normalizeSettings` 非法值回落默认不抛。
- `lib/workspaces.mjs`：`buildTree` 增加 `git` / `archivedCount` / `pendingCount` / 会话 `archived` / `totals.archived` / `plugins[]` 扩展。
- `lib/server.mjs`：新增 `GET /plugins`（异常仍走统一 catch → 500 JSON）。
- `lib/degraded.mjs`：降级 Hub 补 `plugins()` 桩。
- `lib/privacy.mjs`：放行 `sync-hub/reports/plugin-config/*.yml`（插件自留目录整体禁传，只放开这份只读副本）。

## 三、归档写入：宿主服务优先，文件兜底

宿主 `ctx.workspaceRegistry.archiveSession(id)` 是归档的权威 owner：它会持久化、推送 frame 让客户端立刻刷新，还���校验会话是否存在 / 是否在活动。直接改 `storages/workspace.json` 会被宿主下一次持久化覆盖，界面也不刷新。

因此 `lib/archive.mjs` 的策略是：

1. `registryOf(ctx)` 用 `ctx.get('workspaceRegistry')` 取真实服务实例（不直接摸 `ctx.workspaceRegistry`，避免拿到 Cordis 的空服务代理导致兜底路径失效）；
2. 逐个会话调 `archiveSession()`；**任何失败**（不认识该会话 / 会话在活动 / 服务整体不可用）都退回文件实现补记（只增不减，最坏被宿主下次持久化覆盖），并把原因写进 `error`；
3. 文件路径仍然「写前备份到 `sync-hub/backups/<时间戳>/`、只增不减、其它字段原样保留」；
4. 读侧 `readArchivedSessionIds(ctx)` 同样以服务为准。

引擎侧 `runSync({state, transport, version, ctx})` 在拉取阶段结束后回写归档，notes 区分「已归档 N 个会话」与「部分未成功：原因」。

## 四、前端改造（`client.js`）

- 侧栏：`ctx.slots.inject('sidebar.panellist', ...)` 注册图标，图标内画状态圆点（synced / changed / pending / off）；动态状态靠 30s 轮询 `/state` 刷新（侧栏 slot 的 label 只在订阅变化时求值，动态文字放不进去）。
- 主面板 `main` 槽：标题「概览」+ KPI 条 + 5 张卡片（同步状态 / 同步范围 / 插件 / 工作区 / 会话）。
- 设置区 `settings.section`：四个页签（概览 / 同步范围 / 插件 / 传输通道）；范围页三组（DSH 自身 / 插件 / 工作区）+ 自定义路径 + 底部传输方式。
- MachineTree 顺序：DSH 配置 → 技能 → 插件 → 工作区（含其下会话）→ 未归属。
- 字段缺失一律降级（隐藏该卡片或显示「—」），不白屏。

## 五、实测验证

- 测试：13 个测试文件全部 exit=0（含新增 `git-info` / `archive` / `archive-registry` / `plugin-config` / `contract-endpoints`）。
- 隔离实例（minihost，端口 31890，未碰用户运行中的 DSH）：
  - `GET /dsh-sync-hub/plugins` → 200，28 个插件，totals `{plugins:28,withConfig:14,enabled:0}`；凭据已掩码（`redacted:true`），`apiKeyEnv` 未被误脱敏。
  - `GET /dsh-sync-hub/workspaces` → 200，`totals.archived=34`；`dsh-sync-hub` 工作区 `git={isRepo:true,hasRemote:false,branch:master}`，`VibeCoding` `git={isRepo:true,hasRemote:true,remote:https://github.com/loveliveao/VibeCoding.git,branch:main}`，会话行 `archived` 正确。
- 真实 profile 只读解析：270+ 行 `cordis.patch.yml` 解析出 17 条，无一条降级失败。

## 六、注意事项（前端不要踩）

1. `/plugins` 的列表是「profile 依赖 ∪ 补丁里有 config 的条目」，**会包含未安装插件**（`installed=false`、`version=null`）；区分已装 / 未装请用 `installed`。
2. `/workspaces` 里 `plugins[].state` 与 `/plugins` 里按配置副本算出的 `state` 是**两套基线**，不要混用。
3. `state.sections.pluginConfig` 只是 `pluginConfig.enabled` 的镜像，前端读后者即可。
4. 插件配置**只同步副本**，绝不自动改写对方机器的 `cordis.patch.yml`（可能让对方 DSH 起不来）。

## 七、遗留

- 第 8 条「同步时带上本机标签」：等用户在 Q1HY 装好后另做。
- 发布准备（git remote / tag / CI）：用户已说暂时不发布。
- `docs/workspace-check-2026-11-07.md` 第七节的 P0 安全项（鉴权 / Origin / Content-Type、会话覆盖）仍未修。
