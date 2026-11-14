/**
 * 公共类型定义 —— 零 DSH / Cordis 运行时依赖。
 *
 * 这一层刻意保持纯 Node 可用：所有核心逻辑都能在 `createConsole()` 下被
 * 单元测试覆盖，不需要 DSH 宿主，也不需要真实密钥或网络。
 */

// ---------------------------------------------------------------------------
// 错误模型
// ---------------------------------------------------------------------------

export type ErrorKind =
  | 'config'
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'network'
  | 'timeout'
  | 'server'
  | 'client'
  | 'parse'
  | 'unsupported'
  | 'aborted'
  | 'internal'

/** 统一、可直接展示给模型/用户的错误；`message` 保证已脱敏。 */
export interface ClassifiedError {
  kind: ErrorKind
  message: string
  /** 可操作的排查建议。 */
  hint: string
  retryable: boolean
  httpStatus?: number
  providerCode?: string
  /** 截断 + 脱敏后的原始响应片段，仅用于诊断。 */
  rawSnippet?: string
}

// ---------------------------------------------------------------------------
// HTTP 抽象
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface HttpRequestSpec {
  method: HttpMethod
  url: string
  headers?: Record<string, string>
  /** 对象会自动 JSON.stringify；字符串原样发送。 */
  body?: unknown
  timeoutMs?: number
  /** 标记用途，仅用于日志与错误提示。 */
  purpose?: string
  /** 余额请求携带的探针声明，供响应映射器读取；普通调用不带。 */
  balanceProbe?: BalanceProbeSpec
}

export interface HttpResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  text: string
  json?: unknown
  requestId?: string
  elapsedMs: number
}

/**
 * 可替换的传输层。默认走全局 fetch；测试与离线演练注入 mock，
 * 因此整套插件可以在「不接触任何真实密钥/网络」的前提下验证。
 */
export type Transport = (request: HttpRequestSpec, signal: AbortSignal) => Promise<HttpResponse>

// ---------------------------------------------------------------------------
// 服务商 / 账户
// ---------------------------------------------------------------------------

export type BalanceKind = 'money' | 'quota' | 'manual' | 'unsupported'

/** 账户级余额策略覆盖：不同账号可能是「按量付费」或「Coding Plan 套餐」。 */
export type BalancePreset = 'auto' | 'quota' | 'money' | 'manual' | 'unsupported'

export interface AuthSpec {
  /** bearer = `Authorization: Bearer <key>`；raw = 裸 key；header = 自定义头。 */
  scheme: 'bearer' | 'raw' | 'header'
  header?: string
  prefix?: string
}

export interface BalanceProbeSpec {
  kind: BalanceKind
  method?: HttpMethod
  /** 绝对 URL；或以 balanceBaseUrl / chatBaseUrl 为基准的路径。 */
  url?: string
  /** 响应映射器名，见 providers/mappers.ts；自定义 provider 用 `jsonPath`。 */
  mapper?: string
  headers?: Record<string, string>
  /** 非官方/历史端点：UI 上显式标注，失败时降级而不报错。 */
  unreliable?: boolean
  note?: string
}

export interface BalanceMapSpec {
  total?: string
  currency?: string
  granted?: string
  toppedUp?: string
  available?: string
  breakdown?: Record<string, string>
  quotas?: string
}

/** 内置或配置声明的服务商规格。 */
export interface ProviderSpec {
  id: string
  label: string
  site: 'cn' | 'global' | 'custom'
  /** OpenAI 兼容 base，例如 https://api.deepseek.com/v1（不带末尾斜杠）。 */
  chatBaseUrl: string
  chatPath: string
  modelsPath?: string
  balanceBaseUrl?: string
  auth: AuthSpec
  defaultModels: string[]
  balance: BalanceProbeSpec
  /** 备用余额探针（按顺序尝试成功为止），用于非官方端点。 */
  balanceFallbacks?: BalanceProbeSpec[]
  /** 可选的配额探针（套餐账号用）。 */
  quotaProbe?: BalanceProbeSpec
  headers?: Record<string, string>
  /** 声明式映射，仅 custom provider 使用。 */
  balanceMap?: BalanceMapSpec
  notes?: string
  docs?: string
}

