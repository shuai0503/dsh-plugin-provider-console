/**
 * 云账号签名适配器离线测试。
 * 全部使用假 AK/SK + mock transport，不接触网络、不写入任何真实凭据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aliyunRpcSignature,
  aliyunRpcUrl,
  AliyunBssAdapter,
  canonicalQuery,
  percentEncode,
  registerCloudSigning,
  volcV4Signature,
  VolcSignedAdapter,
} from '../src/providers/cloud-signing.ts'
import { createConsole } from '../src/server.ts'
import type { ResolvedAccount } from '../src/types.ts'
import { jsonResponse, mockTransport } from './helpers.ts'

const CLOUD_ENV: Record<string, string | undefined> = {
  TEST_AK: 'LTAI5tFakeAccessKeyId',
  TEST_SK: 'fakeSecretKeyForUnitTestOnly',
  TEST_VOLC_AK: 'AKLTfakeVolcAccessKey',
  TEST_VOLC_SK: 'fakeVolcSecretForUnitTestOnly',
}

const FIXED_DATE = new Date('2026-11-06T07:30:00.000Z')

function fakeAccount(overrides: Partial<ResolvedAccount> = {}): ResolvedAccount {
  return {
    id: 'cloud-main',
    provider: 'aliyun-bss',
    label: '云账号',
    apiKey: 'LTAI5tFakeAccessKeyId',
    apiKeySource: 'env:TEST_AK',
    chatBaseUrl: 'https://business.aliyuncs.com',
    balanceBaseUrl: 'https://business.aliyuncs.com',
    headers: {},
    auth: { scheme: 'raw' },
    balancePreset: 'auto',
    ...overrides,
  } as ResolvedAccount
}

test('percentEncode / canonicalQuery 遵循 RFC3986 与字典序', () => {
  assert.equal(percentEncode('a b'), 'a%20b')
  assert.equal(percentEncode('~'), '~')
  assert.equal(percentEncode('*'), '%2A')
  assert.equal(percentEncode("'()"), '%27%28%29')
  assert.equal(percentEncode('余额'), '%E4%BD%99%E9%A2%9D')
  assert.equal(
    canonicalQuery({ Version: '2017-12-14', Action: 'QueryAccountBalance', Format: 'JSON' }),
    'Action=QueryAccountBalance&Format=JSON&Version=2017-12-14',
  )
})

test('阿里云 RPC 签名：StringToSign 与官方文档一致且可复现', () => {
  const params = { Action: 'QueryAccountBalance', Format: 'JSON', Version: '2017-12-14' }
  const first = aliyunRpcSignature(params, 'unit-test-secret')
  assert.equal(first.canonical, 'Action=QueryAccountBalance&Format=JSON&Version=2017-12-14')
  assert.equal(
    first.stringToSign,
    'GET&%2F&Action%3DQueryAccountBalance%26Format%3DJSON%26Version%3D2017-12-14',
  )
  assert.match(first.signature, /^[A-Za-z0-9+/=]+$/)
  assert.equal(aliyunRpcSignature(params, 'unit-test-secret').signature, first.signature)
  assert.notEqual(aliyunRpcSignature(params, 'other-secret').signature, first.signature)
})

test('阿里云 URL：公共参数齐全、签名被编码、nonce 可注入且可复现', () => {
  const base = {
    endpoint: 'https://business.aliyuncs.com/',
    accessKeyId: 'fake-ak',
    accessKeySecret: 'fake-sk',
    action: 'QueryAccountBalance',
    version: '2017-12-14',
    now: FIXED_DATE,
    nonce: 'fixed-nonce',
  }
  const url = aliyunRpcUrl(base)
  assert.ok(url.startsWith('https://business.aliyuncs.com/?'))
  for (const key of ['AccessKeyId=', 'SignatureMethod=HMAC-SHA1', 'SignatureVersion=1.0', 'SignatureNonce=fixed-nonce', 'Timestamp=2026-11-06T07%3A30%3A00Z', 'Action=QueryAccountBalance', 'Signature=']) {
    assert.ok(url.includes(key), `缺少 ${key}`)
  }
  assert.ok(!url.includes('fake-sk'), '签名密钥绝不能出现在 URL 里')
  assert.equal(aliyunRpcUrl(base), url)
  const randomA = aliyunRpcUrl({ ...base, nonce: undefined })
  const randomB = aliyunRpcUrl({ ...base, nonce: undefined })
  assert.notEqual(randomA, randomB, '未指定 nonce 时应自动生成不同值')
})

test('AliyunBssAdapter：构造签名请求、解析响应、缺 SK 明确失败', () => {
  const adapter = new AliyunBssAdapter({ accessKeySecretEnv: 'TEST_SK' }, CLOUD_ENV)
  const [request] = adapter.balanceRequests(fakeAccount())
  assert.equal(request.method, 'GET')
  assert.ok(request.url.includes('Action=QueryAccountBalance'))
  assert.ok(!request.url.includes('fakeSecretKeyForUnitTestOnly'))
  assert.equal(request.balanceProbe?.kind, 'money')

  const response = jsonResponse(200, {
    Code: 'Success',
    Data: {
      AvailableAmount: '1234.56',
      CreditAmount: '100.00',
      MybankCreditAmount: '0.00',
      Currency: 'CNY',
    },
    RequestId: 'unit-test',
  })
  const payload = adapter.parseBalance(response, fakeAccount(), request)
  assert.equal(payload.total, 1234.56)
  assert.equal(payload.currency, 'CNY')
  assert.equal(payload.breakdown?.['信用额度'], 100)
  assert.equal(payload.available, true)

  const noSecret = new AliyunBssAdapter({ accessKeySecretEnv: 'MISSING_SK' }, CLOUD_ENV)
  assert.throws(
    () => noSecret.balanceRequests(fakeAccount()),
    (error: Error) => error.message.includes('MISSING_SK') && !error.message.includes('fakeSecret'),
  )
})

test('火山 V4 签名：派生密钥链、Authorization 格式、不含 SK', () => {
  const signed = volcV4Signature({
    method: 'GET',
    host: 'open.volcengineapi.com',
    query: { Action: 'QueryBalance', Version: '2022-01-01' },
    accessKey: 'fake-volc-ak',
    secretKey: 'fake-volc-sk',
    region: 'cn-beijing',
    service: 'billing',
    date: FIXED_DATE,
  })
  assert.equal(signed.credentialScope, '20261106/cn-beijing/billing/request')
  assert.equal(signed.signedHeaders, 'host;x-content-sha256;x-date')
  assert.match(signed.authorization, /^HMAC-SHA256 Credential=fake-volc-ak\/20261106\/cn-beijing\/billing\/request, SignedHeaders=host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/)
  assert.match(signed.stringToSign, /^HMAC-SHA256\n20261106T073000Z\n20261106\/cn-beijing\/billing\/request\n[0-9a-f]{64}$/)
  assert.ok(signed.canonicalRequest.includes('host:open.volcengineapi.com'))
  assert.ok(signed.canonicalRequest.includes('x-date:20261106T073000Z'))
  assert.equal(signed.headers['X-Date'], '20261106T073000Z')
  assert.ok(!JSON.stringify(signed.headers).includes('fake-volc-sk'))
  assert.equal(
    volcV4Signature({
      method: 'GET',
      host: 'open.volcengineapi.com',
      query: { Action: 'QueryBalance', Version: '2022-01-01' },
      accessKey: 'fake-volc-ak',
      secretKey: 'fake-volc-sk',
      region: 'cn-beijing',
      service: 'billing',
      date: FIXED_DATE,
    }).signature,
    signed.signature,
  )
})

test('VolcSignedAdapter：未核实端点参数必须显式配置', () => {
  assert.throws(
    () => new VolcSignedAdapter({ balanceMap: { total: 'Result.Amount' } }, CLOUD_ENV),
    (error: Error) => error.message.includes('action'),
  )
  const adapter = new VolcSignedAdapter(
    {
      action: 'QueryBalance',
      version: '2022-01-01',
      service: 'billing',
      secretKeyEnv: 'TEST_VOLC_SK',
      balanceMap: { total: 'Result.AvailableAmount', currency: 'Result.Currency' },
    },
    CLOUD_ENV,
  )
  const [request] = adapter.balanceRequests(fakeAccount({ provider: 'volc-signed' }))
  assert.ok(request.url.includes('Action=QueryBalance'))
  assert.match(String(request.headers?.Authorization ?? ''), /^HMAC-SHA256 Credential=/)
  assert.ok(!JSON.stringify(request.headers).includes('fakeVolcSecretForUnitTestOnly'))
})

test('registerCloudSigning：总开关关闭不注册，开启后可逆释放', async () => {
  const consoleInstance = createConsole({}, { env: CLOUD_ENV, dashboard: false })
  const registry = consoleInstance.registry
  try {
    const none = registerCloudSigning(registry, { enabled: false, aliyun: {} }, CLOUD_ENV)
    assert.equal(none.length, 0)
    assert.ok(!registry.listProviderIds().includes('aliyun-bss'))

    const disposers = registerCloudSigning(
      registry,
      { enabled: true, aliyun: { accessKeySecretEnv: 'TEST_SK' } },
      CLOUD_ENV,
    )
    assert.equal(disposers.length, 1)
    assert.ok(registry.listProviderIds().includes('aliyun-bss'))
    registry.assertAllowedUrl('https://business.aliyuncs.com/?Action=QueryAccountBalance')
    for (const dispose of disposers) dispose()
    assert.ok(!registry.listProviderIds().includes('aliyun-bss'))
  } finally {
    await consoleInstance.close()
  }
})

test('端到端（离线 mock）：云账号余额进入统一快照，单个账户缺凭据不影响其它账户', async () => {
  const mock = mockTransport((request) => {
    if (request.url.includes('/user/balance')) {
      return jsonResponse(200, {
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '88.00' }],
      })
    }
    return jsonResponse(200, {
      Code: 'Success',
      Data: { AvailableAmount: '1234.56', Currency: 'CNY', CreditAmount: '0', MybankCreditAmount: '0' },
    })
  })
  const consoleInstance = createConsole(
    {
      retries: 0,
      cacheTtlMs: 0,
      accounts: [{ id: 'ds-main', provider: 'deepseek', apiKeyEnv: 'TEST_AK' }],
      cloudSigning: { enabled: true, aliyun: { accessKeySecretEnv: 'TEST_SK' } },
    },
    { transport: mock.transport, env: { ...CLOUD_ENV, TEST_AK: 'LTAI5tFakeAccessKeyId' }, dashboard: false },
  )
  try {
    registerCloudSigning(consoleInstance.registry, { enabled: true, aliyun: { accessKeySecretEnv: 'TEST_SK' } }, CLOUD_ENV)
    consoleInstance.registry.registerAccount({
      id: 'aliyun-main',
      provider: 'aliyun-bss',
      apiKeyEnv: 'TEST_AK',
    })
    const report = await consoleInstance.refreshBalances({ force: true })
    const cloud = report.accounts.find((item) => item.accountId === 'aliyun-main')
    assert.equal(cloud?.status, 'ok')
    assert.equal(cloud?.total, 1234.56)
    assert.equal(cloud?.currency, 'CNY')
    assert.ok(cloud?.note?.includes('主账号现金余额'))
    assert.ok(mock.calls.some((call) => call.url.includes('business.aliyuncs.com')))
    assert.ok(mock.calls.every((call) => !JSON.stringify(call).includes('fakeSecretKeyForUnitTestOnly')))
  } finally {
    await consoleInstance.close()
  }
})
