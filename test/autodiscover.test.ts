/**
 * 凭证自动探测（autoDiscover）的单元测试。
 *
 * 全部用本地 mock seam，不接触真实 credentials 服务、不联网、不读真实密钥。
 * 覆盖：探测到 / 未探测到、credentials 服务缺失时降级、显式配置优先、非法 keyEnv 跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_DISCOVER_SPECS,
  KEY_ENV_PATTERN,
  probeCredential,
  runAutoDiscover,
  snapshotOf,
  type AutoDiscoverReport,
  type CredentialSeam,
} from '../src/autodiscover.ts'
import { createConsole } from '../src/server.ts'
import { resolveConfig } from '../src/config.ts'
import { ConsoleRegistry } from '../src/core/registry.ts'
import type { ResolvedConfig } from '../src/types.ts'

/** 假的 credentials 服务：`values` 里有值才算已配置，`describe` 永远不吐值。 */
function fakeSeam(values: Record<string, string>, options: { onlyDescribe?: string[] } = {}): CredentialSeam {
  const describeOnly = new Set(options.onlyDescribe ?? [])
  return {
    async resolve(ref: string) {
      if (describeOnly.has(ref)) return undefined
      const value = values[ref]
      return value === undefined ? undefined : { value, source: 'file' }
    },
    async describe(ref: string) {
      const configured = describeOnly.has(ref) || values[ref] !== undefined
      return configured ? { configured: true, source: 'file', writable: true } : { configured: false, writable: true }
    },
  }
}

function configWith(overrides: Partial<Parameters<typeof resolveConfig>[0]> = {}): ResolvedConfig {
  return resolveConfig({ accounts: [], dashboard: { enabled: false }, ...overrides })
}

function registryOf(config: ResolvedConfig, env: Record<string, string | undefined> = {}): ConsoleRegistry {
  return new ConsoleRegistry(config, { env })
}

// ---------------------------------------------------------------------------
// 探测表本身
// ---------------------------------------------------------------------------

test('探测表：9 个内置服务商，引用名全部是合法 POSIX 标识符', () => {
  assert.equal(AUTO_DISCOVER_SPECS.length, 9)
  const providers = AUTO_DISCOVER_SPECS.map((spec) => spec.provider)
  assert.deepEqual(providers, [
    'deepseek',
    'moonshot-cn',
    'moonshot-global',
    'dashscope',
    'zhipu',
    'siliconflow',
    'volcengine',
    'qianfan',
    'hunyuan',
  ])
  for (const spec of AUTO_DISCOVER_SPECS) {
    assert.ok(spec.keyEnv.length >= 1, `${spec.provider} 至少要有一个候选变量`)
    for (const keyEnv of spec.keyEnv) {
      assert.ok(KEY_ENV_PATTERN.test(keyEnv), `${spec.provider} 的 ${keyEnv} 必须是合法引用名`)
    }
  }
  // 键名逐条对齐需求
  const byEnv = Object.fromEntries(AUTO_DISCOVER_SPECS.map((spec) => [spec.provider, [...spec.keyEnv]]))
  assert.deepEqual(byEnv.deepseek, ['DEEPSEEK_API_KEY'])
  assert.deepEqual(byEnv['moonshot-cn'], ['MOONSHOT_API_KEY'])
  assert.deepEqual(byEnv.dashscope, ['DASHSCOPE_API_KEY'])
  assert.deepEqual(byEnv.zhipu, ['ZHIPU_API_KEY'])
  assert.deepEqual(byEnv.siliconflow, ['SILICONFLOW_API_KEY'])
  assert.deepEqual(byEnv.volcengine, ['ARK_API_KEY'])
  assert.deepEqual(byEnv.qianfan, ['QIANFAN_API_KEY'])
  assert.deepEqual(byEnv.hunyuan, ['HUNYUAN_API_KEY'])
  // moonshot-global 两个都试，专用变量优先
  assert.deepEqual(byEnv['moonshot-global'], ['MOONSHOT_GLOBAL_API_KEY', 'MOONSHOT_API_KEY'])
})

