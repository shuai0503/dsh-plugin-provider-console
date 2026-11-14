/**
 * 可选的本地实时看板（默认关闭）。
 *
 * 只绑定 127.0.0.1，不对外暴露；复用同一份 BalanceService / InvocationService，
 * 因此「刷新」与聊天里的 provider_balances 完全一致。dashboard.enabled=false 时
 * 整个模块不会被创建，也不占端口。
 */
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CallOptions, LogFn, ResolvedConfig } from './types.ts'
import type { ConsoleRegistry } from './core/registry.ts'
import type { BalanceService } from './core/balance.ts'
import type { InvocationService } from './core/invocation.ts'
import { lossless } from './core/errors.ts'
import { sameOrigin } from './debug-api.ts'

export interface DashboardOptions {
  registry: ConsoleRegistry
  balances: BalanceService
  invocation: InvocationService
  host: string
  port: number
  pollMs: number
  log?: LogFn
  /**
   * 归一化后的配置。只经 `publicConfig()` 脱敏后再进 JSON ——
   * 账户的 apiKey / apiKeyEnv 永远不出现在这里（它们本来也不在 ResolvedConfig 里，
   * 但这一层仍然显式白名单，防止以后有人往 ResolvedConfig 加字段时顺手泄露）。
   */
  config?: ResolvedConfig
}

/**
 * 页面可见的配置白名单。
 *
 * 用途只有一个：看板需要知道「预警阈值 / 缓存 TTL / 各开关」才能画出诚实的
 * 进度条和状态；除此之外一个字段都不给。
 */
export interface PublicConfig {
  lowBalanceThreshold?: number
  cacheTtlMs: number
  autoRefreshMs: number
  autoDiscover: boolean
  dashboard: { enabled: boolean; host: string; port: number; pollMs: number }
  sidebar: { enabled: boolean; label: string; order: number }
  llmProvider: { enabled: boolean; routePrefix: string }
}

export function publicConfig(config: ResolvedConfig | undefined): PublicConfig | null {
  if (!config) return null
  return {
    lowBalanceThreshold: config.balance.lowBalanceThreshold,
    cacheTtlMs: config.balance.cacheTtlMs,
    autoRefreshMs: config.balance.autoRefreshMs,
    autoDiscover: config.autoDiscover.enabled,
    dashboard: {
      enabled: config.dashboard.enabled,
      host: config.dashboard.host,
      port: config.dashboard.port,
      pollMs: config.dashboard.pollMs,
    },
    sidebar: {
      enabled: config.sidebar.enabled,
      label: config.sidebar.label,
      order: config.sidebar.order,
    },
    llmProvider: { enabled: config.llm.enabled, routePrefix: config.llm.routePrefix },
  }
}

export interface DashboardHandle {
  /** 配置里写的地址。端口写 0（让内核分配）时这不是真实地址，用 ready() 取。 */
  url: string
  /**
   * 等 `listen` 真正绑定成功后 resolve 出**实际**地址。
   *
   * 需要它的理由：`port: 0` 时内核才决定端口，配置里的 `url` 是 `…:0`；
   * 端口被占用时 `listen` 会失败而不是抛出（错误走 'error' 事件），
   * 调用方只有 await 这个 promise 才知道看板到底起没起来。
   */
  ready(): Promise<string>
  close(): Promise<void>
}

const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html')
const FALLBACK_HTML = '<!doctype html><meta charset="utf-8"><h1>看板页面缺失</h1><p>public/index.html 未找到。</p>'

