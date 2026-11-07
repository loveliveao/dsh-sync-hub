# dsh-sync-hub · 同步中心

在多台电脑之间同步 DeepSeek Harness 的**配置**与**会话**，明确区分「哪些同步、哪些不同步」，
并且**默认不带走任何凭据**（需要时可以在界面里手动打开）。

界面有两个入口：

- **左侧导航「同步中心」** —— 日常同步台：状态条、下一步引导、一键同步、同步范围快捷开关、待同步摘要。
- **设置 → 同步中心** —— 配置中心，三个页签：**概览**（本机现状分析 + 计划与备份 + 隐私说明）、
  **同步范围**、**传输通道**。

---

## 一、它解决什么问题

`~/.dsh` 目录 1.3 GB，其中真正值得跨机携带的只有约 **26 MB**（96% 是会话记录）。
直接同步整个目录既慢又危险：`node_modules` 有 800 MB 以上、里面还有两份重复的 MSYS2 工具链，
凭据文件则默认不该离开本机。

同步中心做四件事：

1. **盘点**：把 DSH 版本、profile、已装插件、会话清单读出来，显示每一项的体积，并明确列出「故意不同步」的目录。
2. **比对**：本地与远端各有一份 sha 清单，算出「要推送 / 要拉取 / 冲突 / 已一致」。
3. **应用**：按你勾选的范围推送与拉取，写入前先备份，冲突按策略处理。
4. **引导**：告诉你下一步该做什么，而不是丢一堆开关给你。

## 二、安装

### 从 GitHub 装（推荐）

```bash
# 装进指定 profile（插件是组合包）
dsh plugin --profile <profile> add github:loveliveao/dsh-sync-hub

# 锁定某个版本
dsh plugin --profile <profile> add github:loveliveao/dsh-sync-hub#v0.5.0
```

### 从 npm 装

```bash
dsh plugin --profile <profile> add dsh-sync-hub
```

### 本地开发

```bash
dsh plugin --profile <profile> add file:D:\dsh-sync-hub
```

源码仓库：<https://github.com/loveliveao/dsh-sync-hub>（MIT 许可证，零运行时依赖，只用 `node:*` 内置模块）。

> `desktop` profile 由 Electron 独占管理，命令行装不进去（会报
> `profile "desktop" is managed exclusively by the Electron application`）。
> 桌面版请用 **设置 → 插件 → 导入本地插件**（或插件管理器的 install_bundle），
> 装完**重启 DSH** 才会加载；之后用「卸载 → 重新安装」即可热更新到新代码。

装好后有两个入口：左侧导航的 **同步中心**（日常同步台）和 **设置 → 同步中心**（配置中心）。
卸载：在插件管理器里移除 `dsh-sync-hub`。

没有运行时依赖（只用 `node:*` 内置模块），因此不会往 profile 里引入任何第三方包。

#### 修好「应用市场装插件报 EPERM」

`desktop` profile 里本插件若以 `file:` 目录依赖登记，pnpm 每次装别的插件都会重新导入它，
用 `rename` 覆盖 `node_modules` 下已存在的目录链接 —— Windows 不允许 rename 覆盖目录链接，
于是**装任何插件都失败**（`[ERR_PNPM_EPERM] ... rename`）。改成 `link:` 协议即可
（pnpm 只维护链接、不再重新导入，插件仍直连工作区，热重载与本地开发不受影响）：

```bash
node scripts/repair-profile-link.mjs            # 演练：只打印将要做的改动
node scripts/repair-profile-link.mjs --apply    # 实际执行（先自动备份到 <DSH_HOME>/plugin-backups/）
```

> 该脚本会写 profile 的 `package.json` / `pnpm-lock.yaml` / `node_modules/.modules.yaml`，请自行确认后再执行。

## 二之二、它会访问什么（安全声明）

给审核者看的一页速览：插件只在你装了它的那台机器上工作，不自带后台进程，不常驻外联。

- **读**：你的 `$DSH_HOME` 里被你勾选的目录（配置、插件清单、技能、会话），只读盘点，不改。
- **写**：远端同步目标（共享文件夹 / Git 仓库 / WebDAV），以及本机 `~/.dsh/sync-hub/`（状态、清单、备份）。
- **外联**：只有你主动点「检查连接」或「同步」时才连接**你填的**远端地址；不连任何第三方服务，不打点，不埋遥测。
- **环境变量**：仅 Git 通道把令牌通过 `GIT_CONFIG_*` 注入**那一个 git 子进程**；令牌不进命令行、不进 `.git/config`、不回传界面。
- **凭据文件**：`.credentials.yaml` 等默认**不读不传**；只有在「同步范围」里显式打开「凭据与密钥」才会带上，私钥类文件任何时候都不传。
- **覆盖前必备份**：被覆盖的文件先复制到 `~/.dsh/sync-hub/backups/<时间戳>/`（默认保留最近 20 份）；远端只增不减，本机也不会因为远端缺文件而删除本地数据。

