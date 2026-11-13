/**
 * 模型可见的 6 个工具。
 *
 * 工具面刻意保持小：
 *   账户（看/增/删） · 余额（查/刷新） · 模型（列表） · 调用（chat） ·
 *   调用（raw） · 诊断（status）
 * 模型不需要知道端点、签名或 mapper，只需要指定「哪个账户 / 哪个模型 / 什么参数」。
 */
import type {
  AccountConfig,
  AccountInfo,
  BalancePreset,
  BalanceReport,
  CallOptions,
  ChatMessage,
  InvocationResult,
  ModelsResult,
  ProviderInfo,
  ResolvedConfig,
} from './types.ts'
import type { DshToolExecution } from './dsh-types.ts'
import type { ConsoleRegistry } from './core/registry.ts'
import type { BalanceService } from './core/balance.ts'
import type { InvocationService } from './core/invocation.ts'
import { lossless } from './core/errors.ts'

import { loadHostDeps } from './hostdeps.ts'
import {
  renderAccounts,
  renderBalanceReport,
  renderInvocation,
  renderModels,
} from './format.ts'

export const hostDeps = await loadHostDeps()
const defineTool: (options: any) => any = hostDeps.defineTool

export interface ToolHost {
  tools: { register(tool: unknown): () => void }
}

export interface ToolDeps {
  registry: ConsoleRegistry
  balances: BalanceService
  invocation: InvocationService
  config: ResolvedConfig
  version: string
  hostDeps: { source: string; notes: string[] }
  dashboardUrl?: string
}

const ACCOUNT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: '账户唯一 id' },
    provider: { type: 'string', required: true, description: '服务商 id，见 provider_accounts list 的「可用服务商」' },
    label: { type: 'string' },
    apiKeyEnv: { type: 'string', description: '存放 API Key 的环境变量名（推荐）' },
    apiKey: { type: 'string', description: '也支持 ${ENV_VAR} 或直接字面量；输出一律脱敏' },
    baseUrl: { type: 'string', description: '覆盖服务商 chat base（代理 / 中转 / 私有部署）' },
    balanceBaseUrl: { type: 'string' },
    defaultModel: { type: 'string' },
    models: { type: 'array', items: { type: 'string' } },
    balancePreset: { type: 'string', enum: ['auto', 'quota', 'money', 'manual', 'unsupported'] },
    manualTotal: { type: 'number', description: 'balancePreset=manual 时的余额数值' },
    manualCurrency: { type: 'string' },
    lowBalanceThreshold: { type: 'number' },
    enabled: { type: 'boolean' },
  },
}

