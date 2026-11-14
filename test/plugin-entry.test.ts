/**
 * Cordis 入口冒烟：验证审批后接入的 systemPrompt 段注入与云签名开关。
 * 全部是本地 mock 宿主，不需要 DSH 运行时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name, version } from '../src/index.ts'
import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER } from '../src/prompt-section.ts'
import type { ConsoleConfig } from '../src/types.ts'

interface RegisteredSection {
  name: string
  order: number
  text: string
  interpolate?: boolean
}

interface Harness {
  ctx: Record<string, unknown>
  sections: RegisteredSection[]
  disposedSections: string[]
  tools: Array<{ name: string }>
  cleanup: () => void
  /** 注册进 ctx.get() 的服务表（模拟 Cordis 的 ctx.get）。 */
  services: Map<string, unknown>
  logs: string[]
}

function harness(
  options: {
    withService?: boolean
    withInject?: boolean
    /** 宿主提供的 credentials 服务；传 false 表示宿主没有该服务。 */
    credentials?: Record<string, unknown> | false
    /** 宿主提供的 llm 服务；传 false 表示宿主没有该服务。 */
    llm?: Record<string, unknown> | false
    /** ctx.get 抛错（模拟 Cordis 上下文未激活）。 */
    getThrows?: boolean
    /** 宿主提供的 webServer 服务；传 false 表示宿主没有该服务。 */
    webServer?: Record<string, unknown> | false
  } = {},
): Harness {
  const sections: RegisteredSection[] = []
  const disposedSections: string[] = []
  const tools: Array<{ name: string }> = []
  const logs: string[] = []
  const services = new Map<string, unknown>()
  // 可能有多条 effect（工具清理、调试台路由、模型 provider…），按注册顺序逆序释放
  const disposers: Array<() => void> = []
  let cleanup: () => void = () => undefined

  const service = {
    section(input: RegisteredSection) {
      sections.push(input)
      return () => disposedSections.push(input.name)
    },
  }
  const ctx: Record<string, unknown> = {
    tools: {
      register(tool: { name: string }) {
        tools.push(tool)
        return () => undefined
      },
    },
    logger: () => ({ info: (message: string) => logs.push(String(message)), warn() {} }),
    effect(cb: () => () => void) {
      const dispose = cb()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    emit() {},
    provide() {},
    set(name: string, value: unknown) {
      services.set(name, value)
    },
    get(name: string) {
      if (options.getThrows) throw new Error('cannot get property without inject')
      return services.get(name)
    },
  }
  if (options.withService !== false) ctx.systemPrompt = service
  if (options.credentials !== false) {
    services.set(
      'credentials',
      options.credentials ?? {
        async resolve(ref: string) {
          const table: Record<string, string> = {
            DEEPSEEK_API_KEY: 'sk-harness-deepseek',
            ZHIPU_API_KEY: 'sk-harness-zhipu',
          }
          const value = table[ref]
          return value === undefined ? undefined : { value, source: 'file' }
        },
        async describe(ref: string) {
          const configured = ref === 'DEEPSEEK_API_KEY' || ref === 'ZHIPU_API_KEY'
          return { configured, writable: true }
        },
      },
    )
  }
  if (options.withInject) {
    // 现在有两个可选服务都会走 ctx.inject：systemPrompt 与 webServer。
    // 按 deps 分派，而不是硬断成 ['systemPrompt'] —— 后者会把「新加了一个可选
    // 服务」误判成回归。
    ctx.inject = (deps: string[], cb: (scope: Record<string, unknown>) => unknown) => {
      assert.ok(Array.isArray(deps) && deps.length === 1, `ctx.inject 应只等一个服务，实际 ${String(deps)}`)
      const injected: Record<string, unknown> = { ...ctx }
      if (deps[0] === 'systemPrompt') injected.systemPrompt = service
      if (deps[0] === 'webServer') injected.webServer = services.get('webServer')
      const disposer = cb(injected)
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
    }
  }
  if (options.llm !== false) {
    services.set('llm', options.llm ?? fakeLlmService())
  }
  // webServer 默认提供：调试台路由只有在宿主真有该服务时才挂得上去
  if (options.webServer !== false) {
    services.set('webServer', options.webServer ?? fakeWebServer().service)
  }
  return {
    ctx,
    sections,
    disposedSections,
    tools,
    // 逆序释放：后注册的先释放，和 Cordis effect 的语义一致
    cleanup: () => {
      for (const dispose of disposers.splice(0).reverse()) dispose()
      cleanup()
    },
    services,
    logs,
  }
}

/** 假 webServer：记录 register 的每条路由，disposer 记进 removed。 */
function fakeWebServer() {
  const routes: Array<{ kind: string; path: string; handler: unknown }> = []
  const removed: string[] = []
  return {
    routes,
    removed,
    service: {
      host: '127.0.0.1',
      port: 3080,
      register(route: { kind: string; path: string; handler: unknown }) {
        routes.push(route)
        return () => removed.push(route.path)
      },
    },
  }
}

/** 假 llm 服务：记录注册了什么，句柄可释放。 */
export function fakeLlmService() {  const state = {
    routes: [] as string[][],
    directory: [] as Array<Array<{ provider: string; displayName: string; declared: boolean }>>,
    discoveries: [] as string[],
    disposed: [] as string[],
  }
  return {
    state,
    service: {
      registerAdapter(routes: string[]) {
        state.routes.push([...routes])
        const handle = (() => state.disposed.push(`adapter:${routes.join(',')}`)) as {
          (): void
          replace?(next: string[]): void
        }
        handle.replace = (next) => state.routes.push([...next])
        return handle
      },
      registerConfigurableProviders(entries: Array<{ provider: string; displayName: string; declared: boolean }>) {
        state.directory.push([...entries])
        const handle = (() => state.disposed.push(`directory:${entries.length}`)) as {
          (): void
          replace?(next: unknown[]): void
        }
        handle.replace = (next) =>
          state.directory.push([...(next as Array<{ provider: string; displayName: string; declared: boolean }>)])
        return handle
      },
      registerModelDiscovery(settingsNs: string) {
        state.discoveries.push(settingsNs)
        return () => state.disposed.push(`discovery:${settingsNs}`)
      },
    },
  }
}

/** 假宿主 LLM 模块：让注册路径走通，不需要真的装上 dsh-llm-pi-ai。 */
export function fakeModules() {
  return {
    PiAiAdapter: class {
      config: Record<string, unknown>
      constructor(config: Record<string, unknown>) {
        this.config = config
      }
    } as never,
    createProvider: ((input: { id: string; name: string; models: unknown[] }) => ({
      id: input.id,
      name: input.name,
      auth: {},
      getModels: () => input.models,
      stream: () => undefined,
      streamSimple: () => undefined,
    })) as never,
    openAICompletionsApi: (() => ({ kind: 'openai-completions' })) as never,
    // HostModules 要求这个构造器：插件用它抛 MISSING_CREDENTIAL，
    // 让 pi-ai 的 listModels() 把「无凭据」与「真故障」区分开。
    LlmError: class LlmError extends Error {
      code: string
      constructor(message: string, code: string) {
        super(message)
        this.code = code
      }
    } as never,
  }
}

const baseConfig: ConsoleConfig = { accounts: [], dashboard: { enabled: false } }

test('插件元数据与工具注册', () => {
  const h = harness()
  apply(h.ctx as never, baseConfig)
  assert.equal(name, 'provider-console')
  assert.equal(version, '0.4.1')
  assert.deepEqual(
    h.tools.map((tool) => tool.name).sort(),
    ['provider_accounts', 'provider_balances', 'provider_call', 'provider_models', 'provider_request', 'provider_status'],
  )
  assert.equal(h.sections.length, 0, '默认不注入提示词段')
  h.cleanup()
})

test('systemPromptSection=true 时通过宿主服务注入段，卸载时释放', () => {
  const h = harness()
  apply(h.ctx as never, { ...baseConfig, systemPromptSection: true })
  assert.equal(h.sections.length, 1)
  const section = h.sections[0]
  assert.equal(section.name, PROMPT_SECTION_NAME)
  assert.equal(section.order, PROMPT_SECTION_ORDER)
  assert.equal(section.interpolate, false, '示例片段不能被 {{}} 插值器改写')
  assert.match(section.text, /provider_balances/)
  assert.match(section.text, /不要编造余额/)
  h.cleanup()
  assert.deepEqual(h.disposedSections, [PROMPT_SECTION_NAME])
})

test('支持自定义提示词文本与 order', () => {
  const h = harness()
  apply(h.ctx as never, {
    ...baseConfig,
    systemPromptSection: true,
    systemPromptText: '自定义段落 {{literal}}',
    systemPromptOrder: 1234,
  })
  assert.equal(h.sections[0].text, '自定义段落 {{literal}}')
  assert.equal(h.sections[0].order, 1234)
  h.cleanup()
})

test('服务晚于插件挂载时通过 ctx.inject 等待，仍能注入', () => {
  const h = harness({ withService: false, withInject: true })
  apply(h.ctx as never, { ...baseConfig, systemPromptSection: true })
  assert.equal(h.sections.length, 1)
  assert.equal(h.sections[0].name, PROMPT_SECTION_NAME)
  h.cleanup()
  assert.ok(h.disposedSections.includes(PROMPT_SECTION_NAME))
})

test('宿主完全不提供 systemPrompt 服务时静默降级，工具照常注册', () => {
  const h = harness({ withService: false })
  apply(h.ctx as never, { ...baseConfig, systemPromptSection: true })
  assert.equal(h.sections.length, 0)
  assert.equal(h.tools.length, 6)
  h.cleanup()
})

test('cloudSigning.enabled=false 不注册签名服务商，也不影响工具', () => {
  const h = harness()
  apply(h.ctx as never, {
    ...baseConfig,
    cloudSigning: { enabled: false, aliyun: { accessKeySecretEnv: 'NO_SUCH_SECRET' } },
  })
  assert.equal(h.tools.length, 6)
  assert.equal(h.sections.length, 0)
  h.cleanup()
})

// ---------------------------------------------------------------------------
// 凭证自动探测：可选 credentials 服务
// ---------------------------------------------------------------------------

/** 从注册进 ctx.tools 的工具里取出 provider_status 的 execute 结果。 */
async function statusOf(h: Harness): Promise<Record<string, any>> {
  const tool = h.tools.find((item) => item.name === 'provider_status') as unknown as {
    execute(args: unknown, exec: { signal: AbortSignal }): Promise<Record<string, any>>
  }
  assert.ok(tool, 'provider_status 必须已注册')
  return tool.execute({}, { signal: new AbortController().signal })
}

test('插件不把 credentials 写进 inject 硬依赖（缺少该服务的宿主也能加载）', () => {
  assert.deepEqual([...inject], ['tools'])
  assert.equal(inject.includes('credentials'), false, 'credentials 必须是可选依赖')
})

test('宿主提供 credentials 服务：自动生成账户，状态工具报告探测结果', async () => {
  const h = harness()
  apply(h.ctx as never, baseConfig)
  const api = h.services.get('providerConsole') as { rediscover(): Promise<unknown> }
  await api.rediscover()

  const status = await statusOf(h)
  const discovery = status.autoDiscover
  assert.equal(discovery.enabled, true, 'autoDiscover 默认开启')
  assert.equal(discovery.serviceAvailable, true, 'credentials 服务可用')
  assert.equal(discovery.pending, false)
  assert.equal(discovery.discovered, 2, 'deepseek + zhipu')
  assert.equal(discovery.providers.length, 9)
  const deepseek = discovery.providers.find((item: any) => item.provider === 'deepseek')
  assert.equal(deepseek.configured, true)
  assert.equal(deepseek.keyEnv, 'DEEPSEEK_API_KEY')
  const hunyuan = discovery.providers.find((item: any) => item.provider === 'hunyuan')
  assert.equal(hunyuan.configured, false)

  const accountIds = (status.accounts as Array<{ id: string }>).map((item) => item.id)
  assert.deepEqual(accountIds.sort(), ['deepseek', 'zhipu'])
  assert.ok((status.accounts as Array<{ discovered?: boolean }>).every((item) => item.discovered === true))
  h.cleanup()
})

test('宿主没有 credentials 服务：静默降级，插件正常加载、工具全在', async () => {
  const h = harness({ credentials: false })
  assert.doesNotThrow(() => apply(h.ctx as never, baseConfig))
  assert.equal(h.tools.length, 6)

  const status = await statusOf(h)
  const discovery = status.autoDiscover
  assert.equal(discovery.serviceAvailable, false)
  assert.equal(discovery.discovered, 0)
  assert.deepEqual(status.accounts, [])
  assert.ok((status.warnings as string[]).some((w) => w.includes('credentials 服务')))
  h.cleanup()
})

test('ctx.get 抛错（上下文未激活）时不冒泡，插件照常加载', () => {
  const h = harness({ getThrows: true })
  assert.doesNotThrow(() => apply(h.ctx as never, baseConfig))
  assert.equal(h.tools.length, 6)
  assert.ok(h.logs.some((line) => line.includes('读取 credentials 服务失败')))
  h.cleanup()
})

test('宿主给了 credentials 但没有 resolve/describe 时视同不可用', async () => {
  const h = harness({ credentials: { notACredentialService: true } })
  assert.doesNotThrow(() => apply(h.ctx as never, baseConfig))
  const status = await statusOf(h)
  assert.equal(status.autoDiscover.serviceAvailable, false)
  assert.deepEqual(status.accounts, [])
  h.cleanup()
})

test('显式账户优先：cordis.patch.yml 里的账户不会被自动探测覆盖', async () => {
  const h = harness({
    credentials: {
      async resolve(ref: string) {
        return ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-auto' } : undefined
      },
      async describe(ref: string) {
        return { configured: ref === 'DEEPSEEK_API_KEY', writable: true }
      },
    },
  })
  apply(h.ctx as never, {
    ...baseConfig,
    accounts: [{ id: 'deepseek', provider: 'deepseek', apiKeyEnv: 'NO_SUCH_VAR', label: '我的主账号' }],
  })
  const api = h.services.get('providerConsole') as { rediscover(): Promise<unknown> }
  await api.rediscover()

  const status = await statusOf(h)
  assert.equal((status.accounts as unknown[]).length, 1)
  const account = (status.accounts as Array<Record<string, any>>)[0]
  assert.equal(account.id, 'deepseek')
  assert.equal(account.label, '我的主账号', '保留用户配置')
  assert.equal(account.discovered, undefined, '不能被标成自动账户')
  assert.equal(account.apiKeySource.startsWith('credentials:'), false, '凭据来源仍是用户配置的')
  assert.equal(status.autoDiscover.discovered, 0, '一个都没新增')
  assert.deepEqual(status.autoDiscover.skipped.map((item: any) => item.provider), ['deepseek'])
  h.cleanup()
})

test('autoDiscover=false 时状态工具如实报告已关闭', async () => {
  const h = harness()
  apply(h.ctx as never, { ...baseConfig, autoDiscover: false })
  const api = h.services.get('providerConsole') as { rediscover(): Promise<unknown> }
  await api.rediscover()
  const status = await statusOf(h)
  assert.equal(status.autoDiscover.enabled, false)
  assert.equal(status.autoDiscover.discovered, 0)
  assert.deepEqual(status.accounts, [])
  h.cleanup()
})

test('状态工具渲染文本包含自动探测小节与逐项配置状态', async () => {
  const h = harness()
  apply(h.ctx as never, baseConfig)
  const api = h.services.get('providerConsole') as { rediscover(): Promise<unknown> }
  await api.rediscover()
  const tool = h.tools.find((item) => item.name === 'provider_status') as unknown as {
    execute(args: unknown): Promise<Record<string, any>>
    output: { render(args: unknown, value: unknown): Array<{ type: string; text: string }> }
  }
  const value = await tool.execute({})
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /凭证自动探测/)
  assert.match(text, /autoDiscover=true/)
  assert.match(text, /探测到：2 个服务商/)
  assert.match(text, /已配置/)
  assert.match(text, /未配置/)
  h.cleanup()
})

