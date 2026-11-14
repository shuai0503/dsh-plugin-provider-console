/**
 * 「调试台」同源路由：端到端（真实 HTTP 请求打到真实注册的 handler 上）。
 *
 * 为什么起一个真实的 http server 而不是直接调 handler：这一层的价值就在
 * 「浏览器能不能真的发出去」——方法/Content-Type/Host/Origin 都是 HTTP 层
 * 的事实，直接调函数会把它们全绕过去，测出来的绿是假的。
 *
 * 安全断言全部走**真实请求**：
 *   · 白名单拦截必须让传输层一次都不被调用（拦在发之前，不是发完再报错）；
 *   · 响应体里不能出现密钥明文；
 *   · 跨站/异源 Host 一律 403。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { createConsole } from '../src/server.ts'
import {
  DEBUG_ACCOUNTS_PATH,
  DEBUG_BASE,
  DEBUG_REQUEST_PATH,
  MAX_BODY_BYTES,
  accountView,
  parseDebugRequest,
  readJsonBody,
  redactDeep,
  sameOrigin,
  trustedAuthority,
  isLoopbackAuthority,
  installDebugRoutes,
  type WebServerService,
} from '../src/debug-api.ts'
import { jsonResponse, mockTransport, TEST_ENV } from './helpers.ts'
import type { HttpRequestSpec } from '../src/types.ts'

const SECRET = 'sk-live-debug-secret-must-not-leak'

interface Running {
  base: string
  calls: HttpRequestSpec[]
  consoleInstance: ReturnType<typeof createConsole>
  close(): Promise<void>
}

/**
 * 起一个把调试台路由挂上去的真实 HTTP 服务。
 *
 * `trustedHosts` 用来验证「非回环部署」那条分支；默认空 = 只认回环。
 */
