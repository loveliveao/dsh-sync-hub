# 05 · dsh.so 同款安全扫描实测报告（vet static-v31）

> 日期：2026-11-07 · 扫描器：`@jieai/dsh-plugin-vet@0.5.27`（dsh.so 投稿页与安全报告页同款 vet，主页 <https://github.com/wulun811/dsh-plugin-vet>）
> 引擎：`static-v31` · scanBasis：`git`（GitHub 渠道口径）· dshVersion：`0.2.2-rc.1`
> 本文只记录**实测结果**，不含推测。所有数字都来自本地真实跑出来的扫描报告（`.dev/vet-scan-git-*.json`）。

## 一、结论摘要

| 口径 | verdict | staticScore | findings | info | medium | high | critical |
|---|---|---|---|---|---|---|---|
| A. 当前工作树（未打补丁） | `suspicious` | 0 | 82 | 60 | 20 | 2 | **0** |
| B. 沙箱快照 + 本文三处补丁 | `clean` | 0 | 78 | 59 | 19 | 0 | **0** |

1. **没有阻断级（critical）发现**：无硬编码密钥、无数据外传端点、无挖矿特征、无加密/批量删除家族。
2. **verdict 被顶成 `suspicious` 的唯一原因是 2 条 R3 high**：`lib/version.mjs:37` 直接读 `process.resourcesPath`（同文件重复上报 2 次）。
3. 打上补丁后 **verdict=clean**（vet 的判定口径：critical≥1→critical，否则 high≥1→suspicious，否则 clean）。
4. `staticScore=0` 是分数被 medium 累加扣到地板（19×8×0.8≈121.6 → 100−121.6→0），不是异常；vet 源码注释明确写「The ONLY authoritative verdict」是 `verdict` 字段。
5. 剩余 19 条 medium **全部是 R11「删除文件操作 rm()」**。vet 规则原文（`lib/scanner-bin/rules/destructive-ops.js`）写明：`DELETE_OPS = unlink/unlinkSync/rm/rmSync/rmdir/rmdirSync` → medium（除非路径字面量命中敏感路径才升 high），并注明「cleanup is common; LLM audit reviews context」。→ 换 `unlink` 之类只是绕过检测、没有收益（同样 medium），**不做这种规避**；正确做法是按 dsh.so「警告级需人工复核」逐条写审计说明（见第六节）。
6. dsh.so 提交标准里「安全扫描通过」指**无阻断级发现**；我们当前（打补丁后）为 0 critical → 满足。

## 二、怎么复现（全程不碰用户 DSH profile）

```bash
# 1. 隔离安装扫描器（不装进任何 profile，不改 `$DSH_HOME`）
npm install @jieai/dsh-plugin-vet --prefix .dev/vet --legacy-peer-deps
#    ^ 必须 --legacy-peer-deps：它 peer 依赖 @deepseek-ai/cordis ^4.0.1，
#      而 @deepseek-ai/dsh-invariants 要 ~4.0.4、@deepseek-ai/dsh-llm 要 ~4.1.0，npm 会 ERESOLVE。

# 2. 不能直接跑它的 bin：lib/gate-cli.js 依赖未安装的 peer @deepseek-ai/dsh-tools
#    Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-tools'
#    改走零依赖的独立子进程入口 lib/scanner-bin/index.js（stdin 一条 ScanRequest → stdout 一条 ScanResponse）

# 3. 驱动脚本（本仓库已备好）
node .dev/run-vet-scan.mjs "D:/dsh-sync-hub" git 0.2.2-rc.1
```

请求形状（`lib/scanner/scan-request.js` 的 `buildFileScanRequest`）：
`{ kind:'files', files:[绝对路径], targetKind:'plugin', osv:false, scanBasis:'git'|'npm', dshVersion:'0.2.2-rc.1' }`

文件枚举用 vet 自己的 `listSourceFiles` + `listInstructionFiles`，保证与线上口径一致。

## 三、扫描面（32 个源码文件 + 3 个附属文件）

