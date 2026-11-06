# 03 · DSH 配置资产盘点（sync inventory）

> 目标：把本机 `DSH_HOME` 与 profile `desktop` 里的每一个可同步资产，落到「路径 / 体积 / 用途 / 隐私等级 / 是否同步 / 怎么应用」六列上，供 `dsh-sync-hub` 的盘点模块与 UI 直接消费。
>
> 实测环境：`DSH_HOME = C:\Users\HUAWEI\.dsh`，profile = `desktop`，DSH `0.2.2-rc.1`，node `v24.22.1`，pwsh `7.5.4`。
> 全部体积/数量均为本机实测值，不是估算；估算只出现在「第 7 节耗时」并明确标注。
>
> **本文档不含任何真实密钥值。** 所有密钥一律写作 `<redacted>`，只保留键名与所在路径。

---

## 0. 一句话结论

本机 `DSH_HOME` 共 **1.34 GB / 43,000+ 文件**，但真正需要跨机同步的资产只有 **≈ 26 MB**，其中 **96% 是会话**；
其余 1.31 GB 是 `node_modules`（857 MB）与一份**存在两份副本的 MSYS2/bash 工具链**（784 MB），全部可按需重建、必须 `local-only`。
隐私红线集中在 **4 个文件 / 3 类位置**：`.credentials.yaml`（+ 备份）、`openai-gateway/api-key`、会话 JSONL 正文、以及 `storages/*` 里可能的明文 gateway key。

---

## 1. 盘点口径

| 项 | 值 |
|---|---|
| 顶层条目 | 18 目录 + 4 文件 |
| 总体积 | ≈ 1.34 GB |
| 总文件数 | ≈ 41,500（`profiles` 36,037 + `dsh-ops` 9,619） |
| 可同步子集 | ≈ 26 MB（见 §7） |
| 唯一会话数 | 40（4 个 project key） |
| 已装插件 | 16 个 dependency / 23 个 bundle |
| MCP server | **0 个**（`mcp/servers.json` = `{"servers":[]}`） |
| 自定义 prompt | **0 个**（`custom/prompts.json` = `{"prompts":[]}`） |

盘点手法：`Get-ChildItem -Recurse` 限流统计 + `node` 用 `node:zlib` 全量解压会话 + 直接读配置文件。所有命令片段见附录 A。

---

## 2. DSH_HOME 顶层清单

`C:\Users\HUAWEI\.dsh\` 下 18 个目录 + 4 个文件。

### 2.1 目录

| 路径 | 体积 | 文件数 | 用途 | 含隐私 | 跨机同步 |
|---|---|---:|---|---|---|
| `sessions/` | 24.33 MB | 40 | 会话历史，`<projectKey>/<sessionDir>/session.v4.jsonl.zstd` | **高**（全文对话） | 手动 / redacted |
| `profiles/` | 859.30 MB | 36,037 | profile 目录；其中 `desktop/node_modules` = 856.67 MB | 低（配置）/ 无（依赖） | **仅配置部分** |
| `dsh-ops/` | 392.41 MB | 9,619 | dsh-ops 插件状态；**99.99% 是解压出的 bash 工具链** | 无 | **否**（可重建） |
| `dsh-config-manager/` | 92.55 MB | 1,138 | config-manager 的导出/快照/同步工作区 | **中**（`vault/`） | 否（自身产物） |
| `storages/` | 2.72 MB | 36 | DSH storage 单元（workspace 表 + 插件 KV） | **中**（可能含 key） | 选择性 |
| `model-router/` | 0.32 MB | 5 | `orchestration.sqlite` + `state.json` | 低 | 否（设备态） |
| `attachments/` | 0.27 MB | 10 | 内容寻址附件库（sha256 文件名，全 PNG） | **中**（截图） | 可选 |
| `bot/` | 0.04 MB | 7 | bot 插件状态 + `usage.sqlite` + 记忆快照 | 低 | 否 |
| `skills/` | 0.03 MB | 1 | `dsh-comfyui-workflows/SKILL.md`（27,899 B） | 无 | **是**（portable） |
| `github-sync/` | 0.02 MB | 2 | `state.json`(21,446 B) + `history.jsonl` | **中**（repo URL） | 否（设备态） |
| `logs/` | 0.01 MB | 1 | `vision-router/vision-router.log` | 低 | 否 |
| `our-free-model/` | 0.01 MB | 4 | `catalog.json` / `availability.json` / `session-map.json` | 低 | 否 |
| `cache/` | 极少 | 1 | `vision-router/live-models.json`(2,969 B) | 无 | 否 |
| `dsh-market/` | 极少 | 1 | `printed-build-keys.json` = `{}` | 无 | 否 |
| `fence/` | 0 | 1（`shared/` 空） | 空壳 | 无 | 否 |
| `channel-pack/` | 0 | 0 | 空目录 | 无 | 否 |
| `data/` | 0 | 0 | `dsh-comfyui/` 空 | 无 | 否 |
| `openai-gateway/` | 43 B | 1 | **`api-key` 裸密钥文件** | **红色** | **绝对否** |

合计 ≈ **1.34 GB**。

### 2.2 文件

| 路径 | 体积 | 用途 | 含隐私 | 同步 |
|---|---|---:|---|---|
| `.credentials.yaml` | 1,045 B | DSH 凭据库（records + refs） | **红色** | **否 / 加密才考虑** |
| `.credentials.yaml.bak-20261106-shuaiapi` | 960 B | 用户改 shuaiapi key 时的备份，**同样含全部密钥** | **红色** | **否** |
| `.anonymous-user-id` | 37 B | UUID 形机器/匿名指纹 | 中（标识本机） | 否 |
| `unlag-reload.log` | 10,219 B | dsh-unlag 1.17.3 运行日志 | 低 | 否 |

> **最危险的单文件**：`openai-gateway/api-key` —— 43 字节、无换行、纯密钥正文，文件本身没有任何「这是密钥」的元信息，任何按扩展名/文件名白名单的打包器都会把它当普通文本带走。盘点模块必须对它**按路径硬排除**。

### 2.3 一个必须写进 UI 的事实：工具链存了两份

| 位置 | 体积 | 角色 |
|---|---|---|
| `profiles/desktop/node_modules/@dsh-ops/bash-win32-x64/` | 392.10 MB / 9,614 files | **源**（随 npm 包安装） |
| `dsh-ops/bash-ipc/334e2ad7ee0b4d7a77fd06f8/` | 392.41 MB / 9,617 files | **运行时解压出的副本** |

两份合计 **784.5 MB = DSH_HOME 全量的 58%**。

证据（`dsh-ops/bash-ipc/334e2ad7ee0b4d7a77fd06f8/.ops-ipc.json` 首行）：

```json
{"identity":"334e2ad7ee0b4d7a77fd06f8",
 "source":"C:\\Users\\HUAWEI\\.dsh\\profiles\\desktop\\node_modules\\@dsh-ops\\bash-win32-x64",
 "msys":"2a89b7c3…","patchedSha256":"86c3df08…","files":{…}}
