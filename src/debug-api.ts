/**
 * 「调试台」的同源 HTTP 路由 —— 任意端点调试的后端半端。
 *
 * ============================================================================
 * 为什么是同源路由，而不是复用 8788 看板
 * ============================================================================
 * 8788 那个看板是插件自己起的 `node:http` 服务器，和 DSH 主界面**不同端口**，
 * 因而是跨源；它没有任何 CORS 头，浏览器会把 fetch 拦下来。给 8788 加
 * `Access-Control-Allow-Origin: http://127.0.0.1:*` 属于「自己发明 CORS 绕过」，
 * 所以走宿主官方接缝：`ctx.webServer.register({kind, path, handler})`。
 *
 * 关键事实（均从宿主真实包源码核对，不是推测）：
 *  · `@deepseek-ai/dsh-host-webserver` 的 `WebServer.register(route)` 接受
 *    `{kind:'exact'|'prefix', path, handler(req,res)}`，返回 disposer；
 *  · 匹配顺序是「精确 → 最长前缀 → fallback」（`match()` 先查 exact 表），
 *    所以 exact 路由**先于** `@deepseek-ai/dsh-client-connection` 注册的 `/api`
 *    前缀生效 —— 这正是 dsh-market 的做法（`exact` 注册 `/dsh-market/api/v1/…`）。
 *
 * ============================================================================
 * 安全
 * ============================================================================
 * 1. 路径带命名空间前缀，不占用别人的 `/api`；
 * 2. exact 路由绕过了宿主 `/api` 的 Host/Origin 栅栏，所以这里**自带**一份等价
 *    栅栏（Host 必须是回环 / 已声明 trustedHosts / 监听地址本身；Origin 必须同源；
 *    `sec-fetch-site: cross-site` 一律拒绝）—— 缺了它就是 DNS rebinding 敞口；
 * 3. 真正的白名单（SSRF 防护）在 `ConsoleRegistry.assertAllowedUrl()`，
 *    `provider_request` 工具与这里走的是**同一条**路径，不存在旁路；
 * 4. 出站密钥只由注册中心注入，本模块从不读取明文；回包还要再过一遍
 *    `redactDeep()`，把密钥值与 `sk-…`/`Bearer …` 形态一律抹掉。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CallOptions, ClassifiedError, ErrorKind, InvocationResult, LogFn, ResolvedConfig } from './types.ts'
import type { ConsoleRegistry } from './core/registry.ts'
import type { InvocationService } from './core/invocation.ts'
import { lossless, redact } from './core/errors.ts'

/** 路由命名空间：带插件名，避免和宿主或别的插件抢路径。 */
export const DEBUG_NAMESPACE = 'dsh-plugin-provider-console'
export const DEBUG_BASE = `/${DEBUG_NAMESPACE}/api/debug`
export const DEBUG_REQUEST_PATH = `${DEBUG_BASE}/request`
export const DEBUG_ACCOUNTS_PATH = `${DEBUG_BASE}/accounts`

/** 请求体上限：调试台不需要传大文件，1 MiB 足够且能挡住误传的巨型 payload。 */
export const MAX_BODY_BYTES = 1_000_000
/** 单次调试请求的超时上限，与 config 的 requestTimeoutMs 上限一致。 */
export const MAX_TIMEOUT_MS = 300_000
/** 允许的方法：与 HttpMethod 一一对应。 */
export const DEBUG_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

export type DebugMethod = (typeof DEBUG_METHODS)[number]

/** 对外暴露的账户视图：只有 4 个字段，密钥一个字节都不出现。 */
export interface DebugAccountView {
  id: string
  label: string
  provider: string
  hasKey: boolean
}

export interface DebugRequestOptions {
  accountId: string
  method: DebugMethod
  path: string
  headers?: Record<string, string>
  body?: unknown
  includeRaw?: boolean
  dryRun?: boolean
  timeoutMs?: number
}

/** `parseDebugRequest` 的结果：要么给出可直接喂给 invocation 的选项，要么给出可展示的原因。 */
export type ParseResult =
  | { ok: true; options: DebugRequestOptions }
  | { ok: false; kind: ErrorKind; message: string; hint?: string }

export interface DebugRoutesDeps {
  registry: ConsoleRegistry
  invocation: InvocationService
  config: ResolvedConfig
  log?: LogFn
}

