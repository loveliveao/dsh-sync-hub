# 同步中心 UI 重设计 —— 前后端契约（2026-11-07）

> 本文件是本轮实现（用户 8 条需求中的第 1–7 条）的**唯一接口契约**。
> 后端与前端并行实现，必须严格按本文档的字段名 / 类型 / 语义写。
> 第 8 条（本机标签）不在本轮范围。

## 0. 需求 → 实现映射

| # | 用户需求 | 落点 |
|---|---|---|
| 1 | 左侧栏入口没实际作用，看不到是否同步 / 同步了多少；参照「上下文洞察」重设计 | 主面板改成仪表盘（KPI 条 + 卡片）；侧栏图标带状态徽章 |
| 2 | 工作区看不出是否有 git 仓库 | 每个工作区显示 git 状态（isRepo / branch / remote），并提示「有 git 可自行推送」 |
| 3 | 会话没显示是否归档；归档会话同步后要进归档 | 会话行加 archived；会话 meta 携带 archived；拉取后写回归档集合 |
| 4 | 删「这台机器现在怎么样」，直接写「概览」 | 文案改「概览」 |
| 5 | 插件要每插件一行 + 是否单独同步 + 解析插件配置 | 新增 /plugins 端点 + 每插件配置开关 + 解析 config 块 |
| 6 | 概览顺序：DSH 配置 → skill → 插件 → 工作区 → 会话 | SECTION_DEFS 顺序 + 概览页卡片顺序 |
| 7 | 同步范围页重排：插件解析、工作区纳入「工作范围」 | 范围页分三组：DSH 自身 / 插件 / 工作区 |

---

## 1. 新增 / 变更的 HTTP 端点

所有响应统一信封：{ ok: true, data: ... } 或 { ok: false, error: "..." }。

### 1.1 GET /dsh-sync-hub/plugins（新增）

插件清单 + 每个插件在 cordis.patch.yml 里的 config 解析结果。

~~~jsonc
{
  "ok": true,
  "data": {
    "generatedAt": "2026-11-07T12:00:00.000Z",
    "plugins": [
      {
        "key": "dsh-context",            // 插件键 = 包名；无 name 的条目用 id 兜底
        "name": "dsh-context",           // 包名或 id
        "version": "0.82.0",             // 来自 profile package.json dependencies；未知为 null
        "installed": true,               // 是否在 profile dependencies 里
        "hasConfig": true,               // cordis.patch.yml 里该条目是否有 config 块
        "configKeys": ["context", "watch"],   // config 顶层键（数组，可能为空）
        "configPaths": ["context.depth"],      // 二级路径（最多两层），给人看
        "config": { "context": { "depth": 3 } }, // 解析后的配置（敏感值已脱敏），无 config 时为 null
        "redacted": true,                // 是否命中过脱敏
        "state": "synced",               // off | pending | synced | changed | new
        "syncEnabled": true,             // settings.pluginConfig.switches[key] 的值
        "bytes": 128                     // 该插件配置副本的大小（字节）
      }
    ],
    "totals": { "plugins": 17, "withConfig": 9, "enabled": 2 }
  }
}
~~~

语义约定：
- state 与现有 compareWithBase 口径一致：off（开关关闭 / 未配置）、new（本机有、基线没有）、changed（与基线不同）、synced（与基线一致）、pending（开关开着但还没纳入基线）。
- config 必须脱敏：命中敏感键（key / token / secret / password / cookie / auth / apiKey 等）的值替换成掩码；脱敏后仍要能正常 JSON 序列化。
- 解析器不得依赖第三方 YAML 包（profile 的 node_modules 里没有 yaml / js-yaml）：自研行级解析器，只处理 cordis.patch.yml 实际形状（顶层 - id: / - name: / config: 缩进块）。

### 1.2 GET /dsh-sync-hub/workspaces（既有，响应结构扩展）

data 新增 / 变更字段：

