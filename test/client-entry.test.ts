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

/**
 * 在隔离的浏览器式沙箱里执行自注册脚本，取出导出的 Cordis 插件。
 *
 * React 只垫最低限度的钩子：useState 落到本地变量、useEffect 立即执行并注册
 * cleanup、useRef 返回一个可写对象。这足以让组件函数被当作普通函数调用一遍
 * 并拿到返回的元素树 —— 真实的渲染/重渲染行为不在本文件的覆盖范围内。
 */
function loadClient() {
  let definition: any = null
  const effects: Array<() => void> = []
  const observers: Array<{ target: any; disconnect(): void }> = []
  const react = {
    createElement(type: any, props: any, ...children: any[]): Element {
      return { type, props: props ?? {}, children }
    },
    useState(init: any) {
      return [typeof init === 'function' ? init() : init, () => undefined]
    },
    useRef(init: any) {
      return { current: init ?? null }
    },
    useEffect(fn: () => any) {
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
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
    MutationObserver: class {
      callback: () => void
      target: any = null
      constructor(callback: () => void) {
        this.callback = callback
      }
      observe(target: any) {
        this.target = target
        observers.push(this)
      }
      disconnect() {}
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
  return { plugin, react, effects, observers, sandbox }
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

/**
 * 去掉 // 与 /* *\/ 注释，只留代码。
 *
 * 必要性：本文件有多处断言「源码里不得出现某个字符串」，而 client.js 的文档注释
 * 恰好会解释「为什么不这么做」并写出那个字符串。直接对整份源码断言会把解释性
 * 注释误判成违规实现。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * vm 里创建的对象/数组来自另一个 realm，原型不同 —— `assert.deepEqual`（strict）
 * 会因为「结构相同但不是同一个 Array.prototype」而失败。跨 realm 比较一律先
 * 归一化成当前 realm 的普通值。
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
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

test('apply 注册左侧图标、主面板与设置页分区，且 id/key 对齐', () => {
  const { plugin } = loadClient()
  const { slots, registrations } = fakeSlots()
  plugin.apply({ slots }, { dashboard: { enabled: true, host: '127.0.0.1', port: 8788 } })

  assert.equal(registrations.length, 4, 'main + sidebar.panellist + settings.section + settings.section.icon')
  const side = registrations.find((r) => r.slot === 'sidebar.panellist')!
  const main = registrations.find((r) => r.slot === 'main')!
  const section = registrations.find((r) => r.slot === 'settings.section')!
  const sectionIcon = registrations.find((r) => r.slot === 'settings.section.icon')!
  assert.ok(side && main && section && sectionIcon)

  // keyed slot 要 key，list slot 要 id，且两者的 id/key 必须一致，否则点图标选不到面板
  assert.equal(side.options.id, 'provider-console')
  assert.equal(main.options.key, 'provider-console')
  assert.equal(side.options.order, 20)
  assert.equal(side.options.label(), '服务商控制台')
  assert.equal(typeof side.component, 'function')
  assert.equal(typeof main.component, 'function')

  // settings.section 是 list slot：id 必须有，且 icon 必须用同一个 id
  assert.equal(section.options.id, 'provider-console')
  assert.equal(section.options.order, plugin.__test.SETTINGS_ORDER)
  assert.equal(section.options.label(), '服务商控制台')
  assert.equal(sectionIcon.options.id, 'provider-console', 'icon 的 id 必须与 section 相同')

  const icon = collect(side.component({ size: 18 })).find((n) => n.type === 'svg')
  assert.ok(icon, '左侧图标应渲染 svg')
})

test('主面板内嵌本地看板，URL 来自 config 且带 embed/theme', () => {
  const { plugin } = loadClient()
  const { slots, registrations } = fakeSlots()
  plugin.apply({ slots }, { dashboard: { enabled: true, host: '127.0.0.1', port: 9123 } })
  const main = registrations.find((r) => r.slot === 'main')!
  const frames = collect(main.component()).filter((n) => n.type === 'iframe')
  assert.equal(frames.length, 1)
  assert.ok(String(frames[0].props.src).startsWith('http://127.0.0.1:9123/'))
  assert.ok(String(frames[0].props.src).includes('embed=1'))
  assert.ok(String(frames[0].props.src).includes('theme='), 'iframe 必须带上主题参数')
  // 不能有 inline 样式硬编码暗色：颜色一律来自 class + token
  assert.equal(frames[0].props.style, undefined, '样式应走 class，不用 inline style')
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

test('sidebar 配置可覆盖标签、排序与地址；enabled=false 时不注册入口但保留设置页', () => {
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
  assert.equal(off.registrations.filter((r) => r.slot === 'sidebar.panellist').length, 0)
  assert.equal(off.registrations.filter((r) => r.slot === 'main').length, 0)
  // 入口关掉了，设置页仍要能看到配置，否则用户没有地方把它改回来
  assert.equal(off.registrations.filter((r) => r.slot === 'settings.section').length, 1)
})

test('dashboardUrl 的兜底与显式 url 覆盖；embedUrl 始终带 embed 与 theme', () => {
  const { plugin } = loadClient()
  const { dashboardUrl, embedUrl } = plugin.__test
  assert.equal(dashboardUrl(undefined), 'http://127.0.0.1:8788/')
  assert.equal(dashboardUrl({ dashboard: { host: '127.0.0.1', port: 9001 } }), 'http://127.0.0.1:9001/')
  assert.equal(dashboardUrl({ dashboard: { url: 'http://localhost:9002/base' } }), 'http://localhost:9002/base')
  assert.equal(dashboardUrl({ sidebar: { dashboardUrl: 'http://127.0.0.1:9999/' } }), 'http://127.0.0.1:9999/')
  assert.equal(embedUrl('http://localhost:9002/base', 0, 'light'), 'http://localhost:9002/base?embed=1&theme=light')
  assert.equal(
    embedUrl('http://localhost:9002/base?x=1', 7, 'dark'),
    'http://localhost:9002/base?x=1&embed=1&theme=dark&t=7',
  )
  // 非法 theme 一律降级为 light，绝不拼出 ?theme=undefined
  assert.equal(embedUrl('http://h/p', 0, 'purple'), 'http://h/p?embed=1&theme=light')
})

// ---------------------------------------------------------------------------
// 主题：只认 body[data-ds-dark-theme]，绝不读 prefers-color-scheme
// ---------------------------------------------------------------------------

function fakeDoc(dark: boolean) {
  return {
    body: {
      hasAttribute(name: string) {
        return name === 'data-ds-dark-theme' ? dark : false
      },
    },
  }
}

test('themeOf 只读 body[data-ds-dark-theme]，不读 prefers-color-scheme', () => {
  const { plugin } = loadClient()
  const { themeOf } = plugin.__test
  assert.equal(themeOf(fakeDoc(true)), 'dark')
  assert.equal(themeOf(fakeDoc(false)), 'light')
  // 没有 body / 没有 document 时必须是可用的默认值，不能抛
  assert.equal(themeOf(null), 'light')
  assert.equal(themeOf(undefined), 'light')
  assert.equal(themeOf({}), 'light')
  assert.equal(themeOf({ body: null }), 'light')

  // 源码里绝不能出现 prefers-color-scheme 的**用法** —— DSH 的「跟随系统」已经被
  // ThemePresenter 解析成 data-ds-dark-theme，再读它就会覆盖用户的手动选择。
  // 注释里提到它是允许的（本文件就在解释为什么不读），所以先去掉注释再断言。
  const code = stripComments(source)
  assert.equal(code.includes('prefers-color-scheme'), false, 'client.js 不得读取 prefers-color-scheme')
  assert.equal(code.includes('matchMedia'), false, 'client.js 不得用 matchMedia 判断主题')
})

test('originOf 从看板地址取 origin，失败时返回 undefined', () => {
  const { plugin } = loadClient()
  const { originOf } = plugin.__test
  assert.equal(originOf('http://127.0.0.1:8788/'), 'http://127.0.0.1:8788')
  assert.equal(originOf('https://h:1/base?x=1'), 'https://h:1')
  assert.equal(originOf(''), undefined)
  assert.equal(originOf(undefined), undefined)
  assert.equal(originOf('not a url'), undefined)
})

test('tokenSnapshot 用 getComputedStyle 读 body 上的 token，跳过空值', () => {
  const { plugin } = loadClient()
  const { tokenSnapshot, FRAME_TOKENS } = plugin.__test
  // 无 document 时必须是空对象而不是抛错（browser 半端在 SSR/测试里也会跑）
  assert.deepEqual({ ...tokenSnapshot() }, {})
  assert.ok(FRAME_TOKENS.length > 20, 'token 名单应覆盖宿主配色')
  assert.ok(FRAME_TOKENS.every((t: string) => t.startsWith('--dsw-')), '只允许读 --dsw-* token')
  // 名单里不允许出现不存在的 token（0.3.0 的三个 bug 就是这类拼写错误）
  for (const bogus of ['--dsw-alias-text-primary', '--dsw-alias-text-secondary', '--dsw-alias-bg-layer-0']) {
    assert.equal(FRAME_TOKENS.includes(bogus), false, `FRAME_TOKENS 不能包含不存在的 ${bogus}`)
  }
})

// ---------------------------------------------------------------------------
// dashboard.enabled 两端一致（回归守卫）
// ---------------------------------------------------------------------------

test('dashboard.enabled 的缺省值两端一致：都视为开启', async () => {
  const { resolveConfig } = await import('../src/config.ts')
  const hostDefault = resolveConfig({}).dashboard.enabled
  assert.equal(hostDefault, true, '宿主缺省应为开启')

  const { plugin } = loadClient()
  assert.equal(plugin.__test.dashboardEnabled({}), true, '客户端无配置时应开启')
  assert.equal(plugin.__test.dashboardEnabled({ dashboard: {} }), true)
  assert.equal(plugin.__test.dashboardEnabled({ dashboard: { enabled: true } }), true)
  assert.equal(plugin.__test.dashboardEnabled({ dashboard: { enabled: false } }), false)
})

test('sidebar 的缺省值两端一致：enabled=true / order=20 / label=服务商控制台', async () => {
  const { resolveConfig } = await import('../src/config.ts')
  const host = resolveConfig({}).sidebar
  const { plugin } = loadClient()
  const client = plugin.__test.panelOptions({})
  assert.equal(host.enabled, client.enabled)
  assert.equal(host.order, client.order)
  assert.equal(host.label, client.label())
  assert.equal(host.enabled, true)
  assert.equal(host.order, 20)
  assert.equal(host.label, '服务商控制台')
})

// ---------------------------------------------------------------------------
// 设置页：只读展示 + 复制 YAML，不写配置
// ---------------------------------------------------------------------------

test('设置页展示 9 个关键开关，且不包含任何密钥字段', () => {
  const { plugin } = loadClient()
  const { knobRows } = plugin.__test
  const rows = knobRows({
    dashboard: { enabled: true, port: 8788 },
    sidebar: { enabled: true, label: '服务商控制台', order: 20 },
    lowBalanceThreshold: 20,
    cacheTtlMs: 60000,
    autoDiscover: true,
    llmProvider: { enabled: true },
  })
  const keys = rows.map((r: any) => r.key)
  assert.deepEqual(plain(keys), [
    'dashboard.enabled',
    'dashboard.port',
    'sidebar.enabled',
    'sidebar.label',
    'sidebar.order',
    'lowBalanceThreshold',
    'cacheTtlMs',
    'autoDiscover',
    'llmProvider.enabled',
  ])
  const byKey = new Map(rows.map((r: any) => [r.key, r.value]))
  assert.equal(byKey.get('dashboard.port'), 8788)
  assert.equal(byKey.get('sidebar.label'), '服务商控制台')
  assert.equal(byKey.get('lowBalanceThreshold'), 20)

  // 空配置不能炸，且要走默认值
  const empty = new Map(plugin.__test.knobRows({}).map((r: any) => [r.key, r.value]))
  assert.equal(empty.get('autoDiscover'), true)
  assert.equal(empty.get('cacheTtlMs'), 60000)
  assert.equal(empty.get('sidebar.order'), 20)
})

test('yamlSnippet 生成可粘贴的片段，且绝不含 apiKey / accounts', () => {
  const { plugin } = loadClient()
  const yaml = plugin.__test.yamlSnippet({
    dashboard: { enabled: false, port: 9001 },
    sidebar: { enabled: true, label: '余额', order: 44 },
    lowBalanceThreshold: 5,
    cacheTtlMs: 1000,
    autoDiscover: false,
    llmProvider: { enabled: false },
  })
  assert.match(yaml, /- insert:/)
  assert.match(yaml, /id: provider-console/)
  assert.match(yaml, /name: dsh-plugin-provider-console/)
  assert.match(yaml, /enabled: false/, 'dashboard.enabled=false 要落进去')
  assert.match(yaml, /port: 9001/)
  assert.match(yaml, /label: 余额/)
  assert.match(yaml, /order: 44/)
  assert.match(yaml, /lowBalanceThreshold: 5/)
  assert.match(yaml, /cacheTtlMs: 1000/)
  assert.match(yaml, /autoDiscover: false/)
  // 只读页面的底线：永远不生成密钥相关字段
  for (const forbidden of ['apiKey', 'apiKeyEnv', 'accounts', 'baseUrl']) {
    assert.equal(yaml.includes(forbidden), false, `片段不得包含 ${forbidden}`)
  }
})

test('设置页组件渲染出只读徽标、配置行与复制按钮', () => {
  const { plugin } = loadClient()
  const Settings = plugin.__test.makeSettingsPage({ sidebar: { label: '服务商控制台' } })
  const nodes = collect(Settings())
  const text = nodes.map((n) => (typeof n.children?.[0] === 'string' ? n.children[0] : '')).join(' ')
  assert.ok(text.includes('服务商控制台'), '标题应出现')
  const buttons = nodes.filter((n) => n.type === 'button')
  assert.equal(buttons.length, 1)
  assert.ok(String(buttons[0].children[0]).includes('复制'), '应有复制 YAML 按钮')
  // 只读：页面上不能出现任何输入控件（用户会以为能改）
  for (const forbidden of ['input', 'select', 'textarea']) {
    assert.equal(nodes.filter((n) => n.type === forbidden).length, 0, `设置页不得出现 ${forbidden}`)
  }
})

test('主题变化会触发一次 postMessage（iframe 跟随宿主亮/暗）', () => {
  const { plugin } = loadClient()
  const messages: any[] = []
  const frame = {
    src: 'http://127.0.0.1:8788/?embed=1&theme=dark',
    contentWindow: { postMessage: (payload: any) => messages.push(payload) },
  }
  const { pushTheme, THEME_MESSAGE } = plugin.__test
  assert.equal(pushTheme(frame, 'dark'), true)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].type, THEME_MESSAGE)
  assert.equal(messages[0].theme, 'dark')
  assert.equal(typeof messages[0].tokens, 'object')

  // 没有 contentWindow / 没有 postMessage 时必须返回 false 而不是抛
  assert.equal(pushTheme(null, 'dark'), false)
  assert.equal(pushTheme({}, 'dark'), false)
  assert.equal(pushTheme({ contentWindow: {} }, 'dark'), false)
})