// ---------------------------------------------------------------------------
// 探测到 / 未探测到
// ---------------------------------------------------------------------------

test('自动探测到：命中即生成账户，id/label 用 provider 自身，密钥不外露', async () => {
  const registry = registryOf(configWith())
  const seam = fakeSeam({
    DEEPSEEK_API_KEY: 'sk-auto-deepseek',
    MOONSHOT_API_KEY: 'sk-auto-moonshot',
  })
  const report = await runAutoDiscover({ seam, registry, explicitIds: [] })

  assert.equal(report.enabled, true)
  assert.equal(report.serviceAvailable, true)
  assert.deepEqual(report.discovered.sort(), ['deepseek', 'moonshot-cn', 'moonshot-global'])

  const accounts = registry.listAccounts()
  const ids = accounts.map((item) => item.id).sort()
  assert.deepEqual(ids, ['deepseek', 'moonshot-cn', 'moonshot-global'])

  const deepseek = accounts.find((item) => item.id === 'deepseek')!
  assert.equal(deepseek.provider, 'deepseek')
  assert.equal(deepseek.label, 'DeepSeek')
  assert.equal(deepseek.hasApiKey, true)
  assert.equal(deepseek.discovered, true)
  assert.equal(deepseek.apiKeySource, 'credentials:DEEPSEEK_API_KEY')

  // 报告与账户视图里绝不能出现密钥明文
  assert.equal(JSON.stringify(report).includes('sk-auto-deepseek'), false)
  assert.equal(JSON.stringify(accounts).includes('sk-auto-deepseek'), false)

  // 但注册中心内部确实拿到了可用密钥（余额/调用需要）
  assert.equal(registry.account('deepseek').apiKey, 'sk-auto-deepseek')
  const global = registry.account('moonshot-global')
  assert.equal(global.apiKey, 'sk-auto-moonshot', '国际站回落到 MOONSHOT_API_KEY')
  registry.dispose()
})

test('未探测到：一个都不命中时不生成账户，报告逐项标注未配置', async () => {
  const registry = registryOf(configWith())
  const report = await runAutoDiscover({ seam: fakeSeam({}), registry, explicitIds: [] })

  assert.deepEqual(report.discovered, [])
  assert.equal(registry.listAccounts().length, 0)
  assert.equal(report.providers.length, 9)
  assert.ok(report.providers.every((item) => item.configured === false))
  assert.equal(report.serviceAvailable, true)
  registry.dispose()
})

test('moonshot-global 专用变量优先于通用变量', async () => {
  const registry = registryOf(configWith())
  const report = await runAutoDiscover({
    seam: fakeSeam({ MOONSHOT_GLOBAL_API_KEY: 'sk-global', MOONSHOT_API_KEY: 'sk-cn' }),
    registry,
    explicitIds: [],
  })
  assert.ok(report.discovered.includes('moonshot-global'))
  const env = report.providers.find((item) => item.provider === 'moonshot-global')!
  assert.equal(env.keyEnv, 'MOONSHOT_GLOBAL_API_KEY')
  assert.equal(registry.account('moonshot-global').apiKey, 'sk-global')
  // 国内站仍用通用变量
  assert.equal(registry.account('moonshot-cn').apiKey, 'sk-cn')
  registry.dispose()
})

// ---------------------------------------------------------------------------
// credentials 服务缺失 → 降级
// ---------------------------------------------------------------------------

test('credentials 服务缺失：静默降级，报告标注不可用且不生成账户', async () => {
  const registry = registryOf(configWith())
  const report = await runAutoDiscover({ seam: undefined, registry, explicitIds: [] })

  assert.equal(report.serviceAvailable, false)
  assert.deepEqual(report.discovered, [])
  assert.equal(registry.listAccounts().length, 0)
  assert.ok(report.warnings.some((w) => w.includes('credentials 服务')))
  registry.dispose()
})

