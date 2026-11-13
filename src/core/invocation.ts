/**
 * 通用 API 调用入口。
 *
 * 两种模式：
 *  - `chat`：构造 OpenAI 兼容的 chat/completions 请求，任意服务商 / 模型 / 参数；
 *  - `raw` ：任意 method + path + body，用于 /models、embeddings、平台专有接口。
 *
 * 三条护栏：
 *  1. `dryRun` 只构造不发送，输出里的 Authorization 一律 <redacted>，
 *     可在完全没有密钥/网络的情况下验证配置；
 *  2. 主机白名单 + 强制 https（本地回环除外），防止 raw 模式变成 SSRF 入口；
 *  3. 结果统一截断并走 lossless()，保证宿主工具输出校验通过、不会撑爆上下文。
 */
import type {
  CallOptions,
  ChatMessage,
  ClassifiedError,
  HttpRequestSpec,
  HttpResponse,
  InvocationResult,
  LogFn,
  ModelsResult,
  ResolvedConfig,
} from '../types.ts'
import { makeError, ProviderFailure, redact, toClassifiedError, truncate } from './errors.ts'
import { previewRequest, type HttpClient } from './http.ts'
import { joinUrl } from './util.ts'
import type { ConsoleRegistry } from './registry.ts'
import { authHeaders, parseModelList } from '../providers/index.ts'

export interface InvocationServiceOptions {
  registry: ConsoleRegistry
  http: HttpClient
  config: ResolvedConfig
  log?: LogFn
}

interface ModelCacheEntry {
  models: string[]
  at: number
}

export class InvocationService {
  private readonly modelCache = new Map<string, ModelCacheEntry>()
  private readonly log: LogFn
  private readonly deps: InvocationServiceOptions

  constructor(deps: InvocationServiceOptions) {
    this.deps = deps
    this.log = deps.log ?? (() => undefined)
  }

  async call(options: CallOptions): Promise<InvocationResult> {
    const started = Date.now()
    const { registry, http, config } = this.deps
    const base: InvocationResult = {
      ok: false,
      dryRun: options.dryRun === true,
      accountId: options.accountId,
      providerId: '',
      model: options.model,
      elapsedMs: 0,
      warnings: [],
    }
    try {
      const account = registry.account(options.accountId)
      const adapter = registry.adapter(account.provider)
      const spec = adapter.spec
      base.providerId = account.provider

      if (!account.apiKey && !options.dryRun) {
        throw new ProviderFailure(
          makeError('config', `账户 "${account.id}" 未配置 API Key（${account.apiKeySource}）`, {
            hint: '设置 apiKeyEnv 指向的环境变量；dry-run 模式无需密钥即可验证配置。',
            retryable: false,
          }),
        )
      }

      const mode = options.mode ?? 'chat'
      let request: HttpRequestSpec
      if (mode === 'raw') {
        if (!config.call.allowRawRequests) {
          throw new ProviderFailure(makeError('config', 'raw 模式已被 allowRawRequests=false 禁用', { retryable: false }))
        }
        const target = options.path ?? '/'
        const url = /^https?:\/\//i.test(target) ? target : joinUrl(account.chatBaseUrl, target)
        request = {
          method: options.method ?? 'GET',
          url,
          headers: { ...authHeaders(account), ...account.headers, ...options.headers },
          body: options.body,
          purpose: `通用 raw 调用 · ${spec.label}`,
        }
      } else {
        const model = options.model ?? account.defaultModel ?? account.models?.[0]
        if (!model) {
          throw new ProviderFailure(
            makeError('config', `账户 "${account.id}" 未指定模型，且服务商没有默认模型`, {
              hint: '在调用里传 model，或在账户配置里设 defaultModel / models。',
              retryable: false,
            }),
          )
        }
        const messages = normalizeMessages(options)
        const parameters = options.parameters ?? {}
        if (parameters.stream === true && !config.call.allowStream) {
          throw new ProviderFailure(
            makeError('config', 'stream=true 需要把 allowStream 设为 true', {
              hint: '在插件配置里设 allowStream=true；流式响应会被聚合成一段文本返回。不需要流式时请去掉 stream 参数。',
              retryable: false,
            }),
          )
        }
        const body = { ...parameters, model, messages }
        assertBodySize(body, config.http.maxResponseChars)
        request = {
          method: 'POST',
          url: joinUrl(account.chatBaseUrl, spec.chatPath),
          headers: { ...authHeaders(account), ...account.headers, ...options.headers },
          body,
          purpose: `chat/completions · ${spec.label} · ${model}`,
        }
        if (adapter.decorateChatRequest) request = adapter.decorateChatRequest(request, account, options)
        base.model = model
      }

      registry.assertAllowedUrl(request.url)
      const preview = previewRequest(request) as {
        method: HttpRequestSpec['method']
        url: string
        headers: Record<string, string>
        body?: unknown
      }

      if (options.dryRun) {
        return {
          ...base,
          ok: true,
          elapsedMs: Date.now() - started,
          request: preview,
          warnings: ['dry-run：仅构造请求，未发送网络数据；Authorization 已脱敏。'],
          content: JSON.stringify(preview.body ?? null),
        }
      }

      const response = await http.send(request, {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? account.timeoutMs,
        strictBody: !(request.body as Record<string, unknown> | undefined)?.stream,
      })
      return this.toResult(base, response, request, started, options, Boolean((request.body as Record<string, unknown> | undefined)?.stream))
    } catch (error) {
      return {
        ...base,
        ok: false,
        elapsedMs: Date.now() - started,
        error: toClassifiedError(error),
        warnings: [],
      }
    }
  }

