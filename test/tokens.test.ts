/**
 * token 存在性守卫。
 *
 * ============================================================================
 * 为什么需要这个文件
 * ============================================================================
 * 0.3.0 在亮色主题下永远是黑底白字，原因不是「颜色选错了」，而是 client.js 里
 * 写了 3 个**根本不存在**的 CSS 自定义属性：
 *
 *   --dsw-alias-text-primary      （真实名：--dsw-alias-label-primary）
 *   --dsw-alias-text-secondary    （真实名：--dsw-alias-label-secondary）
 *   --dsw-alias-bg-layer-0        （真实名：--dsw-alias-bg-base）
 *
 * 因为 `var(--typo, #232936)` 的 fallback 永远生效，浏览器不报错、测试也不红，
 * 于是「暗色兜底值」被当成了真实主题色 —— 亮色主题下必然全黑。**inline fallback
 * 把拼写错误变成了静默错误**，这就是本文件的由来。
 *
 * 做法：把宿主真实发布的 token 名单固化在 tokens.fixture.json（从 DSH 0.2.2-rc.1
 * 的 design-platform.css / base.css / focus.css / gradient-shadow-text.css 提取），
 * 然后扫描插件自己的 CSS，逐个断言存在。
 *
 * 名单是快照，不随宿主升级自动更新 —— 这是刻意的：宿主删掉某个 token 时本测试
 * 应当变红提醒我们去核对，而不是假装还在。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./tokens.fixture.json', import.meta.url)), 'utf8'),
) as { source: string; tokens: string[] }

/** 宿主真实存在的 token 集合。 */
const HOST_TOKENS = new Set(fixture.tokens)

/** 读取插件里所有会写 CSS 的源文件。 */
function readSources() {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  return {
    clientJs: read('../client.js'),
    indexHtml: read('../public/index.html'),
  }
}

/**
 * 去掉注释：HTML 的 <!-- -->、块注释与行注释。
 *
 * 必要性：本文件里多处断言「源码里不得出现某个字符串」（不得引用错 token、
 * 不得用 border-bottom），而这些文件的**文档注释恰好会解释「为什么不这么做」
 * 并原样写出那个字符串。不剥注释就会把「解释」误判成「违规」。
 *
 * 行注释的正则用 [^:] 排除 `http://` 这类链接中的双斜杠。
 */
function stripComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 抽出一段文本里所有 `--dsw-*` 的引用（var(--dsw-x) 或 --dsw-x: … 的定义）。
 *
 * 只认 --dsw- 前缀：插件的本地别名（--bg / --panel / …）不是宿主 token，不该被
 * 检查；--dsh-* 是宿主的运行时变量（如 --dsh-frame-top-clearance），由宿主注入，
 * 也不在 fixture 的静态名单里。
 */
function tokenRefs(text: string): string[] {
  const found = new Set<string>()
  for (const match of stripComments(text).matchAll(/--dsw-[a-zA-Z0-9-]+/g)) {
    found.add(match[0].replace(/-+$/, ''))
  }
  return [...found].sort()
}

test('fixture 覆盖宿主的关键 token，且不含 0.3.0 的三个错误名', () => {
  assert.ok(fixture.tokens.length > 300, `fixture 应有 300+ token，实际 ${fixture.tokens.length}`)
  for (const required of [
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-layer-3',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-label-caption',
    '--dsw-alias-label-primary-foreground',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-border-l3',
    '--dsw-alias-border-l4',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-success-tertiary',
    '--dsw-alias-state-warn-primary',
    '--dsw-alias-state-warn-tertiary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-business-primary',
    '--dsw-alias-state-idle-primary',
    '--dsw-alias-interactive-bg-hover',
    '--dsw-alias-interactive-bg-active',
    '--dsw-alias-button-primary-fill',
    '--dsw-alias-button-primary-hover',
    '--dsw-alias-markdown-code-block',
    '--dsw-elevation-soft',
    '--dsw-elevation-stroke',
    '--dsw-elevation-prominent',
    '--dsw-focus-ring-width',
    '--dsw-radius-xs',
    '--dsw-radius-sm',
    '--dsw-radius-md',
    '--dsw-radius-lg',
    '--dsw-radius-xl',
    '--dsw-radius-panel',
    '--dsw-shadow-lv1',
    '--dsw-shadow-lv2',
    '--dsw-shadow-lv3',
  ]) {
    assert.ok(HOST_TOKENS.has(required), `fixture 应包含 ${required}`)
  }
  // 三条历史 bug 名必须**不在**名单里，否则这个守卫就失效了
  for (const bogus of ['--dsw-alias-text-primary', '--dsw-alias-text-secondary', '--dsw-alias-bg-layer-0']) {
    assert.equal(HOST_TOKENS.has(bogus), false, `fixture 不应包含不存在的 ${bogus}`)
  }
  assert.match(fixture.source, /design-platform\.css/)
})

