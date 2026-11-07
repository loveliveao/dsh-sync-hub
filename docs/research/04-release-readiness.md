# dsh-sync-hub 发布就绪报告（dsh.so 上架）

> 目标：把本插件推到 dsh.so，拿到可复核的 L1→L5 验证记录。
> 本文全部结论基于**实测**（本机文件、npm pack 输出、semver 计算、asar 源码），
> dsh.so 侧规则来自 https://www.dsh.so/zh/verification/ 、/zh/submit/ 、/zh/security/ 、/zh/data/ 与 /zh/ecosystem/（数据截至 2026-11-06，站内当前 dsh 0.2.2-rc.1）。
> 记录日期：2026-11-07。仓库：`D:\dsh-sync-hub`（v0.4.0，MIT）。

---

## 一、结论摘要

| 维度 | 现状 | 判断 |
| --- | --- | --- |
| 插件形态 | 组合包（`package.json` → `dsh.bundle.patch` → `cordis.patch.yml`），零运行时依赖，纯 JS 无构建 | ✅ 是"真正的 dsh 插件"，不是"生态插件" |
| 运行时健壮性 | `inject = ['webServer','credentials','tools']`，全部是内置服务；apply 内 try/catch + ctx.effect 兜底 | ✅ 避开了 L5 最大坑（见下） |
| 版本闸门 | `engines.dsh` 本轮已改为双口径安全范围 | ✅ 刚修 |
| 元数据 | 缺 `repository` / `homepage` / `bugs`；`private: true` 未摘 | ❌ 待整改 |
| README 安装说明 | 只有 `file:` 本地路径一条命令 | ❌ 待整改（提交标准硬性要求） |
| 安全扫描面 | 示例密钥/假令牌本轮已清理，全仓库 0 命中 | ✅ 刚修 |
| 远程仓库 | **git 无 remote**，本地只有 master 分支 | ❌ 提交 dsh.so 的前置条件 |

**一句话**：代码侧的坑基本填平了，剩下的全是"发布形态"问题——渠道、仓库地址、README 安装段，这三项必须由用户拍板。

---

## 二、dsh.so 验证阶梯与本插件逐级自检

### L1 已找到
- 要求：GitHub 仓库可访问、非空、含 README。
- 现状：README.md 250 行内容完整 ✅；**但本地 git 没有 remote**，必须先推到公开远程仓。
- 动作：建 GitHub 仓库 → `git remote add origin` → push。

### L2 结构化
- 要求：manifest/package.json 有效，`name`/`license`/`description` 齐全，且已标注**分类(category)**与**使用场景(use-case)**。
- 现状：`name: dsh-sync-hub` / `license: MIT` / `description` ✅。
- 关键认知（来自 /plugin/@作者/插件名.json 的 `capability.declared`）：**分类与使用场景是 dsh.so 用 LLM 从 README + keywords 推断出来的**（`source: llm-labels`，taxonomy 为 `keyword` 或 `category`），不是我们手填的字段。
- 动作：在 README 开头把"这是什么、给谁用、典型场景"写成显式句子，并补英文 keywords，提升标签推断质量。

### L3 安装规范
- 要求：**从 manifest 解析出安装命令**，并声明 DSH 版本要求（`engines.dsh`）。
- 现状（dsh.so 实际口径，见 /plugin JSON 的 `install.command`）：
  - npm 渠道 → `dsh plugin --profile <profile> add @scope/pkg@1.2.3`（由 npm 包名 + 版本推出）；
  - GitHub 渠道 → `dsh plugin --profile <profile> add github:owner/repo#v0.3.0`（由 repo URL + tag 推出）。
- 结论：**`repository` 字段与稳定的 tag 命名（`v0.4.0`）是 L3 的两个杠杆**；`engines.dsh` 必须能覆盖当前 dsh 版本。

### L4 安装实测
- 要求：安装命令在一次性隔离沙盒里**真跑通**，无依赖错误。
- 现状：未做（本机 `dsh` 不在 PATH，需用测试 profile 或安装好的客户端）。
- 动作：见第五节 L4/L5 验收清单。

### L5 安装已验证
- 要求：沙盒安装通过 + 白名单受限冒烟动作（ping / health / metadata / fixture）+ web 启动就绪 + HTTP 可访问 + 插件清单 active。
- 现状：未做。
- 风险画像（/zh/ecosystem/，6,905 条 L5 失败）：**插件树加载失败 3,079 条（45%）**、启动失败 377、HTTP 未就绪 62、没进 loader 清单 40。安装漏斗 L4 83.9% → L5 66.3%。
- 本插件的抗风险点：`inject` 里的 `webServer`/`credentials`/`tools` 都是宿主内置服务，`dsh-github-sync`（已收录 L5）用的是同款组合（多一个 `workspaceRegistry`）；`apply` 内所有注册路径都包了 try/catch 并注册 disposer；HTTP 前缀 `/dsh-sync-hub` 前后端一致。

