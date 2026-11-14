/**
 * dsh-plugin-provider-console —— 浏览器半端
 * ============================================================================
 * DSH 的 client bundle 不是 ESM，而是自注册脚本：
 *
 *   window.__ModuleLoader__.load({
 *     id: '<package.json 的 name>',
 *     factory: (require) => { ...; return { name, inject, apply } },
 *   })
 *
 * 这里注册四个 slot（与宿主 dsh-client-ui-schedule / ui-plugin-manager 同款写法）：
 *   · sidebar.panellist      → 左侧图标，id 必须与主面板 key 相同
 *   · main                   → 选中图标后显示的中央面板（tab：余额看板 / 调试台）
 *   · settings.section       → 设置页「服务商控制台」分区（只读 + 复制 YAML）
 *   · settings.section.icon  → 设置页导航图标，id 必须与 section 相同
 *
 * 调试台（tab 二）是本插件**独占**的能力：在 DSH 里直接构造任意 method/path/
 * headers/body、dryRun 预览、发送、看原始响应。它走插件注册的**同源**路由
 * （`/dsh-plugin-provider-console/api/debug/*`），因此不受跨源限制；余额看板
 * 仍然是 8788 的 iframe，两条路径互不影响。路由前缀必须与
 * src/debug-api.ts 的 DEBUG_BASE 逐字符一致（有跨文件断言守着）。
 *
 * 主题：**只**看 `document.body[data-ds-dark-theme]`。DSH 的「跟随系统」已由
 * ThemePresenter 解析成这个属性，所以这里绝不读 prefers-color-scheme —— 否则
 * 用户手动选的主题会被系统偏好覆盖。
 *
 * 颜色：一律用宿主 `--dsw-*` token，**不写 inline fallback**。fallback 存在的
 * 唯一效果是把 token 拼写错误变成「看起来还行」的假象 —— 0.3.0 就是这样在亮色
 * 主题下变成黑底白字的（`--dsw-alias-text-primary` / `--dsw-alias-bg-layer-0`
 * 这两个 token 根本不存在）。token 是否真的存在由 test/tokens.test.ts 守护。
 *
 * 看板 iframe 与宿主不同源（8788 vs 65110），所以 token 值通过 postMessage
 * 传进去由 iframe 自己 setProperty，iframe 里没有任何跨域 fetch。
 *
 * 纯 JavaScript：无 JSX、无 TypeScript、无 Node 内置模块。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-provider-console',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    var PANEL_ID = 'provider-console'
    var PANEL_LABEL = '服务商控制台'
    var DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:8788/'
    var SETTINGS_ORDER = 35
    var THEME_MESSAGE = 'dsh-provider-console:theme'
    var CSS_ID = 'dsh-plugin-provider-console/client.css'

    /**
     * 传给 iframe 的 token 名单。iframe 是**独立文档**（还跨源），拿不到宿主的
     * 样式表，只能靠这里逐个读计算值再 postMessage 过去。新增样式时若用到新
     * token，记得加进这个表，否则 iframe 里只有 index.html 自带的兜底色。
     */
    var FRAME_TOKENS = [
      '--dsw-alias-bg-base',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-layer-3',
      '--dsw-alias-bg-module-platform',
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
      '--dsw-alias-brand-primary',
      '--dsw-alias-markdown-code-block',
      '--dsw-elevation-soft',
      '--dsw-elevation-stroke',
      '--dsw-elevation-prominent',
      '--dsw-shadow-lv1',
      '--dsw-shadow-lv2',
      '--dsw-radius-xs',
      '--dsw-radius-sm',
      '--dsw-radius-md',
      '--dsw-radius-lg',
      '--dsw-radius-xl',
      '--dsw-radius-panel',
      '--dsw-focus-ring-width',
    ]

    var name = PANEL_ID
    var inject = ['slots']

    /* ------------------------------------------------------------------ */
    /* 配置                                                                */
    /* ------------------------------------------------------------------ */

    function dashboardUrl(config) {
      var s = config && config.sidebar
      if (s && typeof s.dashboardUrl === 'string' && s.dashboardUrl) return s.dashboardUrl
      var d = config && config.dashboard
      if (!d) return DEFAULT_DASHBOARD_URL
      if (typeof d.url === 'string' && d.url) return d.url
      if (d.host && d.port) {
        // scheme 只能来自显式 url（上面已返回）；host/port 分支按 http 拼，
        // 因为看板服务本身只监听回环地址、从不带 TLS 终止。
        return 'http://' + d.host + ':' + d.port + '/'
      }
      return DEFAULT_DASHBOARD_URL
    }

    function embedUrl(base, nonce, theme) {
      var sep = base.indexOf('?') >= 0 ? '&' : '?'
      return base + sep + 'embed=1&theme=' + (theme === 'dark' ? 'dark' : 'light') + (nonce ? '&t=' + nonce : '')
    }

    /** 从看板地址里取 origin；取不到时返回 undefined（调用方退回 '*'）。 */
    function originOf(url) {
      var m = String(url || '').match(/^(https?:\/\/[^/?#]+)/i)
      return m ? m[1] : undefined
    }

    /** 左侧入口的可配置项：enabled / label / order / dashboardUrl。 */
    function panelOptions(config) {
      var s = config && config.sidebar
      return {
        enabled: !s || s.enabled !== false,
        order: s && typeof s.order === 'number' ? s.order : 20,
        label: function () { return (s && s.label) || PANEL_LABEL },
      }
    }

    /**
     * 看板是否启用。缺省视为开启，必须与宿主侧 config.ts 的
     * `config.dashboard?.enabled !== false` 保持一致：
     * 两端默认值相反时，最小配置下宿主不监听端口、这里却渲染 iframe，结果是白屏。
     */
    function dashboardEnabled(config) {
      var d = config && config.dashboard
      return !d || d.enabled !== false
    }

    /* ------------------------------------------------------------------ */
    /* 主题                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 宿主当前主题。**只**认 `body[data-ds-dark-theme]`：
     * DSH 把 light / dark / system 三种用户选择统一解析成这个属性，
     * 读 prefers-color-scheme 会在「用户手动选了亮色、系统是暗色」时判错。
     */
    function themeOf(doc) {
      var body = doc && doc.body
      if (!body || typeof body.hasAttribute !== 'function') return 'light'
      try {
        return body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
      } catch (_) {
        return 'light'
      }
    }

    function hostTheme() {
      return themeOf(typeof document === 'undefined' ? null : document)
    }

    /**
     * 读宿主 body 上的 token 计算值。getComputedStyle 对自定义属性返回的是
     * **已替换**的结果（`--dsw-elevation-soft` 会展开成完整 box-shadow），
     * 所以 iframe 拿到的就是可以直接用的字符串。
     */
    function tokenSnapshot() {
      var out = {}
      if (typeof document === 'undefined' || !document.body) return out
      var view = typeof window !== 'undefined' ? window : undefined
      if (!view || typeof view.getComputedStyle !== 'function') return out
      var computed
      try {
        computed = view.getComputedStyle(document.body)
      } catch (_) {
        return out
      }
      if (!computed || typeof computed.getPropertyValue !== 'function') return out
      for (var i = 0; i < FRAME_TOKENS.length; i++) {
        var key = FRAME_TOKENS[i]
        var value
        try {
          value = computed.getPropertyValue(key)
        } catch (_) {
          continue
        }
        if (typeof value === 'string' && value.trim()) out[key] = value.trim()
      }
      return out
    }

    /**
     * 把主题 + token 快照推给 iframe。targetOrigin 用看板自己的 origin 而不是
     * '*'：消息里虽然没有密钥，但也没必要广播给任意窗口。
     */
    function pushTheme(frame, theme) {
      if (!frame) return false
      var win = frame.contentWindow
      if (!win || typeof win.postMessage !== 'function') return false
      var src = typeof frame.src === 'string' ? frame.src : ''
      var payload = { type: THEME_MESSAGE, theme: theme === 'dark' ? 'dark' : 'light', tokens: tokenSnapshot() }
      try {
        win.postMessage(payload, originOf(src) || '*')
      } catch (_) {
        return false
      }
      return true
    }

    /* ------------------------------------------------------------------ */
    /* 调试台（任意端点）：纯函数层 —— 全部可单测                          */
    /* ------------------------------------------------------------------ */

    /**
     * 同源路由前缀。**必须**与 src/debug-api.ts 的 DEBUG_BASE 完全一致：
     * 两端拼错任意一个字符，页面会在自己的 fetch 上收到 404，而插件看起来一切正常。
     * test/debug-ui.test.ts 里有一条跨文件一致性断言守着这件事。
     */
    var DEBUG_BASE_PATH = '/dsh-plugin-provider-console/api/debug'
    var DEBUG_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
    /** 结果默认只展开这么行，其余折起来（大响应直接铺开会把面板撑爆）。 */
    var DEBUG_COLLAPSED_LINES = 14

    function debugEndpoints() {
      return {
        accounts: DEBUG_BASE_PATH + '/accounts',
        request: DEBUG_BASE_PATH + '/request',
      }
    }

    /** 把「第 N 个字符」换算成 1 基的行/列，用来在错误里报行号。 */
    function positionToLineColumn(text, position) {
      var limit = Math.max(0, Math.min(Number(position) || 0, text.length))
      var line = 1
      var column = 1
      for (var i = 0; i < limit; i++) {
        if (text.charAt(i) === '\n') {
          line += 1
          column = 1
        } else {
          column += 1
        }
      }
      return { line: line, column: column }
    }

    /**
     * 从 JSON.parse 的报错里抠出位置。
     *
     * 现实很骨感：V8 的措辞**不稳定**，同一句 "is not valid JSON" 有时完全不带
     * position（例如 `{"b": tru\n}` 会给出 `Unexpected token '\n'` 且没有位置），
     * 而带位置时形如 `… at position 12 (line 3 column 1)`。
     * 所以策略是：优先用消息里的 position（自己换算行列，行的基准统一），
     * 抠不到就让调用方用 bracketScanner 自己算 —— 绝不能因为引擎没给位置
     * 就退化成「第 0 行」这种没法用的提示。
     */
    function jsonErrorPosition(text, message) {
      var raw = String(message || '')
      var at = /at position (\d+)/.exec(raw)
      if (at) return positionToLineColumn(text, Number(at[1]))
      var pair = /line (\d+) column (\d+)/.exec(raw)
      if (pair) return { line: Number(pair[1]), column: Number(pair[2]) }
      return null
    }

    /**
     * 自己扫描一遍，找出「解析器最早会炸」的位置。
     *
     * 只处理真实会遇到的几类错：值位置上的坏字面量、缺值（`{"a": }`）、
     * 未闭合的字符串/括号、配错的闭合符、根值之后还有内容。
     * 这不是完整的 JSON 语法分析器（也不需要 —— 真正的判定永远交给 JSON.parse），
     * 它只负责在引擎**不给位置**时提供本地化定位。
     */
    function bracketScanner(text) {
      var stack = []
      var inString = false
      var escaped = false
      var sawRootValue = false
      var lastOpen = null
      // 上一个有意义的记号是 `:` 或 `,` → 下一个非空白字符必须是值的开头
      var expectValue = false
      var literals = ['true', 'false', 'null']
      for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i)
        if (inString) {
          if (escaped) {
            escaped = false
          } else if (ch === '\\') {
            escaped = true
          } else if (ch === '"') {
            inString = false
            sawRootValue = true
            expectValue = false
          }
          continue
        }
        if (/\s/.test(ch)) continue
        if (ch === '"') {
          inString = true
          continue
        }
        if (ch === '{' || ch === '[') {
          stack.push({ ch: ch, at: i })
          lastOpen = { ch: ch, at: i }
          expectValue = ch === '{' ? false : false
          continue
        }
        if (ch === '}' || ch === ']') {
          var expected = ch === '}' ? '{' : '['
          var top = stack.length ? stack[stack.length - 1] : null
          if (!top || top.ch !== expected) return { at: i, reason: 'unexpected-close' }
          // `{"a": }` —— 逗号/冒号后面直接闭合，就是缺值
          if (expectValue) return { at: i, reason: 'missing-value' }
          stack.pop()
          sawRootValue = true
          expectValue = false
          continue
        }
        if (ch === ',') {
          expectValue = true
          continue
        }
        if (ch === ':') {
          expectValue = true
          continue
        }
        if (/[A-Za-z]/.test(ch)) {
          // 值位置的裸标识符只能是 true/false/null；`tru`/`nope` 这类拼错是
          // 最常见的手写错误，而 V8 对它们的报错**不带位置**。
          var matched = null
          for (var k = 0; k < literals.length; k++) {
            if (text.substr(i, literals[k].length) === literals[k]) {
              matched = literals[k]
              break
            }
          }
          if (!matched) return { at: i, reason: 'bad-literal' }
          i += matched.length - 1
          sawRootValue = true
          expectValue = false
          continue
        }
        if (sawRootValue && stack.length === 0) return { at: i, reason: 'trailing-content' }
        sawRootValue = true
        expectValue = false
      }
      if (inString) return { at: text.length, reason: 'unterminated-string' }
      if (stack.length && lastOpen) return { at: text.length, reason: 'unclosed' }
      return null
    }

    /**
     * 把引擎的报错洗成一行人话。
     *
     * V8 新格式会夹带源码片段和换行（`Unexpected token '\n', ..."  "b": tru\n}" is not valid JSON`），
     * 原样塞进 UI 会撑破布局；位置尾巴也有，但我们自己已经算过行列了。
     */
    function cleanJsonMessage(message) {
      var raw = String(message || '')
      raw = raw.replace(/\s*at position \d+.*$/, '')
      // V8 会把出错的源码原文附在后面：`Unexpected token 'o', "{"a": nope}"`。
      // 一律在 `, "` 处截断 —— 片段对我们无用（位置已经自己算过了）。
      var quotedTail = raw.indexOf(', "')
      if (quotedTail !== -1) raw = raw.slice(0, quotedTail)
      raw = raw.replace(/\s*\.\.\.[\s\S]*$/, '')
      raw = raw.replace(/\s+is not valid JSON\s*$/, '')
      raw = raw.replace(/\s+/g, ' ').trim()
      return raw || 'JSON 解析失败'
    }

    /**
     * 扫描器给出的原因翻成人话。
     *
     * 为什么优先用它而不是引擎措辞：`{"a": }` 在 V8 里是
     * `Unexpected token '}', "{"a": }"` —— 既没位置也不说人话。扫描器知道
     * 那是「冒号后面缺值」，直接说出来比翻译引擎的噪声有用得多。
     */
    var SCAN_REASON_TEXT = {
      'bad-literal': '值只能是 true / false / null、数字、带引号的字符串或嵌套对象',
      'missing-value': '冒号后面缺值',
      'unclosed': '括号没有闭合',
      'unterminated-string': '字符串没有闭合',
      'unexpected-close': '多余的或配错的闭合括号',
      'trailing-content': '根值之后还有多余内容',
    }

    /** 把「第 N 个字符」换算成一句用户能照着改的话。 */
    function describeJsonError(position, message, reason) {
      var known = reason ? SCAN_REASON_TEXT[reason] : undefined
      var detail = known || cleanJsonMessage(message)
      if (position && position.line > 0) {
        return '第 ' + position.line + ' 行第 ' + position.column + ' 列：' + detail
      }
      return detail
    }

    /**
     * 实时校验 JSON 文本。
     *
     * 空文本算「合法但不发 body」—— GET 请求根本不带 body，用户也不该被迫填 `{}`。
     * 返回结构对 UI 友好：line/column 用于定位（**永远**能给出，引擎不给位置时
     * 就自己扫），text 直接显示给用户。
     */
    function validateJsonText(text) {
      var raw = typeof text === 'string' ? text : ''
      if (!raw.trim()) return { ok: true, empty: true, value: undefined }
      try {
        return { ok: true, empty: false, value: JSON.parse(raw) }
      } catch (error) {
        var message = (error && error.message) || 'JSON 解析失败'
        var enginePosition = jsonErrorPosition(raw, message)
        var scanned = enginePosition ? null : bracketScanner(raw)
        var position = enginePosition || (scanned ? positionToLineColumn(raw, scanned.at) : { line: 0, column: 0 })
        return {
          ok: false,
          empty: false,
          message: message,
          line: position.line,
          column: position.column,
          reason: scanned ? scanned.reason : undefined,
          text: describeJsonError(position, message, scanned ? scanned.reason : undefined),
        }
      }
    }

    function prettyJson(value) {
      try {
        return JSON.stringify(value, null, 2)
      } catch (_) {
        return String(value)
      }
    }

    /** 人类可读的字节数：调试台要显示响应体大小，直接甩原始数字没人看得懂。 */
    function formatBytes(size) {
      var value = Number(size)
      if (!isFinite(value) || value < 0) return '—'
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / (1024 * 1024)).toFixed(1) + ' MB'
    }

    /**
     * 结果区要展示的正文。
     *
     * 优先级刻意如此：dry-run 看的是**即将发出的请求**（不是响应），真实调用优先
     * 展示结构化 raw，没有 raw 才退回 content（纯文本端点），失败时连请求一起给出
     * —— 否则用户只看到一条错误，不知道它到底发去了哪里。
     */
    function responseBodyText(result) {
      if (!result) return ''
      if (result.dryRun && result.request) return prettyJson(result.request)
      if (result.raw !== undefined && result.raw !== null) return prettyJson(result.raw)
      if (typeof result.content === 'string' && result.content) return result.content
      if (result.request) return prettyJson(result.request)
      return ''
    }

    function payloadSizeOf(result, text) {
      var body = typeof text === 'string' ? text : responseBodyText(result)
      return body ? body.length : 0
    }

    /** 状态色调：ok / warn / err / idle，对应 CSS 里的四套语义色。 */
    function resultToneOf(result) {
      if (!result) return 'idle'
      if (result.dryRun) return 'idle'
      if (result.ok !== true) return 'err'
      if (typeof result.httpStatus === 'number' && result.httpStatus >= 400) return 'warn'
      return 'ok'
    }

    /** 结果头一行：`200 · 324ms · 1.2KB`（dry-run 明确写「未发送」）。 */
    function statusLineOf(result) {
      if (!result) return ''
      var size = formatBytes(payloadSizeOf(result))
      if (result.dryRun) return 'dry-run · 未发送网络请求 · 请求体 ' + size
      if (result.ok !== true) {
        var kind = (result.error && result.error.kind) || 'error'
        var elapsed = typeof result.elapsedMs === 'number' ? ' · ' + result.elapsedMs + 'ms' : ''
        return '请求失败（' + kind + '）' + elapsed
      }
      var code = typeof result.httpStatus === 'number' ? result.httpStatus : '—'
      var ms = typeof result.elapsedMs === 'number' ? result.elapsedMs + 'ms' : '—'
      return code + ' · ' + ms + ' · ' + size
    }

    /**
     * 错误 → 可操作提示。
     *
     * 后端每条错误本来就带 hint，优先用它（那里知道得比前端多）；前端这张表只兜
     * 「宿主没给 hint」的情况，顺带把四类最常见的失败各写一句人话。
     */
    function errorActionOf(error) {
      if (error && typeof error.hint === 'string' && error.hint) {
        if (error.kind === 'config' && /白名单/.test(String(error.message || ''))) {
          return '该主机不在白名单里。到 cordis.patch.yml 的 allowedHosts 加上它，或在账户里用 baseUrl 指过去。'
        }
        return error.hint
      }
      var kind = error && error.kind ? String(error.kind) : 'internal'
      var table = {
        config: '核对账户、路径与白名单；路径要么是相对 baseUrl 的 /xxx，要么是白名单内的绝对 https URL。',
        auth: '密钥无效或站点不匹配（国内站与国际站 Key 不通用）；确认 apiKeyEnv 指向的环境变量正确。',
        quota: '额度不足或欠费；到服务商控制台充值或换个账户再试。',
        rate_limit: '被限流了，过一会儿再发；也可以调大 cacheTtlMs 降低自动刷新频率。',
        network: '连不上上游：检查代理、DNS 与防火墙，确认 baseUrl 可达。',
        timeout: '请求超时：调大 requestTimeoutMs，或把 timeoutMs 填大一些再发。',
        server: '上游 5xx，通常是临时故障，稍后重试。',
        client: '请求被拒（4xx）：核对路径、方法、参数与账户权限。',
        parse: '响应不是预期结构（可能是登录页或纯文本）；看原始响应体判断。',
        aborted: '请求被取消（多为超时或页面关闭）。',
        internal: '插件内部错误，查看宿主日志获取细节。',
      }
      return table[kind] || table.internal
    }

    /** 快捷模板：调试中转站 / 自建网关时最常打的几个端点。 */
    function debugTemplates() {
      return [
        { id: 'models', label: 'GET /models', method: 'GET', path: '/models', body: '' },
        {
          id: 'embeddings',
          label: 'POST /embeddings',
          method: 'POST',
          path: '/embeddings',
          body: '{\n  "model": "text-embedding-3-small",\n  "input": "hello"\n}',
        },
        {
          id: 'chat',
          label: 'POST /chat/completions',
          method: 'POST',
          path: '/chat/completions',
          body:
            '{\n  "model": "deepseek-chat",\n  "messages": [\n    { "role": "user", "content": "你好" }\n  ]\n}',
        },
        { id: 'balance', label: 'GET /user/balance', method: 'GET', path: '/user/balance', body: '' },
      ]
    }

    function normalizeDebugMethod(method) {
      // 外层 trim：从 `<select>` 来的值不会有空格，但手写/粘贴的 state 会有
      var upper = String(method === undefined || method === null ? 'GET' : method).trim().toUpperCase()
      return DEBUG_METHODS.indexOf(upper) >= 0 ? upper : 'GET'
    }

    /** 请求头名必须是无空白的 token（RFC 7230）；带空格的名字浏览器会直接拒绝。 */
    var HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

    /**
     * 表单 → 发给后端的请求。
     *
     * 这是「预览」与「发送」共用的唯一构造入口：两条路径各拼一份 body 是经典的
     * 事故源 —— 预览显示的是一个请求，真发出去的是另一个。
     */
    function buildDebugRequest(state, options) {
      var dryRun = Boolean(options && options.dryRun)
      var source = state || {}
      var accountId = source.accountId ? String(source.accountId) : ''
      if (!accountId) return { ok: false, message: '先选一个账户（一个账户都没配时，去设置页按提示加 accounts）' }
      var method = normalizeDebugMethod(source.method)
      var path = String(source.path || '').trim()
      if (!path) return { ok: false, message: '路径不能为空，例如 /models' }

      var headers = {}
      var rows = Array.isArray(source.headers) ? source.headers : []
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i] || {}
        var name = String(row.key || '').trim()
        if (!name) continue
        if (!HEADER_NAME_PATTERN.test(name)) {
          return { ok: false, message: '请求头名不合法：' + name }
        }
        headers[name] = String(row.value === undefined || row.value === null ? '' : row.value)
      }

      var body
      if (method !== 'GET') {
        var parsed = validateJsonText(source.bodyText)
        if (!parsed.ok) return { ok: false, message: parsed.text, jsonError: parsed }
        if (!parsed.empty) body = parsed.value
      }

      var payload = { accountId: accountId, method: method, path: path, dryRun: dryRun, includeRaw: true }
      if (Object.keys(headers).length) payload.headers = headers
      if (body !== undefined) payload.body = body
      var timeout = Number(source.timeoutMs)
      if (isFinite(timeout) && timeout > 0) payload.timeoutMs = Math.round(timeout)
      return { ok: true, message: '', payload: payload }
    }

    /** 账户下拉的选项；接口只回 4 个字段，这里不擅自补别的。 */
    function debugAccountOptions(payload) {
      var list = payload && Array.isArray(payload.accounts) ? payload.accounts : []
      return list.map(function (item) {
        var entry = item || {}
        var id = String(entry.id || '')
        return {
          id: id,
          label: String(entry.label || id),
          provider: String(entry.provider || ''),
          hasKey: entry.hasKey === true,
        }
      })
    }

    /** 提示文案：没密钥的账户照样能 dry-run，但真发一定 401 —— 先说清楚。 */
    function accountHintOf(accounts, accountId) {
      if (!accounts || !accounts.length) return '还没有任何账户：先在 cordis.patch.yml 或 accountsDir 里配置一个。'
      var selected = null
      for (var i = 0; i < accounts.length; i++) {
        if (accounts[i].id === accountId) {
          selected = accounts[i]
          break
        }
      }
      if (!selected) return '选一个账户后即可发送。'
      if (!selected.hasKey) return '该账户没配 API Key：可以点「预览请求」，但真发布会失败。'
      return ''
    }

    /** 结果里的警告 + 错误合成一行行提示，避免用户漏看 warnings。 */
    function resultNotes(result) {
      if (!result) return []
      var notes = []
      if (result.error) {
        notes.push({ tone: 'err', text: (result.error.message || '请求失败') + ' — ' + errorActionOf(result.error) })
      }
      var warnings = Array.isArray(result.warnings) ? result.warnings : []
      for (var i = 0; i < warnings.length; i++) notes.push({ tone: 'warn', text: String(warnings[i]) })
      return notes
    }

    /** 折叠展示：超过阈值就只给开头若干行（大响应不再把面板顶飞）。 */
    function collapseBody(text, collapsed) {
      if (collapsed !== true) return text
      var lines = String(text || '').split('\n')
      if (lines.length <= DEBUG_COLLAPSED_LINES) return text
      return lines.slice(0, DEBUG_COLLAPSED_LINES).join('\n') + '\n…'
    }

    function lineCountOf(text) {
      if (!text) return 0
      return String(text).split('\n').length
    }

    /** 面板初值：默认停在 GET /models —— 最常用、且不带 body，能立刻验证连通性。 */
    function debugInitialState() {
      return {
        accountId: '',
        accounts: [],
        accountsError: '',
        method: 'GET',
        path: '/models',
        headers: [{ key: '', value: '' }],
        headersOpen: false,
        bodyText: '',
        sending: false,
        result: null,
        requestError: '',
        collapsed: true,
        copied: false,
      }
    }

    /* ------------------------------------------------------------------ */
    /* 调试台：视图（纯函数，给定 state 就渲染，不碰网络）                  */
    /* ------------------------------------------------------------------ */

    function DebugView(props) {
      var state = props.state || {}
      var actions = props.actions || {}
      // 唯一的禁用判据就是「这个请求构造不出来」。恶意/残缺的 body 已经在
      // buildDebugRequest 里被拒（form.ok=false），所以这里**不能**再单独算一个
      // bodyInvalid —— 那是个恒被 form.ok 覆盖的死条件（变异测试发现的）。
      var form = buildDebugRequest(state, { dryRun: false })
      var canSend = form.ok && state.sending !== true
      var accounts = state.accounts || []
      var options = debugAccountOptions({ accounts: accounts })

      var headerRows = []
      if (state.headersOpen) {
        var rows = state.headers || []
        for (var i = 0; i < rows.length; i++) {
          headerRows.push(
            h('div', { className: 'dpc-dbg-hrow', key: 'h' + i },
              h('input', {
                className: 'dpc-input dpc-dbg-hk', placeholder: 'Header 名', value: rows[i].key,
                onChange: function (index) {
                  return function (event) { actions.setHeader && actions.setHeader(index, 'key', event.target.value) }
                }(i),
              }),
              h('input', {
                className: 'dpc-input dpc-dbg-hv', placeholder: '值（可用 ${ENV_VAR}）', value: rows[i].value,
                onChange: function (index) {
                  return function (event) { actions.setHeader && actions.setHeader(index, 'value', event.target.value) }
                }(i),
              }),
              h('button', {
                type: 'button', className: 'dpc-btn', title: '删除这一行',
                onClick: function (index) { return function () { actions.removeHeader && actions.removeHeader(index) } }(i),
              }, '×'),
            ),
          )
        }
        headerRows.push(
          h('button', {
            type: 'button', className: 'dpc-btn dpc-dbg-add', onClick: function () { actions.addHeader && actions.addHeader() },
          }, '+ 添加一行'),
        )
      }

      var bodyBlock = null
      if (state.method !== 'GET') {
        var parsed = validateJsonText(state.bodyText)
        bodyBlock = h('div', { className: 'dpc-dbg-body' },
          h('div', { className: 'dpc-label' }, 'Body（JSON）'),
          h('textarea', {
            className: 'dpc-textarea dpc-json',
            rows: 8,
            spellCheck: false,
            placeholder: '{\n  "input": "hello"\n}',
            value: state.bodyText || '',
            onChange: function (event) { actions.setBody && actions.setBody(event.target.value) },
          }),
          parsed.ok === false
            ? h('div', { className: 'dpc-dbg-invalid', 'data-tone': 'err' },
                h('span', { className: 'dpc-dbg-invalid-h' }, '⚠️ JSON 格式错误'),
                h('div', null, parsed.text),
              )
            : h('div', { className: 'dpc-note', 'data-tone': 'muted' },
                parsed.empty ? '留空则不带请求体。' : 'JSON 合法 · ' + lineCountOf(state.bodyText) + ' 行'),
        )
      }

      var notes = resultNotes(state.result)
      var body = responseBodyText(state.result)
      var bodyShown = collapseBody(body, state.collapsed)
      var tone = resultToneOf(state.result)

      var resultBlock = null
      if (state.requestError) {
        resultBlock = h('div', { className: 'dpc-dbg-result' },
          h('div', { className: 'dpc-dbg-head' },
            h('span', { className: 'dpc-badge', 'data-tone': 'err' }, '没发出去'),
          ),
          h('div', { className: 'dpc-dbg-invalid', 'data-tone': 'err' }, state.requestError),
        )
      } else if (state.result) {
        resultBlock = h('div', { className: 'dpc-dbg-result' },
          h('div', { className: 'dpc-dbg-head' },
            h('span', { className: 'dpc-badge', 'data-tone': tone }, statusLineOf(state.result)),
            h('span', { className: 'dpc-spacer' }),
            h('button', {
              type: 'button', className: 'dpc-btn',
              onClick: function () { actions.toggleCollapsed && actions.toggleCollapsed() },
            }, state.collapsed ? '展开全部' : '折叠'),
            h('button', {
              type: 'button', className: 'dpc-btn',
              onClick: function () { actions.copyBody && actions.copyBody(body) },
            }, state.copied ? '已复制' : '复制'),
          ),
          notes.map(function (note, index) {
            return h('div', { className: 'dpc-dbg-invalid', 'data-tone': note.tone, key: 'n' + index }, note.text)
          }),
          h('pre', { className: 'dpc-code dpc-dbg-out' }, bodyShown || '（响应体为空）'),
        )
      }

      return h('div', { className: 'dpc-dbg' },
        h('div', { className: 'dpc-dbg-form' },
          h('div', { className: 'dpc-dbg-row' },
            h('label', { className: 'dpc-field dpc-dbg-grow' },
              h('span', { className: 'dpc-label' }, '账户'),
              h('select', {
                className: 'dpc-input',
                value: state.accountId || '',
                onChange: function (event) { actions.setAccount && actions.setAccount(event.target.value) },
              },
                h('option', { value: '' }, options.length ? '— 选择账户 —' : '（无可用账户）'),
                options.map(function (option) {
                  return h('option', { value: option.id, key: option.id },
                    option.label + ' · ' + option.provider + (option.hasKey ? '' : '（无密钥）'))
                }),
              ),
            ),
            h('label', { className: 'dpc-field dpc-dbg-method' },
              h('span', { className: 'dpc-label' }, '方法'),
              h('select', {
                className: 'dpc-input',
                value: normalizeDebugMethod(state.method),
                onChange: function (event) { actions.setMethod && actions.setMethod(event.target.value) },
              }, DEBUG_METHODS.map(function (method) {
                return h('option', { value: method, key: method }, method)
              })),
            ),
            h('label', { className: 'dpc-field dpc-dbg-path' },
              h('span', { className: 'dpc-label' }, '路径'),
              h('input', {
                className: 'dpc-input dpc-mono',
                placeholder: '/models 或 https://…',
                value: state.path || '',
                onChange: function (event) { actions.setPath && actions.setPath(event.target.value) },
              }),
            ),
          ),

          h('div', { className: 'dpc-dbg-note' }, accountHintOf(accounts, state.accountId)),
          state.accountsError ? h('div', { className: 'dpc-dbg-invalid', 'data-tone': 'warn' }, state.accountsError) : null,

          h('div', { className: 'dpc-dbg-headers' },
            h('button', {
              type: 'button', className: 'dpc-btn',
              onClick: function () { actions.toggleHeaders && actions.toggleHeaders() },
            }, (state.headersOpen ? '▾ ' : '▸ ') + 'Headers（' + (state.headers || []).length + '）'),
            headerRows.length ? h('div', { className: 'dpc-dbg-hlist' }, headerRows) : null,
          ),

          bodyBlock,

          h('div', { className: 'dpc-dbg-actions' },
            h('button', {
              type: 'button', className: 'dpc-btn',
              disabled: form.ok !== true || state.sending === true,
              onClick: function () { actions.preview && actions.preview() },
            }, '预览请求（dryRun）'),
            h('button', {
              type: 'button', className: 'dpc-btn', 'data-variant': 'primary', disabled: !canSend,
              onClick: function () { actions.send && actions.send() },
            }, state.sending ? '发送中…' : '发送'),
            h('span', { className: 'dpc-spacer' }),
            h('span', { className: 'dpc-note' }, '快捷模板'),
          ),
          h('div', { className: 'dpc-dbg-chips' },
            debugTemplates().map(function (template) {
              return h('button', {
                type: 'button', className: 'dpc-btn dpc-dbg-chip', key: template.id,
                onClick: function () { actions.applyTemplate && actions.applyTemplate(template) },
              }, template.label)
            }),
          ),
        ),
        resultBlock,
      )
    }

    /** 图标（调试台 tab 用不到，但保留一个可复用的最小集合）。 */

    /* ------------------------------------------------------------------ */
    /* 调试台：控制器（持有 state + fetch，视图保持纯净）                   */
    /* ------------------------------------------------------------------ */

    function makeDebugPanel() {
      return function ProviderConsoleDebug() {
        var pair = React.useState(debugInitialState())
        var state = pair[0]
        var setState = pair[1]
        var patch = function (next) {
          setState(function (previous) {
            var merged = {}
            var key
            for (key in previous) if (Object.prototype.hasOwnProperty.call(previous, key)) merged[key] = previous[key]
            for (key in next) if (Object.prototype.hasOwnProperty.call(next, key)) merged[key] = next[key]
            return merged
          })
        }
        // 只在真有 fetch 的环境里拉账户（测试 harness / SSR 里没有 fetch）
        React.useEffect(function () {
          if (typeof fetch !== 'function') return undefined
          var cancelled = false
          fetch(debugEndpoints().accounts, { headers: { accept: 'application/json' } })
            .then(function (response) { return response.json() })
            .then(function (payload) {
              if (cancelled) return
              var list = debugAccountOptions(payload)
              patch({ accounts: list, accountsError: '', accountId: state.accountId || (list[0] ? list[0].id : '') })
            })
            .catch(function (error) {
              if (!cancelled) patch({ accountsError: '账户列表拉取失败：' + ((error && error.message) || error) })
            })
          return function () { cancelled = true }
        }, [])

        var post = function (payload) {
          return fetch(debugEndpoints().request, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }).then(function (response) {
            return response.json().then(function (data) {
              if (!response.ok) {
                var error = (data && data.error) || {}
                throw { kind: error.kind || 'internal', message: error.message || 'HTTP ' + response.status, hint: error.hint }
              }
              return data
            })
          })
        }

        var run = function (dryRun) {
          var built = buildDebugRequest(state, { dryRun: dryRun })
          if (!built.ok) return patch({ requestError: built.message, result: null })
          patch({ sending: true, requestError: '', copied: false })
          post(built.payload)
            .then(function (data) { patch({ sending: false, result: data.result || null }) })
            .catch(function (error) { patch({ sending: false, requestError: errorActionOf(error), result: null }) })
          return undefined
        }

        var actions = {
          setAccount: function (value) { patch({ accountId: value }) },
          setMethod: function (value) { patch({ method: normalizeDebugMethod(value) }) },
          setPath: function (value) { patch({ path: value }) },
          setBody: function (value) { patch({ bodyText: value }) },
          toggleHeaders: function () { patch({ headersOpen: !state.headersOpen }) },
          toggleCollapsed: function () { patch({ collapsed: !state.collapsed }) },
          addHeader: function () { patch({ headers: (state.headers || []).concat([{ key: '', value: '' }]) }) },
          removeHeader: function (index) {
            patch({ headers: (state.headers || []).filter(function (_row, at) { return at !== index }) })
          },
          setHeader: function (index, field, value) {
            patch({
              headers: (state.headers || []).map(function (row, at) {
                if (at !== index) return row
                var next = { key: row.key, value: row.value }
                next[field] = value
                return next
              }),
            })
          },
          applyTemplate: function (template) {
            patch({
              method: template.method,
              path: template.path,
              bodyText: template.body || '',
              // 切模板时保留已填的 header，但把上次的结果清掉，避免误读成「新请求的响应」
              result: null,
              requestError: '',
            })
          },
          preview: function () { run(true) },
          send: function () { run(false) },
          copyBody: function (text) {
            if (copyText(text)) patch({ copied: true })
          },
        }

        return h(DebugView, { state: state, actions: actions })
      }
    }

    /* ------------------------------------------------------------------ */
    /* 样式（一次性注入；全部走宿主 token）                                 */
    /* ------------------------------------------------------------------ */

    var CSS = [
      // 主面板壳：底 + 前景色都来自 token，亮/暗自动跟随
      '.dpc-shell{height:100%;min-height:0;display:flex;flex-direction:column;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}',
      '.dpc-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:0 0 auto;',
      'padding:10px 14px;box-shadow:0 0.5px 0 0 var(--dsw-alias-border-l2)}',
      '.dpc-title{font-size:14px;font-weight:600;line-height:20px}',
      '.dpc-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dpc-hint[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
      '.dpc-spacer{flex:1}',
      // 按钮：elevated 材质 + 发丝描边，hover 用 interactive token
      '.dpc-btn{font:inherit;font-size:12px;line-height:16px;padding:5px 10px;cursor:pointer;',
      'text-decoration:none;display:inline-flex;align-items:center;gap:6px;',
      'border-radius:var(--dsw-radius-sm);border:0;',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);',
      'box-shadow:var(--dsw-elevation-stroke)}',
      '.dpc-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dpc-btn:active{background:var(--dsw-alias-interactive-bg-active)}',
      '.dpc-btn[data-variant="primary"]{background:var(--dsw-alias-button-primary-fill);',
      'color:var(--dsw-alias-label-primary-foreground)}',
      '.dpc-btn[data-variant="primary"]:hover{background:var(--dsw-alias-button-primary-hover)}',
      '.dpc-btn:disabled{opacity:.55;cursor:default}',
      '.dpc-frame{flex:1;width:100%;min-height:0;border:0;background:transparent}',
      '.dpc-foot{flex:0 0 auto;padding:6px 14px;font-size:11px;line-height:16px;',
      'color:var(--dsw-alias-label-caption);box-shadow:0 -0.5px 0 0 var(--dsw-alias-border-l1)}',
      '.dpc-empty{padding:24px;font-size:13px;line-height:1.8;color:var(--dsw-alias-label-secondary)}',
      '.dpc-empty code{background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsw-radius-xs);',
      'padding:1px 5px;font-family:inherit}',

      // 设置页分区
      '.dpc-sec{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);',
      'font-size:13px;line-height:1.6}',
      '.dpc-sec-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dpc-sec-title{margin:0;font-size:15px;font-weight:600;line-height:22px}',
      '.dpc-card{background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-md);',
      'padding:12px 14px;box-shadow:var(--dsw-elevation-soft)}',
      '.dpc-card-h{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);',
      'line-height:18px;margin-bottom:8px}',
      // 发丝分隔：用 box-shadow 不用 border，避免 1px 在缩放里糊掉
      '.dpc-kv{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 16px;',
      'padding:7px 0;box-shadow:0 0.5px 0 0 var(--dsw-alias-border-l1)}',
      '.dpc-kv:last-child{box-shadow:none}',
      '.dpc-k{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dpc-v{font-variant-numeric:tabular-nums;text-align:right}',
      '.dpc-code{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:18px;',
      'background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsw-radius-sm);padding:10px 12px;',
      'max-height:260px;overflow:auto;color:var(--dsw-alias-label-secondary)}',
      '.dpc-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dpc-sec-gap{flex:1}',
      '.dpc-btn-copy{margin-top:8px;align-self:flex-start}',
      '.dpc-badge{display:inline-block;padding:0 7px;border-radius:999px;corner-shape:round;',
      'font-size:11px;line-height:18px}',
      '.dpc-badge[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);',
      'background:var(--dsw-alias-state-success-tertiary)}',
      '.dpc-badge[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);',
      'background:var(--dsw-alias-state-warn-tertiary)}',
      '.dpc-badge[data-tone="idle"]{color:var(--dsw-alias-label-secondary);',
      'background:var(--dsw-alias-interactive-bg-hover)}',
      // 焦点环：--dsw-focus-ring-color 在主题里是 transparent，直接指定 business 色
      '.dpc-shell :focus-visible,.dpc-sec :focus-visible{outline:var(--dsw-focus-ring-width) solid ',
      'var(--dsw-alias-state-business-primary);outline-offset:2px}',

      // ---- 主面板 tab 条 ----
      '.dpc-tabs{display:flex;gap:4px;align-items:center;flex-wrap:wrap}',
      '.dpc-tab{font:inherit;font-size:12px;line-height:16px;padding:5px 11px;cursor:pointer;border:0;',
      'background:transparent;color:var(--dsw-alias-label-secondary);',
      'border-radius:var(--dsw-radius-sm);corner-shape:round}',
      '.dpc-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dpc-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-2);',
      'color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-stroke)}',

      // ---- 调试台 ----
      '.dpc-dbg{flex:1;min-height:0;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:12px}',
      '.dpc-dbg-form{display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-2);',
      'border-radius:var(--dsw-radius-lg);padding:14px;box-shadow:var(--dsw-elevation-soft)}',
      '.dpc-dbg-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}',
      '.dpc-dbg-grow{flex:1 1 200px;min-width:160px}',
      '.dpc-dbg-method{flex:0 0 104px}',
      '.dpc-dbg-path{flex:2 1 260px;min-width:180px}',
      '.dpc-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dpc-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dpc-input{font:inherit;font-size:12px;line-height:18px;padding:5px 8px;width:100%;box-sizing:border-box;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);',
      'border:0;border-radius:var(--dsw-radius-sm);box-shadow:var(--dsw-elevation-stroke)}',
      '.dpc-input:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dpc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.dpc-textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;',
      'line-height:18px;padding:8px 10px;width:100%;box-sizing:border-box;resize:vertical;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);',
      'border:0;border-radius:var(--dsw-radius-sm);box-shadow:var(--dsw-elevation-stroke)}',
      '.dpc-dbg-body{display:flex;flex-direction:column;gap:6px}',
      '.dpc-dbg-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.dpc-note[data-tone="muted"]{color:var(--dsw-alias-label-tertiary)}',
      // 校验/错误块：语义色底 + 语义色字，不用 1px border
      '.dpc-dbg-invalid{font-size:12px;line-height:18px;padding:7px 10px;border-radius:var(--dsw-radius-sm);',
      'color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-business-tertiary)}',
      '.dpc-dbg-invalid[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);',
      'background:var(--dsw-alias-state-warn-tertiary)}',
      '.dpc-dbg-invalid[data-tone="err"]{color:var(--dsw-alias-state-error-primary);',
      'background:var(--dsw-alias-state-business-tertiary)}',
      '.dpc-dbg-invalid-h{font-weight:600}',
      '.dpc-dbg-headers{display:flex;flex-direction:column;gap:8px}',
      '.dpc-dbg-hlist{display:flex;flex-direction:column;gap:6px}',
      '.dpc-dbg-hrow{display:flex;gap:6px;align-items:center}',
      '.dpc-dbg-hk{flex:0 0 150px}',
      '.dpc-dbg-hv{flex:1 1 auto}',
      '.dpc-dbg-add{align-self:flex-start}',
      '.dpc-dbg-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dpc-dbg-chips{display:flex;gap:6px;flex-wrap:wrap}',
      '.dpc-dbg-chip{font-size:11px;line-height:16px;padding:3px 9px}',
      '.dpc-dbg-result{display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-2);',
      'border-radius:var(--dsw-radius-lg);padding:14px;box-shadow:var(--dsw-elevation-soft)}',
      '.dpc-dbg-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dpc-dbg-out{margin:0;max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-word;',
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;',
      'background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsw-radius-sm);padding:10px 12px;',
      'color:var(--dsw-alias-label-secondary)}',
      '.dpc-dbg-empty{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:2px 0}',

      // 调试台里的徽标复用了文件顶部那套 .dpc-badge（ok/warn/idle），这里补 err
      '.dpc-badge[data-tone="err"]{color:var(--dsw-alias-state-error-primary);',
      'background:var(--dsw-alias-state-business-tertiary)}',
    ].join('')

    if (typeof document !== 'undefined' && document.head && !document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')) {
      var styleTag = document.createElement('style')
      styleTag.dataset.plugin = 'dsh-plugin-provider-console'
      styleTag.dataset.pluginCss = CSS_ID
      styleTag.textContent = CSS
      document.head.appendChild(styleTag)
    }

    /** 测试沙箱里没有 useRef 时退化成普通对象；模块初始化时求值一次，不受渲染次数影响。 */
    var useRefHook = typeof React.useRef === 'function' ? React.useRef : function () { return { current: null } }

    /** 订阅宿主主题变化（用户在看板打开时切换外观，iframe 要跟着换）。 */
    function useHostTheme() {
      var pair = React.useState(hostTheme())
      var theme = pair[0]
      var setTheme = pair[1]
      React.useEffect(function () {
        if (typeof MutationObserver !== 'function') return undefined
        if (typeof document === 'undefined' || !document.body) return undefined
        var observer = new MutationObserver(function () { setTheme(hostTheme()) })
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        return function () { observer.disconnect() }
      }, [])
      return theme
    }

    /* ------------------------------------------------------------------ */
    /* 图标                                                                */
    /* ------------------------------------------------------------------ */

    function PanelIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 18
      return h(
        'svg',
        {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.7,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        },
        h('rect', { x: 2.5, y: 5, width: 19, height: 14, rx: 2.5 }),
        h('path', { d: 'M2.5 9.5h19' }),
        h('path', { d: 'M6.5 14.5h4' }),
        h('circle', { cx: 17, cy: 14.5, r: 1.1, fill: 'currentColor', stroke: 'none' }),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 主面板                                                              */
    /* ------------------------------------------------------------------ */

    /** 主面板：tab 条（余额看板 / 调试台）+ 当前 tab 的内容。 */
    function makePage(config) {
      return function ProviderConsolePage() {
        var enabled = dashboardEnabled(config)
        var base = dashboardUrl(config)
        var noncePair = React.useState(0)
        var nonce = noncePair[0]
        var setNonce = noncePair[1]
        var tabPair = React.useState('dashboard')
        var tab = tabPair[0]
        var setTab = tabPair[1]
        var theme = useHostTheme()
        var frameRef = useRefHook(null)
        var Debug = React.useMemo ? React.useMemo(makeDebugPanel, []) : makeDebugPanel()

        // 主题变化时重推 token；首次由 iframe 的 onLoad 负责（那时才拿得到 contentWindow）
        React.useEffect(function () {
          pushTheme(frameRef.current, theme)
        }, [theme])

        var bar = h(
          'div',
          { className: 'dpc-bar' },
          h('span', { className: 'dpc-title' }, 'AI 服务商账户控制台'),
          h('span', {
            className: 'dpc-hint',
            'data-tone': enabled ? 'muted' : 'warn',
          }, enabled ? '本地看板 · 127.0.0.1' : '看板未启用'),
          h('span', { className: 'dpc-spacer' }),
          // tab 条：两个视图互不影响，调试台不依赖看板是否启用
          h('div', { className: 'dpc-tabs', role: 'tablist' },
            h('button', {
              type: 'button', className: 'dpc-tab', role: 'tab',
              'data-active': tab === 'dashboard' ? 'true' : 'false',
              'aria-selected': tab === 'dashboard' ? 'true' : 'false',
              onClick: function () { setTab('dashboard') },
            }, '余额看板'),
            h('button', {
              type: 'button', className: 'dpc-tab', role: 'tab',
              'data-active': tab === 'debug' ? 'true' : 'false',
              'aria-selected': tab === 'debug' ? 'true' : 'false',
              onClick: function () { setTab('debug') },
            }, '调试台'),
          ),
          enabled
            ? h('button', {
                type: 'button', className: 'dpc-btn',
                onClick: function () { setNonce(Date.now()) },
              }, '刷新')
            : null,
          h('a', {
            className: 'dpc-btn', href: base, target: '_blank', rel: 'noreferrer',
            title: '在系统浏览器里打开看板',
          }, '在浏览器打开'),
        )

        // 调试台 tab：完全不依赖 8788 看板，因此放在 enabled 判断之前
        if (tab === 'debug') {
          return h(
            'div',
            { className: 'dpc-shell' },
            bar,
            h(Debug, null),
            h('div', { className: 'dpc-foot' },
              '请求经插件同源路由发出：密钥由账户配置自动注入、白名单强制生效，响应里的密钥一律脱敏。'),
          )
        }

        if (!enabled) {
          return h(
            'div',
            { className: 'dpc-shell' },
            bar,
            h('div', { className: 'dpc-empty' },
              '当前 profile 未开启本地看板，因此这里没有可嵌入的页面。',
              h('br'),
              '在 cordis.patch.yml 的 provider-console 配置里把 ',
              h('code', null, 'dashboard.enabled'),
              ' 设为 true，保存后宿主会热重载。',
              h('br'),
              '也可以直接调用会话里的 provider_status / provider_balances 工具查看状态。',
            ),
          )
        }

        return h(
          'div',
          { className: 'dpc-shell' },
          bar,
          h('iframe', {
            key: String(nonce),
            ref: frameRef,
            src: embedUrl(base, nonce, theme),
            title: 'AI 服务商账户控制台',
            className: 'dpc-frame',
            onLoad: function (event) {
              pushTheme((event && event.currentTarget) || frameRef.current, theme)
            },
          }),
          h('div', { className: 'dpc-foot' },
            '页面由插件本地 HTTP 服务提供，仅监听回环地址；若内嵌显示异常，点「在浏览器打开」。'),
        )
      }
    }

    /* ------------------------------------------------------------------ */
    /* 设置页（只读 + 复制 YAML）                                            */
    /* ------------------------------------------------------------------ */

    var KNOBS = [
      { key: 'dashboard.enabled', label: '本地看板', read: function (c) { return (c.dashboard && c.dashboard.enabled) !== false }, type: 'bool' },
      { key: 'dashboard.port', label: '看板端口', read: function (c) { return (c.dashboard && c.dashboard.port) || 8788 }, type: 'num' },
      { key: 'sidebar.enabled', label: '左侧栏入口', read: function (c) { return !c.sidebar || c.sidebar.enabled !== false }, type: 'bool' },
      { key: 'sidebar.label', label: '入口名称', read: function (c) { return (c.sidebar && c.sidebar.label) || PANEL_LABEL }, type: 'str' },
      { key: 'sidebar.order', label: '入口排序', read: function (c) { return (c.sidebar && typeof c.sidebar.order === 'number' && c.sidebar.order) || 20 }, type: 'num' },
      { key: 'lowBalanceThreshold', label: '低余额预警阈值', read: function (c) { return typeof c.lowBalanceThreshold === 'number' ? c.lowBalanceThreshold : '未设置' }, type: 'any' },
      { key: 'cacheTtlMs', label: '余额缓存 TTL (ms)', read: function (c) { return typeof c.cacheTtlMs === 'number' ? c.cacheTtlMs : 60000 }, type: 'num' },
      { key: 'autoDiscover', label: '凭证自动探测', read: function (c) { return c.autoDiscover !== false }, type: 'bool' },
      { key: 'llmProvider.enabled', label: '模型 provider', read: function (c) { return !c.llmProvider || c.llmProvider.enabled !== false }, type: 'bool' },
    ]

    function knobRows(config) {
      var out = []
      for (var i = 0; i < KNOBS.length; i++) {
        var knob = KNOBS[i]
        var value
        try {
          value = knob.read(config || {})
        } catch (_) {
          value = '—'
        }
        out.push({ key: knob.key, label: knob.label, type: knob.type, value: value })
      }
      return out
    }

    /**
     * 生成可直接粘进 profile 的 cordis.patch.yml 片段。
     *
     * 只写「用户可以安全改」的键；密钥类配置（accounts / apiKey）永远不出现在这里，
     * 因为本页是只读展示，写配置这件事交给用户自己在他的 YAML 里做。
     */
    function yamlSnippet(config) {
      var c = config || {}
      var sidebar = c.sidebar || {}
      var dashboard = c.dashboard || {}
      var llm = c.llmProvider || {}
      var lines = [
        '- insert:',
        '    - id: provider-console',
        '      name: dsh-plugin-provider-console',
        '      config:',
        '        autoDiscover: ' + (c.autoDiscover !== false),
        '        lowBalanceThreshold: ' + (typeof c.lowBalanceThreshold === 'number' ? c.lowBalanceThreshold : 'null'),
        '        cacheTtlMs: ' + (typeof c.cacheTtlMs === 'number' ? c.cacheTtlMs : 60000),
        '        dashboard:',
        '          enabled: ' + (dashboard.enabled !== false),
        '          port: ' + (typeof dashboard.port === 'number' ? dashboard.port : 8788),
        '        sidebar:',
        '          enabled: ' + (sidebar.enabled !== false),
        '          label: ' + ((sidebar && sidebar.label) || PANEL_LABEL),
        '          order: ' + (typeof sidebar.order === 'number' ? sidebar.order : 20),
        '        llmProvider:',
        '          enabled: ' + (llm.enabled !== false),
      ]
      return lines.join('\n')
    }

    function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          void navigator.clipboard.writeText(text)
          return true
        }
      } catch (_) {
        /* 落到下面的选择式兜底 */
      }
      return false
    }

    function makeSettingsPage(config) {
      return function ProviderConsoleSettings() {
        var copiedPair = React.useState(false)
        var copied = copiedPair[0]
        var setCopied = copiedPair[1]
        var snippet = yamlSnippet(config)
        var rows = knobRows(config)
        var base = dashboardUrl(config)

        return h(
          'div',
          { className: 'dpc-sec' },
          h('div', { className: 'dpc-sec-head' },
            h('h2', { className: 'dpc-sec-title' }, '服务商控制台'),
            h('span', { className: 'dpc-badge', 'data-tone': 'idle' }, '只读'),
            h('span', { className: 'dpc-sec-gap' }),
            h('a', { className: 'dpc-btn', href: base, target: '_blank', rel: 'noreferrer' }, '打开看板'),
          ),

          h('div', { className: 'dpc-card' },
            h('div', { className: 'dpc-card-h' }, '当前生效值（宿主传给浏览器半端的配置）'),
            rows.map(function (row) {
              return h('div', { className: 'dpc-kv', key: row.key },
                h('div', { className: 'dpc-k' }, h('code', { className: 'dpc-v' }, row.key), ' · ', row.label),
                h('div', { className: 'dpc-v' }, String(row.value)),
              )
            }),
          ),

          h('div', { className: 'dpc-card' },
            h('div', { className: 'dpc-card-h' }, '如何修改'),
            h('div', { className: 'dpc-note' },
              '这些值来自 profile 的 cordis.patch.yml。本页只读 —— 插件不会替你改配置文件'
                + '（写回 YAML 会破坏注释、和插件管理器的写入互相覆盖，风险高于收益）。',
              h('br'),
              '改法：复制下面的片段 → 粘到你的 profile 里 → 保存，宿主会热重载。',
            ),
            h('pre', { className: 'dpc-code' }, snippet),
            h('button', {
              type: 'button',
              className: 'dpc-btn dpc-btn-copy',
              'data-variant': 'primary',
              onClick: function () {
                if (copyText(snippet)) setCopied(true)
              },
            }, copied ? '已复制' : '复制 YAML 片段'),
          ),
        )
      }
    }

    /* ------------------------------------------------------------------ */
    /* 插件体                                                              */
    /* ------------------------------------------------------------------ */

    function apply(ctx, config) {
      var opts = panelOptions(config)
      var slots = ctx.slots || (ctx.get ? ctx.get('slots') : undefined)
      if (!slots || typeof slots.inject !== 'function') return

      if (opts.enabled) {
        slots.inject('main', function () {
          return slots.register(
            { name: 'main', key: PANEL_ID, order: opts.order, label: opts.label },
            makePage(config),
          )
        })
        slots.inject('sidebar.panellist', function () {
          return slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: opts.order, label: opts.label },
            PanelIcon,
          )
        })
      }

      // 设置页与左侧栏开关解耦：用户关掉入口图标时，仍然要能在设置里看到配置。
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: PANEL_ID, order: SETTINGS_ORDER, label: function () { return PANEL_LABEL } },
          makeSettingsPage(config),
        )
      })
      // settings.section.icon 是 list slot，id 必须与 section 相同，否则图标挂不上
      slots.inject('settings.section.icon', function () {
        return slots.register({ name: 'settings.section.icon', id: PANEL_ID }, PanelIcon)
      })
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    exports.__test = {
      dashboardUrl: dashboardUrl,
      embedUrl: embedUrl,
      dashboardEnabled: dashboardEnabled,
      panelOptions: panelOptions,
      themeOf: themeOf,
      originOf: originOf,
      tokenSnapshot: tokenSnapshot,
      pushTheme: pushTheme,
      knobRows: knobRows,
      yamlSnippet: yamlSnippet,
      makePage: makePage,
      makeSettingsPage: makeSettingsPage,
      // ---- 调试台（纯函数，供 test/debug-ui.test.ts 单测） ----
      makeDebugPanel: makeDebugPanel,
      DebugView: DebugView,
      debugEndpoints: debugEndpoints,
      debugInitialState: debugInitialState,
      debugTemplates: debugTemplates,
      debugAccountOptions: debugAccountOptions,
      accountHintOf: accountHintOf,
      buildDebugRequest: buildDebugRequest,
      validateJsonText: validateJsonText,
      jsonErrorPosition: jsonErrorPosition,
      describeJsonError: describeJsonError,
      cleanJsonMessage: cleanJsonMessage,
      bracketScanner: bracketScanner,
      positionToLineColumn: positionToLineColumn,
      prettyJson: prettyJson,
      formatBytes: formatBytes,
      responseBodyText: responseBodyText,
      resultToneOf: resultToneOf,
      statusLineOf: statusLineOf,
      errorActionOf: errorActionOf,
      resultNotes: resultNotes,
      collapseBody: collapseBody,
      normalizeDebugMethod: normalizeDebugMethod,
      DEBUG_BASE_PATH: DEBUG_BASE_PATH,
      DEBUG_METHODS: DEBUG_METHODS,
      DEBUG_COLLAPSED_LINES: DEBUG_COLLAPSED_LINES,
      FRAME_TOKENS: FRAME_TOKENS,
      CSS: CSS,
      PANEL_ID: PANEL_ID,
      SETTINGS_ORDER: SETTINGS_ORDER,
      THEME_MESSAGE: THEME_MESSAGE,
    }
    return module.exports
  },
})
