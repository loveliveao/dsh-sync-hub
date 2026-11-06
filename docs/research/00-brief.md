# dsh-sync-hub 项目简报（研究阶段共享上下文）

## 背景

用户有多台电脑跑 DeepSeek Harness（DSH），需要把 **配置 + 会话** 在多台机器间同步。
他本机已经装了三个同类插件，本项目要把它们的能力融合成一个新插件：

| 已安装插件 | 作用 | 位置 |
|---|---|---|
| `dsh-github-sync` 0.5.1 | 会话 + 工作区文件夹 → 私有 GitHub 仓，跨设备接力 | `C:\Users\HUAWEI\.dsh\profiles\desktop\node_modules\dsh-github-sync` |
| `dsh-config-manager` 0.4.2 | 配置备份/恢复/导出/导入/迁移 + Git/WebDAV/S3/gist 同步 | `C:\Users\HUAWEI\.dsh\profiles\desktop\node_modules\dsh-config-manager` |
| `dsh-session-sync`（已在 cordis.patch.yml 配置，包可能已卸载） | 会话 git 同步 | 配置在 `C:\Users\HUAWEI\.dsh\profiles\desktop\cordis.patch.yml` 第 164-170 行；README 副本在 `D:\VibeCoding\scratch\readme-dsh-session-sync.md` |

目标是**新写一个干净插件**（不是把三者代码拷进来），吸收三者已验证的做法：
会话格式处理、manifest 格式、隐私过滤、传输层（git/webdav）、UI 形态。

## 硬约束

1. 必须能在当前桌面版 DSH 上加载：desktop 0.2.2-rc.1（runtime node 24.21.0 / pnpm 11.28.5），profile `desktop`。
2. 插件工程目录：`D:\VibeCoding\scratch\dsh-sync-hub`（独立 git 仓）。
3. 尽量零运行时依赖：只用 Node 内置模块（fs/path/zlib/crypto/fetch/child_process）。不要引入 React 以外的重型依赖；client 端只用 DSH 客户端已有的运行时。
4. **隐私红线**：凭据、token、API key、OAuth、`.credentials.yaml`、MCP env 密钥一律不进入同步包（默认排除 + 导出前脱敏）。用户明确要求「除隐私数据外」。
5. 平台：Windows 优先，路径处理要跨平台（插件也要能跑在 macOS 上）。

## 产品形态（Lead 已定的基线）

- 插件 id：`dsh-sync-hub`，中文名「同步中心」。
- 服务端（index.js + lib/）：盘点 DSH 版本与设置 → 生成 manifest → 打包 → 推送/拉取远端 → 应用（含冲突策略）。
- 客户端（client.js）：设置页一个「同步中心」面板 + 侧边栏入口；分组开关（设置/插件/MCP/Skill/会话…）、逐项勾选、远端配置、计划预览（dry-run）、运行与历史。
- Agent 工具：`sync_hub_status` / `sync_hub_plan` / `sync_hub_run` / `sync_hub_sessions` 之类。
- 传输层：本地文件夹 / Git 远端 / WebDAV；S3 可选。

## 三个研究员的交付物（互不重叠）

| 文件 | 负责人 | 内容 |
|---|---|---|
| `docs/research/01-existing-plugins.md` | ref-analyst | 三个插件的能力矩阵、数据格式、隐私处理、传输实现、UI 结构、可复用代码片段（带文件:行号） |
| `docs/research/02-dsh-plugin-spec.md` | spec-digest | 官方插件开发规范摘要 + 可直接抄的骨架代码（服务端/工具/设置 schema/客户端 UI 注册/服务/路由/打包） |
| `docs/research/03-config-inventory.md` | inventory | `~/.dsh` 与 profile 全量清单：每个产物的路径、格式、体积、隐私等级、是否需要同步 |

## 写作要求

- 结论带**确切值**：绝对路径、行号、字段名、API 名、代码片段。
- 先给「结论 / 建议」，再给证据。
- 不写空话，不复述官方文档全文；只留本项目要用的部分。
- 中文写作，代码与标识符保持英文。
