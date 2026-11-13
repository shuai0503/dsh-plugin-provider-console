/**
 * 错误分类与脱敏。
 *
 * 设计原则：
 * 1. 任何错误对象在离开本模块前必须脱敏 —— 请求头/URL/响应体里都可能带密钥；
 * 2. 分类决定「是否重试」：认证、配额、解析、配置错误一律快速失败，
 *    避免重试把额度烧光或把 401 刷成限流；
 * 3. 每条错误都带一条可操作的 hint，模型可直接照着排查。
 */
import type { ClassifiedError, ErrorKind, HttpResponse } from '../types.ts'

const HINTS: Record<ErrorKind, string> = {
  config: '检查 cordis.patch.yml / accounts.json 的字段与环境变量是否齐全。',
  auth: 'API Key 无效、过期或站点不匹配（国内站与国际站 Key 不通用）；确认 apiKeyEnv 指向正确的环境变量。',
  quota: '账户额度不足或已欠费；到服务商控制台充值 / 检查代金券有效期。',
  rate_limit: '触发限流，稍后重试；可降低并发或调大 cacheTtlMs / autoRefreshMs。',
  network: '网络不可达；检查代理、DNS 与防火墙，或稍后重试。',
  timeout: '请求超时；可调大 requestTimeoutMs，或检查服务商状态。',
  server: '服务端错误，通常是临时故障；稍后重试。',
  client: '请求被拒绝（4xx）；核对模型名、参数与账户权限。',
  parse: '响应结构无法解析，可能是端点变更或返回了登录页 HTML；用 provider_request 的 raw 模式看原始响应。',
  unsupported: '该平台不提供「用 API Key 查询余额」的接口；可设 balancePreset=manual 手工录入，或改用配额视图。',
  aborted: '请求被取消。',
  internal: '插件内部错误；查看宿主日志获取细节。',
}

/** 带分类信息的异常，供 HttpClient 向上抛出。 */
export class ProviderFailure extends Error {
  readonly classified: ClassifiedError
  readonly response?: HttpResponse

  constructor(classified: ClassifiedError, response?: HttpResponse) {
    super(classified.message)
    this.name = 'ProviderFailure'
    this.classified = classified
    this.response = response
  }
}

export function makeError(
  kind: ErrorKind,
  message: string,
  extra: Partial<ClassifiedError> = {},
): ClassifiedError {
  return {
    kind,
    message: truncate(redact(message), 400),
    hint: extra.hint ?? HINTS[kind],
    retryable: extra.retryable ?? isRetryable(kind),
    httpStatus: extra.httpStatus,
    providerCode: extra.providerCode,
    rawSnippet: extra.rawSnippet,
  }
}

export function isRetryable(kind: ErrorKind): boolean {
  return kind === 'network' || kind === 'timeout' || kind === 'rate_limit' || kind === 'server'
}

export function configError(message: string): ProviderFailure {
  return new ProviderFailure(makeError('config', message))
}

export function unsupportedError(message: string): ProviderFailure {
  return new ProviderFailure(makeError('unsupported', message))
}

/** 从 HTTP 状态码 + 响应体推断错误分类。 */
export function classifyHttpFailure(response: HttpResponse): ClassifiedError {
  const snippet = safeSnippet(response)
  const body = response.json as Record<string, unknown> | undefined
  const providerCode = extractProviderCode(body)
  const providerMessage = extractProviderMessage(body)

  if (response.status === 401 || response.status === 403) {
    return makeError('auth', providerMessage ?? `鉴权失败 (HTTP ${response.status})`, {
      httpStatus: response.status,
      providerCode,
      rawSnippet: snippet,
    })
  }
  if (response.status === 402 || response.status === 429) {
    const text = `${providerCode} ${providerMessage} ${snippet}`
    // 先排除明确的「限流」措辞，再看是否属于余额/配额耗尽
    const throttled = /rate[_ -]?limit|too many requests|throttl|请求过于频繁|限流/i.test(text)
    const quotaLike =
      response.status === 402 ||
      (!throttled &&
        /insufficient_quota|exceeded_current_quota|quota[_ ]?(exceeded|limit)|balance|arrears|欠费|额度|credit/i.test(
          text,
        ))
    return makeError(quotaLike ? 'quota' : 'rate_limit', providerMessage ?? `HTTP ${response.status}`, {
      httpStatus: response.status,
      providerCode,
      rawSnippet: snippet,
      retryable: !quotaLike,
      hint: quotaLike ? HINTS.quota : HINTS.rate_limit,
    })
  }
  if (response.status >= 500) {
    return makeError('server', providerMessage ?? `服务端错误 (HTTP ${response.status})`, {
      httpStatus: response.status,
      providerCode,
      rawSnippet: snippet,
    })
  }
  return makeError('client', providerMessage ?? `请求被拒绝 (HTTP ${response.status})`, {
    httpStatus: response.status,
    providerCode,
    rawSnippet: snippet,
  })
}

/**
 * 有些平台用 HTTP 200 包业务错误（如 `{code: 1000}`）。
 * 返回 null 表示看起来是正常响应。
 */