  private toResult(
    base: InvocationResult,
    response: HttpResponse,
    request: HttpRequestSpec,
    started: number,
    options: CallOptions,
    streaming: boolean,
  ): InvocationResult {
    const max = this.deps.config.call.maxOutputChars
    const warnings: string[] = []
    let content: string | undefined
    let reasoningContent: string | undefined
    let finishReason: string | undefined
    let usage: InvocationResult['usage']
    let json: unknown = response.json

    if (streaming) {
      const parsed = parseSse(response.text)
      content = parsed.content
      reasoningContent = parsed.reasoning
      finishReason = parsed.finishReason
      usage = parsed.usage
      json = undefined
      warnings.push('流式响应已聚合为完整文本；token 用量取决于服务商是否在流末返回 usage。')
    } else if (json && typeof json === 'object') {
      const root = json as Record<string, unknown>
      const choices = Array.isArray(root.choices) ? root.choices : []
      const first = (choices[0] ?? {}) as Record<string, unknown>
      const message = (first.message ?? first.delta ?? {}) as Record<string, unknown>
      content = pickText(message.content) ?? pickText(first.text)
      reasoningContent = pickText(message.reasoning_content ?? message.reasoning)
      finishReason = typeof first.finish_reason === 'string' ? first.finish_reason : undefined
      const rawUsage = (root.usage ?? {}) as Record<string, unknown>
      const promptTokens = numberOrUndefined(rawUsage.prompt_tokens ?? rawUsage.input_tokens)
      const completionTokens = numberOrUndefined(rawUsage.completion_tokens ?? rawUsage.output_tokens)
      const totalTokens = numberOrUndefined(rawUsage.total_tokens) ??
        (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined)
      if (promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined) {
        usage = { promptTokens, completionTokens, totalTokens }
      }
    } else {
      content = truncate(redact(response.text), max)
      warnings.push('响应不是 JSON（可能是纯文本端点）；已按原文返回。')
    }

    let truncated = false
    if (content !== undefined && content.length > max) {
      content = truncate(content, max)
      truncated = true
    }
    if (reasoningContent !== undefined && reasoningContent.length > max) {
      reasoningContent = truncate(reasoningContent, max)
      truncated = true
    }

    const raw = options.includeRaw ? clipRaw(json ?? parseSseObjects(response.text), max) : undefined
    if (truncated) warnings.push(`输出超过 ${max} 字符，已截断；可用 includeRaw 获取结构化原始响应。`)
    if (!content && !raw) warnings.push('响应中未找到文本内容；建议用 includeRaw=true 查看完整结构。')

    return {
      ...base,
      ok: true,
      httpStatus: response.status,
      elapsedMs: Date.now() - started,
      request: previewRequest(request) as InvocationResult['request'],
      content,
      reasoningContent,
      finishReason,
      usage,
      raw,
      truncated,
      warnings,
    }
  }

