/**
 * 模型 provider：把 provider-console 的账户接进宿主的模型选择器。
 *
 * ## 为什么是这个形状
 *
 * 宿主 `llm` 服务只认「适配器 + 路由」：`ctx.llm.registerAdapter(routes, adapter)`
 * 决定谁能处理某个 provider 的请求，`registerConfigurableProviders(entries)`
 * 决定配置界面看得到哪些路由。插件想「提供模型」，唯一的正路就是自己装配
 * 一个适配器注册进去 —— 这正是 dsh-connect-workbuddy 在做的事。
 *
 * ## 为什么不自己写协议转换
 *
 * `@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiAdapter` 已经把 OpenAI 兼容 / Responses /
 * Anthropic 三种线上协议的流式、工具调用、usage 计量、replay 状态全部做完了。
 * 我们要提供的只是它需要的**输入**：
 *
 *   - `profiles()`：provider 路由 → 该路由的事实（端点、默认能力、pi-ai Provider）
 *   - `resolveApiKey()`：路由 → 密钥（从注册中心的 ResolvedAccount 取）
 *   - `auth`：pi-ai 自己的凭据生命周期（我们用不到，给一份 inert 实现）
 *
 * 于是本文件只做三件事：把账户翻译成 profile、把 profile 翻译成 pi-ai Provider、
 * 把注册表维护成快照。协议细节一行都不用碰。
 *
 * ## 为什么用 OpenAI 兼容
 *
 * 目标用户里绝大多数是 OpenAI 兼容端点（DeepSeek / Kimi / 硅基流动 / 智谱 /
 * 百炼 / OpenAI / OpenRouter / Groq …）。`openai-completions` 一条协议覆盖它们，
 * 而 pi-ai 的 catalog 不认识的手工路由默认就走这条。
 *
 * ## 可选依赖
 *
 * 本模块**不**在顶层 import 任何宿主包：`apply(ctx)` 里用 `ctx.get('llm')` 拿服务，
 * `lazyLoad()` 里才动态 import `dsh-llm-pi-ai` / `pi-ai`。宿主没有这些包、
 * 或没有 llm 服务时，`registerModelProvider()` 返回 `{ active: false, reason }`，
 * 一条 warning 就结束 —— 绝不抛异常，工具/余额/看板不受影响。
 */

import type {
  AccountInfo,
  AccountLlmSpec,
  LlmModelSpec,
  LlmProviderConfig,
  LogFn,
  ResolvedConfig,
  ThinkingLevelMap,
} from './types.ts'
import type { ConsoleRegistry } from './core/registry.ts'
import type { ResolvedAccount } from './types.ts'

// ---------------------------------------------------------------------------
// 宿主接缝的最小形状（不 import Cordis / DSH 类型，避免版本耦合）
// ---------------------------------------------------------------------------

/** 宿主 llm 服务里我们用到的那一小部分。 */
export interface HostLlmService {
  registerAdapter(routes: string[], adapter: unknown): AdapterHandle
  registerConfigurableProviders?(entries: HostConfigurableProvider[]): AdapterHandle
  registerModelDiscovery?(
    settingsNs: string,
    discover: (request: DiscoveryRequest, signal?: AbortSignal) => Promise<DiscoveryModel[]>,
  ): () => void
  listProviders?(): Array<{ id: string; name: string }>
}

/** `registerAdapter` / `registerConfigurableProviders` 的返回句柄。 */
export interface AdapterHandle {
  (): void
  replace?(routes: string[] | HostConfigurableProvider[]): void
}

/** 配置界面看到的一条可配置 provider。 */
export interface HostConfigurableProvider {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: string[]
  declared: boolean
  defaultBaseURL?: string
  baseURLEnv?: string[]
}

export interface DiscoveryRequest {
  provider?: string
  baseURL?: string
  api?: string
  apiKey?: string
  headers?: Record<string, string>
}

export interface DiscoveryModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: string[]
}