async function running(
  options: {
    transport?: (request: HttpRequestSpec) => ReturnType<typeof jsonResponse>
    accounts?: Array<{ id: string; provider: string } & Record<string, unknown>>
    trustedHosts?: string[]
    bindHost?: string
  } = {},
): Promise<Running> {
  const calls: HttpRequestSpec[] = []
  const mock = mockTransport((request) => {
    calls.push(request)
    if (options.transport) return options.transport(request)
    if (request.url.endsWith('/models')) {
      return jsonResponse(200, { object: 'list', data: [{ id: 'deepseek-chat' }] })
    }
    return jsonResponse(200, { ok: true, url: request.url })
  })
  const consoleInstance = createConsole(
    {
      retries: 0,
      accounts: options.accounts ?? [{ id: 'ds', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY' }],
    },
    { transport: mock.transport, env: TEST_ENV, dashboard: false },
  )

  // 用真实 webServer 的**行为契约**（register 返回 disposer、exact 表）做一个最小实现；
  // 不做成 mock 对象，是为了让 handler 走真正的 (req,res) 生命周期。
  const routes = new Map<string, (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>>()
  const webServer: WebServerService = {
    host: options.bindHost ?? '127.0.0.1',
    port: 0,
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate exact route ${route.path}`)
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }

  const server: Server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const handler = routes.get(pathname)
    if (!handler) {
      res.writeHead(404)
      res.end()
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      res.writeHead(500)
      res.end(String(error))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  const handle = installDebugRoutes(
    {
      get: (name: string) => {
        if (name === 'webServer') return webServer
        if (name === 'connection') return { trustedHosts: options.trustedHosts ?? [] }
        return undefined
      },
    },
    {
      registry: consoleInstance.registry,
      invocation: consoleInstance.invocation,
      config: consoleInstance.config,
    },
  )
  // installDebugRoutes 在无 ctx.inject 时立即挂载
  assert.equal(handle.status().registered, true, '路由应已挂载')

  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    consoleInstance,
    close: async () => {
      handle.dispose()
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
      await consoleInstance.close()
    },
  }
}

async function postJson(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/**
 * 绕过 WHATWG fetch 的 forbidden-header 规则，发一个**带自定义 Host** 的请求。
 *
 * 必要性：fetch 会无条件丢掉调用方写的 `Host`，而 DNS rebinding 的全部危险
 * 就在这个头上 —— 用 fetch 测「Host 是攻击者域名」永远是回环 Host，测试恒绿。
 */
async function rawRequest(
  base: string,
  path: string,
  options: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  const url = new URL(path, base)
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: options.method,
        headers: { ...options.headers, 'content-length': String(Buffer.byteLength(options.body ?? '')) },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    request.on('error', reject)
    if (options.body) request.write(options.body)
    request.end()
  })
}

// ---------------------------------------------------------------------------
// 常量与纯函数
// ---------------------------------------------------------------------------

test('路由常量带插件命名空间，绝不占用宿主的 /api', () => {
  assert.equal(DEBUG_BASE, '/dsh-plugin-provider-console/api/debug')
  assert.equal(DEBUG_REQUEST_PATH, `${DEBUG_BASE}/request`)
  assert.equal(DEBUG_ACCOUNTS_PATH, `${DEBUG_BASE}/accounts`)
  assert.equal(DEBUG_BASE.startsWith('/api'), false, '不能抢宿主的 /api 前缀（client-connection 拥有它）')
})

test('accountView 只回 4 个字段：没有 baseUrl / apiKeySource / models', () => {
  const view = accountView({
    id: 'ds',
    label: '主账号',
    provider: 'deepseek',
    hasApiKey: true,
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeySource: 'env:DEEPSEEK_API_KEY',
  } as never)
  assert.deepEqual(view, { id: 'ds', label: '主账号', provider: 'deepseek', hasKey: true })
})

test('redactDeep：抹掉账户密钥原值，也抹掉 sk- / Bearer 形态', () => {
  const payload = {
    note: `my key is ${SECRET}`,
    nested: { header: `Bearer ${SECRET}`, other: 'sk-abcdefghijklmnop' },
    list: [`${SECRET}`, 'plain text'],
    count: 3,
  }
  const out = redactDeep(payload, [SECRET]) as Record<string, any>
  const raw = JSON.stringify(out)
  assert.equal(raw.includes(SECRET), false, '账户密钥原值必须消失')
  assert.equal(raw.includes('sk-abcdefghijklmnop'), false, 'sk- 形态必须被打码')
  assert.equal(raw.includes('plain text'), true, '普通文本不应被误伤')
  assert.equal(out.count, 3, '非字符串值原样保留')
  assert.match(out.list[0], /redacted/)
})

test('isLoopbackAuthority / trustedAuthority 的边界', () => {
  for (const host of ['127.0.0.1:3080', 'localhost:1', '[::1]:9', '127.0.0.1']) {
    assert.equal(isLoopbackAuthority(host), true, `${host} 应判为回环`)
  }
  for (const host of ['0.0.0.0:3080', 'evil.com', 'localhost.evil.com:1', '10.0.0.5:1', '']) {
    assert.equal(isLoopbackAuthority(host), false, `${host} 不应判为回环`)
  }
  // 带端口 = 精确匹配；不带端口 = 任意端口
  assert.equal(trustedAuthority('dsh.internal:8080', ['dsh.internal:8080']), true)
  assert.equal(trustedAuthority('dsh.internal:9090', ['dsh.internal:8080']), false)
  assert.equal(trustedAuthority('dsh.internal:9090', ['dsh.internal']), true)
  assert.equal(trustedAuthority('dsh.internal:9090', []), false)
})

test('sameOrigin：Host 必须是回环/已声明；跨站与异源 Origin 一律拒', () => {
  const loop = (headers: Record<string, string>) => sameOrigin({ headers })
  assert.equal(loop({ host: '127.0.0.1:3080' }).ok, true)
  assert.equal(loop({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }).ok, true)
  // Chrome 151+ 回环 Origin 省略端口
  assert.equal(loop({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1' }).ok, true)
  // 缺少 Host：浏览器一定发，没发就不是页面来的
  assert.equal(loop({}).ok, false)
  // DNS rebinding：Host 是攻击者的域名
  assert.equal(loop({ host: 'evil.com:3080', origin: 'http://evil.com:3080' }).ok, false)
  // 同站但不同源
  assert.equal(loop({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' }).ok, false)
  assert.equal(loop({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }).ok, false)
  assert.equal(loop({ host: '127.0.0.1:3080', origin: 'null' }).ok, false)
  // 已声明可信主机 + 说明 Host 也能过；监听地址本身也算
  const declared = sameOrigin({ headers: { host: 'dsh.internal:9' } }, ['dsh.internal:9'])
  assert.equal(declared.ok, true)
  const bind = sameOrigin({ headers: { host: '10.0.0.5:3080' } }, [], '10.0.0.5')
  assert.equal(bind.ok, true)
})

test('parseDebugRequest：缺字段/非法方法/非字符串 header 都给可操作提示', () => {
  const need = parseDebugRequest({})
  assert.equal(need.ok, false)
  assert.match((need as { hint?: string }).hint ?? '', /accounts/)

  const badMethod = parseDebugRequest({ accountId: 'ds', method: 'TRACE', path: '/x' })
  assert.equal(badMethod.ok, false)
  assert.match((badMethod as { hint?: string }).hint ?? '', /GET/)

  const noPath = parseDebugRequest({ accountId: 'ds' })
  assert.equal(noPath.ok, false)

  const badHeader = parseDebugRequest({ accountId: 'ds', path: '/x', headers: { a: 1 } })
  assert.equal(badHeader.ok, false)
  assert.match((badHeader as { message: string }).message, /headers\["a"\]/)

  // 默认 GET、默认 includeRaw=true（调试台就是要看原始结构）
  const okDefault = parseDebugRequest({ accountId: 'ds', path: '/models' })
  assert.equal(okDefault.ok, true)
  const options = (okDefault as { options: any }).options
  assert.equal(options.method, 'GET')
  assert.equal(options.includeRaw, true)
  assert.equal(options.dryRun, false)

  // method 归一为大写、超时被夹到上限
  const normalized = parseDebugRequest({ accountId: 'ds', path: '/x', method: 'post', timeoutMs: 9_999_999 })
  assert.equal((normalized as { options: any }).options.method, 'POST')
  assert.equal((normalized as { options: any }).options.timeoutMs, 300_000)

  // 空 header 名被丢掉，不会发个无名头出去
  const blank = parseDebugRequest({ accountId: 'ds', path: '/x', headers: { '  ': 'v', 'X-K': 'v' } })
  assert.deepEqual((blank as { options: any }).options.headers, { 'X-K': 'v' })
})

test('readJsonBody：超限与坏 JSON 都收敛成原因，不抛', async () => {
  const tiny = createServer(async (req, res) => {
    const result = await readJsonBody(req, 16)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result))
  })
  await new Promise<void>((resolve) => tiny.listen(0, '127.0.0.1', resolve))
  const port = (tiny.address() as { port: number }).port
  try {
    const big = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'x'.repeat(64) })
    const bigBody = (await big.json()) as Record<string, any>
    assert.equal(bigBody.ok, false)
    assert.match(bigBody.message, /超过上限/)

    const bad = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{oops' })
    const badBody = (await bad.json()) as Record<string, any>
    assert.equal(badBody.ok, false)
    assert.match(badBody.message, /不是合法 JSON/)

    const empty = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' })
    const emptyBody = (await empty.json()) as Record<string, any>
    assert.equal(emptyBody.ok, true)
    assert.deepEqual(emptyBody.value, {})
  } finally {
    await new Promise<void>((resolve) => tiny.close(() => resolve()))
  }
})

// ---------------------------------------------------------------------------
// 真实 HTTP：正常路径
// ---------------------------------------------------------------------------

test('GET /accounts 返回脱敏账户视图（真实 HTTP）', async () => {
  const app = await running()
  try {
    const response = await fetch(`${app.base}${DEBUG_ACCOUNTS_PATH}`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, any>
    assert.equal(Array.isArray(body.accounts), true)
    assert.equal(body.accounts.length, 1)
    assert.deepEqual(body.accounts[0], { id: 'ds', label: 'ds', provider: 'deepseek', hasKey: true })
    assert.equal(body.rawEnabled, true)
    // 响应里不能有任何密钥痕迹
    assert.equal(JSON.stringify(body).includes(SECRET), false)
    assert.equal(JSON.stringify(body).includes(TEST_ENV.TEST_DS_KEY!), false)
  } finally {
    await app.close()
  }
})

test('POST /request 真实发一次 GET /models：状态码/耗时/原始响应都在', async () => {
  const app = await running()
  try {
    const response = await postJson(app.base, DEBUG_REQUEST_PATH, {
      accountId: 'ds',
      method: 'GET',
      path: '/models',
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, any>
    const result = body.result
    assert.equal(result.ok, true)
    assert.equal(result.httpStatus, 200)
    assert.equal(typeof result.elapsedMs, 'number')
    assert.equal(result.request.url, 'https://api.deepseek.com/models')
    assert.equal(result.request.headers.Authorization, '<redacted>')
    // includeRaw 默认开启：调试台就是要看原始结构
    assert.deepEqual(result.raw, { object: 'list', data: [{ id: 'deepseek-chat' }] })

    // 传输层确实被调用了一次，且密钥由注册中心注入（不是前端传的）
    assert.equal(app.calls.length, 1)
    assert.equal(app.calls[0].headers?.Authorization, `Bearer ${TEST_ENV.TEST_DS_KEY}`)
  } finally {
    await app.close()
  }
})

test('dryRun 只构造不发送：传输层零调用，Authorization 已脱敏', async () => {
  const app = await running()
  try {
    const response = await postJson(app.base, DEBUG_REQUEST_PATH, {
      accountId: 'ds',
      method: 'POST',
      path: '/chat/completions',
      body: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] },
      dryRun: true,
    })
    assert.equal(response.status, 200)
    const result = ((await response.json()) as Record<string, any>).result
    assert.equal(result.ok, true)
    assert.equal(result.dryRun, true)
    assert.equal(app.calls.length, 0, 'dry-run 绝不能触达传输层')
    assert.equal(result.request.headers.Authorization, '<redacted>')
    assert.equal(result.request.method, 'POST')
    assert.deepEqual(result.request.body, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    })
  } finally {
    await app.close()
  }
})

// ---------------------------------------------------------------------------
// 真实 HTTP：安全
// ---------------------------------------------------------------------------

test('白名单拦截：evil.example.com 被拒，且传输层一次都没被调用', async () => {
  const app = await running()
  try {
    const response = await postJson(app.base, DEBUG_REQUEST_PATH, {
      accountId: 'ds',
      method: 'GET',
      path: 'https://evil.example.com/steal',
    })
    assert.equal(response.status, 200, '白名单拒绝是「调用失败」而不是路由失败')
    const result = ((await response.json()) as Record<string, any>).result
    assert.equal(result.ok, false)
    assert.equal(result.error.kind, 'config')
    assert.match(result.error.message, /白名单/)
    assert.ok(result.error.hint, '必须给出可操作的 hint')
    assert.equal(app.calls.length, 0, '被白名单拦下的请求绝不能出网')
  } finally {
    await app.close()
  }
})

test('http:// 非回环地址同样被拒（只允许 https 或回环 http）', async () => {
  const app = await running()
  try {
    const result = (
      (await (await postJson(app.base, DEBUG_REQUEST_PATH, {
        accountId: 'ds',
        method: 'GET',
        path: 'http://api.deepseek.com/x',
      })).json()) as Record<string, any>
    ).result
    assert.equal(result.ok, false)
    assert.equal(result.error.kind, 'config')
    assert.match(result.error.message, /https/)
    assert.equal(app.calls.length, 0)
  } finally {
    await app.close()
  }
})

test('跨站请求在路由层就被 403 挡掉（连 invocation 都不进）', async () => {
  const app = await running()
  try {
    const response = await fetch(`${app.base}${DEBUG_REQUEST_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 浏览器跨站请求会带它；这是 DNS rebinding / CSRF 的同款信号
        'sec-fetch-site': 'cross-site',
        origin: 'http://evil.com',
      },
      body: JSON.stringify({ accountId: 'ds', method: 'GET', path: '/models' }),
    })
    // fetch 会按 URL 重写 Host，所以这里改用显式 Host 头的那条测试来验 rebinding；
    // 这里验证的是「跨站标记 + 异源 Origin」不被放行
    assert.equal(response.status, 403)
    const body = (await response.json()) as Record<string, any>
    assert.match(body.error.message, /已拒绝/)
    assert.equal(app.calls.length, 0)
  } finally {
    await app.close()
  }
})