test('client.js 引用的每个 --dsw-* token 都真实存在', () => {
  const { clientJs } = readSources()
  const refs = tokenRefs(clientJs)
  assert.ok(refs.length >= 25, `client.js 应使用足够的 token，实际只有 ${refs.length} 个`)
  const missing = refs.filter((token) => !HOST_TOKENS.has(token))
  assert.deepEqual(missing, [], `client.js 引用了不存在的 token：${missing.join(', ')}`)
})

test('public/index.html 引用的每个 --dsw-* token 都真实存在', () => {
  const { indexHtml } = readSources()
  const refs = tokenRefs(indexHtml)
  assert.ok(refs.length >= 15, `index.html 应使用足够的 token，实际只有 ${refs.length} 个`)
  const missing = refs.filter((token) => !HOST_TOKENS.has(token))
  assert.deepEqual(missing, [], `index.html 引用了不存在的 token：${missing.join(', ')}`)
})

test('0.3.0 的三个错名在插件源码里彻底消失', () => {
  const { clientJs, indexHtml } = readSources()
  const js = stripComments(clientJs)
  const html = stripComments(indexHtml)
  for (const bogus of ['--dsw-alias-text-primary', '--dsw-alias-text-secondary', '--dsw-alias-bg-layer-0']) {
    assert.equal(js.includes(bogus), false, `client.js 不应再出现 ${bogus}`)
    assert.equal(html.includes(bogus), false, `index.html 不应再出现 ${bogus}`)
  }
})

test('不写 inline color fallback —— fallback 会掩盖 token 拼写错误', () => {
  const { clientJs } = readSources()
  // 规则：var(--dsw-xxx, <fallback>) 一律不允许。要么有 token，要么没有；
  // 兜一个写死的颜色等于把「token 打错了」变成「看起来能用」。
  const withFallback = [...stripComments(clientJs).matchAll(/var\(\s*--dsw-[a-zA-Z0-9-]+\s*,[^)]*\)/g)].map(
    (m) => m[0],
  )
  assert.deepEqual(withFallback, [], `client.js 不得给 token 写 inline fallback：${withFallback.join(' | ')}`)
})

