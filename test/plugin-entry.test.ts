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
    /** ctx.get 抛错（模拟 Cordis 上下文未激活）。 */
    getThrows?: boolean
  } = {},
): Harness {
  const sections: RegisteredSection[] = []
  const disposedSections: string[] = []
  const tools: Array<{ name: string }> = []
  const logs: string[] = []
  const services = new Map<string, unknown>()
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
      cleanup = cb()
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
    ctx.inject = (deps: string[], cb: (scope: Record<string, unknown>) => unknown) => {
      assert.deepEqual(deps, ['systemPrompt'])
      const injected = { ...ctx, systemPrompt: service }
      const disposer = cb(injected)
      if (typeof disposer === 'function') {
        const previous = cleanup
        cleanup = () => {
          ;(disposer as () => void)()
          previous()
        }
      }
    }
  }
  return { ctx, sections, disposedSections, tools, cleanup: () => cleanup(), services, logs }
}

const baseConfig: ConsoleConfig = { accounts: [], dashboard: { enabled: false } }

test('插件元数据与工具注册', () => {
  const h = harness()
  apply(h.ctx as never, baseConfig)
  assert.equal(name, 'provider-console')
  assert.equal(version, '0.2.3')
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