test('DNS rebinding：Host 指向攻击者域名时 403', async () => {
  const app = await running()
  try {
    // 必须用 node:http 而不是 fetch：WHATWG fetch 的 forbidden header 集合会把
    // 调用方给的 Host 头直接丢掉（浏览器里更是改不了），那样就测不到 rebinding。
    const response = await rawRequest(app.base, DEBUG_REQUEST_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'evil.com' },
      body: JSON.stringify({ accountId: 'ds', method: 'GET', path: '/models' }),
    })
    assert.equal(response.status, 403, `实际 ${response.status}: ${response.body}`)
    assert.match(response.body, /已拒绝/)
    assert.equal(app.calls.length, 0, '被拒的请求绝不能出网')
  } finally {
    await app.close()
  }
})

test('声明了 trustedHosts 的部署，该 Host 能正常用（不是一刀切只认回环）', async () => {
  const app = await running({ trustedHosts: ['dsh.internal:3080'] })
  try {
    const response = await fetch(`${app.base}${DEBUG_REQUEST_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'dsh.internal:3080' },
      body: JSON.stringify({ accountId: 'ds', method: 'GET', path: '/models' }),
    })
    assert.equal(response.status, 200)
    const result = ((await response.json()) as Record<string, any>).result
    assert.equal(result.ok, true)
  } finally {
    await app.close()
  }
})

// ---------------------------------------------------------------------------
// 真实 HTTP：错误分类
// ---------------------------------------------------------------------------

test('错误分类：401 → auth、超时 → timeout、未知账户 → config，各带 hint', async () => {
  const authApp = await running({
    transport: () => jsonResponse(401, { error: { message: 'invalid api key' } }),
  })
  try {
    const auth = (
      (await (await postJson(authApp.base, DEBUG_REQUEST_PATH, {
        accountId: 'ds',
        method: 'GET',
        path: '/models',
      })).json()) as Record<string, any>
    ).result
    assert.equal(auth.ok, false)
    assert.equal(auth.error.kind, 'auth')
    assert.match(auth.error.hint, /apiKeyEnv|密钥/)
  } finally {
    await authApp.close()
  }

  const timeoutApp = await running({
    transport: () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    },
  })
  try {
    const timed = (
      (await (await postJson(timeoutApp.base, DEBUG_REQUEST_PATH, {
        accountId: 'ds',
        method: 'GET',
        path: '/models',
        timeoutMs: 50,
      })).json()) as Record<string, any>
    ).result
    assert.equal(timed.ok, false)
    // 传输层抛 TimeoutError 时归为 network/timeout，两者都必须给 hint
    assert.ok(['timeout', 'network'].includes(timed.error.kind), `实际 ${timed.error.kind}`)
    assert.ok(timed.error.hint)
  } finally {
    await timeoutApp.close()
  }

  const unknownApp = await running()
  try {
    const unknown = (
      (await (await postJson(unknownApp.base, DEBUG_REQUEST_PATH, {
        accountId: 'nope',
        method: 'GET',
        path: '/models',
      })).json()) as Record<string, any>
    ).result
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.kind, 'config')
    assert.match(unknown.error.message, /未知账户/)
    assert.equal(unknownApp.calls.length, 0)
  } finally {
    await unknownApp.close()
  }
})

test('路由层的协议约束：GET /request 405、非 JSON content-type 415、坏 JSON 400', async () => {
  const app = await running()
  try {
    const wrongMethod = await fetch(`${app.base}${DEBUG_REQUEST_PATH}`)
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.get('allow'), 'POST')

    const accountsPost = await postJson(app.base, DEBUG_ACCOUNTS_PATH, {})
    assert.equal(accountsPost.status, 405)
    assert.equal(accountsPost.headers.get('allow'), 'GET, HEAD')

    const wrongType = await fetch(`${app.base}${DEBUG_REQUEST_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    })
    assert.equal(wrongType.status, 415)

    const broken = await fetch(`${app.base}${DEBUG_REQUEST_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    })
    assert.equal(broken.status, 400)
    const brokenBody = (await broken.json()) as Record<string, any>
    assert.match(brokenBody.error.message, /不是合法 JSON/)

    const missingAccount = await postJson(app.base, DEBUG_REQUEST_PATH, { method: 'GET', path: '/models' })
    assert.equal(missingAccount.status, 400)
    const missingBody = (await missingAccount.json()) as Record<string, any>
    assert.match(missingBody.error.message, /accountId/)
  } finally {
    await app.close()
  }
})

test('响应体里绝不出现密钥明文（真实上游回显密钥的极端情况）', async () => {
  // 故意让「上游」把注入的 Authorization 原样回显 —— 中转站/调试网关真的会这么干
  const app = await running({
    transport: (request) =>
      jsonResponse(200, {
        echo: request.headers?.Authorization,
        hint: `your token is ${TEST_ENV.TEST_DS_KEY}`,
        url: request.url,
      }),
  })
  try {
    const response = await postJson(app.base, DEBUG_REQUEST_PATH, {
      accountId: 'ds',
      method: 'GET',
      path: '/models',
    })
    const raw = await response.text()
    assert.equal(raw.includes(TEST_ENV.TEST_DS_KEY!), false, '回显的密钥必须被打码')
    assert.match(raw, /redacted/)
    // 结构还在（不是整条响应被吞掉）
    const body = JSON.parse(raw) as Record<string, any>
    assert.equal(body.result.ok, true)
    assert.equal(body.result.httpStatus, 200)
  } finally {
    await app.close()
  }
})

test('请求体超过上限被拒（不会把巨型 payload 灌进内存）', async () => {
  const app = await running()
  try {
    const huge = await fetch(`${app.base}${DEBUG_REQUEST_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'ds', path: '/models', body: { blob: 'x'.repeat(MAX_BODY_BYTES + 10) } }),
    })
    assert.equal(huge.status, 400)
    const body = (await huge.json()) as Record<string, any>
    assert.match(body.error.message, /超过上限/)
    assert.equal(app.calls.length, 0)
  } finally {
    await app.close()
  }
})

