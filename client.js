// dsh-sync-hub · 客户端半边（浏览器模块，无 node:*）
// 手写 JS，不经打包：平台按 __ModuleLoader__ 工厂格式直接加载。
//
// 文件结构：
//   1. 文案与图标
//   2. 通用小部件（Button / Switch / Field / Badge / fmt）
//   3. 数据层（http 封装 + useHub 状态机）
//   4. 五个页签：概览 / 范围 / 通道 / 会话 / 计划与备份
//   5. 注册：settings.section
//
// 约定：所有状态都从服务端 /dsh-sync-hub/* 读，不在浏览器里推断同步结果；
//       凭据只写不读——提交后服务端返回 configured 布尔值，明文永远不回传界面。
window.__ModuleLoader__.load({
  id: 'dsh-sync-hub',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-sync-hub';
    const SECTION_ID = 'dsh-sync-hub';
    const PREFIX = '/dsh-sync-hub';
    const VERSION = '0.1.0';

    // 服务端有些字段是 { zh, en } 双语对象（范围名称、描述、会话标题等），
    // 直接塞进 React 会抛 “objects are not valid as a React child”。统一过一遍。
    function uiLang() {
      const raw = (typeof document !== 'undefined' && document.documentElement
        && document.documentElement.lang)
        || (typeof navigator !== 'undefined' && navigator.language)
        || 'zh';
      return String(raw).toLowerCase().startsWith('en') ? 'en' : 'zh';
    }

    function pickText(value, fallback) {
      if (value === null || value === undefined || value === '') return fallback === undefined ? '' : fallback;
      if (typeof value === 'string' || typeof value === 'number') return String(value);
      if (typeof value === 'object') {
        return value[uiLang()] || value.zh || value.en || (fallback === undefined ? '' : fallback);
      }
      return fallback === undefined ? '' : fallback;
    }

    const ZH = {
      section: '同步中心',
      title: '同步中心',
      subtitle: '多台电脑之间同步 DSH 配置与会话 · 不含任何凭据',
      device: '本机',
      deviceName: '设备名',
      refresh: '刷新',
      save: '保存',
      saved: '已保存',
      saving: '保存中…',
      loadFail: '读取失败',
      tabOverview: '概览',
      tabScope: '同步范围',
      tabTransport: '传输通道',
      tabSessions: '会话',
      tabPlan: '计划与备份',
      version: 'DSH 版本',
      edition: '版本类型',
      node: 'Node',
      profile: 'Profile',
      home: 'DSH 数据目录',
      transport: '通道',
      target: '目标',
      localStats: '本机待同步内容',
      remoteStats: '远端',
      remoteUnknown: '尚未探测（点“刷新”后会读取远端 manifest）',
      devices: '设备',
      entries: '条目',
      bytes: '大小',
      updatedAt: '更新时间',
      lastSync: '上次同步',
      never: '从未',
      secrets: '凭据',
      configured: '已配置',
      notConfigured: '未配置',
      privacyTitle: '隐私边界',
      privacyBody:
        '凭据、令牌、API key、.credentials.yaml、.env、私钥文件既不会被读取，也不会被写入或传输。界面里只记录“是否已配置”这一位信息，明文不回传。',
      scopeIntro: '勾选要跨机同步的类别。任何一项都可以单独关掉，关掉后既不推送也不拉取。',
      advisory: '只读上报',
      redacted: '已脱敏',
      files: '文件同步',
      count: '个条目',
      sessionsLimit: '会话筛选',
      maxBytes: '单会话上限',
      maxBytesHint: '超过这个大小的会话不同步，0 表示不限制',
      maxAgeDays: '只同步最近',
      maxAgeDaysHint: '按会话创建时间过滤，0 表示不限制',
      days: '天',
      customPaths: '自定义路径',
      customHint: '相对 DSH 数据目录的路径，例如 data/dsh-comfyui/workflows',
      add: '添加',
      remove: '移除',
      transportIntro: '选一种把数据送到别处的方式。三台机器必须指向同一个目标。',
      local: '共享文件夹',
      localHint: '例如 OneDrive / 坚果云 / NAS 同步盘目录。最简单，不依赖网络服务。',
      git: 'Git 仓库',
      gitHint: '私有仓库，推荐 GitHub / Gitee。支持历史与多机合并。',
      webdav: 'WebDAV',
      webdavHint: '坚果云、Nextcloud、群晖等。',
      path: '文件夹路径',
      repo: '仓库地址',
      repoHint: '例如 https://github.com/you/dsh-sync.git',
      branch: '分支',
      url: 'WebDAV 地址',
      urlHint: '例如 https://dav.example.com/dsh-sync',
      username: '用户名',
      token: '访问令牌',
      tokenHint: '只保存在本机 DSH 凭据库，不写进任何配置文件',
      password: '应用密码',
      saveSecret: '保存凭据',
      clearSecret: '清除',
      test: '测试连接',
      testing: '测试中…',
      testOk: '连接正常',
      testFail: '连接失败',
      sessionsIntro: '会话按单个会话合并：对方机器新增的会拉下来，本机已有的不会因为对方删除而消失。',
      sessionTitle: '标题',
      sessionCwd: '工作区',
      sessionCreated: '创建时间',
      sessionSize: '大小',
      sessionState: '状态',
      synced: '已同步',
      notSynced: '未同步',
      excluded: '已排除',
      exclude: '不同步',
      include: '恢复',
      noSessions: '还没有会话记录',
      planIntro: '先预览再同步：推送本机改动、拉取远端更新，冲突按下面的策略处理。',
      preview: '预览变更',
      previewing: '读取远端…',
      run: '开始同步',
      running: '同步中…',
      push: '推送',
      pull: '拉取',
      conflicts: '冲突',
      skipped: '跳过',
      nothing: '两端一致，没有需要同步的内容',
      conflictPolicy: '冲突策略',
      policyNewest: '保留更新的（按修改时间）',
      policyLocal: '保留本机',
      policyRemote: '保留远端',
      policySkip: '跳过，下次再决定',
      keepBackups: '备份保留份数',
      backups: '最近备份',
      noBackups: '还没有备份',
      resultTitle: '同步结果',
      failCount: '失败',
      done: '完成',
      errTitle: '出错了',
    };
    const EN = {
      section: 'Sync Hub',
      title: 'Sync Hub',
      subtitle: 'Sync DSH config and sessions across machines · no credentials',
      device: 'This device',
      deviceName: 'Device name',
      refresh: 'Refresh',
      save: 'Save',
      saved: 'Saved',
      saving: 'Saving…',
      loadFail: 'Failed to load',
      tabOverview: 'Overview',
      tabScope: 'Scope',
      tabTransport: 'Transport',
      tabSessions: 'Sessions',
      tabPlan: 'Plan & backups',
      version: 'DSH version',
      edition: 'Edition',
      node: 'Node',
      profile: 'Profile',
      home: 'DSH home',
      transport: 'Transport',
      target: 'Target',
      localStats: 'Local content',
      remoteStats: 'Remote',
      remoteUnknown: 'Not probed yet (refresh to read the remote manifest)',
      devices: 'devices',
      entries: 'entries',
      bytes: 'size',
      updatedAt: 'updated',
      lastSync: 'Last sync',
      never: 'never',
      secrets: 'Credentials',
      configured: 'configured',
      notConfigured: 'missing',
      privacyTitle: 'Privacy boundary',
      privacyBody:
        'Credentials, tokens, API keys, .credentials.yaml, .env and private keys are never read, written or transferred. The UI only tracks whether a secret exists; plaintext is never sent back.',
      scopeIntro: 'Pick what travels between machines. Anything switched off is neither pushed nor pulled.',
      advisory: 'report only',
      redacted: 'redacted',
      files: 'files',
      count: 'entries',
      sessionsLimit: 'Session filters',
      maxBytes: 'Max session size',
      maxBytesHint: 'Sessions larger than this are skipped; 0 means no limit',
      maxAgeDays: 'Only sessions from the last',
      maxAgeDaysHint: 'Filtered by creation time; 0 means no limit',
      days: 'days',
      customPaths: 'Custom paths',
      customHint: 'Path relative to DSH home, e.g. data/dsh-comfyui/workflows',
      add: 'Add',
      remove: 'Remove',
      transportIntro: 'Pick how data reaches the other machines. All devices must point at the same target.',
      local: 'Shared folder',
      localHint: 'A folder inside OneDrive / Dropbox / NAS sync. Simplest, no network service.',
      git: 'Git repo',
      gitHint: 'A private repo (GitHub / GitLab). History and multi-machine merges.',
      webdav: 'WebDAV',
      webdavHint: 'Nextcloud, Synology, Jianguoyun, etc.',
      path: 'Folder path',
      repo: 'Repo URL',
      repoHint: 'e.g. https://github.com/you/dsh-sync.git',
      branch: 'Branch',
      url: 'WebDAV URL',
      urlHint: 'e.g. https://dav.example.com/dsh-sync',
      username: 'Username',
      token: 'Access token',
      tokenHint: 'Stored only in the local DSH credential store, never in config files',
      password: 'App password',
      saveSecret: 'Save secret',
      clearSecret: 'Clear',
      test: 'Test connection',
      testing: 'Testing…',
      testOk: 'Connection OK',
      testFail: 'Connection failed',
      sessionsIntro:
        'Sessions merge per session: new ones from the other machine are pulled, and local ones are never deleted by a remote delete.',
      sessionTitle: 'Title',
      sessionCwd: 'Workspace',
      sessionCreated: 'Created',
      sessionSize: 'Size',
      sessionState: 'State',
      synced: 'Synced',
      notSynced: 'Not synced',
      excluded: 'Excluded',
      exclude: 'Exclude',
      include: 'Restore',
      noSessions: 'No sessions yet',
      planIntro: 'Preview first: push local edits, pull remote updates, resolve conflicts with the policy below.',
      preview: 'Preview changes',
      previewing: 'Reading remote…',
      run: 'Sync now',
      running: 'Syncing…',
      push: 'Push',
      pull: 'Pull',
      conflicts: 'Conflicts',
      skipped: 'Skipped',
      nothing: 'Both sides match — nothing to sync',
      conflictPolicy: 'Conflict policy',
      policyNewest: 'Keep newer (by mtime)',
      policyLocal: 'Keep local',
      policyRemote: 'Keep remote',
      policySkip: 'Skip for now',
      keepBackups: 'Backups to keep',
      backups: 'Recent backups',
      noBackups: 'No backups yet',
      resultTitle: 'Sync result',
      failCount: 'failed',
      done: 'done',
      errTitle: 'Something went wrong',
    };

    /* ---------- 1. 工具函数 ---------- */

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

    const C = {
      border: 'rgba(127,127,127,0.28)',
      dim: 'rgba(127,127,127,0.92)',
      pill: 'rgba(127,127,127,0.12)',
      ok: '#22c55e',
      warn: '#f59e0b',
      bad: '#ef4444',
      accent: 'rgba(99,102,241,0.16)',
    };

    function fmtBytes(n) {
      const v = Number(n);
      if (!Number.isFinite(v) || v < 0) return '?';
      if (v < 1024) return v + ' B';
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
      if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(2) + ' MB';
      return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
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

    /* ---------- 2. 小部件 ---------- */

    function Button({ children, onClick, disabled, primary, title, busy }) {
      return h(
        'button',
        {
          onClick,
          disabled: disabled || busy,
          title,
          style: {
            padding: '5px 11px',
            borderRadius: 6,
            cursor: disabled || busy ? 'not-allowed' : 'pointer',
            border: `1px solid ${C.border}`,
            background: primary ? C.accent : 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontSize: 12,
            opacity: disabled || busy ? 0.55 : 1,
            whiteSpace: 'nowrap',
          },
        },
        busy ? `${children}…` : children,
      );
    }

    function Row({ label, children, hint }) {
      return h(
        'div',
        { style: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0' } },
        h('div', { style: { width: 148, flex: '0 0 148px', fontSize: 12, color: C.dim, paddingTop: 5 } }, label),
        h(
          'div',
          { style: { flex: 1, minWidth: 0 } },
          children,
          hint ? h('div', { style: { fontSize: 11, color: C.dim, marginTop: 3 } }, hint) : null,
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
          borderRadius: 6,
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
            borderRadius: 6,
            font: 'inherit',
          },
        },
        options.map((o) => h('option', { key: o.value, value: o.value, style: { color: '#111' } }, pickText(o.label, o.value))),
      );
    }

    function Switch({ on, onChange, disabled }) {
      return h(
        'button',
        {
          onClick: () => !disabled && onChange(!on),
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          title: on ? 'on' : 'off',
          style: {
            width: 34,
            height: 19,
            borderRadius: 10,
            border: 'none',
            padding: 0,
            cursor: disabled ? 'not-allowed' : 'pointer',
            background: on ? '#3b82f6' : 'rgba(127,127,127,0.35)',
            position: 'relative',
            flex: '0 0 34px',
            opacity: disabled ? 0.5 : 1,
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 2,
            left: on ? 17 : 2,
            width: 15,
            height: 15,
            borderRadius: 8,
            background: '#fff',
            transition: 'left .15s',
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
            border: `1px solid ${C.border}`,
            borderRadius: 9,
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
            border: `1px solid ${color}55`,
            background: `${color}14`,
            borderRadius: 8,
            padding: '7px 10px',
            fontSize: 12,
            marginBottom: 10,
            whiteSpace: 'pre-wrap',
          },
        },
        h('div', { style: { flex: 1 } }, children),
        onClose ? h('button', {
          onClick: onClose,
          style: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, opacity: 0.7 },
        }, '✕') : null,
      );
    }

    function Empty({ children }) {
      return h('div', { style: { fontSize: 12, color: C.dim, padding: '10px 0' } }, children);
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

    /* ---------- 3. 数据层 ---------- */

    function useHub(t) {
      const [status, setStatus] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [dirty, setDirty] = React.useState(false);
      const [busy, setBusy] = React.useState('');
      const [sessions, setSessions] = React.useState(null);
      const [plan, setPlan] = React.useState(null);

      const load = React.useCallback(
        async (opts) => {
          const probe = Boolean(opts && opts.probeRemote);
          setLoading(true);
          try {
            const res = await getJson(`${PREFIX}/state${probe ? '?remote=1' : ''}`);
            if (!res || !res.ok) throw new Error((res && res.error) || t('loadFail'));
            setStatus(res.data);
            setDraft((prev) => (prev && dirty ? prev : JSON.parse(JSON.stringify(res.data.settings))));
            setError('');
          } catch (err) {
            setError(String((err && err.message) || err));
          } finally {
            setLoading(false);
          }
        },
        [t, dirty],
      );

      React.useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const patchDraft = React.useCallback((fn) => {
        setDraft((prev) => {
          const next = JSON.parse(JSON.stringify(prev || {}));
          fn(next);
          return next;
        });
        setDirty(true);
      }, []);

      const save = React.useCallback(async () => {
        if (!draft) return;
        setBusy('save');
        try {
          const res = await postJson(`${PREFIX}/settings`, { settings: draft });
          if (!res || !res.ok) throw new Error((res && res.error) || 'save failed');
          setDirty(false);
          setNotice({ kind: 'ok', text: t('saved') });
          await load();
        } catch (err) {
          setNotice({ kind: 'error', text: String((err && err.message) || err) });
        } finally {
          setBusy('');
        }
      }, [draft, load, t]);

      const saveSecret = React.useCallback(
        async (kind, value) => {
          setBusy(`secret:${kind}`);
          try {
            const res = await postJson(`${PREFIX}/secret`, { kind, value });
            if (!res || !res.ok) throw new Error((res && res.error) || 'failed');
            setNotice({ kind: 'ok', text: res.data && res.data.cleared ? t('clearSecret') : t('saved') });
            await load();
          } catch (err) {
            setNotice({ kind: 'error', text: String((err && err.message) || err) });
          } finally {
            setBusy('');
          }
        },
        [load, t],
      );

      const test = React.useCallback(async () => {
        setBusy('test');
        try {
          const res = await postJson(`${PREFIX}/test`, {});
          const data = (res && res.data) || {};
          setNotice({
            kind: res && res.ok && data.ok ? 'ok' : 'error',
            text: `${data.ok ? t('testOk') : t('testFail')}${data.message ? ` · ${data.message}` : ''}`,
          });
        } catch (err) {
          setNotice({ kind: 'error', text: String((err && err.message) || err) });
        } finally {
          setBusy('');
        }
      }, [t]);

      const preview = React.useCallback(async () => {
        setBusy('plan');
        try {
          const res = await postJson(`${PREFIX}/plan`, {});
          if (!res || !res.ok) throw new Error((res && res.error) || 'plan failed');
          setPlan(res.plan);
          setNotice(null);
        } catch (err) {
          setNotice({ kind: 'error', text: String((err && err.message) || err) });
        } finally {
          setBusy('');
        }
      }, []);

      const run = React.useCallback(async () => {
        setBusy('run');
        try {
          const res = await postJson(`${PREFIX}/run`, {});
          if (!res) throw new Error('no response');
          if (!res.ok && res.error) throw new Error(res.error);
          const result = res.result || {};
          const totals = result.pushed || result.pulled || result.conflicts
            ? ` · ↑${(result.pushed || []).length} ↓${(result.pulled || []).length} ⚠${(result.conflicts || []).length}`
            : '';
          setNotice({
            kind: (result.failures || []).length ? 'warn' : 'ok',
            text: `${t('done')}${totals}${(result.failures || []).length ? ` · ${result.failures.length} ${t('failCount')}` : ''}`,
          });
          setPlan(null);
          await load({ probeRemote: true });
        } catch (err) {
          setNotice({ kind: 'error', text: String((err && err.message) || err) });
        } finally {
          setBusy('');
        }
      }, [load, t]);

      const loadSessions = React.useCallback(async () => {
        setBusy('sessions');
        try {
          const res = await getJson(`${PREFIX}/sessions`);
          if (!res || !res.ok) throw new Error((res && res.error) || 'failed');
          setSessions(res.data);
        } catch (err) {
          setNotice({ kind: 'error', text: String((err && err.message) || err) });
        } finally {
          setBusy('');
        }
      }, []);

      return {
        status, loading, error, notice, setNotice, draft, patchDraft, dirty, busy,
        sessions, plan, setPlan, load, save, saveSecret, test, preview, run, loadSessions,
      };
    }

    /* ---------- 4. 页签 ---------- */

    function Overview({ hub, t }) {
      const s = hub.status;
      if (!s) return null;
      const v = s.version || {};
      const ver = v.desktop && v.desktop.desktopVersion ? v.desktop.desktopVersion : v.version || '未知';
      const stat = s.local || { entries: 0, bytes: 0, sections: [] };
      const secretCount = [s.secrets && s.secrets.git, s.secrets && s.secrets.webdav].filter(Boolean).length;
      return h(
        'div',
        null,
        h(
          Card,
          { title: t('version') },
          h(Row, { label: t('edition') }, h('span', null, h('b', null, ver), ' ', h(Badge, { text: v.edition || 'unknown' }))),
          h(Row, { label: t('node') }, `${(v.desktop && v.desktop.nodeVersion) || v.node || '?'} · ${v.platform || ''} ${v.arch || ''}`),
          h(Row, { label: t('profile') }, `profiles/${v.profile || 'desktop'}`),
          h(Row, { label: t('home') }, h('code', { style: { fontSize: 11, wordBreak: 'break-all' } }, s.dshHome || '')),
        ),
        h(
          Card,
          { title: t('localStats'), extra: h(Badge, { text: `${stat.entries} ${t('entries')} · ${s.bytesLabel || fmtBytes(stat.bytes)}` }) },
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            (s.sections || []).filter((x) => x.enabled).map((x) =>
              h(
                'div',
                {
                  key: x.id,
                  style: {
                    border: `1px solid ${C.border}`,
                    borderRadius: 7,
                    padding: '5px 9px',
                    fontSize: 11,
                    minWidth: 116,
                  },
                },
                h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                  h('span', { style: { fontWeight: 600 } }, pickText(x.label, x.id)),
                  x.kind === 'advisory' ? h(Badge, { text: t('advisory') }) : null,
                  x.kind === 'redacted' ? h(Badge, { text: t('redacted') }) : null),
                h('div', { style: { color: C.dim, marginTop: 2 } }, `${x.count} ${t('count')}`),
              ),
            ),
          ),
        ),
        h(
          Card,
          {
            title: t('remoteStats'),
            extra: h(Button, { onClick: () => hub.load({ probeRemote: true }), busy: hub.loading, disabled: !s.settings }),
          },
          s.remote
            ? h(
                'div',
                null,
                h(Row, { label: t('entries') }, `${s.remote.stats.entries} · ${fmtBytes(s.remote.stats.bytes)}`),
                h(Row, { label: t('devices') }, String(Object.keys(s.remote.devices || {}).length)),
                h(Row, { label: t('updatedAt') }, relTime(s.remote.updatedAt)),
                h(Row, { label: t('lastSync') }, s.lastSync ? relTime(s.lastSync.at) : t('never')),
              )
            : h(Empty, null, s.remoteError ? `${t('errTitle')}: ${s.remoteError}` : t('remoteUnknown')),
        ),
        h(
          Card,
          { title: t('privacyTitle') },
          h('div', { style: { fontSize: 12, lineHeight: 1.65, color: C.dim } }, t('privacyBody')),
          h('div', { style: { marginTop: 6, fontSize: 11, color: C.dim } }, `${t('secrets')}: ${secretCount} ${t('configured')}`),
        ),
      );
    }

    function Scope({ hub, t }) {
      const d = hub.draft;
      if (!d) return null;
      const sections = (hub.status && hub.status.sectionDefs) || [];
      const localSections = (hub.status && hub.status.sections) || [];
      const countOf = (id) => {
        const found = localSections.find((x) => x.id === id);
        return found ? found.count : 0;
      };
      return h(
        'div',
        null,
        h('div', { style: { fontSize: 12, color: C.dim, marginBottom: 8 } }, t('scopeIntro')),
        h(
          Card,
          null,
          (d.sections ? Object.keys(d.sections) : []).map((id) => {
            const def = sections.find((x) => x.id === id) || { id, label: { zh: id }, desc: null, kind: 'files' };
            const on = Boolean(d.sections[id]);
            return h(
              'div',
              {
                key: id,
                style: {
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  padding: '8px 0',
                  borderBottom: `1px solid ${C.border}`,
                },
              },
              h(Switch, {
                on,
                onChange: (next) => hub.patchDraft((x) => { x.sections[id] = next; }),
              }),
              h(
                'div',
                { style: { flex: 1, minWidth: 0 } },
                h(
                  'div',
                  { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: 12, fontWeight: 600 } }, pickText(def.label, id)),
                  def.kind === 'advisory' ? h(Badge, { text: t('advisory') }) : null,
                  def.kind === 'redacted' ? h(Badge, { text: t('redacted') }) : null,
                  h(Badge, { text: `${countOf(id)} ${t('count')}` }),
                ),
                def.desc ? h('div', { style: { fontSize: 11, color: C.dim, marginTop: 3, lineHeight: 1.55 } }, pickText(def.desc)) : null,
              ),
            );
          }),
        ),
        h(
          Card,
          { title: t('sessionsLimit') },
          h(
            Row,
            { label: t('maxBytes'), hint: t('maxBytesHint') },
            h(TextInput, {
              type: 'number',
              value: Math.round((d.sessions.maxBytes || 0) / 1024 / 1024),
              onChange: (v) => hub.patchDraft((x) => { x.sessions.maxBytes = Math.max(0, Number(v) || 0) * 1024 * 1024; }),
              style: { width: 120 },
            }),
          ),
          h(
            Row,
            { label: t('maxAgeDays'), hint: t('maxAgeDaysHint') },
            h(TextInput, {
              type: 'number',
              value: d.sessions.maxAgeDays || 0,
              onChange: (v) => hub.patchDraft((x) => { x.sessions.maxAgeDays = Math.max(0, Number(v) || 0); }),
              style: { width: 120 },
            }),
          ),
        ),
        h(
          Card,
          { title: t('customPaths') },
          h('div', { style: { fontSize: 11, color: C.dim, marginBottom: 6 } }, t('customHint')),
          (d.customPaths || []).map((item, idx) =>
            h(
              'div',
              { key: `${item.rel}-${idx}`, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' } },
              h(Switch, {
                on: item.enabled !== false,
                onChange: (next) => hub.patchDraft((x) => { x.customPaths[idx].enabled = next; }),
              }),
              h('code', { style: { flex: 1, fontSize: 11, wordBreak: 'break-all' } }, item.rel),
              h(Button, { onClick: () => hub.patchDraft((x) => { x.customPaths.splice(idx, 1); }) }, t('remove')),
            ),
          ),
          h(CustomPathAdder, { hub, t }),
        ),
        h('div', { style: { display: 'flex', gap: 8 } },
          h(Button, {
            primary: true,
            onClick: hub.save,
            busy: hub.busy === 'save',
            disabled: !hub.dirty,
          }, hub.dirty ? t('save') : t('saved')),
          hub.dirty ? h('span', { style: { fontSize: 11, color: C.warn, alignSelf: 'center' } }, '●') : null),
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
              hub.patchDraft((x) => {
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
      const d = hub.draft;
      const st = hub.status || {};
      const [secret, setSecret] = React.useState('');
      if (!d) return null;
      const kind = d.transport || 'local';
      const setRemote = (patch) => hub.patchDraft((x) => { x.remote = { ...x.remote, ...patch }; });
      const secretKind = kind === 'git' ? 'git' : 'webdav';
      const secretSaved = Boolean(st.secrets && st.secrets[secretKind]);
      const secretLabel = kind === 'git' ? t('token') : t('password');
      return h(
        'div',
        null,
        h('div', { style: { fontSize: 12, color: C.dim, marginBottom: 8 } }, t('transportIntro')),
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
                  borderBottom: `1px solid ${C.border}`,
                  cursor: 'pointer',
                },
              },
              h('input', {
                type: 'radio',
                name: 'sync-hub-transport',
                checked: kind === opt.id,
                onChange: () => hub.patchDraft((x) => { x.transport = opt.id; }),
                style: { marginTop: 2 },
              }),
              h('div', null,
                h('div', { style: { fontSize: 12, fontWeight: 600 } }, pickText(opt.label)),
                h('div', { style: { fontSize: 11, color: C.dim, marginTop: 2, lineHeight: 1.55 } }, opt.hint)),
            ),
          ),
        ),
        h(
          Card,
          { title: t('transport') },
          kind === 'local'
            ? h(Row, { label: t('path'), hint: t('localHint') },
                h(TextInput, { value: d.remote.path, onChange: (v) => setRemote({ path: v }), placeholder: 'D:\\Sync\\dsh' }))
            : null,
          kind === 'git'
            ? [
                h(Row, { key: 'repo', label: t('repo'), hint: t('repoHint') },
                  h(TextInput, { value: d.remote.url, onChange: (v) => setRemote({ url: v }), placeholder: 'https://github.com/you/dsh-sync.git' })),
                h(Row, { key: 'branch', label: t('branch') },
                  h(TextInput, { value: d.remote.branch, onChange: (v) => setRemote({ branch: v }), placeholder: 'main', style: { width: 160 } })),
              ]
            : null,
          kind === 'webdav'
            ? [
                h(Row, { key: 'url', label: t('url'), hint: t('urlHint') },
                  h(TextInput, { value: d.remote.url, onChange: (v) => setRemote({ url: v }), placeholder: 'https://dav.example.com/dsh-sync' })),
                h(Row, { key: 'user', label: t('username') },
                  h(TextInput, { value: d.remote.username, onChange: (v) => setRemote({ username: v }), style: { width: 200 } })),
              ]
            : null,
          kind !== 'local'
            ? h(
                Row,
                { label: secretLabel, hint: t('tokenHint') },
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
                      hub.saveSecret(secretKind, secret);
                      setSecret('');
                    },
                    busy: hub.busy === `secret:${secretKind}`,
                    disabled: !secret.trim(),
                  }, t('saveSecret')),
                  secretSaved
                    ? h(Button, {
                        onClick: () => { hub.saveSecret(secretKind, ''); setSecret(''); },
                        busy: hub.busy === `secret:${secretKind}`,
                      }, t('clearSecret'))
                    : null,
                ),
              )
            : null,
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
            h(Button, { primary: true, onClick: hub.save, busy: hub.busy === 'save', disabled: !hub.dirty },
              hub.dirty ? t('save') : t('saved')),
            h(Button, { onClick: hub.test, busy: hub.busy === 'test' }, hub.busy === 'test' ? t('testing') : t('test'))),
        ),
        h(Card, { title: t('target') },
          h('code', { style: { fontSize: 11, wordBreak: 'break-all' } }, st.target || '—')),
      );
    }

    function SessionsTab({ hub, t }) {
      const d = hub.draft;
      React.useEffect(() => {
        if (hub.sessions === null && hub.busy !== 'sessions') hub.loadSessions();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      if (!d) return null;
      const excluded = new Set((d.sessions && d.sessions.excludeIds) || []);
      const data = hub.sessions;
      return h(
        'div',
        null,
        h('div', { style: { fontSize: 12, color: C.dim, marginBottom: 8 } }, t('sessionsIntro')),
        h(
          Card,
          {
            title: t('tabSessions'),
            extra: h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              data ? h(Badge, { text: `${data.total} · ${fmtBytes(data.bytes)}` }) : null,
              h(Button, { onClick: hub.loadSessions, busy: hub.busy === 'sessions' }, t('refresh'))),
          },
          !data ? h(Empty, null, hub.busy === 'sessions' ? '…' : t('noSessions'))
            : data.sessions.length === 0
              ? h(Empty, null, t('noSessions'))
              : h(
                  'div',
                  { style: { maxHeight: 420, overflow: 'auto' } },
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
                          borderBottom: `1px solid ${C.border}`,
                          opacity: excluded.has(s.sessionId) ? 0.5 : 1,
                        },
                      },
                      h(
                        'div',
                        { style: { flex: 1, minWidth: 0 } },
                        h('div', { style: { fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                          pickText(s.title, s.sessionId)),
                        h('div', { style: { fontSize: 11, color: C.dim, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                          `${s.cwd || '—'} · ${fmtTime(s.createdAt)} · ${fmtBytes(s.bytes)}`),
                      ),
                      s.synced ? h(Badge, { text: t('synced'), color: C.ok }) : h(Badge, { text: t('notSynced') }),
                      h(Button, {
                        onClick: () => {
                          hub.patchDraft((x) => {
                            x.sessions = x.sessions || { excludeIds: [] };
                            const list = new Set(x.sessions.excludeIds || []);
                            if (list.has(s.sessionId)) list.delete(s.sessionId);
                            else list.add(s.sessionId);
                            x.sessions.excludeIds = [...list];
                          });
                        },
                      }, excluded.has(s.sessionId) ? t('include') : t('exclude')),
                    ),
                  ),
                ),
        ),
        h('div', { style: { display: 'flex', gap: 8 } },
          h(Button, { primary: true, onClick: hub.save, busy: hub.busy === 'save', disabled: !hub.dirty },
            hub.dirty ? t('save') : t('saved'))),
      );
    }

    function PlanTab({ hub, t }) {
      const d = hub.draft;
      const s = hub.status || {};
      if (!d) return null;
      const plan = hub.plan;
      const totals = plan ? plan.totals : null;
      const list = (items, color) =>
        h(
          'div',
          { style: { maxHeight: 190, overflow: 'auto', marginTop: 4 } },
          (items || []).map((item, i) =>
            h(
              'div',
              { key: `${item.id}-${i}`, style: { display: 'flex', gap: 8, fontSize: 11, padding: '2px 0' } },
              h('span', { style: { color, width: 60, flex: '0 0 60px' } }, item.section || ''),
              h('span', { style: { flex: 1, wordBreak: 'break-all' } }, shortRel(item.rel)),
              h('span', { style: { color: C.dim } }, item.bytes != null ? fmtBytes(item.bytes) : ''),
            ),
          ),
        );
      return h(
        'div',
        null,
        h('div', { style: { fontSize: 12, color: C.dim, marginBottom: 8 } }, t('planIntro')),
        h(
          Card,
          { title: t('conflictPolicy') },
          h(Row, { label: t('conflictPolicy') },
            h(Select, {
              value: d.conflictPolicy,
              onChange: (v) => hub.patchDraft((x) => { x.conflictPolicy = v; }),
              options: [
                { value: 'newest', label: t('policyNewest') },
                { value: 'local', label: t('policyLocal') },
                { value: 'remote', label: t('policyRemote') },
                { value: 'skip', label: t('policySkip') },
              ],
            })),
          h(Row, { label: t('keepBackups') },
            h(TextInput, {
              type: 'number',
              value: d.keepBackups || 20,
              onChange: (v) => hub.patchDraft((x) => { x.keepBackups = Math.max(1, Number(v) || 20); }),
              style: { width: 100 },
            })),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
            h(Button, { onClick: hub.save, busy: hub.busy === 'save', disabled: !hub.dirty },
              hub.dirty ? t('save') : t('saved'))),
        ),
        h(
          Card,
          {
            title: t('tabPlan'),
            extra: h('div', { style: { display: 'flex', gap: 8 } },
              h(Button, { onClick: hub.preview, busy: hub.busy === 'plan' }, hub.busy === 'plan' ? t('previewing') : t('preview')),
              h(Button, { primary: true, onClick: hub.run, busy: hub.busy === 'run' }, hub.busy === 'run' ? t('running') : t('run'))),
          },
          !totals
            ? h(Empty, null, s.lastSync ? `${t('lastSync')}: ${relTime(s.lastSync.at)}` : t('never'))
            : totals.push + totals.pull + totals.conflicts === 0
              ? h(Empty, null, t('nothing'))
              : h(
                  'div',
                  null,
                  h('div', { style: { display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' } },
                    h(Badge, { text: `${t('push')} ${totals.push} · ${fmtBytes(totals.pushBytes)}`, color: '#3b82f6' }),
                    h(Badge, { text: `${t('pull')} ${totals.pull} · ${fmtBytes(totals.pullBytes)}`, color: C.warn }),
                    h(Badge, { text: `${t('conflicts')} ${totals.conflicts}`, color: C.bad }),
                    h(Badge, { text: `${t('skipped')} ${totals.skipped}` })),
                  plan.push && plan.push.length ? h('div', null, h('div', { style: { fontSize: 11, fontWeight: 600, color: '#3b82f6' } }, t('push')), list(plan.push, '#3b82f6')) : null,
                  plan.pull && plan.pull.length ? h('div', null, h('div', { style: { fontSize: 11, fontWeight: 600, color: C.warn } }, t('pull')), list(plan.pull, C.warn)) : null,
                  plan.conflicts && plan.conflicts.length
                    ? h('div', null, h('div', { style: { fontSize: 11, fontWeight: 600, color: C.bad } }, t('conflicts')), list(plan.conflicts, C.bad))
                    : null,
                ),
        ),
        h(
          Card,
          { title: t('backups') },
          (s.backups || []).length === 0
            ? h(Empty, null, t('noBackups'))
            : h('div', null,
                (s.backups || []).map((b) =>
                  h('div', { key: b.stamp || b.path || b.name, style: { display: 'flex', gap: 8, fontSize: 11, padding: '2px 0' } },
                    h('span', { style: { flex: 1 } }, b.stamp || b.name || b.path),
                    h('span', { style: { color: C.dim } }, b.entries != null ? `${b.entries} ${t('entries')}` : '')))),
        ),
      );
    }

    /* ---------- 5. 主组件与注册 ---------- */

    const TABS = [
      { id: 'overview', key: 'tabOverview', render: 'overview' },
      { id: 'scope', key: 'tabScope', render: 'scope' },
      { id: 'transport', key: 'tabTransport', render: 'transport' },
      { id: 'sessions', key: 'tabSessions', render: 'sessions' },
      { id: 'plan', key: 'tabPlan', render: 'plan' },
    ];

    function Section({ t }) {
      const hub = useHub(t);
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
      const s = hub.status;
      const ver = s && s.version
        ? (s.version.desktop && s.version.desktop.desktopVersion) || s.version.version || ''
        : '';

      return h(
        'div',
        { style: { fontSize: 13, lineHeight: 1.5, padding: '2px 0 12px' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' } },
          h(SyncIcon, { size: 20 }),
          h('div', { style: { flex: 1, minWidth: 160 } },
            h('div', { style: { fontSize: 14, fontWeight: 600 } }, t('title')),
            h('div', { style: { fontSize: 11, color: C.dim } }, t('subtitle'))),
          ver ? h(Badge, { text: `DSH ${ver}` }) : null,
          s ? h(Badge, { text: `${t('device')}: ${s.device.name}` }) : null,
          h(Button, { onClick: () => hub.load({ probeRemote: true }), busy: hub.loading }, t('refresh')),
        ),
        hub.notice
          ? h(Banner, { kind: hub.notice.kind, onClose: () => hub.setNotice(null) }, hub.notice.text)
          : null,
        hub.error ? h(Banner, { kind: 'error' }, hub.error) : null,
        h(
          'div',
          { style: { display: 'flex', gap: 4, marginBottom: 10, borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap' } },
          TABS.map((item) =>
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
                  borderBottom: tab === item.id ? '2px solid #3b82f6' : '2px solid transparent',
                  marginBottom: -1,
                },
              },
              t(item.key),
            ),
          ),
        ),
        hub.loading && !s ? h(Empty, null, '…') : null,
        !s ? null : tab === 'overview' ? h(Overview, { hub, t })
          : tab === 'scope' ? h(Scope, { hub, t })
            : tab === 'transport' ? h(TransportTab, { hub, t })
              : tab === 'sessions' ? h(SessionsTab, { hub, t })
                : h(PlanTab, { hub, t }),
        h('div', { style: { fontSize: 10, color: C.dim, marginTop: 8 } }, `${NS} v${VERSION}`),
      );
    }

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
        const off = ctx.slots.inject('settings.section', () =>
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
            if (typeof off === 'function') off();
          } catch {
            /* ignore */
          }
        };
      },
    };
  },
});