export function classifyBodyFailure(response: HttpResponse): ClassifiedError | null {
  const body = response.json
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  const code = record.code
  const message = typeof record.message === 'string' ? record.message : undefined
  const error = record.error

  if (code !== undefined && code !== null) {
    const numeric = typeof code === 'string' ? Number(code) : code
    if (typeof numeric === 'number' && Number.isFinite(numeric)) {
      if (numeric === 0 || numeric === 200 || numeric === 20000) return null
      // 智谱 1000/1001 = 鉴权；Moonshot 非 0 = 业务错误；硅基流动 30014 = 未授权
      if ([1000, 1001, 30014, 1113].includes(numeric)) {
        return makeError('auth', message ?? `业务错误 code=${numeric}`, {
          providerCode: String(numeric),
          rawSnippet: safeSnippet(response),
        })
      }
      if (/quota|balance/i.test(message ?? '')) {
        return makeError('quota', message ?? `业务错误 code=${numeric}`, {
          providerCode: String(numeric),
          rawSnippet: safeSnippet(response),
        })
      }
      return makeError('client', message ?? `业务错误 code=${numeric}`, {
        providerCode: String(numeric),
        rawSnippet: safeSnippet(response),
      })
    }
  }
  if (error && typeof error === 'object') {
    const inner = error as Record<string, unknown>
    const innerCode = typeof inner.code === 'string' ? inner.code : undefined
    const innerMessage = typeof inner.message === 'string' ? inner.message : undefined
    const quotaLike = /quota|insufficient|exceeded|balance/i.test(`${innerCode} ${innerMessage}`)
    return makeError(quotaLike ? 'quota' : 'auth', innerMessage ?? `响应包含 error 字段`, {
      providerCode: innerCode,
      rawSnippet: safeSnippet(response),
      retryable: false,
    })
  }
  return null
}

/** 传输层抛出的异常分类。 */
export function classifyTransportError(
  error: unknown,
  context: { timedOut: boolean; externallyAborted: boolean },
): ClassifiedError {
  if (context.externallyAborted) return makeError('aborted', '请求被外部取消', { retryable: false })
  if (context.timedOut) return makeError('timeout', '请求超时', { retryable: true })

  const err = error as { name?: string; message?: string; code?: string; cause?: { code?: string } }
  const code = err?.code ?? err?.cause?.code ?? ''
  if (err?.name === 'AbortError' || code === 'ABORT_ERR') {
    return makeError('aborted', '请求被中断', { retryable: false })
  }
  const detail = `${err?.name ?? ''} ${err?.message ?? ''} ${code}`
  return makeError('network', `网络请求失败：${truncate(redact(detail), 200)}`, {
    retryable: true,
  })
}

/** 解析响应体（非 JSON 或 HTML 登录页）失败时的分类。 */
export function parseError(message: string, response?: HttpResponse): ProviderFailure {
  return new ProviderFailure(
    makeError('parse', message, {
      rawSnippet: response ? safeSnippet(response) : undefined,
      retryable: false,
    }),
    response,
  )
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk-[A-Za-z0-9_\-.]{6,})/g, 'sk-***'],
  [/\b(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1***'],
  [/("?(?:authorization|api[-_]?key|x-api-key|token)"?\s*[:=]\s*"?)([^\s"',}&]+)/gi, '$1***'],
  [/\b([?&](?:api[-_]?key|token|access_key)=)[^&\s]+/gi, '$1***'],
]

export function redact(input: string): string {
  let out = input
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** 用于诊断的响应片段：截断 + 脱敏，绝不返回完整 body。 */
export function safeSnippet(response: HttpResponse, limit = 240): string {
  return truncate(redact(response.text || ''), limit)
}

export function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/** 把任意值变成「无损 JSON」：丢弃 undefined / NaN / 非有限数。 */
export function lossless<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => lossless(item)) as unknown as T
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue
      if (typeof item === 'number' && !Number.isFinite(item)) continue
      out[key] = lossless(item)
    }
    return out as T
  }
  return value
}

function extractProviderCode(body: Record<string, unknown> | undefined): string | undefined {
  if (!body) return undefined
  const code = body.code ?? (body.error as Record<string, unknown> | undefined)?.code
  return code === undefined || code === null ? undefined : String(code)
}

function extractProviderMessage(body: Record<string, unknown> | undefined): string | undefined {
  if (!body) return undefined
  const direct = body.message ?? body.msg ?? (body.error as Record<string, unknown> | undefined)?.message
  return typeof direct === 'string' ? redact(direct) : undefined
}

/** 把任意异常收敛成可展示的错误对象（工具层用，保证不抛出未处理异常）。 */
export function toClassifiedError(error: unknown): ClassifiedError {
  if (isProviderFailure(error)) return error.classified
  if (error instanceof Error) return classifyTransportError(error, { timedOut: false, externallyAborted: false })
  return classifyTransportError(new Error(String(error)), { timedOut: false, externallyAborted: false })
}

function isProviderFailure(error: unknown): error is ProviderFailure {
  return error instanceof ProviderFailure
}

/** 从响应头里读 Retry-After（秒或 HTTP 日期），并限制上限。 */
export function retryAfterMs(response: HttpResponse, capMs = 5000): number | undefined {
  const raw = response.headers['retry-after']
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, capMs)
  const date = Date.parse(raw)
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), capMs)
  return undefined
}
