/**
 * Cordis 入口冒烟：验证审批后接入的 systemPrompt 段注入与云签名开关。
 * 全部是本地 mock 宿主，不需要 DSH 运行时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, version } from '../src/index.ts'
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
}

function harness(options: { withService?: boolean; withInject?: boolean } = {}): Harness {
  const sections: RegisteredSection[] = []
  const disposedSections: string[] = []
  const tools: Array<{ name: string }> = []
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
    logger: () => ({ info() {}, warn() {} }),
    effect(cb: () => () => void) {
      cleanup = cb()
    },
    emit() {},
    provide() {},
    set() {},
    get() {},
  }
  if (options.withService !== false) ctx.systemPrompt = service
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
  return { ctx, sections, disposedSections, tools, cleanup: () => cleanup() }
}

const baseConfig: ConsoleConfig = { accounts: [], dashboard: { enabled: false } }

test('插件元数据与工具注册', () => {
  const h = harness()
  apply(h.ctx as never, baseConfig)
  assert.equal(name, 'provider-console')
  assert.equal(version, '0.1.0')
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
