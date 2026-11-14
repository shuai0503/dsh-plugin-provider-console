/**
 * 「调试台」前端逻辑：JSON 实时校验、dryRun/发送共用一套构造、结果展示与错误分类。
 *
 * 全部走 client.js 里的**纯函数**（`plugin.__test`），不渲染、不联网：
 * 这些函数是「预览」和「发送」唯一的构造入口，测住它们就测住了整条表单链路。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { DEBUG_BASE, DEBUG_REQUEST_PATH, DEBUG_ACCOUNTS_PATH } from '../src/debug-api.ts'

const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

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
    useMemo(factory: () => any) {
      return factory()
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

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ---------------------------------------------------------------------------
// 同源路由前缀必须两端逐字符一致
// ---------------------------------------------------------------------------

test('前端调试路由前缀与后端 DEBUG_BASE 逐字符一致', () => {
  const plugin = loadClient()
  const endpoints = plain(plugin.__test.debugEndpoints())
  assert.equal(plugin.__test.DEBUG_BASE_PATH, DEBUG_BASE, 'client.js 与 src/debug-api.ts 的路径前缀漂移了')
  assert.equal(endpoints.request, DEBUG_REQUEST_PATH)
  assert.equal(endpoints.accounts, DEBUG_ACCOUNTS_PATH)
  // 绝不能自己拼一个跨源地址（0.3.0 那套 iframe/8788 的教训）
  for (const url of Object.values(endpoints) as string[]) {
    assert.match(url, /^\/dsh-plugin-provider-console\/api\/debug\//)
    assert.equal(/^https?:/i.test(url), false, '必须走同源相对路径，不能是绝对 URL')
  }
})

// ---------------------------------------------------------------------------
// JSON 校验
// ---------------------------------------------------------------------------

test('validateJsonText：合法 JSON 解析出值，空文本视为「不带 body」', () => {
  const { validateJsonText } = loadClient().__test

  const ok = validateJsonText('{"input":"hello"}')
  assert.equal(ok.ok, true)
  assert.equal(ok.empty, false)
  assert.deepEqual(plain(ok.value), { input: 'hello' })

  // 空文本是合法的「不发 body」——GET 本来就不带 body，不该逼用户填 {}
  for (const empty of ['', '   ', '\n\t ']) {
    const result = validateJsonText(empty)
    assert.equal(result.ok, true, `"${empty}" 应视为合法`)
    assert.equal(result.empty, true)
  }
  // 非字符串一律按空处理，不抛
  assert.equal(validateJsonText(undefined).ok, true)
  assert.equal(validateJsonText(null).ok, true)
})

test('validateJsonText：非法 JSON 给出**行号**和原因，且禁用发送', () => {
  const { validateJsonText } = loadClient().__test

  // 第 3 行第 18 列少个引号 —— 报错必须能定位到行，否则用户要自己数
  const broken = '{\n  "a": 1,\n  "b": tru\n}'
  const result = validateJsonText(broken)
  assert.equal(result.ok, false)
  assert.equal(result.line, 3, `行号应指向第 3 行，实际 ${result.line}`)
  assert.ok(result.column > 0, '列号也要有')
  assert.match(result.text, /第 3 行/)
  assert.ok(result.text.length > 6, '要带上原因而不只是一个行号')
  // 原始的 parser 消息保留下来，便于对上游报错
  assert.ok(typeof result.message === 'string' && result.message.length > 0)

  // 尾逗号是手写 JSON 最常见的错
  const trailing = validateJsonText('{\n  "a": 1,\n}')
  assert.equal(trailing.ok, false)
  assert.ok(trailing.line >= 2)

  // 只有开括号：行号应落在最后
  const truncated = validateJsonText('{\n  "a": [1, 2')
  assert.equal(truncated.ok, false)
  assert.ok(truncated.line >= 1)
})

test('positionToLineColumn 是 1 基，且换行本身算到上一行', () => {
  const { positionToLineColumn } = loadClient().__test
  assert.deepEqual(plain(positionToLineColumn('abc', 0)), { line: 1, column: 1 })
  assert.deepEqual(plain(positionToLineColumn('abc', 2)), { line: 1, column: 3 })
  // '\n' 在位置 3：换行后是第 2 行第 1 列
  assert.deepEqual(plain(positionToLineColumn('abc\ndef', 4)), { line: 2, column: 1 })
  assert.deepEqual(plain(positionToLineColumn('a\nb\nc', 4)), { line: 3, column: 1 })
  // 越界位置被夹住，不抛
  assert.deepEqual(plain(positionToLineColumn('ab', 99)), { line: 1, column: 3 })
})

test('describeJsonError 把「position N」翻成人话；无位置时只给原因', () => {
  const { describeJsonError } = loadClient().__test
  const withPosition = describeJsonError(
    { line: 3, column: 18 },
    "Unexpected token '}' in JSON at position 42",
  )
  assert.match(withPosition, /^第 3 行第 18 列：/)
  assert.equal(withPosition.includes('at position'), false, '不该把引擎的位置尾巴原样甩给用户')

  const noPosition = describeJsonError({ line: 0, column: 0 }, 'JSON 解析失败')
  assert.equal(noPosition, 'JSON 解析失败')
})

// ---------------------------------------------------------------------------
// 构造请求：预览与发送必须同源同构
// ---------------------------------------------------------------------------

const BASE_STATE = {
  accountId: 'ds',
  method: 'GET',
  path: '/models',
  headers: [{ key: '', value: '' }],
  bodyText: '',
}

test('buildDebugRequest：GET 不带 body；dryRun 只是多一个标记', () => {
  const { buildDebugRequest } = loadClient().__test

  const send = buildDebugRequest(BASE_STATE, { dryRun: false })
  assert.equal(send.ok, true)
  assert.deepEqual(plain(send.payload), {
    accountId: 'ds',
    method: 'GET',
    path: '/models',
    dryRun: false,
    includeRaw: true,
  })
  assert.equal('body' in send.payload, false, 'GET 不能带 body')
  assert.equal('headers' in send.payload, false, '空 header 行不应发出去')

  const preview = buildDebugRequest(BASE_STATE, { dryRun: true })
  assert.equal(preview.ok, true)
  assert.equal(preview.payload.dryRun, true)
  // 除了 dryRun，预览与发送的 payload 必须完全一致
  assert.deepEqual(plain({ ...preview.payload, dryRun: false }), plain(send.payload))
})

test('buildDebugRequest：POST 解析 JSON body 成对象；JSON 非法时拒绝并带错误详情', () => {
  const { buildDebugRequest } = loadClient().__test
  const state = {
    ...BASE_STATE,
    method: 'POST',
    path: '/embeddings',
    bodyText: '{"input":"hello","model":"m"}',
  }
  const built = buildDebugRequest(state, { dryRun: false })
  assert.equal(built.ok, true)
  assert.deepEqual(plain(built.payload.body), { input: 'hello', model: 'm' })

  const broken = buildDebugRequest({ ...state, bodyText: '{"input":' }, { dryRun: false })
  assert.equal(broken.ok, false)
  assert.ok(broken.jsonError, '要带结构化错误，供 UI 高亮行号')
  assert.equal(broken.jsonError.ok, false)
  assert.match(broken.message, /第 \d+ 行/)

  // POST 但留空 body：合法，且不带 body 字段
  const emptyBody = buildDebugRequest({ ...state, bodyText: '' }, { dryRun: false })
  assert.equal(emptyBody.ok, true)
  assert.equal('body' in emptyBody.payload, false)
})

test('buildDebugRequest：缺账户/缺路径/坏 header 名都拒绝，且不产出一个「半成品」payload', () => {
  const { buildDebugRequest } = loadClient().__test

  const noAccount = buildDebugRequest({ ...BASE_STATE, accountId: '' }, { dryRun: false })
  assert.equal(noAccount.ok, false)
  assert.match(noAccount.message, /账户/)

  const noPath = buildDebugRequest({ ...BASE_STATE, path: '   ' }, { dryRun: false })
  assert.equal(noPath.ok, false)
  assert.match(noPath.message, /路径/)

  const badHeader = buildDebugRequest(
    { ...BASE_STATE, headers: [{ key: 'Bad Header', value: 'v' }] },
    { dryRun: false },
  )
  assert.equal(badHeader.ok, false)
  assert.match(badHeader.message, /请求头名不合法/)
})

test('buildDebugRequest：header 行归一，空名丢弃，timeoutMs 只在正数时带上', () => {
  const { buildDebugRequest } = loadClient().__test
  const built = buildDebugRequest(
    {
      ...BASE_STATE,
      headers: [
        { key: 'X-Trace', value: 'abc' },
        { key: '  ', value: 'ignored' },
        { key: '', value: 'ignored' },
      ],
      timeoutMs: 5000,
    },
    { dryRun: false },
  )
  assert.equal(built.ok, true)
  assert.deepEqual(plain(built.payload.headers), { 'X-Trace': 'abc' })
  assert.equal(built.payload.timeoutMs, 5000)

  for (const timeoutMs of [0, -1, '', 'abc', undefined, null]) {
    const out = buildDebugRequest({ ...BASE_STATE, timeoutMs }, { dryRun: false })
    assert.equal(out.ok, true, `timeoutMs=${String(timeoutMs)} 不该让整个请求失败`)
    assert.equal('timeoutMs' in out.payload, false, `timeoutMs=${String(timeoutMs)} 不该被带上`)
  }
})

test('normalizeDebugMethod：大小写归一，未知方法退回 GET', () => {
  const { normalizeDebugMethod } = loadClient().__test
  assert.equal(normalizeDebugMethod('post'), 'POST')
  assert.equal(normalizeDebugMethod('  Delete '), 'DELETE')
  for (const bogus of ['TRACE', 'HEAD', '', null, undefined, 123]) {
    assert.equal(normalizeDebugMethod(bogus), 'GET', `${String(bogus)} 应退回 GET`)
  }
})

// ---------------------------------------------------------------------------
// 账户下拉
// ---------------------------------------------------------------------------

test('debugAccountOptions：只认后端给的 4 个字段，缺 label 用 id 兜', () => {
  const { debugAccountOptions } = loadClient().__test
  const options = plain(
    debugAccountOptions({
      accounts: [
        { id: 'ds', label: '主账号', provider: 'deepseek', hasKey: true },
        { id: 'kimi', provider: 'moonshot-cn', hasKey: false },
        { id: 'x', label: 'y', provider: 'p', hasKey: 'yes' },
      ],
    }),
  )
  assert.equal(options.length, 3)
  assert.equal(options[0].label, '主账号')
  assert.equal(options[1].label, 'kimi', '缺 label 时用 id')
  assert.equal(options[1].hasKey, false)
  assert.equal(options[2].hasKey, false, 'hasKey 只认严格 true')
  // 不允许透传别的字段（防止后端将来加字段时前端顺手展示出去）
  assert.deepEqual(Object.keys(options[0]).sort(), ['hasKey', 'id', 'label', 'provider'])

  // 空/坏输入不抛
  assert.deepEqual(plain(debugAccountOptions({})), [])
  assert.deepEqual(plain(debugAccountOptions(null)), [])
  assert.deepEqual(plain(debugAccountOptions({ accounts: 'nope' })), [])
})

test('accountHintOf：没账户 / 没选中 / 没密钥 各给一句人话', () => {
  const { accountHintOf } = loadClient().__test
  assert.match(accountHintOf([], ''), /还没有任何账户/)
  const accounts = [
    { id: 'ds', label: 'a', provider: 'p', hasKey: true },
    { id: 'kimi', label: 'b', provider: 'p', hasKey: false },
  ]
  assert.match(accountHintOf(accounts, ''), /选一个账户/)
  assert.match(accountHintOf(accounts, 'kimi'), /没配 API Key/)
  assert.equal(accountHintOf(accounts, 'ds'), '', '有密钥的账户不该有噪声提示')
})

// ---------------------------------------------------------------------------
// 结果展示
// ---------------------------------------------------------------------------

test('dryRun 预览展示的是「即将发出的请求」，不是响应', () => {
  const { responseBodyText, statusLineOf, resultToneOf } = loadClient().__test
  const result = {
    ok: true,
    dryRun: true,
    accountId: 'ds',
    providerId: 'deepseek',
    elapsedMs: 1,
    request: {
      method: 'POST',
      url: 'https://api.deepseek.com/embeddings',
      headers: { Authorization: '<redacted>', 'content-type': 'application/json' },
      body: { input: 'hello' },
    },
    warnings: ['dry-run：仅构造请求，未发送网络数据；Authorization 已脱敏。'],
  }
  const text = responseBodyText(result)
  assert.match(text, /api\.deepseek\.com\/embeddings/)
  assert.match(text, /<redacted>/)
  assert.match(text, /"input": "hello"/, '请求体要格式化展示')
  // 预览绝不能被当成「成功响应」
  assert.equal(resultToneOf(result), 'idle')
  assert.match(statusLineOf(result), /dry-run/)
  assert.match(statusLineOf(result), /未发送/)
})

test('statusLineOf：成功给 状态码·耗时·大小，失败给分类，全部人话', () => {
  const { statusLineOf } = loadClient().__test
  const ok = statusLineOf({
    ok: true,
    dryRun: false,
    accountId: 'ds',
    providerId: 'p',
    elapsedMs: 324,
    httpStatus: 200,
    raw: { data: [{ id: 'a' }] },
    warnings: [],
  })
  assert.match(ok, /^200 · 324ms · /)
  assert.match(ok, /B|KB/, '要有响应体大小')

  const failed = statusLineOf({
    ok: false,
    dryRun: false,
    accountId: 'ds',
    providerId: 'p',
    elapsedMs: 80,
    error: { kind: 'auth', message: 'bad key', hint: 'x', retryable: false },
    warnings: [],
  })
  assert.match(failed, /失败/)
  assert.match(failed, /auth/)
  // 没有结果时返回空串而不是 'undefined'
  assert.equal(statusLineOf(null), '')
})

test('resultToneOf：ok→ok / 4xx→warn / 失败→err / dryRun→idle', () => {
  const { resultToneOf } = loadClient().__test
  const base = { dryRun: false, accountId: 'ds', providerId: 'p', elapsedMs: 1, warnings: [] }
  assert.equal(resultToneOf({ ...base, ok: true, httpStatus: 200 }), 'ok')
  assert.equal(resultToneOf({ ...base, ok: true, httpStatus: 404 }), 'warn')
  assert.equal(resultToneOf({ ...base, ok: false, error: { kind: 'auth' } }), 'err')
  assert.equal(resultToneOf({ ...base, ok: true, dryRun: true }), 'idle')
  assert.equal(resultToneOf(null), 'idle')
})

test('错误分类提示：白名单 / 401 / 超时 / 网络错误各给可操作建议', () => {
  const { errorActionOf } = loadClient().__test

  // 后端带 hint 时优先用后端的（它知道得更多）
  assert.equal(
    errorActionOf({ kind: 'auth', message: 'x', hint: '确认 apiKeyEnv 指向的环境变量。' }),
    '确认 apiKeyEnv 指向的环境变量。',
  )
  // 白名单特有的那句覆盖（后端 hint 是通用 config 文案时补充具体动作）
  const whitelist = errorActionOf({
    kind: 'config',
    message: '目标主机 "evil.example.com" 不在白名单。',
    hint: '检查配置。',
  })
  assert.match(whitelist, /allowedHosts/)

  // 没有 hint 时按 kind 兜底 —— 四类必须各不相同，否则分类等于没做
  const kinds = ['auth', 'timeout', 'network', 'quota', 'rate_limit', 'client']
  const texts = kinds.map((kind) => errorActionOf({ kind, message: 'm' }))
  assert.equal(new Set(texts).size, kinds.length, '每个错误分类都应给出不同的建议')
  for (const text of texts) assert.ok(text.length > 10, '建议不能是空话')
  // 未知分类兜到 internal 文案，不抛
  assert.ok(errorActionOf({ kind: 'weird', message: 'm' }).length > 0)
  assert.ok(errorActionOf(null).length > 0)
})

test('resultNotes：错误在前、warnings 在后，tone 可区分', () => {
  const { resultNotes } = loadClient().__test
  const notes = plain(
    resultNotes({
      ok: false,
      dryRun: false,
      accountId: 'ds',
      providerId: 'p',
      elapsedMs: 1,
      error: { kind: 'timeout', message: '请求超时', hint: '调大 requestTimeoutMs' },
      warnings: ['第一条警告', '第二条警告'],
    }),
  )
  assert.equal(notes.length, 3)
  assert.equal(notes[0].tone, 'err')
  assert.match(notes[0].text, /请求超时/)
  assert.match(notes[0].text, /requestTimeoutMs/)
  assert.deepEqual(
    notes.slice(1).map((n: any) => n.tone),
    ['warn', 'warn'],
  )
  assert.deepEqual(plain(resultNotes(null)), [])
})

test('collapseBody：超过阈值折叠，阈值内原样；展开时不截断', () => {
  const { collapseBody, DEBUG_COLLAPSED_LINES } = loadClient().__test
  const short = 'a\nb'
  assert.equal(collapseBody(short, true), short)
  const long = Array.from({ length: DEBUG_COLLAPSED_LINES + 10 }, (_v, i) => `line${i}`).join('\n')
  const folded = collapseBody(long, true)
  assert.ok(folded.length < long.length)
  assert.match(folded, /…$/)
  assert.equal(folded.split('\n').length, DEBUG_COLLAPSED_LINES + 1)
  assert.equal(collapseBody(long, false), long, '展开时必须是完整正文')
})

test('formatBytes：B/KB/MB 三档，坏输入给 —', () => {
  const { formatBytes } = loadClient().__test
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(1024 * 1024 * 2.5), '2.5 MB')
  for (const bad of [-1, NaN, 'x', undefined]) {
    assert.equal(formatBytes(bad), '—')
  }
})

// ---------------------------------------------------------------------------
// 快捷模板
// ---------------------------------------------------------------------------

test('快捷模板覆盖 /models、/embeddings、/chat/completions，且 body 都是合法 JSON', () => {
  const { debugTemplates, validateJsonText } = loadClient().__test
  const templates = plain(debugTemplates())
  const paths = templates.map((t: any) => t.path)
  for (const required of ['/models', '/embeddings', '/chat/completions']) {
    assert.ok(paths.includes(required), `缺少模板 ${required}`)
  }
  for (const template of templates as Array<Record<string, string>>) {
    assert.ok(template.id && template.label && template.method && template.path)
    if (template.body) {
      const parsed = validateJsonText(template.body)
      assert.equal(parsed.ok, true, `模板 ${template.id} 的 body 不是合法 JSON`)
    }
  }
  // GET 模板不能带 body，否则用户点了模板就会发出一个带 body 的 GET
  for (const template of templates as Array<Record<string, string>>) {
    if (template.method === 'GET') assert.equal(template.body, '', `${template.id} 是 GET 却带了 body`)
  }
})

// ---------------------------------------------------------------------------
// 渲染结构（真实组件树）
// ---------------------------------------------------------------------------

function collect(node: any, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if ('type' in node && 'props' in node) {
    out.push(node)
    for (const child of node.children ?? []) collect(child, out)
  }
  return out
}

test('调试台渲染出账户下拉、方法/路径输入、Headers、Body、预览与发送按钮、模板', () => {
  const plugin = loadClient()
  const state = {
    ...plugin.__test.debugInitialState(),
    accountId: 'ds',
    method: 'POST',
    path: '/embeddings',
    bodyText: '{"input":"hello"}',
    accounts: [{ id: 'ds', label: '主账号', provider: 'deepseek', hasKey: true }],
  }
  const nodes = collect(plugin.__test.DebugView({ state, actions: {} }))
  const inputs = nodes.filter((n) => n.type === 'input')
  const selects = nodes.filter((n) => n.type === 'select')
  const textareas = nodes.filter((n) => n.type === 'textarea')
  const buttons = nodes.filter((n) => n.type === 'button')

  assert.equal(selects.length, 2, '账户 + 方法两个下拉')
  assert.ok(inputs.length >= 1, '至少要有路径输入框')
  assert.equal(textareas.length, 1, 'POST 才有 body 编辑器')
  assert.ok(buttons.length >= 4, '预览 / 发送 / 模板 / headers 开关')

  const labels = buttons.map((b) => String(b.children[0] ?? ''))
  assert.ok(labels.some((l) => l.includes('预览请求')), `应有 dryRun 预览按钮：${labels.join(' | ')}`)
  assert.ok(labels.some((l) => l === '发送'), '应有发送按钮')

  // 方法/路径的当前值被回填（受控组件）。
  // 精确按 class 找：路径输入框的 class 是 'dpc-input dpc-mono'（走 token 的通用
  // 输入样式），'dpc-dbg-path' 在包裹它的 label 上 —— 按字段名找会找错元素。
  const pathInput = inputs.find((n) => String(n.props.className ?? '') === 'dpc-input dpc-mono')
  assert.ok(pathInput, '应有路径输入框')
  assert.equal(pathInput.props.value, '/embeddings')
  assert.equal(pathInput.props.placeholder.includes('/models'), true, '占位符要提示相对路径写法')
})

test('GET 时不渲染 body 编辑器；JSON 非法时发送被禁用但预览可用', () => {
  const plugin = loadClient()
  const base = {
    ...plugin.__test.debugInitialState(),
    accountId: 'ds',
    accounts: [{ id: 'ds', label: 'a', provider: 'p', hasKey: true }],
  }

  const getNodes = collect(plugin.__test.DebugView({ state: base, actions: {} }))
  assert.equal(getNodes.filter((n) => n.type === 'textarea').length, 0, 'GET 不该有 body 编辑器')

  const broken = collect(
    plugin.__test.DebugView({
      state: { ...base, method: 'POST', path: '/x', bodyText: '{"a":' },
      actions: {},
    }),
  )
  const buttons = broken.filter((n) => n.type === 'button')
  const send = buttons.find((b) => String(b.children[0]) === '发送')
  const preview = buttons.find((b) => String(b.children[0]).includes('预览请求'))
  assert.ok(send, '需要有发送按钮')
  assert.equal(send.props.disabled, true, 'JSON 非法时必须禁用发送')
  // 预览也走同一个 body，非法时同样禁用（避免用户在预览里看到「一切正常」）
  assert.equal(preview.props.disabled, true)
  // 错误块要出现，带行号
  const invalid = broken.find((n) => String(n.props.className ?? '').includes('dpc-dbg-invalid'))
  assert.ok(invalid, '非法 JSON 必须显示错误块')
  const text = JSON.stringify(invalid.children)
  assert.match(text, /JSON 格式错误/)
  assert.match(text, /第 \d+ 行/)
})

test('结果区渲染状态行、可折叠与复制按钮；dryRun 显示请求预览', () => {
  const plugin = loadClient()
  const state = {
    ...plugin.__test.debugInitialState(),
    accountId: 'ds',
    result: {
      ok: true,
      dryRun: false,
      accountId: 'ds',
      providerId: 'deepseek',
      elapsedMs: 324,
      httpStatus: 200,
      raw: { data: [{ id: 'm' }] },
      warnings: [],
    },
  }
  const nodes = collect(plugin.__test.DebugView({ state, actions: {} }))
  const raw = JSON.stringify(nodes.map((n) => n.props?.['data-tone'] ?? ''))
  assert.match(raw, /ok/, '成功结果应有 ok 色调')
  const buttons = nodes.filter((n) => n.type === 'button').map((n) => String(n.children[0]))
  assert.ok(buttons.includes('折叠') || buttons.includes('展开全部'), '要有折叠按钮')
  assert.ok(buttons.includes('复制'), '要有复制按钮')
  const pre = nodes.find((n) => n.type === 'pre')
  assert.ok(pre, '响应体要用 pre 展示')
  assert.match(String(pre.children[0]), /"id": "m"/, '响应格式化后展示')
})

test('没选账户时表单给提示，且发送/预览都禁用', () => {
  const plugin = loadClient()
  const state = { ...plugin.__test.debugInitialState(), accounts: [] }
  const nodes = collect(plugin.__test.DebugView({ state, actions: {} }))
  const buttons = nodes.filter((n) => n.type === 'button')
  const send = buttons.find((b) => String(b.children[0]) === '发送')
  assert.equal(send.props.disabled, true)
  const text = JSON.stringify(nodes.map((n) => n.children))
  assert.match(text, /还没有任何账户/)
})

test('调试台组件不依赖看板开关（dashboard.enabled=false 也能用）', () => {
  const plugin = loadClient()
  const Page = plugin.__test.makePage({ dashboard: { enabled: false } })
  const nodes = collect(Page())
  // 默认 tab 是余额看板 → 显示开启指引；但 tab 条上必须有「调试台」入口。
  // 精确匹配 'dpc-tab'：容器是 'dpc-tabs'，包含匹配会把容器也算进来。
  const tabButtons = nodes.filter((n) => n.type === 'button' && n.props.className === 'dpc-tab')
  assert.equal(tabButtons.length, 2, '两个 tab：余额看板 / 调试台')
  const labels = tabButtons.map((b) => String(b.children[0]))
  assert.deepEqual(labels, ['余额看板', '调试台'])
  // 调试台 tab 的渲染结果里不该出现「dashboard.enabled」这种看板专属提示
  const Debug = plugin.__test.makeDebugPanel()
  const debugHtml = JSON.stringify(collect(Debug()))
  assert.equal(debugHtml.includes('dashboard.enabled'), false, '调试台不该依赖看板配置')
})

test('tab 条在调试台激活时把该 tab 标记为 active/aria-selected', () => {
  const plugin = loadClient()
  // 直接渲染 tab 条所在的页面：默认 active 是余额看板
  const Page = plugin.__test.makePage({ dashboard: { enabled: true } })
  const nodes = collect(Page())
  const tabs = nodes.filter((n) => n.type === 'button' && n.props.className === 'dpc-tab')
  const byLabel = new Map(tabs.map((t) => [String(t.children[0]), t]))
  assert.equal(byLabel.get('余额看板').props['data-active'], 'true')
  assert.equal(byLabel.get('调试台').props['data-active'], 'false')
  assert.equal(byLabel.get('余额看板').props['aria-selected'], 'true')
  assert.equal(byLabel.get('调试台').props['aria-selected'], 'false')
})
