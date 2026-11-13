import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConsole } from '../src/server.ts'
import { jsonResponse, mockTransport, TEST_ENV } from './helpers.ts'

const DEEPSEEK_OK = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
}

function fixture() {
  let failBalance = false
  const mock = mockTransport((request) => {
    if (request.url.includes('/user/balance')) {
      if (failBalance) return jsonResponse(503, { message: 'upstream down' })
      return jsonResponse(200, DEEPSEEK_OK)
    }
    if (request.url.includes('/v1/users/me/balance')) {
      return jsonResponse(401, { error: { message: 'Invalid API key', code: 'invalid_api_key' } })
    }
    return jsonResponse(404, { error: { message: 'unknown' } })
  })
  const consoleInstance = createConsole(
    {
      retries: 0,
      retryBaseMs: 1,
      cacheTtlMs: 60_000,
      accounts: [
        { id: 'ds-main', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY', label: 'DeepSeek 主账号' },
        { id: 'kimi-main', provider: 'moonshot-cn', apiKeyEnv: 'TEST_KIMI_KEY', label: 'Kimi' },
        { id: 'qwen-main', provider: 'dashscope', apiKeyEnv: 'TEST_QWEN_KEY', label: '通义千问' },
        {
          id: 'manual-acc',
          provider: 'deepseek',
          apiKeyEnv: 'TEST_DS_KEY',
          label: '手工录入',
          balancePreset: 'manual',
          manual: { total: 50, currency: 'CNY', note: '控制台抄录' },
        },
        { id: 'low-acc', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY', label: '低余额', lowBalanceThreshold: 200 },
      ],
    },
    { transport: mock.transport, env: TEST_ENV, dashboard: false },
  )
  return { consoleInstance, mock, setFail: (value: boolean) => (failBalance = value) }
}

test('多账户刷新：成功 / 鉴权失败 / 不支持 / 手工 / 阈值预警各行独立', async () => {
  const { consoleInstance } = fixture()
  try {
    const report = await consoleInstance.refreshBalances({ force: true })
    const byId = Object.fromEntries(report.accounts.map((item) => [item.accountId, item]))
    assert.equal(byId['ds-main'].status, 'ok')
    assert.equal(byId['ds-main'].total, 110)
    assert.equal(byId['ds-main'].breakdown?.['赠金'], 10)

    assert.equal(byId['kimi-main'].status, 'error')
    assert.equal(byId['kimi-main'].error?.kind, 'auth')
    assert.match(byId['kimi-main'].error?.hint ?? '', /Key/)

    assert.equal(byId['qwen-main'].status, 'unsupported')
    assert.match(byId['qwen-main'].note ?? '', /百炼|余额/)

    assert.equal(byId['manual-acc'].status, 'manual')
    assert.equal(byId['manual-acc'].total, 50)
    assert.equal(byId['manual-acc'].stale, true)

    assert.ok(report.warnings.some((w) => w.includes('低余额') && w.includes('预警阈值')))
    assert.equal(report.counts.ok, 2)
    assert.equal(report.counts.error, 1)
    assert.equal(report.counts.unsupported, 1)
    assert.equal(report.counts.manual, 1)
    assert.equal(report.totals.find((t) => t.currency === 'CNY')?.total, 270)
  } finally {
    await consoleInstance.close()
  }
})

test('TTL 缓存：未过期直接命中缓存，force 才联网', async () => {
  const { consoleInstance, mock } = fixture()
  try {
    const first = await consoleInstance.refreshBalances({ force: true, accountIds: ['ds-main'] })
    assert.equal(first.counts.cached, 0)
    const callsAfterFirst = mock.calls.length

    const second = await consoleInstance.refreshBalances({ accountIds: ['ds-main'] })
    assert.equal(mock.calls.length, callsAfterFirst, '缓存命中不应发网络请求')
    assert.equal(second.accounts[0].fromCache, true)
    assert.equal(second.accounts[0].stale, false)

    const forced = await consoleInstance.refreshBalances({ force: true, accountIds: ['ds-main'] })
    assert.ok(mock.calls.length > callsAfterFirst)
    assert.equal(forced.counts.cached, 0)
  } finally {
    await consoleInstance.close()
  }
})

test('软失败：全部探针失败时保留上次成功值并标记 stale', async () => {
  const { consoleInstance, setFail } = fixture()
  try {
    await consoleInstance.refreshBalances({ force: true })
    setFail(true)
    const report = await consoleInstance.refreshBalances({ force: true, accountIds: ['ds-main'] })
    const item = report.accounts[0]
    assert.equal(item.status, 'stale')
    assert.equal(item.stale, true)
    assert.equal(item.fromCache, true)
    assert.equal(item.total, 110, '应保留上次成功的余额')
    assert.equal(item.error?.kind, 'server')
    assert.ok(item.warnings.some((w) => w.includes('缓存值')))
  } finally {
    await consoleInstance.close()
  }
})

test('只读缓存模式不发网络请求', async () => {
  const { consoleInstance, mock } = fixture()
  try {
    await consoleInstance.refreshBalances({ force: true })
    const calls = mock.calls.length
    const cached = consoleInstance.balances.snapshot()
    assert.equal(mock.calls.length, calls)
    assert.ok(cached.accounts.every((item) => item.fromCache))
  } finally {
    await consoleInstance.close()
  }
})

test('事件订阅能收到刷新结果', async () => {
  const { consoleInstance } = fixture()
  const seen: number[] = []
  const off = consoleInstance.balances.onUpdate((report) => seen.push(report.accounts.length))
  try {
    await consoleInstance.refreshBalances({ force: true })
    off()
    await consoleInstance.refreshBalances({ force: true })
    assert.deepEqual(seen, [5])
  } finally {
    await consoleInstance.close()
  }
})
