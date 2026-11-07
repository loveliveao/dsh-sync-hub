/**
 * 给 Agent 用的工具：状态、计划、执行、会话列表。
 * 都返回纯文本摘要，参数尽量少 —— 模型只需要知道「同步到哪了」和「跑一次」。
 */

function textResult(text, extra = {}) {
  return [{ type: 'text', text }]
}

/**
 * 给每个工具执行体套一层兜底：异常转成可读文本返回，绝不冒泡给宿主。
 * 宿主执行器把 reject 当成「工具崩了」，插件不该让这种事发生。
 */
function safeExecute(name, fn) {
  return async function execute(...args) {
    try {
      return await fn(...args)
    } catch (err) {
      const detail = String((err && err.message) || err)
      return { text: `[sync-hub] ${name} 失败：${detail}` }
    }
  }
}

function outputSchema() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string' },
        pushed: { type: 'number' },
        pulled: { type: 'number' },
        conflicts: { type: 'number' },
      },
    },
    render: (_args, value) => textResult(value.text),
  }
}

function describePlan(plan) {
  const lines = []
  lines.push(`通道：${plan.transport} → ${plan.target}`)
  lines.push(`本机条目 ${plan.localEntries} 个，远端 ${plan.remoteEntries} 个`)
  lines.push(`待推送 ${plan.totals.push} 个（${plan.totals.pushBytes} 字节），待拉取 ${plan.totals.pull} 个（${plan.totals.pullBytes} 字节）`)
  if (plan.conflicts.length) {
    lines.push(`冲突 ${plan.conflicts.length} 个：`)
    for (const item of plan.conflicts.slice(0, 8)) {
      lines.push(`  · ${item.rel}（${item.section}，处理方式：${item.resolution}）`)
    }
  }
  const pushPreview = plan.push.slice(0, 8).map((item) => `  + ${item.rel}`)
  if (pushPreview.length) lines.push('待推送：', ...pushPreview)
  const pullPreview = plan.pull.slice(0, 8).map((item) => `  ← ${item.rel}`)
  if (pullPreview.length) lines.push('待拉取：', ...pullPreview)
  if (plan.errors && plan.errors.length) {
    lines.push(`采集告警：${plan.errors.map((item) => `${item.section}: ${item.message}`).join('; ')}`)
  }
  return lines.join('\n')
}