- **源码面**：`index.js`、`client.js`、`lib/**`（含 `transport/`）、`package.json`、`cordis.patch.yml`、`tests/*.test.mjs`、`tests/smoke.mjs`
- **指令面**：根级 `AGENTS.md`（R18 指令注入观测面）
- **不在扫描面**：`docs/**`、`locale/*.json`、`icon.svg`、`README.md`、`.dev/`、`.git/`
  → 结论：**文档里写的示例密钥不会被扫到**，但 `tests/` 里会被扫到（所以示例令牌仍要清理，上一轮已做）。

## 四、基线（A）完整 findings 清单

### 4.1 high（2 条，verdict 的唯一元凶）

| 规则 | 位置 | 证据 | 说明 |
|---|---|---|---|
| R3 | `lib/version.mjs:37` | `process.resourcesPath` | Electron 专有属性，直接读属「宿主捕获」面，vet 判 high/certain |

### 4.2 medium（20 条）

| 规则 | 位置 | 说明 |
|---|---|---|
| R9 | `lib/session-canon.mjs:144` | 正则嵌套量词 `("(?:[^"\\]|\\.)*")` → ReDoS 风险 |
| R11 | `lib/engine.mjs:228` | `rm(join(root,name),{recursive:true})` 旧备份目录清理 |
| R11 | `lib/archive.mjs:72` | 同上（另一会话新加的 archive 模块） |
| R11 | `lib/session-canon.mjs:360` | 删除本机会话副本 |
| R11 | `lib/transport/git.mjs:380` | dispose 时删 `.git/index.lock`（自建临时 workdir 内） |
| R11 | `lib/transport/local.mjs:69/72/153/160` | 覆盖写前删旧文件、删临时文件、可写性探针文件删除 |
| R11 | `lib/util.mjs:23` | rename 失败后删临时文件 |
| R11 | `tests/*.test.mjs`（10 处） | 测试里的临时目录清理 |

### 4.3 info（60 条，摘要）

- R2 `client.js:19` `require('react')` —— DSH bundle 客户端加载器标准写法（vet 自己这么标注）
- R3 一批「只读 process 成员（能力触达面）」：`process.env` / `process.pid` / `process.argv` / `process.platform` 等
- R6 `lib/util.mjs:3` 「字符串特征：child_process 引用」——用于跑 git
- R15/N5 三处「网络目标动态构造，静态不可审计」：`client.js:606/608`、`lib/transport/webdav.mjs:52`（目标由运行时配置决定，本来就该动态）
- **R12 一条值得修**：`engines.node=>=20 低于 DSH 运行要求（>=22.19），可能不兼容`
- R19/其它：0

### 4.4 capabilities（扫描器观测到的能力面）

```
hosts       : github.com, dav.example.com, example.invalid, 127.0.0.1:9   ← 后三个是测试夹具/默认值
fsPaths     : /dsh-sync-hub, /sessions/, .dsh, /state, /settings, ~/ …
spawnCmds   : bash                                                      ← 跑 git 用
imports     : react                                                     ← DSH web 客户端运行时提供
ghostDeps   : react                                                     ← info 级：声明与引用不一致
hasNetwork  : true        hasExec: true        esmNamedBuiltins: true
esmNamedBuiltinModules: fs/promises, fs, child_process
hasNativeBinary: false
```

## 五、三处补丁（已实测验证，**尚未落到工作树**）

> 补丁文件：`.dev/vet-patch-2026-11-07.diff`（`git apply` 可用）；补丁后的三个文件副本在 `.dev/patch-candidate/`。
> 落地前请确认另一会话没有改动同三个文件（实测 2026-11-07 14:36 时，三个文件与快照一致）。

### 补丁 1：`lib/version.mjs:37` 去掉冗余的 `process.resourcesPath`

```diff
   // 桌面版：<安装目录>\DeepSeek Harness.exe → <安装目录>\resources
   if (process.execPath) push(join(dirname(process.execPath), 'resources'))
-  if (process.resourcesPath) push(process.resourcesPath)
   if (process.env.DSH_RESOURCES_DIR) push(process.env.DSH_RESOURCES_DIR)
```

