import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

interface Element {
  type: unknown
  props: Record<string, any>
  children: any[]
}

/** 在隔离的浏览器式沙箱里执行自注册脚本，取出导出的 Cordis 插件。 */
function loadClient() {
  let definition: any = null
  const react = {
    createElement(type: any, props: any, ...children: any[]): Element {
      return { type, props: props ?? {}, children }
    },
    useState(init: any) {
      return [typeof init === 'function' ? init() : init, () => undefined]
    },
  }
  const sandbox: Record<string, any> = {
    window: {
      __ModuleLoader__: {
        load(def: any) {
          definition = def
        },
      },
    },
    require(id: string) {
      if (id === 'react') return react
      throw new Error(`unexpected require: ${id}`)
    },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(definition, 'client.js 必须调用 window.__ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-plugin-provider-console')
  const plugin = definition.factory(sandbox.require)
  return { plugin, react }
}

function collect(node: any, out: Element[] = []): Element[] {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if ('type' in node && 'props' in node) {
    out.push(node as Element)
    for (const child of (node as Element).children ?? []) collect(child, out)
  }
  return out
}

function fakeSlots() {
  const registrations: Array<{ slot: string; options: any; component: any }> = []
  const slots = {
    inject(slot: string, factory: () => any) {
      const result = factory()
      registrations.push({ slot, options: result?.options, component: result?.component })
      return result
    },
    register(options: any, component: any) {
      return { options, component }
    },
  }
  return { slots, registrations }
}

test('client bundle 自注册并导出标准 Cordis 插件接口', () => {
  const { plugin } = loadClient()
  assert.equal(plugin.name, 'provider-console')
  assert.deepEqual([...plugin.inject], ['slots'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply 注册左侧图标与主面板，且 id/key 对齐', () => {
  const { plugin } = loadClient()
  const { slots, registrations } = fakeSlots()
  plugin.apply({ slots }, { dashboard: { enabled: true, host: '127.0.0.1', port: 8788 } })

  assert.equal(registrations.length, 2)
  const side = registrations.find((r) => r.slot === 'sidebar.panellist')
  const main = registrations.find((r) => r.slot === 'main')
  assert.ok(side && main)
  assert.equal(side.options.id, 'provider-console')
  assert.equal(main.options.key, 'provider-console')
  assert.equal(side.options.order, 20)
  assert.equal(side.options.label(), '服务商控制台')
  assert.equal(typeof side.component, 'function')
  assert.equal(typeof main.component, 'function')

  const icon = collect(side.component()).find((n) => n.type === 'svg')
  assert.ok(icon, '左侧图标应渲染 svg')
})

test('主面板内嵌本地看板，URL 来自 config 且带 embed=1', () => {
  const { plugin } = loadClient()
  const { slots, registrations } = fakeSlots()
  plugin.apply({ slots }, { dashboard: { enabled: true, host: '127.0.0.1', port: 9123 } })
  const main = registrations.find((r) => r.slot === 'main')!
  const frames = collect(main.component()).filter((n) => n.type === 'iframe')
  assert.equal(frames.length, 1)
  assert.ok(String(frames[0].props.src).startsWith('http://127.0.0.1:9123/'))
  assert.ok(String(frames[0].props.src).includes('embed=1'))
})

test('看板关闭时给出指引，不渲染 iframe；缺少 slots 服务时静默跳过', () => {
  const { plugin } = loadClient()
  const { slots, registrations } = fakeSlots()
  plugin.apply({ slots }, { dashboard: { enabled: false } })
  const main = registrations.find((r) => r.slot === 'main')!
  const nodes = collect(main.component())
  assert.equal(nodes.filter((n) => n.type === 'iframe').length, 0)
  assert.ok(nodes.some((n) => String(n.children).includes('dashboard.enabled')))
  assert.doesNotThrow(() => plugin.apply({}, {}))
})

test('sidebar 配置可覆盖标签、排序与地址；enabled=false 时不注册入口', () => {
  const { plugin } = loadClient()
  const { slots, registrations } = fakeSlots()
  plugin.apply({ slots }, {
    sidebar: { enabled: true, label: '余额看板', order: 33, dashboardUrl: 'http://127.0.0.1:9999/' },
  })
  const side = registrations.find((r) => r.slot === 'sidebar.panellist')!
  const main = registrations.find((r) => r.slot === 'main')!
  assert.equal(side.options.label(), '余额看板')
  assert.equal(side.options.order, 33)
  const frame = collect(main.component()).find((n) => n.type === 'iframe')!
  assert.ok(String(frame.props.src).startsWith('http://127.0.0.1:9999/'))

  const off = fakeSlots()
  plugin.apply({ slots: off.slots }, { sidebar: { enabled: false } })
  assert.equal(off.registrations.length, 0)
})

test('dashboardUrl 的兜底与显式 url 覆盖', () => {
  const { plugin } = loadClient()
  const { dashboardUrl, embedUrl } = plugin.__test
  assert.equal(dashboardUrl(undefined), 'http://127.0.0.1:8788/')
  assert.equal(dashboardUrl({ dashboard: { host: '127.0.0.1', port: 9001 } }), 'http://127.0.0.1:9001/')
  assert.equal(dashboardUrl({ dashboard: { url: 'http://localhost:9002/base' } }), 'http://localhost:9002/base')
  assert.equal(dashboardUrl({ sidebar: { dashboardUrl: 'http://127.0.0.1:9999/' } }), 'http://127.0.0.1:9999/')
  assert.equal(embedUrl('http://localhost:9002/base', 0), 'http://localhost:9002/base?embed=1')
  assert.equal(embedUrl('http://localhost:9002/base?x=1', 7), 'http://localhost:9002/base?x=1&embed=1&t=7')
})
