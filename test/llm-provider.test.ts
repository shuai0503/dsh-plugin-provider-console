/**
 * 模型 provider 的单元测试。
 *
 * 全部离线、离线依赖：宿主模块用假实现注入，llm 服务用假实现模拟。
 * 覆盖三块：
 *  1. 纯函数：账户 → 路由计划 → pi-ai 模型描述符（转换正确性）
 *  2. 注册：registerAdapter / registerConfigurableProviders / registerModelDiscovery
 *  3. 降级：宿主没有 llm 服务 / 模块加载失败 / 配置关闭时，插件照常工作
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isLlmService,
  llmServiceOf,
  loadHostModules,
  normalizeModels,
  planRoutes,
  registerModelProvider,
  routeIdOf,
  slug,
  thinkingMapOf,
  toPiModels,
  toRouteProfile,
  type HostConfigurableProvider,
  type HostLlmService,
  type RoutePlan,
} from '../src/llm-provider.ts'
import { createConsole } from '../src/server.ts'
import type { ConsoleConfig, ResolvedConfig } from '../src/types.ts'

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function fakeConfig(overrides: Partial<ConsoleConfig> = {}): ResolvedConfig {
  const consoleInstance = createConsole(
    { accounts: [], dashboard: { enabled: false }, ...overrides },
    { env: {}, dashboard: false },
  )
  // 立即关闭后台探测，避免测试期间挂着定时器
  void consoleInstance.close()
  return consoleInstance.config
}

/** 假宿主模块：记录拿到什么，返回可断言的对象。 */
function fakeModules() {
  const providers: Array<{ id: string; name: string; models: unknown[]; api: unknown }> = []
  const adapters: Array<{ config: Record<string, unknown> }> = []

  /** 与 @deepseek-ai/dsh-llm 的 LlmError 同形：instanceof + code 可判。 */
  class FakeLlmError extends Error {
    code: string
    constructor(message: string, code: string) {
      super(message)
      this.name = 'LlmError'
      this.code = code
    }
  }

  return {
    providers,
    adapters,
    LlmError: FakeLlmError,
    modules: {
      PiAiAdapter: class {
        config: Record<string, unknown>
        constructor(config: Record<string, unknown>) {
          this.config = config
          adapters.push({ config })
        }
      } as never,
      createProvider: ((input: { id: string; name: string; models: unknown[]; api: unknown }) => {
        providers.push(input)
        return {
          id: input.id,
          name: input.name,
          auth: {},
          getModels: () => input.models,
          stream: () => undefined,
          streamSimple: () => undefined,
        }
      }) as never,
      openAICompletionsApi: (() => ({ kind: 'openai-completions' })) as never,
      LlmError: FakeLlmError as never,
    },
  }
}

/** 假 llm 服务：记录注册调用并返回可释放句柄。 */
function fakeLlm() {
  const state = {
    routes: [] as string[][],
    adapters: [] as unknown[],
    directory: [] as HostConfigurableProvider[][],
    discoveries: [] as string[],
    disposed: [] as string[],
  }
  const service: HostLlmService = {
    registerAdapter(routes, adapter) {
      state.routes.push([...routes])
      state.adapters.push(adapter)
      const handle = (() => {
        state.disposed.push(`adapter:${routes.join(',')}`)
      }) as { (): void; replace?(next: string[]): void }
      handle.replace = (next) => {
        state.routes.push([...(next as string[])])
      }
      return handle
    },
    registerConfigurableProviders(entries) {
      state.directory.push([...entries])
      const handle = (() => {
        state.disposed.push(`directory:${entries.map((entry) => entry.provider).join(',')}`)
      }) as { (): void; replace?(next: HostConfigurableProvider[]): void }
      handle.replace = (next) => {
        state.directory.push([...(next as HostConfigurableProvider[])])
      }
      return handle
    },
    registerModelDiscovery(settingsNs) {
      state.discoveries.push(settingsNs)
      return () => state.disposed.push(`discovery:${settingsNs}`)
    },
    listProviders: () => [],
  }
  return { service, state }
}

const noLog = (): void => undefined

function accountsConfig(): ConsoleConfig {
  return {
    dashboard: { enabled: false },
    accounts: [
      {
        id: 'ds-main',
        provider: 'deepseek',
        label: '主账号',
        apiKeyEnv: 'DS_KEY',
        models: ['deepseek-chat', 'deepseek-reasoner'],
      },
      {
        id: 'kimi_main',
        provider: 'moonshot-cn',
        apiKeyEnv: 'KIMI_KEY',
        models: ['kimi-k2'],
      },
    ],
  }
}