export function registerTools(ctx: ToolHost, deps: ToolDeps): Array<() => void> {
  const disposers: Array<() => void> = []
  const register = (tool: unknown) => disposers.push(ctx.tools.register(tool) as () => void)

  // 1. 余额查询 / 刷新 ----------------------------------------------------
  register(
    defineTool({
      name: 'provider_balances',
      description:
        '查询并展示所有（或指定）AI 服务商账户的实时余额与套餐配额。默认读 TTL 缓存，' +
        'force=true 会逐个账户并发刷新；单个账户失败只影响自己那一行，并显示上次成功的缓存值。' +
        '对没有按 API Key 余额接口的平台会明确标注「不支持」并给出替代方案。',
      parameters: {
        accountIds: { type: 'array', items: { type: 'string' }, description: '只查这些账户；不传则查全部启用账户' },
        force: { type: 'boolean', description: 'true = 绕过缓存强制联网刷新，默认 false' },
        action: {
          type: 'string',
          enum: ['auto', 'refresh', 'cached'],
          description: 'auto（默认，缓存过期才刷新）/ refresh（强制刷新）/ cached（只读缓存，绝不联网）',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [
          { type: 'text', text: renderBalanceReport(value as BalanceReport) },
        ],
      },
      async execute(args: any, exec: DshToolExecution) {
        const action = args.action ?? (args.force ? 'refresh' : 'auto')
        if (action === 'cached') return lossless(deps.balances.snapshot())
        const report = await deps.balances.refresh({
          accountIds: args.accountIds,
          force: action === 'refresh',
          signal: exec.signal,
        })
        return lossless(report)
      },
    }),
  )

  // 2. 账户与服务商管理 --------------------------------------------------
  register(
    defineTool({
      name: 'provider_accounts',
      description:
        '管理多账户配置：list 列出账户与所有可用服务商（含余额能力说明），register 运行时新增/覆盖一个账户，' +
        'unregister 移除，enable/disable 启停，refresh-credentials 在环境变量变化后重读密钥。' +
        '所有输出都不含密钥明文。',
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'register', 'unregister', 'enable', 'disable', 'refresh-credentials'],
          required: true,
        },
        id: { type: 'string', description: 'unregister / enable / disable 时的账户 id' },
        account: { ...ACCOUNT_SCHEMA, description: 'register 时的账户声明' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => {
          const payload = value as { accounts?: unknown[]; providers?: unknown[]; message?: string }
          const text = renderAccounts(
            (payload.accounts ?? []) as AccountInfo[],
            (payload.providers ?? []) as ProviderInfo[],
          )
          return [{ type: 'text', text: payload.message ? `${payload.message}\n\n${text}` : text }]
        },
      },
      async execute(args: any) {
        if (args.action === 'register') {
          if (!args.account) throw new Error('register 需要提供 account')
          deps.registry.registerAccount(toAccountConfig(args.account))
          return lossless({
            message: `已注册账户 \`${args.account.id}\`。`,
            accounts: deps.registry.listAccounts(),
            providers: deps.registry.listProviders(),
          })
        }
        if (args.action === 'unregister') {
          if (!args.id) throw new Error('unregister 需要提供 id')
          return lossless({
            message: `移除账户 \`${args.id}\`：${deps.registry.unregisterAccount(args.id) ? '成功' : '不存在'}。`,
            accounts: deps.registry.listAccounts(),
            providers: deps.registry.listProviders(),
          })
        }
        if (args.action === 'enable' || args.action === 'disable') {
          if (!args.id) throw new Error('该操作需要提供 id')
          deps.registry.setAccountEnabled(args.id, args.action === 'enable')
          return lossless({ accounts: deps.registry.listAccounts(), providers: deps.registry.listProviders() })
        }
        if (args.action === 'refresh-credentials') {
          return lossless({
            message: `已重新读取凭据：${deps.registry.refreshCredentials().join(', ') || '（无账户）'}`,
            accounts: deps.registry.listAccounts(),
            providers: deps.registry.listProviders(),
          })
        }
        return lossless({ accounts: deps.registry.listAccounts(), providers: deps.registry.listProviders() })
      },
    }),
  )

  // 3. 模型列表 ----------------------------------------------------------
  register(
    defineTool({
      name: 'provider_models',
      description:
        '列出某个账户当前可用的模型。优先调服务商 /models；接口不存在或失败时回退到静态清单，并明确标注来源。' +
        '在 provider_call 里选模型前先用它确认。',
      parameters: {
        accountId: { type: 'string', required: true },
        refresh: { type: 'boolean', description: '跳过模型缓存重新拉取' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: renderModels(value as ModelsResult) }],
      },
      async execute(args: any, exec: DshToolExecution) {
        return lossless(await deps.invocation.models(args.accountId, { refresh: args.refresh, signal: exec.signal }))
      },
    }),
  )

  // 4. 通用 chat 调用 ----------------------------------------------------
  register(
    defineTool({
      name: 'provider_call',
      description:
        '通用 API 调用入口（OpenAI 兼容 chat/completions）：自由选择账户、模型与任意参数，返回文本、token 用量与原始响应。' +
        'dryRun=true 只构造请求不联网、不含密钥，适合先验证配置；includeRaw=true 返回结构化原始响应。',
      parameters: {
        accountId: { type: 'string', required: true, description: '账户 id，见 provider_accounts list' },
        model: { type: 'string', description: '模型名；缺省用账户默认模型' },
        prompt: { type: 'string', description: '快捷写法：单条 user 消息' },
        messages: {
          type: 'array',
          description: '完整对话（与 prompt 二选一）',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'], required: true },
              content: { type: 'string', required: true },
              name: { type: 'string' },
              tool_call_id: { type: 'string' },
            },
          },
        },
        parameters: {
          type: 'object',
          additionalProperties: true,
          description: '任意 OpenAI 兼容参数：temperature / max_tokens / top_p / stop / tools / response_format / stream …',
        },
        includeRaw: { type: 'boolean', description: '附带原始响应（按上限截断）' },
        dryRun: { type: 'boolean', description: '只返回将要发送的请求，不联网、不消耗额度' },
        timeoutMs: { type: 'number', description: '本次调用超时毫秒数' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: renderInvocation(value as InvocationResult) }],
      },
      async execute(args: any, exec: DshToolExecution) {
        const options: CallOptions = {
          accountId: args.accountId,
          mode: 'chat',
          model: args.model,
          prompt: args.prompt,
          messages: args.messages as ChatMessage[] | undefined,
          parameters: args.parameters,
          includeRaw: args.includeRaw === true,
          dryRun: args.dryRun === true,
          timeoutMs: args.timeoutMs,
          signal: exec.signal,
        }
        return lossless(await deps.invocation.call(options))
      },
    }),
  )

  // 5. 任意 raw 请求 -----------------------------------------------------
  register(
    defineTool({
      name: 'provider_request',
      description:
        '更底层的通用入口：对某个账户的 base URL 发起任意 method/path/body 请求，' +
        '用于 /models、embeddings、rerank 或平台专有端点。受主机白名单与 https 约束，密钥自动注入且不回显。',
      parameters: {
        accountId: { type: 'string', required: true },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: '默认 GET' },
        path: { type: 'string', required: true, description: '相对 base URL 的路径，如 /models；也接受绝对 https URL（须在白名单内）' },
        headers: { type: 'object', additionalProperties: true, description: '额外请求头' },
        body: { type: 'object', additionalProperties: true, description: 'JSON 请求体' },
        includeRaw: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        timeoutMs: { type: 'number' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: renderInvocation(value as InvocationResult) }],
      },
      async execute(args: any, exec: DshToolExecution) {
        const options: CallOptions = {
          accountId: args.accountId,
          mode: 'raw',
          method: args.method ?? 'GET',
          path: args.path,
          headers: args.headers,
          body: args.body,
          includeRaw: args.includeRaw === true,
          dryRun: args.dryRun === true,
          timeoutMs: args.timeoutMs,
          signal: exec.signal,
        }
        return lossless(await deps.invocation.call(options))
      },
    }),
  )

  // 6. 诊断 --------------------------------------------------------------
  register(
    defineTool({
      name: 'provider_status',
      description:
        '查看插件运行状态：版本、宿主 defineTool 来源、已注册服务商/账户数、缓存与自动刷新配置、主机白名单、看板地址、配置警告。' +
        '排查「插件没生效 / 余额查不到 / 调用被拒」时先看这里。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: renderStatus(value as StatusPayload) }],
      },
      async execute() {
        return lossless({
          version: deps.version,
          hostDefineTool: deps.hostDeps.source,
          hostDepsNotes: deps.hostDeps.notes,
          providers: deps.registry.listProviderIds(),
          accounts: deps.registry.listAccounts(),
          cacheTtlMs: deps.config.balance.cacheTtlMs,
          autoRefreshMs: deps.config.balance.autoRefreshMs,
          concurrency: deps.config.balance.concurrency,
          requestTimeoutMs: deps.config.http.timeoutMs,
          retries: deps.config.http.retries,
          allowStream: deps.config.call.allowStream,
          allowRawRequests: deps.config.call.allowRawRequests,
          allowedHosts: deps.registry.allowedHosts(),
          dashboardUrl: deps.dashboardUrl,
          warnings: deps.config.warnings,
        })
      },
    }),
  )

  return disposers
}

