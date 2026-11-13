/**
 * 云账号签名适配器（审批后接入）。
 *
 * 为什么需要这一层：百炼 / 火山方舟的**主账号余额与用量**属于云账号管控面，
 * 不是「拿一个推理 API Key 就能查」。它们要求 AK/SK 做请求签名 + RAM/IAM 授权。
 * 本文件只提供两件事：
 *   1. 与官方文档一致的签名算法（阿里云 RPC HMAC-SHA1、火山引擎 V4 HMAC-SHA256）；
 *   2. 把它们包装成 ProviderAdapter，插进现有注册中心（registerProvider）。
 *
 * 诚实边界：
 *  - 阿里云 `QueryAccountBalance` 查的是**主账号现金余额**，不等于「百炼专属额度」；
 *  - 火山方舟没有公开的「按 Key 查套餐用量」端点，因此 Action / Version / Service /
 *    响应字段全部由配置显式给出，插件不预设、不猜测、不伪造任何默认值；
 *  - 全部凭据只从环境变量读取，不写盘、不进日志、不进工具输出；
 *  - 本文件**未经真实凭据联网验证**（审批时选择跳过），默认开关为 false。
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type {
  AliyunBssSigningConfig,
  BalancePayload,
  BalanceProbeSpec,
  CloudSigningConfig,
  HttpRequestSpec,
  HttpResponse,
  LogFn,
  ProviderAdapter,
  ProviderSpec,
  ResolvedAccount,
  VolcSigningConfig,
} from '../types.ts'
import { configError } from '../core/errors.ts'
import type { EnvSource } from '../core/util.ts'
import { getMapper } from './mappers.ts'
import type { ConsoleRegistry } from '../core/registry.ts'

// ---------------------------------------------------------------------------
// 通用编码 / 摘要工具
// ---------------------------------------------------------------------------

/** RFC 3986 百分号编码：空格 %20、`~` 不编码、`!'()*` 必须显式转义。 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\+/g, '%20')
}

/** 按 key 字典序生成规范化查询串（两种签名共用）。 */
export function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&')
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

// ---------------------------------------------------------------------------
// 阿里云 RPC 签名（BssOpenApi / QueryAccountBalance）
// ---------------------------------------------------------------------------

export interface AliyunRpcUrlOptions {
  endpoint: string
  accessKeyId: string
  accessKeySecret: string
  action: string
  version: string
  /** 额外业务参数，会一起参与签名。 */
  query?: Record<string, string>
  now?: Date
  nonce?: string
}

export interface AliyunRpcSignResult {
  canonical: string
  stringToSign: string
  signature: string
}