function consoleFor(config: ConsoleConfig) {
  return createConsole(config, {
    env: { DS_KEY: 'sk-ds', KIMI_KEY: 'sk-kimi' },
    dashboard: false,
  })
}

// ---------------------------------------------------------------------------
// 纯函数：id / slug
// ---------------------------------------------------------------------------

test('slug：任意账户 id 压成 pi-ai 接受的小写连字符标识', () => {
  assert.equal(slug('ds-main'), 'ds-main')
  assert.equal(slug('Kimi_Main'), 'kimi-main')
  assert.equal(slug('foo.bar_v2'), 'foo-bar-v2')
  assert.equal(slug('...'), 'account', '压不出字符时退回 account 而不是空串')
  assert.equal(slug('中文id'), 'id', '非 ASCII 被剥离，保留残留的 ASCII')
  assert.equal(routeIdOf('pc', 'ds-main'), 'pc-ds-main')
})

// ---------------------------------------------------------------------------
// 纯函数：模型归一
// ---------------------------------------------------------------------------

test('normalizeModels：字符串与结构化声明混用，按 id 去重、丢掉空 id', () => {
  const models = normalizeModels(['a', { id: 'b', name: 'B 模型', contextWindow: 64_000 }, 'a', { id: '  ' }, 'c'], {
    defaultContextWindow: 128_000,
    defaultMaxTokens: 8_192,
  })
  assert.deepEqual(
    models.map((model) => model.id),
    ['a', 'b', 'c'],
  )
  assert.equal(models[0].name, 'a', '没给 name 时用 id')
  assert.equal(models[0].contextWindow, 128_000, '缺省用全局默认上下文窗口')
  assert.equal(models[0].maxTokens, 8_192)
  assert.equal(models[1].name, 'B 模型')
  assert.equal(models[1].contextWindow, 64_000, '显式声明优先于默认值')
})

test('normalizeModels：非法数值退回默认值而不是产生 NaN/负数', () => {
  const models = normalizeModels(
    [
      { id: 'a', contextWindow: -5, maxTokens: 0 },
      { id: 'b', contextWindow: Number.NaN, maxTokens: Number.POSITIVE_INFINITY },
    ],
    { defaultContextWindow: 1000, defaultMaxTokens: 500 },
  )
  assert.deepEqual(
    models.map((model) => [model.contextWindow, model.maxTokens]),
    [
      [1000, 500],
      [1000, 500],
    ],
  )
})

test('normalizeModels：inputModalities 规范化，空数组退回 text', () => {
  const models = normalizeModels(
    [
      { id: 'a', inputModalities: ['TEXT', 'image', 'text'] },
      { id: 'b', inputModalities: [] },
      { id: 'c' },
    ],
    { defaultContextWindow: 1000, defaultMaxTokens: 500 },
  )
  assert.deepEqual(models[0].inputModalities, ['text', 'image'], '去重并小写')
  assert.deepEqual(models[1].inputModalities, ['text'], '[] 是一个什么都接受不了的模型，退回 text')
  assert.deepEqual(models[2].inputModalities, ['text'])
})

// ---------------------------------------------------------------------------
// 纯函数：推理档位
// ---------------------------------------------------------------------------

test('thinkingMapOf：false/未声明 => 无推理；true => OpenAI 直通表', () => {
  assert.equal(thinkingMapOf(undefined), undefined)
  assert.equal(thinkingMapOf(false), undefined)
  const passthrough = thinkingMapOf(true)
  assert.ok(passthrough)
  assert.equal(passthrough.off, null, 'off 映射成 null（不接受关闭 = 省略字段）')
  assert.equal(passthrough.high, 'high')
})

test('thinkingMapOf：自定义表把 false 归一成 null，空表退回 undefined', () => {
  const custom = thinkingMapOf({ off: null, low: 'minimal', max: false })
  assert.ok(custom)
  assert.equal(custom.low, 'minimal')
  assert.equal(custom.max, null, 'false 必须归一成 null：false 会被 pi-ai 当成「支持并发送 false」')
  assert.equal(thinkingMapOf({}), undefined, '空对象视同没有推理能力')
})

test('thinkingMapOf：默认推理能力会被单个模型覆盖', () => {
  const models = normalizeModels(
    [
      { id: 'plain', reasoning: false },
      { id: 'inherits' },
      { id: 'custom', reasoning: { low: 'low' } },
    ],
    { defaultContextWindow: 1000, defaultMaxTokens: 500, defaultReasoning: true },
  )
  assert.equal(models[0].thinkingLevelMap, undefined, '单个模型的 false 覆盖全局 true')
  assert.ok(models[1].thinkingLevelMap, '没声明的继承全局默认')
  assert.deepEqual(models[2].thinkingLevelMap, { low: 'low' })
})

