# dsh-sync-hub · 同步中心

在多台电脑之间同步 DeepSeek Harness 的**配置**与**会话**，明确区分「哪些同步、哪些不同步」，
并且**永不传输任何凭据**。

界面入口：**设置 → 同步中心**（五个页签：概览 / 同步范围 / 传输通道 / 会话 / 计划与备份）。

---

## 一、它解决什么问题

`~/.dsh` 目录 1.3 GB，其中真正值得跨机携带的只有约 **26 MB**（96% 是会话记录）。
直接同步整个目录既慢又危险：`node_modules` 有 800 MB 以上、里面还有两份重复的 MSYS2 工具链，
凭据文件则根本不该离开本机。

同步中心做三件事：

1. **盘点**：把 DSH 版本、profile、已装插件、会话清单读出来，显示每一项的体积。
2. **比对**：本地与远端各有一份 sha 清单，算出「要推送 / 要拉取 / 冲突 / 已一致」。
3. **应用**：按你勾选的范围推送与拉取，写入前先备份，冲突按策略处理。

## 二、安装

```bash
# 装进当前 profile（插件是组合包，装完需要重启 DSH 才生效）
dsh plugin --profile desktop add file:D:\VibeCoding\scratch\dsh-sync-hub
```

重启后打开 **设置 → 同步中心**。卸载：`dsh plugin --profile desktop remove dsh-sync-hub`。

没有运行时依赖（只用 `node:*` 内置模块），因此不会往 profile 里引入任何第三方包。

## 三、同步范围（默认值）

| 范围 | 内容 | 默认 | 说明 |
| --- | --- | --- | --- |
| DSH 配置 | `profiles/<profile>/cordis.patch.yml`、`cordis.yml` | 开 | 模型提供商、界面、插件参数；**字面量密钥导出时脱敏**为 `<redacted>` |
| 插件清单 | profile `package.json` 的依赖与 bundles | 开 | **只读上报**，绝不自动安装（bundles 里的未安装项会让 DSH 启动失败） |
| 技能库 | `~/.dsh/skills` 整棵树 | 开 | 技能里若写了密钥，导出时同样脱敏 |
| 会话 | `~/.dsh/sessions/**/session.v4.jsonl.zstd` | 开 | 按会话合并，**不会删除**另一台机器的会话 |
| 工作区列表 | `storages/workspace.json` 摘要 | 关 | 只读上报：工作区路径跨机通常无意义 |
| 插件数据 | 市场 / 插件管理器等状态目录 | 关 | 可能含本机路径 |
| 自定义路径 | 你填的、相对 `~/.dsh` 的路径 | 关 | 文件和目录都行，文本类会脱敏 |

排除规则（无论怎么勾都不会被读写或传输）：
`.credentials.yaml*`、`dsh-config-manager/vault/`、`openai-gateway/api-key`、
`auth|oauth|token|secrets.json`、`.env*`、`.netrc`、`*.pem|p12|pfx|key`、私钥文件、
以及插件自己的 `~/.dsh/sync-hub/`。

## 四、传输通道（三种，任选其一）

1. **共享文件夹** —— OneDrive / 坚果云 / NAS 同步盘的某个目录。最简单，适合两三台机器。
   三台机器填**同一个目录**（各自本机路径可以不同，指向同一份云端同步内容即可）。
2. **Git 仓库** —— 任意私有仓（GitHub / Gitee / 自建）。有历史、天然支持多机合并。
   私有仓的令牌存在 DSH 凭据库里，**不写进 `.git/config`**，也不回传界面。
3. **WebDAV** —— 坚果云、Nextcloud、群晖等。填服务器地址 + 用户名 + 密码。

目标目录的布局：

```
manifest.json                         # 条目清单：路径、sha256、大小、来源设备
blobs/ab/abcdef...                    # 内容寻址的 blob，按 sha 前两位分桶
```

因为按内容寻址，同一份会话在两台机器上只存一份；远端只增不减，删除不会跨机传播。

## 五、冲突与备份

- **先预览再同步**：「计划与备份」页的**预览变更**只读远端、算差异，不写任何文件。
- **冲突策略**：保留更新的（按修改时间）/ 保留本机 / 保留远端 / 跳过。
- **DSH 配置不按行合并**：`cordis.patch.yml` 会被 config-manager 这类插件整文件重写，
  行级合并会毁掉 YAML。同步时按顶层条目 id 结构化合并，脱敏段用「键名对齐」还原
  （远端是 `<redacted>`、本机有同名键时用本机的值）。
- **写入前备份**：被覆盖的文件先复制到 `~/.dsh/sync-hub/backups/<时间戳>/<原相对路径>`，
  默认保留最近 20 份，可在界面调整。

## 六、给 Agent 用的工具

| 工具 | 作用 |
| --- | --- |
| `sync_hub_status` | 本机版本、设备、各范围条目数与体积、远端概况、凭据是否已配置 |
| `sync_hub_plan` | 只算差异，返回 push / pull / conflict 列表 |
| `sync_hub_run` | 执行一次同步，返回推送/拉取/冲突/失败数 |
| `sync_hub_sessions` | 列出会话（标题、工作区、大小、是否已在远端） |

HTTP 接口（前缀 `/dsh-sync-hub`）：`GET /state`、`GET /status?remote=1`、`GET /sessions`、
`GET /backups`、`POST /settings`、`POST /secret`、`POST /test`、`POST /plan`、`POST /run`。

## 七、不做的事（边界）

- **不同步浏览器端设置**：主题、快捷键、侧边栏布局存在浏览器 localStorage 里，插件无法跨机搬运。
- **不自动装插件**：插件清单只上报差异，装不装由你决定。
- **不删除对方数据**：远端只增不减，本机也不会因为远端缺失而删除文件。
- **不碰凭据**：`.credentials.yaml` 与其备份、各类 API key 一律不读、不写、不传。
- **会话引用的附件暂时不跟随**（`/attachments/` 引用）；后续版本计划作为可选范围加入。

## 八、开发

```bash
node tests/smoke.mjs      # 无宿主冒烟：采集 → 推送 → 二次计划 → 伪造远端会话可拉取
```

目录：

```
index.js             服务端入口（name / inject / apply）
lib/paths.mjs        路径解析（全部限制在 $DSH_HOME 内）
lib/sections.mjs     七个范围的采集与脱敏
lib/privacy.mjs      隐私红线与脱敏规则
lib/version.mjs      DSH 版本探测（asar 包 / runtime.json / 环境变量）
lib/engine.mjs       差异决策、冲突、备份、应用
lib/transport/       local / git / webdav + 共享基类
lib/server.mjs       HTTP 路由
lib/tools.mjs        四个 Agent 工具
client.js            设置页 UI（手写 JS，仅 require('react')）
cordis.patch.yml     组合包 patch（insert 本插件 + 初始配置）
```

设计取舍、官方规范摘录与配置盘点见 `docs/research/`：
`01-existing-plugins.md`（本机已装的三个同步插件做了什么）、
`02-dsh-plugin-spec.md`（插件 API 与打包规范）、
`03-config-inventory.md`（本机 DSH_HOME 逐项盘点与体积/隐私结论）。
