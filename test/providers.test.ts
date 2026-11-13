import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BalancePreset, HttpRequestSpec, ProviderSpec } from '../src/types.ts'
import { resolveConfig } from '../src/config.ts'
import { ConsoleRegistry } from '../src/core/registry.ts'
import { getMapper, mapperNames, parseModelList, type MapperContext } from '../src/providers/mappers.ts'
import { BUILTIN_PROVIDER_SPECS } from '../src/providers/specs.ts'
import { compileCustomProvider, SpecAdapter, authHeaders } from '../src/providers/index.ts'
import { joinUrl } from '../src/core/util.ts'
import { jsonResponse, TEST_ENV } from './helpers.ts'

function builtin(id: string): ProviderSpec {
  const spec = BUILTIN_PROVIDER_SPECS.find((item) => item.id === id)
  assert.ok(spec, `内置服务商 ${id} 应存在`)
  return spec
}

function registryFor(providerId: string, preset: BalancePreset = 'auto'): ConsoleRegistry {
  const config = resolveConfig({
    accounts: [{ id: 'a', provider: providerId, apiKeyEnv: 'TEST_DS_KEY', balancePreset: preset }],
  })
  return new ConsoleRegistry(config, { env: TEST_ENV })
}

/** 用真实 spec/账户 + 指定的 mapper 构造映射上下文。 */
function mapWith(providerId: string, mapperName: string, body: unknown) {
  const spec = builtin(providerId)
  const registry = registryFor(providerId)
  const account = registry.account('a')
  const request: HttpRequestSpec = {
    method: 'GET',
    url: 'https://example.com/probe',
    balanceProbe: { kind: 'money', mapper: mapperName },
  }
  const ctx: MapperContext = { response: jsonResponse(200, body), account, spec, request }
  const mapper = getMapper(mapperName)
  assert.ok(mapper, `映射器 ${mapperName} 应已注册（可用: ${mapperNames().join(',')}）`)
  const result = mapper(ctx)
  registry.dispose()
  return result
}

/** 走完整链路：adapter 构造请求 → mapper 解析响应。 */
function mapFirst(providerId: string, body: unknown) {
  const spec = builtin(providerId)
  const adapter = new SpecAdapter(spec)
  const registry = registryFor(providerId)
  const account = registry.account('a')
  const request = adapter.balanceRequests(account)[0]
  assert.ok(request, `${providerId} 应产生余额请求`)
  const mapper = getMapper(request.balanceProbe?.mapper)
  assert.ok(mapper)
  const result = adapter.parseBalance(jsonResponse(200, body), account, request)
  registry.dispose()
  return result
}

test('DeepSeek 官方余额响应 → 统一结构', () => {
  const payload = mapFirst('deepseek', {
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
  })
  assert.equal(payload.total, 110)
  assert.equal(payload.currency, 'CNY')
  assert.equal(payload.breakdown?.['赠金'], 10)
  assert.equal(payload.breakdown?.['充值'], 100)
  assert.equal(payload.available, true)
})

test('Kimi 国内站 CNY / 国际站 USD，欠费给出预警', () => {
  const cn = mapFirst('moonshot-cn', {
    code: 0,
    data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
    status: true,
  })
  assert.equal(cn.total, 49.58894)
  assert.equal(cn.currency, 'CNY')
  assert.equal(cn.breakdown?.['代金券'], 46.58893)

  const globalBody = { code: 0, data: { available_balance: 3, voucher_balance: 3, cash_balance: -1 } }
  const globalSpec = builtin('moonshot-global')
  const globalRegistry = registryFor('moonshot-global')
  const globalRequest = new SpecAdapter(globalSpec).balanceRequests(globalRegistry.account('a'))[0]
  const global = new SpecAdapter(globalSpec).parseBalance(jsonResponse(200, globalBody), globalRegistry.account('a'), globalRequest)
  assert.equal(global.currency, 'USD')
  assert.ok(global.warnings?.some((w) => w.includes('欠费')))
  globalRegistry.dispose()
})