~~~jsonc
{
  "workspaces": [
    {
      "key": "dsh-sync-hub",
      "path": "D:\\dsh-sync-hub",
      "title": "dsh-sync-hub",
      "registered": true,
      "enabled": true,
      "git": {                       // 新增
        "isRepo": true,
        "hasRemote": true,
        "remote": "https://github.com/owner/repo.git",  // 已去除凭据
        "branch": "master",
        "detached": false
      },
      "sessionCount": 12,
      "archivedCount": 3,            // 新增
      "pendingCount": 2,             // 新增
      "bytes": 12345678,
      "sessions": [
        {
          "id": "sessions:session-xxx",
          "sessionId": "session-xxx",
          "project": "--D-dsh-sync-hub--",
          "rel": "sessions/session-xxx/session.v4.jsonl.zstd",
          "title": "会话标题",
          "cwd": "D:\\dsh-sync-hub",
          "bytes": 1234,
          "updatedAt": "2026-11-07T10:00:00.000Z",
          "createdAt": "2026-11-07T09:00:00.000Z",
          "sha": "...",
          "sync": "pending",          // off | pending
          "reason": "...",
          "archived": true            // 新增
        }
      ]
    }
  ],
  "unassigned": [ /* 同结构（无 git 字段时为 null） */ ],
  "plugins": [
    { "key": "dsh-context", "name": "dsh-context", "version": "0.82.0", "state": "synced",
      "hasConfig": true, "configKeys": ["context"], "syncEnabled": true }   // 新增 hasConfig / configKeys / syncEnabled
  ],
  "totals": {
    "workspaces": 3, "unassigned": 1, "sessions": 55, "bytes": 36900000,
    "synced": 40, "changed": 2, "pending": 5, "off": 8,
    "archived": 34                    // 新增
  }
}
~~~

### 1.3 POST /dsh-sync-hub/settings（既有，请求体扩展）

在现有 settings 基础上新增一个命名空间：

~~~jsonc
{
  "pluginConfig": {
    "enabled": false,                     // 总开关：是否同步「插件配置副本」
    "switches": { "dsh-context": true }   // 每个插件单独开关
  },
  "workspaces": {
    "switches": { "dsh-sync-hub": true },  // 既有
    "map": {}
  }
}
~~~

- pluginConfig.enabled 默认 false（不改变现有行为）。
- pluginConfig.switches[key] = true 且 pluginConfig.enabled = true 时，该插件的 config 才会被采集。
- 归一化：normalizeSettings 必须对 pluginConfig 做类型收敛（非法值回落到默认，不抛异常）。
- **安全约定**：插件配置只以「副本 / 报告」形式同步（落到 sync-hub/reports/plugin-config/<key>.yml），**绝不自动改写对方机器的 cordis.patch.yml** —— 自动改写可能让对方 DSH 起不来。

### 1.4 其余端点

/state（= /status）、/sessions、/analysis、/backups、/secret、/test、/plan、/run 语义不变。
/state 的 sections[] 数组顺序按第 3 节调整（前端概览页直接用这个顺序渲染）。

---

## 2. 新增后端能力

### 2.1 工作区 git 状态（lib/git-info.mjs 新建）

~~~js
export function detectGitRepo(rootDir) // -> { isRepo, hasRemote, remote, branch, detached }
~~~
- 只读文件，不调用 git 命令、不产生任何副作用。
- .git 是目录或文件（worktree）都算仓库。
- remote 从 .git/config 里取第一个 [remote "x"] url =；**必须去掉凭据**（https://user:pass@host/... → https://host/...）。
- branch 从 .git/HEAD 取 ref: refs/heads/<branch>；若是裸 sha 则 detached = true。
- 任何异常都返回 { isRepo:false, hasRemote:false, remote:null, branch:null, detached:false }，不抛。

### 2.2 会话归档（lib/archive.mjs 新建）