## 三、同步范围（默认值）

配置中心 → **同步范围** 页逐段开关；左侧导航的主面板上也有同名快捷开关，改完立即保存。

| 范围 | 内容 | 默认 | 说明 |
| --- | --- | --- | --- |
| DSH 配置 | `profiles/<profile>/cordis.patch.yml`、`cordis.yml` | 开 | 模型提供商、界面、插件参数；**字面量密钥导出时脱敏**为 `<redacted>` |
| 插件清单 | profile `package.json` 的依赖与 bundles | 开 | **只读上报**，绝不自动安装（bundles 里的未安装项会让 DSH 启动失败） |
| 插件配置副本 | 各插件在 `cordis.patch.yml` 里的 `config` 块 | **关** | **只读副本**：解析 + 脱敏后写到 `sync-hub/reports/plugin-config/<插件>.yml`，**绝不改写对方的 DSH 配置**（见下方说明） |
| 技能库 | `~/.dsh/skills` 整棵树 | 开 | 技能里若写了密钥，导出时同样脱敏 |
| 会话 | `~/.dsh/sessions/**/session.v4.jsonl.zstd` | 开 | 按会话合并，**不会删除**另一台机器的会话 |
| 凭据与密钥 | `.credentials.yaml`、密钥库、网关 key | **关** | 默认关闭；开启后这些文件与配置里的明文密钥会一起上传（见下方「凭据开关」） |
| 工作区列表 | `storages/workspace.json` 摘要 | 关 | 只读上报：工作区路径跨机通常无意义 |
| 插件数据 | 市场 / 插件管理器等状态目录 | 关 | 可能含本机路径 |
| 自定义路径 | 你填的、相对 `~/.dsh` 的路径 | 关 | 文件和目录都行，文本类会脱敏 |

### 凭据开关

「凭据与密钥」默认关闭。打开后（界面里会明确列出将要上传的文件）：

- 允许上传 `.credentials.yaml`、`dsh-config-manager/vault/.credentials.yaml`、`openai-gateway/api-key`；
- 配置里的**内联明文密钥**（例如 `cordis.patch.yml` 里写死的 API key）不再脱敏，一并带走，
  这样另一台机器换机后不需要重新输入；
- **另一台机器也要打开这个开关**，否则拉回来的文件不会被写回。

无论开关怎么开，以下内容**永远不同步**：私钥类文件（`*.pem` / `*.p12` / `*.pfx` / `*.key` /
`id_rsa` / `id_ed25519` / `id_ecdsa` / `id_dsa`）、`.env*`、`.netrc`、以及插件自己的 `~/.dsh/sync-hub/`。

**公开仓库闸门**：用 Git 通道时，如果远端仓库「不用登录就能读」（也就是公开仓），
而你又打开了「凭据与密钥」，同步会被**直接拦住**，并在计划页写明原因。
公开仓 + 明文 key 等于把 key 发给所有人，所以这里不给「先推了再说」的选项。
处理办法：把仓库改成私有，或者先关掉凭据开关。

### 插件配置副本（只读副本，不改对方配置）

「插件配置副本」默认关闭。它把 `profiles/<profile>/cordis.patch.yml` 里每个插件的 `config` 块
用自研的行级 YAML 解析器读出来（不依赖 `yaml` / `js-yaml`），敏感键（`key` / `token` / `secret` /
`password` / `cookie` / `auth` / `credential` 等）替换成 `<redacted>`，而 `apiKeyEnv` 这类
**环境变量名**保持原样，然后作为**副本**写到 `sync-hub/reports/plugin-config/<插件名>.yml`。

- 它只是「让对方看一眼本机插件配了什么」，**不会**把配置写回对方的 `cordis.patch.yml`；
- 总开关 `pluginConfig.enabled` 关着时一条都不采；打开后还要给每个插件单独打开
  `pluginConfig.switches[<插件包名>]`；
- 单个插件解析失败只降级成「无配置」，不影响其它插件。

### 始终排除的清单

`.credentials.yaml*`、`auth|oauth|token|secrets.json`、`.env*`、`.netrc`、私钥文件
（除非你在「凭据与密钥」里明确打开该项）。