export function registerTools(ctx, hub) {
  const disposers = []

  disposers.push(
    ctx.tools.register({
      name: 'sync_hub_status',
      description:
        '查看 dsh-sync-hub 的同步状态：DSH 版本、本机设备、通道、各同步范围与条目数、上次同步结果。需先了解配置同步情况时调用。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: outputSchema(),
      isConcurrencySafe: () => true,
      timeoutMs: 30000,
      execute: safeExecute('sync_hub_status', async () => {
        const status = await hub.status({ probeRemote: false })
        const sections = status.sections
          .filter((item) => item.enabled || item.count > 0)
          .map((item) => `  · ${item.id}${item.enabled ? '' : '（停用）'}：${item.count} 个条目`)
        const lines = [
          `插件 ${status.plugin.name}@${status.plugin.version}`,
          `DSH ${status.version.version || '未知'}（${status.version.edition}）· node ${status.version.node}`,
          `设备 ${status.device.name}（${status.device.id.slice(0, 8)}）· 配置目录 ${status.dshHome}`,
          `通道 ${status.transport} → ${status.target || '未设置'}`,
          `本机 ${status.local.entries} 个条目 / ${status.bytesLabel}`,
          '同步范围：',
          ...sections,
        ]
        if (status.lastSync) {
          lines.push(
            `上次同步 ${status.lastSync.at}：推送 ${status.lastSync.pushed}、拉取 ${status.lastSync.pulled}、冲突 ${status.lastSync.conflicts}、失败 ${status.lastSync.failures}`,
          )
        } else {
          lines.push('还没有执行过同步')
        }
        if (status.remote && status.remote.stats) {
          lines.push(`远端已有 ${status.remote.stats.entries} 个条目 / ${status.remote.stats.devices} 台设备`)
        }
        return { text: lines.join('\n') }
      }),
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'sync_hub_plan',
      description: '生成 dsh-sync-hub 的同步计划（只读，不写文件）：列出待推送、待拉取、冲突与被跳过的条目。执行同步前先看计划。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: outputSchema(),
      isConcurrencySafe: () => false,
      timeoutMs: 120000,
      execute: safeExecute('sync_hub_plan', async () => {
        const result = await hub.plan()
        if (!result.ok) return { text: `计划失败：${result.error}` }
        const plan = result.plan
        return {
          text: describePlan(plan),
          pushed: plan.totals.push,
          pulled: plan.totals.pull,
          conflicts: plan.totals.conflicts,
        }
      }),
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'sync_hub_run',
      description: '执行一次 dsh-sync-hub 同步：推送本机变更到远端、拉取远端变更并写入本机（写入前自动备份）。返回推送/拉取/冲突/失败数量。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: outputSchema(),
      isConcurrencySafe: () => false,
      timeoutMs: 600000,
      execute: safeExecute('sync_hub_run', async () => {
        const result = await hub.run()
        if (!result.ok) return { text: `同步失败：${result.error || '见失败列表'}` }
        const data = result.result
        const lines = [
          `同步完成：推送 ${data.pushed.length} 个、拉取 ${data.pulled.length} 个、冲突 ${data.conflicts.length} 个`,
          `通道：${data.lastSync.transport} → ${data.lastSync.target}`,
          `耗时 ${Math.round(data.lastSync.durationMs / 100) / 10}s`,
        ]
        if (data.pushed.length) lines.push('已推送：', ...data.pushed.slice(0, 10).map((item) => `  + ${item.rel}`))
        if (data.pulled.length) lines.push('已拉取：', ...data.pulled.slice(0, 10).map((item) => `  ← ${item.rel}${item.backup ? '（已备份）' : ''}`))
        for (const conflict of data.conflicts.slice(0, 8)) {
          lines.push(`冲突 ${conflict.rel}：${conflict.resolution === 'push' ? '保留本机' : conflict.resolution === 'pull' ? '采用远端' : '跳过'}`)
        }
        if (data.failures.length) {
          lines.push(
            `失败 ${data.failures.length} 个：`,
            ...data.failures.slice(0, 8).map((item) => `  ! ${item.rel}: ${item.message}`),
          )
        }
        if (data.notes.length) lines.push('说明：', ...data.notes.slice(0, 8).map((item) => `  · ${item}`))
        return {
          text: lines.join('\n'),
          pushed: data.pushed.length,
          pulled: data.pulled.length,
          conflicts: data.conflicts.length,
        }
      }),
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'sync_hub_sessions',
      description: '列出本机 DSH 会话（标题、工作区、大小、是否已同步到远端），用于确认哪些会话会被同步。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'number', description: '最多返回多少条，默认 20' },
        },
      },
      output: outputSchema(),
      isConcurrencySafe: () => true,
      timeoutMs: 30000,
      execute: safeExecute('sync_hub_sessions', async (args) => {
        const limit = Math.min(200, Math.max(1, Number(args && args.limit) || 20))
        const data = await hub.sessions()
        const rows = data.sessions.slice(0, limit).map((item) => {
          const size = item.bytes >= 1024 * 1024 ? `${(item.bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(item.bytes / 1024))}KB`
          return `  · ${item.title || '(无标题)'} — ${item.cwd || item.project} · ${size} · ${item.synced ? '已同步' : '未同步'}`
        })
        const lines = [`本机共 ${data.total} 个会话（${Math.round(data.bytes / 1024 / 1024 * 10) / 10}MB）`]
        if (rows.length) lines.push(...rows)
        return { text: lines.join('\n') }
      }),
    }),
  )

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 已经卸载 */
      }
    }
  }
}