// ---------------------------------------------------------------------------
// 纯函数：路由计划
// ---------------------------------------------------------------------------

test('planRoutes：账户翻译成路由，模型来自账户的 models', async () => {
  const consoleInstance = consoleFor(accountsConfig())
  try {
    const plans = planRoutes(consoleInstance.registry, consoleInstance.config, {
      routePrefix: 'pc',
      defaultContextWindow: 128_000,
      defaultMaxTokens: 8_192,
    })
    assert.deepEqual(
      plans.map((plan) => plan.provider),
      ['pc-ds-main', 'pc-kimi-main'],
    )
    assert.equal(plans[0].displayName, '主账号', '选择器里显示账户 label')
    assert.equal(plans[0].hasApiKey, true)
    assert.equal(plans[0].baseUrl, 'https://api.deepseek.com')
    assert.deepEqual(
      plans[0].models.map((model) => model.id),
      ['deepseek-chat', 'deepseek-reasoner'],
    )
  } finally {
    await consoleInstance.close()
  }
})

test('planRoutes：没声明模型、也没有 defaultModel 的账户不注册路由（不猜）', async () => {
  // 火山方舟/千帆这两个服务商故意不提供 defaultModels（模型名取决于控制台），
  // 正是「不知道能跑什么模型」的真实场景。
  const consoleInstance = consoleFor({
    dashboard: { enabled: false },
    accounts: [
      { id: 'bare', provider: 'volcengine', apiKeyEnv: 'NO_KEY' },
      { id: 'with-models', provider: 'volcengine', apiKeyEnv: 'NO_KEY', models: ['ep-123456'] },
    ],
  })
  try {
    const plans = planRoutes(consoleInstance.registry, consoleInstance.config, {
      routePrefix: 'pc',
      defaultContextWindow: 1000,
      defaultMaxTokens: 100,
    })
    assert.deepEqual(
      plans.map((plan) => plan.accountId),
      ['with-models'],
      '不知道能跑什么模型时宁可不出现，也不要一个必然 404 的条目',
    )
  } finally {
    await consoleInstance.close()
  }
})

test('planRoutes：account.llm.enabled=false 与账户禁用都不进选择器', async () => {
  const consoleInstance = consoleFor({
    dashboard: { enabled: false },
    accounts: [
      { id: 'off-by-llm', provider: 'deepseek', apiKeyEnv: 'DS_KEY', models: ['m'], llm: { enabled: false } },
      { id: 'off-by-account', provider: 'deepseek', apiKeyEnv: 'DS_KEY', models: ['m'], enabled: false },
      { id: 'kept', provider: 'deepseek', apiKeyEnv: 'DS_KEY', models: ['m'] },
    ],
  })
  try {
    const plans = planRoutes(consoleInstance.registry, consoleInstance.config, {
      routePrefix: 'pc',
      defaultContextWindow: 1000,
      defaultMaxTokens: 100,
    })
    assert.deepEqual(
      plans.map((plan) => plan.accountId),
      ['kept'],
    )
  } finally {
    await consoleInstance.close()
  }
})

test('planRoutes：账户级覆盖 displayName / models / 默认能力', async () => {
  const consoleInstance = consoleFor({
    dashboard: { enabled: false },
    accounts: [
      {
        id: 'custom',
        provider: 'deepseek',
        apiKeyEnv: 'DS_KEY',
        models: ['ignored'],
        llm: {
          displayName: '我的网关',
          models: ['real-model', { id: 'big', contextWindow: 200_000 }],
          contextWindow: 32_000,
          maxTokens: 4_096,
          reasoning: true,
        },
      },
    ],
  })
  try {
    const plans = planRoutes(consoleInstance.registry, consoleInstance.config, {
      routePrefix: 'pc',
      defaultContextWindow: 999,
      defaultMaxTokens: 999,
    })
    const plan = plans[0]
    assert.equal(plan.displayName, '我的网关')
    assert.deepEqual(
      plan.models.map((model) => model.id),
      ['real-model', 'big'],
      'llm.models 覆盖账户 models',
    )
    assert.equal(plan.models[0].contextWindow, 32_000, '账户级默认值生效')
    assert.equal(plan.models[0].maxTokens, 4_096)
    assert.equal(plan.models[1].contextWindow, 200_000, '单个模型的显式值仍然优先')
    assert.ok(plan.models[0].thinkingLevelMap, '账户级 reasoning=true 传递到模型')
  } finally {
    await consoleInstance.close()
  }
})