// ---------------------------------------------------------------------------
// 模型 provider（把账户接进宿主的模型选择器）
// ---------------------------------------------------------------------------

/**
 * 推理档位表：键是档位名（off/low/medium/high/xhigh/max），值是线上拼写。
 * `null` 或 `false` 都表示「这个档位不支持」（pi-ai 用 null，YAML 里写 false
 * 更顺手，两者归一）。
 */
export type ThinkingLevelMap = Record<string, string | null | false>

/**
 * 一个模型在选择器里的能力声明。
 *
 * 只有 `id` 必填；其余字段缺省时由 `LlmProviderConfig` 的默认值补齐，
 * 因为「说不清的能力」比「猜错的能力」更安全：少报会被拒绝在附加之前，
 * 多报则要等到上游 400 之后才会暴露，而那时消息已经落盘。
 */
export interface LlmModelSpec {
  id: string
  /** 选择器里显示的名字；缺省用 id。 */
  name?: string
  contextWindow?: number
  maxTokens?: number
  /**
   * 推理能力。`false`（默认）表示纯对话模型；`true` 表示支持
   * OpenAI 的 reasoning_effort 档位；给对象则作为 pi-ai 的
   * `thinkingLevelMap`（键是档位，值是线上拼写，`null`/`false` = 不支持）。
   */
  reasoning?: boolean | ThinkingLevelMap
  /** pi-ai 的输入模态；缺省 `['text']`。 */
  inputModalities?: string[]
}

/** 账户级的 LLM provider 覆盖；不写则全部用全局默认值。 */
export interface AccountLlmSpec {
  /** false = 这个账户不进模型选择器（余额/工具照常）。 */
  enabled?: boolean
  /** 选择器里显示的提供方名字；缺省用账户 label。 */
  displayName?: string
  /** 覆盖账户级 models 清单；元素可以是 id 或结构化声明。 */
  models?: Array<string | LlmModelSpec>
  /** 账户内所有模型的默认上下文窗口。 */
  contextWindow?: number
  /** 账户内所有模型的默认输出上限。 */
  maxTokens?: number
  /** 账户内所有模型默认的推理能力（见 LlmModelSpec.reasoning）。 */
  reasoning?: boolean | ThinkingLevelMap
  /** 额外请求头；与账户 headers 合并，后者优先。 */
  headers?: Record<string, string>
}

/**
 * 模型 provider 能力开关。
 *
 * 缺省启用：宿主有 `llm` 服务且有可用账户时，账户会自动出现在对话框的
 * 模型选择器里；没有该服务的宿主静默跳过，工具与看板不受影响。
 */
export interface LlmProviderConfig {
  enabled?: boolean
  /** 路由 id 前缀，最终 id 是 `<prefix>-<accountId>`；默认 `pc`。 */
  routePrefix?: string
  /** 未声明 contextWindow 的模型用这个值；默认 128000。 */
  defaultContextWindow?: number
  /** 未声明 maxTokens 的模型用这个值；默认 8192。 */
  defaultMaxTokens?: number
  /** 流空闲上限（毫秒）；默认 300000。 */
  streamIdleTimeoutMs?: number
  /** 是否同时注册 model discovery（配置页「拉取模型」）；默认 true。 */
  discovery?: boolean
}

/** 账户配置（可直接写在 cordis.patch.yml 或 accountsDir/*.json）。 */
export interface AccountConfig {
  id: string
  provider: string
  label?: string
  /** 推荐：从环境变量读取密钥，配置文件里不出现明文。 */
  apiKeyEnv?: string
  /** 也支持 `${ENV_VAR}` 插值或直接字面量；所有输出都会脱敏。 */
  apiKey?: string
  /** 覆盖服务商的 chat base（中转站 / 代理 / 私有部署）。 */
  baseUrl?: string
  /** 覆盖余额探针的 host（默认同 chatBaseUrl 的 origin）。 */
  balanceBaseUrl?: string
  /** 支持 `${ENV_VAR}` 展开的额外请求头。 */
  headers?: Record<string, string>
  defaultModel?: string
  /** `/models` 不可用时的静态模型清单；同时也是模型选择器的候选来源。 */
  models?: string[]
  balancePreset?: BalancePreset
  /** balancePreset=manual 时手工录入的余额。 */
  manual?: { total?: number; currency?: string; note?: string }
  /** 低于该值产生预警；不填继承全局 lowBalanceThreshold。 */
  lowBalanceThreshold?: number
  enabled?: boolean
  timeoutMs?: number
  /** 模型 provider 覆盖；不写则用全局默认值。 */
  llm?: AccountLlmSpec
  metadata?: Record<string, unknown>
}

