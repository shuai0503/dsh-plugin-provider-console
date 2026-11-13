/**
 * 余额聚合服务：多账户并发刷新、TTL 缓存、失败降级、阈值预警、后台定时刷新。
 *
 * 关键设计：
 *  - **账户隔离**：`mapLimit` 限并发，单个账户 401 / 超时 / 端点改版只影响自己那一行；
 *  - **新鲜度可见**：每次结果都带 `stale` / `fromCache` / `fetchedAt`，UI 不会把
 *    三天前的缓存当成实时余额；
 *  - **软失败**：全部探针失败时保留「上次成功」并标 stale，而不是把整张表清空；
 *  - **探针链**：非官方端点按顺序尝试（智谱三个），认证类错误立即停止，不做无谓重试。
 */
import type {
  BalanceReport,
  BalanceSnapshot,
  ClassifiedError,
  HttpRequestSpec,
  LogFn,
  RefreshOptions,
  ResolvedConfig,
} from '../types.ts'
import { makeError, ProviderFailure, toClassifiedError } from './errors.ts'
import type { HttpClient } from './http.ts'
import { mapLimit } from './util.ts'
import type { ConsoleRegistry } from './registry.ts'

export interface BalanceServiceOptions {
  registry: ConsoleRegistry
  http: HttpClient
  config: ResolvedConfig
  log?: LogFn
}

export class BalanceService {
  private readonly cache = new Map<string, BalanceSnapshot>()
  private readonly listeners = new Set<(report: BalanceReport) => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false
  private readonly log: LogFn
  private readonly deps: BalanceServiceOptions

  constructor(deps: BalanceServiceOptions) {
    this.deps = deps
    this.log = deps.log ?? (() => undefined)
    if (deps.config.balance.autoRefreshMs > 0) this.startAutoRefresh()
  }