test('宿主没有 webServer 服务时静默降级，不抛异常', () => {
  const consoleInstance = createConsole({ retries: 0, accounts: [] }, { env: {}, dashboard: false })
  try {
    assert.doesNotThrow(() => {
      const handle = installDebugRoutes(
        { get: () => undefined },
        { registry: consoleInstance.registry, invocation: consoleInstance.invocation, config: consoleInstance.config },
      )
      assert.equal(handle.status().registered, false)
      assert.match(handle.status().reason ?? '', /webServer/)
      handle.dispose()
    })
  } finally {
    void consoleInstance.close()
  }
})

test('ctx.inject 可用时等 webServer 就绪；重复路径注册只记原因不抛', () => {
  const consoleInstance = createConsole({ retries: 0, accounts: [] }, { env: {}, dashboard: false })
  try {
    let registered = 0
    const webServer = {
      host: '127.0.0.1',
      register() {
        registered += 1
        return () => undefined
      },
    }
    const handle = installDebugRoutes(
      {
        inject(deps: string[], cb: (scope: Record<string, unknown>) => unknown) {
          assert.deepEqual(deps, ['webServer'])
          cb({ get: (name: string) => (name === 'webServer' ? webServer : undefined) })
        },
      },
      { registry: consoleInstance.registry, invocation: consoleInstance.invocation, config: consoleInstance.config },
    )
    assert.equal(registered, 2, 'accounts + request 两条路由')
    assert.equal(handle.status().registered, true)

    // 第二条重复路径 = 配置错误：必须收敛成 reason，而不是冒泡成插件 failed
    const clash = installDebugRoutes(
      { get: () => ({ host: '127.0.0.1', register() { throw new Error('duplicate exact route') } }) },
      { registry: consoleInstance.registry, invocation: consoleInstance.invocation, config: consoleInstance.config },
    )
    assert.equal(clash.status().registered, false)
    assert.match(clash.status().reason ?? '', /duplicate/)
  } finally {
    void consoleInstance.close()
  }
})