```

内容构成（按扩展名）：340 个 `.dll` = 158.31 MB、350 个 `.exe` = 125.36 MB、373 个 `.html` = 15.64 MB、1,987 个 `.vim` = 13.04 MB、811 个 `.pm` = 11.66 MB、259 个 `.txt` = 11.20 MB。`bin/` 下是 `bash.exe` / `git.exe` / `sh.exe`。

全部 mtime 落在 `2026-11-03 10:09:27 – 11:19:17` 的 70 分钟窗口内 = 一次性解压产物。

**结论**：`dsh-ops/bash-ipc/**` 与 `node_modules/@dsh-ops/**` 同为可重建物，等级 `local-only`，且应当在 UI 里显式展示为「已跳过 784 MB（可重建的运行时装）」——否则用户只看到「1.34 GB 里只同步了 26 MB」会以为盘点漏了。

---

## 3. Profile 资产（`profiles/desktop`）

5 个文件 + 3 个目录。

### 3.1 根文件

| 文件 | 体积 | 用途 | 同步 | 应用方式 |
|---|---:|---|---|---|
| `cordis.patch.yml` | 4,225 B（170 行） | **插件配置本体**，DSH 唯一权威配置源 | **是**（默认开） | 合并 + 重启 |
| `package.json` | 1,413 B | 16 个 dependency + `dsh.profile.bundles` 23 条 | **是** | 合并依赖后 `pnpm install` |
| `cordis.yml` | 223 B | 只有注释 + `[]`；注释原文：*"Edit cordis.patch.yml, not this file"* | 否（空壳） | — |
| `pnpm-lock.yaml` | 112,783 B | 110 KB 锁文件 | 可选（建议开） | 覆盖写后 `pnpm install` |
| `pnpm-workspace.yaml` | 202 B | `packages:[.]` / `nodeLinker:hoisted` / `autoInstallPeers:false` / `minimumReleaseAgeExclude` 白名单 4 项 | **是** | 覆盖写 |

`cordis.patch.yml` 首行固定为：

```yaml
# rewritten by dsh-config-manager import (original comments not preserved)
```

→ 说明该文件历史上被 config-manager 的 import 通道重写过。**它不含注释可保留性保证**，跨机合并时不能假设用户注释还在。

### 3.2 `cordis.patch.yml` 的条目与行号（config 段落在哪）

| 行号 | 条目 id | config 内容摘要 | 敏感性 |
|---|---|---|---|
| 2–70 | `llm-pi-ai` | providers 列表：baseURL / model / `apiKeyEnv` / maxTokens | **低**（只有 env 名） |
| 71–75 | `ui-chat` | `transcriptView: standard`、`performanceUsage: detailed` | 无 |
| 76–79 | `ui-settings` | 常规 UI 开关 | 无 |
| 80–89 | `ui-settings-account` | `version1` / `step: done` / `purpose: development` / `process: standard` / `completion: completed` / `usage: detailed` / `developerTools: true` | 低（暴露使用画像） |
| 90–94 | `agent-default-model` | `provider: qiniucloud`、`model: deepseek/deepseek-v4.1-flash-1017` | 低 |
| 95–96 | `cc-safety-net` | `disabled: true`，**无 config** | 无 |
| 97–101 | `web` | `searchProvider: ddg`、`fetchProvider: fs-quality-fetch` | 无 |
| 102–106 | `vision-router` | 路由开关 | 无 |
| 107–159 | `web-search-free` | **最大段**：`keyStorage: credentials`、`bingMarket: zh-CN`、`cache: true`、`cacheTtl: 5`、`platforms` 14 项 | **中**（`keyStorage: credentials` = 安全形态） |
| 160–163 | `better-sidebar` | 侧栏开关 | 无 |
| 164–170 | `session-sync` | `remote: https://github.com/loveliveao/DeepSeekHarness-session.git`、`branch: main`、`autoPullOnStart: false`、`autoPushOnTurnEnd: false` | **中**（泄露私有仓库名） |

### 3.3 config 里的密钥：实证判读

对本文件 grep `apiKey|token|secret|password|authorization|Bearer|ghp_|sk-`，**全部命中只有两类**：

```
line  8: apiKeyEnv: QINIUCLOUD_API_KEY          ← 环境变量“名”，安全
line 45: apiKeyEnv: MINIMAX_CN_API_KEY          ← 环境变量“名”，安全
line 15/22/29/36/43/50/56/62: maxTokens: …      ← 误报（含 "token" 子串）
```

**结论**：本机 `cordis.patch.yml` **没有任何内联密钥**。

由此得出 `dsh-sync-hub` 的判据形态（两类要分开）：

- **安全形态**：`apiKeyEnv: X` / `keyStorage: credentials` / `tokenRef: X` / `secretRef: X` —— 值是**引用名**，本身不是秘密，可同步。
- **危险形态**：`apiKey: sk-…` / `token: ghp_…` / `password: …` / `authorization: Bearer …` / 任何形如 `(apiKey|token|secret|password|authorization|clientSecret|accessKey|privateKey)` **后面直接跟字面值**的键。

判据不能只看键名，必须看「键名 + 值是否像引用」。`apiKeyEnv` 与 `apiKey` 只差 3 个字符，一刀切会误杀整份配置（本机 14 个 provider 全靠 `apiKeyEnv`）。

### 3.4 目录

| 路径 | 体积 | 说明 | 同步 |
|---|---:|---|---|
| `node_modules/` | 856.67 MB / 35,989 files | 16 个 direct dep + 全部传递依赖（hoisted 扁平布局） | **绝对否** |
| `.dsh-market/` | 2.49 MB / 7 files | 插件市场发现缓存：`discovery-compatibility-v1.json`(1.38 MB)、`discovery-github-compatibility-v1.json`(1.20 MB)、`log.ndjson`、`drain.ndjson`、`state.json`(98 B)、`pending-updates.json`、`pending-rows.json` | 否（缓存可重拉） |
| `.plugin-manager/` | 36 files | `run.json`(29 B) + `logs/*` | 否 |

**`node_modules` 为什么不同步 / 怎么重建**：

1. **平台绑定**：`nodeLinker: hoisted` 的依赖树里含平台特化包——`@dsh-ops/bash-win32-x64`（392 MB，win32-x64 专用）、`better-sqlite3` 等带 `.node` 原生二进制的包。把整个目录拷到 macOS/Linux 机器上，`bash.exe` 与 `.node` 全部不可执行。
2. **体积**：857 MB ≈ 可同步子集（26 MB）的 **33 倍**，任何 git/HTTP 通道都会被它堵死（GitHub 单文件/仓库体积限制、HTTP 超时）。
3. **可重建**：`package.json` + `pnpm-lock.yaml` + `pnpm-workspace.yaml` 三件套已在盘上，等价于一份完整重建配方：
   ```
   pnpm install --frozen-lockfile
   ```
   重建耗时是本机实测级的分钟量级（hoisted 链接 + 原生包编译），远优于传 857 MB。
4. **重建后不同的东西**：`node_modules` 里没有任何用户数据（无 config、无 state），插件状态全部落在 `DSH_HOME` 顶层目录（见 §5）。所以「不传 node_modules」不损失任何不可重建信息。

→ `node_modules` 在 UI 里应显示为「已跳过 857 MB（依赖，`pnpm install` 重建）」，与 §2.3 的工具链合并为**同一类跳过项**：`node_modules` 里的 `@dsh-ops` 392 MB 与 `dsh-ops/bash-ipc` 392 MB 是同一批文件。

---

## 4. Settings 到底存在哪

这是本次盘点最反直觉的一节，也是 dsh-sync-hub 最容易做错的 section。

### 4.1 没有 `settings.yaml`

```
Test-Path C:\Users\HUAWEI\.dsh\settings.yaml                  → False
Test-Path C:\Users\HUAWEI\.dsh\profiles\desktop\settings.yaml → False
depth-2 遍历 $DSH_HOME 下 *.yaml → 只有 profiles/desktop/{cordis,cordis.patch}.yml 与 pnpm-workspace.yaml
```

但 DSH 的 settings 服务**预期**把落盘文件放在 `$DSH_HOME/settings.yaml`。证据是 `dsh-config-manager` 的适配器注释：

```
node_modules/dsh-config-manager/lib/adapters/settings.js:3
  // 数据源 = ~/.dsh/settings.yaml 中「非 UI 类」namespace
  //（经 ctx.settings.describe({redactSecrets:true}) 读取）
```

同文件 `:5-6` 另注明：DSH settings 服务**没有枚举全部 namespace 的 API**，namespace 清单由宿主注入 —— 这正是本机「文件不存在但仍有 27 个 namespace」的原因。

> **对 dsh-sync-hub 的要求**：`settings.yaml` 必须按**可选文件**处理。`exists=false` 是合法状态，不能报错、不能据此清空对端设置。

### 4.2 27 个 namespace 的值全部可推导

从 config-manager 的导出包里抽出 `config/settings.json`（26,495 B），结构是每个 namespace 一条：

```json
{ "value": {…}, "base": {…}, "revision": 0, "applies": ["live"], "secrets": [] }
```

27 个 namespace：`session-log-deepseek`、`agent-default-model`、`llm-pi-ai`、`pwsh-sandbox`、`permission`、`subagent`、`web`、`web-search-deepseek`、`web-deepseek-api`、`agent-loop`、`llm-deepseek`、`llm-deepseek-account`、`product-analytics`、`subagent-model-selection-settings`、`ui-settings-account`、`ui-theme`、`locale`、`ui-settings`、`ui-settings-general`、`ui-conversation`、`ui-chat`、`agent-preset-registry`、`web-search-free`、`comfyui`、`plugin-market`、`better-sidebar`、`dsh-context`。

关键观察：**`revision` 全部为 `0`**，且 `value` = `base`（内置默认）× `cordis.patch.yml` 覆盖 的合成结果。例：

```
agent-default-model.value = { provider: "qiniucloud", model: "minimax-m3.1-flash" }
agent-default-model.base  = { provider: "deepseek-official", model: "deepseek-flash" }
                 ↑ 与 cordis.patch.yml:90-94 完全一致
```

**结论**：本机「设置」没有独立存储，`settings.yaml` 缺失是正常的 —— 有效设置的唯一真实来源就是
**profile `cordis.patch.yml` + 各 bundle 的内置默认值**。

→ dsh-sync-hub 的 `settings` section **不应该**去同步一个不存在的 `settings.yaml`；
真正要同步的是 `cordis.patch.yml`。UI 上把这两者做成两个 section 会让用户以为配置存了两份。

### 4.3 UI / 外观 / 快捷键：同步不了，别假装能

`lib/adapters/ui.js:8-19` 定义了 `KNOWN_UI_NAMESPACE_PREFIXES`：

```
pet, dsh-better-sidebar, remote-web-ui, ui-onboarding,
dsh-client-ui, skin, theme, layout, sidebar, appearance
```

实测 `config/ui.json` 的 `namespaces` 是**空对象 `{}`**，只有 3 条 `uiMigrationNotes`：

| 来源 | 存储键 | 不可迁移原因 |
|---|---|---|
| `dsh-task-board` | localStorage `dsh.taskBoard.v1` | 浏览器端 UI 状态无法经 Host API 迁移 |
| `dsh-aionui-panel` | localStorage `aionui-panel.*` | 同上 |
| `dsh-client-ui-*` | localStorage `*` | 同上 |

桌面壳自己的设置：`C:\Users\HUAWEI\AppData\Roaming\@deepseek-ai\dsh-desktop\desktop\settings.json` 仅 **61 B**：

```json
{"updates":{"allowTestAuthPopupWindow":false}}
```

同目录另有 `Local Storage/leveldb`、`Network/Cookies`、`Cache`、`GPUCache`、`Code Cache` —— 全属 Chromium 浏览器数据。

**分级**：
- `ui-theme` / `locale` / `ui-settings` / `ui-settings-general` / `ui-conversation` / `ui-chat` → 这些是 **Host 侧** namespace，走 `cordis.patch.yml`，**可同步**。
- 面板宽度 / 折叠状态 / 皮肤 / 快捷键 → **浏览器 localStorage**，`local-only`，UI 上必须标注「无法同步」而不是「同步失败」。
- `Local Storage/`、`Cookies`、`Cache/`、`GPUCache/`、`Code Cache/` → `local-only`，且是**认证态**（Cookie 里有 deepseek 登录态），绝不能进包。

### 4.4 `storages/` 的数据结构

`storages/` 是 DSH 的 storage-unit 机制，每个「单元」一个目录，内含 `tables/*.json` 或插件自定义 JSON。

```
storages/
├── workspace.json                                  2,588 B
├── session_projcache/sessions/*.json    27 个，5.6 KB – 512 KB
└── vision_router_session_policy/policies/*.json  7 个，100 B / 175 B
```

`workspace.json` 结构（真实片段，路径已脱敏为占位）：

```json
{"unit":{"name":"workspace","version":2},
 "global":{"initialized":true,"defaultWorkspaceId":"…","workspaceIds":["…"],
           "archivedSessionIds":[… 18 条 …],"pinnedSessionIds":[]},
 "tables":{"workspaces":{"0b85b1df-…":{"path":"D:\\VibeCoding","title":"VibeCoding",
           "sessionIds":[… 18 条 …],"createdAt":…,"updatedAt":…}}}}
```

**注意 `path` 字段是绝对本机路径**（`D:\VibeCoding`）—— 跨机同步必须做路径映射，否则对端会出现一个指向不存在目录的 workspace。

| storage 单元 | 性质 | 判定依据 | 分级 |
|---|---|---|---|
| `workspace.json` | **DSH 核心**（非插件） | unit 名 `workspace`、version 2、含 `global`+`tables` 双段 | `redacted`（需路径改写） |
| `session_projcache/sessions/*.json` | 插件状态（project cache） | 27 个文件、按 session id 命名、体积 5.6 KB–512 KB | `local-only`（缓存） |
| `vision_router_session_policy/policies/*.json` | 插件状态（会话级策略） | 内容 `{"version":1,"record":{"revision":1,"enabled":false,"source":"user"}}` | 可选 |

> `vision_router_session_policy` 的内容是「给人看的语义值」而非二进制缓存 —— 这类是理想的 pluginData 同步对象。而 `session_projcache` 是纯缓存，同步只会把对端的缓存打脏。

**`storages/` 里的 gateway key**：本次**未在 `storages/` 下发现任何形似 gateway key 的字段**——`storages/` 全部 36 个文件均为 workspace 表 / 会话缓存 / 策略记录，无 `apiKey`/`token`/`key` 字面键。真正的 gateway key 在 `openai-gateway/api-key`（§2.2）。但盘点模块**不能因此豁免 `storages/`**：它是插件可写的自由 JSON 区，任何插件都能往 `tables/*.json` 里塞 key，必须保持「按值形态扫描」（§6.1 的 R5/R6 规则）。

---

## 5. 会话资产

### 5.1 目录层级

```
sessions/
└── <projectKey>/                        ← cwd 的编码形式
    └── <sessionDir>/                    ← session id（可能带/不带 session- 前缀）
        └── session.v4.jsonl.zstd        ← 唯一文件
```

**简报假设需要纠正**：会话目录里**只有这一个文件**，没有 `meta.json`，没有目录内 `attachments/`。所有元数据（`id`/`createdAt`/`cwd`/`agentPreset`）都在压缩流的**首行**。

### 5.2 projectKey 编码规则

规则：**`--` + 绝对路径把 `\` `:` `/` `.` 一律替换成 `-` + `--`**，原路径里的 `-` 保持不变。

| 原始 cwd | projectKey |
|---|---|
| `D:\VibeCoding` | `--D-VibeCoding--` |
| `C:\Users\HUAWEI\.dsh\bot\workspace` | `--C-Users-HUAWEI-.dsh-bot-workspace--` |
| `D:\Personal\Documents\deepseek-harness\default-workspace` | `--D-Personal-Documents-deepseek-harness-default-workspace--` |

注意第三行：原始路径中的 `-`（`deepseek-harness`、`default-workspace`）被保留 → 编码**不可逆**（无法从 key 唯一还原路径）。要拿真实 cwd 只能解压首行的 `cwd` 字段。

实测 4 个 project key：

| projectKey | 会话数 | 体积 |
|---|---:|---:|
| `--D-VibeCoding--` | 29 | 20.20 MB |
| `--D-Personal-Desktop--` | 6 | 2.18 MB |
| `--D-Personal-Documents-deepseek-harness-default-workspace--` | 4 | 0.36 MB |
| `--C-Users-HUAWEI-.dsh-bot-workspace--` | 1 | 0.20 MB |

### 5.3 目录命名：两套并存

| 形态 | 数量 | 说明 |
|---|---:|---|
| `session-<uuid>` | 33 | 主流形态 |
| 裸 `<uuid>` | 7（全在 `--D-VibeCoding--`） | 旧形态 / 导入残留 |

实测 `--D-VibeCoding--/0a2ef732-b3ba-4834-a6af-7da20da8f260/session.v4.jsonl.zstd` 的首行 `id` = `0a2ef732-b3ba-4834-a6af-7da20da8f260`（**同样是裸 uuid，无前缀**）。

→ **权威 id 在文件首行，不能从目录名推断。** 盘点模块不能用「目录名去掉 `session-`」当 id，必须在去重/合并时读首行。

### 5.4 文件格式（node 24 可直接解）

- 容器：**单帧 zstd**，magic `28 b5 2f fd`。
- 解压：**`zlib.zstdDecompressSync()` 在 node 24.22.1 上 40/40 全部成功** —— 零依赖路径成立，不需要外挂 `zstd` 二进制。
- 内容：JSONL（每行一个 JSON 对象）。
- 首行固定形态：

```json
{"type":"session","version":4,"id":"…","createdAt":1793861730962,
 "cwd":"D:\\VibeCoding","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

`createdAt` 是**毫秒 epoch**（不是 ISO 字符串）。

实测行类型分布（样本 `session-a322ce04`，149 行）：

| 行类型 | 条数 | 行类型 | 条数 |
|---|---:|---|---:|
| `session` | 1 | `request/header` | 4 |
| `permission/preset` | 3 | `request/context` | 3 |
| `sandbox/mode` | 3 | `assistant/attempt` | 3 |
| `approval/policy` | 3 | `step/end` | 14 |
| `session/title` | 1 | `turn/end` | 4 |
| `model/selection` | 5 | `command/run` | 2 |
| `agent/inbox/spliced` | 12 | `command/done` | 2 |
| `turn/start` | 4 | `developer/message` | 3 |
| `step/start` | 14 | `assistant/message` | 11 |
| `system/message` | 2 | `tool/call` | 18 |
| `user/message` | 14 | `tool/result` | 18 |
| | | `job/registered` / `job/settled` | 2 / 2 |
| | | `session/end-seed` | 1 |

→ **`tool/result`（18 条）与 `request/context`（3 条）是体积与隐私的双重主因**：前者是命令输出（可能含 `env`、日志里的 token），后者会内联 `AGENTS.md` 等上下文全文。

### 5.5 统计（node 全量扫描 40 个会话）

| 指标 | 值 |
|---|---|
| 会话总数 | **40** |
| 压缩后总量 | **24.09 MB**（目录实测 24.33 MB，含文件系统开销） |
| 解压后总量 | **83.32 MB** |
| 压缩率 | **0.289**（约 3.46 : 1） |
| JSONL 总行数 | **36,429** |
| 含 `/attachments/` 引用的行 | **29** |
| mtime 跨度 | `2026-11-03 09:56:18` – `2026-11-06 19:55:05`（约 3 天） |
| 最大单会话 | **3,151 KB 压缩** / 10,201 KB 原文 / 5,036 行 |
| 最小单会话 | **0.30 KB**（2 个） |
| 平均 | 587 KB 压缩 |
| `title` 字段 | **全部为空**（40/40） |

`title` 全空 → **UI 无法靠会话文件本身列出「可读的会话列表」**，只能显示 `createdAt` + 首条 `user/message` 摘要，或走 `storages/workspace.json` 的 workspace 关联。这对「同步预览」界面的设计是硬约束。

### 5.6 attachments 的性质

```
attachments/v1/{objects,tmp}
objects/<2 字符前缀>/<sha256>      ← 内容寻址
9 个前缀分片目录：10 17 23 24 61 71 73 f9 fe
共 10 个文件，0.27 MB
```

magic 全部为 `89 50 4e 47 0d 0a 1a 0a` = **PNG**。文件名即 sha256 → 天然可去重、可校验、可增量（对端已存在同 sha256 就跳过）。

同步体积风险：**当前 0.27 MB 可忽略**，但这是**唯一会随时间线性膨胀且无上限**的资产（截图/生成图）。必须设单文件与总量阈值（§7.3）。

**引用关系**：会话 JSONL 里有 29 行含 `/attachments/` 路径引用（绝对路径形式）。→ **会话与 attachments 必须同步或都不同步**，否则对端会话会出现坏图。这是 dsh-sync-hub 必须实现的**依赖约束**：`sessions` section 勾选时提示 `attachments` 一并处理。

### 5.7 会话的隐私等级

会话 JSONL 里同时存在：

1. **完整用户对话**（`user/message`：14/149 行）—— 可能包含用户粘贴的密钥、密码、内部地址；
2. **完整工具输出**（`tool/result`：18/149 行）—— 可能含 `env`、`git remote`、日志、内网 IP；
3. **完整上下文快照**（`request/context`）—— 实测内联了 `AGENTS.md` 全文，里面就有本机的目录约定、Tailscale IP 段、容器名；
4. **绝对路径**（`cwd`、工具参数）—— 泄露本机盘符与用户目录结构。

→ **会话不可定为 `public-safe`，至少 `redacted`，且默认不同步**。理由不是「可能含密钥」这种含糊判断，而是：**它就是一份完整的终端转录**，任何在终端里出现过的东西都在里面。

---

## 6. 隐私分级

### 6.1 判据（不是拍脑袋）

四级定义：

| 等级 | 含义 | 默认行为 |
|---|---|---|
| `public-safe` | 不含任何本机专属信息，任意机器可接受 | **默认同步** |
| `redacted` | 含本机专属信息（路径/设备 id/私有仓库名/会话正文），需改写或用户确认后才能同步 | 默认关，需显式勾选 |
| `local-only` | 只对本机有意义（缓存/指纹/设备态/socket），同步过去是污染 | **强制排除**，UI 显示「已跳过」 |
| `secret` | 凭据本体，泄露即失守 | **强制排除**，UI 显示「已排除（凭据）」且不显示值 |

**判定流水线（按顺序短路，第一个命中即定级）**：

| # | 规则 | 命中 → |
|---|---|---|
| R1 | 路径命中凭据文件名模式 | `secret` |
| R2 | JSON/YAML 里键名命中凭据键模式，**且值不像引用** | `secret` |
| R3 | 值形态命中密钥正则 | `secret` |
| R4 | 路径命中缓存/设备态模式 | `local-only` |
| R5 | 内容含本机绝对路径 / 设备 id / 私有仓库 URL | `redacted` |
| R6 | 无以上命中且为 portability=portable 的配置 | `public-safe` |

**R1 · 凭据文件名模式（大小写不敏感，命中路径任一段即 `secret`）**

```
.credentials                        .credentials.*         credentials.yaml
credentials.json (非脱敏版)          *.pem  *.key  *.p12  *.pfx  *.jks
id_rsa  id_ed25519  id_ecdsa         .netrc  .npmrc (含 _authToken)
*oauth*  *-token  *-key (裸文件)      vault/**  secrets/**
api-key  apikey  api_key              .env  .env.*  *.env
```

本机命中实例：`.credentials.yaml`、`.credentials.yaml.bak-20261106-shuaiapi`、`openai-gateway/api-key`、`dsh-config-manager/vault/.credentials.yaml`。

> 注意 `dsh-config-manager/vault/` 下那份 900 B 的 `.credentials.yaml` 是**第三份凭据副本**（前两份在 HOME 根）。三份都要排除。

**R2 · 凭据键名模式**

```
apiKey  api_key  apikey        apiSecret  api_secret
token  accessToken  refreshToken  idToken  authToken
secret  clientSecret  privateKey  signingKey
password  passwd  pwd  credential
authorization  Authorization header  Bearer
accessKey  accessKeyId  secretKey  sessionKey
```

**但**：命中键名后必须看值 —— 值形如以下「引用形态」则**降级为安全**：

```
*Env 后缀（apiKeyEnv: QINIUCLOUD_API_KEY）
*Ref 后缀（tokenRef: DSH_CONFIG_MANAGER_SYNC_TOKEN）
keyStorage: credentials / keyStorage: env / keyStorage: keychain
值等于大写 SNAKE_CASE 环境变量名（^[A-Z][A-Z0-9_]{2,}$）
值等于 <redacted> / "" / null / 布尔
```

反例（本机未出现，必须能识别）：`apiKey: sk-…`、`token: ghp_…`、`authorization: Bearer eyJ…`。

**R3 · 值形态正则（与键名无关，扫所有文本值）**

```
sk-[A-Za-z0-9_-]{16,}            OpenAI 风格
ghp_[A-Za-z0-9]{30,}             GitHub PAT (classic)
github_pat_[A-Za-z0-9_]{20,}     GitHub PAT (fine-grained)
xox[baps]-[A-Za-z0-9-]{10,}      Slack
AKIA[0-9A-Z]{16}                 AWS access key id
eyJ[A-Za-z0-9_-]{10,}\.eyJ       JWT
-----BEGIN [A-Z ]*PRIVATE KEY-----
[a-f0-9]{32,}                    32+ 位 hex（裸 api-key 常见形态，需与上下文联合判定）
```

> 这条规则的价值在于**兜底**：`openai-gateway/api-key` 的内容是 43 字节无结构裸串，键名只是 `api-key`，靠 R1 命中；若某个插件把 key 写进 `storages/foo/tables/x.json` 的 `value` 字段，就只有 R3 能抓到。

**R4 · 缓存 / 设备态模式（`local-only`）**

```
cache/  caches/  .cache/  tmp/  temp/  work/
logs/  *.log  *.ndjson (运行日志)
node_modules/  dist/  build/
bash-ipc/**  *-win32-*/**  *.exe  *.dll  *.node
.sessions  session_projcache/**  (纯缓存类 storage)
.anonymous-user-id  environment-fingerprint.token
*deviceId*  *deviceName*  *machineId*
Local Storage/  Cookies  Cache/  GPUCache/  Code Cache/  *.leveldb
.Spotlight-V100  .DS_Store  Thumbs.db
```

本机命中实例：`node_modules/`(857 MB)、`dsh-ops/bash-ipc/**`(392 MB)、`.dsh-market/`、`.plugin-manager/logs/`、`dsh-config-manager/{exports,snapshots,sync,market,migration-history,transactions}/**`(92 MB)、`storages/session_projcache/**`、`github-sync/state.json`（含 `deviceId`/`deviceName`）、`.anonymous-user-id`。

**R5 · 本机标识（`redacted`）**

- 内容含 `[A-Z]:\\Users\\[^\\]+` 或 `/(home|Users)/[^/]+/` → 含用户目录；
- 内容含私有仓库 URL（`github.com/<org>/<repo>.git`）→ 泄露仓库名（本机 2 处：`session-sync.remote`、`dsh-config-manager/sync/sync-config.json.git.repoUrl`）；
- 内容含内网地址（`10.`/`192.168.`/`100.64.`/Tailscale `100.` CIDR）；
- 会话 JSONL（必然命中前两条）。

### 6.2 资产分级总表（核心交付）

| # | 资产（相对 `DSH_HOME`） | 体积 | 等级 | 命中规则 | 进包 |
|---|---|---:|---|---|---|
| 1 | `profiles/desktop/cordis.patch.yml` | 4,225 B | `public-safe` | R6（无内联密钥，仅 `apiKeyEnv` 引用） | **是** |
| 2 | `profiles/desktop/package.json` | 1,413 B | `public-safe` | R6 | **是** |
| 3 | `profiles/desktop/pnpm-workspace.yaml` | 202 B | `public-safe` | R6 | **是** |
| 4 | `profiles/desktop/pnpm-lock.yaml` | 110 KB | `public-safe` | R6 | 是（建议） |
| 5 | `profiles/desktop/cordis.yml` | 223 B | `public-safe` | R6（空壳，无信息量） | 可选 |
| 6 | `skills/dsh-comfyui-workflows/SKILL.md` | 27,899 B | `public-safe` | R6 | **是** |
| 7 | `storages/workspace.json` | 2,588 B | `redacted` | R5（`path` 为绝对本机路径） | 需改写路径 |
| 8 | `storages/vision_router_session_policy/**` | 7 files | `public-safe` | R6 | 可选 |
| 9 | `storages/session_projcache/**` | 27 files / 2.7 MB | `local-only` | R4 | 否 |
| 10 | `sessions/**` | 24.33 MB | `redacted` | R5（R3 亦可能命中） | 默认否，显式勾选 |
| 11 | `attachments/**` | 0.27 MB | `redacted` | R5（截图可能含敏感界面） | 随会话联动 |
| 12 | `profiles/desktop/node_modules/**` | 856.67 MB | `local-only` | R4（平台二进制） | 否 |
| 13 | `profiles/desktop/.dsh-market/**` | 2.49 MB | `local-only` | R4（缓存） | 否 |
| 14 | `profiles/desktop/.plugin-manager/**` | 36 files | `local-only` | R4（日志/pid） | 否 |
| 15 | `dsh-ops/bash-ipc/**` | 392.41 MB | `local-only` | R4（`.exe`/`.dll`） | 否 |
| 16 | `dsh-ops/acl-backups/**` | 677 B | `local-only` | R4（设备态） | 否 |
| 17 | `dsh-config-manager/{exports,snapshots,sync,market,migration-history,transactions,tmp}/**` | 92.55 MB | `local-only` | R4（自身产物） | 否 |
| 18 | `dsh-config-manager/vault/.credentials.yaml` | 900 B | `secret` | R1 | **否** |
| 19 | `dsh-config-manager/environment-fingerprint.token` | 小 | `local-only` | R4（机器指纹） | 否 |
| 20 | `model-router/orchestration.sqlite` + `state.json` | 0.32 MB | `local-only` | R4（设备态） | 否 |
| 21 | `github-sync/state.json` | 21,446 B | `local-only` | R4（含 `deviceId`/`deviceName`） | 否 |
| 22 | `bot/{state.json,usage.sqlite,memory/**}` | 0.04 MB | `local-only` | R4 | 否 |
| 23 | `our-free-model/**` | 0.01 MB | `local-only` | R4 | 否 |
| 24 | `logs/**`、`cache/**` | 0.02 MB | `local-only` | R4 | 否 |
| 25 | `dsh-market/printed-build-keys.json`（`{}`）、`fence/`、`channel-pack/`、`data/` | ~0 | `local-only` | R4（空） | 否 |
| 26 | `.credentials.yaml` | 1,045 B | **`secret`** | R1 + R2 | **否（加密才考虑）** |
| 27 | `.credentials.yaml.bak-20261106-shuaiapi` | 960 B | **`secret`** | R1（备份同样含全部 key） | **否** |
| 28 | `openai-gateway/api-key` | 43 B | **`secret`** | R1 + R3 | **否** |
| 29 | `.anonymous-user-id` | 37 B | `local-only` | R4 | 否 |
| 30 | `unlag-reload.log` | 10,219 B | `local-only` | R4（日志） | 否 |

**汇总**：`public-safe` 6 项（≈ 145 KB）、`redacted` 4 项（≈ 24.6 MB）、`secret` 4 项（4 个文件、共 3 份凭据副本）、其余 `local-only`（≈ 1.31 GB）。

### 6.3 `.credentials.yaml` —— 只看结构，不看值

```
$DSH_HOME\.credentials.yaml   1,045 B / 26 行
```

结构（值全部 `<redacted>`，本文档从未记录真实值）：

```yaml
version: <redacted>
records:
  client-connection/browser-session:
    kind: <redacted>
    payload:
      version: <redacted>
      secret: <redacted>          # ← 浏览器会话密钥
  deepseek-account-platform/device:
    kind: <redacted>
    payload:
      id: <redacted>              # ← 设备 id
  deepseek-account-platform/default:
    kind: <redacted>
    payload:
      version: <redacted>
      token: <redacted>           # ← 账号 token（最高危）
      issuer: <redacted>
refs:
  MINIMAX_CN_API_KEY: <redacted>
  QINIU_API_KEY: <redacted>
  DSH_CONFIG_MANAGER_SYNC_TOKEN: <redacted>
  QINIUCLOUD_API_KEY: <redacted>
  GITHUB_TOKEN: <redacted>
  SHUAIAPI_API_KEY: <redacted>
```

**6 个 refs 键名**（这部分是安全的元信息，可以进文档、也可以进 UI 的「本机已有凭据」列表）：

`MINIMAX_CN_API_KEY`、`QINIU_API_KEY`、`DSH_CONFIG_MANAGER_SYNC_TOKEN`、`QINIUCLOUD_API_KEY`、`GITHUB_TOKEN`、`SHUAIAPI_API_KEY`。

**3 条 records**：`client-connection/browser-session`、`deepseek-account-platform/device`、`deepseek-account-platform/default`。

**备份文件**：`.credentials.yaml.bak-20261106-shuaiapi`（960 B）是用户改 `SHUAIAPI_API_KEY` 时留下的，结构相同、**同样含全部 6 个 refs 与 3 条 records**。

→ 排除逻辑必须是 **glob `.credentials.yaml*`**，而不是精确文件名。这类「用户手动改 key 时顺手 cp 的备份」是最常见的凭据泄露通道。

### 6.4 MCP 配置里的 env

本机实测 **MCP server 数量 = 0**：

```json
// 导出包 mcp/servers.json 全文
{"version":1,"servers":[]}
```

交叉验证：`storages/` 下无 `mcp_connector.json`；`$DSH_HOME/cordis.patch.yml`（home 层）**不存在**；`profiles/desktop/cordis.patch.yml` 无任何 `mcp` 条目。

**但目前为空不等于可以不做**。MCP 的 `env` 是**全 DSH 里最典型的明文密钥落点**，形态固定：

```jsonc
{ "mcpServers": { "some-server": {
    "command": "npx", "args": [...],
    "env": { "GITHUB_TOKEN": "ghp_…", "API_KEY": "sk-…" }   // ← R2 + R3 双命中
}}}
```

→ dsh-sync-hub 对 `mcp` section 必须有**字段级**处理，而不是整文件排除：
1. 遍历 `servers[*].env` 的每个键值；
2. 值命中 R3 正则或键名命中 R2 → 替换为 `<redacted>`，同时在包的 manifest 里记一条 `redactedFields: ["servers.foo.env.GITHUB_TOKEN"]`；
3. 导入端把这些键置为「未配置」，并在 UI 提示「对端需自行填入 N 个环境变量」。

同理适用于 `args` 里内联的 `--token=…` 形态。

### 6.5 pluginData 与 storages 里可能的 token

**已核实的事实**：16 个已装插件的 `package.json` **全部没有 `dsh.dataDirs` 声明**（16/16 = `-`）。

```
dsh-config-manager/lib/adapters/plugin-data-declared.js:19  MAX_DECLARED_PACKAGES = 300
dsh-config-manager/lib/adapters/plugin-data-declared.js:29  scanDeclaredDataSources()
        → 读 profiles/<profile>/node_modules/<pkg>/package.json 的 dsh.dataDirs
```

→ **pluginData 分区在本机没有任何自述来源**。DSH_HOME 顶层那些插件目录是**按插件包名约定**落盘的，映射关系只能靠「目录名 == 插件名」推断：

| DSH_HOME 目录 | 归属插件 | 内容性质 |
|---|---|---|
| `dsh-ops/` | `dsh-ops` | bash-ipc 工具链（可重建）+ acl-backups |
| `dsh-config-manager/` | `dsh-config-manager` | 导出/快照/同步工作区 + **vault** |
| `github-sync/` | `dsh-github-sync` | 设备态 + 远端缓存 |
| `dsh-market/` | `dshmarket` | 已打印 build key 集合（空） |
| `model-router/` | （bundle 内） | 编排 sqlite + 版本缓存 |
| `openai-gateway/` | （bundle 内） | **裸 api-key** |
| `our-free-model/` | （bundle 内） | 模型目录 + 可用性 |
| `bot/` | （bundle 内） | 用量统计 + 记忆快照 |
| `fence/`、`channel-pack/` | — | 空 |

**结论**：`pluginData` 在本机是**不可靠分区**——既无声明，目录名又只是约定。dsh-sync-hub 不应把它做成「一键全同步」，而应做成**「按目录勾选 + 强制过 R1–R3 扫描」**。特别是 `dsh-config-manager/`：它是唯一同时含 `local-only`（92 MB 产物）与 `secret`（vault）的分区，绝不能整体放行。

---

## 7. 体积与耗时

### 7.1 打包后体积（实测口径）

| 分区 | 未压缩 | zstd lvl3 后（估） | 说明 |
|---|---:|---:|---|
| `config`（cordis.patch + package.json + cordis.yml） | 5.7 KB | ~2 KB | 文本，压缩率极高 |
| `lock`（pnpm-lock.yaml） | 110 KB | ~25 KB | 文本 |
| `skills` | 27.9 KB | ~10 KB | Markdown |
| `workspaces`（storages/workspace.json） | 2.6 KB | ~1 KB | JSON |
| `sessions` | **24.09 MB**（已 zstd，**不可再压**） | **24.09 MB** | 压缩率 0.289，二次压缩收益 < 2% |
| `attachments` | 0.27 MB | 0.27 MB | 已是 PNG |
| **合计（不含会话）** | **≈ 150 KB** | **≈ 40 KB** | |
| **合计（含会话）** | **≈ 24.4 MB** | **≈ 24.2 MB** | 会话占 **98.6%** |

参考实测：config-manager 的无会话导出包 `dsh-config-auto-20261106-165610-351996.zip` = **24,077 B**（14 entries）；含会话的 `dsh-config-2026-11-06-b5d92a.zip` = **20,282,128 B**（20.3 MB）。

> **关键设计结论**：会话已经是 zstd，压缩容器（zip/tar.zst）对它**几乎无效**。所以「先整体压缩再上传」只能帮到那 150 KB 的配置；会话必须走**增量 + 去重**，而不是靠压缩省流量。

### 7.2 本机实测吞吐（node，单线程）

| 操作 | 数据量 | 耗时 | 吞吐 |
|---|---:|---:|---:|
| `zstdDecompressSync` 全量会话 | 84.25 MB 原文 | 1,265 ms | **66.6 MB/s** |
| `zstdCompressSync` lvl3 重压 | 84.25 MB → 13.12 MB | 2,483 ms | **33.9 MB/s** |
| `sha256` | 83 MB | 383 ms | **217 MB/s** |
| 解压 + JSON 解析 40 个会话 | 36,429 行 | 5,740 ms | 143 ms/会话 |

→ **本地预处理成本可忽略**（全量解压 + 解析 + 哈希 ≈ 7 s）。瓶颈完全在网络上。

### 7.3 网络耗时量级（估算，非实测）

按 24 MB 会话包 / 150 KB 配置包：

| 通道 | 上行带宽 | 首次全量（24.4 MB） | 增量（1 会话 ≈ 0.6 MB） |
|---|---:|---:|---:|
| 家宽上行 | 20 Mbps | ≈ 12 s | ≈ 0.3 s |
| 家宽上行（差） | 5 Mbps | ≈ 45 s | ≈ 1.1 s |
| 公司/公网 | 2 Mbps | ≈ 110 s | ≈ 2.6 s |
| GitHub git push（本机历史量级） | — | 含 `git` 打包 + TLS + 远端校验，**另加 3–10 s 固定开销** | 固定开销占主导 |

**重要**：git 通道的固定开销（index/pack/TLS 往返）在**小包场景下占绝对主导**——150 KB 的配置同步也要 3–10 s。所以：
- 配置类变更**不应走 git**，或必须做**合并批次**（一次 push 带多个 section），否则用户点一下按钮等 5 s 只为传 5 KB。
- 增量按「每会话一个 blob」提交，天然去重（内容寻址），比整目录覆盖更省。

### 7.4 建议阈值

| 阈值 | 值 | 理由 |
|---|---:|---|
| **单会话上限（默认同步）** | **5 MB** | 本机最大 3.15 MB；> 5 MB 的会话通常是长跑 agent + 大量 `tool/result`，传输与解析成本非线性上升 |
| **单会话硬上限（拒绝）** | **50 MB** | 超此值多半是异常（死循环写日志），UI 提示「手动处理」 |
| **会话总量告警** | **200 MB** | 首次全量超过 200 MB 时改为「只同步最近 N 天」模式 |
| **默认时间窗** | **最近 30 天** | 本机 40 会话跨度仅 3 天，全部在内；长期用户靠窗口控量 |
| **单附件上限** | **10 MB** | PNG 截图通常 < 2 MB |
| **附件总量告警** | **100 MB** | |
| **整包硬上限** | **500 MB** | 超过则拒绝打包，提示用户裁剪 |
| **跳过项（强制）** | `node_modules`、`bash-ipc`、`.dsh-market`、`exports/snapshots/sync/market/migration-history/transactions`、`session_projcache`、所有 `*.log` | 合计 ≈ 1.31 GB，占全量 98% |
| **首次全量预期** | **25–27 MB / 30–60 s** | 96% 是会话 |

---

## 8. 给 dsh-sync-hub 的建议

### 8.1 建议的分区（section）划分与默认开关

比 config-manager 的 17 分区更贴合本机实况：**合并空分区、拆开混杂分区**。

| # | section | 内容（本机实测） | 体积 | 默认 | 来源 |
|---|---|---|---:|---|---|
| 1 | `config` | `profiles/<p>/cordis.patch.yml` | 4.2 KB | **开** | 直接读文件 |
| 2 | `deps` | `package.json` + `pnpm-workspace.yaml` + `pnpm-lock.yaml` | 112 KB | **开** | 直接读文件 |
| 3 | `skills` | `$DSH_HOME/skills/**` | 28 KB | **开** | 直接读目录 |
| 4 | `prompts` | 自定义 prompt（本机空） | 0 | 开 | 需探测 |
| 5 | `presets` | agent preset（本机走 `agent-preset-registry`） | 小 | 关 | 需探测 |
| 6 | `workspaces` | `storages/workspace.json`（需路径改写） | 2.6 KB | **开** | storage unit |
| 7 | `pluginState` | 白名单插件 storage（如 `vision_router_session_policy`） | 小 | 关 | storage unit |
| 8 | `sessions` | `sessions/**` | 24.1 MB | **关**（显式勾选） | 见 §5 |
| 9 | `attachments` | `attachments/**` | 0.27 MB | **关**（随 sessions 联动） | 内容寻址 |
| 10 | `mcp` | MCP server 定义（本机空，需字段级 redact） | 0 | 开（空时无副作用） | §6.4 |
| 11 | `secrets` | **不实现为导出分区**，只实现为「引用清单」 | — | 关 | `credentialsStatus` 同级 |
| 12 | `providers` | 已并入 `config`（`llm-pi-ai` 就在 patch 里），不再单列 | — | — | — |

**默认可同步范围（一句话）**：`config + deps + skills + workspaces`，约 **150 KB**；`sessions + attachments` 默认关闭、需用户显式勾选并二次确认隐私提示。

**不建议照搬的 config-manager 分区**（理由在表里）：
- `settings` / `ui`：本机无 `settings.yaml`，UI namespace 为空对象 → **同步这两个 section 等于同步空气**（§4.1–4.3）。
- `providers`：数据在 `cordis.patch.yml` 的 `llm-pi-ai` 段里，拆出来会造成「同一份配置两个 section」。
- `credentialsStatus` / `secrets`：前者是脱敏视图（`hasValue:false`），同步过去毫无意义；后者在本机实现为「payload 为空 + 强制排除」，**正确的产品形态是「凭据引用清单」而不是「凭据同步」**——把 6 个 refs 键名同步过去当检查表，值永不导出。
- `pluginFiles` / `pluginAssets`：本机无关（无本地插件源码、无插件静态资源）。

### 8.2 每类资产的应用方式

| section | 应用方式 | 需重启 | 冲突策略 |
|---|---|---|---|
| `config`（cordis.patch.yml） | **YAML 三路合并**，按顶层条目 id 为合并单元 | **是** | 按条目 id 比较；同一条目双改 → 报告冲突，保留本地 + 写 `.conflict` 副本 |
| `deps`（package.json） | 合并 `dependencies` 与 `dsh.profile.bundles`（并集，`^` 版本取较宽） | 是（`pnpm install` 后） | 并集自动合并；版本冲突列出两侧 |
| `pnpm-lock.yaml` | **仅当 `deps` 无冲突时**覆盖写 | 是（`pnpm install --frozen-lockfile`） | 冲突则丢弃锁文件，让 pnpm 重算 |
| `skills` | 按 skill 目录**整目录覆盖**（同名先备份为 `<name>.bak-<ts>`） | 否（下次调用生效） | 同名双向修改 → 保留本地 |
| `workspaces` | **JSON 合并 + 路径改写**：合并 `tables.workspaces`，对端不存在则新增；`path` 字段用「对端 workspace 根」替换本机盘符段 | 是 | 同一 workspace id 的 `path` 不同 → 保留本地，仅合并 `sessionIds` |
| `sessions` | **只增不删**：按 session id 去重，本地已有的**永不覆盖** | 是（会话列表重载） | 天然无冲突（id 即内容标识）；同一 id 内容不同 → 保留本地并警告 |
| `attachments` | 内容寻址，**存在即跳过**（同 sha256 必同内容） | 否 | 无冲突 |
| `mcp` | 合并 `servers` 按 name；`env` 值全部置空 | 是 | 同名 server 保留本地 |
| 任何 `secret` 级 | **仅提示**：「本机有 N 个凭据，对端需自行配置」 | — | 不参与同步 |

**「导入后需重启」的名单**（DSH 需重启才生效）：`config`、`deps`、`workspaces`、`sessions`、`mcp`。
**不需重启**：`skills`、`attachments`、`pluginState`（取决于插件）。

### 8.3 跨机冲突的真实风险点

按发生概率 × 破坏力排序：

1. **`cordis.patch.yml` 被两台机器同时改（最高风险）**
   - 该文件被 config-manager 的 import 通道**整文件重写**（首行注释即证据），是「最后写入者胜」的语义。
   - 两侧各自启用不同插件 → 各自在文件末尾追加条目 → **基于文本的 merge 会产生语法错误**（YAML 顶层是数组，条目边界错位就整份失效）。
   - **必须做结构化合并（按条目 `id` 对齐），不能做行级 diff/patch。**
   - 且 `cordis.patch.yml` 里的 `web-search-free` 段有 14 个 platform 配置项，单条改动就可能几十行 → 行级冲突概率随条目大小线性上升。

2. **`package.json` 的 `dependencies` 版本漂移（高频）**
   - 本机 16 条依赖里 4 条用 `^`（`dsh-github-sync`、`dsh-plugin-dev-kb`、`dsh-useful-tools`、`dshmarket`），其余钉死。
   - 两台机器各 `pnpm install` 一次 → `^` 那 4 条装出不同版本 → 锁文件不一致 → 同一 UI 在两台机器行为不同。
   - 缓解：`deps` 同步后**必须**同时同步 `pnpm-lock.yaml`，并跑 `--frozen-lockfile`。

3. **`storages/workspace.json` 的 `global.archivedSessionIds` / `pinnedSessionIds`（中）**
   - 这两个数组是**集合语义**，用「整个 JSON 覆盖写」会把对端的归档/置顶全冲掉。
   - 必须做**集合并集**。而 `tables.workspaces[*].sessionIds` 也是集合 → 同样按并集合并，不是覆盖。

4. **`workspaces[*].path` 绝对路径（中）**
   - 本机是 `D:\VibeCoding`，对端可能是 `C:\Users\x\VibeCoding` 或 `/Users/x/VibeCoding`。
   - 覆盖写会让对端多出一个指向不存在目录的 workspace（DSH 会在侧栏显示但打不开）。

5. **同一 session id 在两台机器各自续写（低概率、高破坏）**
   - 用户在两台机器打开同一会话继续聊 → 同一个 `session.v4.jsonl.zstd` 产生两条不同历史。
   - 按 id 去重时必须**比较内容 hash**，不一致就保留本地 + 生成 `.conflict`，绝不能静默覆盖。

6. **`.dsh-market/state.json` 与配置的版本耦合（低）**
   - 市场发现缓存里存了 `pending-updates`，若与对端 `package.json` 版本不匹配会提示错误的可更新项。
   - 已归入 `local-only`，此风险由「不同步」消解。

7. **附件引用的悬空（低，但用户可见）**
   - 只同步 sessions 不同步 attachments → 对端会话里 29 行图片引用全部 404。
   - 建议把 `attachments` 做成 `sessions` 的**硬依赖**：勾 sessions 自动带 attachments（0.27 MB 不值得省）。

### 8.4 盘点模块的实现约束（给 UI 直接消费）

1. **每个被跳过的资产都要有理由**，且理由要能显示给人看：
   - `node_modules` →「依赖，`pnpm install` 重建」
   - `bash-ipc` →「运行时装，重新解压重建」
   - `.dsh-market` →「市场缓存，可重拉」
   - `.credentials.yaml*` →「凭据，永不导出」（**不要显示文件名以外的任何信息**）
   - 会话 →「含完整对话与工具输出，需确认」
2. **必须显示「已跳过 1.31 GB」的总量**，否则用户看到「1.34 GB → 26 MB」会以为工具坏了。
3. **`secret` 级条目在 UI 里只显示路径 + 一级理由，不显示大小以外的任何属性**（大小是安全的，值不是）。
4. **`settings.yaml` 不存在时静默降级**（§4.1），不要报 warning。
5. **会话列表不能依赖 `title`**（40/40 为空，§5.5）——用 `createdAt` + 首条 `user/message` 前 N 字。

---

## 附录 A · 已核实的命令片段

```powershell
# 顶层体积
Get-ChildItem -LiteralPath $H -Force | ForEach-Object {
  $s = if ($_.PSIsContainer) {
    Get-ChildItem $_.FullName -Recurse -File -Force -EA SilentlyContinue |
      Measure-Object Length -Sum
  } else { [pscustomobject]@{ Sum = $_.Length } }
  "{0,-32} {1,10:N2} MB" -f $_.Name, ($s.Sum / 1MB)
}

# 插件 dataDirs 声明
Get-Content "$P\package.json" -Raw | ConvertFrom-Json |
  ForEach-Object { $_.dependencies.PSObject.Properties.Name } | ForEach-Object {
    $j = Get-Content "$P\node_modules\$_\package.json" -Raw | ConvertFrom-Json
    "{0} dataDirs={1}" -f $_, $(if ($j.dsh.dataDirs) { $j.dsh.dataDirs -join ';' } else { '-' })
  }
```

```js
// 会话解压 + 统计（零依赖，node 24）
const fs = require('fs'), zlib = require('zlib'), path = require('path');
function walk(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p, acc) : e.name.endsWith('.zstd') && acc.push(p);
  }
  return acc;
}
const files = walk('C:/Users/HUAWEI/.dsh/sessions');
let raw = 0, lines = 0;
for (const f of files) {
  const txt = zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8');
  raw += Buffer.byteLength(txt); lines += txt.split('\n').filter(Boolean).length;
}
console.log({ sessions: files.length, rawMB: (raw / 1048576).toFixed(2), lines });
```

```powershell
# 配置里有没有内联密钥（只看键名，不看值）
Select-String -LiteralPath "$P\cordis.patch.yml" `
  -Pattern 'apiKey|token|secret|password|authorization|Bearer|ghp_|sk-' -AllMatches |
  ForEach-Object { "line $($_.LineNumber): $($_.Line.Trim())" }
```

---

## 附录 B · 与 00-brief 假设的偏差（需 upstream 知晓）

| 简报假设 | 实测 | 影响 |
|---|---|---|
| 会话目录内有 `meta` / `attachments` | **只有一个 `session.v4.jsonl.zstd`** | 盘点不能按「目录内多文件」设计 |
| 存在 `settings.yaml` | **不存在**，设置=patch+默认值 | 不要实现 `settings` 导出分区 |
| UI 设置可通过文件同步 | **在浏览器 localStorage** | UI 上标注「无法同步」而非报错 |
| 会话可能含密钥（含糊） | **必然含**：完整对话 + 工具输出 + `AGENTS.md` 全文 | 隐私等级直接定 `redacted` |
| 插件有 `dataDirs` 自述 | **16/16 无声明** | pluginData 目录名靠约定，需目录勾选 + 强制扫描 |
| MCP 可能含 env 密钥 | **本机 0 个 server** | 功能仍须实现，但不能用本机数据测 |
| node_modules 需说明为何不同步 | 857 MB + 平台二进制 + `@dsh-ops` 与 `bash-ipc` **重复 392 MB** | 跳过项要合计到 1.31 GB |