/** pi-ai 的模型描述符（只列我们真的会写的字段）。 */
interface PiModel {
  id: string
  name: string
  api: string
  provider: string
  baseUrl: string
  input: string[]
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  thinkingLevelMap?: Record<string, string | null>
  compat?: Record<string, unknown>
}

/** pi-ai 需要一个 Provider 对象才能 dispatch。 */
interface PiProvider {
  id: string
  name: string
  baseUrl?: string
  auth: Record<string, unknown>
  getModels(): PiModel[]
  stream(model: PiModel, context: unknown, options: unknown): unknown
  streamSimple(model: PiModel, context: unknown, options: unknown): unknown
}

/** `PiAiAdapter` 需要的配置面。 */
interface PiAiAdapterConfig {
  profiles(): Map<string, RouteProfile>
  resolveApiKey(provider: string, profile: RouteProfile): Promise<string | undefined>
  auth: PiAiAuth
  prepareHeaders?(request: unknown, headers: Headers): Headers
}

/** 一条路由在适配器内部的事实包。 */
interface RouteProfile {
  provider: string
  displayName: string
  streamIdleTimeoutMs: number
  retryPolicy?: unknown
  configuredMaxTokens: Map<string, number>
  modelErrors: Map<string, string>
  reasoning?: string
  requestImagePixelBudget: number
  requestImageMaxBytes: number
  maxRequestImageBytes: number
  maxRequestImages: number
  imageOffloadCountQuantum: number
  piProvider?: PiProvider
  catalogError?: string
  headers?: Record<string, string>
}

interface PiAiAuth {
  credentials: {
    read(providerId: string): Promise<undefined>
    list(): Promise<never[]>
    modify(providerId: string, mutate: unknown): Promise<never>
    delete(providerId: string): Promise<void>
  }
  authContext: {
    env(name: string): Promise<undefined>
    fileExists(path: string): Promise<boolean>
  }
}

/** 懒加载出来的宿主模块。 */
interface HostModules {
  PiAiAdapter: new (config: PiAiAdapterConfig) => unknown
  createProvider: (input: {
    id: string
    name: string
    auth: Record<string, unknown>
    models: PiModel[]
    api: unknown
  }) => PiProvider
  openAICompletionsApi: () => unknown
  /**
   * `@deepseek-ai/dsh-llm` 的 LlmError。
   *
   * 必须用它（而不是普通 Error）来抛 MISSING_CREDENTIAL：
   * PiAiAdapter.listModels() 用 `error instanceof LlmError && error.code === ...`
   * 判定「该厂商无凭据」，普通 Error 不会被识别，模型就不会被隐藏。
   */
  LlmError: new (message: string, code: string, options?: unknown) => Error
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** pi-ai 的图片请求预算默认值（与 dsh-llm-pi-ai 保持一致）。 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20 * 1024 * 1024,
  requestImagePixelBudget: 2048 * 2048,
  requestImageMaxBytes: 1024 * 1024,
} as const

/** 模型不单独计价时报告的零成本；我们没有可靠的逐 token 单价来源。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/**
 * 惰性 pi-ai 凭据平面。
 *
 * 我们的路由**只**通过 `resolveApiKey()` 认证（密钥来自 provider-console 的账户），
 * 所以 pi-ai 自己的凭据存储与 ambient 发现必须**什么都别做** —— 否则它会
 * 去翻环境变量、翻凭据文件，凭空造出一个能用的凭证，让「密钥没配」这件事
 * 变得无法诊断。`modify` 明确拒绝，因为写不进去的写入不能报告成功。
 */
const INERT_AUTH: PiAiAuth = {
  credentials: {
    async read() {
      return undefined
    },
    async list() {
      return []
    },
    async modify() {
      throw new Error('provider-console: 这些路由没有 pi-ai 凭据生命周期，请在账户配置里设置 apiKeyEnv')
    },
    async delete() {
      /* 没有可删的东西 */
    },
  },
  authContext: {
    async env() {
      return undefined
    },
    async fileExists() {
      return false
    },
  },
}