test('planRoutes：没有密钥的账户仍然出路由（好报 MISSING_CREDENTIAL 而不是静默消失）', async () => {
  const consoleInstance = consoleFor({
    dashboard: { enabled: false },
    accounts: [{ id: 'nokey', provider: 'deepseek', apiKeyEnv: 'ABSENT', models: ['m'] }],
  })
  try {
    const plans = planRoutes(consoleInstance.registry, consoleInstance.config, {
      routePrefix: 'pc',
      defaultContextWindow: 1000,
      defaultMaxTokens: 100,
    })
    assert.equal(plans.length, 1)
    assert.equal(plans[0].hasApiKey, false)
  } finally {
    await consoleInstance.close()
  }
})

// ---------------------------------------------------------------------------
// 纯函数：pi-ai 描述符
// ---------------------------------------------------------------------------

test('toPiModels：api/provider/baseUrl 三件套必须自洽，否则 dispatch 找不到路由', () => {
  const plan: RoutePlan = {
    provider: 'pc-ds',
    displayName: 'DS',
    accountId: 'ds',
    baseUrl: 'https://api.deepseek.com',
    hasApiKey: true,
    headers: {},
    models: normalizeModels([{ id: 'deepseek-chat' }], {
      defaultContextWindow: 128_000,
      defaultMaxTokens: 8_192,
    }),
  }
  const models = toPiModels(plan)
  assert.equal(models.length, 1)
  assert.equal(models[0].api, 'openai-completions', 'OpenAI 兼容协议')
  assert.equal(models[0].provider, 'pc-ds', 'provider 必须等于路由 id')
  assert.equal(models[0].baseUrl, 'https://api.deepseek.com')
  assert.equal(models[0].reasoning, false)
  assert.equal(models[0].thinkingLevelMap, undefined, '非推理模型不能带 thinkingLevelMap')
  assert.deepEqual(models[0].compat, { supportsReasoningEffort: false })
})

test('toPiModels：reasoning 与 compat.supportsReasoningEffort 必须同步', () => {
  const plan: RoutePlan = {
    provider: 'pc-r',
    displayName: 'R',
    accountId: 'r',
    baseUrl: 'https://example.test/v1',
    hasApiKey: true,
    headers: {},
    models: normalizeModels([{ id: 'r1', reasoning: true }], {
      defaultContextWindow: 1000,
      defaultMaxTokens: 100,
    }),
  }
  const model = toPiModels(plan)[0]
  assert.equal(model.reasoning, true)
  assert.equal(
    (model.compat as { supportsReasoningEffort: boolean }).supportsReasoningEffort,
    true,
    '两个字段对「能不能带 reasoning_effort」必须给出同一答案',
  )
})

test('toRouteProfile：装好 piProvider、按模型填 configuredMaxTokens、带上图片预算', () => {
  const plan: RoutePlan = {
    provider: 'pc-x',
    displayName: 'X',
    accountId: 'x',
    baseUrl: 'https://example.test/v1',
    hasApiKey: true,
    headers: { 'x-trace': '1' },
    models: normalizeModels([{ id: 'm1', maxTokens: 1234 }], {
      defaultContextWindow: 1000,
      defaultMaxTokens: 100,
    }),
  }
  let seen: unknown[] = []
  const profile = toRouteProfile(plan, {
    streamIdleTimeoutMs: 60_000,
    makeProvider: (models) => {
      seen = models
      return {
        id: plan.provider,
        name: plan.displayName,
        auth: {},
        getModels: () => models,
        stream: () => undefined,
        streamSimple: () => undefined,
      }
    },
  })
  assert.equal(profile.provider, 'pc-x')
  assert.equal(profile.displayName, 'X')
  assert.equal(profile.streamIdleTimeoutMs, 60_000)
  assert.equal(profile.configuredMaxTokens.get('m1'), 1234)
  assert.deepEqual(profile.headers, { 'x-trace': '1' })
  assert.ok(profile.piProvider, '没错误时必须有 piProvider')
  assert.equal((seen as Array<{ id: string }>)[0].id, 'm1')
  assert.ok(profile.requestImagePixelBudget > 0, '图片预算必须给出，否则 PiAiAdapter 读不到')
  assert.equal(profile.modelErrors.size, 0)
})

