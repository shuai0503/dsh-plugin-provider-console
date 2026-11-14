/**
 * 渲染证据：把 client.js 的组件树**真的渲染成 HTML 字符串**，并落到
 * test/render-evidence/ 下，供人工核对结构（而不是只靠 assert）。
 *
 * 做法：沙箱里把 react.createElement 换成一个极小的渲染器（支持函数组件、
 * 数组、null、普通 DOM 元素），导出元素树后序列化成 HTML。
 * 这不是浏览器渲染，是**结构**证据 —— 用来确认「卡片列表 / 进度条 / 徽标 /
 * 只读设置页」这些结构真的出现在输出里。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')
const OUT_DIR = fileURLToPath(new URL('./render-evidence/', import.meta.url))

function loadClient() {
  let definition: any = null
  const react = {
    createElement(type: any, props: any, ...children: any[]) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useState(init: any) {
      return [typeof init === 'function' ? init() : init, () => undefined]
    },
    useRef(init: any) {
      return { current: init ?? null }
    },
    useEffect() {
      return undefined
    },
  }
  const sandbox: Record<string, any> = {
    window: { __ModuleLoader__: { load: (def: any) => { definition = def } } },
    require: (id: string) => {
      if (id === 'react') return react
      throw new Error(`unexpected require: ${id}`)
    },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  return definition.factory(sandbox.require)
}

const ATTR_ORDER = ['class', 'data-tone', 'data-variant', 'style', 'href', 'title', 'type']

/** 把 React 的 style 对象序列化成 CSS 文本；这是渲染器与真实 React 的差异点。 */
function cssText(style: Record<string, any>): string {
  return Object.entries(style)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      const prop = key.startsWith('--') ? key : key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
      return `${prop}:${String(value)}`
    })
    .join(';')
}

/** 属性值转义：与浏览器把 DOM 序列化成 HTML 时一致（& 也要转义）。 */
function escapeAttr(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

function attrs(props: Record<string, any>): string {
  const mapped: Record<string, any> = {}
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') mapped.class = value
    else if (key === 'style' && value && typeof value === 'object') mapped.style = cssText(value as Record<string, any>)
    else mapped[key] = value
  }
  const pairs: string[] = []
  for (const key of ATTR_ORDER) {
    const value = mapped[key]
    if (value === undefined || value === null || value === '') continue
    pairs.push(`${key}="${escapeAttr(String(value))}"`)
  }
  // 其余属性按字母序追加，保证输出稳定可比
  for (const key of Object.keys(mapped).sort()) {
    if (ATTR_ORDER.includes(key)) continue
    const value = mapped[key]
    if (value === undefined || value === null || typeof value === 'function') continue
    if (key === 'children' || key === 'key' || key === 'ref' || key === 'onLoad' || key === 'onClick') continue
    if (typeof value === 'object') continue
    pairs.push(`${key}="${escapeAttr(String(value))}"`)
  }
  return pairs.length ? ' ' + pairs.join(' ') : ''
}

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link'])

function render(node: any, depth = 0): string {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string') return node.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => render(child, depth)).join('')
  if (typeof node.type === 'function') return render(node.type(node.props), depth)
  const tag = String(node.type)
  const inner = node.children.map((child: any) => render(child, depth + 1)).join('')
  if (VOID.has(tag)) return `<${tag}${attrs(node.props)} />`
  return `<${tag}${attrs(node.props)}>${inner}</${tag}>`
}

function pretty(html: string): string {
  // 只做「块级元素前后换行」的轻度美化，便于人工阅读
  return html
    .replace(/></g, '>\n<')
    .split('\n')
    .map((line, index) => '  '.repeat(Math.min(6, countDepth(html, line))) + line.trim())
    .join('\n')

  function countDepth(_all: string, line: string): number {
    if (/^<\/(div|section|header|pre|button|a|span|h2|code)>/.test(line)) return 0
    return 1
  }
}