/** 已解析账户：密钥与 URL 都已就绪，但任何对外输出都必须先 sanitize。 */
export interface ResolvedAccount {
  id: string
  provider: string
  label: string
  apiKey: string
  apiKeySource: string
  chatBaseUrl: string
  balanceBaseUrl: string
  headers: Record<string, string>
  auth: AuthSpec
  defaultModel?: string
  models?: string[]
  balancePreset: BalancePreset
  manual?: { total?: number; currency?: string; note?: string }
  lowBalanceThreshold?: number
  timeoutMs?: number
  metadata?: Record<string, unknown>
}

/** 对外可见的脱敏账户视图。 */
export interface AccountInfo {
  id: string
  provider: string
  label: string
  baseUrl: string
  hasApiKey: boolean
  apiKeySource: string
  headerKeys: string[]
  defaultModel?: string
  balancePreset: BalancePreset
  balanceKind: BalanceKind
  balanceReliable: boolean
  models?: string[]
  notes?: string
  enabled: boolean
  /** true = 该账户由凭证自动探测生成（autoDiscover），非用户显式配置。 */
  discovered?: boolean
}

/**
 * 自动探测生成的账户：密钥值与显式账户的 `apiKeyEnv` 一样只在内存里，
 * 但**不**进入 `AccountConfig` / `ResolvedConfig`，避免配置文件与工具输出带出明文。
 */
export interface DiscoveredAccount {
  id: string
  provider: string
  label: string
  /** 命中的凭证引用名（即环境变量名），用于展示来源。 */
  apiKeyEnv: string
  /** 已解析的密钥值；只允许流向 `ResolvedAccount.apiKey`。 */
  apiKey: string
}

export interface ProviderInfo {
  id: string
  label: string
  site: string
  chatBaseUrl: string
  balanceKind: BalanceKind
  balanceReliable: boolean
  defaultModels: string[]
  notes?: string
  docs?: string
}

/** 第三方插件可实现自定义适配器，完全接管请求构造与响应解析。 */
export interface ProviderAdapter {
  readonly spec: ProviderSpec
  /** 返回候选余额请求（按顺序尝试）；空数组表示无可用余额接口。 */
  balanceRequests(account: ResolvedAccount): HttpRequestSpec[]
  parseBalance(
    response: HttpResponse,
    account: ResolvedAccount,
    request: HttpRequestSpec,
  ): BalancePayload
  parseModels?(response: HttpResponse): string[]
  decorateChatRequest?(
    request: HttpRequestSpec,
    account: ResolvedAccount,
    options: CallOptions,
  ): HttpRequestSpec
}

// ---------------------------------------------------------------------------
// 余额
// ---------------------------------------------------------------------------

export interface QuotaWindow {
  name: string
  used?: number
  limit?: number
  remaining?: number
  usedPercent?: number
  resetAt?: number
  unit?: string
}

/** 映射器的输出：只描述「查到了什么」，元信息由 BalanceService 补齐。 */
export interface BalancePayload {
  currency?: string
  total?: number
  breakdown?: Record<string, number>
  available?: boolean
  quotas?: QuotaWindow[]
  note?: string
  warnings?: string[]
}

export type SnapshotStatus = 'ok' | 'stale' | 'error' | 'unsupported' | 'manual'

export interface BalanceSnapshot {
  accountId: string
  providerId: string
  label: string
  kind: BalanceKind
  status: SnapshotStatus
  currency?: string
  total?: number
  breakdown?: Record<string, number>
  available?: boolean
  quotas?: QuotaWindow[]
  note?: string
  fetchedAt: number
  latencyMs: number
  /** true = 本次刷新的数据来自缓存或上次成功结果，非实时。 */
  stale: boolean
  fromCache: boolean
  attempts: number
  warnings: string[]
  error?: ClassifiedError
}

