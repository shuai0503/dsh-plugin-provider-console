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
import type { CallOptions, LogFn } from './types.ts'
import type { ConsoleRegistry } from './core/registry.ts'
import type { BalanceService } from './core/balance.ts'
import type { InvocationService } from './core/invocation.ts'
import { lossless } from './core/errors.ts'

export interface DashboardOptions {
  registry: ConsoleRegistry
  balances: BalanceService
  invocation: InvocationService
  host: string
  port: number
  pollMs: number
  log?: LogFn
}

export interface DashboardHandle {
  url: string
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

  server.listen(options.port, options.host, () => {
    log(`余额看板已启动：http://${options.host}:${options.port}`)
  })
  server.on('error', (error) => log(`看板监听失败: ${error.message}`))

  return {
    url: `http://${options.host}:${options.port}`,
    close: () =>
      new Promise<void>((resolve) => {
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