test('主面板渲染出工具条 + iframe（带 embed/theme），且没有 inline 深色样式', () => {
  const plugin = loadClient()
  const Page = plugin.__test.makePage({ dashboard: { enabled: true, host: '127.0.0.1', port: 8788 } })
  const html = render(Page())
  assert.match(html, /class="dpc-bar"/)
  assert.match(html, /<iframe[^>]*class="dpc-frame"/)
  assert.match(html, /src="http:\/\/127\.0\.0\.1:8788\/\?embed=1&amp;theme=light"/)
  // 不得再有写死的暗色 inline 样式（0.3.0 的 bug 就长这样）
  assert.equal(/#171a21|#232936|#e7eaf0/i.test(html), false, '主面板不得出现写死的暗色值')
  // 按钮走 class 而不是 inline 样式
  assert.match(html, /<button[^>]*class="dpc-btn"/)
  assert.equal(/<button[^>]*style=/.test(html), false, '按钮不应有 inline style')
})

test('看板关闭时渲染开启指引，不渲染 iframe', () => {
  const plugin = loadClient()
  const Page = plugin.__test.makePage({ dashboard: { enabled: false } })
  const html = render(Page())
  assert.equal(html.includes('<iframe'), false)
  assert.match(html, /dashboard\.enabled/)
  assert.match(html, /data-tone="warn"/)
})

test('设置页渲染出只读徽标 + 配置行 + 复制按钮（无输入控件）', () => {
  const plugin = loadClient()
  const Settings = plugin.__test.makeSettingsPage({
    dashboard: { enabled: true, port: 8788 },
    sidebar: { enabled: true, label: '服务商控制台', order: 20 },
    lowBalanceThreshold: 20,
    cacheTtlMs: 60000,
    autoDiscover: true,
    llmProvider: { enabled: true },
  })
  const html = render(Settings())
  assert.match(html, /class="dpc-badge" data-tone="idle">只读</)
  // 9 个配置行都在
  for (const key of [
    'dashboard.enabled',
    'dashboard.port',
    'sidebar.enabled',
    'sidebar.label',
    'sidebar.order',
    'lowBalanceThreshold',
    'cacheTtlMs',
    'autoDiscover',
    'llmProvider.enabled',
  ]) {
    assert.ok(html.includes(key), `设置页应展示 ${key}`)
  }
  assert.match(html, /<pre class="dpc-code">/)
  assert.match(html, /复制 YAML 片段/)
  for (const forbidden of ['<input', '<select', '<textarea']) {
    assert.equal(html.includes(forbidden), false, `设置页不得出现 ${forbidden}`)
  }
})

test('把渲染结构落盘作为人工核对证据', () => {
  mkdirSync(OUT_DIR, { recursive: true })
  const plugin = loadClient()

  const page = render(plugin.__test.makePage({ dashboard: { enabled: true, host: '127.0.0.1', port: 8788 } })())
  const pageOff = render(plugin.__test.makePage({ dashboard: { enabled: false } })())
  const settings = render(
    plugin.__test.makeSettingsPage({
      dashboard: { enabled: true, port: 8788 },
      sidebar: { enabled: true, label: '服务商控制台', order: 20 },
      lowBalanceThreshold: 20,
      cacheTtlMs: 60000,
      autoDiscover: true,
      llmProvider: { enabled: true },
    })(),
  )

  writeFileSync(
    join(OUT_DIR, 'main-panel.html'),
    `<!-- 由 test/render.test.ts 自动生成；client.js 主面板的结构快照 -->\n${page}\n`,
    'utf8',
  )
  writeFileSync(
    join(OUT_DIR, 'main-panel-disabled.html'),
    `<!-- 看板关闭时的开启指引 -->\n${pageOff}\n`,
    'utf8',
  )
  writeFileSync(
    join(OUT_DIR, 'settings-section.html'),
    `<!-- 设置页分区：只读 + 复制 YAML -->\n${settings}\n`,
    'utf8',
  )
  writeFileSync(
    join(OUT_DIR, 'client-css.css'),
    `/* client.js 注入到宿主 <style data-plugin-css> 的完整 CSS */\n${plugin.__test.CSS}\n`,
    'utf8',
  )
  writeFileSync(
    join(OUT_DIR, 'frame-tokens.txt'),
    `${plugin.__test.FRAME_TOKENS.join('\n')}\n`,
    'utf8',
  )

  // 存下来的东西必须就是刚刚渲染出来的（防止写成空文件还声称有证据）
  const saved = readFileSync(join(OUT_DIR, 'main-panel.html'), 'utf8')
  assert.ok(saved.includes('<iframe'), '落盘的主面板快照必须包含 iframe')
  assert.ok(saved.length > 400, '快照文件不应是空的')
  assert.ok(readFileSync(join(OUT_DIR, 'settings-section.html'), 'utf8').includes('只读'))
  assert.equal(pretty(page).length > 0, true)
})