export interface BalanceReport {
  generatedAt: number
  accounts: BalanceSnapshot[]
  totals: Array<{ currency: string; total: number; accounts: number }>
  warnings: string[]
  counts: { ok: number; stale: number; error: number; unsupported: number; manual: number; cached: number }
}

export interface RefreshOptions {
  accountIds?: string[]
  force?: boolean
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// 通用调用
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  tool_call_id?: string
}

export interface CallOptions {
  accountId: string
  mode?: 'chat' | 'raw'
  /** chat 模式：模型名；缺省用账户 defaultModel 或服务商首个默认模型。 */
  model?: string
  /** chat 模式：完整 messages；与 prompt 二选一。 */
  messages?: ChatMessage[]
  /** chat 模式：快捷写法，等价于单条 user message。 */
  prompt?: string
  /** chat 模式：任意 OpenAI 兼容参数（temperature / max_tokens / top_p / tools …）。 */
  parameters?: Record<string, unknown>
  /** raw 模式：method / path / headers / body。 */
  method?: HttpMethod
  path?: string
  headers?: Record<string, string>
  body?: unknown
  includeRaw?: boolean
  /** 只构造请求、不发网络、不读密钥内容，用于离线验证配置。 */
  dryRun?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

export interface InvocationResult {
  ok: boolean
  dryRun: boolean
  accountId: string
  providerId: string
  model?: string
  httpStatus?: number
  elapsedMs: number
  request?: { method: HttpMethod; url: string; headers: Record<string, string>; body?: unknown }
  content?: string
  reasoningContent?: string
  finishReason?: string
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  raw?: unknown
  truncated?: boolean
  error?: ClassifiedError
  warnings: string[]
}

export interface ModelsResult {
  accountId: string
  providerId: string
  models: string[]
  source: 'live' | 'fallback'
  warnings: string[]
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface CustomProviderSpec extends Partial<ProviderSpec> {
  id: string
  label?: string
  chatBaseUrl?: string
}

export interface DashboardConfig {
  enabled: boolean
  host: string
  port: number
  /** 页面轮询间隔（毫秒）。 */
  pollMs: number
}

/**
 * 左侧栏入口与设置页分区的展示配置。
 *
 * 浏览器半端（client.js）直接读这份原始 config 渲染图标与面板，宿主侧则把它
 * 归一化后放进 ResolvedConfig，两端默认值必须一致 —— 不一致时会出现「图标在
 * 点击后面板是空的」这类不一致状态。默认值见 resolveConfig()。
 */
export interface SidebarConfig {
  /** false = 不注册左侧入口与主面板（设置页分区仍然注册）。 */
  enabled: boolean
  /** 入口显示名；缺省「服务商控制台」。 */
  label: string
  /** 入口与主面板的排序；缺省 20。 */
  order: number
  /** 显式覆盖看板地址（默认由 dashboard.host/port 推导）。 */
  dashboardUrl?: string
}

// ---------------------------------------------------------------------------
// 云账号签名适配器（需要 AK/SK 与 RAM/IAM 授权；默认完全关闭）
// ---------------------------------------------------------------------------

/**
 * 阿里云 BssOpenApi（主账号现金余额）。
 * 只实现官方 RPC 签名与请求构造，凭据一律从环境变量读取、不落盘。
 */
export interface AliyunBssSigningConfig {
  enabled?: boolean
  /** 注册到注册中心的服务商 id；账户的 provider 要用同一个值。 */
  providerId?: string
  /** 账户 apiKeyEnv 指向 AK 变量；这里只声明 SK 的变量名。 */
  accessKeySecretEnv?: string
  endpoint?: string
  action?: string
  version?: string
  /** 额外业务参数，会一起参与签名。 */
  query?: Record<string, string>
  balanceMap?: BalanceMapSpec
}

/**
 * 火山引擎通用 V4 签名适配器。
 * 官方没有「按 API Key 查方舟套餐用量」的公开端点，因此 Action / Version /
 * Service 与响应字段一律由配置显式给出，插件不预设未核实的端点。
 */
export interface VolcSigningConfig {
  enabled?: boolean
  providerId?: string
  accessKeyEnv?: string
  secretKeyEnv?: string
  /** STS 临时凭据的 session token（可选环境变量名）。 */
  sessionTokenEnv?: string
  endpoint?: string
  action?: string
  version?: string
  service?: string
  region?: string
  /** 额外查询参数（Action / Version 由插件自动加入并参与签名）。 */
  query?: Record<string, string>
  balanceMap?: BalanceMapSpec
}

export interface CloudSigningConfig {
  /** 总开关；false 时完全不注册适配器，也不会发出任何签名请求。 */
  enabled?: boolean
  aliyun?: AliyunBssSigningConfig
  volc?: VolcSigningConfig
}

export interface ConsoleConfig {
  /** 内联账户；也可用 accountsDir 从 JSON 文件加载。 */
  accounts?: AccountConfig[]
  accountsDir?: string | string[]
  /** 声明式自定义服务商（JSON 文件同样支持）。 */
  providers?: CustomProviderSpec[]
  providersDir?: string | string[]
  includeBuiltinProviders?: boolean