依据：Electron 下 `process.resourcesPath` === `dirname(process.execPath)/resources`，与上一行**同值**（注释就写着「桌面版：…→ …/resources」），删掉是纯冗余、零行为变化。
效果：**2 条 high/certain 消失**（这是 verdict 从 suspicious 变 clean 的关键）。

### 补丁 2：`lib/session-canon.mjs:144` 手写扫描器替换嵌套量词正则

把 `/"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/g` 换成手写的 `findCwdLiteral(head, expectedLiteral)`（逐字符扫描 JSON 字符串字面量，遇 `\\` 跳过两字符），`replaceCwdLiteral` 改为基于其返回值定点替换。

依据：(a) 消除 R9 的 ReDoS 告警；(b) 语义等价且更直白（只认成对写法）；(c) 沙箱 `node --test "tests/*.test.mjs"` → **9 pass / 0 fail**（含 `tests/session-canon.test.mjs`）。

### 补丁 3：`package.json` `engines.node` `>=20` → `>=22.19`

依据：vet 的 DSH 需求闸门明确指出 DSH 运行时要求 Node ≥22.19；我们插件跑在 DSH 内，实际最低就是 22.19。改后那条 info 消失。

### 打补丁后的实测对比

| 项 | A 基线 | B 打补丁 |
|---|---|---|
| verdict | suspicious | **clean** |
| findings | 82 | 78 |
| high | 2 | **0** |
| medium | 20 | 19（全为 R11 rm 清理） |
| info | 60 | 59（少的是 engines.node 那条） |
| 插件自带测试 | — | 9 pass / 0 fail |

## 六、剩余 19 条 R11 的审计说明（按 dsh.so / vet 的口径逐条交代）

vet 的 `destructive-ops.js` 判定：删除类调用一律 medium，**只有路径字面量命中敏感路径正则**（`/etc/`、`/root/`、`.ssh`、`.aws`、`crontab` 等）才升 high。我们 9 处 lib 站点逐一核对：

| 位置 | 删除对象 | 为什么安全 |
|---|---|---|
| `lib/engine.mjs:228` | `$DSH_HOME/sync-hub/backups/<旧时间戳>/` | 只删插件自己备份区里超出 `keepBackups` 的旧目录 |
| `lib/archive.mjs:72` | 同上（workspace 备份） | 同上 |
| `lib/session-canon.mjs:360` | `$DSH_HOME/sync-hub/sessions/<id>/` 本机副本 | 只删本插件同步库里的会话副本，保留 keepDir 那一份 |
| `lib/transport/git.mjs:380` | 自建临时 workdir 里的 `.git/index.lock` | 只清自己产生的 git 锁 |
| `lib/transport/local.mjs:69` | 同步目标文件（覆盖写前） | 用户指定的同步文件夹内的目标文件 |
| `lib/transport/local.mjs:72` | 同步临时文件 | 同上目录的 `.tmp-` 文件 |
| `lib/transport/local.mjs:153/160` | 可写性探针 `.dsh-sync-hub-probe-<pid>` | 检测完立即删自己的探针 |
| `lib/util.mjs:23` | `.tmp-<pid>-<ts>` 临时文件 | rename 失败时的兜底清理 |

共 9 处 lib + 10 处 tests（测试里删自己的临时目录）。**无一处命中敏感路径**，无密钥/凭据文件被删——与 `lib/privacy.mjs` 的 `SECRET_FILES`（`.credentials.yaml`、`dsh-config-manager/vault/.credentials.yaml`、`openai-gateway/api-key`）没有交集。

## 七、对照 dsh.so 提交接受标准的差距（实测口径）