~~~js
export function readArchivedSessionIds()        // -> string[]，读 storages/workspace.json global.archivedSessionIds
export function applyArchivedSessionIds(ids, opts) // -> { added: string[], skipped: string[], error?: string }
~~~
- 数据源：$DSH_HOME/storages/workspace.json 的 global.archivedSessionIds。
- applyArchivedSessionIds：**只增不减**（避免把对方机器手动取消归档的状态抹掉）。
  写入流程：读原文件 → 备份到备份目录 → 合并数组（去重、保序）→ 原子写回（保持 2 空格缩进、保留其余字段原样）→ 失败只记 error，**绝不抛异常**。
- readArchivedSessionIds 失败 → 返回 []。

### 2.3 插件配置解析（lib/plugin-config.mjs 新建）

~~~js
export function parsePluginConfigs(patchText) // -> [{ id, name, key, hasConfig, configKeys, configPaths, config }]
export function loadPluginConfigs()           // -> 同上（自己读 profile cordis.patch.yml）
~~~
- 行级解析器，识别顶层 - id: / - name: / 缩进 config: 块；支持嵌套 map、标量、!!js 表达式（按字符串原样保留）、行内注释。
- 值解析：数字 / 布尔 / 字符串自动识别；复杂结构原样保留字符串。
- 敏感键脱敏：键名匹配 /(key|token|secret|password|passwd|cookie|auth|credential|apikey)/i → 值替换为掩码；注意 apiKeyEnv 是环境变量名，不要脱敏。
- 解析失败 → 该条目降级为 { hasConfig:false, config:null }，不影响其它条目。

### 2.4 同步范围调整（lib/sections.mjs）

- SECTION_DEFS 新顺序（同时决定 /state 的 sections[] 与概览页顺序）：
  cordis → skills → plugins → pluginConfig → workspaces → sessions → secrets → pluginData
- 新增段 pluginConfig：kind = files、default = false、desc 说明「插件配置副本（不会改写对方 DSH 配置）」。
- 采集器 collectPluginConfig：
  - 仅当 settings.pluginConfig.enabled 为真且该插件 settings.pluginConfig.switches[key] 为真时采集。
  - 条目 id：plugin-config:<key>；rel：sync-hub/reports/plugin-config/<key>.yml；内容 = 解析后脱敏的 YAML 文本；sha 走正常逻辑。
  - 该段计入 sections[].count。
- collectSessions：meta 增加 archived: true|false（来自 readArchivedSessionIds()）。
- collectWorkspaces：产出的 storages/workspaces.report.json advisory 报告里带上 git 信息与归档计数。

### 2.5 拉取后写回归档（lib/engine.mjs）

- writeSessionEntry 成功落盘后，若 entry.meta.archived === true → 把该 sessionId 记入待归档集合。
- runSync 的 pull 阶段结束后，对待归档集合调用 applyArchivedSessionIds；结果写进 notes（成功：已归档 N 个会话；失败：归档同步失败：<原因>）。
- 任何异常都不能中断同步（try/catch 包裹）。

### 2.6 防御性要求（AGENTS.md 硬规则）

- 新模块的所有公开函数都不得抛异常；失败返回降级值 + 记日志。
- lib/tools.mjs 已有 safeExecute；新增能力若有工具暴露，同样走 safeExecute。
- 新增能力必须有单测（tests/ 下），且不能依赖真实用户 DSH_HOME（测试里把 DSH_HOME 指向临时目录）。

---

## 3. 前端改造（client.js）

### 3.1 文案
- analysisTitle 与 treeTitle：'这台机器现在怎么样' → '概览'（两处都要改）。

### 3.2 侧栏入口（需求 1）
- 侧栏槽位只能渲染图标（官方契约：renderSlot('sidebar.panellist', ..., { only: id }) 只放图标组件）。
- 因此：**在图标组件内部**画一个状态徽章（小圆点）：
  - 无远端 / 未配置 → 灰点
  - 上次同步成功且无待同步 → 绿点
  - 有待同步条目 → 琥珀点
  - 同步出错 → 红点