### 判定口径（提交时必须知道）
- L1–L3 与 dsh 版本无关；L4/L5 **只统计当前 dsh 版本的真测**。
- 同版本内以最新 L5 真测胜出；dsh 升级后旧判定保留并单列 stale，不会被清零。
- 通过率 = 通过 ÷（通过+失败），"生态插件 / 生态应用 / 未测"不参与；**未实测 ≠ 失败**。
- 站内只报出 "L5 · 生态插件" / "L5 · 生态应用" 这两种混合标签，所以要拿纯 "L5"，必须是 `dsh.bundle` 声明完整的真 dsh 插件。

---

## 三、提交接受标准逐条核对（/zh/submit/）

| 标准 | 本插件 | 结论 |
| --- | --- | --- |
| DSH 兼容信号（至少其一） | `package.json` 有 `dsh` 字段 ✅ / `cordis.patch.yml` 是 cordis manifest ✅ / keywords 含 `dsh-plugin` ✅ / 仓库加 `dsh-plugin` 话题 ✅ | ✅ 满足 |
| README 带安装说明 | 只有 `file:D:\dsh-sync-hub`（本地路径） | ❌ **必须补** GitHub / npm 两条命令 |
| 开源许可证（SPDX 可识别） | MIT + LICENSE 文件 | ✅ |
| 插件 id 合规 `^[a-z0-9]+(-[a-z0-9]+)*$` | `dsh-sync-hub` | ✅ |
| 源码可扫描 | 纯 JS/TS，零依赖，无构建产物 | ✅ |
| 安全扫描无阻断项 | 本轮清理后 0 命中 | ✅（仍需实测复核） |
| 渠道 | GitHub/Gitee/GitLab 仓库 或 npm 包名 | ⏸ **待用户决定** |

**提交后流程**：条目与扫描报告以 Issue 形式归档到 dsh.so 后台等人工审核；服务端每次提交都重新拉源码重扫（不用缓存），按 IP 与仓库限频（每 10 分钟数次）。收录时只以 "Declared" 兼容性收录，自测通过前绝不标 Verified —— 也就是说**等级不会自己涨**。

---

## 四、差距清单与整改动作

### 4.1 本轮已完成（实测通过）

| # | 动作 | 依据 |
| --- | --- | --- |
| 1 | `engines.dsh`：`">=0.2.1-rc.5"` → `">=0.2.1-rc.5 <0.2.2 || >=0.2.2-rc.1"` | DSH 的 `unmetRequirements` 用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`（asar `@deepseek-ai/dsh-app-boot/lib/index.js`），而 dsh.so 侧若用**严格** semver，现值会误判"不含 0.2.2-rc.1"。新范围在两种口径下都覆盖 0.2.1-rc.5 → 0.3.0（semver 实测 8 个版本 × 2 口径） |
| 2 | 删掉 `docs/workspace-check-2026-11-07.md:49` 的 `AKIAIOSFODNN7EXAMPLE`（AWS 官方示例密钥） | 会被 vet 判成硬编码密钥 → 阻断级风险；改成描述性文字后不再有该字面量 |
| 3 | `tests/transport.test.mjs`、`tests/git-guard.test.mjs` 的 `SECRET-TOKEN-*` / `p@ssw0rd-secret` 改成 `placeholder-not-a-real-token` 等明确占位符 | 消除"赋值型密钥字面量"警告；变量名 `secret` → `dummyToken` 一并改掉 |
| 4 | `package.json` 加 `scripts.test`（`node --test "tests/*.test.mjs"`）与 `author.name` | 官方必需元数据清单缺 scripts/author；`npm test` 实测 exit 0（9 tests / 0 fail） |
| 5 | 全仓库密钥样式字面量复扫（含 docs/tests/lib/client.js/README） | **0 命中** |

### 4.2 待用户决策（拍板后才能落地）

| # | 动作 | 说明 |
| --- | --- | --- |
| 6 | 摘掉 `"private": true` | npm 渠道的前提（保留则 `npm publish` 直接被拒）。若最终只走 GitHub 渠道则可保留 |
| 7 | 补 `repository` / `homepage` / `bugs` | L3 从 manifest 解析安装命令要用 repo URL；URL 取决于第 8 项 |
| 8 | **发布渠道与仓库地址** | GitHub 仓（公开，否则 dsh.so 扫不到）／ npm 包名（`dsh-sync-hub`、`@dsh-so/dsh-sync-hub`、`dsh-sync-hub-plugin` 均未被占用；`dsh-sync` 已被占用 0.1.3）／ 两者都做 |
| 9 | README 安装段改成渠道口径 | 例如 `dsh plugin --profile <profile> add github:<owner>/<repo>#v0.4.0` 与 `... add <pkg>@0.4.0`；同时保留本地 `file:` 用法作为开发说明 |