## 三之二、工作区分层同步

会话是按**工作区**分组的，所以同步范围可以细到「哪个工作区同步、哪个不���步」。

### 概览页的「本机现状」是一棵可展开的树

```
工作区 1 · 会话 51 · 35.69 MB · 已同步 0 · 有改动 0 · 待推送 51 · 不同步 0
├ VibeCoding  D:\VibeCoding                 40 条 · 32.95 MB   [开关]
│   ├ 开发 DSH 配置与会话同步插件  7.34 MB   待推送
│   ├ 帮我操作这个文件            1.49 MB   待推送
│   └ …
├ 未归属工作区
│   ├ default-workspace  D:\Personal\Documents\deepseek-harness\default-workspace   4 条
│   ├ Desktop            D:\Personal\Desktop                                     6 条
│   └ workspace          C:\Users\HUAWEI\.dsh\bot\workspace                       1 条
插件 17 个（带版本） · 技能 1 个（27.2 KB）
```

- 展开任意工作区，能看到**每一条会话**，最右侧是「是否同步」标签：
  `已同步` / `有改动` / `待推送` / `不同步`（附一句原因，例如「所属工作区已关闭同步」）。
- **未归属工作区**：这些会话的目录不在任何已注册工作区里。它们**仍然会同步**，
  但在界面上单列一组；要归到某个工作区，去「同步范围」里手动指定一次即可。

### 每个工作区一个开关

「同步范围」页有一块「按工作区分别同步」：每个工作区一行，带开关、会话数与体积，
以及跨机目录映射输入框。关掉某个工作区，**它的会话就不进同步集合**（不是「同步了但跳过」）。

工作区身份 = **目录名**（例如 `VibeCoding`），这是跨机匹配的依据。

### 跨机目录不同怎么办

两台机器上同一个工作区可能不在同一个盘符或路径。同步中心按目录名自动匹配；
匹配不上时，可以在「同步范围 → 按工作区分别同步」里填一次本机目录并**记住这个映射**。

拉取时会发生两件事：

1. 会话文件里的 `cwd`（会话创建时写死的绝对路径）被**改写成目标机的目录**；
2. 文件被搬到目标机对应的会话目录（DSH 要求文件所在目录名与 `cwd` 一致，
   只改内容不搬目录会被判定为损坏的会话记录）。

会话内容在清单里按「**把 cwd 抹掉后的样子**」比对，所以两台机器路径不同也不会
每次都判成冲突、改一次就变一次。

### 同步仓库和你自己的 git 仓库是两回事

同步中心用 Git 通道时，工作副本放在 `~/.dsh/sync-hub/remote-git/`，
**只推 DSH 自己的 `manifest.json` 与 `blobs/`**，不会碰你工作区里的 `.git`，
也不会把你的项目代码混进同步仓库。

## 四、传输通道（三种，任选其一）

1. **共享文件夹** —— OneDrive / 坚果云 / NAS 同步盘的某个目录。最简单，适合两三台机器。
   三台机器填**同一个目录**（各自本机路径可以不同，指向同一份云端同步内容即可）。
2. **Git 仓库** —— 任意私有仓（GitHub / Gitee / 自建）。有历史、天然支持多机合并。
   私有仓的令牌存在 DSH 凭据库里，**不写进 `.git/config`**，也不回传界面。
   令牌也不进 git 的命令行参数（命令行在进程列表里全机可见）：认证头通过
   `GIT_CONFIG_*` 环境变量注入，只给这一个子进程。
3. **WebDAV** —— 坚果云、Nextcloud、群晖等。填服务器地址 + 用户名 + 密码。

目标目录的布局：

```
manifest.json                         # 条目清单：路径、sha256、大小、来源设备
blobs/ab/abcdef...                    # 内容寻址的 blob，按 sha 前两位分桶
```

因为按内容寻址，同一份会话在两台机器上只存一份；远端只增不减，删除不会跨机传播。

### 「检查连接」在检查什么

传输通道页点「检查连接」后，会逐条告诉你这一步在做什么、结果如何（失败时给的是原因，不是错误码）：

- **本地文件夹**：目标文件夹存在 → 可读（能列目录）→ 可写（写入并删除探针文件）→ 剩余空间 → 同步库状态（已有多少条目、来自几台设备，还是空目录）。
- **Git 仓库**：仓库可访问（401/403=令牌不对或没权限，404=仓库名错或没授权，主机解析失败=网络不通）→ 认证 → 分支是否存在 → 仓库是否公开（公开仓会给出警告）。
- **WebDAV**：地址格式 → 认证（401=账号密码不对，403=没有写权限）→ 目录是否存在（404 时首次同步会自动创建）→ 能否写入。