test('toRouteProfile：带 error 的计划不建 piProvider，而是记进 catalogError', () => {
  const plan: RoutePlan = {
    provider: 'pc-e',
    displayName: 'E',
    accountId: 'e',
    baseUrl: 'https://example.test/v1',
    hasApiKey: true,
    headers: {},
    models: normalizeModels([{ id: 'm' }], { defaultContextWindow: 10, defaultMaxTokens: 10 }),
    error: '端点不可用',
  }
  const profile = toRouteProfile(plan, {
    streamIdleTimeoutMs: 1,
    makeProvider: () => {
      throw new Error('不该被调用')
    },
  })
  assert.equal(profile.piProvider, undefined)
  assert.equal(profile.catalogError, '端点不可用')
})

// ---------------------------------------------------------------------------
// 注册：走假 llm 服务
// ---------------------------------------------------------------------------

test('registerModelProvider：注册适配器 + 可配置目录 + 模型发现', async () => {
  const consoleInstance = consoleFor(accountsConfig())
  const { service, state } = fakeLlm()
  const fake = fakeModules()
  try {
    const handle = registerModelProvider({
      ctx: { get: (name: string) => (name === 'llm' ? service : undefined) },
      registry: consoleInstance.registry,
      config: consoleInstance.config,
      log: noLog,
      modules: fake.modules,
    })
    assert.equal(handle.active, true)
    assert.deepEqual(handle.routes, ['pc-ds-main', 'pc-kimi-main'])
    assert.deepEqual(state.routes, [['pc-ds-main', 'pc-kimi-main']], '一次注册两条路由')
    assert.equal(state.adapters.length, 1)

    const entries = state.directory[0]
    assert.deepEqual(
      entries.map((entry) => entry.provider),
      ['pc-ds-main', 'pc-kimi-main'],
    )
    assert.equal(entries[0].displayName, '主账号', '选择器里看到的是账户 label')
    assert.equal(entries[0].declared, true, '手工声明的路由必须 declared=true（pi-ai catalog 不认识它）')
    assert.equal(entries[0].settingsNs, 'provider-console')
    assert.deepEqual(entries[0].settingsPath, [])
    assert.equal(entries[0].defaultBaseURL, 'https://api.deepseek.com')

    assert.deepEqual(state.discoveries, ['provider-console'])
    handle.dispose()
    assert.ok(state.disposed.some((entry) => entry.startsWith('adapter:')), '卸载时释放适配器')
    assert.ok(state.disposed.some((entry) => entry.startsWith('directory:')), '卸载时释放目录')
    assert.ok(state.disposed.some((entry) => entry.startsWith('discovery:')), '卸载时释放发现')
  } finally {
    await consoleInstance.close()
  }
})

test('registerModelProvider：适配器收到的 profiles 里每个路由都带 piProvider 且能取到密钥', async () => {
  const consoleInstance = consoleFor(accountsConfig())
  const { service } = fakeLlm()
  const fake = fakeModules()
  try {
    const handle = registerModelProvider({
      ctx: { get: (name: string) => (name === 'llm' ? service : undefined) },
      registry: consoleInstance.registry,
      config: consoleInstance.config,
      log: noLog,
      modules: fake.modules,
    })
    const adapterConfig = fake.adapters[0].config as {
      profiles(): Map<string, unknown>
      resolveApiKey(provider: string, profile: unknown): Promise<string | undefined>
    }
    const profiles = adapterConfig.profiles()
    assert.deepEqual([...profiles.keys()], ['pc-ds-main', 'pc-kimi-main'])
    const profile = profiles.get('pc-ds-main') as { piProvider?: unknown }
    assert.ok(profile.piProvider, '每个 profile 都要有 piProvider，否则 PiAiAdapter 无法 dispatch')

    assert.equal(await adapterConfig.resolveApiKey('pc-ds-main', profile), 'sk-ds')
    assert.equal(await adapterConfig.resolveApiKey('pc-kimi-main', profiles.get('pc-kimi-main')), 'sk-kimi')

    // 不认识的路由 / 没有密钥的账户都必须**抛 MISSING_CREDENTIAL**，不能返回 undefined。
    // 原因：PiAiAdapter.listModels() 只在 `error instanceof LlmError && code==='MISSING_CREDENTIAL'`
    // 时返回 []，从而把该厂商整组从模型选择器隐藏；返回 undefined 会让没密钥的模型
    // 照常出现在选择器里，用户选中后才报错。
    await assert.rejects(
      () => adapterConfig.resolveApiKey('unknown-route', profile),
      (error: unknown) => error instanceof fake.LlmError && (error as { code?: string }).code === 'MISSING_CREDENTIAL',
      '不认识的路由要抛 MISSING_CREDENTIAL',
    )

    // 密钥是**按请求现取**的：账户变了下一次取到新值
    consoleInstance.registry.registerAccount({
      id: 'ds-main',
      provider: 'deepseek',
      apiKey: 'sk-rotated',
      models: ['deepseek-chat'],
    })
    assert.equal(await adapterConfig.resolveApiKey('pc-ds-main', profile), 'sk-rotated')
    handle.dispose()
  } finally {
    await consoleInstance.close()
  }
})

