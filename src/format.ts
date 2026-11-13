/**
 * 工具输出渲染。DSH 的 defineTool 通过 output.render 返回 text block，
 * 所以「展示」层就是一份对齐过的 Markdown 表格 + 可操作的诊断信息。
 */
import type {
  AccountInfo,
  BalanceReport,
  BalanceSnapshot,
  InvocationResult,
  ModelsResult,
  ProviderInfo,
} from './types.ts'
import { formatMoney } from './core/balance.ts'
import { truncate } from './core/errors.ts'

export function statusLabel(status: BalanceSnapshot['status']): string {
  switch (status) {
    case 'ok':
      return '实时'
    case 'stale':
      return '缓存'
    case 'error':
      return '失败'
    case 'unsupported':
      return '不支持'
    case 'manual':
      return '手工'
  }
}

export function renderBalanceReport(report: BalanceReport): string {
  const lines: string[] = []
  const time = new Date(report.generatedAt).toLocaleString()
  lines.push(`## 账户余额（${time}）`, '')

  if (report.accounts.length === 0) {
    lines.push('没有启用的账户。用 `provider_accounts` 的 list 检查配置，或 register 新增账户。', '')
  } else {
    lines.push('| 账户 | 服务商 | 状态 | 余额 / 配额 | 构成 | 更新于 |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const item of report.accounts) {
      lines.push(
        `| ${escapeCell(item.label)} | ${escapeCell(item.providerId)} | ${statusLabel(item.status)} | ${balanceCell(item)} | ${breakdownCell(item)} | ${new Date(item.fetchedAt).toLocaleTimeString()} |`,
      )
    }
    lines.push('')
  }

  if (report.totals.length) {
    lines.push(
      '合计：' + report.totals.map((t) => `${formatMoney(t.total, t.currency)}（${t.accounts} 个账户）`).join(' · '),
      '',
    )
  }
  const c = report.counts
  lines.push(
    `实时 ${c.ok} · 缓存 ${c.stale} · 失败 ${c.error} · 不支持 ${c.unsupported} · 手工 ${c.manual}` +
      (c.cached ? ` · 命中 TTL 缓存 ${c.cached}` : ''),
  )

  const notes = report.accounts
    .filter((item) => item.note || item.error)
    .map((item) => `- ${item.label}：${item.error ? `${item.error.message}（${item.error.hint}）` : item.note}`)
  if (notes.length) lines.push('', '### 说明', '', ...notes)

  if (report.warnings.length) {
    lines.push('', '### 预警', '', ...[...new Set(report.warnings)].map((text) => `- ${text}`))
  }
  return lines.join('\n')
}

function balanceCell(item: BalanceSnapshot): string {
  if (item.status === 'unsupported') return '—（无按 Key 余额接口）'
  if (item.status === 'error') return '—'
  if (item.total !== undefined) return `**${formatMoney(item.total, item.currency)}**`
  if (item.quotas?.length) {
    return item.quotas
      .map((q) => `${q.name} ${q.usedPercent !== undefined ? `${q.usedPercent}% 已用` : `${q.remaining ?? '?'} / ${q.limit ?? '?'}`}`)
      .join('；')
  }
  return '—'
}

function breakdownCell(item: BalanceSnapshot): string {
  const parts = Object.entries(item.breakdown ?? {}).map(([key, value]) => `${key} ${formatMoney(value, item.currency)}`)
  return parts.length ? parts.join(' / ') : '—'
}