test('硅基流动：余额接口已下线，不再构造任何余额请求（对话能力保留）', () => {
  const spec = builtin('siliconflow')
  // 官方 Release Notes 2026.08.11 公告：/user/info 于 2026-08-14 停用，替代接口未公布
  assert.equal(spec.balance.kind, 'unsupported')
  assert.match(spec.balance.note ?? '', /2026-08-14/)
  assert.match(spec.balance.note ?? '', /停用/)
  assert.match(spec.balance.note ?? '', /manual/)
  // 关键：不能再有 url，否则会真的去打一个返回 410 的端点
  assert.equal(spec.balance.url, undefined)
  assert.equal(spec.balanceFallbacks, undefined)

  const registry = registryFor('siliconflow')
  assert.equal(
    new SpecAdapter(spec).balanceRequests(registry.account('a')).length,
    0,
    '已下线的端点绝不能出现在请求里',
  )
  registry.dispose()

  // 对话能力必须仍然可用：chat base / 模型列表 / 默认模型都不受影响
  assert.equal(spec.chatBaseUrl, 'https://api.siliconflow.cn/v1')
  assert.equal(spec.chatPath, '/chat/completions')
  assert.equal(spec.modelsPath, '/models?sub_type=chat')
  assert.ok(spec.defaultModels.length > 0)
})

test('硅基流动：对话调用照常构造请求并带上 Bearer 鉴权', () => {
  const spec = builtin('siliconflow')
  const adapter = new SpecAdapter(spec)
  const registry = registryFor('siliconflow')
  const account = registry.account('a')
  assert.equal(account.provider, 'siliconflow')
  assert.equal(account.apiKey, 'sk-unit-test-deepseek')
  // 余额请求为空，但对话端点、鉴权与模型都在
  assert.deepEqual(adapter.balanceRequests(account), [])
  assert.equal(joinUrl(account.chatBaseUrl, spec.chatPath), 'https://api.siliconflow.cn/v1/chat/completions')
  assert.equal(authHeaders(account).Authorization, 'Bearer sk-unit-test-deepseek')
  assert.ok(spec.modelsPath, '模型列表端点仍在，provider_models 可用')
  registry.dispose()
})

test('硅基流动：balancePreset=manual 是推荐替代，能给出可用余额视图', () => {
  const config = resolveConfig({
    accounts: [
      {
        id: 'sf',
        provider: 'siliconflow',
        apiKeyEnv: 'TEST_QWEN_KEY',
        balancePreset: 'manual',
        manual: { total: 88.88, currency: 'CNY', note: '控制台抄录' },
      },
    ],
  })
  const registry = new ConsoleRegistry(config, { env: TEST_ENV })
  const info = registry.listAccounts()[0]
  // spec 层面是 unsupported，但账户用 manual 覆盖后，UI 上走手工录入路径
  assert.equal(info.balancePreset, 'manual')
  assert.equal(info.hasApiKey, true)
  registry.dispose()
})

test('硅基流动 mapper 仍可被自定义服务商显式使用（保留但标注已下线）', () => {
  const payload = mapWith('siliconflow', 'siliconflow', {
    code: 20000,
    status: true,
    data: { balance: '0.88', chargeBalance: '88.00', totalBalance: '88.88' },
  })
  assert.equal(payload.total, 88.88)
  assert.equal(payload.breakdown?.['充值'], 88)
  assert.equal(payload.currency, 'CNY')
  assert.ok(
    payload.warnings?.some((w) => w.includes('2026-08-14')),
    'mapper 输出必须提示该端点已停用',
  )
})

test('智谱三种探针：旧版余额 / 账户报告 / 套餐配额', () => {
  const legacy = mapWith('zhipu', 'zhipu-legacy', {
    balanceInfo: { balance: 19.94, giftBalance: 0, voucherBalance: 0, usedTokens: 1234 },
  })
  assert.equal(legacy.total, 19.94)
  assert.ok(legacy.warnings?.some((w) => w.includes('旧版')))

  const report = mapWith('zhipu', 'zhipu-report', {
    code: 200,
    data: { balance: 19.94012911, rechargeAmount: 20, giveAmount: 0, totalSpendAmount: 0.0599 },
  })
  assert.equal(report.total, 19.94012911)
  assert.equal(report.breakdown?.['累计消费'], 0.0599)

  const quota = mapWith('zhipu', 'zhipu-quota', {
    code: 200,
    success: true,
    data: {
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, currentValue: 5040, usage: 12000, remaining: 6960, percentage: 42 },
        { type: 'CREDIT_LIMIT', unit: 6, currentValue: 7800, usage: 60000, percentage: 13 },
        { type: 'TIME_LIMIT', currentValue: 25, usage: 500, percentage: 5 },
      ],
    },
  })
  assert.equal(quota.quotas?.length, 3)
  assert.equal(quota.quotas?.[0].name, '5 小时窗口')
  assert.equal(quota.quotas?.[0].usedPercent, 42)
  assert.equal(quota.quotas?.[2].name, '月度工具')
})

