import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.ts'
import { ConsoleRegistry } from '../src/core/registry.ts'
import { TEST_ENV } from './helpers.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-console-'))
}

test('配置归并：目录 → 内联，同 id 后者覆盖；坏文件只警告', () => {
  const dir = tempDir()
  try {
    writeFileSync(
      join(dir, 'accounts.json'),
      JSON.stringify([
        { id: 'ds-main', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY', label: '目录版' },
        { id: 'kimi-main', provider: 'moonshot-cn', apiKeyEnv: 'TEST_KIMI_KEY' },
      ]),
      'utf8',
    )
    writeFileSync(join(dir, 'broken.json'), '{ this is not json', 'utf8')
    writeFileSync(join(dir, 'comment.json'), '// 注释\n{ "id": "x" }', 'utf8')

    const resolved = resolveConfig(
      {
        accountsDir: dir,
        accounts: [{ id: 'ds-main', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY', label: '内联版' }],
      },
      dir,
    )
    assert.equal(resolved.accounts.length, 2)
    assert.equal(resolved.accounts.find((a) => a.id === 'ds-main')?.label, '内联版')
    assert.ok(resolved.warnings.some((w) => w.includes('broken.json')))
    assert.ok(resolved.warnings.some((w) => w.includes('comment.json')))
    assert.ok(resolved.warnings.length >= 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置：非法 id / 缺 provider 会被跳过而不是抛错', () => {
  const resolved = resolveConfig({
    accounts: [
      { id: 'bad id!', provider: 'deepseek' },
      { id: 'no-provider' } as never,
      { id: 'ok', provider: 'deepseek' },
    ],
  })
  assert.deepEqual(resolved.accounts.map((a) => a.id), ['ok'])
  assert.equal(resolved.warnings.length, 2)
})

test('配置：缺省值与派生主机白名单', () => {
  const resolved = resolveConfig({
    accounts: [{ id: 'ds', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY' }],
  })
  assert.equal(resolved.balance.cacheTtlMs, 60_000)
  assert.equal(resolved.balance.autoRefreshMs, 0)
  assert.equal(resolved.balance.concurrency, 4)
  assert.equal(resolved.http.timeoutMs, 15_000)
  // 看板默认开启：与 client.js 的默认值一致，避免「宿主不监听、客户端却渲染 iframe」的白屏
  assert.equal(resolved.dashboard.enabled, true)
  assert.equal(resolved.dashboard.host, '127.0.0.1')
  assert.ok(resolved.call.allowedHosts.includes('api.deepseek.com'))
  assert.equal(resolved.call.allowStream, false)
  assert.equal(resolved.call.allowRawRequests, true)
})

test('注册中心：密钥只从环境变量取，对外视图不含明文', () => {
  const resolved = resolveConfig({
    accounts: [{ id: 'ds', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY', label: '主账号' }],
  })
  const registry = new ConsoleRegistry(resolved, { env: TEST_ENV })
  const account = registry.account('ds')
  assert.equal(account.apiKey, 'sk-unit-test-deepseek')
  assert.equal(account.chatBaseUrl, 'https://api.deepseek.com')
  const info = registry.listAccounts()[0]
  assert.equal(info.hasApiKey, true)
  assert.equal(info.apiKeySource, 'env:TEST_DS_KEY')
  assert.equal(JSON.stringify(info).includes('sk-unit-test'), false)
  assert.equal(info.balanceKind, 'money')
  assert.equal(info.balanceReliable, true)
  registry.dispose()
})

test('注册中心：自定义服务商声明式接入 + ${ENV} 展开', () => {
  const resolved = resolveConfig({
    providers: [
      {
        id: 'my-proxy',
        label: '自建中转',
        chatBaseUrl: '${PROXY_BASE}/v1',
        defaultModels: ['model-a'],
        balance: { kind: 'money', url: 'https://proxy.example.com/v1/balance' },
        balanceMap: { total: 'data.balance', currency: 'data.currency', breakdown: { 赠金: 'data.gift' } },
      },
    ],
    accounts: [{ id: 'proxy', provider: 'my-proxy', apiKeyEnv: 'TEST_QWEN_KEY' }],
    allowedHosts: ['proxy.example.com'],
  })
  const env = { ...TEST_ENV, PROXY_BASE: 'https://proxy.example.com' }
  const registry = new ConsoleRegistry(resolved, { env })
  assert.ok(registry.listProviderIds().includes('my-proxy'))
  assert.equal(registry.account('proxy').chatBaseUrl, 'https://proxy.example.com/v1')
  assert.ok(resolved.call.allowedHosts.includes('proxy.example.com'))
  assert.equal(registry.listAccounts()[0].hasApiKey, true)
  registry.dispose()
})

test('注册中心：raw 请求的主机白名单与 https 约束', () => {
  const resolved = resolveConfig({
    accounts: [{ id: 'ds', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY' }],
  })
  const registry = new ConsoleRegistry(resolved, { env: TEST_ENV })
  assert.doesNotThrow(() => registry.assertAllowedUrl('https://api.deepseek.com/models'))
  assert.throws(() => registry.assertAllowedUrl('https://evil.example.com/x'), /不在白名单/)
  assert.throws(() => registry.assertAllowedUrl('http://api.deepseek.com/x'), /仅允许 https/)
  // 回环地址不再自动绕过白名单（SSRF 修复）：默认必须拒绝
  assert.throws(
    () => registry.assertAllowedUrl('http://127.0.0.1:11434/v1/models'),
    /不在白名单.*本地回环地址默认也需显式允许/,
  )
  registry.dispose()
})

test('SSRF：回环默认拒绝，显式列入 allowedHosts 后才放行', () => {
  const blocked = resolveConfig({
    accounts: [{ id: 'ds', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY' }],
  })
  assert.equal(blocked.call.requireLoopbackAllowlist, true)
  const r1 = new ConsoleRegistry(blocked, { env: TEST_ENV })
  assert.throws(() => r1.assertAllowedUrl('http://localhost:8080/anything'), /不在白名单/)
  assert.throws(() => r1.assertAllowedUrl('http://[::1]:11434/v1/models'), /不在白名单/)
  r1.dispose()

  // 显式把回环 host 写进白名单 → 放行（收紧但仍可用）
  const allowed = resolveConfig({
    accounts: [{ id: 'ds', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY' }],
    allowedHosts: ['127.0.0.1', 'localhost'],
  })
  const r2 = new ConsoleRegistry(allowed, { env: TEST_ENV })
  assert.doesNotThrow(() => r2.assertAllowedUrl('http://127.0.0.1:11434/v1/models'))
  assert.doesNotThrow(() => r2.assertAllowedUrl('http://localhost:8080/x'))
  r2.dispose()
})

test('SSRF：allowLoopbackTargets=true 才恢复旧的回环豁免（显式自愿放宽）', () => {
  const relaxed = resolveConfig({
    accounts: [{ id: 'ds', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY' }],
    allowLoopbackTargets: true,
  })
  assert.equal(relaxed.call.requireLoopbackAllowlist, false)
  const r = new ConsoleRegistry(relaxed, { env: TEST_ENV })
  assert.doesNotThrow(() => r.assertAllowedUrl('http://127.0.0.1:11434/v1/models'))
  // 外网主机仍必须在白名单里，放宽只影响回环
  assert.throws(() => r.assertAllowedUrl('https://evil.example.com/x'), /不在白名单/)
  r.dispose()
})