## 五、冲突与备份

- **先预览再同步**：概览页的**预览变更**只读远端、算差异，不写任何文件；上传清单逐条列出路径与体积。
- **冲突策略**：保留更新的（按修改时间）/ 保留本机 / 保留远端 / 跳过。
- **DSH 配置不按行合并**：`cordis.patch.yml` 会被 config-manager 这类插件整文件重写，
  行级合并会毁掉 YAML。同步时按顶层条目 id 结构化合并，脱敏段用「键名对齐」还原
  （远端是 `<redacted>`、本机有同名键时用本机的值）。
- **写入前备份**：被覆盖的文件先复制到 `~/.dsh/sync-hub/backups/<时间戳>/<原相对路径>`，
  默认保留最近 20 份，可在概览页调整。

## 六、界面怎么用

**左侧导航「同步中心」（主面板，日常用这个）**

1. 顶部状态条：传输通道、同步目标、上次同步时间、本机一共多少项多大。
2. **下一步**：根据当前状态只给一条指引（没设目标 → 先去设通道；缺令牌 → 先填令牌；
   没检查过 → 先检查连接；有变更 → 先预览；有冲突 → 先定策略）。
3. **待同步**：↑上传 / ↓下载 / ⚠冲突 / ⤼跳过 四枚计数，配「预览变更」和「同步」按钮。
4. **同步范围**：逐段开关（含「插件配置副本」），改一下立即保存。

**设置 → 同步中心（配置中心）**

- **概览**：折叠的「这台机器现在怎么样」（工作区、插件、技能、会话数量与体积、
  **故意不同步**的目录及体积、凭据文件清单——只列路径和大小，不读取内容）；
  计划与备份（冲突策略、备份份数、预览、同步、备份列表）；隐私说明。
- **同步范围**：各范围的开关与逐条说明、**按工作区分别同步**（每工作区开关 + 跨机目录映射）、
  会话体积/天数限制、自定义路径。
- **传输通道**：三种通道三选一、参数、令牌、连接检查清单。

## 七、给 Agent 用的工具

| 工具 | 作用 |
| --- | --- |
| `sync_hub_status` | 本机版本、设备、各范围条目数与体积、远端概况、凭据是否已配置 |
| `sync_hub_plan` | 只算差异，返回 push / pull / conflict 列表 |
| `sync_hub_run` | 执行一次同步，返回推送/拉取/冲突/失败数 |
| `sync_hub_sessions` | 列出会话（标题、工作区、大小、是否已在远端） |

HTTP 接口（前缀 `/dsh-sync-hub`）：`GET /state`、`GET /status?remote=1`、`GET /analysis`、
`GET /sessions`、`GET /plugins`、`GET /workspaces`、`GET /backups`、`POST /settings`、`POST /secret`、
`POST /test`、`POST /plan`、`POST /run`。

`GET /plugins` 列出本机插件清单与配置状态：

```json
{ "ok": true, "data": { "generatedAt": "...", "plugins": [{ "key": "@deepseek-ai/dsh-llm-pi-ai", "name": "@deepseek-ai/dsh-llm-pi-ai", "version": "1.6.0", "installed": true, "hasConfig": true, "configKeys": ["providers"], "configPaths": ["providers"], "config": {}, "redacted": true, "state": "pending", "syncEnabled": false, "bytes": 0 }], "totals": { "plugins": 1, "withConfig": 1, "enabled": 0 } } }
```

`key` 是插件包名（没有包名时退回配置里的 id），`version` 取自 profile `package.json`（未知为 `null`），
`config` 已脱敏，`state` 取 `off` / `pending` / `synced` / `changed`。

`GET /workspaces` 除了工作区与会话树，还带上每个工作区的 `git` 信息
（`{ isRepo, hasRemote, remote, branch, detached }`，远端地址会去掉凭据）、`archivedCount`、
`pendingCount`；会话行带 `archived`，`totals.archived` 是已归档会话数。

## 八、不做的事（边界）

- **不同步浏览器端设置**：主题、快捷键、侧边栏布局存在浏览器 localStorage 里，插件无法跨机搬运。
- **不自动装插件**：插件清单只上报差异，装不装由你决定。
- **不删除对方数据**：远端只增不减，本机也不会因为远端缺失而删除文件。
- **默认不碰凭据**：`.credentials.yaml`、密钥库、网关 key 默认不读、不写、不传；要在多台机器之间
  搬运登录状态时，在「同步范围」里手动打开凭据开关（私钥类文件任何时候都不传）。