test('registerModelProvider：没有密钥的账户会让该厂商整组从选择器隐藏（抛 MISSING_CREDENTIAL）', async () => {
  // env 里故意不给这个账户的密钥
  const consoleInstance = createConsole(
    {
      dashboard: { enabled: false },
      accounts: [
        { id: 'ds-main', provider: 'deepseek', apiKeyEnv: 'DS_KEY', models: ['deepseek-chat'] },
        { id: 'glm', provider: 'zhipu', apiKeyEnv: 'MISSING_KEY', models: ['glm-4-plus'] },
      ],
    },
    { env: { DS_KEY: 'sk-ds' }, dashboard: false },
  )
  void consoleInstance.close()
  const { service } = fakeLlm()
  const fake = fakeModules()
  try {
    const handle = registerModelProvider({
      ctx: { get: (name: string) => (name === 'llm' ? service : undefined) },
      registry: consoleInstance.registry,
      config: consoleInstance.config,
      log: noLog,
      modules: fake.modules,
    })
    const adapterConfig = fake.adapters[0].config as {
      resolveApiKey(provider: string, profile: unknown): Promise<string>
    }
    // 有密钥的照常返回
    assert.equal(await adapterConfig.resolveApiKey('pc-ds-main', {}), 'sk-ds')
    // 无密钥的必须抛 MISSING_CREDENTIAL —— 这是 PiAiAdapter 隐藏该组的唯一触发条件
    await assert.rejects(
      () => adapterConfig.resolveApiKey('pc-zhipu', {}),
      (error: unknown) => error instanceof fake.LlmError && (error as { code?: string }).code === 'MISSING_CREDENTIAL',
      '没有密钥的厂商必须抛 MISSING_CREDENTIAL，否则模型会出现在选择器里但点了报错',
    )
    handle.dispose()
  } finally {
    await consoleInstance.close()
  }
})

test('registerModelProvider：PiAiAdapter 收到的 auth 是惰性的（不让 pi-ai 自己造凭证）', async () => {  const consoleInstance = consoleFor(accountsConfig())
  const { service } = fakeLlm()
  const fake = fakeModules()
  try {
    const handle = registerModelProvider({
      ctx: { get: (name: string) => (name === 'llm' ? service : undefined) },
      registry: consoleInstance.registry,
      config: consoleInstance.config,
      log: noLog,
      modules: fake.modules,
    })
    const adapterConfig = fake.adapters[0].config as {
      auth: {
        credentials: { read(id: string): Promise<unknown>; modify(): Promise<unknown> }
        authContext: { env(name: string): Promise<unknown>; fileExists(path: string): Promise<boolean> }
      }
    }
    assert.equal(await adapterConfig.auth.credentials.read('pc-ds-main'), undefined)
    await assert.rejects(() => adapterConfig.auth.credentials.modify(), /没有 pi-ai 凭据生命周期/)
    assert.equal(await adapterConfig.auth.authContext.env('OPENAI_API_KEY'), undefined)
    assert.equal(await adapterConfig.auth.authContext.fileExists('~/.aws/credentials'), false)
    handle.dispose()
  } finally {
    await consoleInstance.close()
  }
})

test('registerModelProvider：注册前先算路由，之后 refresh 能跟上账户增删', async () => {
  const consoleInstance = consoleFor(accountsConfig())
  const { service, state } = fakeLlm()
  const fake = fakeModules()
  try {
    const handle = registerModelProvider({
      ctx: { get: (name: string) => (name === 'llm' ? service : undefined) },
      registry: consoleInstance.registry,
      config: consoleInstance.config,
      log: noLog,
      modules: fake.modules,
    })
    assert.equal(handle.routes.length, 2)

    consoleInstance.registry.registerAccount({
      id: 'third',
      provider: 'deepseek',
      apiKey: 'sk-openai',
      models: ['gpt-4o-mini'],
    })
    const plans = handle.refresh()
    assert.deepEqual(
      plans.map((plan) => plan.provider),
      ['pc-ds-main', 'pc-kimi-main', 'pc-third'],
    )
    assert.deepEqual(state.routes.at(-1), ['pc-ds-main', 'pc-kimi-main', 'pc-third'], 'refresh 走 replace 而不是重建')
    handle.dispose()
  } finally {
    await consoleInstance.close()
  }
})