| dsh.so 要求（<https://www.dsh.so/zh/submit/>） | 现状 | 结论 |
|---|---|---|
| DSH 兼容信号 | `package.json` 的 `dsh.bundle.patch` + `dsh.client` + keywords 含 `dsh-plugin` | ✅ 满足 |
| README 带安装说明 | 目前只有 `add file:D:\dsh-sync-hub`（本地路径） | ❌ 需补 GitHub / npm 口径 |
| 开源许可证（SPDX） | `MIT` + LICENSE 文件 | ✅ 满足 |
| 插件 id 规范 `^[a-z0-9]+(-[a-z0-9]+)*$` | `dsh-sync-hub` | ✅ 满足 |
| 源码可扫描 | 32 个源码文件 | ✅ 满足 |
| 安全扫描无阻断级 | critical=0（打补丁后） | ✅ 满足（警告级需人工复核，即本文第六节） |
| 渠道：GitHub 仓库 | **无 git remote、仓库未创建** | ❌ 待办 |
| 渠道：npm 包名 | `private:true` 阻断 publish；`dsh-sync-hub` 包名未被占用 | ❌ 待办（需去掉 private） |
| `repository` / `homepage` / `bugs` 字段 | 全部缺失 | ❌ 待办 |
| `engines.dsh` | `>=0.2.1-rc.5 <0.2.2 || >=0.2.2-rc.1` | ⚠️ 语义上等价于「≥0.2.1-rc.5 且无上限」，建议改成 `>=0.2.1-rc.5 <0.3.0-0`（与已收录 L5 的 dsh-git-plugin 同款写法） |

补充实测：
- **`engines.dsh` 闸门验证**：vet 的 DSH 需求闸门在 `dshVersion` = 0.2.1-rc.5 / 0.2.2-rc.1 / 0.3.0-rc.1 三档都**没有报任何版本不满足**（说明当前范围可满足，但也没有上限保护）。
- DSH 自己的闸门（asar 内 `@deepseek-ai/dsh-app-boot` 的 `satisfies()`）用 `semver.satisfies(v, range, { includePrerelease: true })`，所以预发布版本不会被误拒。
- npm 侧 `dsh-sync-hub` / `@dsh-so/dsh-sync-hub` / `dsh-sync-hub-plugin` 三个包名当前**均未被占用**（`dsh-sync` 已被占用 0.1.3）。

## 八、L4 / L5 本地验收清单（提交前自测）

L4 = 隔离沙盒安装成功；L5 = 装上后插件树能加载 + 白名单冒烟动作 + web 端口 HTTP 可达 + 清单 active。

1. `dsh plugin --profile <隔离profile> add <github 或 npm 口径>` → 安装成功、无依赖错误；
2. `dsh --profile <隔离profile> --dump-config` 能看到 `# == dsh-sync-hub` 层；
3. 插件树加载无报错（`inject: ['webServer','credentials','tools']` 三个服务都要在）——**这是 L5「插件树加载失败」（占失败原因 45%）的头号来源，本插件的 inject 组合与已收录 L5 的 dsh-github-sync 一致**；
4. `GET /dsh-sync-hub/state` 返回 200 JSON；
5. `ctx.tools.schemas()` 里出现 `sync_hub_status/sync_hub_plan/sync_hub_run/sync_hub_sessions`；
6. 工具各执行一次冒烟（不真传远端）。

## 九、权威来源

- 验证阶梯 <https://www.dsh.so/zh/verification/> · 提交与接受标准 <https://www.dsh.so/zh/submit/> · 方法论 <https://www.dsh.so/zh/methodology/> · 安全 <https://www.dsh.so/zh/security/> · 数据接口 <https://www.dsh.so/zh/data/>
- 兼容矩阵 Discussions <https://github.com/deepseek-ai/deepseek-harness/discussions> · 架构 <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- 扫描器 <https://github.com/wulun811/dsh-plugin-vet>（npm `@jieai/dsh-plugin-vet`）· 审计协议 <https://github.com/wulun811/dsh-plugin-vet/blob/main/AUDIT_PROTOCOL.md>
- 提交队列仓库 <https://github.com/ihuajiu/dsh-plugin-submissions>

## 十、本报告未覆盖（已知未知）

- dsh.so 的 L4/L5 沙盒与冒烟协议细节站内未公开，只能按第八节自测；
- dsh.so 站内「插件市场尚未暴露逐对象的验证阶段位」，L1–L5 展示位与 Verified 徽章不是一回事（<https://www.dsh.so/zh/methodology/>）；
- 提交队列仓库的 Issue 样例未取到（GitHub API 限流），条目字段的精确契约仍是黑盒。