// ---------------------------------------------------------------------------
// 模型 provider：可选 llm 服务
// ---------------------------------------------------------------------------

test('llm 不在 inject 硬依赖里（缺少该服务的宿主也要能加载）', () => {
  assert.deepEqual([...inject], ['tools'])
  assert.equal(inject.includes('llm'), false, 'llm 必须是可选依赖')
})

test('宿主没有 llm 服务：一条 warning，工具全在，不抛异常', async () => {
  const h = harness({ llm: false })
  assert.doesNotThrow(() => apply(h.ctx as never, baseConfig))
  assert.equal(h.tools.length, 6)
  assert.ok(
    h.logs.some((line) => line.includes('模型 provider 未启用') && line.includes('llm 服务')),
    `应记录降级原因：${h.logs.join(' | ')}`,
  )
  const status = await statusOf(h)
  assert.equal(status.modelProvider.active, false)
  assert.equal(status.modelProvider.routes.length, 0)
  h.cleanup()
})

test('有 llm 服务但没账户模型：不激活，选择器里不留空分组', async () => {
  const fake = fakeLlmService()
  const h = harness({ llm: fake.service })
  apply(h.ctx as never, baseConfig)
  assert.ok(h.logs.some((line) => line.includes('没有可公布的账户模型')))
  assert.deepEqual(fake.state.routes, [])
  const status = await statusOf(h)
  assert.equal(status.modelProvider.active, false)
  h.cleanup()
})

