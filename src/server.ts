/**
 * 无宿主入口：不经过 Cordis 也能拿到完整能力。
 *
 * 用途：脚本、单元测试、本地看板、其它 Node 程序。
 * 传 `transport` 即可完全离线跑通（无需真实密钥/网络）。
 */
import { resolveConfig } from './config.ts'
import { HttpClient } from './core/http.ts'
import { ConsoleRegistry } from './core/registry.ts'
import { BalanceService } from './core/balance.ts'
import { InvocationService } from './core/invocation.ts'
import { createDashboard, type DashboardHandle } from './dashboard.ts'
import type {
  BalanceReport,
  CallOptions,
  ConsoleConfig,
  InvocationResult,
  LogFn,
  ModelsResult,
  RefreshOptions,
  ResolvedConfig,
  Transport,
} from './types.ts'

export interface CreateConsoleOptions {
  cwd?: string
  log?: LogFn
  env?: Record<string, string | undefined>
  /** 注入自定义传输层（测试 / 离线演练）。 */
  transport?: Transport
  /** 强制开关看板（覆盖配置）。 */
  dashboard?: boolean
}

export interface Console {
  readonly config: ResolvedConfig
  readonly registry: ConsoleRegistry
  readonly balances: BalanceService
  readonly invocation: InvocationService
  readonly dashboard?: DashboardHandle
  refreshBalances(options?: RefreshOptions): Promise<BalanceReport>
  call(options: CallOptions): Promise<InvocationResult>
  models(accountId: string, options?: { refresh?: boolean }): Promise<ModelsResult>
  listAccounts(): ReturnType<ConsoleRegistry['listAccounts']>
  listProviders(): ReturnType<ConsoleRegistry['listProviders']>
  close(): Promise<void>
}

export function createConsole(config: ConsoleConfig = {}, options: CreateConsoleOptions = {}): Console {
  const cwd = options.cwd ?? process.cwd()
  const log: LogFn = options.log ?? (() => undefined)
  const resolved = resolveConfig(config, cwd)
  for (const warning of resolved.warnings) log(`配置警告: ${warning}`)

  const http = new HttpClient({
    transport: options.transport,
    timeoutMs: resolved.http.timeoutMs,
    retries: resolved.http.retries,
    retryBaseMs: resolved.http.retryBaseMs,
    maxResponseChars: resolved.http.maxResponseChars,
    userAgent: resolved.http.userAgent,
    log,
  })
  const registry = new ConsoleRegistry(resolved, { env: options.env, log })
  const balances = new BalanceService({ registry, http, config: resolved, log })
  const invocation = new InvocationService({ registry, http, config: resolved, log })

  const dashboardEnabled = options.dashboard ?? resolved.dashboard.enabled
  const dashboard = dashboardEnabled
    ? createDashboard({
        registry,
        balances,
        invocation,
        host: resolved.dashboard.host,
        port: resolved.dashboard.port,
        pollMs: resolved.dashboard.pollMs,
        log,
      })
    : undefined

  return {
    config: resolved,
    registry,
    balances,
    invocation,
    dashboard,
    refreshBalances: (refreshOptions) => balances.refresh(refreshOptions),
    call: (callOptions) => invocation.call(callOptions),
    models: (accountId, modelOptions) => invocation.models(accountId, modelOptions),
    listAccounts: () => registry.listAccounts(),
    listProviders: () => registry.listProviders(),
    close: async () => {
      balances.close()
      invocation.close()
      if (dashboard) await dashboard.close()
      registry.dispose()
    },
  }
}

export type { ConsoleConfig, ResolvedConfig } from './types.ts'
