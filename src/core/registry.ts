/**
 * 服务商 / 账户注册中心。
 *
 * 两个扩展面：
 *  - 代码层：registerProvider(adapter) 让其它插件注入全新协议实现；
 *  - 配置层：providersDir/*.json 声明式接入任意 OpenAI 兼容端点。
 *
 * 注册中心同时是**唯一的凭据持有者**：密钥只在 ResolvedAccount 内部，
 * listAccounts() / 工具输出 / 日志都拿不到明文。
 */
import type {
  AccountConfig,
  AccountInfo,
  BalanceKind,
  DiscoveredAccount,
  HttpRequestSpec,
  LogFn,
  ProviderAdapter,
  ProviderInfo,
  ProviderSpec,
  ResolvedAccount,
  ResolvedConfig,
} from '../types.ts'
import { configError, redact } from './errors.ts'
import { expandEnv, expandHeaders, hostOf, ID_PATTERN, originOf, unique } from './util.ts'
import { builtinAdapters, compileCustomProvider, providerUrls, SpecAdapter } from '../providers/index.ts'

export interface RegistryOptions {
  env?: Record<string, string | undefined>
  log?: LogFn
}

export class ConsoleRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>()
  private readonly accounts = new Map<string, ResolvedAccount>()
  private readonly rawAccounts = new Map<string, AccountConfig>()
  private readonly disabled = new Set<string>()
  /**
   * 自动探测生成的账户及其密钥。
   *
   * 密钥刻意**不**写进 AccountConfig：那是会出现在 config / 报告 / 工具参数里的
   * 数据结构。这里只存 ResolvedAccount 需要的最终值，`listAccounts()` 也只读
   * `hasApiKey`，所以自动账户与显式账户对外表现一致，明文不外泄。
   */
  private readonly discovered = new Map<string, DiscoveredAccount>()
  private readonly env: Record<string, string | undefined>
  private readonly log: LogFn

  private readonly config: ResolvedConfig

  constructor(config: ResolvedConfig, options: RegistryOptions = {}) {
    this.config = config
    this.env = options.env ?? process.env
    this.log = options.log ?? (() => undefined)

    if (config.includeBuiltinProviders) {
      for (const adapter of builtinAdapters(this.env)) this.adapters.set(adapter.spec.id, adapter)
    }
    for (const raw of config.customProviders) {
      if (this.adapters.has(raw.id)) continue // 内置已注册，配置层可在下面覆盖
      try {
        const adapter = new SpecAdapter(compileCustomProvider(raw, this.env), this.env)
        this.adapters.set(adapter.spec.id, adapter)
      } catch (error) {
        this.log(`跳过自定义服务商 "${raw.id}": ${(error as Error).message}`)
        config.warnings.push(`自定义服务商 "${raw.id}" 编译失败: ${(error as Error).message}`)
      }
    }
    // 配置里显式声明的同名 spec 优先（例如把 dashscope 的 baseUrl 换成新加坡地域）
    for (const raw of config.customProviders) {
      if (!raw.chatBaseUrl) continue
      try {
        this.adapters.set(raw.id, new SpecAdapter(compileCustomProvider(raw, this.env), this.env))
      } catch {
        /* 上面已经记过 warning */
      }
    }
    for (const raw of config.accounts) {
      try {
        this.registerAccount(raw)
      } catch (error) {
        config.warnings.push(`账户 "${raw.id}" 注册失败: ${(error as Error).message}`)
        this.log(`跳过账户 "${raw.id}": ${(error as Error).message}`)
      }
    }
  }

  // ---- 服务商 ------------------------------------------------------------

  registerProvider(provider: ProviderSpec | ProviderAdapter): () => void {
    const adapter = 'spec' in provider ? provider : new SpecAdapter(provider, this.env)
    const id = adapter.spec.id
    if (!ID_PATTERN.test(id)) throw configError(`非法服务商 id：${id}`)
    const previous = this.adapters.get(id)
    this.adapters.set(id, adapter)
    return () => {
      if (this.adapters.get(id) === adapter) {
        if (previous) this.adapters.set(id, previous)
        else this.adapters.delete(id)
      }
    }
  }

  adapter(id: string): ProviderAdapter {
    const adapter = this.adapters.get(id)
    if (!adapter) throw configError(`未注册的服务商 "${id}"，可用：${this.listProviderIds().join(', ')}`)
    return adapter
  }

  listProviderIds(): string[] {
    return [...this.adapters.keys()].sort()
  }

  listProviders(): ProviderInfo[] {
    return this.listProviderIds().map((id) => {
      const spec = this.adapters.get(id)!.spec
      const probes = [spec.balance, ...(spec.balanceFallbacks ?? [])]
      const usable = probes.find((probe) => probe?.url)
      return {
        id: spec.id,
        label: spec.label,
        site: spec.site,
        chatBaseUrl: spec.chatBaseUrl,
        balanceKind: usable?.kind ?? 'unsupported',
        balanceReliable: !usable?.unreliable,
        defaultModels: spec.defaultModels,
        notes: spec.notes,
        docs: spec.docs,
      }
    })
  }

  // ---- 账户 --------------------------------------------------------------

  registerAccount(raw: AccountConfig): ResolvedAccount {
    if (!raw || typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
      throw configError(`非法账户 id：${String(raw?.id)}`)
    }
    const adapter = this.adapter(raw.provider)
    const resolved = this.resolveAccount(raw, adapter.spec)
    this.accounts.set(raw.id, resolved)
    this.rawAccounts.set(raw.id, { ...raw })
    if (raw.enabled === false) this.disabled.add(raw.id)
    else this.disabled.delete(raw.id)
    if (!resolved.apiKey) {
      this.log(`账户 "${raw.id}" 未取到 API Key（${resolved.apiKeySource}），余额与调用会在执行时报配置错误`)
    }
    return resolved
  }

  unregisterAccount(id: string): boolean {
    this.rawAccounts.delete(id)
    this.disabled.delete(id)
    this.discovered.delete(id)
    return this.accounts.delete(id)
  }

  /** 是否已有该 id 的账户（含已禁用的）。 */
  hasAccount(id: string): boolean {
    return this.accounts.has(id)
  }

  /** 是否注册过该服务商。 */
  hasProvider(id: string): boolean {
    return this.adapters.has(id)
  }

  /** 该账户是否由凭证自动探测生成。 */
  isDiscovered(id: string): boolean {
    return this.discovered.has(id)
  }

  /**
   * 注册一个自动探测到的账户。
   *
   * 与 `registerAccount()` 的差别只有两点：密钥由调用方直接给出（不经过环境变量，
   * 因为值来自 credentials 接缝），以及会记下「这是自动账户」以便状态工具区分。
   *
   * 返回值区分三种情况，好让调用方（重复探测时）如实报告：
   *  - `created` 新建；`updated` 覆盖了**上一次自动探测**的账户；`skipped` 同名账户
   *    是用户显式配置的，一个字节都不写 —— 显式配置永远优先。
   */
  registerDiscoveredAccount(
    raw: Pick<AccountConfig, 'id' | 'provider' | 'label' | 'apiKeyEnv'>,
    apiKey: string,
  ): 'created' | 'updated' | 'skipped' {
    if (!raw || typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
      throw configError(`非法账户 id：${String(raw?.id)}`)
    }
    if (this.accounts.has(raw.id) && !this.discovered.has(raw.id)) {
      this.log(`自动探测：账户 "${raw.id}" 已由用户显式配置，保留原配置`)
      return 'skipped'
    }
    const secret = (apiKey ?? '').trim()
    if (!secret) throw configError(`账户 "${raw.id}" 自动探测到的密钥为空`)
    const adapter = this.adapter(raw.provider)
    const accountConfig: AccountConfig = {
      id: raw.id,
      provider: raw.provider,
      label: raw.label ?? raw.id,
      apiKeyEnv: raw.apiKeyEnv,
    }
    const resolved = this.resolveAccount(accountConfig, adapter.spec)
    // 接缝给出的值优先于环境变量解析结果（同一个变量名可能两处都有）
    const withSecret: ResolvedAccount = {
      ...resolved,
      apiKey: secret,
      apiKeySource: raw.apiKeyEnv ? `credentials:${raw.apiKeyEnv}` : 'credentials',
    }
    const existed = this.discovered.has(raw.id)
    this.accounts.set(raw.id, withSecret)
    this.discovered.set(raw.id, {
      id: raw.id,
      provider: raw.provider,
      label: accountConfig.label ?? raw.id,
      apiKeyEnv: raw.apiKeyEnv ?? '',
      apiKey: secret,
    })
    this.disabled.delete(raw.id)
    return existed ? 'updated' : 'created'
  }

  setAccountEnabled(id: string, enabled: boolean): boolean {
    if (!this.accounts.has(id)) return false
    const raw = this.rawAccounts.get(id)
    if (raw) this.rawAccounts.set(id, { ...raw, enabled })
    if (enabled) this.disabled.delete(id)
    else this.disabled.add(id)
    return true
  }

  /** 环境变量变化后可整体重解析，无需重建插件。 */
  refreshCredentials(): string[] {
    const updated: string[] = []
    for (const [id, raw] of this.rawAccounts) {
      try {
        const adapter = this.adapter(raw.provider)
        this.accounts.set(id, this.resolveAccount(raw, adapter.spec))
        updated.push(id)
      } catch (error) {
        this.log(`刷新凭据失败 ${id}: ${(error as Error).message}`)
      }
    }
    // 自动探测账户不读环境变量（密钥来自 credentials 接缝），原样保留，
    // 但仍算作「已刷新」，否则工具会让人误以为它们被清掉了。
    for (const id of this.discovered.keys()) {
      if (this.accounts.has(id)) updated.push(id)
    }
    return updated
  }

  account(id: string): ResolvedAccount {
    const account = this.accounts.get(id)
    if (!account) throw configError(`未知账户 "${id}"，可用：${this.listAccountIds().join(', ')}`)
    return account
  }

  listAccountIds(): string[] {
    return [...this.accounts.keys()].filter((id) => !this.disabled.has(id)).sort()
  }

  listAccounts(): AccountInfo[] {
    return [...this.accounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, account]) => {
        const spec = this.adapters.get(account.provider)?.spec
        let requests: HttpRequestSpec[] = []
        if (spec) {
          try {
            requests = this.adapters.get(account.provider)!.balanceRequests(account)
          } catch {
            // 适配器可能因缺凭据而拒绝构造请求；账户列表仍要能正常展示
          }
        }
        const probe = (requests[0] as HttpRequestSpec | undefined)?.balanceProbe
        const kind: BalanceKind = probe?.kind ?? (account.balancePreset === 'manual' ? 'manual' : 'unsupported')
        return {
          id,
          provider: account.provider,
          label: account.label,
          baseUrl: redact(account.chatBaseUrl),
          hasApiKey: Boolean(account.apiKey),
          apiKeySource: account.apiKeySource,
          headerKeys: Object.keys(account.headers),
          defaultModel: account.defaultModel,
          balancePreset: account.balancePreset,
          balanceKind: kind,
          balanceReliable: !probe?.unreliable,
          models: account.models ?? spec?.defaultModels,
          notes: spec?.notes,
          enabled: !this.disabled.has(id),
          discovered: this.discovered.has(id) || undefined,
        }
      })
  }

  // ---- 安全 --------------------------------------------------------------

  allowedHosts(): string[] {
    const hosts = [...this.config.call.allowedHosts]
    for (const account of this.accounts.values()) {
      hosts.push(hostOf(account.chatBaseUrl), hostOf(account.balanceBaseUrl))
    }
    for (const adapter of this.adapters.values()) {
      for (const url of providerUrls(adapter.spec)) hosts.push(hostOf(url))
    }
    return unique(hosts.filter(Boolean))
  }

  /** SSRF 防护：raw 模式 / 自定义 path 不得跳出已知主机；非本地一律要求 https。 */
  assertAllowedUrl(url: string): void {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw configError(`非法 URL：${redact(url)}`)
    }
    const host = parsed.hostname.toLowerCase()
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
    if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
      throw configError(`仅允许 https（本地回环可用 http）：${redact(url)}`)
    }
    if (!loopback && !this.allowedHosts().includes(host)) {
      throw configError(
        `目标主机 "${host}" 不在白名单。请在 allowedHosts 中显式添加（当前：${this.allowedHosts().slice(0, 8).join(', ')}）`,
      )
    }
  }

  dispose(): void {
    this.accounts.clear()
    this.rawAccounts.clear()
    this.adapters.clear()
    this.disabled.clear()
    this.discovered.clear()
  }

  private resolveAccount(raw: AccountConfig, spec: ProviderSpec): ResolvedAccount {
    const { value: apiKey, source } = resolveApiKey(raw, this.env)
    const chatBaseUrl = expandEnv(raw.baseUrl ?? spec.chatBaseUrl, this.env).replace(/\/+$/, '')
    const balanceBaseUrl = expandEnv(
      raw.balanceBaseUrl ?? spec.balanceBaseUrl ?? originOf(chatBaseUrl),
      this.env,
    ).replace(/\/+$/, '')
    if (!chatBaseUrl) throw configError(`账户 "${raw.id}" 的 chatBaseUrl 为空`)
    return {
      id: raw.id,
      provider: raw.provider,
      label: raw.label ?? raw.id,
      apiKey,
      apiKeySource: source,
      chatBaseUrl,
      balanceBaseUrl,
      headers: {
        ...expandHeaders(spec.headers, this.env),
        ...expandHeaders(raw.headers, this.env),
      },
      auth: spec.auth,
      defaultModel: raw.defaultModel ?? spec.defaultModels[0],
      models: raw.models ?? spec.defaultModels,
      balancePreset: raw.balancePreset ?? 'auto',
      manual: raw.manual,
      lowBalanceThreshold: raw.lowBalanceThreshold,
      timeoutMs: raw.timeoutMs,
      metadata: raw.metadata,
    }
  }
}

function resolveApiKey(
  raw: AccountConfig,
  env: Record<string, string | undefined>,
): { value: string; source: string } {
  if (raw.apiKeyEnv) {
    return { value: (env[raw.apiKeyEnv] ?? '').trim(), source: `env:${raw.apiKeyEnv}` }
  }
  if (raw.apiKey) {
    const expanded = expandEnv(raw.apiKey, env)
    const inline = expanded === raw.apiKey
    if (!expanded) return { value: '', source: `${redact(raw.apiKey)}（环境变量未设置）` }
    return { value: expanded.trim(), source: inline ? 'inline（建议改用 apiKeyEnv）' : 'env-interpolation' }
  }
  return { value: '', source: '未配置' }
}