/** 与 pi-ai 的 `harnessApiKeyAuth` 等价：把已解析的密钥交给协议层。 */
const HARNESS_API_KEY_AUTH = {
  apiKey: {
    name: 'provider-console account key',
    resolve: ({ credential }: { credential?: { key?: string } }) =>
      Promise.resolve({
        auth: credential?.key === undefined ? {} : { apiKey: credential.key },
        source: 'provider-console',
      }),
  },
}

// ---------------------------------------------------------------------------
// 纯函数：账户 → 路由计划（可单元测试，零宿主依赖）
// ---------------------------------------------------------------------------

export interface RouteModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  inputModalities: string[]
  thinkingLevelMap?: Record<string, string | null>
}

export interface RoutePlan {
  /** pi-ai 路由 id，形如 `pc-deepseek`。 */
  provider: string
  displayName: string
  accountId: string
  baseUrl: string
  models: RouteModel[]
  headers: Record<string, string>
  /** 空 = 没有可用密钥；该路由仍会注册（以便报 MISSING_CREDENTIAL 而不是静默消失）。 */
  hasApiKey: boolean
  /** 装配失败的原因；非空时这条路由不装配 pi-ai Provider。 */
  error?: string
}

/** 模型 provider 的对外状态（脱敏，可安全进工具输出）。 */
export interface ModelProviderStatus {
  active: boolean
  reason?: string
  routes: Array<{
    provider: string
    displayName: string
    accountId: string
    baseUrl: string
    models: Array<{ id: string; name: string; contextWindow: number; maxTokens: number }>
    hasApiKey: boolean
  }>
}

export interface PlanOptions {
  routePrefix: string
  defaultContextWindow: number
  defaultMaxTokens: number
  /** 传入时用它做 routePrefix 之外的第二层过滤（测试用）。 */
  onlyAccountIds?: string[]
}

/**
 * 把注册中心的账户翻译成路由计划。
 *
 * 什么都不做的情况（返回空数组，调用方据此保持休眠）：
 *   - 账户被禁用
 *   - 账户 llm.enabled === false
 *   - 账户既没有 models 也没有 defaultModel（「不知道能跑什么模型」时
 *     不猜 —— 猜错会让选择器里出现一个必然 404 的模型）
 */
export function planRoutes(
  registry: Pick<ConsoleRegistry, 'listAccounts' | 'account'>,
  config: ResolvedConfig,
  options: PlanOptions,
): RoutePlan[] {
  const plans: RoutePlan[] = []
  const only = options.onlyAccountIds ? new Set(options.onlyAccountIds) : undefined
  for (const info of registry.listAccounts()) {
    if (info.enabled === false) continue
    if (only && !only.has(info.id)) continue
    const plan = planOne(registry, info, config, options)
    if (plan) plans.push(plan)
  }
  return plans
}

function planOne(
  registry: Pick<ConsoleRegistry, 'account'>,
  info: AccountInfo,
  config: ResolvedConfig,
  options: PlanOptions,
): RoutePlan | null {
  const llm = llmSpecOf(config, info.id)
  if (llm.enabled === false) return null

  let account: ResolvedAccount
  try {
    account = registry.account(info.id)
  } catch {
    return null
  }

  const rawModels = llm.models ?? account.models ?? (account.defaultModel ? [account.defaultModel] : [])
  const models = normalizeModels(rawModels, {
    defaultContextWindow: llm.contextWindow ?? options.defaultContextWindow,
    defaultMaxTokens: llm.maxTokens ?? options.defaultMaxTokens,
    defaultReasoning: llm.reasoning,
  })
  // 没有模型可公布 → 不注册这条路由。DSH 的 GUI 要求模型出现在目录里才能选中，
  // 注册一条空路由只会让选择器里多一个点不开的分组。
  if (models.length === 0) return null

  return {
    provider: routeIdOf(options.routePrefix, info.id),
    displayName: llm.displayName ?? account.label ?? info.label ?? info.id,
    accountId: info.id,
    baseUrl: account.chatBaseUrl,
    models,
    headers: { ...llm.headers, ...account.headers },
    hasApiKey: Boolean(account.apiKey),
  }
}

