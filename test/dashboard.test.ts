/**
 * 看板的配置面：脱敏、默认值一致性，以及真实 HTTP 响应体。
 *
 * publicConfig 单独测纯函数；`/api/state` 的**线路格式**必须走真实 HTTP ——
 * 最容易犯的错误不是 publicConfig 写错，而是路由忘了调用它（把整个
 * ResolvedConfig 直接塞进 JSON），那样 accounts 里的字段会随响应一起出网。
 * 纯函数测试抓不到这一类，所以这里起一个只听 127.0.0.1、端口由内核分配的看板。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDashboard } from '../src/dashboard.ts'
import { publicConfig } from '../src/dashboard.ts'
import { resolveConfig } from '../src/config.ts'
import { HttpClient } from '../src/core/http.ts'
import { ConsoleRegistry } from '../src/core/registry.ts'
import { BalanceService } from '../src/core/balance.ts'
import { InvocationService } from '../src/core/invocation.ts'
import type { ConsoleConfig, Transport } from '../src/types.ts'

/** 起一个临时看板（port:0），把真实 base url 交给 run，结束后一定关掉。 */
async function withDashboard(
  config: ConsoleConfig,
  run: (base: string, resolved: ReturnType<typeof resolveConfig>) => Promise<void>,
): Promise<void> {
  const resolved = resolveConfig(config)
  // 关键：注入 offline transport。/api/state 在缓存为空时会补一次刷新，
  // 用真实 fetch 挂上去会让测试卡在真网络（沙箱里直接超时/悬挂）。
  const http = new HttpClient({ timeoutMs: 2_000, retries: 0, transport: offlineTransport() })
  const registry = new ConsoleRegistry(resolved, { env: {} })
  const balances = new BalanceService({ registry, http, config: resolved })
  const invocation = new InvocationService({ registry, http, config: resolved })
  const dashboard = createDashboard({
    registry,
    balances,
    invocation,
    host: '127.0.0.1',
    port: 0,
    pollMs: resolved.dashboard.pollMs,
    config: resolved,
  })
  try {
    const base = await dashboard.ready()
    assert.ok(base.startsWith('http://127.0.0.1:'), `应绑定在回环地址上，实际 ${base}`)
    await run(base, resolved)
  } finally {
    await dashboard.close()
    balances.close()
    invocation.close()
  }
}

/**
 * 离线传输：任何上游请求都返回 404 的 JSON。
 *
 * 这足以让「缓存为空 → 补一次刷新」这条路径立刻走完并落到 error 状态，
 * 而不是去连真实的 provider 端点。测试关心的是响应体形状，不是余额数值。
 */
function offlineTransport(): Transport {
  return async (request) => ({
    status: 404,
    ok: false,
    headers: { 'content-type': 'application/json' },
    text: JSON.stringify({ error: 'offline-test', url: request.url }),
    elapsedMs: 1,
  })
}

const SECRET = 'sk-live-must-never-leak'
const KEY_ENV = 'MY_DEEPSEEK_KEY'

test('publicConfig 只暴露白名单字段，绝不含密钥相关键', () => {
  const config = resolveConfig({
    accounts: [{ id: 'a1', provider: 'deepseek', apiKey: SECRET, apiKeyEnv: KEY_ENV }],
    lowBalanceThreshold: 20,
    cacheTtlMs: 1234,
  })
  const pub = publicConfig(config)!
  assert.ok(pub)
  const json = JSON.stringify(pub)
  for (const forbidden of [SECRET, KEY_ENV, 'apiKey', 'baseUrl', 'accounts']) {
    assert.equal(json.includes(forbidden), false, `publicConfig 泄漏了 ${forbidden}`)
  }
  assert.deepEqual(Object.keys(pub).sort(), [
    'autoDiscover',
    'autoRefreshMs',
    'cacheTtlMs',
    'dashboard',
    'llmProvider',
    'lowBalanceThreshold',
    'sidebar',
  ])
  assert.equal(pub.lowBalanceThreshold, 20)
  assert.equal(pub.cacheTtlMs, 1234)
})

test('publicConfig(undefined) 返回 null，页面据此走「无配置」分支', () => {
  assert.equal(publicConfig(undefined), null)
})