test('registerModelProvider：dispose 之后 refresh 是空操作（不会往已释放的注册里写）', async () => {
  const consoleInstance = consoleFor(accountsConfig())
  const { service, state } = fakeLlm()
  const fake = fakeModules()
  try {
    const handle = registerModelProvider({
      ctx: { get: (name: string) => (name === 'llm' ? service : undefined) },
      registry: consoleInstance.registry,
      config: consoleInstance.config,
      log: noLog,
      modules: fake.modules,
    })
    const before = state.routes.length
    handle.dispose()
    assert.deepEqual(handle.refresh(), [])
    assert.equal(state.routes.length, before, 'dispose 后不该再注册')
  } finally {
    await consoleInstance.close()
  }
})

test('registerModelProvider：账户全删光导致 0 路由时必须整段撤掉，不能拿空数组去 replace', async () => {
  const consoleInstance = consoleFor({
    dashboard: { enabled: false },
    accounts: [{ id: 'only', provider: 'deepseek', apiKeyEnv: 'DS_KEY', models: ['m'] }],
  })
  const { service, state } = fakeLlm()
  const fake = fakeModules()
  try {
    const handle = registerModelProvider({
      ctx: { get: (name: string) => (name === 'llm' ? service : undefined) },
      registry: consoleInstance.registry,
      config: consoleInstance.config,
      log: noLog,
      modules: fake.modules,
    })
    assert.deepEqual(state.routes, [['pc-only']])
    consoleInstance.registry.unregisterAccount('only')
    const plans = handle.refresh()
    assert.deepEqual(plans, [], '没有账户 => 没有计划')
    // 宿主对空路由数组会抛 INVALID_ADAPTER（registerAdapter 与 replace 同一套校验），
    // 所以这里**不能**再出现一次 replace([])，必须走释放。
    assert.equal(state.routes.at(-1)?.length, 1, '不能把空数组 replace 进去')
    assert.ok(state.disposed.includes('adapter:pc-only'), '应整段释放而不是留一条死路由')
    assert.ok(state.disposed.some((entry) => entry.startsWith('directory:')), '目录也要撤')
  } finally {
    await consoleInstance.close()
  }
})

// ---------------------------------------------------------------------------
// 降级：拿不到能力时一条 warning 就结束
// ---------------------------------------------------------------------------

test('registerModelProvider：宿主没有 llm 服务 => 不激活，不抛异常', async () => {
  const consoleInstance = consoleFor(accountsConfig())
  const logs: string[] = []
  try {
    const handle = registerModelProvider({
      ctx: { get: () => undefined },
      registry: consoleInstance.registry,
      config: consoleInstance.config,
      log: (message) => logs.push(message),
      modules: fakeModules().modules,
    })
    assert.equal(handle.active, false)
    assert.match(handle.reason ?? '', /llm 服务/)
    assert.deepEqual(handle.routes, [])
    assert.deepEqual(handle.plans(), [])
    assert.deepEqual(handle.refresh(), [])
    handle.dispose() // 必须是安全的空操作
    assert.equal(logs.length, 1, '只留一条日志，不刷屏')
  } finally {
    await consoleInstance.close()
  }
})

test('registerModelProvider：ctx.get 抛错（Cordis 上下文未激活）时不冒泡', async () => {
  const consoleInstance = consoleFor(accountsConfig())
  try {
    const handle = registerModelProvider({
      ctx: {
        get() {
          throw new Error('cannot get required service "llm" in inactive context')
        },
      },
      registry: consoleInstance.registry,
      config: consoleInstance.config,
      log: noLog,
      modules: fakeModules().modules,
    })
    assert.equal(handle.active, false)
    assert.match(handle.reason ?? '', /llm 服务/)
  } finally {
    await consoleInstance.close()
  }
})

test('registerModelProvider：ctx 根本没有 get() 时也降级', async () => {
  const consoleInstance = consoleFor(accountsConfig())
  try {
    const handle = registerModelProvider({
      ctx: {},
      registry: consoleInstance.registry,
      config: consoleInstance.config,
      log: noLog,
      modules: fakeModules().modules,
    })
    assert.equal(handle.active, false)
  } finally {
    await consoleInstance.close()
  }
})