/** 账户的 llm 覆盖；来自 config.accounts 里的原始声明。 */
function llmSpecOf(config: ResolvedConfig, accountId: string): AccountLlmSpec {
  const raw = config.accounts.find((entry) => entry.id === accountId)
  return raw?.llm ?? {}
}

/** 路由 id：`<prefix>-<accountId>`，两者都必须是 pi-ai 接受的小写连字符标识。 */
export function routeIdOf(prefix: string, accountId: string): string {
  return `${prefix}-${slug(accountId)}`
}

/** 把任意账户 id 压成小写连字符；`foo_bar.v2` → `foo-bar-v2`。 */
export function slug(value: string): string {
  const lowered = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return lowered || 'account'
}

export interface ModelDefaults {
  defaultContextWindow: number
  defaultMaxTokens: number
  defaultReasoning?: boolean | ThinkingLevelMap
}

/** 把配置里的模型声明（字符串 or 结构化）归一成 RouteModel 列表，按 id 去重。 */
export function normalizeModels(input: Array<string | LlmModelSpec>, defaults: ModelDefaults): RouteModel[] {
  const out: RouteModel[] = []
  const seen = new Set<string>()
  for (const entry of input) {
    const spec: LlmModelSpec = typeof entry === 'string' ? { id: entry } : entry
    const id = typeof spec?.id === 'string' ? spec.id.trim() : ''
    // 空 id 会让适配器抛出 INVALID_CATALOG 并连带整条路由失效，直接丢掉。
    if (!id || seen.has(id)) continue
    seen.add(id)
    const reasoning = spec.reasoning ?? defaults.defaultReasoning
    const model: RouteModel = {
      id,
      name: spec.name?.trim() || id,
      contextWindow: positive(spec.contextWindow) ?? defaults.defaultContextWindow,
      maxTokens: positive(spec.maxTokens) ?? defaults.defaultMaxTokens,
      inputModalities: normalizeModalities(spec.inputModalities),
    }
    const thinkingLevelMap = thinkingMapOf(reasoning)
    if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap
    out.push(model)
  }
  return out
}

/**
 * 推理能力 → pi-ai 的 thinkingLevelMap。
 *
 * `false`/未声明 → 无（模型不支持推理）。
 * `true` → 一份 OpenAI 风格的直通表：档位名就是线上拼写，`off` 映射为
 * `null`（不接受「关」，即省略该字段）。
 * 对象 → 原样采用，但把值为 `false` 的档位归一成 `null`（pi-ai 用 null
 * 表示不支持，用 false 会被当成「支持并发送 false」）。
 */
