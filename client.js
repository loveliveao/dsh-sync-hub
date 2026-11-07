// dsh-sync-hub · 客户端半边（浏览器模块，无 node:fs）
// 手写 JS，不经打包：平台按 __ModuleLoader__ 工厂格式直接加载。
//
// 文件结构（从上到下）：
//   1. 常量与文案（ZH/EN）
//   2. 主题 token 与小工具
//   3. 数据层：全局 store（主面板与设置区共用一份状态）
//   4. 基础组件：Button / Row / TextInput / Select / Switch / Badge / Card /
////      Banner / Empty / Collapsible / Steps / SyncIcon
//   5. 主面板（main 槽位）：日常同步台 —— 状态条 + 下一步引导 + 一键同步 + 范围快捷开关
//   6. 配置中心（settings.section）：三页签 —— 概览 / 同步范围 / 传输通道
//   7. 插件注册：main 槽位 + sidebar.panellist + settings.section
//
// 约定：样式只用主题 token（--dsw-alias-*），不写死颜色；不 import 任何
//       Harness Client 包（组件抛错会让整个 slot 变成空白）；文案走 t()。
window.__ModuleLoader__.load({
  id: 'dsh-sync-hub',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-sync-hub';
    const PANEL_ID = 'dsh-sync-hub';
    const SECTION_ID = 'dsh-sync-hub';
    const PREFIX = '/dsh-sync-hub';
    // 插件版本以服务端 /state 返回的 plugin.version 为准（读自 package.json），
    // 这里的常量只是拿不到状态时的兜底。
    const FALLBACK_VERSION = '0.3.0';

    /* ---------- 1. 文案 ---------- */

    const ZH = {
      nav: '同步中心',
      title: '同步中心',
      subtitle: '多台电脑共用一份 DSH 配置与会话',
      section: '同步中心',
      overviewTab: '概览',
      scopeTab: '同步范围',
      transportTab: '传输通道',

      refresh: '刷新',
      save: '保存',
      saved: '已保存',
      saving: '保存中',
      saveSecret: '保存令牌',
      clearSecret: '清除',
      configured: '已配置',
      notConfigured: '未配置',
      testing: '检查中',
      test: '检查连接',
      check: '检查',
      preview: '预览变更',
      previewing: '预览中',
      run: '同步',
      running: '同步中',
      done: '同步完成',
      failCount: '项失败',
      errTitle: '出了点问题',
      loadFail: '读取状态失败',

      device: '设备',
      dshVersion: 'DSH 版本',
      edition: '版本类型',
      node: '运行环境',
      profile: '配置文件',
      home: '数据目录',
      channel: '传输通道',
      target: '同步目标',
      lastSync: '上次同步',
      never: '从未同步',
      nothing: '没有待同步的变更',
      entries: '项',
      count: '条',
      bytes: '大小',
      connected: '已连接',
      notConnected: '未连接',
      unknown: '未知',

      nextTitle: '下一步',
      nextAllGood: '一切就绪：这台机器与远端已经一致，随时可以手动同步一次。',
      nextNeedChannel: '还没有选同步目标：在「设置 › 同步中心 › 传输通道」里选一个本地文件夹、Git 仓库或 WebDAV 地址。',
      nextNeedToken: '通道缺少凭据：回到「传输通道」页签填入访问令牌，否则连不上远端。',
      nextNeedCheck: '还没检查过连通性：到「传输通道」页签点「检查连接」，它会逐项告诉你哪里通了、哪里不通。',
      nextFirstSync: '第一次同步：点下面的「同步」，系统会先算一份变更清单，确认后再上传。',
      nextPending: '有变更等着同步：点「预览变更」看看具体是哪几条。',
      nextConflict: '有冲突要处理：到「设置 › 同步中心 › 概览」选一个冲突策略。',

      quickScope: '同步范围',
      quickScopeHint: '改开关会立即保存。',
      planSummary: '待同步',
      planEmpty: '当前没有待同步的变更。',

      scopeIntro: '勾选要同步的内容。没勾的永远不会被上传。',
      secretsTitle: '凭据与密钥',
      secretsOff: '不同步任何密钥。',
      secretsOn: '会连下面这些文件一起上传（明文）：',
      secretsNever: '私钥类文件（.pem / .p12 / .pfx / *.key / id_rsa 等）无论开关怎么开都不会同步。',
      secretsBoth: '另一台电脑也要打开这个开关，它才会把这些文件写回去。',
      secretsPublicRepo: 'Git 通道：如果远端仓库是公开的（不用登录就能访问），开启此开关后同步会被直接拦住，避免明文密钥被所有人看到。请先把仓库改成私有。',
      sessionsLimit: '会话限制',
      maxBytes: '单会话上限',
      maxBytesHint: '超过这个大小的会话不上传。填 0 表示不限制。',
      maxAgeDays: '最老天数',
      maxAgeDaysHint: '只同步最近 N 天的会话。填 0 表示不限制。',
      sessionsList: '会话明细',
      sessionsListHint: '点「排除」可以把某个会话排除掉。',
      customPaths: '自定义路径',
      customHint: '相对 DSH_HOME 的路径，例如 data/dsh-comfyui/workflows。',
      add: '添加',
      remove: '删除',
      include: '包含',
      exclude: '排除',
      synced: '已同步',
      notSynced: '未同步',
      noSessions: '没有会话',
      sessionsIntro: '会话按条合并，不会删掉对方机器上的会话。',

      conflictPolicy: '冲突策略',
      policyNewest: '以新的为准',
      policyLocal: '保留本机',
      policyRemote: '保留远端',
      policySkip: '跳过不动',
      keepBackups: '备份保留份数',
      backupsTitle: '备份',
      noBackups: '还没有备份',
      planTitle: '计划与备份',
      planIntro: '同步前先预览，确认无误再执行。',

      transportIntro: '选一个把数据放哪儿。点「检查连接」会逐项检查能不能连上、能不能写、远端现状如何。',
      local: '本地文件夹',
      localHint: '最简单：指向网盘挂载点或另一台电脑能访问的目录。',
      git: 'Git 仓库',
      gitHint: '适合用私有仓库在多台电脑之间接力，天然带版本历史。',
      webdav: 'WebDAV',
      webdavHint: '适合坚果云、Nextcloud 这类自建或第三方网盘。',
      path: '文件夹路径',
      repo: '仓库地址',
      repoHint: '例如 https://github.com/you/dsh-sync.git',
      branch: '分支',
      url: '地址',
      urlHint: '例如 https://dav.example.com/dsh-sync',
      username: '用户名',
      token: '访问令牌',
      password: '密码',
      tokenHint: '只保存在本机 DSH 的凭据库里，不会写进同步内容。',
      checkTitle: '连接检查',
      checkIntro: '上面点「检查连接」后，这里会逐条显示每一步的结果。',
      checkNever: '还没检查过。',
      checkOk: '全部通过',
      checkFail: '有问题',

      analysisTitle: '这台机器现在怎么样',
      analysisCard: '本机现状',
      analysisIntro: '读一遍本机的 DSH 数据分布，只看体量与清单，不改任何文件。',
      analysisRun: '分析本机',
      analysisLoading: '分析中…',
      analysisError: '分析失败',
      analysisFresh: '数据量',
      analysisWs: '工作区',
      analysisPlugins: '插件',
      analysisSkills: '技能',
      analysisSessions: '会话',
      analysisSkipped: '故意不同步',
      analysisSecrets: '凭据文件',
      analysisSecretsHint: '只列路径和大小，不读取内容。',
      analysisNoData: '没有数据',
      analysisErrors: '部分项目读取失败',

      treeTitle: '这台机器现在怎么样',
      treeCard: '本机现状',
      treeIntro: '按工作区列出本机的插件、技能与会话，展开可以看到每条会话会不会被同步。',
      treeRun: '读取本机清单',
      treeLoading: '读取中…',
      treeError: '读取失败',
      treeEmpty: '没有找到工作区或会话',
      treeWs: '工作区',
      treeSessions: '会话',
      treeSynced: '已同步',
      treeChanged: '有改动',
      treeOff: '不同步',
      treePending: '待推送',
      treeUnassigned: '未归属工作区',
      treePlugins: '插件',
      treeSkills: '技能',
      wsOn: '同步这个工作区',
      wsOff: '不同步这个工作区',
      wsNoSessions: '这个工作区下还没有会话',
      wsUnassignedHint: '这些会话的目录不在任何已注册工作区里，仍然可以同步；在「同步范围」里可以手动指定它属于哪个工作区。',
      syncOff: '不同步',
      syncSynced: '已同步',
      syncChanged: '有改动',
      syncPending: '待推送',
      wsMapTitle: '跨机目录映射',
      wsMapHint: '同一台工作区在另一台电脑上的路径可能不同。填了之后，同步过来的会话会被记成这个目录；留空表示按目录名自动匹配。',
      wsMapPlaceholder: '本机路径，例如 D:\\Code\\VibeCoding',
      wsMapSave: '记住这个映射',
      wsMapSaved: '已记住',

      privacyTitle: '隐私',
      privacyBody: '同步的是「配置 + 会话」，不会碰浏览器本地设置。默认不带走任何密钥；需要跨机登录时，可以在「同步范围」里手动打开凭据开关。',
      pushSync: '推送同步',
      wsScopeTitle: '按工作区分别同步',
      wsScopeHint: '关掉某个工作区，它的会话就不会被同步；插件、技能、配置不受影响。',
    };

    const EN = {
      nav: 'Sync Hub',
      title: 'Sync Hub',
      subtitle: 'One DSH config and session set across computers',
      section: 'Sync Hub',
      overviewTab: 'Overview',
      scopeTab: 'What to sync',
      transportTab: 'Transport',

      refresh: 'Refresh',
      save: 'Save',
      saved: 'Saved',
      saving: 'Saving',
      saveSecret: 'Save token',
      clearSecret: 'Clear',
      configured: 'configured',
      notConfigured: 'not set',
      testing: 'Checking',
      test: 'Check connection',
      check: 'Check',
      preview: 'Preview changes',
      previewing: 'Previewing',
      run: 'Sync',
      running: 'Syncing',
      done: 'Sync finished',
      failCount: 'failed',
      errTitle: 'Something went wrong',
      loadFail: 'Failed to load status',

      device: 'Device',
      dshVersion: 'DSH version',
      edition: 'Edition',
      node: 'Runtime',
      profile: 'Profile',
      home: 'Data dir',
      channel: 'Transport',
      target: 'Target',
      lastSync: 'Last sync',
      never: 'never synced',
      nothing: 'Nothing to sync',
      entries: 'items',
      count: 'items',
      bytes: 'size',
      connected: 'Connected',
      notConnected: 'Not connected',
      unknown: 'unknown',

      nextTitle: 'Next step',
      nextAllGood: 'All set: this machine matches the remote. Sync manually any time.',
      nextNeedChannel: 'No target yet: pick a local folder, Git repo or WebDAV URL in Settings › Sync Hub › Transport.',
      nextNeedToken: 'Transport has no credential: add the access token in the Transport tab.',
      nextNeedCheck: 'Connection never checked: open the Transport tab and press "Check connection" — it reports each step.',
      nextFirstSync: 'First sync: press Sync below; a change list is computed first, then uploaded.',
      nextPending: 'Changes are waiting: press "Preview changes" to see exactly which ones.',
      nextConflict: 'Conflicts need a decision: pick a conflict policy in Settings › Sync Hub › Overview.',

      quickScope: 'Sync scope',
      quickScopeHint: 'Toggles save immediately.',
      planSummary: 'Pending',
      planEmpty: 'No pending changes.',

      scopeIntro: 'Tick what should be synced. Everything unticked is never uploaded.',
      secretsTitle: 'Credentials & secrets',
      secretsOff: 'No secret is synced.',
      secretsOn: 'These files are uploaded too (plain text):',
      secretsNever: 'Private key files (.pem / .p12 / .pfx / *.key / id_rsa …) are never synced, whatever the switch says.',
      secretsBoth: 'The other computer must enable the same switch to write these files.',
      secretsPublicRepo: 'Git channel: if the remote repo is public (readable without logging in), syncing is blocked while this switch is on, so plain-text keys are never exposed. Make the repo private first.',
      sessionsLimit: 'Session limits',
      maxBytes: 'Max size per session',
      maxBytesHint: 'Sessions bigger than this are skipped. 0 means no limit.',
      maxAgeDays: 'Max age (days)',
      maxAgeDaysHint: 'Only sync sessions from the last N days. 0 means no limit.',
      sessionsList: 'Session details',
      sessionsListHint: 'Press Exclude to drop a session.',
      customPaths: 'Custom paths',
      customHint: 'Path relative to DSH_HOME, e.g. data/dsh-comfyui/workflows.',
      add: 'Add',
      remove: 'Remove',
      include: 'Include',
      exclude: 'Exclude',
      synced: 'synced',
      notSynced: 'not synced',
      noSessions: 'No sessions',
      sessionsIntro: 'Sessions merge per item; nothing is deleted on the other machine.',

      conflictPolicy: 'Conflict policy',
      policyNewest: 'Newest wins',
      policyLocal: 'Keep local',
      policyRemote: 'Keep remote',
      policySkip: 'Skip',
      keepBackups: 'Backups to keep',
      backupsTitle: 'Backups',
      noBackups: 'No backups yet',
      planTitle: 'Plan & backups',
      planIntro: 'Preview first, then execute.',

      transportIntro: 'Pick where the data lives. "Check connection" verifies reachability, writability and the remote state step by step.',
      local: 'Local folder',
      localHint: 'Simplest: point at a mounted network drive or a shared folder.',
      git: 'Git repo',
      gitHint: 'Good for a private repo as a relay across computers; version history included.',
      webdav: 'WebDAV',
      webdavHint: 'Works with Nutstore, Nextcloud and similar services.',
      path: 'Folder path',
      repo: 'Repository URL',
      repoHint: 'e.g. https://github.com/you/dsh-sync.git',
      branch: 'Branch',
      url: 'URL',
      urlHint: 'e.g. https://dav.example.com/dsh-sync',
      username: 'Username',
      token: 'Access token',
      password: 'Password',
      tokenHint: 'Stored in the local DSH credential vault, never inside synced content.',
      checkTitle: 'Connection check',
      checkIntro: 'Results of each step appear here after you press "Check connection".',
      checkNever: 'Never checked yet.',
      checkOk: 'All steps passed',
      checkFail: 'Problems found',

      analysisTitle: 'How this machine looks',
      analysisCard: 'Local machine',
      analysisIntro: 'Reads the local DSH data layout — size and inventory only, nothing is modified.',
      analysisRun: 'Analyze this machine',
      analysisLoading: 'Analyzing…',
      analysisError: 'Analysis failed',
      analysisFresh: 'Volume',
      analysisWs: 'Workspaces',
      analysisPlugins: 'Plugins',
      analysisSkills: 'Skills',
      analysisSessions: 'Sessions',
      analysisSkipped: 'Deliberately skipped',
      analysisSecrets: 'Credential files',
      analysisSecretsHint: 'Paths and sizes only, contents are never read.',
      analysisNoData: 'no data',
      analysisErrors: 'Some items failed to read',

      treeTitle: 'How this machine looks',
      treeCard: 'Local machine',
      treeIntro: 'Lists local plugins, skills and sessions grouped by workspace — expand one to see whether each session will be synced.',
      treeRun: 'Read local inventory',
      treeLoading: 'Reading…',
      treeError: 'Failed to read',
      treeEmpty: 'No workspace or session found',
      treeWs: 'Workspaces',
      treeSessions: 'Sessions',
      treeSynced: 'Synced',
      treeChanged: 'Changed',
      treeOff: 'Not synced',
      treePending: 'To push',
      treeUnassigned: 'Unassigned workspaces',
      treePlugins: 'Plugins',
      treeSkills: 'Skills',
      wsOn: 'Sync this workspace',
      wsOff: 'Do not sync this workspace',
      wsNoSessions: 'No session under this workspace yet',
      wsUnassignedHint: 'These sessions live in a folder that is not a registered workspace. They still sync; in "What to sync" you can point them at a workspace.',
      syncOff: 'Not synced',
      syncSynced: 'Synced',
      syncChanged: 'Changed',
      syncPending: 'Pending',
      wsMapTitle: 'Cross-machine path mapping',
      wsMapHint: 'The same workspace may live under a different path on another computer. Set it here and incoming sessions are recorded against that folder; leave empty to match by folder name.',
      wsMapPlaceholder: 'Local path, e.g. D:\\Code\\VibeCoding',
      wsMapSave: 'Remember this mapping',
      wsMapSaved: 'Remembered',

      privacyTitle: 'Privacy',
      privacyBody: 'What travels is config + sessions; browser-local settings are never touched. No secret leaves the machine unless you turn the credential switch on in "What to sync".',
      pushSync: 'Push & sync',
      wsScopeTitle: 'Sync per workspace',
      wsScopeHint: 'Turning off a workspace keeps its sessions local. Plugins, skills and config are unaffected.',
    };

    /* ---------- 2. 主题与小工具 ---------- */

    // 官方 UI 规范：只用主题 token（--dsw-alias-*），别写死颜色。
    const V = (name, fallback) => `var(--dsw-alias-${name}, ${fallback})`;
    // 主题 token 一律取自 DSH 官方语义（已在 app.css 中核对）：
    //   switch 轨道 关=border-l3 开=brand-primary；滑块 关=switch-thumb 开=label-primary-foreground
    //   主按钮 底=button-primary-fill 字=label-primary-foreground
    const C = {
      border: V('border-l2', 'rgba(127,127,127,0.28)'),
      borderStrong: V('border-l3', 'rgba(127,127,127,0.45)'),
      label: V('label-primary', 'inherit'),
      dim: V('label-secondary', 'rgba(127,127,127,0.9)'),
      dimmed: V('label-tertiary', 'rgba(127,127,127,0.65)'),
      error: V('state-error-primary', '#ef4444'),
      brand: V('brand-primary', '#3b82f6'),
      onBrand: V('label-primary-foreground', '#0f1115'),
      ok: V('state-success-primary', '#22c55e'),
      warn: V('state-warn-primary', '#f59e0b'),
      bad: V('state-error-primary', '#ef4444'),
      pill: V('interactive-bg-hover', 'rgba(127,127,127,0.12)'),
      track: V('border-l3', 'rgba(127,127,127,0.3)'),
      fill: V('bg-layer-2', 'rgba(127,127,127,0.08)'),
      fill2: V('bg-layer-3', 'rgba(127,127,127,0.16)'),
      hover: V('interactive-bg-hover', 'rgba(127,127,127,0.1)'),
      hoverAccent: V('interactive-bg-hover-accent', 'rgba(59,130,246,0.18)'),
      separator: V('border-l1', 'rgba(127,127,127,0.2)'),
      cardFill: V('settings-card-fill', 'transparent'),
      cardStroke: V('settings-card-stroke', 'rgba(127,127,127,0.28)'),
      btnFill: V('button-primary-fill', '#3b82f6'),
      btnHover: V('button-primary-hover', '#2563eb'),
      thumb: V('switch-thumb', '#adb2b8'),
    };

    function uiLang() {
      try {
        const el = document.documentElement;
        const raw = String((el && (el.lang || el.getAttribute('lang'))) || (typeof navigator !== 'undefined' ? navigator.language : '') || 'zh');
        return raw.toLowerCase().startsWith('zh') ? 'zh' : 'en';
      } catch {
        return 'zh';
      }
    }

    /** 服务端返回的 {zh,en} 双语对象 → 当前语言的字符串。 */
    function pickText(value, fallback) {
      if (value == null) return fallback == null ? '' : fallback;
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (typeof value === 'object') {
        const lang = uiLang();
        const picked = value[lang] != null ? value[lang] : value.zh != null ? value.zh : value.en;
        if (picked != null) return String(picked);
      }
      return fallback == null ? '' : fallback;
    }

    function fmtBytes(n) {
      const v = Number(n);
      if (!Number.isFinite(v) || v < 0) return '?';
      if (v < 1024) return `${v} B`;
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
      if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(2)} MB`;
      return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }

    function fmtTime(value) {
      if (!value) return '—';
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return '—';
      const pad = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function relTime(value) {
      if (!value) return '—';
      const t = new Date(value).getTime();
      if (!Number.isFinite(t)) return '—';
      const diff = Date.now() - t;
      const min = Math.round(diff / 60000);
      if (min < 1) return '刚刚';
      if (min < 60) return `${min} 分钟前`;
      const hour = Math.round(min / 60);
      if (hour < 24) return `${hour} 小时前`;
      return `${Math.round(hour / 24)} 天前`;
    }

    function shortRel(rel) {
      const text = String(rel || '');
      const idx = text.indexOf('/sessions/');
      if (idx >= 0) return text.slice(idx + 10).replace(/\.jsonl\.zstd$/, '').replace(/^session-/, '');
      return text;
    }

    /* ---------- 3. 数据层（主面板与设置区共用） ---------- */

    const api = (p) => new URL(String(p).replace(/^\/+/, ''), document.baseURI).pathname;
    const getJson = async (p) => (await fetch(api(p), { cache: 'no-store' })).json();
    const postJson = async (p, body) => {
      const res = await fetch(api(p), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return res.json();
    };

    // 全局文案函数：apply(ctx) 里绑定 locale，供 store 内部发通知时使用。
    let TT = null;

    const store = {
      state: {
        status: null,
        loading: true,
        error: '',
        notice: null,
        draft: null,
        dirty: false,
        busy: '',
        sessions: null,
        plan: null,
        analysis: null,
        analysisLoading: false,
        tree: null,
        treeLoading: false,
        check: null,
      },
      listeners: new Set(),
      set(patch) {
        Object.assign(store.state, patch);
        store.listeners.forEach((fn) => {
          try {
            fn();
          } catch {
            /* ignore */
          }
        });
      },
      subscribe(fn) {
        store.listeners.add(fn);
        return () => store.listeners.delete(fn);
      },
    };

    const actions = {
      async load(opts) {
        const probe = Boolean(opts && opts.probeRemote);
        store.set({ loading: true });
        try {
          const res = await getJson(`${PREFIX}/state${probe ? '?remote=1' : ''}`);
          if (!res || !res.ok) throw new Error((res && res.error) || 'load failed');
          const keepDraft = store.state.dirty && store.state.draft;
          store.set({
            status: res.data,
            draft: keepDraft ? store.state.draft : JSON.parse(JSON.stringify(res.data.settings || {})),
            error: '',
          });
        } catch (err) {
          store.set({ error: String((err && err.message) || err) });
        } finally {
          store.set({ loading: false });
        }
      },
      patchDraft(fn) {
        const next = JSON.parse(JSON.stringify(store.state.draft || {}));
        fn(next);
        store.set({ draft: next, dirty: true });
      },
      async save() {
        const draft = store.state.draft;
        if (!draft) return;
        store.set({ busy: 'save' });
        try {
          const res = await postJson(`${PREFIX}/settings`, { settings: draft });
          if (!res || !res.ok) throw new Error((res && res.error) || 'save failed');
          store.set({ dirty: false, notice: { kind: 'ok', text: TT ? TT('saved') : '已保存' } });
          await actions.load();
        } catch (err) {
          store.set({ notice: { kind: 'error', text: String((err && err.message) || err) } });
        } finally {
          store.set({ busy: '' });
        }
      },
      /** 立刻保存一个设置改动（主面板的快捷开关用）。 */
      async saveNow(nextSettings) {
        store.set({ draft: nextSettings, busy: 'save' });
        try {
          const res = await postJson(`${PREFIX}/settings`, { settings: nextSettings });
          if (!res || !res.ok) throw new Error((res && res.error) || 'save failed');
          store.set({ dirty: false });
          await actions.load();
        } catch (err) {
          store.set({ notice: { kind: 'error', text: String((err && err.message) || err) } });
        } finally {
          store.set({ busy: '' });
        }
      },
      dismissNotice() {
        store.set({ notice: null });
      },
      async saveSecret(kind, value) {
        store.set({ busy: `secret:${kind}` });
        try {
          const res = await postJson(`${PREFIX}/secret`, { kind, value });
          if (!res || !res.ok) throw new Error((res && res.error) || 'failed');
          store.set({ notice: { kind: 'ok', text: res.data && res.data.cleared ? '已清除' : '已保存' } });          await actions.load();
        } catch (err) {
          store.set({ notice: { kind: 'error', text: String((err && err.message) || err) } });
        } finally {
          store.set({ busy: '' });
        }
      },
      async test() {
        store.set({ busy: 'test' });
        try {
          const res = await postJson(`${PREFIX}/test`, {});
          const data = (res && res.data) || {};
          store.set({ check: data });
          store.set({
            notice: {
              kind: res && res.ok && data.ok ? 'ok' : 'error',
              text: data.ok ? '连接检查通过' : data.message || '连接检查发现问题',
            },
          });
        } catch (err) {
          store.set({ notice: { kind: 'error', text: String((err && err.message) || err) } });
        } finally {
          store.set({ busy: '' });
        }
      },
      async preview() {
        store.set({ busy: 'plan' });
        try {
          const res = await postJson(`${PREFIX}/plan`, {});
          if (!res || !res.ok) throw new Error((res && res.error) || 'plan failed');
          store.set({ plan: res.plan });
        } catch (err) {
          store.set({ notice: { kind: 'error', text: String((err && err.message) || err) } });
        } finally {
          store.set({ busy: '' });
        }
      },
      async run() {
        store.set({ busy: 'run' });
        try {
          const res = await postJson(`${PREFIX}/run`, {});
          if (!res) throw new Error('no response');
          if (!res.ok && res.error) throw new Error(res.error);
          const result = res.result || {};
          const totals = `↑${(result.pushed || []).length} ↓${(result.pulled || []).length} ⚠${(result.conflicts || []).length}`;
          const failures = result.failures || [];
          const firstMessage = failures.length ? String(failures[0].message || '') : '';
          store.set({
            notice: {
              kind: failures.length ? (result.blocked ? 'error' : 'warn') : 'ok',
              text: failures.length
                ? (result.blocked ? `同步被阻止：${firstMessage}` : `同步完成 ${totals} · ${failures.length} 项失败：${firstMessage}`)
                : `同步完成 ${totals}`,
            },
            plan: null,
          });
          await actions.load({ probeRemote: true });
        } catch (err) {
          store.set({ notice: { kind: 'error', text: String((err && err.message) || err) } });
        } finally {
          store.set({ busy: '' });
        }
      },
      async loadSessions() {
        store.set({ busy: 'sessions' });
        try {
          const res = await getJson(`${PREFIX}/sessions`);
          if (!res || !res.ok) throw new Error((res && res.error) || 'failed');
          store.set({ sessions: res.data });
        } catch (err) {
          store.set({ notice: { kind: 'error', text: String((err && err.message) || err) } });
        } finally {
          store.set({ busy: '' });
        }
      },
      async loadAnalysis() {
        store.set({ analysisLoading: true });
        try {
          const res = await getJson(`${PREFIX}/analysis`);
          if (!res || !res.ok) throw new Error((res && res.error) || 'failed');
          store.set({ analysis: res.data });
        } catch (err) {
          store.set({ analysis: { error: String((err && err.message) || err) } });
        } finally {
          store.set({ analysisLoading: false });
        }
      },
      /** 工作区树：工作区 → 会话，每条带「是否同步」。 */
      async loadTree() {
        store.set({ treeLoading: true });
        try {
          const res = await getJson(`${PREFIX}/workspaces`);
          if (!res || !res.ok) throw new Error((res && res.error) || 'failed');
          store.set({ tree: res.data });
        } catch (err) {
          store.set({ tree: { error: String((err && err.message) || err) } });
        } finally {
          store.set({ treeLoading: false });
        }
      },
      /** 开关某个工作区的同步。key 是工作区目录名。 */
      async toggleWorkspace(key, enabled) {
        const draft = JSON.parse(JSON.stringify(store.state.draft || {}));
        draft.workspaces = {
          ...(draft.workspaces || {}),
          switches: { ...((draft.workspaces || {}).switches || {}), [key]: enabled },
        };
        await actions.saveNow(draft);
        await actions.loadTree();
      },
      /** 记住跨机目录映射：目录名 → 本机路径。空字符串表示清除。 */
      async setWorkspaceMap(key, path) {
        const draft = JSON.parse(JSON.stringify(store.state.draft || {}));
        const map = { ...((draft.workspaces || {}).map || {}) };
        const value = String(path || '').trim();
        if (value) map[key] = value;
        else delete map[key];
        draft.workspaces = { ...(draft.workspaces || {}), map };
        await actions.saveNow(draft);
        await actions.loadTree();
      },
    };

    function useHub() {
      const [, force] = React.useState(0);
      React.useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
      React.useEffect(() => {
        if (!store.state.status) actions.load();
      }, []);
      return { ...store.state, actions };
    }

    /* ---------- 4. 基础组件 ---------- */

    function Button({ children, onClick, disabled, primary, title, busy, small }) {
      const style = {
        padding: small ? '3px 8px' : '5px 11px',
        borderRadius: small ? 5 : 7,
        cursor: disabled || busy ? 'not-allowed' : 'pointer',
        border: `1px solid ${primary ? 'transparent' : C.border}`,
        background: primary ? C.btnFill : 'transparent',
        color: primary ? C.onBrand : 'inherit',
        font: 'inherit',
        fontSize: small ? 11 : 12,
        opacity: disabled || busy ? 0.55 : 1,
        whiteSpace: 'nowrap',
      };
      return h(
        'button',
        { onClick, disabled: disabled || busy, title, style },
        busy ? `${children}…` : children,
      );
    }

    function Row({ label, children, hint }) {
      return h(
        'div',
        { style: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0' } },
        h('div', { style: { width: 140, flex: '0 0 140px', fontSize: 12, color: C.dim, paddingTop: 5 } }, label),
        h(
          'div',
          { style: { flex: 1, minWidth: 0 } },
          children,
          hint ? h('div', { style: { fontSize: 11, color: C.dimmed, marginTop: 3, lineHeight: 1.5 } }, hint) : null,
        ),
      );
    }

    function TextInput({ value, onChange, placeholder, type, style, disabled }) {
      return h('input', {
        type: type || 'text',
        value: value ?? '',
        placeholder: placeholder || '',
        disabled,
        spellCheck: false,
        onChange: (e) => onChange && onChange(e.target.value),
        style: {
          width: '100%',
          boxSizing: 'border-box',
          padding: '5px 8px',
          fontSize: 12,
          color: 'inherit',
          background: 'transparent',
          border: `1px solid ${C.border}`,
          borderRadius: 7,
          outline: 'none',
          font: 'inherit',
          ...(style || {}),
        },
      });
    }

    function Select({ value, onChange, options }) {
      return h(
        'select',
        {
          value,
          onChange: (e) => onChange(e.target.value),
          style: {
            padding: '5px 8px',
            fontSize: 12,
            color: 'inherit',
            background: 'transparent',
            border: `1px solid ${C.border}`,
            borderRadius: 7,
            font: 'inherit',
          },
        },
        options.map((o) => h('option', { key: o.value, value: o.value }, pickText(o.label, o.value))),
      );
    }

    function Switch({ on, onChange, disabled }) {
      // 与 DSH 官方开关一致：轨道 关=border-l3 开=brand-primary；滑块 关=switch-thumb 开=label-primary-foreground
      return h(
        'button',
        {
          onClick: () => !disabled && onChange(!on),
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          style: {
            width: 36,
            height: 20,
            borderRadius: 999,
            border: 'none',
            padding: 2,
            cursor: disabled ? 'not-allowed' : 'pointer',
            background: on ? C.brand : C.track,
            position: 'relative',
            flex: '0 0 36px',
            opacity: disabled ? 0.5 : 1,
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 2,
            left: 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: on ? C.onBrand : C.thumb,
            transform: on ? 'translate(16px)' : 'translate(0)',
            transition: 'transform .12s ease',
          },
        }),
      );
    }

    function Badge({ text, color }) {
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            padding: '1px 6px',
            fontSize: 10,
            borderRadius: 5,
            background: C.pill,
            color: color || 'inherit',
            whiteSpace: 'nowrap',
          },
        },
        text,
      );
    }

    function Card({ title, extra, children }) {
      return h(
        'div',
        {
          style: {
            border: `1px solid ${C.cardStroke}`,
            background: C.cardFill,
            borderRadius: 10,
            padding: '10px 12px',
            marginBottom: 10,
          },
        },
        title || extra
          ? h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
              h('div', { style: { fontSize: 12, fontWeight: 600, flex: 1 } }, title),
              extra || null,
            )
          : null,
        children,
      );
    }

    function Banner({ kind, children, onClose }) {
      const color = kind === 'error' ? C.bad : kind === 'warn' ? C.warn : C.ok;
      return h(
        'div',
        {
          style: {
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            border: `1px solid ${color}`,
            background: C.fill,
            borderRadius: 8,
            padding: '7px 10px',
            fontSize: 12,
            marginBottom: 10,
            whiteSpace: 'pre-wrap',
          },
        },
        h('div', { style: { flex: 1 } }, children),
        onClose
          ? h(
              'button',
              {
                onClick: onClose,
                style: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, opacity: 0.7 },
              },
              '✕',
            )
          : null,
      );
    }

    function Empty({ children }) {
      return h('div', { style: { fontSize: 12, color: C.dim, padding: '8px 0' } }, children);
    }

    /** 折叠块：默认收起，展开时可懒加载。 */
    function Collapsible({ title, meta, defaultOpen, onOpen, children }) {
      const [open, setOpen] = React.useState(Boolean(defaultOpen));
      return h(
        'div',
        null,
        h(
          'button',
          {
            onClick: () => {
              const next = !open;
              setOpen(next);
              if (next && onOpen) onOpen();
            },
            style: {
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
              padding: '2px 0',
              textAlign: 'left',
            },
          },
          h('span', { style: { color: C.dim, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s', display: 'inline-block' } }, '›'),
          h('span', { style: { fontWeight: 600, flex: 1 } }, title),
          meta ? h('span', { style: { fontSize: 11, color: C.dim } }, meta) : null,
        ),
        open ? h('div', { style: { paddingTop: 6 } }, children) : null,
      );
    }

    /** 连接检查的分步结果。 */
    function Steps({ steps }) {
      if (!steps || !steps.length) return null;
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
        steps.map((step, i) => {
          const severity = step.severity || (step.ok ? 'info' : 'error');
          const color = severity === 'error' ? C.bad : severity === 'warn' ? C.warn : C.ok;
          const icon = severity === 'error' ? '✕' : severity === 'warn' ? '!' : '✓';
          return h(
            'div',
            { key: step.id || i, style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
            h(
              'span',
              {
                style: {
                  width: 15,
                  height: 15,
                  borderRadius: 8,
                  flex: '0 0 15px',
                  marginTop: 2,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  color: C.onBrand,
                  background: color,
                },
              },
              icon,
            ),
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: 12 } }, step.label || step.id),
              step.detail
                ? h('div', { style: { fontSize: 11, color: C.dim, marginTop: 1, lineHeight: 1.5, wordBreak: 'break-word' } }, step.detail)
                : null,
            ),
          );
        }),
      );
    }

    function SyncIcon({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M3.5 8.5A5.5 5.5 0 0 1 9 4h5.5' }),
        h('path', { d: 'M12.5 2 15 4l-2.5 2' }),
        h('path', { d: 'M20.5 15.5A5.5 5.5 0 0 1 15 20H9.5' }),
        h('path', { d: 'M11.5 18 9 20l2.5 2' }),
      );
    }

    /* ---------- 5. 主面板：日常同步台 ---------- */

    function StatusDot({ ok, warn }) {
      const color = warn ? C.warn : ok ? C.ok : C.dimmed;
      return h('span', {
        style: {
          display: 'inline-block',
          width: 7,
          height: 7,
          borderRadius: 4,
          background: color,
          marginRight: 6,
          flex: '0 0 7px',
        },
      });
    }

    /** 根据当前状态算出「下一步该做什么」。 */
    function nextSteps(status, t) {
      if (!status) return [];
      const settings = status.settings || {};
      const kind = status.transport || 'local';
      const remote = settings.remote || {};
      const steps = [];
      const hasTarget =
        kind === 'local' ? Boolean(remote.path) : kind === 'git' ? Boolean(remote.url) : Boolean(remote.url);
      if (!hasTarget) {
        steps.push({ id: 'channel', text: t('nextNeedChannel') });
        return steps;
      }
      if (kind !== 'local' && !(status.secrets && status.secrets[kind])) {
        steps.push({ id: 'token', text: t('nextNeedToken') });
        return steps;
      }
      const plan = status.lastPlan;
      const totals = plan && plan.totals;
      if (totals && totals.conflicts > 0) {
        steps.push({ id: 'conflict', text: t('nextConflict') });
      } else if (!status.lastSync) {
        steps.push({ id: 'first', text: t('nextFirstSync') });
      } else if (totals && totals.push + totals.pull > 0) {
        steps.push({ id: 'pending', text: t('nextPending') });
      } else {
        steps.push({ id: 'ok', text: t('nextAllGood') });
      }
      return steps;
    }

    function ScopeQuickToggles({ hub, t }) {
      const status = hub.status;
      const draft = hub.draft;
      if (!status || !draft) return null;
      const defs = status.sectionDefs || [];
      const counts = {};
      for (const item of status.sections || []) counts[item.id] = item.count;
      const toggle = async (def, on) => {
        const next = JSON.parse(JSON.stringify(draft));
        next.sections = { ...(next.sections || {}), [def.id]: on };
        await hub.actions.saveNow(next);
      };
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        defs.map((def) => {
          const enabled = Boolean(draft.sections && draft.sections[def.id]);
          return h(
            'div',
            {
              key: def.id,
              style: { display: 'flex', alignItems: 'center', gap: 9, padding: '3px 0' },
            },
            h(Switch, { on: enabled, onChange: (on) => toggle(def, on) }),
            h(
              'span',
              { style: { fontSize: 12, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
              pickText(def.label, def.id),
            ),
            h('span', { style: { fontSize: 11, color: C.dimmed } }, `${counts[def.id] || 0}`),
          );
        }),
      );
    }

    function Panel({ t }) {
      const hub = useHub();
      const status = hub.status;
      const draft = hub.draft;
      const ver = status && status.version
        ? (status.version.desktop && status.version.desktop.desktopVersion) || status.version.version || ''
        : '';
      const plan = hub.plan || status?.lastPlan || null;
      const totals = plan && plan.totals ? plan.totals : null;
      const steps = nextSteps(status, t);
      const kind = status ? status.transport : 'local';
      const configured = status
        ? kind === 'local'
          ? Boolean((status.settings?.remote || {}).path)
          : kind === 'git'
            ? Boolean((status.settings?.remote || {}).url)
            : Boolean((status.settings?.remote || {}).url)
        : false;

      return h(
        'div',
        { style: { fontSize: 13, lineHeight: 1.5, padding: '2px 0 12px', maxHeight: '100%', overflow: 'auto' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' } },
          h(SyncIcon, { size: 20 }),
          h(
            'div',
            { style: { flex: 1, minWidth: 160 } },
            h('div', { style: { fontSize: 14, fontWeight: 600 } }, t('title')),
            h('div', { style: { fontSize: 11, color: C.dim } }, t('subtitle')),
          ),
          ver ? h(Badge, { text: `DSH ${ver}` }) : null,
          status ? h(Badge, { text: `${t('device')}: ${status.device?.name || '—'}` }) : null,
          h(Button, { onClick: () => hub.actions.load({ probeRemote: true }), busy: hub.loading }, t('refresh')),
        ),

        hub.notice
          ? h(Banner, { kind: hub.notice.kind, onClose: () => hub.actions.dismissNotice() }, hub.notice.text)
          : null,
        hub.error ? h(Banner, { kind: 'error' }, hub.error) : null,

        status
          ? h(
              'div',
              { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, fontSize: 11, color: C.dim } },
              h(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center' } },
                h(StatusDot, { ok: configured, warn: false }),
                `${t('channel')}: ${pickText({ local: t('local'), git: t('git'), webdav: t('webdav') }[kind] || kind, kind)}`,
              ),
              h('span', null, `${t('target')}: ${status.target || '—'}`),
              h('span', null, `${t('lastSync')}: ${status.lastSync ? relTime(status.lastSync.at) : t('never')}`),
              h('span', null, `${status.local?.entries || 0} ${t('entries')} · ${status.bytesLabel || fmtBytes(status.local?.bytes || 0)}`),
            )
          : null,

        h(
          Card,
          { title: t('nextTitle') },
          steps.length === 0
            ? h(Empty, null, '…')
            : steps.map((step, i) =>
                h(
                  'div',
                  { key: step.id, style: { display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, padding: '2px 0' } },
                  h('span', { style: { color: C.dim, flex: '0 0 16px' } }, `${i + 1}.`),
                  h('span', { style: { flex: 1 } }, step.text),
                ),
              ),
        ),

        h(
          Card,
          {
            title: t('planSummary'),
            extra: h(
              'div',
              { style: { display: 'flex', gap: 8 } },
              h(Button, { onClick: hub.actions.preview, busy: hub.busy === 'plan' }, hub.busy === 'plan' ? t('previewing') : t('preview')),
              h(Button, { primary: true, onClick: hub.actions.run, busy: hub.busy === 'run' }, hub.busy === 'run' ? t('running') : t('run')),
            ),
          },
          !totals
            ? h(Empty, null, t('planEmpty'))
            : h(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h(Badge, { text: `↑ ${totals.push} · ${fmtBytes(totals.pushBytes)}`, color: C.brand }),
                h(Badge, { text: `↓ ${totals.pull} · ${fmtBytes(totals.pullBytes)}`, color: C.warn }),
                h(Badge, { text: `⚠ ${totals.conflicts}`, color: C.bad }),
                h(Badge, { text: `⤼ ${totals.skipped}` }),
              ),
        ),

        h(Card, { title: t('quickScope'), extra: h('span', { style: { fontSize: 10, color: C.dimmed } }, t('quickScopeHint')) }, h(ScopeQuickToggles, { hub, t })),

        h('div', { style: { fontSize: 10, color: C.dimmed, marginTop: 6 } }, `${NS} v${status?.plugin?.version || FALLBACK_VERSION}`),
      );
    }

    /* ---------- 6. 配置中心：概览 / 同步范围 / 传输通道 ---------- */

    /** 一行会话：标题 + 路径 + 最右侧的「是否同步」标签。 */
    function SessionRow({ s, t }) {
      const state = s.sync;
      const color = state === 'off' ? C.dimmed : state === 'synced' ? C.ok : state === 'changed' ? C.warn : C.brand;
      const label =
        state === 'off' ? (s.reason || t('syncOff'))
          : state === 'synced' ? t('syncSynced')
            : state === 'changed' ? t('syncChanged')
              : t('syncPending');
      const name = s.title || s.sessionId.slice(0, 8);
      return h(
        'div',
        {
          key: s.sessionId,
          style: {
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            fontSize: 11,
            padding: '3px 0',
            paddingLeft: 14,
          },
        },
        h(
          'span',
          { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          name,
          h('span', { style: { color: C.dimmed, marginLeft: 6 } }, s.cwd || s.rel),
        ),
        h('span', { style: { color: C.dimmed, flex: '0 0 auto' } }, fmtBytes(s.bytes || 0)),
        h(Badge, { text: label, color }),
      );
    }

    /** 一个工作区：标题行（含开关与会话数）+ 可展开的会话列表。 */
    function WorkspaceGroup({ ws, hub, t, muted }) {
      const [open, setOpen] = React.useState(false);
      const sessions = ws.sessions || [];
      return h(
        'div',
        { style: { borderTop: `1px solid ${C.separator}`, padding: '7px 0' } },
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h(
            'button',
            {
              onClick: () => setOpen(!open),
              style: {
                flex: 1,
                minWidth: 0,
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                border: 'none',
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                fontSize: 12,
                cursor: 'pointer',
                textAlign: 'left',
                padding: 0,
              },
            },
            h('span', { style: { color: C.dim, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s', display: 'inline-block' } }, '›'),
            h('span', { style: { fontWeight: 600 } }, ws.title || ws.key),
            h('span', { style: { fontSize: 11, color: C.dim } }, ws.path || ''),
            h(Badge, { text: `${sessions.length} ${t('count')}` }),
            h(Badge, { text: fmtBytes(ws.bytes || 0) }),
          ),
          h(
            Switch,
            {
              on: ws.enabled !== false,
              onChange: (next) => hub.actions.toggleWorkspace(ws.key, next),
              title: ws.enabled !== false ? t('wsOn') : t('wsOff'),
            },
          ),
        ),
        muted
          ? null
          : null,
        open
          ? h(
              'div',
              { style: { maxHeight: 260, overflow: 'auto', marginTop: 4 } },
              sessions.length === 0
                ? h(Empty, null, t('wsNoSessions'))
                : sessions.map((s) => h(SessionRow, { key: s.sessionId, s, t })),
            )
          : null,
      );
    }

    /** 本机现状：工作区 → 会话，可展开；下面还有插件和技能清单。 */
    function MachineTree({ hub, t }) {
      const tree = hub.tree;
      if (!tree) return null;
      if (tree.error) return h(Banner, { kind: 'error' }, `${t('treeError')}: ${tree.error}`);
      const groups = tree.workspaces || [];
      const unassigned = tree.unassigned || [];
      const totals = tree.totals || {};
      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
          h(Badge, { text: `${t('treeWs')} ${totals.workspaces ?? 0}`, color: C.brand }),
          h(Badge, { text: `${t('treeSessions')} ${totals.sessions ?? 0}` }),
          h(Badge, { text: fmtBytes(totals.bytes || 0) }),
          h(Badge, { text: `${t('treeSynced')} ${totals.synced ?? 0}`, color: C.ok }),
          h(Badge, { text: `${t('treeChanged')} ${totals.changed ?? 0}`, color: C.warn }),
          h(Badge, { text: `${t('treePending')} ${totals.pending ?? 0}`, color: C.brand }),
          h(Badge, { text: `${t('treeOff')} ${totals.off ?? 0}` }),
        ),
        groups.length === 0 && unassigned.length === 0
          ? h(Empty, null, t('treeEmpty'))
          : null,
        groups.map((ws) => h(WorkspaceGroup, { key: `ws:${ws.key}`, ws, hub, t })),
        unassigned.length
          ? h(
              'div',
              { style: { marginTop: 8 } },
              h(
                'div',
                { style: { fontSize: 11, fontWeight: 600, color: C.dim, marginBottom: 2 } },
                t('treeUnassigned'),
              ),
              h(
                'div',
                { style: { fontSize: 11, color: C.dimmed, marginBottom: 4, lineHeight: 1.55 } },
                t('wsUnassignedHint'),
              ),
              unassigned.map((ws) => h(WorkspaceGroup, { key: `un:${ws.key}`, ws, hub, t })),
            )
          : null,
        (tree.plugins || []).length
          ? h(
              'div',
              { style: { marginTop: 10 } },
              h('div', { style: { fontSize: 11, fontWeight: 600, color: C.dim, marginBottom: 3 } }, t('treePlugins')),
              h(
                'div',
                { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                (tree.plugins || []).map((p) =>
                  h(Badge, { key: p.name, text: `${p.name}${p.version ? ` ${p.version}` : ''}` }),
                ),
              ),
            )
          : null,
        (tree.skills || []).length
          ? h(
              'div',
              { style: { marginTop: 8 } },
              h('div', { style: { fontSize: 11, fontWeight: 600, color: C.dim, marginBottom: 3 } }, t('treeSkills')),
              h(
                'div',
                { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                (tree.skills || []).map((s) =>
                  h(Badge, { key: s.name, text: `${s.name} · ${s.files} ${t('count')} · ${fmtBytes(s.bytes || 0)}` }),
                ),
              ),
            )
          : null,
      );
    }

    function AnalysisBlock({ hub, t }) {
      const a = hub.analysis;
      const loading = hub.analysisLoading;
      const run = () => hub.actions.loadAnalysis();
      const row = (label, value, note) =>
        h(
          'div',
          { key: label, style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, padding: '2px 0' } },
          h('span', { style: { width: 110, flex: '0 0 110px', color: C.dim } }, label),
          h('span', { style: { flex: 1 } }, value),
          note ? h('span', { style: { fontSize: 11, color: C.dimmed } }, note) : null,
        );

      return h(
        'div',
        null,
        h(
          'div',
          { style: { fontSize: 11, color: C.dim, marginBottom: 6, lineHeight: 1.55 } },
          t('analysisIntro'),
        ),
        loading ? h(Empty, null, t('analysisLoading')) : null,
        !loading && !a ? h(Button, { onClick: run }, t('analysisRun')) : null,
        !loading && a && a.error ? h(Banner, { kind: 'error' }, `${t('analysisError')}: ${a.error}`) : null,
        !loading && a && !a.error
          ? h(
              'div',
              null,
              row(
                t('analysisWs'),
                `${a.workspaces?.count ?? 0}`,
                (a.workspaces?.items || []).slice(0, 3).map((w) => w.title || w.path).join(' · '),
              ),
              row(t('analysisPlugins'), `${a.plugins?.count ?? 0}`, `bundles ${a.plugins?.bundles ?? 0}`),
              row(t('analysisSkills'), `${a.skills?.count ?? 0}`, fmtBytes(a.skills?.bytes || 0)),
              row(
                t('analysisSessions'),
                `${a.sessions?.count ?? 0}`,
                `${fmtBytes(a.sessions?.bytes || 0)} · ${a.sessions?.projects ?? 0} 个项目`,
              ),
              row(t('analysisSkipped'), `${(a.skipped || []).length} 项`, (a.skipped || []).map((s) => `${s.name} ${fmtBytes(s.bytes)}`).join(' · ')),
              row(
                t('analysisSecrets'),
                `${(a.secrets?.files || []).length} 个文件`,
                t('analysisSecretsHint'),
              ),
              (a.errors || []).length
                ? h('div', { style: { fontSize: 11, color: C.warn, marginTop: 4 } }, `${t('analysisErrors')}: ${a.errors.join('; ')}`)
                : null,
              h(
                'div',
                { style: { marginTop: 8 } },
                h(Button, { small: true, onClick: run }, t('analysisRun')),
              ),
            )
          : null,
      );
    }

    function PlanList({ plan, t }) {
      const list = (items, color) =>
        h(
          'div',
          { style: { maxHeight: 180, overflow: 'auto', marginTop: 4 } },
          (items || []).map((item, i) =>
            h(
              'div',
              { key: `${item.id}-${i}`, style: { display: 'flex', gap: 8, fontSize: 11, padding: '2px 0' } },
              h('span', { style: { color, width: 58, flex: '0 0 58px' } }, item.section || ''),
              h('span', { style: { flex: 1, wordBreak: 'break-all' } }, shortRel(item.rel)),
              h('span', { style: { color: C.dim } }, item.bytes != null ? fmtBytes(item.bytes) : ''),
            ),
          ),
        );
      const totals = plan && plan.totals;
      const guard = plan && plan.guard;
      const guardBanner =
        guard && guard.ok === false
          ? h(
              'div',
              {
                style: {
                  marginBottom: 8,
                  padding: '8px 10px',
                  borderRadius: 10,
                  border: `1px solid ${C.bad}`,
                  background: C.fill,
                  fontSize: 12,
                  color: C.bad,
                  lineHeight: 1.55,
                },
              },
              guard.message,
            )
          : null;
      if (!totals) return h('div', null, guardBanner, h(Empty, null, t('planEmpty')));
      if (totals.push + totals.pull + totals.conflicts === 0) {
        return h('div', null, guardBanner, h(Empty, null, t('nothing')));
      }
      return h(
        'div',
        null,
        guardBanner,
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' } },
          h(Badge, { text: `↑ ${totals.push} · ${fmtBytes(totals.pushBytes)}`, color: C.brand }),
          h(Badge, { text: `↓ ${totals.pull} · ${fmtBytes(totals.pullBytes)}`, color: C.warn }),
          h(Badge, { text: `⚠ ${totals.conflicts}`, color: C.bad }),
          h(Badge, { text: `⤼ ${totals.skipped}` }),
        ),
        plan.push && plan.push.length
          ? h('div', null, h('div', { style: { fontSize: 11, fontWeight: 600, color: C.brand } }, '上传'), list(plan.push, C.brand))
          : null,
        plan.pull && plan.pull.length
          ? h('div', null, h('div', { style: { fontSize: 11, fontWeight: 600, color: C.warn } }, '下载'), list(plan.pull, C.warn))
          : null,
        plan.conflicts && plan.conflicts.length
          ? h('div', null, h('div', { style: { fontSize: 11, fontWeight: 600, color: C.bad } }, '冲突'), list(plan.conflicts, C.bad))
          : null,
      );
    }

    function OverviewTab({ hub, t }) {
      const status = hub.status;
      const draft = hub.draft;
      React.useEffect(() => {
        if (!hub.tree && !hub.treeLoading) hub.actions.loadTree();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      if (!status || !draft) return null;
      const plan = hub.plan || status.lastPlan;
      return h(
        'div',
        null,
        h(
          Card,
          {
            title: t('treeCard'),
            extra: h(Badge, { text: `${status.local?.entries || 0} ${t('entries')}` }),
          },
          h(
            'div',
            { style: { fontSize: 11, color: C.dim, marginBottom: 6, lineHeight: 1.55 } },
            t('treeIntro'),
          ),
          hub.treeLoading && !hub.tree ? h(Empty, null, t('treeLoading')) : null,
          !hub.treeLoading && !hub.tree
            ? h(Button, { onClick: () => hub.actions.loadTree() }, t('treeRun'))
            : null,
          hub.tree ? h(MachineTree, { hub, t }) : null,
          h(
            Collapsible,
            {
              title: t('analysisTitle'),
              meta: hub.analysis && !hub.analysis.error ? fmtBytes(hub.analysis.totals?.bytes || 0) : null,
              onOpen: () => {
                if (!hub.analysis && !hub.analysisLoading) hub.actions.loadAnalysis();
              },
            },
            h(AnalysisBlock, { hub, t }),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 10 } },
            h(Button, { primary: true, onClick: hub.actions.run, busy: hub.busy === 'run' }, hub.busy === 'run' ? t('running') : t('pushSync')),
            h(Button, { onClick: () => hub.actions.loadTree() }, t('treeRun')),
          ),
        ),
        h(
          Card,
          { title: t('planTitle'), extra: h('span', { style: { fontSize: 11, color: C.dim } }, t('planIntro')) },
          h(
            Row,
            { label: t('conflictPolicy') },
            h(Select, {
              value: draft.conflictPolicy,
              onChange: (v) => hub.actions.patchDraft((x) => { x.conflictPolicy = v; }),
              options: [
                { value: 'newest', label: t('policyNewest') },
                { value: 'local', label: t('policyLocal') },
                { value: 'remote', label: t('policyRemote') },
                { value: 'skip', label: t('policySkip') },
              ],
            }),
          ),
          h(
            Row,
            { label: t('keepBackups') },
            h(TextInput, {
              type: 'number',
              value: draft.keepBackups || 20,
              onChange: (v) => hub.actions.patchDraft((x) => { x.keepBackups = Math.max(1, Number(v) || 20); }),
              style: { width: 100 },
            }),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, margin: '6px 0' } },
            h(Button, { onClick: hub.actions.preview, busy: hub.busy === 'plan' }, hub.busy === 'plan' ? t('previewing') : t('preview')),
            h(Button, { primary: true, onClick: hub.actions.run, busy: hub.busy === 'run' }, hub.busy === 'run' ? t('running') : t('run')),
            h(Button, { onClick: hub.actions.save, busy: hub.busy === 'save', disabled: !hub.dirty }, hub.dirty ? t('save') : t('saved')),
          ),
          h(PlanList, { plan, t }),
        ),
        h(
          Card,
          { title: t('backupsTitle') },
          (status.backups || []).length === 0
            ? h(Empty, null, t('noBackups'))
            : h(
                'div',
                null,
                (status.backups || []).map((b) =>
                  h(
                    'div',
                    { key: b.stamp || b.path || b.name, style: { display: 'flex', gap: 8, fontSize: 11, padding: '2px 0' } },
                    h('span', { style: { flex: 1 } }, b.stamp || b.name || b.path),
                    h('span', { style: { color: C.dim } }, b.entries != null ? `${b.entries} ${t('entries')}` : ''),
                  ),
                ),
              ),
        ),
        h(Card, { title: t('privacyTitle') }, h('div', { style: { fontSize: 12, lineHeight: 1.65, color: C.dim } }, t('privacyBody'))),
      );
    }

    /** 跨机目录映射：一行输入框，填了就记住。 */
    function WorkspaceMapRow({ hub, t, ws }) {
      const draft = hub.draft || {};
      const saved = (draft.workspaces && draft.workspaces.map && draft.workspaces.map[ws.key]) || '';
      const [value, setValue] = React.useState(saved);
      React.useEffect(() => setValue(saved), [saved]);
      const [savedTick, setSavedTick] = React.useState(false);
      const submit = async () => {
        await hub.actions.setWorkspaceMap(ws.key, value);
        setSavedTick(true);
        setTimeout(() => setSavedTick(false), 2500);
      };
      return h(
        'div',
        { style: { marginTop: 6 } },
        h(
          'div',
          { style: { fontSize: 11, color: C.dimmed, marginBottom: 3 } },
          t('wsMapHint'),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h(TextInput, {
            value,
            placeholder: t('wsMapPlaceholder'),
            onChange: (v) => setValue(v),
            style: { flex: 1, minWidth: 0 },
          }),
          h(Button, { small: true, onClick: submit, busy: hub.busy === 'save' }, savedTick ? t('wsMapSaved') : t('wsMapSave')),
        ),
      );
    }

    function ScopeTab({ hub, t }) {
      const status = hub.status;
      const draft = hub.draft;
      React.useEffect(() => {
        if (hub.sessions === null && hub.busy !== 'sessions') hub.actions.loadSessions();
        if (!hub.tree && !hub.treeLoading) hub.actions.loadTree();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      if (!status || !draft) return null;
      const defs = status.sectionDefs || [];
      const counts = {};
      for (const item of status.sections || []) counts[item.id] = item.count;
      const secretFiles = status.secretFiles || {};
      const secretCandidates = secretFiles.candidates || [];
      const secretsOn = Boolean(draft.sections && draft.sections.secrets);
      const excluded = new Set((draft.sessions && draft.sessions.excludeIds) || []);
      const data = hub.sessions;
      const saveBtn = h(Button, {
        primary: true,
        onClick: hub.actions.save,
        busy: hub.busy === 'save',
        disabled: !hub.dirty,
      }, hub.dirty ? t('save') : t('saved'));

      return h(
        'div',
        null,
        h('div', { style: { fontSize: 12, color: C.dim, marginBottom: 8 } }, t('scopeIntro')),
        h(
          Card,
          null,
          defs.map((def) => {
            const on = Boolean(draft.sections && draft.sections[def.id]);
            return h(
              'div',
              {
                key: def.id,
                style: {
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  padding: '8px 0',
                  borderBottom: `1px solid ${C.separator}`,
                },
              },
              h(Switch, {
                on,
                onChange: (next) => hub.actions.patchDraft((x) => { x.sections = { ...(x.sections || {}), [def.id]: next }; }),
              }),
              h(
                'div',
                { style: { flex: 1, minWidth: 0 } },
                h(
                  'div',
                  { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: 12, fontWeight: 600 } }, pickText(def.label, def.id)),
                  def.kind === 'advisory' ? h(Badge, { text: '只读' }) : null,
                  def.kind === 'redacted' ? h(Badge, { text: '已脱敏' }) : null,
                  def.kind === 'secret' ? h(Badge, { text: '密钥', color: C.warn }) : null,
                  h(Badge, { text: `${counts[def.id] || 0} ${t('count')}` }),
                ),
                def.desc
                  ? h('div', { style: { fontSize: 11, color: C.dim, marginTop: 3, lineHeight: 1.55 } }, pickText(def.desc))
                  : null,
                def.id === 'secrets'
                  ? h(
                      'div',
                      { style: { fontSize: 11, color: secretsOn ? C.warn : C.dimmed, marginTop: 4, lineHeight: 1.55 } },
                      h('div', null, secretsOn ? t('secretsOn') : t('secretsOff')),
                      secretsOn
                        ? h('ul', { style: { margin: '3px 0 0', paddingLeft: 18 } },
                            (secretFiles.files || secretCandidates).map((f) => h('li', { key: f }, h('code', { style: { fontSize: 11 } }, f))))
                        : null,
                      h('div', { style: { marginTop: 3 } }, t('secretsNever')),
                      h('div', null, t('secretsBoth')),
                      secretsOn && (status.transport || 'local') === 'git'
                        ? h('div', { style: { marginTop: 3, color: C.warn } }, t('secretsPublicRepo'))
                        : null,
                    )
                  : null,
              ),
            );
          }),
        ),
        h(
          Card,
          { title: t('wsScopeTitle') },
          h('div', { style: { fontSize: 11, color: C.dim, marginBottom: 6, lineHeight: 1.55 } }, t('wsScopeHint')),
          !hub.tree
            ? h(Button, { onClick: () => hub.actions.loadTree() }, t('treeRun'))
            : null,
          hub.tree
            ? h(
                'div',
                null,
                (hub.tree.workspaces || []).map((ws) =>
                  h(
                    'div',
                    {
                      key: `sc:${ws.key}`,
                      style: {
                        display: 'flex',
                        gap: 10,
                        alignItems: 'flex-start',
                        padding: '8px 0',
                        borderBottom: `1px solid ${C.separator}`,
                      },
                    },
                    h(Switch, {
                      on: ws.enabled !== false,
                      onChange: (next) => hub.actions.toggleWorkspace(ws.key, next),
                    }),
                    h(
                      'div',
                      { style: { flex: 1, minWidth: 0 } },
                      h(
                        'div',
                        { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                        h('span', { style: { fontSize: 12, fontWeight: 600 } }, ws.title || ws.key),
                        h(Badge, { text: `${(ws.sessions || []).length} ${t('count')}` }),
                        h(Badge, { text: fmtBytes(ws.bytes || 0) }),
                      ),
                      h('div', { style: { fontSize: 11, color: C.dim, marginTop: 2 } }, ws.path || ''),
                      h(WorkspaceMapRow, { hub, t, ws }),
                    ),
                  ),
                ),
                (hub.tree.unassigned || []).length
                  ? h(
                      'div',
                      { style: { marginTop: 8 } },
                      h('div', { style: { fontSize: 11, fontWeight: 600, color: C.dim, marginBottom: 3 } }, t('treeUnassigned')),
                      h('div', { style: { fontSize: 11, color: C.dimmed, lineHeight: 1.55 } }, t('wsUnassignedHint')),
                      (hub.tree.unassigned || []).map((ws) =>
                        h(
                          'div',
                          {
                            key: `scu:${ws.key}`,
                            style: {
                              display: 'flex',
                              gap: 10,
                              alignItems: 'flex-start',
                              padding: '8px 0',
                              borderTop: `1px solid ${C.separator}`,
                            },
                          },
                          h(Switch, {
                            on: ws.enabled !== false,
                            onChange: (next) => hub.actions.toggleWorkspace(ws.key, next),
                          }),
                          h(
                            'div',
                            { style: { flex: 1, minWidth: 0 } },
                            h(
                              'div',
                              { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                              h('span', { style: { fontSize: 12, fontWeight: 600 } }, ws.title || ws.key),
                              h(Badge, { text: `${(ws.sessions || []).length} ${t('count')}` }),
                            ),
                            h('div', { style: { fontSize: 11, color: C.dim, marginTop: 2 } }, ws.path || ''),
                            h(WorkspaceMapRow, { hub, t, ws }),
                          ),
                        ),
                      ),
                    )
                  : null,
              )
            : null,
        ),
        h(
          Card,
          { title: t('sessionsLimit') },
          h(
            Row,
            { label: t('maxBytes'), hint: t('maxBytesHint') },
            h(TextInput, {
              type: 'number',
              value: Math.round((draft.sessions?.maxBytes || 0) / 1024 / 1024),
              onChange: (v) => hub.actions.patchDraft((x) => { x.sessions = { ...(x.sessions || {}), maxBytes: Math.max(0, Number(v) || 0) * 1024 * 1024 }; }),
              style: { width: 120 },
            }),
          ),
          h(
            Row,
            { label: t('maxAgeDays'), hint: t('maxAgeDaysHint') },
            h(TextInput, {
              type: 'number',
              value: draft.sessions?.maxAgeDays || 0,
              onChange: (v) => hub.actions.patchDraft((x) => { x.sessions = { ...(x.sessions || {}), maxAgeDays: Math.max(0, Number(v) || 0) }; }),
              style: { width: 120 },
            }),
          ),
          h(Collapsible, {
            title: t('sessionsList'),
            meta: data ? `${data.total} · ${fmtBytes(data.bytes)}` : '',
            onOpen: () => {
              if (hub.sessions === null) hub.actions.loadSessions();
            },
          },
            h('div', { style: { fontSize: 11, color: C.dim, marginBottom: 6 } }, t('sessionsListHint')),
            !data
              ? h(Empty, null, hub.busy === 'sessions' ? '…' : t('noSessions'))
              : data.sessions.length === 0
                ? h(Empty, null, t('noSessions'))
                : h(
                    'div',
                    { style: { maxHeight: 320, overflow: 'auto' } },
                    data.sessions.slice(0, 400).map((s) =>
                      h(
                        'div',
                        {
                          key: s.sessionId,
                          style: {
                            display: 'flex',
                            gap: 10,
                            alignItems: 'center',
                            padding: '6px 0',
                            borderBottom: `1px solid ${C.separator}`,
                            opacity: excluded.has(s.sessionId) ? 0.5 : 1,
                          },
                        },
                        h(
                          'div',
                          { style: { flex: 1, minWidth: 0 } },
                          h(
                            'div',
                            { style: { fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                            pickText(s.title, s.sessionId),
                          ),
                          h(
                            'div',
                            { style: { fontSize: 11, color: C.dim, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                            `${s.cwd || '—'} · ${fmtTime(s.createdAt)} · ${fmtBytes(s.bytes)}`,
                          ),
                        ),
                        s.synced ? h(Badge, { text: t('synced'), color: C.ok }) : h(Badge, { text: t('notSynced') }),
                        h(
                          Button,
                          {
                            small: true,
                            onClick: () => {
                              hub.actions.patchDraft((x) => {
                                x.sessions = x.sessions || { excludeIds: [] };
                                const list = new Set(x.sessions.excludeIds || []);
                                if (list.has(s.sessionId)) list.delete(s.sessionId);
                                else list.add(s.sessionId);
                                x.sessions.excludeIds = [...list];
                              });
                            },
                          },
                          excluded.has(s.sessionId) ? t('include') : t('exclude'),
                        ),
                      ),
                    ),
                  ),
          ),
        ),
        h(
          Card,
          { title: t('customPaths') },
          h('div', { style: { fontSize: 11, color: C.dim, marginBottom: 6 } }, t('customHint')),
          (draft.customPaths || []).map((item, idx) =>
            h(
              'div',
              { key: `${item.rel}-${idx}`, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' } },
              h(Switch, {
                on: item.enabled !== false,
                onChange: (next) => hub.actions.patchDraft((x) => { x.customPaths[idx].enabled = next; }),
              }),
              h('code', { style: { flex: 1, fontSize: 11, wordBreak: 'break-all' } }, item.rel),
              h(Button, { small: true, onClick: () => hub.actions.patchDraft((x) => { x.customPaths.splice(idx, 1); }) }, t('remove')),
            ),
          ),
          h(CustomPathAdder, { hub, t }),
        ),
        h('div', { style: { display: 'flex', gap: 8 } }, saveBtn, hub.dirty ? h('span', { style: { fontSize: 11, color: C.warn, alignSelf: 'center' } }, '●') : null),
      );
    }

    function CustomPathAdder({ hub, t }) {
      const [value, setValue] = React.useState('');
      return h(
        'div',
        { style: { display: 'flex', gap: 8, marginTop: 8 } },
        h(TextInput, { value, onChange: setValue, placeholder: 'data/dsh-comfyui/workflows' }),
        h(
          Button,
          {
            disabled: !value.trim(),
            onClick: () => {
              const rel = value.trim().replace(/^[\\/]+/, '');
              if (!rel) return;
              hub.actions.patchDraft((x) => {
                x.customPaths = x.customPaths || [];
                if (!x.customPaths.some((item) => item.rel === rel)) x.customPaths.push({ rel, enabled: true });
              });
              setValue('');
            },
          },
          t('add'),
        ),
      );
    }

    function TransportTab({ hub, t }) {
      const status = hub.status || {};
      const draft = hub.draft;
      const [secret, setSecret] = React.useState('');
      if (!draft) return null;
      const kind = draft.transport || 'local';
      const setRemote = (patch) => hub.actions.patchDraft((x) => { x.remote = { ...(x.remote || {}), ...patch }; });
      const secretKind = kind === 'git' ? 'git' : 'webdav';
      const secretSaved = Boolean(status.secrets && status.secrets[secretKind]);
      const check = hub.check;

      return h(
        'div',
        null,
        h('div', { style: { fontSize: 12, color: C.dim, marginBottom: 8, lineHeight: 1.55 } }, t('transportIntro')),
        h(
          Card,
          null,
          [
            { id: 'local', label: t('local'), hint: t('localHint') },
            { id: 'git', label: t('git'), hint: t('gitHint') },
            { id: 'webdav', label: t('webdav'), hint: t('webdavHint') },
          ].map((opt) =>
            h(
              'label',
              {
                key: opt.id,
                style: {
                  display: 'flex',
                  gap: 9,
                  alignItems: 'flex-start',
                  padding: '8px 0',
                  borderBottom: `1px solid ${C.separator}`,
                  cursor: 'pointer',
                },
              },
              h('input', {
                type: 'radio',
                name: 'sync-hub-transport',
                checked: kind === opt.id,
                onChange: () => hub.actions.patchDraft((x) => { x.transport = opt.id; }),
                style: { marginTop: 2 },
              }),
              h(
                'div',
                null,
                h('div', { style: { fontSize: 12, fontWeight: 600 } }, opt.label),
                h('div', { style: { fontSize: 11, color: C.dim, marginTop: 2, lineHeight: 1.55 } }, opt.hint),
              ),
            ),
          ),
        ),
        h(
          Card,
          { title: t('transportTab') },
          kind === 'local'
            ? h(Row, { label: t('path'), hint: t('localHint') },
                h(TextInput, { value: draft.remote?.path || '', onChange: (v) => setRemote({ path: v }), placeholder: 'D:\\Sync\\dsh' }))
            : null,
          kind === 'git'
            ? [
                h(Row, { key: 'repo', label: t('repo'), hint: t('repoHint') },
                  h(TextInput, { value: draft.remote?.url || '', onChange: (v) => setRemote({ url: v }), placeholder: 'https://github.com/you/dsh-sync.git' })),
                h(Row, { key: 'branch', label: t('branch') },
                  h(TextInput, { value: draft.remote?.branch || 'main', onChange: (v) => setRemote({ branch: v }), placeholder: 'main', style: { width: 160 } })),
              ]
            : null,
          kind === 'webdav'
            ? [
                h(Row, { key: 'url', label: t('url'), hint: t('urlHint') },
                  h(TextInput, { value: draft.remote?.url || '', onChange: (v) => setRemote({ url: v }), placeholder: 'https://dav.example.com/dsh-sync' })),
                h(Row, { key: 'user', label: t('username') },
                  h(TextInput, { value: draft.remote?.username || '', onChange: (v) => setRemote({ username: v }), style: { width: 200 } })),
              ]
            : null,
          kind !== 'local'
            ? h(
                Row,
                { label: kind === 'git' ? t('token') : t('password'), hint: t('tokenHint') },
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  h(TextInput, {
                    type: 'password',
                    value: secret,
                    onChange: setSecret,
                    placeholder: secretSaved ? `•••••• (${t('configured')})` : '',
                  }),
                  h(Button, {
                    onClick: () => {
                      hub.actions.saveSecret(secretKind, secret);
                      setSecret('');
                    },
                    busy: hub.busy === `secret:${secretKind}`,
                    disabled: !secret.trim(),
                  }, t('saveSecret')),
                  secretSaved
                    ? h(Button, {
                        onClick: () => {
                          hub.actions.saveSecret(secretKind, '');
                          setSecret('');
                        },
                        busy: hub.busy === `secret:${secretKind}`,
                      }, t('clearSecret'))
                    : null,
                ),
              )
            : null,
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 8 } },
            h(Button, { primary: true, onClick: hub.actions.save, busy: hub.busy === 'save', disabled: !hub.dirty },
              hub.dirty ? t('save') : t('saved')),
            h(Button, { onClick: hub.actions.test, busy: hub.busy === 'test' }, hub.busy === 'test' ? t('testing') : t('test')),
          ),
        ),
        h(
          Card,
          { title: t('checkTitle'), extra: h('span', { style: { fontSize: 11, color: C.dim } }, t('checkIntro')) },
          !check
            ? h(Empty, null, t('checkNever'))
            : h(
                'div',
                null,
                h(
                  'div',
                  { style: { fontSize: 12, marginBottom: 6, color: check.ok ? C.ok : C.bad } },
                  check.ok ? t('checkOk') : `${t('checkFail')}${check.message ? ` · ${check.message}` : ''}`,
                ),
                h(Steps, { steps: check.steps }),
              ),
        ),
        h(Card, { title: t('target') }, h('code', { style: { fontSize: 11, wordBreak: 'break-all' } }, status.target || '—')),
      );
    }

    function Section({ t }) {
      const hub = useHub();
      const [tab, setTab] = React.useState(() => {
        try {
          return localStorage.getItem(`${NS}:tab`) || 'overview';
        } catch {
          return 'overview';
        }
      });
      const switchTab = (id) => {
        setTab(id);
        try {
          localStorage.setItem(`${NS}:tab`, id);
        } catch {
          /* ignore */
        }
      };
      const status = hub.status;
      const ver = status && status.version
        ? (status.version.desktop && status.version.desktop.desktopVersion) || status.version.version || ''
        : '';

      const tabs = [
        { id: 'overview', label: t('overviewTab') },
        { id: 'scope', label: t('scopeTab') },
        { id: 'transport', label: t('transportTab') },
      ];

      return h(
        'div',
        { style: { fontSize: 13, lineHeight: 1.5, padding: '2px 0 12px' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' } },
          h(SyncIcon, { size: 20 }),
          h(
            'div',
            { style: { flex: 1, minWidth: 160 } },
            h('div', { style: { fontSize: 14, fontWeight: 600 } }, t('title')),
            h('div', { style: { fontSize: 11, color: C.dim } }, t('subtitle')),
          ),
          ver ? h(Badge, { text: `DSH ${ver}` }) : null,
          status ? h(Badge, { text: `${t('device')}: ${status.device?.name || '—'}` }) : null,
          h(Button, { onClick: () => hub.actions.load({ probeRemote: true }), busy: hub.loading }, t('refresh')),
        ),
        hub.notice
          ? h(Banner, { kind: hub.notice.kind, onClose: () => hub.actions.dismissNotice() }, hub.notice.text)
          : null,
        hub.error ? h(Banner, { kind: 'error' }, hub.error) : null,
        h(
          'div',
          { style: { display: 'flex', gap: 4, marginBottom: 10, borderBottom: `1px solid ${C.separator}`, flexWrap: 'wrap' } },
          tabs.map((item) =>
            h(
              'button',
              {
                key: item.id,
                onClick: () => switchTab(item.id),
                style: {
                  border: 'none',
                  background: 'transparent',
                  color: 'inherit',
                  font: 'inherit',
                  fontSize: 12,
                  padding: '6px 10px',
                  cursor: 'pointer',
                  opacity: tab === item.id ? 1 : 0.62,
                  borderBottom: tab === item.id ? `2px solid ${C.brand}` : '2px solid transparent',
                  marginBottom: -1,
                },
              },
              item.label,
            ),
          ),
        ),
        hub.loading && !status ? h(Empty, null, '…') : null,
        !status
          ? null
          : tab === 'overview'
            ? h(OverviewTab, { hub, t })
            : tab === 'scope'
              ? h(ScopeTab, { hub, t })
              : h(TransportTab, { hub, t }),
        h('div', { style: { fontSize: 10, color: C.dimmed, marginTop: 8 } }, `${NS} v${status?.plugin?.version || FALLBACK_VERSION}`),
      );
    }

    /* ---------- 7. 插件注册 ---------- */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), `${NS}: dictionaries`);
        } catch {
          /* locale 可选 */
        }
        let t;
        try {
          t = ctx.locale.bind(NS);
        } catch {
          t = (key) => ZH[key] || key;
        }
        TT = t;

        // 主面板：左上角那一页，日常同步台。
        const offPanel = ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) }, Panel),
        );
        // 侧边栏入口。
        const offRow = ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              label: () => (t ? t('nav') : '同步中心'),
              locale: NS,
            },
            (owner) => h(SyncIcon, { size: (owner && owner.size) || 16 }),
          ),
        );
        // 设置区：配置中心。
        const offSection = ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: 62,
              label: () => (t ? t('section') : '同步中心'),
              locale: NS,
              inject: () => ({ t }),
            },
            Section,
          ),
        );

        return () => {
          try {
            if (typeof offRow === 'function') offRow();
          } catch {
            /* ignore */
          }
          try {
            if (typeof offPanel === 'function') offPanel();
          } catch {
            /* ignore */
          }
          try {
            if (typeof offSection === 'function') offSection();
          } catch {
            /* ignore */
          }
        };
      },
    };
  },
});