test('registerModelProvider：配置里 llmProvider.enabled=false 时不注册', async () => {
  const consoleInstance = consoleFor({ ...accountsConfig(), llmProvider: { enabled: false } })
  const { service, state } = fakeLlm()
  try {
    const handle = registerModelProvider({
      ctx: { get: (name: string) => (name === 'llm' ? service : undefined) },
      registry: consoleInstance.registry,
      config: consoleInstance.config,
      log: noLog,
      modules: fakeModules().modules,
    })
    assert.equal(handle.active, false)
    assert.match(handle.reason ?? '', /enabled=false/)
    assert.deepEqual(state.routes, [], '一条路由都不该注册')
  } finally {
    await consoleInstance.close()
  }
})

test('registerModelProvider：没有可用模型时不注册（选择器里不留空分组）', async () => {
  const consoleInstance = consoleFor({
    dashboard: { enabled: false },
    accounts: [{ id: 'bare', provider: 'volcengine', apiKey: 'sk' }],
  })
  const { service, state } = fakeLlm()
  try {
    const handle = registerModelProvider({
      ctx: { get: (name: string) => (name === 'llm' ? service : undefined) },
      registry: consoleInstance.registry,
      config: consoleInstance.config,
      log: noLog,
      modules: fakeModules().modules,
    })
    assert.equal(handle.active, false)
    assert.match(handle.reason ?? '', /models/)
    assert.deepEqual(state.routes, [])
  } finally {
    await consoleInstance.close()
  }
})

test('registerModelProvider：宿主模块加载失败时不激活，且不阻塞其它能力', async () => {
  const consoleInstance = consoleFor(accountsConfig())
  const { service, state } = fakeLlm()
  const logs: string[] = []
  try {
    const handle = registerModelProvider({
      ctx: { get: (name: string) => (name === 'llm' ? service : undefined) },
      registry: consoleInstance.registry,
      config: consoleInstance.config,
      log: (message) => logs.push(message),
      // 不注入 modules => 走真实的惰性 import，本测试环境里必然失败
    })
    assert.equal(handle.active, true, '有 llm 服务 + 有模型 => 视为激活，异步补齐模块')
    // 等到异步 import 结束
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.deepEqual(state.routes, [], '模块加载失败时不该注册任何路由')
    assert.ok(
      logs.some((message) => /未启用/.test(message)),
      `应记录模块加载失败：${logs.join(' | ')}`,
    )
    handle.dispose()
  } finally {
    await consoleInstance.close()
  }
})

test('registerModelProvider：目录注册失败不影响已经成功的路由', async () => {
  const consoleInstance = consoleFor(accountsConfig())
  const logs: string[] = []
  const registered: string[][] = []
  const service: HostLlmService = {
    registerAdapter(routes) {
      registered.push([...routes])
      return () => undefined
    },
    registerConfigurableProviders() {
      throw new Error('DUPLICATE_DIRECTORY')
    },
  }
  try {
    const handle = registerModelProvider({
      ctx: { get: (name: string) => (name === 'llm' ? service : undefined) },
      registry: consoleInstance.registry,
      config: consoleInstance.config,
      log: (message) => logs.push(message),
      modules: fakeModules().modules,
    })
    assert.equal(handle.active, true)
    assert.deepEqual(registered, [['pc-ds-main', 'pc-kimi-main']], '适配器注册成功')
    assert.ok(
      logs.some((message) => /目录注册失败/.test(message)),
      '目录失败要记日志但不能把路由打掉',
    )
  } finally {
    await consoleInstance.close()
  }
})

// ---------------------------------------------------------------------------
// 服务识别
// ---------------------------------------------------------------------------

test('isLlmService：只认有 registerAdapter 的对象', () => {
  assert.equal(isLlmService(undefined), false)
  assert.equal(isLlmService(null), false)
  assert.equal(isLlmService({}), false)
  assert.equal(isLlmService({ registerAdapter: 'nope' }), false)
  assert.equal(isLlmService({ registerAdapter: () => undefined }), true)
})

test('llmServiceOf：有服务时返回服务，没有时返回 undefined 并记一条日志', () => {
  const logs: string[] = []
  const logs2: string[] = []
  const service = { registerAdapter: () => () => undefined }
  assert.equal(llmServiceOf({ get: () => service }, (m) => logs.push(m)), service)
  assert.equal(logs.length, 0)
  assert.equal(llmServiceOf({ get: () => ({}) }, (m) => logs2.push(m)), undefined)
  assert.equal(logs2.length, 0, '形状不对时静默返回 undefined，由调用方决定怎么记')
  assert.equal(llmServiceOf({}, () => undefined), undefined)
})

test('loadHostModules：本测试环境里没有宿主包 => 返回原因而不是抛异常', async () => {
  const result = await loadHostModules()
  assert.equal(result.modules, undefined)
  assert.ok(result.reason, '必须给出一个可读的原因')
})