interface StatusPayload {
  version: string
  hostDefineTool: string
  hostDepsNotes: string[]
  providers: string[]
  accounts: Array<{ id: string; provider: string; hasApiKey: boolean; balanceKind: string }>
  cacheTtlMs: number
  autoRefreshMs: number
  concurrency: number
  requestTimeoutMs: number
  retries: number
  allowStream: boolean
  allowRawRequests: boolean
  allowedHosts: string[]
  dashboardUrl?: string
  warnings: string[]
}

function renderStatus(value: StatusPayload): string {
  const lines = [
    '## 插件状态',
    '',
    `- 版本：${value.version} · defineTool 来源：${value.hostDefineTool}`,
    `- 服务商：${value.providers.length} 个（${value.providers.join(', ')}）`,
    `- 账户：${value.accounts.length} 个 · 已配置密钥 ${value.accounts.filter((a) => a.hasApiKey).length} 个`,
    `- 余额缓存：${value.cacheTtlMs}ms · 自动刷新：${value.autoRefreshMs ? `${value.autoRefreshMs}ms` : '关闭'} · 并发 ${value.concurrency}`,
    `- 请求：超时 ${value.requestTimeoutMs}ms · 重试 ${value.retries} · stream ${value.allowStream ? '开' : '关'} · raw ${value.allowRawRequests ? '开' : '关'}`,
    `- 主机白名单：${value.allowedHosts.join(', ') || '（空）'}`,
  ]
  if (value.dashboardUrl) lines.push(`- 本地看板：${value.dashboardUrl}`)
  if (value.hostDepsNotes.length) lines.push('', '宿主依赖：', ...value.hostDepsNotes.map((n) => `- ${n}`))
  if (value.warnings.length) lines.push('', '配置警告：', ...value.warnings.map((w) => `- ${w}`))
  const missing = value.accounts.filter((a) => !a.hasApiKey)
  if (missing.length) lines.push('', `缺少密钥的账户：${missing.map((a) => a.id).join(', ')}（用 provider_accounts 的 refresh-credentials 重读环境变量）`)
  return lines.join('\n')
}

function toAccountConfig(raw: Record<string, unknown>): AccountConfig {
  const config: AccountConfig = {
    id: String(raw.id ?? ''),
    provider: String(raw.provider ?? ''),
  }
  for (const key of ['label', 'apiKeyEnv', 'apiKey', 'baseUrl', 'balanceBaseUrl', 'defaultModel'] as const) {
    if (typeof raw[key] === 'string') (config as unknown as Record<string, unknown>)[key] = raw[key]
  }
  if (Array.isArray(raw.models)) config.models = raw.models.map(String)
  if (raw.balancePreset) config.balancePreset = raw.balancePreset as BalancePreset
  if (typeof raw.lowBalanceThreshold === 'number') config.lowBalanceThreshold = raw.lowBalanceThreshold
  if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled
  if (typeof raw.manualTotal === 'number' || typeof raw.manualCurrency === 'string') {
    config.manual = {
      total: typeof raw.manualTotal === 'number' ? raw.manualTotal : undefined,
      currency: typeof raw.manualCurrency === 'string' ? raw.manualCurrency : undefined,
    }
  }
  return config
}