test('index.html 的本地别名只做「← token」映射，且保留原有变量名', () => {
  const { indexHtml } = readSources()
  // 本地别名必须仍然存在（100+ 处引用依赖它们），只是值改成指向宿主 token
  for (const local of [
    '--bg',
    '--panel',
    '--border',
    '--text',
    '--muted',
    '--accent',
    '--ok',
    '--warn',
    '--err',
    '--soft',
    '--code',
  ]) {
    assert.equal(new RegExp(`${local}\\s*:`).test(indexHtml), true, `index.html 应仍定义 ${local}`)
  }
  // 核心映射：值必须是 var(--dsw-…)，不能是写死的色值
  assert.match(indexHtml, /--text:\s*var\(--dsw-alias-label-primary/)
  assert.match(indexHtml, /--bg:\s*var\(--dsw-alias-bg-base/)
  assert.match(indexHtml, /--panel:\s*var\(--dsw-alias-bg-layer-2/)
  assert.match(indexHtml, /--muted:\s*var\(--dsw-alias-label-secondary/)
})

test('全圆角必须配 corner-shape:round（否则被宿主 superellipse 变形）', () => {
  const { clientJs, indexHtml } = readSources()
  for (const [name, text] of [
    ['client.js', clientJs],
    ['index.html', indexHtml],
  ] as const) {
    // 找到每一处 border-radius:50% / 999px 的声明，确认同一规则里有 corner-shape
    const blocks = stripComments(text).split('}')
    let checked = 0
    for (const block of blocks) {
      if (!/border-radius:\s*(50%|999px)/.test(block)) continue
      checked += 1
      assert.match(
        block,
        /corner-shape:\s*round/,
        `${name} 里有一个 border-radius 全圆角缺 corner-shape:round：\n${block.trim()}`,
      )
    }
    assert.ok(checked > 0, `${name} 里应至少有一处全圆角（进度条/徽标），否则这条规则没测到东西`)
  }
})

test('iframe 主题：client.js 传 theme 参数，index.html 消费它', () => {
  const { clientJs, indexHtml } = readSources()
  // client.js 侧：embedUrl 必须拼 theme
  assert.match(clientJs, /embed=1&theme=/)
  // index.html 侧：必须读 ?theme=、必须有 postMessage 接收、必须 setProperty
  assert.match(indexHtml, /params\.get\('theme'\)/)
  assert.match(indexHtml, /addEventListener\('message'/)
  assert.match(indexHtml, /style\.setProperty/)
  // iframe 只接受 --dsw-* 变量注入
  assert.match(indexHtml, /indexOf\('--dsw-'\)\s*!==\s*0/)
  // 旧的硬编码暗色套件必须已经消失
  assert.equal(indexHtml.includes('html.embed body { --bg:'), false, '旧的 iframe 硬编码暗色变量应已删除')
  assert.equal(indexHtml.includes('#171a21'), false, 'index.html 不应保留写死的暗色底 #171a21')
})

test('状态色映射：ok→success / stale,manual→warn / error→error / unsupported→idle', () => {
  const { indexHtml } = readSources()
  assert.match(
    indexHtml,
    /const TONE = \{ ok: 'ok', stale: 'warn', manual: 'warn', error: 'err', unsupported: 'idle' \}/,
  )
  // 样式类必须齐备
  for (const cls of ['.b-ok', '.b-stale, .b-manual', '.b-error', '.b-unsupported']) {
    assert.equal(indexHtml.includes(cls), true, `缺少状态样式 ${cls}`)
  }
  // 语义色必须来自 token
  assert.match(indexHtml, /\.b-ok\s*\{[^}]*var\(--ok/)
  assert.match(indexHtml, /\.b-unsupported\s*\{[^}]*var\(--muted/)
})

test('表格已改成卡片列表（grid 布局，发丝分隔不用 border-bottom）', () => {
  const { indexHtml } = readSources()
  const html = stripComments(indexHtml)
  assert.equal(html.includes('<table'), false, '不应再有 <table>')
  assert.equal(html.includes('<thead'), false)
  assert.equal(/border-bottom\s*:/.test(html), false, '分隔线一律用 box-shadow 发丝线')
  assert.match(html, /\.accounts\s*\{[^}]*display:\s*flex/)
  assert.match(html, /\.account\s*\{[^}]*display:\s*grid/)
  // 两行信息层级：主行 + 次级说明
  assert.match(html, /\.acct-name/)
  assert.match(html, /\.acct-sub/)
  // 卡片材质用 elevation，不用 1px border
  assert.match(html, /box-shadow:\s*var\(--elev-soft\)/)
})

test('余额进度条：轨道 + 语义色填充 + 无法算比例时不编数字', () => {
  const { indexHtml } = readSources()
  const html = stripComments(indexHtml)
  assert.match(html, /\.track\s*\{[^}]*corner-shape:\s*round/)
  assert.match(html, /\.fill\[data-tone="ok"\]/)
  assert.match(html, /\.fill\[data-tone="warn"\]/)
  assert.match(html, /\.fill\[data-tone="err"\]/)
  assert.match(html, /\.fill\[data-tone="idle"\]/)
  // meterOf 没有阈值/配额时必须返回 undefined（渲染中性空轨道），不能瞎编百分比
  assert.match(html, /function meterOf\(item, threshold\)/)
  assert.match(html, /return undefined/)
})

test('焦点环直接用 business 色（--dsw-focus-ring-color 在主题里是 transparent）', () => {
  const { clientJs, indexHtml } = readSources()
  for (const [name, text] of [
    ['client.js', clientJs],
    ['index.html', indexHtml],
  ] as const) {
    const css = stripComments(text)
    if (!css.includes(':focus-visible')) continue
    assert.match(
      css,
      /:focus-visible\s*\{[^}]*outline:[^}]*var\(--dsw-alias-state-business-primary\)|:focus-visible\s*\{[^}]*outline:[^}]*var\(--accent/,
      `${name} 的焦点环应指向 business 色`,
    )
    assert.equal(
      /:focus-visible\s*\{[^}]*solid\s+var\(--dsw-focus-ring-color\)/.test(css),
      false,
      `${name} 不应把 --dsw-focus-ring-color 当实色用（它是 transparent）`,
    )
  }
})
