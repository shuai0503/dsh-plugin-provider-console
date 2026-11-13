/**
 * Cordis 插件入口。
 *
 * 装配顺序：配置 → 注册中心 → HTTP → 余额服务 → 调用服务 → 工具 → （可选）看板
 * 卸载时按逆序释放：工具 → 事件 → 看板 → 定时器 → 注册中心。
 *
 * 全部宿主接缝都是可选降级：ctx.tools 不存在时仍能通过 ctx.get('providerConsole')
 * 提供编程 API；ctx.logger 缺失时退回 console；defineTool 拿不到时用本地等价实现。
 */
import type {
  AccountConfig,
  BalanceReport,
  CallOptions,
  ConsoleConfig,
  InvocationResult,
  LogFn,
  ModelsResult,
  ProviderAdapter,
  ProviderSpec,
  RefreshOptions,
  ResolvedConfig,
} from './types.ts'
import { createConsole, type Console } from './server.ts'
import { hostDeps, registerTools } from './tools.ts'
import { lossless } from './core/errors.ts'
import { registerMapper } from './providers/index.ts'
import type { BalanceMapper } from './providers/mappers.ts'
import { registerCloudSigning } from './providers/cloud-signing.ts'
import type { DiscoverySnapshot } from './autodiscover.ts'
import { isCredentialSeam, type CredentialSeam } from './autodiscover.ts'
import {
  DEFAULT_PROMPT_SECTION,
  PROMPT_SECTION_NAME,
  PROMPT_SECTION_ORDER,
} from './prompt-section.ts'

export const name = 'provider-console'
export const version = '0.2.2'

/**
 * 只硬依赖 tools；其余宿主能力全部可选。
 *
 * 特别地 `credentials` **不**写进 inject：缺少该服务的宿主会因硬依赖而加载失败，
 * 而我们只把它当作增强能力（用于凭证自动探测），拿不到就静默跳过。
 */
export const inject = ['tools']

export type { ConsoleConfig }

/** 暴露给其它 Cordis 插件的扩展 API。 */
export interface ProviderConsoleApi {
  readonly version: string
  readonly config: ResolvedConfig
  /** 自动探测状态（不含任何密钥值）。 */
  readonly discovery: DiscoverySnapshot
  /** 注入全新协议的服务商实现（可覆盖内置 id）。 */
  registerProvider(provider: ProviderSpec | ProviderAdapter): () => void
  /** 注入自定义余额响应映射器。 */
  registerMapper(name: string, mapper: BalanceMapper): () => void
  registerAccount(account: AccountConfig): void
  unregisterAccount(id: string): boolean
  listAccounts(): ReturnType<Console['listAccounts']>
  listProviders(): ReturnType<Console['listProviders']>
  refreshBalances(options?: RefreshOptions): Promise<BalanceReport>
  call(options: CallOptions): Promise<InvocationResult>
  models(accountId: string, options?: { refresh?: boolean }): Promise<ModelsResult>
  /** 手动重跑一轮凭证自动探测。 */
  rediscover(): Promise<DiscoverySnapshot>
  /** 直接拿底层 Console（脚本/测试用）。 */
  raw(): Console
}

/** 宿主上下文的最小形状；不 import Cordis 类型，避免版本/依赖树耦合。 */
interface Context {
  tools?: { register(tool: unknown): () => void }
  logger?: (name: string) => Record<string, (...args: unknown[]) => void>
  effect?: (cb: () => () => void) => void
  on?: (event: string, cb: () => void) => void
  emit?: (event: string, payload: unknown) => void
  provide?: (name: string) => void
  set?: (name: string, value: unknown) => void
  get?: (name: string) => unknown
  [key: string]: unknown
}