test('有 llm 服务且有账户模型：注册路由并通过 modelProvider() 报告', async () => {
  const fake = fakeLlmService()
  const h = harness({ llm: fake.service })
  apply(
    h.ctx as never,
    {
      ...baseConfig,
      accounts: [{ id: 'ds', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY', models: ['deepseek-chat'] }],
    },
    { llmModules: fakeModules() },
  )
  const status = await statusOf(h)
  assert.equal(status.modelProvider.active, true)
  assert.deepEqual(
    status.modelProvider.routes.map((route: any) => route.provider),
    ['pc-ds'],
  )
  const route = status.modelProvider.routes[0]
  assert.equal(route.accountId, 'ds')
  assert.equal(route.hasApiKey, false, 'TEST_DS_KEY 未在环境里，如实报告没有密钥')
  assert.deepEqual(
    route.models.map((model: any) => model.id),
    ['deepseek-chat'],
  )
  assert.equal(route.apiKey, undefined, '绝不能把密钥字段带进状态')
  assert.ok(fake.state.disposed.includes('adapter:pc-ds') === false, '此刻还没释放')
  h.cleanup()
  assert.ok(fake.state.disposed.includes('adapter:pc-ds'), '插件卸载时释放适配器')
})

test('llmProvider.enabled=false 时明确报告关闭原因', async () => {
  const fake = fakeLlmService()
  const h = harness({ llm: fake.service })
  apply(h.ctx as never, {
    ...baseConfig,
    llmProvider: { enabled: false },
    accounts: [{ id: 'ds', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY', models: ['deepseek-chat'] }],
  })
  const status = await statusOf(h)
  assert.equal(status.modelProvider.active, false)
  assert.match(status.modelProvider.reason, /enabled=false/)
  assert.deepEqual(fake.state.routes, [], '一条路由都不该注册')
  h.cleanup()
})

test('unregisterAccount 会重算模型路由（不留死路由）', async () => {
  const fake = fakeLlmService()
  const h = harness({ llm: fake.service })
  apply(
    h.ctx as never,
    {
      ...baseConfig,
      accounts: [
        { id: 'ds', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY', models: ['deepseek-chat'] },
        { id: 'kimi', provider: 'moonshot-cn', apiKeyEnv: 'TEST_KIMI_KEY', models: ['kimi-k2'] },
      ],
    },
    { llmModules: fakeModules() },
  )
  const api = h.services.get('providerConsole') as { unregisterAccount(id: string): boolean }
  assert.equal(api.unregisterAccount('kimi'), true)
  assert.deepEqual(fake.state.routes.at(-1), ['pc-ds'], '删掉账户后剩余路由被 replace 进去')
  h.cleanup()
})

test('ctx.get 抛错时模型 provider 也一并降级（与 credentials 互不牵连）', async () => {
  const h = harness({ getThrows: true })
  assert.doesNotThrow(() => apply(h.ctx as never, baseConfig))
  assert.equal(h.tools.length, 6)
  assert.ok(h.logs.some((line) => line.includes('读取 credentials 服务失败')))
  assert.ok(
    h.logs.some((line) => line.includes('读取 llm 服务失败')),
    '两个可选服务各自降级，互不牵连',
  )
  h.cleanup()
})
