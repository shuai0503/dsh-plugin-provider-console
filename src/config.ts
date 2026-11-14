/**
 * 配置加载与归一化。
 *
 * 归并顺序（与 dsh-plugin-subagent-hub 保持一致）：
 *   内置服务商/预置 → providersDir/*.json → providers 内联 → 账户（accountsDir → accounts 内联）
 * 同 id 后者覆盖前者。单个坏文件只产生 warning，绝不让整条插件加载失败。
 *
 * 注意：目录里的文件必须是**严格 JSON**（不支持注释），否则会被跳过并给出警告。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type {
  AccountConfig,
  ConsoleConfig,
  CustomProviderSpec,
  DashboardConfig,
  ResolvedConfig,
} from './types.ts'
import { clamp, hostOf, ID_PATTERN, originOf } from './core/util.ts'
import { BUILTIN_PROVIDER_SPECS } from './providers/specs.ts'

export function resolveConfig(config: ConsoleConfig = {}, cwd: string = process.cwd()): ResolvedConfig {
  const warnings: string[] = []

  const providerById = new Map<string, CustomProviderSpec>()
  for (const [dir, entries] of readDirs<CustomProviderSpec>(config.providersDir, cwd, warnings, '服务商目录')) {
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
        warnings.push(`跳过 ${dir} 中缺少 id 的服务商声明`)
        continue
      }
      providerById.set(entry.id, entry)
    }
  }
  for (const entry of config.providers ?? []) {
    if (!entry || typeof entry.id !== 'string') {
      warnings.push('跳过一个缺少 id 的内联服务商声明')
      continue
    }
    providerById.set(entry.id, entry)
  }

  const accountById = new Map<string, AccountConfig>()
  for (const [dir, entries] of readDirs<AccountConfig>(config.accountsDir, cwd, warnings, '账户目录')) {
    for (const entry of entries) {
      if (!validAccount(entry, dir, warnings)) continue
      accountById.set(entry.id, entry)
    }
  }
  for (const entry of config.accounts ?? []) {
    if (!validAccount(entry, '内联 accounts', warnings)) continue
    accountById.set(entry.id, entry)
  }

  const accounts: AccountConfig[] = [...accountById.values()].map((entry) => ({
    ...entry,
    label: entry.label ?? entry.id,
    balancePreset: entry.balancePreset ?? 'auto',
    enabled: entry.enabled !== false,
  }))
  const customProviders = [...providerById.values()]

  // 主机白名单 = 显式配置 + 所有账户 URL + 自定义服务商 URL 的 host。
  const hosts = new Set<string>((config.allowedHosts ?? []).map((host) => host.toLowerCase()))
  for (const account of accounts) {
    for (const url of [account.baseUrl, account.balanceBaseUrl]) {
      const host = url ? hostOf(url) : ''
      if (host) hosts.add(host)
    }
    // 账户没显式覆盖 URL 时，把其服务商的默认端点 host 也纳入白名单
    const known = BUILTIN_PROVIDER_SPECS.find((spec) => spec.id === account.provider)
    if (known) {
      hosts.add(hostOf(known.chatBaseUrl))
      hosts.add(hostOf(known.balanceBaseUrl ?? originOf(known.chatBaseUrl)))
    }
  }
  for (const provider of customProviders) {
    for (const url of [provider.chatBaseUrl, provider.balanceBaseUrl]) {
      const host = url ? hostOf(url) : ''
      if (host) hosts.add(host)
    }
  }

  const dashboard: DashboardConfig = {
    // 默认开启：与 client.js 的默认值保持一致（客户端缺省视为开启）。
    // 两端默认值相反时，最小配置下宿主不监听端口、客户端却渲染 iframe，必然白屏。
    enabled: config.dashboard?.enabled !== false,
    host: config.dashboard?.host ?? '127.0.0.1',
    port: clamp(config.dashboard?.port ?? 8788, 1, 65535),
    pollMs: clamp(config.dashboard?.pollMs ?? 5000, 1000, 600_000),
  }

  // 路由前缀会被拼进 provider id，必须是 pi-ai/DSH 都接受的小写连字符标识符；
  // 非法值退回默认而不是让整条插件加载失败。
  const rawPrefix = (config.llmProvider?.routePrefix ?? 'pc').trim()
  const routePrefix = /^[a-z][a-z0-9-]*$/.test(rawPrefix) ? rawPrefix : 'pc'
  if (rawPrefix && routePrefix !== rawPrefix) {
    warnings.push(`llmProvider.routePrefix "${rawPrefix}" 不是小写连字符标识，已退回 "${routePrefix}"`)
  }

  return {
    accounts,
    customProviders,
    warnings,
    includeBuiltinProviders: config.includeBuiltinProviders !== false,
    autoDiscover: {
      enabled: config.autoDiscover !== false,
      providers: (config.autoDiscoverProviders ?? []).filter(
        (id): id is string => typeof id === 'string' && Boolean(id.trim()),
      ),
    },
    http: {
      timeoutMs: clamp(config.requestTimeoutMs ?? 15_000, 1000, 300_000),
      retries: clamp(config.retries ?? 1, 0, 5),
      retryBaseMs: clamp(config.retryBaseMs ?? 250, 50, 5000),
      maxResponseChars: clamp(config.maxResponseChars ?? 200_000, 1024, 5_000_000),
      userAgent: config.userAgent ?? 'dsh-plugin-provider-console/0.1',
    },
    balance: {
      cacheTtlMs: clamp(config.cacheTtlMs ?? 60_000, 0, 86_400_000),
      autoRefreshMs: clamp(config.autoRefreshMs ?? 0, 0, 86_400_000),
      concurrency: clamp(config.concurrency ?? 4, 1, 32),
      lowBalanceThreshold: config.lowBalanceThreshold,
    },
    call: {
      maxOutputChars: clamp(config.maxOutputChars ?? 8_000, 256, 200_000),
      allowStream: config.allowStream === true,
      allowRawRequests: config.allowRawRequests !== false,
      allowedHosts: [...hosts],
      // 默认收紧：回环地址不再自动绕过白名单。
      // 需要调本地服务时，显式设 allowLoopbackTargets: false 且把 host 写进 allowedHosts。
      requireLoopbackAllowlist: config.allowLoopbackTargets !== true,
    },
    dashboard,
    // 与 client.js 的 panelOptions() 默认值一一对应：enabled 缺省 true、order 缺省 20。
    // 两端默认值相反时，用户不写 sidebar 配置会看到「图标存在但面板标签/排序不对」。
    sidebar: {
      enabled: config.sidebar?.enabled !== false,
      label: (config.sidebar?.label ?? '').trim() || '服务商控制台',
      order: clamp(config.sidebar?.order ?? 20, -1_000_000, 1_000_000),
      ...(config.sidebar?.dashboardUrl ? { dashboardUrl: config.sidebar.dashboardUrl } : {}),
    },
    llm: {
      enabled: config.llmProvider?.enabled !== false,
      routePrefix,
      defaultContextWindow: clamp(config.llmProvider?.defaultContextWindow ?? 128_000, 1_024, 10_000_000),
      defaultMaxTokens: clamp(config.llmProvider?.defaultMaxTokens ?? 8_192, 1, 1_000_000),
      streamIdleTimeoutMs: clamp(config.llmProvider?.streamIdleTimeoutMs ?? 300_000, 1_000, 3_600_000),
      discovery: config.llmProvider?.discovery !== false,
    },
  }
}

function validAccount(entry: AccountConfig | undefined, source: string, warnings: string[]): entry is AccountConfig {
  if (!entry || typeof entry !== 'object') {
    warnings.push(`跳过 ${source} 中非对象条目`)
    return false
  }
  if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) {
    warnings.push(`跳过 ${source} 中非法 id：${String(entry.id)}（需匹配 ${ID_PATTERN}）`)
    return false
  }
  if (typeof entry.provider !== 'string' || !entry.provider) {
    warnings.push(`账户 "${entry.id}" 缺少 provider，已跳过`)
    return false
  }
  return true
}

function readDirs<T>(
  input: string | string[] | undefined,
  cwd: string,
  warnings: string[],
  label: string,
): Array<[string, T[]]> {
  if (!input) return []
  const list = Array.isArray(input) ? input : [input]
  const out: Array<[string, T[]]> = []
  for (const dirRaw of list.filter(Boolean)) {
    const dir = isAbsolute(dirRaw) ? dirRaw : resolve(cwd, dirRaw)
    if (!existsSync(dir)) {
      warnings.push(`${label}不存在，已跳过: ${dir}`)
      continue
    }
    let entries: string[]
    try {
      entries = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json')).sort()
    } catch (error) {
      warnings.push(`无法读取${label} ${dir}: ${(error as Error).message}`)
      continue
    }
    const items: T[] = []
    for (const entry of entries) {
      const file = join(dir, entry)
      try {
        if (!statSync(file).isFile()) continue
        // 严格 JSON：带 // 或 # 注释的文件会被跳过，避免整条插件加载失败
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
        items.push(...(Array.isArray(parsed) ? (parsed as T[]) : [parsed as T]))
      } catch (error) {
        warnings.push(`跳过 ${file}: ${(error as Error).message}`)
      }
    }
    out.push([dir, items])
  }
  return out
}