/** 宿主上下文的最小形状（不 import Cordis 类型，避免版本耦合）。 */
export interface DebugHostContext {
  get?: (name: string) => unknown
  inject?: (deps: string[], cb: (scope: DebugHostContext) => unknown) => unknown
  effect?: (cb: () => () => void, label?: string) => unknown
  on?: (event: string, cb: () => void) => unknown
}

/** 宿主 webServer 服务的最小形状（见 dsh-host-webserver 的 register()）。 */
export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
  readonly host?: string
  readonly port?: number
}

export interface DebugApiStatus {
  /** 路由是否真的挂到了宿主 webServer 上。 */
  registered: boolean
  paths: { request: string; accounts: string }
  /** 没挂上的原因（宿主没有 webServer 服务 / 注册抛错），用于诊断。 */
  reason?: string
}

export interface DebugRoutesHandle {
  status(): DebugApiStatus
  dispose(): void
}

// ---------------------------------------------------------------------------
// 同源栅栏
// ---------------------------------------------------------------------------

/** Host 头是否就是回环地址（含 localhost 与 IPv6 回环）。 */
export function isLoopbackAuthority(host: string | undefined): boolean {
  if (typeof host !== 'string' || !host) return false
  const lower = host.toLowerCase()
  // IPv6 字面量保留方括号：`[::1]:3080` → `[::1]`
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/** 解析裸 `host[:port]`；不是权威形式时返回 undefined。 */
function parseAuthority(value: string): URL | undefined {
  try {
    const url = new URL(`http://${value}`)
    const canonical = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`
    return canonical === value.toLowerCase() ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * Host 是否命中部署声明的 `trustedHosts`。
 *
 * 规则与宿主 `/api` 栅栏一致：带端口的条目精确匹配，不带端口的条目匹配任意端口。
 * 声明只可能来自配置文件，所以这不是攻击者能伪造的东西。
 */
export function trustedAuthority(host: string, trustedHosts: readonly string[]): boolean {
  const hostUrl = parseAuthority(host)
  if (!hostUrl) return false
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (!entryUrl) return false
    return entryUrl.port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}

/**
 * 同源判定（反向代理/局域网部署要能用，是主机名就必须在 trustedHosts 里）。
 *
 * 三条规则，逐一对应浏览器真实会发的信号：
 *  1. `Host` 必须是回环 / 已声明 / 监听地址本身 —— DNS rebinding 唯一伪造不了的头；
 *  2. `sec-fetch-site: cross-site` 直接拒；
 *  3. 带 `Origin` 时必须与 Host 同源（回环允许 Chrome 151+ 省略端口）。
 * 缺少 `Host` 时不放行：浏览器一定会发它，没发就说明不是页面来的。
 */
export function sameOrigin(
  request: { headers: Record<string, string | string[] | undefined> },
  trustedHosts: readonly string[] = [],
  bindHost?: string,
): { ok: true } | { ok: false; reason: string } {
  const raw = request.headers.host
  const host = Array.isArray(raw) ? raw[0] : raw
  if (typeof host !== 'string' || !host) {
    return { ok: false, reason: '请求缺少 Host 头，无法确认来源' }
  }
  const bindOk = (() => {
    if (typeof bindHost !== 'string' || !bindHost) return false
    const zoneAt = bindHost.indexOf('%')
    const address = zoneAt === -1 ? bindHost : bindHost.slice(0, zoneAt)
    const bindUrl = parseAuthority(address.includes(':') ? `[${address}]` : address)
    const hostUrl = parseAuthority(host)
    return Boolean(bindUrl && hostUrl && bindUrl.hostname === hostUrl.hostname)
  })()
  if (!isLoopbackAuthority(host) && !trustedAuthority(host, trustedHosts) && !bindOk) {
    return { ok: false, reason: `Host "${host}" 不是回环、也不是已声明的可信地址` }
  }
  const site = request.headers['sec-fetch-site']
  if ((Array.isArray(site) ? site[0] : site) === 'cross-site') {
    return { ok: false, reason: '浏览器把该请求标记为跨站（sec-fetch-site: cross-site）' }
  }
  const rawOrigin = request.headers.origin
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin
  if (origin === undefined) return { ok: true }
  try {
    const originUrl = new URL(origin)
    if (originUrl.host === host) return { ok: true }
    // Chrome 151+ 在回环 Origin 上省略显式端口（宿主 /api 栅栏同规则）
    if (originUrl.port === '' && isLoopbackAuthority(host)) {
      const hostUrl = parseAuthority(host)
      if (hostUrl && originUrl.hostname === hostUrl.hostname) return { ok: true }
    }
    return { ok: false, reason: `Origin "${origin}" 与 Host "${host}" 不同源` }
  } catch {
    return { ok: false, reason: `Origin 头无法解析：${origin}` }
  }
}

// ---------------------------------------------------------------------------
// 请求体
// ---------------------------------------------------------------------------

/** 读 JSON 请求体；超限与非 JSON 都收敛成可展示的原因（绝不抛到调用方）。 */
export async function readJsonBody(
  request: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; message: string }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer)
    size += buffer.length
    if (size > maxBytes) return { ok: false, message: `请求体超过上限 ${maxBytes} 字节` }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, message: `请求体不是合法 JSON：${(error as Error).message}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: '请求体必须是 JSON 对象' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/** 把客户端传来的东西归一成 invocation 的选项；任何不合法都给出可操作的提示。 */
export function parseDebugRequest(payload: Record<string, unknown>): ParseResult {
  const accountId = typeof payload.accountId === 'string' ? payload.accountId.trim() : ''
  if (!accountId) {
    return { ok: false, kind: 'config', message: '缺少 accountId', hint: '先 GET /api/debug/accounts 选一个账户。' }
  }
  const rawMethod = typeof payload.method === 'string' ? payload.method.trim().toUpperCase() : 'GET'
  if (!(DEBUG_METHODS as readonly string[]).includes(rawMethod)) {
    return {
      ok: false,
      kind: 'config',
      message: `不支持的 method：${rawMethod}`,
      hint: `可用方法：${DEBUG_METHODS.join(' / ')}`,
    }
  }
  const path = typeof payload.path === 'string' ? payload.path.trim() : ''
  if (!path) {
    return {
      ok: false,
      kind: 'config',
      message: '缺少 path',
      hint: '填相对 baseUrl 的路径（如 /models），或白名单内的绝对 https URL。',
    }
  }
  let headers: Record<string, string> | undefined
  if (payload.headers !== undefined) {
    if (payload.headers === null || typeof payload.headers !== 'object' || Array.isArray(payload.headers)) {
      return { ok: false, kind: 'config', message: 'headers 必须是对象（key → value 都是字符串）' }
    }
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(payload.headers as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        return { ok: false, kind: 'config', message: `headers["${key}"] 必须是字符串` }
      }
      const name = key.trim()
      if (!name) continue
      out[name] = value
    }
    if (Object.keys(out).length) headers = out
  }
  let timeoutMs: number | undefined
  if (payload.timeoutMs !== undefined && payload.timeoutMs !== null) {
    if (typeof payload.timeoutMs !== 'number' || !Number.isFinite(payload.timeoutMs)) {
      return { ok: false, kind: 'config', message: 'timeoutMs 必须是数字（毫秒）' }
    }
    timeoutMs = Math.min(Math.max(Math.round(payload.timeoutMs), 1), MAX_TIMEOUT_MS)
  }
  return {
    ok: true,
    options: {
      accountId,
      method: rawMethod as DebugMethod,
      path,
      ...(headers ? { headers } : {}),
      body: payload.body,
      // 调试台的默认行为是「把原始结构给我看」；显式 false 才关
      includeRaw: payload.includeRaw !== false,
      dryRun: payload.dryRun === true,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  }
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

/**
 * 深度脱敏：先把**账户密钥原值**整串替换掉，再套用通用密钥形态规则。
 *
 * 两层都要：通用规则只认 `sk-…` / `Bearer …`，而有些平台（自建网关、中转站的
 * 自定义头）密钥长得完全不像密钥，只能靠「知道原值」才能抹掉。
 */
export function redactDeep(value: unknown, secrets: readonly string[] = []): unknown {
  const live = secrets.filter((secret) => typeof secret === 'string' && secret.length >= 6)
  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') {
      let out = input
      for (const secret of live) out = out.split(secret).join('<redacted>')
      return redact(out)
    }
    if (Array.isArray(input)) return input.map((item) => walk(item))
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        out[key] = walk(item)
      }
      return out
    }
    return input
  }
  return walk(value)
}