  onUpdate(listener: (report: BalanceReport) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(report: BalanceReport): void {
    for (const listener of this.listeners) {
      try {
        listener(report)
      } catch (error) {
        this.log(`余额事件订阅者异常: ${(error as Error).message}`)
      }
    }
  }

  /** 只读缓存，不发网络请求。 */
  snapshot(): BalanceReport {
    const accounts = this.deps.registry
      .listAccountIds()
      .map((id) => this.cache.get(id))
      .filter((item): item is BalanceSnapshot => Boolean(item))
      .map((item) => ({ ...item, fromCache: true }))
    return assembleReport(accounts)
  }

  get(accountId: string): BalanceSnapshot | undefined {
    return this.cache.get(accountId)
  }

  /** 主动刷新；不传 accountIds 时刷新全部启用的账户。force=true 绕过 TTL。 */
  async refresh(options: RefreshOptions = {}): Promise<BalanceReport> {
    const ids = options.accountIds?.length
      ? options.accountIds
      : this.deps.registry.listAccountIds()
    const snapshots = await mapLimit(ids, this.deps.config.balance.concurrency, async (id) =>
      this.refreshOne(id, options.force === true, options.signal),
    )
    const report = assembleReport(snapshots)
    this.emit(report)
    return report
  }

  private async refreshOne(id: string, force: boolean, signal?: AbortSignal): Promise<BalanceSnapshot> {
    const started = Date.now()
    const { registry, http, config } = this.deps
    let account
    try {
      account = registry.account(id)
    } catch (error) {
      return errorSnapshot(id, '', id, toClassifiedError(error), started, 0)
    }
    if (!this.deps.registry.listAccountIds().includes(id)) {
      // 被禁用的账户仍然允许显式查询，但给出提示
      this.log(`账户 "${id}" 当前为 disabled，仍按显式请求刷新`)
    }
    const adapter = registry.adapter(account.provider)
    const cached = this.cache.get(id)

    if (!force && cached && cached.status === 'ok' && config.balance.cacheTtlMs > 0) {
      if (Date.now() - cached.fetchedAt < config.balance.cacheTtlMs) {
        return { ...cached, fromCache: true, stale: false, attempts: 0 }
      }
    }

    const warnings: string[] = []
    if (account.balancePreset === 'manual') {
      const manual = account.manual ?? {}
      const snapshot: BalanceSnapshot = {
        accountId: id,
        providerId: account.provider,
        label: account.label,
        kind: 'manual',
        status: 'manual',
        currency: manual.currency ?? 'CNY',
        total: manual.total,
        note: manual.note ?? '手工录入值，非实时查询；请在控制台核对后更新配置。',
        fetchedAt: Date.now(),
        latencyMs: Date.now() - started,
        stale: true,
        fromCache: false,
        attempts: 0,
        warnings: ['手工录入，非实时数据。'],
      }
      this.cache.set(id, snapshot)
      return applyThreshold(snapshot, account.lowBalanceThreshold ?? config.balance.lowBalanceThreshold, warnings)
    }

    // 自定义 / 签名适配器可能在构造请求时抛错（例如缺少 AK/SK）。
    // 这里收敛成单账户的 config 错误，绝不让一个账户拖垮整批刷新。
    let requests: HttpRequestSpec[]
    try {
      requests = adapter.balanceRequests(account)
    } catch (error) {
      const snapshot = errorSnapshot(
        id,
        account.provider,
        account.label,
        toClassifiedError(error),
        started,
        0,
      )
      this.cache.set(id, snapshot)
      return snapshot
    }
    if (requests.length === 0) {
      const note = adapter.spec.balance.note ?? '该平台未提供按 API Key 查询余额的接口。'
      const snapshot: BalanceSnapshot = {
        accountId: id,
        providerId: account.provider,
        label: account.label,
        kind: account.balancePreset === 'unsupported' ? 'unsupported' : (adapter.spec.balance.kind ?? 'unsupported'),
        status: 'unsupported',
        note,
        fetchedAt: Date.now(),
        latencyMs: Date.now() - started,
        stale: false,
        fromCache: false,
        attempts: 0,
        warnings: [`${account.label}：${note}`],
      }
      this.cache.set(id, snapshot)
      return snapshot
    }

    let lastError: ClassifiedError | undefined
    let attempts = 0
    for (const request of requests) {
      attempts++
      try {
        if (!account.apiKey) {
          throw new ProviderFailure(
            makeError('config', `账户 "${id}" 未配置 API Key（${account.apiKeySource}）`, {
              hint: '在环境变量中设置 apiKeyEnv 指向的变量，或在账户配置里提供 apiKey。',
              retryable: false,
            }),
          )
        }
        const response = await http.send(request, { signal, timeoutMs: account.timeoutMs })
        const payload = adapter.parseBalance(response, account, request)
        const probe = (request as HttpRequestSpec).balanceProbe
        const snapshot: BalanceSnapshot = {
          accountId: id,
          providerId: account.provider,
          label: account.label,
          kind: probe?.kind ?? 'money',
          status: 'ok',
          currency: payload.currency,
          total: payload.total,
          breakdown: payload.breakdown,
          available: payload.available,
          quotas: payload.quotas,
          note: payload.note ?? (probe?.unreliable ? '非官方端点，结果仅供参考。' : undefined),
          fetchedAt: Date.now(),
          latencyMs: response.elapsedMs,
          stale: false,
          fromCache: false,
          attempts,
          warnings: payload.warnings ?? [],
        }
        const final = applyThreshold(
          snapshot,
          account.lowBalanceThreshold ?? config.balance.lowBalanceThreshold,
          warnings,
        )
        this.cache.set(id, final)
        return final
      } catch (error) {
        lastError = toClassifiedError(error)
        this.log(`余额刷新失败 ${id} (${request.purpose ?? request.url}): ${lastError.message}`)
        // 认证/取消/配置错误再试其它端点没有意义，直接停
        if (['auth', 'aborted', 'config'].includes(lastError.kind)) break
      }
    }

    // 全部探针失败：保留上次成功结果并标 stale
    if (cached && cached.status === 'ok') {
      const degraded: BalanceSnapshot = {
        ...cached,
        status: 'stale',
        stale: true,
        fromCache: true,
        attempts,
        error: lastError,
        warnings: [`${account.label}：本次刷新失败，显示 ${new Date(cached.fetchedAt).toLocaleString()} 的缓存值。`],
      }
      this.cache.set(id, degraded)
      return degraded
    }
    const failed = errorSnapshot(id, account.provider, account.label, lastError, started, attempts)
    this.cache.set(id, failed)
    return failed
  }

  startAutoRefresh(): void {
    if (this.timer || this.closed || this.deps.config.balance.autoRefreshMs <= 0) return
    this.timer = setInterval(() => {
      void this.refresh({ force: true }).catch((error: unknown) => {
        this.log(`自动刷新异常: ${(error as Error).message}`)
      })
    }, this.deps.config.balance.autoRefreshMs)
    // 不让定时器阻止进程退出
    ;(this.timer as unknown as { unref?: () => void }).unref?.()
    this.log(`余额自动刷新已开启：每 ${this.deps.config.balance.autoRefreshMs}ms`)
  }

  stopAutoRefresh(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  close(): void {
    this.closed = true
    this.stopAutoRefresh()
    this.listeners.clear()
    this.cache.clear()
  }
}

function errorSnapshot(
  id: string,
  providerId: string,
  label: string,
  error: ClassifiedError | undefined,
  started: number,
  attempts: number,
): BalanceSnapshot {
  return {
    accountId: id,
    providerId,
    label,
    kind: 'unsupported',
    status: 'error',
    fetchedAt: Date.now(),
    latencyMs: Date.now() - started,
    stale: false,
    fromCache: false,
    attempts,
    error:
      error ??
      makeError('internal', '余额刷新失败', { retryable: false }),
    warnings: [error ? `${label || id}：${error.message}（${error.hint}）` : `${label || id}：余额刷新失败`],
  }
}

function applyThreshold(
  snapshot: BalanceSnapshot,
  threshold: number | undefined,
  extra: string[],
): BalanceSnapshot {
  const warnings = [...snapshot.warnings, ...extra]
  if (snapshot.available === false) warnings.push(`${snapshot.label}：账户当前不可用（余额不足或欠费）。`)
  if (threshold !== undefined && snapshot.total !== undefined && snapshot.total <= threshold) {
    warnings.push(
      `${snapshot.label}：余额 ${formatMoney(snapshot.total, snapshot.currency)} 低于预警阈值 ${formatMoney(threshold, snapshot.currency)}。`,
    )
  }
  return { ...snapshot, warnings }
}

export function formatMoney(value: number, currency?: string): string {
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : currency ? `${currency} ` : '¥'
  return `${symbol}${value.toFixed(2)}`
}

export function assembleReport(accounts: BalanceSnapshot[]): BalanceReport {
  const totals = new Map<string, { total: number; accounts: number }>()
  for (const item of accounts) {
    if (item.total === undefined) continue
    if (item.kind !== 'money' && item.status !== 'manual') continue
    const currency = item.currency ?? 'CNY'
    const entry = totals.get(currency) ?? { total: 0, accounts: 0 }
    entry.total += item.total
    entry.accounts += 1
    totals.set(currency, entry)
  }
  return {
    generatedAt: Date.now(),
    accounts,
    totals: [...totals.entries()].map(([currency, value]) => ({ currency, ...value })),
    warnings: accounts.flatMap((item) => item.warnings),
    counts: {
      ok: accounts.filter((item) => item.status === 'ok').length,
      stale: accounts.filter((item) => item.status === 'stale').length,
      error: accounts.filter((item) => item.status === 'error').length,
      unsupported: accounts.filter((item) => item.status === 'unsupported').length,
      manual: accounts.filter((item) => item.status === 'manual').length,
      cached: accounts.filter((item) => item.fromCache).length,
    },
  }
}