export function renderAccounts(accounts: AccountInfo[], providers: ProviderInfo[] = []): string {
  const lines: string[] = ['## 已配置账户', '']
  if (accounts.length === 0) {
    lines.push(
      '（空）在 cordis.patch.yml 的 accounts / accountsDir 里添加账户；' +
        '若宿主提供了 credentials 服务，autoDiscover=true 会自动为已配置的 API Key 生成账户。',
    )
  } else {
    lines.push('| id | 服务商 | 余额能力 | 凭据 | 默认模型 | 状态 |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const account of accounts) {
      const ability = account.balanceKind === 'unsupported'
        ? '不支持'
        : account.balanceKind === 'manual'
          ? '手工'
          : account.balanceKind === 'quota'
            ? '配额窗口'
            : `余额${account.balanceReliable ? '' : '（非官方端点）'}`
      const state = account.enabled ? (account.discovered ? '启用（自动探测）' : '启用') : '停用'
      lines.push(
        `| \`${account.id}\` | ${escapeCell(account.label)} / ${account.provider} | ${ability} | ${account.hasApiKey ? `已配置 (${account.apiKeySource})` : '**缺失**'} | ${account.defaultModel ?? '—'} | ${state} |`,
      )
    }
  }
  if (providers.length) {
    lines.push('', '### 可用服务商', '')
    lines.push('| id | 名称 | chat base | 余额接口 |')
    lines.push('| --- | --- | --- | --- |')
    for (const p of providers) {
      lines.push(
        `| \`${p.id}\` | ${escapeCell(p.label)} | \`${p.chatBaseUrl}\` | ${p.balanceKind === 'unsupported' ? '无' : p.balanceReliable ? '官方' : '非官方/历史端点'} |`,
      )
    }
  }
  return lines.join('\n')
}

export function renderModels(result: ModelsResult): string {
  const lines = [
    `## 可用模型 · ${result.accountId}（${result.providerId}）`,
    '',
    `来源：${result.source === 'live' ? '实时 /models' : '静态回退清单'}`,
    '',
  ]
  if (result.models.length === 0) lines.push('（空）请在账户配置里设置 models 或 defaultModel。')
  else lines.push(...result.models.map((model) => `- \`${model}\``))
  if (result.warnings.length) lines.push('', ...result.warnings.map((text) => `> ${text}`))
  return lines.join('\n')
}

export function renderInvocation(result: InvocationResult): string {
  const lines: string[] = []
  const title = result.dryRun ? '请求预览（dry-run）' : result.ok ? '调用成功' : '调用失败'
  lines.push(`## ${title}`, '')
  lines.push(
    `- 账户：\`${result.accountId}\` · 服务商：\`${result.providerId}\`` +
      (result.model ? ` · 模型：\`${result.model}\`` : ''),
  )
  if (result.httpStatus !== undefined) lines.push(`- HTTP ${result.httpStatus} · ${result.elapsedMs}ms`)
  if (result.request) {
    lines.push(`- \`${result.request.method} ${result.request.url}\``)
  }

  if (result.error) {
    lines.push('', `**错误类型**：${result.error.kind}`, '', `**信息**：${result.error.message}`, '', `**建议**：${result.error.hint}`)
    if (result.error.providerCode) lines.push('', `平台错误码：\`${result.error.providerCode}\``)
    return lines.join('\n')
  }

  if (result.dryRun && result.request?.body !== undefined) {
    lines.push('', '```json', truncate(JSON.stringify(result.request.body, null, 2), 4000), '```')
  }
  if (result.reasoningContent) {
    lines.push('', '<details><summary>思考过程</summary>', '', result.reasoningContent, '', '</details>')
  }
  if (result.content && !result.dryRun) lines.push('', result.content)
  if (result.usage) {
    lines.push(
      '',
      `Token：输入 ${result.usage.promptTokens ?? '?'} · 输出 ${result.usage.completionTokens ?? '?'} · 合计 ${result.usage.totalTokens ?? '?'}`,
    )
  }
  if (result.finishReason) lines.push(`结束原因：\`${result.finishReason}\``)
  if (result.truncated) lines.push('> 输出已截断。')
  if (result.raw !== undefined) {
    lines.push('', '<details><summary>原始响应（截断）</summary>', '', '```json', truncate(JSON.stringify(result.raw, null, 2), 4000), '```', '</details>')
  }
  if (result.warnings.length) lines.push('', ...result.warnings.map((text) => `> ${text}`))
  return lines.join('\n')
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
