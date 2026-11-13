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
import {
  AUTO_DISCOVER_SPECS,
  runAutoDiscover,
  snapshotOf,
  type AutoDiscoverReport,
  type AutoDiscoverSpec,
  type CredentialSeam,
  type DiscoverySnapshot,
  type DiscoveryState,
} from './autodiscover.ts'
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
  /**
   * 宿主 credentials 接缝（`ctx.get('credentials')` 的结果）。
   * 缺失 = 没有该服务，自动探测静默跳过，其余能力不受影响。
   */
  credentials?: CredentialSeam
}

export interface Console {
  readonly config: ResolvedConfig
  readonly registry: ConsoleRegistry
  readonly balances: BalanceService
  readonly invocation: InvocationService
  readonly dashboard?: DashboardHandle
  /** 自动探测的运行状态；`settled` 在首轮探测（异步）结束后 resolve。 */
  readonly discovery: DiscoveryState
  discoverySnapshot(): DiscoverySnapshot
  /** 手动重跑一轮凭证自动探测（宿主晚提供 credentials 服务时用）。 */
  rediscover(seam?: CredentialSeam): Promise<AutoDiscoverReport>
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

  const discovery: DiscoveryState = {
    enabled: resolved.autoDiscover.enabled,
    pending: resolved.autoDiscover.enabled === true,
    serviceAvailable: options.credentials ? true : null,
    report: null,
    settled: Promise.resolve(null),
  }
  const explicitIds = resolved.accounts.map((account) => account.id)

  const runDiscover = (seam?: CredentialSeam): Promise<AutoDiscoverReport> => {
    const target = seam ?? options.credentials
    const specs = pickDiscoverySpecs(resolved.autoDiscover.providers)
    // 配置里点名了不存在的服务商时给一条 warning，而不是静默少探测几个
    const unknown = resolved.autoDiscover.providers.filter(
      (id) => !AUTO_DISCOVER_SPECS.some((spec) => spec.provider === id),
    )
    discovery.enabled = resolved.autoDiscover.enabled
    discovery.serviceAvailable = target ? true : null
    discovery.pending = true
    // 显式账户只在启动时确定一次；重跑探测不会把上次自动生成的账户算成「显式」，
    // 否则第二次探测会把它们误报成「已存在，跳过」。
    const task = runAutoDiscover({
      seam: target,
      registry,
      enabled: resolved.autoDiscover.enabled,
      explicitIds,
      specs,
      log,
    })
      .then((report) => {
        if (unknown.length) {
          report.warnings.push(`autoDiscoverProviders 里这些服务商没有内置探测声明，已忽略：${unknown.join(', ')}`)
        }
        return report
      })
      .catch((error: unknown): AutoDiscoverReport => {
        // 探测是增强能力：任何意外都收敛成一条 warning，绝不让 createConsole 失败
        log(`凭证自动探测异常: ${(error as Error).message}`)
        return {
          enabled: resolved.autoDiscover.enabled,
          serviceAvailable: target ? true : false,
          discovered: [],
          skipped: [],
          providers: [],
          warnings: [`凭证自动探测异常：${(error as Error).message}`],
          at: Date.now(),
        }
      })
      .then((report) => {
        discovery.report = report
        discovery.pending = false
        discovery.serviceAvailable = report.serviceAvailable
        return report
      })
    discovery.settled = task
    return task
  }

  runDiscover()

  return {
    config: resolved,
    registry,
    balances,
    invocation,
    dashboard,
    discovery,
    discoverySnapshot: () => snapshotOf(discovery),
    rediscover: (seam) => runDiscover(seam),
    refreshBalances: (refreshOptions) => balances.refresh(refreshOptions),
    call: (callOptions) => invocation.call(callOptions),
    models: (accountId, modelOptions) => invocation.models(accountId, modelOptions),
    listAccounts: () => registry.listAccounts(),
    listProviders: () => registry.listProviders(),
    close: async () => {
      await discovery.settled.catch(() => undefined)
      balances.close()
      invocation.close()
      if (dashboard) await dashboard.close()
      registry.dispose()
    },
  }
}

/** 按 `autoDiscoverProviders` 过滤探测表；空配置 = 全部内置服务商。 */
function pickDiscoverySpecs(only: string[]): readonly AutoDiscoverSpec[] | undefined {
  if (!only.length) return undefined
  const wanted = new Set(only)
  return AUTO_DISCOVER_SPECS.filter((spec) => wanted.has(spec.provider))
}

export type { ConsoleConfig, ResolvedConfig } from './types.ts'