/** 账户列表视图：4 个字段，没有 baseUrl / apiKeySource / 任何可反推密钥的信息。 */
export function accountView(account: {
  id: string
  label: string
  provider: string
  hasApiKey: boolean
}): DebugAccountView {
  return {
    id: account.id,
    label: account.label,
    provider: account.provider,
    hasKey: account.hasApiKey,
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const ROUTE_LABELS = {
  accounts: `${DEBUG_NAMESPACE}: debug accounts route`,
  request: `${DEBUG_NAMESPACE}: debug request route`,
}

/** 把宿主 webServer 服务归一化；不是这个形状就当没有。 */
function asWebServer(value: unknown): WebServerService | undefined {
  if (!value || typeof value !== 'object') return undefined
  const service = value as { register?: unknown }
  if (typeof service.register !== 'function') return undefined
  return value as WebServerService
}

/**
 * 注册调试台路由。
 *
 * 与 `systemPrompt` / `llm` 一样是**可选增强**：宿主没有 webServer 时记一条
 * warning 后静默跳过，工具、余额、模型 provider 全部照常。
 */
export function installDebugRoutes(ctx: DebugHostContext, deps: DebugRoutesDeps): DebugRoutesHandle {
  const log = deps.log ?? (() => undefined)
  const disposers: Array<() => void> = []
  let status: DebugApiStatus = {
    registered: false,
    paths: { request: DEBUG_REQUEST_PATH, accounts: DEBUG_ACCOUNTS_PATH },
    reason: '尚未挂载',
  }

  const readService = (name: string): unknown => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      // Cordis 的 Proxy get 对未在 inject 声明的属性会抛；这里一律视同「没有」
      return undefined
    }
  }

  const sendJson = (response: ServerResponse, code: number, payload: unknown): void => {
    if (response.headersSent) return
    response.writeHead(code, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      // 同源路由不对外开跨源共享；这条只是让「被别处误用」时更早失败
      'x-content-type-options': 'nosniff',
    })
    response.end(JSON.stringify(lossless(payload)))
  }

  const refuse = (response: ServerResponse, message: string): void => {
    sendJson(response, 403, {
      error: {
        kind: 'config',
        message: `已拒绝：${message}`,
        hint: '请从 DSH 主界面（同一源）打开调试台；命令行请直连回环地址并带 Host 头。',
      },
    })
  }

  /** 每个请求都要算一次：trustedHosts / bindHost 由宿主运行期决定。 */
  const fence = (request: IncomingMessage): { ok: true } | { ok: false; reason: string } => {
    let trustedHosts: string[] = []
    const connection = readService('connection') as { trustedHosts?: unknown } | undefined
    if (connection && Array.isArray(connection.trustedHosts)) {
      trustedHosts = connection.trustedHosts.filter((entry): entry is string => typeof entry === 'string')
    }
    const webServer = asWebServer(readService('webServer'))
    return sameOrigin(request, trustedHosts, webServer?.host)
  }

  const handleAccounts = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' })
      response.end()
      return
    }
    const gate = fence(request)
    if (!gate.ok) return refuse(response, gate.reason)
    try {
      sendJson(response, 200, {
        accounts: deps.registry.listAccounts().map(accountView),
        rawEnabled: deps.config.call.allowRawRequests,
      })
    } catch (error) {
      log(`调试台 /accounts 失败: ${(error as Error).message}`)
      sendJson(response, 500, {
        error: { kind: 'internal', message: (error as Error).message, hint: '查看宿主日志。' },
      })
    }
  }

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const gate = fence(request)
    if (!gate.ok) return refuse(response, gate.reason)
    const contentType = String(request.headers['content-type'] ?? '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase()
    if (contentType !== 'application/json') {
      sendJson(response, 415, {
        error: { kind: 'config', message: '需要 Content-Type: application/json', hint: '调试台自己会带这个头。' },
      })
      return
    }
    const body = await readJsonBody(request)
    if (!body.ok) {
      sendJson(response, 400, {
        error: { kind: 'client', message: body.message, hint: '检查 JSON 语法（尾逗号、引号、括号配对）。' },
      })
      return
    }
    const parsed = parseDebugRequest(body.value)
    if (!parsed.ok) {
      sendJson(response, 400, { error: { kind: parsed.kind, message: parsed.message, hint: parsed.hint } })
      return
    }
    const options = parsed.options
    // 密钥只用于「回包脱敏」这一个用途，且永不写日志、永不出现在响应里
    const secrets: string[] = []
    try {
      secrets.push(deps.registry.account(options.accountId).apiKey)
    } catch {
      // 未知账户：invocation 会给出可操作的 config 错误，这里不抢它的活
    }
    try {
      const callOptions: CallOptions = {
        accountId: options.accountId,
        mode: 'raw',
        method: options.method,
        path: options.path,
        headers: options.headers,
        body: options.body,
        includeRaw: options.includeRaw,
        dryRun: options.dryRun,
        timeoutMs: options.timeoutMs,
      }
      const result = await deps.invocation.call(callOptions)
      // 错误对象里的 rawSnippet 也可能含密钥原文，所以要整棵树过一遍
      sendJson(response, 200, { result: redactDeep(result, secrets) })
      log(
        `调试台 ${options.method} ${options.path} → ${result.ok ? (result.httpStatus ?? 'ok') : (result.error?.kind ?? 'error')}` +
          `${options.dryRun ? '（dry-run）' : ''}`,
      )
    } catch (error) {
      log(`调试台 /request 异常: ${(error as Error).message}`)
      const classified: ClassifiedError = {
        kind: 'internal',
        message: redact((error as Error).message),
        hint: '插件内部错误；查看宿主日志获取细节。',
        retryable: false,
      }
      sendJson(response, 500, { error: classified })
    }
  }

  const mount = (scope: DebugHostContext): void => {
    const service = asWebServer(
      (() => {
        try {
          return typeof scope.get === 'function' ? scope.get('webServer') : undefined
        } catch {
          return undefined
        }
      })(),
    )
    if (!service) {
      status = {
        registered: false,
        paths: { request: DEBUG_REQUEST_PATH, accounts: DEBUG_ACCOUNTS_PATH },
        reason: '宿主没有 webServer 服务',
      }
      log('宿主未提供 webServer 服务，调试台同源路由跳过（工具与看板不受影响）')
      return
    }
    let failure: string | undefined
    const registerRoute = (
      route: { kind: 'exact'; path: string; handler: (r: IncomingMessage, s: ServerResponse) => Promise<void> },
      label: string,
    ): void => {
      try {
        const effect = typeof scope.effect === 'function' ? scope.effect : undefined
        if (effect) effect(() => service.register(route), label)
        else disposers.push(service.register(route))
      } catch (error) {
        // 路径重复 = 宿主里已有同名路由（配置错误）。记 warning，别把插件打成 failed。
        failure = (error as Error).message
        log(`调试台路由注册失败 ${route.path}: ${failure}`)
      }
    }
    registerRoute({ kind: 'exact', path: DEBUG_ACCOUNTS_PATH, handler: handleAccounts }, ROUTE_LABELS.accounts)
    registerRoute({ kind: 'exact', path: DEBUG_REQUEST_PATH, handler: handleRequest }, ROUTE_LABELS.request)
    // 任何一条失败都不能报「已挂载」—— 否则诊断工具会对着一个 404 的地址说「已挂载」。
    status = failure
      ? {
          registered: false,
          paths: { request: DEBUG_REQUEST_PATH, accounts: DEBUG_ACCOUNTS_PATH },
          reason: failure,
        }
      : {
          registered: true,
          paths: { request: DEBUG_REQUEST_PATH, accounts: DEBUG_ACCOUNTS_PATH },
        }
    if (!failure) log(`调试台同源路由已挂载：${DEBUG_BASE}/request · ${DEBUG_BASE}/accounts`)
  }

  const canInject = typeof ctx.inject === 'function'
  if (canInject) {
    // 与宿主 systemPrompt/llm 的写法一致：服务可能晚于本插件挂载，用 ctx.inject 等它
    ;(ctx.inject as (deps: string[], cb: (scope: DebugHostContext) => unknown) => unknown).call(
      ctx,
      ['webServer'],
      (scope) => {
        mount(scope)
        return () => {
          /* 路由由 scope.effect 释放；这里只兜底直接注册的分支 */
        }
      },
    )
  } else {
    mount(ctx)
  }

  return {
    status: () => status,
    dispose: () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* 已释放 */
        }
      }
    },
  }
}