test('/api/state 的响应体走 publicConfig，密钥一个字节都不出网', async () => {
  await withDashboard(
    {
      accounts: [{ id: 'a1', provider: 'deepseek', apiKey: SECRET, apiKeyEnv: KEY_ENV }],
      lowBalanceThreshold: 42,
      cacheTtlMs: 777,
      sidebar: { label: '我的控制台', order: 33 },
    },
    async (base) => {
      const res = await fetch(`${base}/api/state`, { cache: 'no-store' })
      assert.equal(res.status, 200)
      const body = (await res.json()) as Record<string, any>

      // 页面需要的结构必须齐全
      for (const key of ['generatedAt', 'accounts', 'providers', 'report', 'config']) {
        assert.ok(key in body, `响应缺少 ${key}`)
      }
      // 脱敏：整条响应里不能出现明文密钥，也不能出现 apiKey 字段本身
      const raw = JSON.stringify(body)
      assert.equal(raw.includes(SECRET), false, '响应体泄漏了明文密钥')
      assert.equal(/"apiKey"\s*:/.test(raw), false, '响应体出现了 apiKey 字段')
      // 注意：apiKeySource 里会带**环境变量名**（"credentials:MY_DEEPSEEK_KEY"）。
      // 那是凭据来源的展示信息，不是密钥值，且环境变量名对同一用户本就可见，
      // 因此不算泄漏；真正的红线是上面的明文密钥与 apiKey 字段。
      // accounts 是脱敏后的视图：只有 hasApiKey 布尔，没有密钥内容
      assert.equal(body.accounts.length, 1)
      assert.equal(typeof body.accounts[0].hasApiKey, 'boolean')
      assert.equal(
        Object.prototype.hasOwnProperty.call(body.accounts[0], 'apiKey'),
        false,
        'accounts 视图不应带 apiKey 字段',
      )

      // config 必须是 publicConfig 的形状
      const pub = body.config as Record<string, any>
      assert.deepEqual(pub, publicConfig(resolveConfig({
        accounts: [{ id: 'a1', provider: 'deepseek' }],
        lowBalanceThreshold: 42,
        cacheTtlMs: 777,
        sidebar: { label: '我的控制台', order: 33 },
      })))
      assert.equal(pub.lowBalanceThreshold, 42)
      assert.equal(pub.cacheTtlMs, 777)
      assert.equal(pub.sidebar.label, '我的控制台')
      assert.equal(pub.sidebar.order, 33)
    },
  )
})

test('/api/state 在没有配置时 config 为 null（不吐半个对象）', async () => {
  const resolved = resolveConfig({})
  const http = new HttpClient({ timeoutMs: 2_000, retries: 0, transport: offlineTransport() })
  const registry = new ConsoleRegistry(resolved, { env: {} })
  const balances = new BalanceService({ registry, http, config: resolved })
  const invocation = new InvocationService({ registry, http, config: resolved })
  // 故意不传 config —— 等价于「某个调用方忘了接」
  const dashboard = createDashboard({
    registry,
    balances,
    invocation,
    host: '127.0.0.1',
    port: 0,
    pollMs: 1000,
  })
  try {
    const base = await dashboard.ready()
    const body = (await (await fetch(`${base}/api/state`)).json()) as Record<string, any>
    assert.equal(body.config, null, '没有配置时应返 null，而不是 {} 或抛错')
  } finally {
    await dashboard.close()
    balances.close()
    invocation.close()
  }
})

test('/api/health 与 404 的既有行为不变', async () => {
  await withDashboard({ accounts: [{ id: 'a1', provider: 'deepseek' }] }, async (base) => {
    const health = (await (await fetch(`${base}/api/health`)).json()) as Record<string, any>
    assert.equal(health.ok, true)
    assert.equal(health.accounts, 1)

    const missing = await fetch(`${base}/api/nope`)
    assert.equal(missing.status, 404)
  })
})