export function apply(ctx: Context, config: ConsoleConfig = {}): void {
  const log = createLogger(ctx)
  // credentials 是**可选**依赖：ctx.get() 拿不到就返回 undefined，
  // 自动探测静默跳过，工具/余额/看板照常工作（见 inject 的说明）。
  const credentials = credentialsOf(ctx, log)
  const consoleInstance = createConsole(config, { log, credentials })
  const { registry, balances, invocation, config: resolved } = consoleInstance

  for (const note of hostDeps.notes) log(`宿主依赖: ${note}`)

  // 审批后接入：云账号签名适配器（总开关默认 false，关闭时绝不会发签名请求）
  const cloudDisposers =
    config.cloudSigning?.enabled === true
      ? registerCloudSigning(registry, config.cloudSigning, process.env, log)
      : []
  if (config.cloudSigning?.enabled !== true) log('云账号签名适配器未启用（cloudSigning.enabled=false）')

  // 审批后接入：通过宿主的 systemPrompt.section 注入工具使用说明（可选降级）
  const detachPromptSection =
    config.systemPromptSection === true ? installPromptSection(ctx, config, log) : null

  log(`已注册 ${registry.listProviderIds().length} 个服务商、${registry.listAccountIds().length} 个账户`)
  if (consoleInstance.dashboard) log(`本地看板：${consoleInstance.dashboard.url}`)

  // 余额变化广播给宿主事件总线（失败不影响插件）
  const offUpdate = balances.onUpdate((report) => {
    try {
      ctx.emit?.('provider-console/balance-updated', lossless(report))
    } catch {
      /* 事件总线不可用 */
    }
  })

  const toolDisposers = ctx.tools
    ? registerTools({ tools: ctx.tools }, {
        registry,
        balances,
        invocation,
        config: resolved,
        version,
        hostDeps: { source: hostDeps.source, notes: hostDeps.notes },
        dashboardUrl: consoleInstance.dashboard?.url,
        discovery: consoleInstance.discovery,
      })
    : []

  const api: ProviderConsoleApi = {
    version,
    config: resolved,
    discovery: consoleInstance.discoverySnapshot(),
    registerProvider: (provider) => registry.registerProvider(provider),
    registerMapper: (mapperName, mapper) => registerMapper(mapperName, mapper),
    registerAccount: (account) => void registry.registerAccount(account),
    unregisterAccount: (id) => registry.unregisterAccount(id),
    listAccounts: () => registry.listAccounts(),
    listProviders: () => registry.listProviders(),
    refreshBalances: (options) => balances.refresh(options),
    call: (options) => invocation.call(options),
    models: (accountId, options) => invocation.models(accountId, options),
    rediscover: async () => {
      await consoleInstance.rediscover(credentials)
      return consoleInstance.discoverySnapshot()
    },
    raw: () => consoleInstance,
  }
  provideService(ctx, 'providerConsole', api)

  const cleanup = () => {
    offUpdate()
    for (const dispose of toolDisposers) {
      try {
        dispose()
      } catch {
        /* 已释放 */
      }
    }
    try {
      detachPromptSection?.()
    } catch {
      /* 已释放 */
    }
    for (const dispose of [...cloudDisposers].reverse()) {
      try {
        dispose()
      } catch {
        /* 已释放 */
      }
    }
    void consoleInstance.close()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  else ctx.on?.('dispose', cleanup)
}

/**
 * DSH 原生 systemPrompt 注入：`ctx.systemPrompt.section({name, order, text})`
 * 返回 Cordis effect disposer。服务可能晚于本插件挂载，故用 `ctx.inject`
 * 等待；宿主完全不提供该服务时静默跳过，不影响工具与看板。
 */
interface SystemPromptService {
  section(input: {
    name: string
    order: number
    text: string
    interpolate?: boolean
  }): unknown
}

function installPromptSection(ctx: Context, config: ConsoleConfig, log: LogFn): () => void {
  let detach: (() => void) | null = null
  const section = {
    name: PROMPT_SECTION_NAME,
    order: Number.isFinite(config.systemPromptOrder)
      ? (config.systemPromptOrder as number)
      : PROMPT_SECTION_ORDER,
    text: config.systemPromptText ?? DEFAULT_PROMPT_SECTION,
    interpolate: false,
  }

  const attach = (scope: Context): void => {
    if (detach) return
    const service = systemPromptOf(scope)
    if (!service) return
    try {
      const disposer = service.section(section)
      detach = typeof disposer === 'function' ? (disposer as () => void) : () => undefined
      log(`已注入系统提示词段 ${PROMPT_SECTION_NAME}（order=${section.order}）`)
    } catch (error) {
      log(`系统提示词段注入失败: ${(error as Error).message}`)
    }
  }

  // 顺序很重要：必须**先**走 ctx.inject()，用 Cordis 的延迟依赖机制等 systemPrompt 就绪。
  // 不能先直接读 ctx.systemPrompt —— 该属性未在静态 inject 里声明，
  // Cordis 的 Proxy getter 会抛 `cannot get property "systemPrompt" without inject`，
  // 即便外面包了 try 也会让这段逻辑永远拿不到服务（且旧版本这异常会冒泡到 apply()，
  // 直接把整个插件打成 failed）。
  const canInject = typeof (ctx as Record<string, unknown>).inject === 'function'
  if (canInject) {
    ;(
      ctx as unknown as {
        inject: (deps: string[], cb: (scope: Context) => unknown) => void
      }
    ).inject(['systemPrompt'], (scope) => {
      attach(scope)
      return () => {
        try {
          detach?.()
        } catch {
          /* 已释放 */
        }
        detach = null
      }
    })
  } else if (systemPromptOf(ctx)) {
    // 没有 ctx.inject（非 Cordis 宿主）时才回退到直接读取。
    attach(ctx)
  } else {
    log('宿主未提供 systemPrompt 服务，跳过提示词注入（其它能力不受影响）')
  }

  return () => {
    try {
      detach?.()
    } catch {
      /* 已释放 */
    }
    detach = null
  }
}

function systemPromptOf(scope: Context): SystemPromptService | undefined {
  // Cordis 的 Proxy get 对未在 inject 声明的属性会直接抛异常
  // （cannot get property "X" without inject / cannot get required service "X" in inactive context），
  // 因此这里必须整体 try 包裹：宿主没有 systemPrompt 服务时应静默返回 undefined，
  // 而不是把异常抛到 apply() 里导致整个插件加载失败。
  try {
    const bag = scope as Record<string, unknown>
    const direct = bag.systemPrompt as SystemPromptService | undefined
    if (direct && typeof direct.section === 'function') return direct
    if (typeof bag.get === 'function') {
      const viaGet = (bag.get as (name: string) => unknown).call(scope, 'systemPrompt') as
        | SystemPromptService
        | undefined
      if (viaGet && typeof viaGet.section === 'function') return viaGet
    }
  } catch {
    // 宿主未提供 systemPrompt 服务：提示词段跳过，插件其余能力不受影响
  }
  return undefined
}

function provideService(ctx: Context, key: string, value: unknown): void {
  try {
    ctx.provide?.(key)
    ctx.set?.(key, value)
  } catch {
    // 服务注册不可用时不阻塞插件主体能力
  }
}

/**
 * 可选地取宿主 credentials 服务。
 *
 * 三条护栏，全部为了「拿不到也不能失败」：
 *  1. 只用 `ctx.get('credentials')` —— 不写进 inject，所以宿主没有该服务时
 *     内核不会在激活阶段因缺依赖而把整个插件打成 failed；
 *  2. `ctx.get` 本身可能抛（Cordis 的 Proxy getter / 上下文未激活），整体 try 包裹；
 *  3. 取到的对象若两个方法都没有，视同不可用，避免把垃圾对象传下去。
 */
function credentialsOf(ctx: Context, log: LogFn): CredentialSeam | undefined {
  try {
    const getter = (ctx as Record<string, unknown>).get
    if (typeof getter !== 'function') {
      log('宿主上下文没有 ctx.get()，跳过凭证自动探测（其余能力不受影响）')
      return undefined
    }
    const service = (getter as (name: string) => unknown).call(ctx, 'credentials')
    if (!isCredentialSeam(service)) {
      log('宿主未提供 credentials 服务，跳过凭证自动探测（其余能力不受影响）')
      return undefined
    }
    return service
  } catch (error) {
    log(`读取 credentials 服务失败，跳过凭证自动探测: ${(error as Error).message}`)
    return undefined
  }
}

function createLogger(ctx: Context): LogFn {
  const factory = ctx.logger
  const logger = typeof factory === 'function' ? factory.call(ctx, name) : undefined
  return (message: string, detail?: unknown) => {
    const line = `[provider-console] ${message}`
    if (logger && typeof logger.info === 'function') {
      logger.info(detail === undefined ? line : `${line} ${safeStringify(detail)}`)
      return
    }
    console.log(line, detail ?? '')
  }
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}