test('balancePreset 决定智谱探针链：auto=3 / money=2 / quota=1 / manual=0', () => {
  const spec = builtin('zhipu')
  const adapter = new SpecAdapter(spec)
  const counts: Record<string, number> = {}
  for (const preset of ['auto', 'money', 'quota', 'manual'] as const) {
    const registry = registryFor('zhipu', preset)
    counts[preset] = adapter.balanceRequests(registry.account('a')).length
    registry.dispose()
  }
  assert.deepEqual(counts, { auto: 3, money: 2, quota: 1, manual: 0 })
})

test('余额请求：URL 与 Bearer 鉴权正确，且端点都标了用途', () => {
  const registry = registryFor('deepseek')
  const requests = new SpecAdapter(builtin('deepseek')).balanceRequests(registry.account('a'))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://api.deepseek.com/user/balance')
  assert.equal(requests[0].method, 'GET')
  assert.equal(requests[0].headers?.Authorization, 'Bearer sk-unit-test-deepseek')
  assert.match(requests[0].purpose ?? '', /余额查询/)
  registry.dispose()
})

test('无余额接口的平台：不产生请求，且给出替代方案说明', () => {
  for (const id of ['dashscope', 'volcengine', 'qianfan', 'hunyuan']) {
    const spec = builtin(id)
    const registry = registryFor(id)
    assert.equal(new SpecAdapter(spec).balanceRequests(registry.account('a')).length, 0, id)
    assert.match(spec.balance.note ?? '', /manual|接口|余额/)
    registry.dispose()
  }
})

test('自定义服务商：jsonPath 声明式映射无需写代码', () => {
  const spec = compileCustomProvider({
    id: 'proxy',
    chatBaseUrl: 'https://proxy.example.com/v1',
    balance: { kind: 'money', url: 'https://proxy.example.com/v1/balance' },
    balanceMap: { total: 'data.balance', currency: 'data.currency', breakdown: { 赠金: 'data.gift' } },
  })
  const adapter = new SpecAdapter(spec)
  const config = resolveConfig({
    providers: [
      {
        id: 'proxy',
        chatBaseUrl: 'https://proxy.example.com/v1',
        balance: { kind: 'money', url: '/v1/balance' },
        balanceMap: { total: 'data.balance', currency: 'data.currency', breakdown: { 赠金: 'data.gift' } },
      },
    ],
    accounts: [{ id: 'p', provider: 'proxy', apiKeyEnv: 'TEST_QWEN_KEY' }],
  })
  const registry = new ConsoleRegistry(config, { env: TEST_ENV })
  const account = registry.account('p')
  const request = adapter.balanceRequests(account)[0]
  assert.equal(request.url, 'https://proxy.example.com/v1/balance')

  const mapper = getMapper('jsonPath')!
  const response = jsonResponse(200, { data: { balance: '12.5', currency: 'CNY', gift: 2 } })
  const payload = mapper({ response, account, spec: registry.adapter('proxy').spec, request })
  assert.equal(payload.total, 12.5)
  assert.equal(payload.currency, 'CNY')
  assert.equal(payload.breakdown?.['赠金'], 2)
  registry.dispose()
})

test('模型列表解析兼容 {data:[{id}]} / 字符串数组 / {models:[{name}]}', () => {
  assert.deepEqual(parseModelList(jsonResponse(200, { data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] })), ['a', 'b'])
  assert.deepEqual(parseModelList(jsonResponse(200, ['x', 'y'])), ['x', 'y'])
  assert.deepEqual(parseModelList(jsonResponse(200, { models: [{ name: 'm1' }] })), ['m1'])
  assert.deepEqual(parseModelList(jsonResponse(200, { unexpected: true })), [])
})