- 徽章状态来自共享 store 的 status；图标组件自己订阅 store 变化并重渲染（React 本地 state + store.subscribe）。
- 数据新鲜度：共享一个 30 秒轮询 /state 的 statusWatcher（全局单例，不要每个组件各开一个定时器）。轮询失败静默重试，不打断 UI。
- 侧栏 label 文本保持静态（官方 slot 契约：label 只在订阅 / locale 变化时算一次，不能放动态状态）。

### 3.3 主面板 = 仪表盘（需求 1，参照 dsh-context）
结构（自上而下）：
1. **标题区**：概览 + 副标题（同步状态一句话，如「上次同步 2 小时前 · 40 项已同步」）。
2. **KPI 条**：5–6 个指标块 —— 已同步条目 / 待同步 / 会话 / 工作区 / 插件 / 占用空间。
3. **卡片区**（每张卡片：标题 + 一行摘要 + 明细 + 操作按钮）：
   - 「同步状态」：传输方式、目标（路径 / 仓库）、上次同步时间、推送 / 拉取 / 冲突数、按钮「立即同步」「查看计划」。
   - 「同步范围」：按 /state 的 sections[] 顺序（cordis→skills→plugins→pluginConfig→workspaces→sessions→secrets→pluginData）列出各段，每段显示开关状态与条目数；点击跳到「同步范围」页。
   - 「工作区」：每个工作区一行：名称、git 徽章（git · master / 无 git）、会话数、已同步 / 待同步、归档数、开关（改 settings.workspaces.switches）。有 git 的工作区加提示「有 git 仓库，可自行推送」。
   - 「插件」：每个插件一行：名称、版本徽章、有配置 / 无配置、配置键数、开关；点击进入「插件」页签。
   - 「会话」：最近会话列表：标题、cwd、时间、**归档徽章**、同步状态徽章。
4. 数据来源：/state（KPI、sections）、/workspaces（工作区 / 会话 / 插件）、/plugins（插件页详细）。

### 3.4 工作区行（需求 2）
- 每行显示 git.isRepo ? 'git · ' + (branch || 'detached') : '无 git' 徽章；hasRemote 为真时显示 remote 主机名。
- 文案区分：有 git（可自行推送） / 无 git（只能靠本插件同步）。

### 3.5 会话行（需求 3）
- 归档会话显示「归档」徽章（不同颜色），与普通会话视觉上可区分。

### 3.6 插件页 / 范围页（需求 5、7）
- 「插件」页签（新增）：每插件一行 = 名称、版本、是否安装、有配置徽章、配置键摘要、**单独同步开关**（写 settings.pluginConfig.switches[key]）、状态徽章（synced / changed / pending / off）。
- 「同步范围」页签重排为三组：
  1. **DSH 自身**：配置（cordis）、技能（skills）、会话（sessions）、密钥（secrets）开关 + 会话高级设置（maxBytes / maxAgeDays / excludeIds）。
  2. **插件**：总开关「同步插件配置」+ 每个插件一行开关（总开关关时整组置灰）。
  3. **工作区**：每个工作区一行开关 + git 状态提示。
- 传输方式（local / git / webdav）设置保留在范围页底部或独立小节。

### 3.7 健壮性
- 前端必须容忍后端字段缺失（git 为 null、archived 缺失、/plugins 请求失败 → 插件区显示「插件信息暂不可用」），不能白屏。
- 所有新增请求都要有 loading / 错误态。

---

## 4. 交付与验收

- 后端：新增 / 改动模块的单测；node tests/*.test.mjs 全绿（现有 8 个文件不能挂）。
- 前端：client.js 改动后用 ui_check 静态检查能列出新增控件。
- 端到端：用 minihost 起隔离实例，验证 /plugins 200、/workspaces 含 git / archived 字段、非法输入返回 500 JSON 而不是崩溃。
- 提交：分两个 commit（后端 / 前端），都不改用户 DSH 配置。