  /**
   * 从宿主 credentials 服务自动探测已配置的 API Key 并生成账户；默认 true。
   * 显式配置的账户优先，自动账户不会覆盖同名 id。宿主不提供 credentials 服务时
   * 静默跳过，其余能力不受影响。
   */
  autoDiscover?: boolean
  /** 参与自动探测的服务商 id；缺省用内置的 9 个。 */
  autoDiscoverProviders?: string[]

  requestTimeoutMs?: number
  retries?: number
  retryBaseMs?: number
  maxResponseChars?: number
  maxOutputChars?: number
  concurrency?: number

  /** 余额缓存有效期；force 刷新可绕过。0 = 不缓存。 */
  cacheTtlMs?: number
  /** 后台自动刷新周期；0 = 关闭。 */
  autoRefreshMs?: number
  lowBalanceThreshold?: number

  /** 是否允许 stream=true（会把 SSE 聚合为文本返回）。 */
  allowStream?: boolean
  /** 是否允许 raw 模式自定义 path/body。 */
  allowRawRequests?: boolean
  /** raw / 自定义 baseUrl 的主机白名单；默认由账户 URL 自动推导。 */
  allowedHosts?: string[]

  dashboard?: Partial<DashboardConfig>
  /** 左侧栏入口 / 设置页分区。 */
  sidebar?: Partial<SidebarConfig>
  userAgent?: string

  /** 通过 ctx.systemPrompt.section 注入工具使用说明；宿主不支持时静默跳过。 */
  systemPromptSection?: boolean
  /** 覆盖内置提示词段文本（默认取 prompts/system.md 的正文）。 */
  systemPromptText?: string
  /** 段顺序，默认 9000（在第一方固定段之后）。 */
  systemPromptOrder?: number

  /** 云账号签名适配器；默认关闭，开启前必须提供 AK/SK 环境变量。 */
  cloudSigning?: CloudSigningConfig

  /**
   * 模型 provider：把账户接进宿主的模型选择器。
   *
   * 需要宿主提供 `llm` 服务；没有该服务的宿主会静默跳过这一段，
   * 工具/余额/看板全部照常工作。也可以传 `llmProvider: { enabled: false }`
   * 显式关闭。
   */
  llmProvider?: LlmProviderConfig
}

export interface ResolvedConfig {
  accounts: AccountConfig[]
  customProviders: CustomProviderSpec[]
  warnings: string[]
  includeBuiltinProviders: boolean
  autoDiscover: {
    enabled: boolean
    /** 参与探测的服务商 id 白名单；空数组 = 全部内置 9 个。 */
    providers: string[]
  }
  http: {
    timeoutMs: number
    retries: number
    retryBaseMs: number
    maxResponseChars: number
    userAgent: string
  }
  balance: {
    cacheTtlMs: number
    autoRefreshMs: number
    concurrency: number
    lowBalanceThreshold?: number
  }
  call: {
    maxOutputChars: number
    allowStream: boolean
    allowRawRequests: boolean
    allowedHosts: string[]
  }
  dashboard: DashboardConfig
  sidebar: SidebarConfig
  llm: {
    enabled: boolean
    routePrefix: string
    defaultContextWindow: number
    defaultMaxTokens: number
    streamIdleTimeoutMs: number
    discovery: boolean
  }
}

export type LogFn = (message: string, detail?: unknown) => void