export function createDashboard(options: DashboardOptions): DashboardHandle {
  const log = options.log ?? (() => undefined)
  // 每次请求重新读盘：宿主 HMR 不保证重新求值本模块，改 public/index.html
  // （例如嵌入宿主的 embed 样式）后无需重启窗口即可生效。仅本地低频访问。
  const renderPage = () => {
    try {
      return readFileSync(HTML_PATH, 'utf8').replace('__POLL_MS__', String(options.pollMs))
    } catch {
      return FALLBACK_HTML
    }
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${options.host}:${options.port}`)
    const send = (status: number, body: unknown) => {
      const text = typeof body === 'string' ? body : JSON.stringify(lossless(body))
      res.writeHead(status, {
        'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(text)
    }

    // 写操作必须有可证明的同源来源。
    //
    // 背景：本看板绑在 127.0.0.1，但浏览器里任意一个网页都能对它发
    // `POST /api/call`（用 text/plain 可绕过 CORS 预检），服务端照常执行 =>
    // 等于「任意网页诱导本机用已存的 Key 调一次付费 API」。响应被 CORS 挡
    // 住也没用，业务已经跑完了。
    //
    // 复用 debug-api.ts 的同一份栅栏（Host / sec-fetch-site / Origin 三检），
    // 避免同一仓库两套安全标准。curl 不带 Origin 仍放行，保留 CLI 用法。
    const WRITE_PATHS = new Set(['/api/call', '/api/refresh'])
    if (req.method === 'POST' && WRITE_PATHS.has(url.pathname)) {
      const verdict = sameOrigin({ headers: req.headers as Record<string, string | string[] | undefined> })
      if (!verdict.ok) return send(403, { error: `请求来源校验失败：${verdict.reason}` })
    }

    try {
      if (req.method === 'GET' && url.pathname === '/') return send(200, renderPage())
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return send(200, { ok: true, accounts: options.registry.listAccountIds().length })
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        // 冷启动时缓存为空，直接返回会让首屏显示「没有启用的账户」，
        // 用户会误以为没配好而去改 YAML。这里在缓存全空时补一次非 force 刷新
        // （走 TTL 逻辑，已有缓存时不会重复打上游）。
        const hasAccounts = options.registry.listAccountIds().length > 0
        if (hasAccounts && options.balances.snapshot().accounts.length === 0) {
          try {
            await options.balances.refresh({})
          } catch {
            /* 首屏刷新失败也要返回结构，前端会显示错误行 */
          }
        }
        return send(200, {
          generatedAt: Date.now(),
          accounts: options.registry.listAccounts(),
          providers: options.registry.listProviders(),
          report: options.balances.snapshot(),
          // 脱敏后的配置快照：页面据此画阈值进度条与状态徽标，不含任何密钥
          config: publicConfig(options.config),
        })
      }
      if (req.method === 'POST' && url.pathname === '/api/refresh') {
        const ids = url.searchParams.get('accountId')
        const report = await options.balances.refresh({ force: true, accountIds: ids ? [ids] : undefined })
        return send(200, { report })
      }
      if (req.method === 'GET' && url.pathname === '/api/models') {
        const accountId = url.searchParams.get('accountId') ?? ''
        return send(200, await options.invocation.models(accountId, { refresh: url.searchParams.get('refresh') === '1' }))
      }
      if (req.method === 'POST' && url.pathname === '/api/call') {
        const body = await readJson(req)
        const callOptions: CallOptions = {
          accountId: String(body.accountId ?? ''),
          mode: body.mode === 'raw' ? 'raw' : 'chat',
          model: typeof body.model === 'string' ? body.model : undefined,
          prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
          messages: Array.isArray(body.messages) ? (body.messages as CallOptions['messages']) : undefined,
          parameters: body.parameters && typeof body.parameters === 'object' ? (body.parameters as Record<string, unknown>) : undefined,
          path: typeof body.path === 'string' ? body.path : undefined,
          method: typeof body.method === 'string' ? (body.method as CallOptions['method']) : undefined,
          body: body.body,
          dryRun: body.dryRun === true,
          includeRaw: body.includeRaw === true,
        }
        return send(200, await options.invocation.call(callOptions))
      }
      send(404, { error: 'not found' })
    } catch (error) {
      log(`看板请求失败 ${url.pathname}: ${(error as Error).message}`)
      send(500, { error: (error as Error).message })
    }
  })

  let listenTimer: NodeJS.Timeout | undefined
  const ready = new Promise<string>((resolve, reject) => {
    server.once('listening', () => {
      const address = server.address()
      let actual = `http://${options.host}:${options.port}`
      if (address && typeof address === 'object') actual = `http://${options.host}:${address.port}`
      // 启动日志延到 listening 里打，才拿得到 port:0 的真实端口
      log(`余额看板已启动：${actual}`)
      resolve(actual)
    })
    server.once('error', (error: Error) => {
      log(`看板监听失败: ${error.message}`)
      reject(new Error(`看板监听失败: ${error.message}`))
    })
  })
  // 没人 await ready() 时不要留下一个未处理的 rejection 把进程带崩
  void ready.catch(() => undefined)
  listenTimer = setTimeout(() => log('看板监听超时（10s）'), 10_000)
  listenTimer.unref?.()

  server.on('error', (error) => log(`看板监听失败: ${error.message}`))

  // 真正的绑定放这里：ready / error 两个 once 监听器必须先挂上再 listen，
  // 否则端口被占用的错误会在监听器注册前触发，promise 永远挂着。
  server.listen(options.port, options.host)

  return {
    url: `http://${options.host}:${options.port}`,
    ready: () => ready,
    close: () =>
      new Promise<void>((resolve) => {
        if (listenTimer) clearTimeout(listenTimer)
        if (!server.listening) {
          resolve()
          return
        }
        // 必须主动断开 keep-alive 连接：server.close() 只是停止接受新连接，
        // 浏览器/测试客户端留下的空闲连接会让回调一直不触发（表现为 close() 悬挂）。
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

async function readJson(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Buffer))
    if (chunks.reduce((sum, item) => sum + item.length, 0) > 1_000_000) break
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return {}
  }
}