- **会话引用的附件暂时不跟随**（`/attachments/` 引用）；后续版本计划作为可选范围加入。

## 九、开发

```bash
npm test                     # 一次跑完 19 个测试文件
node tests/smoke.mjs           # 无宿主冒烟：采集 → 推送 → 二次计划 → 伪造远端会话可拉取
node tests/secrets.test.mjs    # 凭据开关：关闭时不上传，打开时只放行那 3 个已知文件
node tests/transport.test.mjs  # 三种通道的检查步骤与「不泄漏令牌」
node tests/git-guard.test.mjs  # Git 安全：令牌走环境变量、公开仓库闸门
node tests/analysis.test.mjs   # 本机盘点：坏文件不抛异常、3 秒内返回
node tests/session-canon.test.mjs  # 会话文件名归一化：跨机同名不打架
node tests/cross-machine.test.mjs  # 双机模拟：推送、拉取、冲突、回滚
node tests/defensive.test.mjs      # 防御性：hub 异常不冒泡、apply 遇坏宿主不崩
node tests/git-info.test.mjs       # 仓库信息：远端去凭据、分支、detached、异常降级
node tests/archive.test.mjs        # 会话归档：只增不减、写盘前备份、失败降级
node tests/archive-registry.test.mjs  # 归档走宿主注册表：宿主优先、失败回落文件
node tests/plugin-config.test.mjs  # 插件配置解析：嵌套、行内注释、!!js、敏感键脱敏
node tests/contract-endpoints.test.mjs  # /plugins 与 /workspaces 的字段形状
node tests/security.test.mjs       # 接口访问控制：跨站/非回环/非 JSON 一律拒绝
node tests/p0-sync-safety.test.mjs  # 同步安全：真实值不被占位符顶掉、不反复拉取
node tests/section-model.test.mjs  # 分区模型：custom 的开关、记账与明文条目落地
node tests/custom-section.test.mjs  # 自定义路径分区：脱敏副本合并、不写占位文件
node tests/state-baseline.test.mjs  # 状态基线：白名单往返与 sha 记账
node tests/merge-correctness.test.mjs  # 合并正确性：结构化 JSON 合并、保留本机独有键、三方基线比较
node tests/path-safety.test.mjs    # 路径安全：联接外不读不写、设置路径净化、子路径净化
```

目录：

```
index.js             服务端入口（name / inject / apply）
lib/paths.mjs        路径解析（全部限制在 $DSH_HOME 内）
lib/sections.mjs     八个范围的采集与脱敏
lib/git-info.mjs     仓库信息只读探测（远端去凭据、分支、detached）
lib/archive.mjs      会话归档读写（只增不减，写盘前备份）
lib/plugin-config.mjs  cordis.patch.yml 的 config 解析与脱敏（自研行级 YAML 解析器）
lib/privacy.mjs      隐私红线、脱敏规则、凭据开关判定
lib/analysis.mjs     本机现状盘点（工作区/插件/技能/会话/故意不同步/凭据清单）
lib/version.mjs      DSH 版本探测（asar 包 / runtime.json / 环境变量）
lib/state.mjs        设置与状态的读写（原子写）
lib/manifest.mjs     远端清单格式
lib/engine.mjs       差异决策、冲突、备份、应用
lib/transport/       local / git / webdav + 共享基类（检查步骤统一在这里）
lib/hub.mjs          门面：状态、计划、执行、备份
lib/degraded.mjs     初始化失败时的降级 Hub（只报错，不抛异常）
lib/server.mjs       HTTP 路由
lib/tools.mjs        四个 Agent 工具
client.js            主面板 + 配置中心 UI（手写 JS，仅 require('react')）
cordis.patch.yml     组合包 patch（insert 本插件 + 初始配置）
```

界面规范：样式只用 DSH 官方主题 token `--dsw-alias-*`（不写死颜色、不引入组件库）；
客户端不 import 任何 `@deepseek-ai/*` 客户端包（官方规范：抛错的组件会让整个 slot 变空白）。

设计取舍、官方规范摘录与配置盘点见 `docs/research/`：
`01-existing-plugins.md`（本机已装的三个同步插件做了什么）、
`02-dsh-plugin-spec.md`（插件 API 与打包规范）、
`03-config-inventory.md`（本机 DSH_HOME 逐项盘点与体积/隐私结论）。