export function thinkingMapOf(
  reasoning: boolean | ThinkingLevelMap | undefined,
): Record<string, string | null> | undefined {
  if (reasoning === undefined || reasoning === false) return undefined
  if (reasoning === true) {
    return { off: null, low: 'low', medium: 'medium', high: 'high' }
  }
  const out: Record<string, string | null> = {}
  for (const [level, wire] of Object.entries(reasoning)) {
    if (!level) continue
    out[level] = wire === false ? null : wire
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeModalities(input: string[] | undefined): string[] {
  if (!Array.isArray(input)) return ['text']
  const list = input
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  // `[]` 描述的是一个什么都接受不了的模型；退回文本比公布空列表安全。
  return list.length > 0 ? [...new Set(list)] : ['text']
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

// ---------------------------------------------------------------------------
// 纯函数：路由计划 → pi-ai 模型描述符
// ---------------------------------------------------------------------------

/** 一条路由的模型 → pi-ai 描述符；`provider` 必须与路由 id 一致，否则 dispatch 找不到。 */
export function toPiModels(plan: RoutePlan): PiModel[] {
  return plan.models.map((model) => ({
    id: model.id,
    name: model.name,
    api: 'openai-completions',
    provider: plan.provider,
    baseUrl: plan.baseUrl,
    input: [...model.inputModalities],
    cost: { ...NO_COST },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.thinkingLevelMap !== undefined,
    ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
    // supportsReasoningEffort 必须与 reasoning 一致，否则 pi-ai 会在两个地方
    // 对「这个模型能不能带 reasoning_effort」给出相反答案。
    compat: { supportsReasoningEffort: model.thinkingLevelMap !== undefined },
  }))
}

/** 一条路由的 profile（`PiAiAdapter` 内部读的那些字段）。 */
export function toRouteProfile(plan: RoutePlan, options: {
  streamIdleTimeoutMs: number
  makeProvider: (models: PiModel[]) => PiProvider
}): RouteProfile {
  const models = toPiModels(plan)
  const profile: RouteProfile = {
    provider: plan.provider,
    displayName: plan.displayName,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    configuredMaxTokens: new Map(models.map((model) => [model.id, model.maxTokens])),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    maxRequestImages: 50,
    imageOffloadCountQuantum: 10,
    headers: { ...plan.headers },
  }
  if (plan.error !== undefined) {
    // 装配失败的模型逐个记账，而不是整条路由消失：其它模型仍然可选。
    profile.catalogError = plan.error
  } else {
    profile.piProvider = options.makeProvider(models)
  }
  return profile
}

// ---------------------------------------------------------------------------
// 宿主装配
// ---------------------------------------------------------------------------

export interface RegisterModelProviderOptions {
  ctx: Record<string, unknown>
  registry: ConsoleRegistry
  config: ResolvedConfig
  log: LogFn
  /** 注入宿主模块（测试用）；省略则惰性 import。 */
  modules?: HostModules
  /**
   * 覆盖惰性加载（测试用）。
   * 与 `modules` 的区别：这个可以异步，用来模拟「模块晚到」。
   */
  loadModules?: () => Promise<{ modules?: HostModules; reason?: string }>
}

export interface ModelProviderHandle {
  active: boolean
  /** 未激活的原因；激活时为 undefined。 */
  reason?: string
  routes: string[]
  /** 当前路由快照（脱敏，可给工具/测试读）。 */
  plans(): RoutePlan[]
  /** 账户变化后重算路由并原子替换注册。 */
  refresh(): RoutePlan[]
  dispose(): void
}

/**
 * 惰性加载宿主模块；失败返回原因而不是抛异常。
 *
 * 三个包名写在常量里而不是写成字面量 `import('...')`：它们由**宿主运行时**
 * 提供（在 app.asar 内部），不在本插件的 node_modules 里 —— 字面量会让
 * TypeScript 在编译期要求模块存在（TS2307），而运行期宿主其实解析得到。
 */
export async function loadHostModules(): Promise<{ modules?: HostModules; reason?: string }> {
  try {
    const adapterSpecifier: string = '@deepseek-ai/dsh-llm-pi-ai'
    const coreSpecifier: string = '@earendil-works/pi-ai'
    const apiSpecifier: string = '@earendil-works/pi-ai/api/openai-completions.lazy'
    const piAi = (await import(adapterSpecifier)) as unknown as {
      PiAiAdapter?: unknown
    }
    const PiAiAdapter = piAi.PiAiAdapter
    if (typeof PiAiAdapter !== 'function') {
      return { reason: '@deepseek-ai/dsh-llm-pi-ai 没有导出 PiAiAdapter' }
    }
    const core = (await import(coreSpecifier)) as unknown as { createProvider?: unknown }
    if (typeof core.createProvider !== 'function') {
      return { reason: '@earendil-works/pi-ai 没有导出 createProvider' }
    }
    const api = (await import(apiSpecifier)) as unknown as {
      openAICompletionsApi?: unknown
    }
    if (typeof api.openAICompletionsApi !== 'function') {
      return { reason: '@earendil-works/pi-ai/api/openai-completions.lazy 没有导出 openAICompletionsApi' }
    }
    const llmSpecifier: string = '@deepseek-ai/dsh-llm'
    const llm = (await import(llmSpecifier)) as unknown as { LlmError?: unknown }
    const LlmError = llm.LlmError
    if (typeof LlmError !== 'function') {
      return { reason: '@deepseek-ai/dsh-llm 没有导出 LlmError' }
    }
    return {
      modules: {
        PiAiAdapter: PiAiAdapter as HostModules['PiAiAdapter'],
        createProvider: core.createProvider as HostModules['createProvider'],
        openAICompletionsApi: api.openAICompletionsApi as HostModules['openAICompletionsApi'],
        LlmError: LlmError as HostModules['LlmError'],
      },
    }
  } catch (error) {
    return { reason: `无法加载宿主 LLM 包: ${(error as Error).message}` }
  }
}

/**
 * 把账户注册成宿主的模型 provider。
 *
 * 三条护栏，与 `credentialsOf()` 同构 —— 全部为了「做不到也不能失败」：
 *  1. 只用 `ctx.get('llm')`，不写进 inject；
 *  2. `ctx.get` 可能抛（Cordis 的 Proxy getter），整体 try 包裹；
 *  3. 服务形状不对（没有 registerAdapter）视同不可用。
 */
export function registerModelProvider(options: RegisterModelProviderOptions): ModelProviderHandle {
  const { ctx, registry, config, log } = options
  const inactive = (reason: string): ModelProviderHandle => {
    log(`模型 provider 未启用：${reason}（工具/余额/看板不受影响）`)
    return { active: false, reason, routes: [], plans: () => [], refresh: () => [], dispose: () => undefined }
  }

  if (!config.llm.enabled) return inactive('配置里 llmProvider.enabled=false')
  const llm = llmServiceOf(ctx, log)
  if (!llm) return inactive('宿主未提供 llm 服务')

  const planOptions: PlanOptions = {
    routePrefix: config.llm.routePrefix,
    defaultContextWindow: config.llm.defaultContextWindow,
    defaultMaxTokens: config.llm.defaultMaxTokens,
  }
  let plans = planRoutes(registry, config, planOptions)
  if (plans.length === 0) {
    return inactive('没有可公布的账户模型（请在账户里设置 models 或 defaultModel）')
  }

  // ---- 装配适配器（惰性 import；失败就整段降级） ---------------------------
  let modules = options.modules
  let pending: Promise<void> | null = null
  const load = options.loadModules ?? loadHostModules
  const ensureModules = async (): Promise<boolean> => {
    if (modules) return true
    if (!pending) {
      pending = load().then((result) => {
        if (result.modules) modules = result.modules
        else log(`模型 provider 未启用：${result.reason}（工具/余额/看板不受影响）`)
      })
      return pending.then(() => modules !== undefined)
    }
    return pending.then(() => modules !== undefined)
  }

  // 同步注册：先把路由与适配器挂上去（此时若还没拿到模块，注册会失败并被
  // 记录成 reload 待办，而不是让 apply() 变成异步）。
  let adapterDispose: AdapterHandle | null = null
  let directoryDispose: AdapterHandle | null = null
  let discoveryDispose: (() => void) | null = null
  let disposed = false
  let current: unknown = null

  const build = (host: HostModules): unknown => {
    const profiles = new Map<string, RouteProfile>()
    for (const plan of plans) {
      profiles.set(
        plan.provider,
        toRouteProfile(plan, {
          streamIdleTimeoutMs: config.llm.streamIdleTimeoutMs,
          makeProvider: (models) =>
            host.createProvider({
              id: plan.provider,
              name: plan.displayName,
              auth: HARNESS_API_KEY_AUTH as unknown as Record<string, unknown>,
              models,
              api: host.openAICompletionsApi(),
            }),
        }),
      )
    }
    const accountByRoute = new Map(plans.map((plan) => [plan.provider, plan.accountId]))
    return new host.PiAiAdapter({
      profiles: () => profiles,
      // 密钥按请求现取：账户可能在会话中途被解锁/改环境变量。
      //
      // 这里必须「抛 MISSING_CREDENTIAL」而不是返回 undefined：
      // PiAiAdapter.listModels() 只在 resolveApiKey 抛这个 code 时才返回 []，
      // 从而把没有密钥的厂商整组从模型选择器里隐藏。返回 undefined 会被当成
      // 「有值但为空」，模型照常出现在选择器里，选中后才报错 —— 那正是我们
      // 明确不要的体验（用户选了打不开的模型）。
      resolveApiKey: async (provider) => {
        const accountId = accountByRoute.get(provider)
        if (!accountId) {
          throw new host.LlmError(
            `provider-console: 路由 "${provider}" 没有对应账户`,
            'MISSING_CREDENTIAL',
          )
        }
        const account = registry.account(accountId)
        if (!account?.apiKey) {
          throw new host.LlmError(
            `provider-console: 账户 "${accountId}" 未配置 API Key（${account?.apiKeySource ?? '未配置'}）`,
            'MISSING_CREDENTIAL',
          )
        }
        return account.apiKey
      },
      auth: INERT_AUTH,
    })
  }

  const routesOf = (): string[] => plans.map((plan) => plan.provider)

  const directoryEntries = (): HostConfigurableProvider[] =>
    plans.map((plan) => ({
      provider: plan.provider,
      displayName: plan.displayName,
      settingsNs: 'provider-console',
      // 我们的账户不是 settings 文档里的一个字典项（取值在注册中心，来自
      // cordis.patch.yml 的 accounts）；空路径 = 没有可编辑的配置行可绑。
      settingsPath: [],
      // declared 的宿主语义是「pi-ai 的已装 catalog 不认识这条路由」
      // （llm-pi-ai 自己算的就是 `declared: installed === undefined`）。
      // 我们的 pc-* 路由**全部**是手工声明的，所以必须是 true —— 传 false 会
      // 让设置页把它当「收窄的目录路由」，去找一份并不存在的 catalog 默认值。
      // （dsh-connect-workbuddy 传的 false 与这条语义相反，不要照抄。）
      declared: true,
      ...(plan.baseUrl ? { defaultBaseURL: plan.baseUrl } : {}),
    }))

  const install = (host: HostModules): boolean => {
    try {
      current = build(host)
      adapterDispose = llm.registerAdapter(routesOf(), current)
    } catch (error) {
      log(`模型 provider 注册失败：${(error as Error).message}`)
      return false
    }
    // 目录（设置 → 模型页）与发现能力都跟随 discovery 开关；两者都失败也
    // 不影响已经注册成功的路由 —— 选择器能看到模型才是主目标。
    if (config.llm.discovery) {
      directoryDispose = registerDirectory(llm)
      if (typeof llm.registerModelDiscovery === 'function') {
        // 命名空间必须是我们自己的：llm-pi-ai 已经占了它自己的那个，
        // 同一 ns 注册第二个会 DUPLICATE_DISCOVERY。
        try {
          discoveryDispose = llm.registerModelDiscovery('provider-console', async (request) => {
            // 只回答我们自己的路由；别人的路由不该由我们冒充。
            const plan = plans.find((entry) => entry.provider === request.provider)
            if (!plan) return []
            return plan.models.map((model) => ({
              id: model.id,
              name: model.name,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              inputModalities: [...model.inputModalities],
            }))
          })
        } catch (error) {
          log(`模型发现注册失败（选择器不受影响）：${(error as Error).message}`)
          discoveryDispose = null
        }
      }
    }
    log(`已注册 ${routesOf().length} 条模型路由：${routesOf().join(', ')}`)
    return true
  }

  // 模块已就绪（测试注入）则同步装上；否则异步补齐。
  if (modules) install(modules)
  else {
    void ensureModules().then((ready) => {
      if (disposed || !ready || !modules) return
      install(modules)
    })
  }

  return {
    active: true,
    routes: routesOf(),
    plans: () => plans,
    refresh: () => {
      if (disposed) return []
      const previous = plans
      plans = planRoutes(registry, config, planOptions)
      if (!modules) return plans
      const routes = routesOf()
      // 宿主不允许「注册 0 条路由」（registerAdapter 会抛 INVALID_ADAPTER，
      // replace 复用同一套校验）。没有路由时唯一正确的动作是整段撤掉。
      if (routes.length === 0) {
        releaseAll()
        return plans
      }
      try {
        // 关键：**先** build 再 replace —— PiAiAdapter 的 profiles 是每次
        // dispatch 现读的闭包，替换路由时必须让它看到新快照，否则选择器里
        // 会出现一条指向旧账户的旧路由。
        current = build(modules)
        if (adapterDispose?.replace) {
          adapterDispose.replace(routes)
          if (directoryDispose?.replace) directoryDispose.replace(directoryEntries())
          else directoryDispose = registerDirectory(llm)
        } else {
          // 旧宿主没有 replace：拆掉重建。失败时退回上一份计划，不留半截状态。
          releaseAll()
          install(modules)
        }
      } catch (error) {
        plans = previous
        log(`模型 provider 刷新失败（保留旧路由）：${(error as Error).message}`)
      }
      return plans
    },
    dispose: () => {
      disposed = true
      releaseAll()
    },
  }

  /** 释放三件套；可重复调用。 */
  function releaseAll(): void {
    for (const release of [discoveryDispose, directoryDispose, adapterDispose]) {
      try {
        release?.()
      } catch {
        /* 已释放 */
      }
    }
    discoveryDispose = null
    directoryDispose = null
    adapterDispose = null
  }

  /** 单独注册可配置目录；失败只记日志（目录冲突不该打掉已成功的路由）。 */
  function registerDirectory(host: HostLlmService): AdapterHandle | null {
    if (typeof host.registerConfigurableProviders !== 'function') return null
    try {
      return host.registerConfigurableProviders(directoryEntries())
    } catch (error) {
      log(`模型 provider 目录注册失败（路由仍可用）：${(error as Error).message}`)
      return null
    }
  }
}

/**
 * 可选地取宿主 llm 服务。
 *
 * Cordis 的 Proxy get 对未在 inject 声明的属性会直接抛
 * （`cannot get property "llm" without inject`），而 `ctx.llm` 正是这种属性 ——
 * 所以这里**只**用 `ctx.get('llm')`，且整体 try 包裹。
 */
export function llmServiceOf(ctx: Record<string, unknown>, log: LogFn): HostLlmService | undefined {
  try {
    const getter = ctx.get
    if (typeof getter !== 'function') {
      log('宿主上下文没有 ctx.get()，跳过模型 provider（其余能力不受影响）')
      return undefined
    }
    const service = (getter as (name: string) => unknown).call(ctx, 'llm')
    return isLlmService(service) ? service : undefined
  } catch (error) {
    log(`读取 llm 服务失败，跳过模型 provider: ${(error as Error).message}`)
    return undefined
  }
}

export function isLlmService(value: unknown): value is HostLlmService {
  if (!value || typeof value !== 'object') return false
  return typeof (value as { registerAdapter?: unknown }).registerAdapter === 'function'
}

/** 把句柄翻成脱敏的对外状态。 */
export function statusOf(handle: ModelProviderHandle): ModelProviderStatus {
  const plans = handle.plans()
  return {
    active: handle.active,
    ...(handle.reason === undefined ? {} : { reason: handle.reason }),
    routes: plans.map((plan) => ({
      provider: plan.provider,
      displayName: plan.displayName,
      accountId: plan.accountId,
      baseUrl: plan.baseUrl,
      models: plan.models.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
      hasApiKey: plan.hasApiKey,
    })),
  }
}

export type { LlmProviderConfig }