test('/ 返回注入过 pollMs 的页面，且页面已切到 token 化主题', async () => {
  await withDashboard({ accounts: [], dashboard: { enabled: true, pollMs: 3000 } }, async (base) => {
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    const html = await res.text()
    // 占位符必须被替换掉，否则页面的 setInterval 会拿到 NaN
    assert.equal(html.includes('__POLL_MS__'), false, '__POLL_MS__ 占位符未被替换')
    assert.match(html, /const POLL_MS = 3000/)
    // 主题相关：不能再有旧的硬编码暗色套件
    assert.equal(html.includes('#171a21'), false)
    assert.match(html, /params\.get\('theme'\)/)
    assert.match(html, /--dsw-alias-label-primary/)
  })
})

test('close() 之后端口确实释放（可以立刻被重新占用）', async () => {
  const resolved = resolveConfig({})
  const http = new HttpClient({ timeoutMs: 2_000, retries: 0, transport: offlineTransport() })
  const registry = new ConsoleRegistry(resolved, { env: {} })
  const dashboard = createDashboard({
    registry,
    balances: new BalanceService({ registry, http, config: resolved }),
    invocation: new InvocationService({ registry, http, config: resolved }),
    host: '127.0.0.1',
    port: 0,
    pollMs: 1000,
  })
  const base = await dashboard.ready()
  const port = Number(new URL(base).port)
  await dashboard.close()
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/health`), '关闭后不应还能连上')
  // 幂等：再关一次也不能抛
  await dashboard.close()
})

// ---------------------------------------------------------------------------
// 纯归一化
// ---------------------------------------------------------------------------

test('publicConfig 的 dashboard / sidebar / llmProvider 与 normalize 结果一致', () => {
  const config = resolveConfig({
    dashboard: { enabled: false, port: 9999, pollMs: 7000 },
    sidebar: { enabled: false, label: '我的控制台', order: 44 },
    llmProvider: { enabled: false, routePrefix: 'zz' },
  })
  const pub = publicConfig(config)!
  assert.deepEqual(pub.dashboard, { enabled: false, host: '127.0.0.1', port: 9999, pollMs: 7000 })
  assert.deepEqual(pub.sidebar, { enabled: false, label: '我的控制台', order: 44 })
  assert.deepEqual(pub.llmProvider, { enabled: false, routePrefix: 'zz' })
})

test('sidebar 归一化：默认值、空标签回退、order 越界收敛', () => {
  assert.deepEqual(resolveConfig({}).sidebar, {
    enabled: true,
    label: '服务商控制台',
    order: 20,
  })
  // 空/纯空白 label 要回退到默认，否则左侧栏出现一个没有名字的图标
  assert.equal(resolveConfig({ sidebar: { label: '   ' } }).sidebar.label, '服务商控制台')
  assert.equal(resolveConfig({ sidebar: { label: '' } }).sidebar.label, '服务商控制台')
  // enabled 只认严格的 false，其它一律视为开启（与 client.js 的 !== false 一致）
  assert.equal(resolveConfig({ sidebar: { enabled: false } }).sidebar.enabled, false)
  assert.equal(resolveConfig({}).sidebar.enabled, true)
  // order 是个数字就保留，极端值收敛而不是让排序器崩
  assert.equal(resolveConfig({ sidebar: { order: 0 } }).sidebar.order, 0)
  assert.equal(resolveConfig({ sidebar: { order: -5 } }).sidebar.order, -5)
  assert.equal(resolveConfig({ sidebar: { order: Number.POSITIVE_INFINITY } }).sidebar.order, 1_000_000)
  // dashboardUrl 只有显式给了才出现（undefined 不写进对象，避免 JSON 里出现 null）
  assert.equal('dashboardUrl' in resolveConfig({}).sidebar, false)
  assert.equal(
    resolveConfig({ sidebar: { dashboardUrl: 'http://127.0.0.1:1/' } }).sidebar.dashboardUrl,
    'http://127.0.0.1:1/',
  )
})

test('sidebar 与 dashboard 的默认值互相独立（关看板不影响入口）', () => {
  const config = resolveConfig({ dashboard: { enabled: false } })
  assert.equal(config.dashboard.enabled, false)
  assert.equal(config.sidebar.enabled, true, 'dashboard 关掉时左侧入口仍应保留（面板自己会提示）')
})