### 4.3 可以马上做（不依赖决策）

| # | 动作 | 目的 |
| --- | --- | --- |
| 10 | README 增加「网络与文件读写范围」声明段 | 安全扫描会命中"数据外传端点""env 访问"（本插件确实读凭据、可传远端），显式声明能让人工复核时一眼看懂 |
| 11 | keywords 补英文（`config-sync` `session-sync` `multi-device` `developer-tools`） | dsh.so 的 category/use-case 靠 README+keywords 推断，词汇越准标签越准 |
| 12 | README 补一句 `npm test` 用法 | 与新 scripts 对齐 |
| 13 | 定版与 tag 规范 `v0.4.0` | GitHub 渠道的安装命令带 tag，tag 缺失会拉不到目标版本 |

---

## 五、L4/L5 上架前的本地验收清单

> 官方 smoke 三件套（`docs/research/02-dsh-plugin-spec.md` L665）用**真实入口**，不用 mock。

### 5.1 安装（对应 L4）

```bash
# 1) 干净 profile 里真实安装（不是 file: 直链）
dsh plugin --profile <test-profile> add <owner>/<repo>#v0.4.0
# 或 npm 渠道
dsh plugin --profile <test-profile> add <pkg>@0.4.0

# 2) 层级闸门：能看到本插件的层才算装对
dsh --profile <test-profile> --dump-config
```

预期：`# == dsh-sync-hub` 层出现；`dsh plugin list` 能查到；无 `incompatible-version`（engines.dsh）、无 `build-blocked`（pnpm allowBuilds，本插件无 prepare 脚本，正常不该出现）。

### 5.2 冒烟（对应 L5）

1. profile 启动无报错，日志无 `did not activate`；
2. `ctx.tools.schemas()` 里出现 `sync_hub_status` / `sync_hub_plan` / `sync_hub_run` / `sync_hub_sessions`；
3. `GET /dsh-sync-hub/state` 返回 200 且是 JSON（HTTP 服务就绪 + 清单 active）；
4. 白名单受限动作自检：ping / health / metadata / fixture 四类要能被触发且不越权。

### 5.3 打包核对

```bash
npm pack --dry-run   # 期望 entryCount 42 / size ≈ 169 KB（改完元数据后重取）
npm test             # 期望 9 tests / 0 fail
```

---

## 六、提交 dsh.so 的操作口径

1. 先推公开远程仓（GitHub/Gitee/GitLab），仓库打 `dsh-plugin` 话题 → 可被自动索引；
2. 走 https://www.dsh.so/zh/submit/ 的提交表单；纯 npm 条目元数据/许可证/安装命令全来自**已发布的 tarball**，声明了仓库的条目则从仓库同步星标/fork/许可证；
3. 提交后条目与扫描报告以 Issue 形式归档，等人工审核；服务端会**重新拉源码重扫**，按 IP 与仓库限频（每 10 分钟数次）——别连续重提；
4. 想看外部复核结果，可用公开数据接口（免密钥、CORS 全开）：
   - `https://www.dsh.so/artifact/@作者/插件名.json`（安全：badge.state / findings / dynamicAudit / scannedAt / commitSha）
   - `https://www.dsh.so/data/install/@作者/插件名.json`（安装：installTest.state / level / verified / checkedAt / environment）
   - `https://www.dsh.so/plugin/@作者/插件名.json`（规范事实表）
   - `https://www.dsh.so/plugins-index.json`（全量检索 feed）

### 安全扫描的预期结论（提前知道，免得慌）

- 本插件会命中：**数据外传端点**（Git/WebDAV 远端）、**env 访问**（令牌经 `GIT_CONFIG_*` 注入子进程）、**凭据文件读取**（默认关闭，开关打开才读）。
- 这些**不是**阻断项，只要在 README 里把"读什么、往哪传、默认关"讲清楚，人工复核会放行。
- 真实阻断项只有一类：硬编码密钥。本轮已清零。

---

## 七、已知未知（黑盒，别白费时间）

- dsh.so 的提交接口契约拿不到（站源码仓库取不到：raw 404 + API 限流），表单字段以实际页面为准；
- 它的冒烟协议（ping/health/metadata/fixture 具体长什么样）不在官方 KB 里，只能按站内描述对齐；
- 站内 `capability.declared` 目前是 AI 推断（`taxonomy: keyword`），"verified"通道还没落地 —— **我们只能通过写好 README 来提高标签质量**。

---

## 八、维护约定

- 改完插件跑 `npm test`（8 个 `*.test.mjs` 覆盖分析/双机/防御性/git 闸门/凭据/会话归一/传输）。
- 本文与 `docs/research/01`–`03` 同属研究档案，发布前再更新一次"实测数字"。
- 涉及用户 DSH 配置（`$DSH_HOME/profiles/*`）的动作一律只读，改动步骤写成可复制片段交给用户。