  /** 列出账户可用模型；/models 失败时回退到静态清单，并明确标注来源。 */
  async models(accountId: string, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelsResult> {
    const { registry, http, config } = this.deps
    const account = registry.account(accountId)
    const adapter = registry.adapter(account.provider)
    const fallback = account.models ?? adapter.spec.defaultModels ?? []
    const warnings: string[] = []
    const cached = this.modelCache.get(accountId)
    if (!options.refresh && cached && Date.now() - cached.at < config.balance.cacheTtlMs) {
      return { accountId, providerId: account.provider, models: cached.models, source: 'live', warnings }
    }
    const modelsPath = adapter.spec.modelsPath
    if (!modelsPath || !account.apiKey) {
      if (!account.apiKey) warnings.push('未配置 API Key，无法拉取在线模型列表。')
      else warnings.push('该服务商未声明 /models 端点。')
      return { accountId, providerId: account.provider, models: fallback, source: 'fallback', warnings }
    }
    try {
      const url = joinUrl(account.chatBaseUrl, modelsPath)
      registry.assertAllowedUrl(url)
      const response = await http.send(
        {
          method: 'GET',
          url,
          headers: { ...authHeaders(account), ...account.headers },
          purpose: `模型列表 · ${adapter.spec.label}`,
        },
        { signal: options.signal, timeoutMs: account.timeoutMs },
      )
      const models = adapter.parseModels ? adapter.parseModels(response) : parseModelList(response)
      if (models.length === 0) {
        warnings.push('/models 返回空列表，已回退到静态清单。')
        return { accountId, providerId: account.provider, models: fallback, source: 'fallback', warnings }
      }
      this.modelCache.set(accountId, { models, at: Date.now() })
      return { accountId, providerId: account.provider, models, source: 'live', warnings }
    } catch (error) {
      const classified: ClassifiedError = toClassifiedError(error)
      warnings.push(`在线模型列表不可用：${classified.message}（${classified.hint}）`)
      if (cached) return { accountId, providerId: account.provider, models: cached.models, source: 'live', warnings }
      return { accountId, providerId: account.provider, models: fallback, source: 'fallback', warnings }
    }
  }

  close(): void {
    this.modelCache.clear()
  }
}

function normalizeMessages(options: CallOptions): ChatMessage[] {
  if (Array.isArray(options.messages) && options.messages.length) return options.messages
  if (typeof options.prompt === 'string' && options.prompt.trim()) {
    return [{ role: 'user', content: options.prompt }]
  }
  throw new ProviderFailure(
    makeError('config', 'chat 模式需要 messages 或 prompt', {
      hint: '传 prompt:"你的问题"，或传完整 messages 数组。',
      retryable: false,
    }),
  )
}

function assertBodySize(body: unknown, max: number): void {
  const size = JSON.stringify(body).length
  if (size > max) {
    throw new ProviderFailure(
      makeError('config', `请求体 ${size} 字符超过上限 ${max}`, { retryable: false }),
    )
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function pickText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => ((item ?? {}) as Record<string, unknown>).text)
      .filter((item): item is string => typeof item === 'string')
    return parts.length ? parts.join('\n') : undefined
  }
  return undefined
}

function clipRaw(value: unknown, max: number): unknown {
  try {
    const text = JSON.stringify(value)
    if (text.length <= max) return value
    return { truncated: true, preview: truncate(redact(text), max) }
  } catch {
    return { truncated: true, preview: '<无法序列化>' }
  }
}

/** 把 SSE 文本聚合成一段回复；容错跳过非 JSON 行与心跳。 */
export function parseSse(text: string): {
  content: string
  reasoning: string
  finishReason?: string
  usage?: InvocationResult['usage']
} {
  let content = ''
  let reasoning = ''
  let finishReason: string | undefined
  let usage: InvocationResult['usage']
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let chunk: Record<string, unknown>
    try {
      chunk = JSON.parse(data) as Record<string, unknown>
    } catch {
      continue
    }
    const first = (Array.isArray(chunk.choices) ? chunk.choices[0] : undefined) as Record<string, unknown> | undefined
    const delta = (first?.delta ?? first?.message ?? {}) as Record<string, unknown>
    content += pickText(delta.content) ?? ''
    reasoning += pickText(delta.reasoning_content ?? delta.reasoning) ?? ''
    if (typeof first?.finish_reason === 'string') finishReason = first.finish_reason
    const rawUsage = (chunk.usage ?? {}) as Record<string, unknown>
    if (Object.keys(rawUsage).length) {
      usage = {
        promptTokens: numberOrUndefined(rawUsage.prompt_tokens),
        completionTokens: numberOrUndefined(rawUsage.completion_tokens),
        totalTokens: numberOrUndefined(rawUsage.total_tokens),
      }
    }
  }
  return { content, reasoning, finishReason, usage }
}

function parseSseObjects(text: string): unknown {
  const out: unknown[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      out.push(JSON.parse(data))
    } catch {
      /* 心跳行忽略 */
    }
  }
  return out
}