test('credentials 服务缺失：显式账户照常工作，其余能力不受影响', async () => {
  const config = configWith({
    accounts: [{ id: 'ds-main', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY' }],
  })
  const registry = registryOf(config, { TEST_DS_KEY: 'sk-explicit' })
  const report = await runAutoDiscover({ seam: undefined, registry, explicitIds: ['ds-main'] })

  assert.equal(report.serviceAvailable, false)
  assert.deepEqual(registry.listAccountIds(), ['ds-main'])
  assert.equal(registry.account('ds-main').apiKey, 'sk-explicit')
  // 服务商注册不受影响
  assert.ok(registry.listProviderIds().includes('deepseek'))
  registry.dispose()
})

test('seam 方法抛错只当作「没探到」，不冒泡到调用方', async () => {
  const registry = registryOf(configWith())
  const boom: CredentialSeam = {
    resolve() {
      throw new Error('存储损坏')
    },
    describe() {
      return Promise.reject(new Error('存储损坏'))
    },
  }
  const report = await runAutoDiscover({ seam: boom, registry, explicitIds: [] })
  assert.deepEqual(report.discovered, [])
  assert.equal(report.providers.length, 9)
  assert.ok(report.providers.every((item) => item.configured === false))
  registry.dispose()
})

// ---------------------------------------------------------------------------
// 显式配置优先
// ---------------------------------------------------------------------------

test('显式配置优先：同名 id 不被自动账户覆盖，密钥仍用用户配置的', async () => {
  // 用户显式把账户 id 命名为 deepseek（与自动 id 撞车）
  const config = configWith({
    accounts: [
      { id: 'deepseek', provider: 'deepseek', apiKeyEnv: 'USER_DS_KEY', label: '我的 DeepSeek' },
    ],
  })
  const registry = registryOf(config, { USER_DS_KEY: 'sk-user-explicit' })
  const report = await runAutoDiscover({
    seam: fakeSeam({ DEEPSEEK_API_KEY: 'sk-auto-should-lose' }),
    registry,
    explicitIds: ['deepseek'],
  })

  assert.deepEqual(report.discovered, [])
  assert.ok(report.skipped.some((item) => item.provider === 'deepseek'))
  assert.equal(registry.listAccounts().length, 1)
  const account = registry.listAccounts()[0]
  assert.equal(account.label, '我的 DeepSeek', '保留用户配置的 label')
  assert.equal(account.apiKeySource, 'env:USER_DS_KEY', '保留用户配置的凭据来源')
  assert.equal(account.discovered, undefined, '显式账户不应被标成自动探测')
  assert.equal(registry.account('deepseek').apiKey, 'sk-user-explicit')
  registry.dispose()
})

test('显式配置优先：自定义 label 的账户 id 不撞车时，自动账户照常生成', async () => {
  const config = configWith({
    accounts: [{ id: 'ds-main', provider: 'deepseek', apiKeyEnv: 'USER_DS_KEY', label: '主账号' }],
  })
  const registry = registryOf(config, { USER_DS_KEY: 'sk-user-explicit' })
  const report = await runAutoDiscover({
    seam: fakeSeam({ DEEPSEEK_API_KEY: 'sk-auto' }),
    registry,
    explicitIds: ['ds-main'],
  })
  assert.deepEqual(report.discovered, ['deepseek'])
  assert.deepEqual(registry.listAccountIds(), ['deepseek', 'ds-main'])
  assert.equal(registry.account('ds-main').apiKey, 'sk-user-explicit')
  assert.equal(registry.account('deepseek').apiKey, 'sk-auto')
  registry.dispose()
})

test('registerDiscoveredAccount 对已存在账户返回 skipped 且不写入', () => {
  const config = configWith({
    accounts: [{ id: 'same', provider: 'deepseek', apiKeyEnv: 'USER_KEY' }],
  })
  const registry = registryOf(config, { USER_KEY: 'sk-user' })
  const result = registry.registerDiscoveredAccount(
    { id: 'same', provider: 'deepseek', label: '自动版', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    'sk-auto',
  )
  assert.equal(result, 'skipped')
  assert.equal(registry.account('same').apiKey, 'sk-user')
  assert.equal(registry.isDiscovered('same'), false)
  registry.dispose()
})

test('重复探测是幂等的：覆盖上一次自动账户，不误判成显式配置', async () => {
  const registry = registryOf(configWith())
  const first = await runAutoDiscover({
    seam: fakeSeam({ DEEPSEEK_API_KEY: 'sk-v1' }),
    registry,
    explicitIds: [],
  })
  assert.deepEqual(first.discovered, ['deepseek'])
  assert.equal(registry.account('deepseek').apiKey, 'sk-v1')

  // 密钥轮换后再探测一次：应更新同一个自动账户，而不是报「已存在」
  const second = await runAutoDiscover({
    seam: fakeSeam({ DEEPSEEK_API_KEY: 'sk-v2' }),
    registry,
    explicitIds: [],
  })
  assert.deepEqual(second.discovered, ['deepseek'])
  assert.deepEqual(second.skipped, [])
  assert.equal(registry.account('deepseek').apiKey, 'sk-v2')
  assert.equal(registry.listAccounts().length, 1)
  registry.dispose()
})

// ---------------------------------------------------------------------------
// 非法 keyEnv 跳过
// ---------------------------------------------------------------------------

test('非法 keyEnv 跳过：含空格 / 破折号 / 数字开头 / 空串的候选都不被探测', async () => {
  const probed: string[] = []
  const seam: CredentialSeam = {
    async resolve(ref: string) {
      probed.push(ref)
      return { value: 'sk-should-not-be-used' }
    },
    async describe() {
      return { configured: false }
    },
  }

  for (const bad of ['BAD-KEY', '1BAD', 'HAS SPACE', '', 'sk-lower', 'A.B']) {
    const probe = await probeCredential(seam, [bad])
    assert.equal(probe.configured, false, `${JSON.stringify(bad)} 应被跳过`)
    assert.deepEqual(probe.invalid, [bad])
    assert.equal(probe.value, undefined)
  }
  assert.deepEqual(probed, [], '非法引用名不应被交给 seam')
})

test('非法 keyEnv 跳过：一个候选非法时仍继续尝试后面的合法候选', async () => {
  const probed: string[] = []
  const seam: CredentialSeam = {
    async resolve(ref: string) {
      probed.push(ref)
      return ref === 'GOOD_KEY' ? { value: 'sk-good' } : undefined
    },
    async describe() {
      return { configured: false }
    },
  }
  const probe = await probeCredential(seam, ['BAD-KEY', 'GOOD_KEY'])
  assert.equal(probe.configured, true)
  assert.equal(probe.keyEnv, 'GOOD_KEY')
  assert.equal(probe.value, 'sk-good')
  assert.deepEqual(probe.invalid, ['BAD-KEY'])
  assert.deepEqual(probed, ['GOOD_KEY'], '只把合法引用名交给 seam')
})

test('非法 keyEnv 跳过：探测表里混入非法候选时整轮仍能跑完并告警', async () => {
  const registry = registryOf(configWith())
  const report = await runAutoDiscover({
    seam: fakeSeam({ DEEPSEEK_API_KEY: 'sk-auto-deepseek' }),
    registry,
    explicitIds: [],
    specs: [
      { provider: 'deepseek', keyEnv: ['DEEPSEEK_API_KEY'] },
      { provider: 'zhipu', keyEnv: ['NOT A KEY', 'ZHIPU_API_KEY'] },
      { provider: 'hunyuan', keyEnv: ['BAD-NAME'] },
    ],
  })
  assert.deepEqual(report.discovered.sort(), ['deepseek'])
  const hunyuan = report.providers.find((item) => item.provider === 'hunyuan')!
  assert.equal(hunyuan.configured, false)
  assert.match(hunyuan.note ?? '', /非法引用名/)
  assert.ok(report.warnings.some((w) => w.includes('BAD-NAME')))
  registry.dispose()
})

// ---------------------------------------------------------------------------
// 开关与降级细节
// ---------------------------------------------------------------------------

test('autoDiscover=false 时一次探测也不发', async () => {
  const registry = registryOf(configWith({ autoDiscover: false }))
  let calls = 0
  const seam: CredentialSeam = {
    async resolve() {
      calls++
      return { value: 'sk-auto' }
    },
    async describe() {
      calls++
      return { configured: true }
    },
  }
  const report = await runAutoDiscover({ seam, registry, enabled: false, explicitIds: [] })
  assert.equal(calls, 0)
  assert.deepEqual(report.discovered, [])
  assert.equal(report.enabled, false)
  assert.ok(report.warnings.some((w) => w.includes('autoDiscover=false')))
  registry.dispose()
})

test('已配置但接缝不给值：报告说明原因，不建半可用账户', async () => {
  const registry = registryOf(configWith())
  const report = await runAutoDiscover({
    seam: fakeSeam({}, { onlyDescribe: ['DEEPSEEK_API_KEY'] }),
    registry,
    explicitIds: [],
    specs: [{ provider: 'deepseek', keyEnv: ['DEEPSEEK_API_KEY'] }],
  })
  assert.deepEqual(report.discovered, [])
  const entry = report.providers[0]
  assert.equal(entry.configured, true)
  assert.match(entry.note ?? '', /未返回值/)
  assert.equal(registry.listAccounts().length, 0)
  registry.dispose()
})

test('配置缺省：autoDiscover 默认 true，显式 false 才关闭', () => {
  assert.equal(configWith().autoDiscover.enabled, true)
  assert.equal(configWith({ autoDiscover: true }).autoDiscover.enabled, true)
  assert.equal(configWith({ autoDiscover: false }).autoDiscover.enabled, false)
  assert.deepEqual(configWith().autoDiscover.providers, [])
  assert.deepEqual(configWith({ autoDiscoverProviders: ['deepseek'] }).autoDiscover.providers, ['deepseek'])
})

test('快照只含摘要，不含任何密钥值', async () => {
  const registry = registryOf(configWith())
  const report = await runAutoDiscover({
    seam: fakeSeam({ DEEPSEEK_API_KEY: 'sk-secret-value' }),
    registry,
    explicitIds: [],
  })
  const snapshot = snapshotOf({
    enabled: true,
    pending: false,
    serviceAvailable: true,
    report,
    settled: Promise.resolve(report),
  })
  assert.equal(snapshot.discovered, 1)
  assert.equal(snapshot.providers.length, 9)
  assert.equal(JSON.stringify(snapshot).includes('sk-secret-value'), false)
  registry.dispose()
})

// ---------------------------------------------------------------------------
// createConsole 集成：没有 seam 时整条链路照常工作
// ---------------------------------------------------------------------------

test('createConsole：不传 credentials 时降级，账户与工具面照常', async () => {
  const consoleInstance = createConsole(
    {
      accounts: [{ id: 'ds-main', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY' }],
      dashboard: { enabled: false },
    },
    { env: { TEST_DS_KEY: 'sk-explicit' }, dashboard: false },
  )
  try {
    const report = await consoleInstance.discovery.settled
    assert.equal(report.serviceAvailable, false)
    assert.deepEqual(report.discovered, [])
    assert.deepEqual(consoleInstance.listAccounts().map((item) => item.id), ['ds-main'])
    assert.equal(consoleInstance.discovery.pending, false)
    assert.equal(consoleInstance.discoverySnapshot().serviceAvailable, false)
  } finally {
    await consoleInstance.close()
  }
})

test('createConsole：传入 seam 时自动生成账户，且不与显式账户冲突', async () => {
  const consoleInstance = createConsole(
    {
      accounts: [{ id: 'ds-main', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY', label: '主账号' }],
      dashboard: { enabled: false },
    },
    {
      env: { TEST_DS_KEY: 'sk-explicit' },
      dashboard: false,
      credentials: fakeSeam({ DEEPSEEK_API_KEY: 'sk-auto', ZHIPU_API_KEY: 'sk-zhipu' }),
    },
  )
  try {
    const report = await consoleInstance.discovery.settled
    assert.ok(report, '传入 seam 时 settled 必须给出报告')
    assert.equal(report.serviceAvailable, true)
    assert.deepEqual(report.discovered.sort(), ['deepseek', 'zhipu'])
    assert.deepEqual(consoleInstance.listAccounts().map((item) => item.id).sort(), ['deepseek', 'ds-main', 'zhipu'])
    // 显式账户的密钥没有被自动值顶掉
    assert.equal(consoleInstance.registry.account('ds-main').apiKey, 'sk-explicit')
    assert.equal(consoleInstance.registry.account('deepseek').apiKey, 'sk-auto')
    // 自动账户也能正常参与余额请求构造
    const info = consoleInstance.listAccounts().find((item) => item.id === 'zhipu')!
    assert.equal(info.discovered, true)
    assert.equal(info.hasApiKey, true)
  } finally {
    await consoleInstance.close()
  }
})

test('createConsole：autoDiscover=false 时即使有 seam 也不生成账户', async () => {
  const consoleInstance = createConsole(
    { accounts: [], autoDiscover: false, dashboard: { enabled: false } },
    { dashboard: false, credentials: fakeSeam({ DEEPSEEK_API_KEY: 'sk-auto' }) },
  )
  try {
    const report = await consoleInstance.discovery.settled
    assert.equal(report?.enabled, false)
    assert.deepEqual(report?.discovered, [])
    assert.deepEqual(consoleInstance.listAccounts(), [])
  } finally {
    await consoleInstance.close()
  }
})

test('createConsole：autoDiscoverProviders 只探测点名的服务商，未知 id 给 warning', async () => {
  const consoleInstance = createConsole(
    {
      accounts: [],
      autoDiscoverProviders: ['deepseek', 'no-such-provider'],
      dashboard: { enabled: false },
    },
    {
      dashboard: false,
      credentials: fakeSeam({ DEEPSEEK_API_KEY: 'sk-auto', ZHIPU_API_KEY: 'sk-zhipu' }),
    },
  )
  try {
    const report = await consoleInstance.discovery.settled
    assert.deepEqual(report?.discovered, ['deepseek'], 'zhipu 不在白名单里，不该被探测')
    assert.deepEqual(consoleInstance.listAccounts().map((item) => item.id), ['deepseek'])
    assert.ok(report?.warnings.some((w) => w.includes('no-such-provider')))
  } finally {
    await consoleInstance.close()
  }
})

test('createConsole.close() 会等首轮探测结束，不会留下悬挂的异步任务', async () => {
  let resolveSeam: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    resolveSeam = resolve
  })
  const slowSeam: CredentialSeam = {
    async resolve(ref: string) {
      if (ref === 'DEEPSEEK_API_KEY') await gate
      return ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-late' } : undefined
    },
  }
  const consoleInstance = createConsole(
    { accounts: [], dashboard: { enabled: false } },
    { dashboard: false, credentials: slowSeam },
  )
  assert.equal(consoleInstance.discovery.pending, true)
  const closing = consoleInstance.close()
  resolveSeam?.()
  await closing
  assert.equal(consoleInstance.discovery.pending, false)
})