/** Signature = Base64(HMAC-SHA1(secret + "&", "GET&%2F&" + percentEncode(canonical))) */
export function aliyunRpcSignature(
  params: Record<string, string>,
  accessKeySecret: string,
): AliyunRpcSignResult {
  const canonical = canonicalQuery(params)
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonical)}`
  const signature = createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign, 'utf8')
    .digest('base64')
  return { canonical, stringToSign, signature }
}

/** 生成带公共参数与签名的完整 GET URL（签名本身也要 percentEncode）。 */
export function aliyunRpcUrl(options: AliyunRpcUrlOptions): string {
  const date = options.now ?? new Date()
  const timestamp = date.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const params: Record<string, string> = {
    Action: options.action,
    Format: 'JSON',
    Version: options.version,
    AccessKeyId: options.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: options.nonce ?? randomBytes(16).toString('hex'),
    Timestamp: timestamp,
    ...(options.query ?? {}),
  }
  const { canonical, signature } = aliyunRpcSignature(params, options.accessKeySecret)
  const base = options.endpoint.replace(/\/+$/, '')
  return `${base}/?${canonical}&Signature=${percentEncode(signature)}`
}

// ---------------------------------------------------------------------------
// 火山引擎 V4 签名（通用）
// ---------------------------------------------------------------------------

export interface VolcV4SignInput {
  method: string
  host: string
  path?: string
  query: Record<string, string>
  /** 参与签名的自定义头（会自动补齐 host / x-date / x-content-sha256）。 */
  headers?: Record<string, string>
  body?: string
  accessKey: string
  secretKey: string
  region: string
  service: string
  date: Date
  sessionToken?: string
}

export interface VolcV4SignResult {
  authorization: string
  headers: Record<string, string>
  canonicalRequest: string
  stringToSign: string
  credentialScope: string
  signedHeaders: string
  signature: string
}

function xDateFormat(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/**
 * 派生密钥链 kDate → kRegion → kService → kSigning，再对 StringToSign 做 HMAC。
 * 签名结果放在 Authorization 头；请求头里不含任何 SK。
 */
export function volcV4Signature(input: VolcV4SignInput): VolcV4SignResult {
  const method = input.method.toUpperCase()
  const xDate = xDateFormat(input.date)
  const shortDate = xDate.slice(0, 8)
  const body = input.body ?? ''
  const payloadHash = sha256Hex(body)

  const signedHeaderMap: Record<string, string> = {
    host: input.host,
    'x-content-sha256': payloadHash,
    'x-date': xDate,
    ...(input.sessionToken ? { 'x-security-token': input.sessionToken } : {}),
  }
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    signedHeaderMap[key.toLowerCase()] = String(value).trim()
  }

  const headerKeys = Object.keys(signedHeaderMap).sort()
  const canonicalHeaders = headerKeys.map((key) => `${key}:${signedHeaderMap[key]}\n`).join('')
  const signedHeaders = headerKeys.join(';')
  const canonicalUri = input.path || '/'
  const canonicalQueryString = canonicalQuery(input.query)
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const credentialScope = `${shortDate}/${input.region}/${input.service}/request`
  const stringToSign = `HMAC-SHA256\n${xDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`
  const kDate = hmac(input.secretKey, shortDate)
  const kRegion = hmac(kDate, input.region)
  const kService = hmac(kRegion, input.service)
  const kSigning = hmac(kService, 'request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')
  const authorization = `HMAC-SHA256 Credential=${input.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    authorization,
    headers: {
      ...(input.headers ?? {}),
      Authorization: authorization,
      'X-Date': xDate,
      'X-Content-Sha256': payloadHash,
      ...(input.sessionToken ? { 'X-Security-Token': input.sessionToken } : {}),
    },
    canonicalRequest,
    stringToSign,
    credentialScope,
    signedHeaders,
    signature,
  }
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

const ALIYUN_DEFAULTS = {
  providerId: 'aliyun-bss',
  endpoint: 'https://business.aliyuncs.com',
  action: 'QueryAccountBalance',
  version: '2017-12-14',
  secretEnv: 'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
  balanceMap: {
    total: 'Data.AvailableAmount',
    currency: 'Data.Currency',
    breakdown: {
      信用额度: 'Data.CreditAmount',
      网商授信: 'Data.MybankCreditAmount',
    },
  },
} as const

interface AliyunResolved {
  providerId: string
  endpoint: string
  action: string
  version: string
  secretEnv: string
  query?: Record<string, string>
  balanceMap: NonNullable<ProviderSpec['balanceMap']>
}

function resolveAliyun(raw: AliyunBssSigningConfig): AliyunResolved {
  return {
    providerId: raw.providerId ?? ALIYUN_DEFAULTS.providerId,
    endpoint: raw.endpoint ?? ALIYUN_DEFAULTS.endpoint,
    action: raw.action ?? ALIYUN_DEFAULTS.action,
    version: raw.version ?? ALIYUN_DEFAULTS.version,
    secretEnv: raw.accessKeySecretEnv ?? ALIYUN_DEFAULTS.secretEnv,
    query: raw.query,
    balanceMap: raw.balanceMap ?? (ALIYUN_DEFAULTS.balanceMap as unknown as NonNullable<ProviderSpec['balanceMap']>),
  }
}

/** 构造「只查余额」的 ProviderSpec：chat 底座与余额端点同域，不用于推理调用。 */
function signingSpec(options: {
  id: string
  label: string
  endpoint: string
  note: string
  probe: BalanceProbeSpec
  balanceMap?: NonNullable<ProviderSpec['balanceMap']>
  docs?: string
}): ProviderSpec {
  const origin = options.endpoint.replace(/\/+$/, '')
  return {
    id: options.id,
    label: options.label,
    site: 'cn',
    chatBaseUrl: origin,
    chatPath: '/',
    balanceBaseUrl: origin,
    auth: { scheme: 'raw' },
    defaultModels: [],
    balance: options.probe,
    balanceMap: options.balanceMap,
    notes: options.note,
    docs: options.docs,
  }
}

function readSecret(env: EnvSource, name: string | undefined, label: string): string {
  const value = name ? (env[name] ?? '').trim() : ''
  if (!value) {
    throw configError(
      `云账号签名缺少 ${label}：请在环境变量 ${name ?? '(未配置变量名)'} 中设置，然后执行 provider_accounts refresh-credentials。`,
    )
  }
  return value
}

/** 统一走 jsonPath mapper，避免为签名响应再写一套解析逻辑。 */
function parseWithJsonPath(
  response: HttpResponse,
  account: ResolvedAccount,
  spec: ProviderSpec,
  request: HttpRequestSpec,
): BalancePayload {
  const mapper = getMapper('jsonPath')
  if (!mapper) throw configError('jsonPath 映射器未注册，无法解析云账号余额响应')
  return mapper({ response, account, spec, request })
}

export class AliyunBssAdapter implements ProviderAdapter {
  readonly spec: ProviderSpec
  private readonly probe: BalanceProbeSpec
  private readonly settings: AliyunResolved
  private readonly env: EnvSource

  constructor(raw: AliyunBssSigningConfig, env: EnvSource = process.env) {
    this.env = env
    this.settings = resolveAliyun(raw)
    this.probe = {
      kind: 'money',
      method: 'GET',
      mapper: 'jsonPath',
      note: '阿里云主账号现金余额，非百炼专属额度；需要 RAM 授权 bss:DescribeAcccount。',
    }
    this.spec = signingSpec({
      id: this.settings.providerId,
      label: '阿里云百炼 · 主账号余额（BssOpenApi）',
      endpoint: this.settings.endpoint,
      note: '仅用于主账号余额查询；推理调用请另配 dashscope 账户。',
      probe: this.probe,
      balanceMap: this.settings.balanceMap,
      docs: 'https://help.aliyun.com/zh/bss-open-api/developer-reference/api-queryaccountbalance',
    })
  }

  balanceRequests(account: ResolvedAccount): HttpRequestSpec[] {
    const secret = readSecret(this.env, this.settings.secretEnv, 'AccessKeySecret')
    if (!account.apiKey) {
      throw configError(`账户 "${account.id}" 缺少 AccessKeyId（apiKeyEnv 指向 AK 环境变量）`)
    }
    return [
      {
        method: 'GET',
        url: aliyunRpcUrl({
          endpoint: this.settings.endpoint,
          accessKeyId: account.apiKey,
          accessKeySecret: secret,
          action: this.settings.action,
          version: this.settings.version,
          query: this.settings.query,
        }),
        headers: { Accept: 'application/json' },
        purpose: `余额查询 · 阿里云 BssOpenApi · ${this.settings.action}`,
        balanceProbe: this.probe,
      },
    ]
  }

  parseBalance(response: HttpResponse, account: ResolvedAccount, request: HttpRequestSpec): BalancePayload {
    return parseWithJsonPath(response, account, this.spec, request)
  }
}

interface VolcResolved {
  providerId: string
  endpoint: string
  action: string
  version: string
  service: string
  region: string
  accessKeyEnv: string
  secretKeyEnv: string
  sessionTokenEnv?: string
  query?: Record<string, string>
  balanceMap?: NonNullable<ProviderSpec['balanceMap']>
}

function resolveVolc(raw: VolcSigningConfig): VolcResolved {
  for (const field of ['action', 'version', 'service'] as const) {
    if (!raw[field]) {
      throw configError(
        `火山签名适配器缺少 ${field}：官方没有「按 API Key 查方舟套餐用量」的公开端点，必须按账号实际开通的计费 API 显式配置。`,
      )
    }
  }
  return {
    providerId: raw.providerId ?? 'volc-signed',
    endpoint: raw.endpoint ?? 'https://open.volcengineapi.com',
    action: raw.action!,
    version: raw.version!,
    service: raw.service!,
    region: raw.region ?? 'cn-beijing',
    accessKeyEnv: raw.accessKeyEnv ?? 'VOLC_ACCESSKEY',
    secretKeyEnv: raw.secretKeyEnv ?? 'VOLC_SECRETKEY',
    sessionTokenEnv: raw.sessionTokenEnv,
    query: raw.query,
    balanceMap: raw.balanceMap,
  }
}

export class VolcSignedAdapter implements ProviderAdapter {
  readonly spec: ProviderSpec
  private readonly probe: BalanceProbeSpec
  private readonly settings: VolcResolved
  private readonly env: EnvSource

  constructor(raw: VolcSigningConfig, env: EnvSource = process.env) {
    this.env = env
    this.settings = resolveVolc(raw)
    this.probe = {
      kind: 'money',
      method: 'GET',
      mapper: 'jsonPath',
      unreliable: true,
      note: '云账号管控面签名请求；Action/Version/Service 与响应字段均为用户显式配置，未经官方余额端点核实。',
    }
    this.spec = signingSpec({
      id: this.settings.providerId,
      label: '火山引擎 · 签名用量查询',
      endpoint: this.settings.endpoint,
      note: '仅用于签名余额/用量查询；方舟推理调用请另配 volc-ark 账户。',
      probe: this.probe,
      balanceMap: this.settings.balanceMap,
    })
  }

  balanceRequests(account: ResolvedAccount): HttpRequestSpec[] {
    const secret = readSecret(this.env, this.settings.secretKeyEnv, 'SecretKey')
    const accessKey = account.apiKey || (this.env[this.settings.accessKeyEnv] ?? '').trim()
    if (!accessKey) {
      throw configError(
        `账户 "${account.id}" 缺少 AccessKeyId（apiKeyEnv 指向 AK，或设置 ${this.settings.accessKeyEnv}）`,
      )
    }
    const endpoint = new URL(this.settings.endpoint)
    const token = this.settings.sessionTokenEnv
      ? (this.env[this.settings.sessionTokenEnv] ?? '').trim() || undefined
      : undefined
    const signed = volcV4Signature({
      method: 'GET',
      host: endpoint.host,
      path: endpoint.pathname || '/',
      query: {
        Action: this.settings.action,
        Version: this.settings.version,
        ...(this.settings.query ?? {}),
      },
      accessKey,
      secretKey: secret,
      region: this.settings.region,
      service: this.settings.service,
      date: new Date(),
      sessionToken: token,
    })
    return [
      {
        method: 'GET',
        url: `${endpoint.origin}${endpoint.pathname || '/'}?${canonicalQuery({
          Action: this.settings.action,
          Version: this.settings.version,
          ...(this.settings.query ?? {}),
        })}`,
        headers: { Accept: 'application/json', ...signed.headers },
        purpose: `余额查询 · 火山引擎 V4 签名 · ${this.settings.action}`,
        balanceProbe: this.probe,
      },
    ]
  }

  parseBalance(response: HttpResponse, account: ResolvedAccount, request: HttpRequestSpec): BalancePayload {
    return parseWithJsonPath(response, account, this.spec, request)
  }
}

// ---------------------------------------------------------------------------
// 注册入口
// ---------------------------------------------------------------------------

/**
 * 把配置里的云签名适配器注册进注册表。返回 disposer 列表，插件卸载时逆序释放。
 * 总开关关闭时什么都不做 —— 不会因为缺少 AK/SK 而误发请求。
 */
export function registerCloudSigning(
  registry: ConsoleRegistry,
  config: CloudSigningConfig,
  env: EnvSource = process.env,
  log: LogFn = () => undefined,
): Array<() => void> {
  const disposers: Array<() => void> = []
  if (config.enabled !== true) return disposers

  if (config.aliyun && config.aliyun.enabled !== false) {
    try {
      const adapter = new AliyunBssAdapter(config.aliyun, env)
      disposers.push(registry.registerProvider(adapter))
      log(`已注册云签名适配器 ${adapter.spec.id}（凭据仅从环境变量读取）`)
    } catch (error) {
      log(`阿里云签名适配器注册失败: ${(error as Error).message}`)
    }
  }
  if (config.volc && config.volc.enabled !== false) {
    try {
      const adapter = new VolcSignedAdapter(config.volc, env)
      disposers.push(registry.registerProvider(adapter))
      log(`已注册云签名适配器 ${adapter.spec.id}（凭据仅从环境变量读取）`)
    } catch (error) {
      log(`火山签名适配器注册失败: ${(error as Error).message}`)
    }
  }
  return disposers
}
