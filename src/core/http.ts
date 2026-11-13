/**
 * 统一 HTTP 客户端。
 *
 * 职责：超时（可取消）、按分类重试与退避、JSON 解析、响应大小上限、
 * 业务错误码归一化、日志脱敏。所有网络细节集中在这里，上层模块永远
 * 只看见 `HttpResponse` 或 `ProviderFailure`。
 *
 * `transport` 可注入：测试、离线演练（--dry-run 的近亲）都能在完全没有
 * 网络和密钥的情况下跑通全链路。
 */
import type { HttpRequestSpec, HttpResponse, LogFn, Transport } from '../types.ts'
import {
  classifyBodyFailure,
  classifyHttpFailure,
  classifyTransportError,
  ProviderFailure,
  redact,
  retryAfterMs,
  truncate,
} from './errors.ts'

export interface HttpClientOptions {
  transport?: Transport
  timeoutMs?: number
  retries?: number
  retryBaseMs?: number
  maxResponseChars?: number
  userAgent?: string
  log?: LogFn
}

interface SendOptions {
  signal?: AbortSignal
  timeoutMs?: number
  retries?: number
  /** 关掉「HTTP 200 但 body 带业务错误码」的检查。 */
  strictBody?: boolean
  purpose?: string
}

const DEFAULT_UA = 'dsh-plugin-provider-console/0.1'

/** 默认传输：浏览器/Node 全局 fetch。 */
export const fetchTransport: Transport = async (request, signal) => {
  const started = Date.now()
  const hasBody = request.body !== undefined && request.method !== 'GET'
  const body = hasBody
    ? typeof request.body === 'string'
      ? request.body
      : JSON.stringify(request.body)
    : undefined

  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal,
  })
  const text = await response.text()
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })
  const requestId =
    headers['x-request-id'] ?? headers['x-ds-trace-id'] ?? headers['x-trace-id'] ?? headers['request-id']
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    headers,
    text,
    json,
    requestId,
    elapsedMs: Date.now() - started,
  }
}

export class HttpClient {
  private readonly transport: Transport
  private readonly defaults: Required<Pick<HttpClientOptions, 'timeoutMs' | 'retries' | 'retryBaseMs' | 'maxResponseChars' | 'userAgent'>>
  private readonly log: LogFn

  constructor(options: HttpClientOptions = {}) {
    this.transport = options.transport ?? fetchTransport
    this.log = options.log ?? (() => undefined)
    this.defaults = {
      timeoutMs: options.timeoutMs ?? 15_000,
      retries: options.retries ?? 1,
      retryBaseMs: options.retryBaseMs ?? 250,
      maxResponseChars: options.maxResponseChars ?? 200_000,
      userAgent: options.userAgent ?? DEFAULT_UA,
    }
  }

  get config(): Readonly<HttpClientOptions> {
    return this.defaults
  }

  async send(request: HttpRequestSpec, options: SendOptions = {}): Promise<HttpResponse> {
    const timeoutMs = Math.max(1, options.timeoutMs ?? request.timeoutMs ?? this.defaults.timeoutMs)
    const retries = Math.max(0, options.retries ?? this.defaults.retries)
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.defaults.userAgent,
      ...(request.body !== undefined && request.method !== 'GET' ? { 'content-type': 'application/json' } : {}),
      ...request.headers,
    }
    const prepared: HttpRequestSpec = { ...request, headers }

    let lastFailure: ClassifiedLike | null = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      // 宿主/调用方的取消信号也要透传
      const external = options.signal
      const onExternalAbort = () => controller.abort()
      if (external) {
        if (external.aborted) controller.abort()
        else external.addEventListener('abort', onExternalAbort, { once: true })
      }

      try {
        const response = await this.transport(prepared, controller.signal)
        this.log(`HTTP ${response.status} ${redact(request.url)} · ${response.elapsedMs}ms${attempt ? ` (retry ${attempt})` : ''}`)

        if (!response.ok) {
          const classified = classifyHttpFailure(response)
          const failure = new ProviderFailure(classified, response)
          if (classified.retryable && attempt < retries) {
            lastFailure = classified
            await this.backoff(attempt, retryAfterMs(response))
            continue
          }
          throw failure
        }

        const limited: HttpResponse = {
          ...response,
          text: truncate(response.text, this.defaults.maxResponseChars),
        }
        if (options.strictBody !== false) {
          const bodyFailure = classifyBodyFailure(limited)
          if (bodyFailure) throw new ProviderFailure(bodyFailure, limited)
        }
        return limited
      } catch (error) {
        if (error instanceof ProviderFailure) throw error
        const externallyAborted = Boolean(external?.aborted && !timedOut)
        const classified = classifyTransportError(error, { timedOut, externallyAborted })
        if (classified.retryable && attempt < retries) {
          lastFailure = classified
          this.log(`重试 ${attempt + 1}/${retries}：${classified.message}`)
          await this.backoff(attempt)
          continue
        }
        throw new ProviderFailure(classified)
      } finally {
        clearTimeout(timer)
        if (external) external.removeEventListener('abort', onExternalAbort)
      }
    }
    // 理论上不可达（循环最后一次必然 return 或 throw）
    throw new ProviderFailure(lastFailure ?? classifyTransportError(new Error('unknown'), { timedOut: false, externallyAborted: false }))
  }

  private async backoff(attempt: number, serverHintMs?: number): Promise<void> {
    const base = this.defaults.retryBaseMs * 2 ** attempt
    const jitter = Math.floor(Math.random() * Math.min(base * 0.3, 200))
    const wait = serverHintMs ?? Math.min(base + jitter, 3000)
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
}

type ClassifiedLike = ProviderFailure['classified']

export { toClassifiedError } from './errors.ts'

/** 构造脱敏后的请求预览（dry-run / 日志 / 错误诊断共用）。 */
export function previewRequest(request: HttpRequestSpec): HttpRequestSpec {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    headers[key] = /authorization|api[-_]?key|token|secret/i.test(key)
      ? '<redacted>'
      : redact(value)
  }
  return {
    method: request.method,
    url: redact(request.url),
    headers,
    body: request.body,
    purpose: request.purpose,
  }
}
