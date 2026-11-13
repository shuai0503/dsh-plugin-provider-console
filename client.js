/**
 * dsh-plugin-provider-console —— 浏览器半端（左侧「服务商控制台」入口）
 * ============================================================================
 * DSH 的 client bundle 不是 ESM，而是自注册脚本：
 *
 *   window.__ModuleLoader__.load({
 *     id: '<package.json 的 name>',
 *     factory: (require) => { ...; return { name, inject, apply } },
 *   })
 *
 * 这里注册两个 slot（与宿主 dsh-client-ui-schedule 同款写法）：
 *   · sidebar.panellist  → 左侧图标，id 必须与主面板 key 相同
 *   · main               → 选中图标后显示的中央面板（内嵌 127.0.0.1 看板）
 *
 * 面板本身只做壳：数据、余额刷新、API 调用全部由宿主线程里的看板页面负责，
 * 浏览器半端不接触任何 API Key，也不发跨域请求（iframe 同源加载本地页面）。
 * 看板地址优先取配置树里同一 entry 的 dashboard.{url,host,port}，取不到则用
 * 默认 http://127.0.0.1:8788/ —— 即使 client 端没拿到 config 也能工作。
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

    var name = PANEL_ID
    var inject = ['slots']

    function dashboardUrl(config) {
      var s = config && config.sidebar
      if (s && typeof s.dashboardUrl === 'string' && s.dashboardUrl) return s.dashboardUrl
      var d = config && config.dashboard
      if (!d) return DEFAULT_DASHBOARD_URL
      if (typeof d.url === 'string' && d.url) return d.url
      if (d.host && d.port) {
        var scheme = String(d.url || '').match(/^https:/) ? 'https' : 'http'
        return scheme + '://' + d.host + ':' + d.port + '/'
      }
      return DEFAULT_DASHBOARD_URL
    }

    function embedUrl(base, nonce) {
      var sep = base.indexOf('?') >= 0 ? '&' : '?'
      return base + sep + 'embed=1' + (nonce ? '&t=' + nonce : '')
    }

    function label() {
      return PANEL_LABEL
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

    /** 左侧图标：一个钱包 / 仪表盘轮廓，跟随宿主前景色。 */
    function PanelIcon() {
      return h(
        'svg',
        {
          width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.7,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        },
        h('rect', { x: 2.5, y: 5, width: 19, height: 14, rx: 2.5 }),
        h('path', { d: 'M2.5 9.5h19' }),
        h('path', { d: 'M6.5 14.5h4' }),
        h('circle', { cx: 17, cy: 14.5, r: 1.1, fill: 'currentColor', stroke: 'none' }),
      )
    }

    var buttonStyle = {
      font: 'inherit', fontSize: 12, padding: '5px 10px',
      border: '1px solid var(--dsw-alias-border-l1, #3a4252)',
      borderRadius: 7, cursor: 'pointer', textDecoration: 'none',
      background: 'var(--dsw-alias-bg-layer-1, #232936)',
      color: 'var(--dsw-alias-text-primary, #e7eaf0)',
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

    /** 主面板：工具条 + 内嵌看板；看板关闭时给出明确的开启指引。 */
    function makePage(config) {
      return function ProviderConsolePage() {
        var enabled = dashboardEnabled(config)
        var base = dashboardUrl(config)
        var state = React.useState(0)
        var nonce = state[0]
        var setNonce = state[1]

        var bar = h(
          'div',
          {
            style: {
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              padding: '10px 14px', flex: '0 0 auto',
              borderBottom: '1px solid var(--dsw-alias-border-l1, #303746)',
            },
          },
          h('span', { style: { fontWeight: 600, fontSize: 14 } }, 'AI 服务商账户控制台'),
          h('span', {
            style: {
              fontSize: 12, color: enabled
                ? 'var(--dsw-alias-text-secondary, #9aa3b5)'
                : 'var(--dsw-alias-state-warn-primary, #d99a2b)',
            },
          }, enabled ? '本地看板 · 127.0.0.1' : '看板未启用'),
          h('span', { style: { flex: 1 } }),
          enabled
            ? h('button', {
                type: 'button', style: buttonStyle,
                onClick: function () { setNonce(Date.now()) },
              }, '刷新')
            : null,
          h('a', {
            href: base, target: '_blank', rel: 'noreferrer',
            style: buttonStyle, title: '在系统浏览器里打开看板',
          }, '在浏览器打开'),
        )

        if (!enabled) {
          return h(
            'div',
            { style: { height: '100%', display: 'flex', flexDirection: 'column' } },
            bar,
            h('div', {
              style: {
                padding: 24, fontSize: 13, lineHeight: 1.8,
                color: 'var(--dsw-alias-text-secondary, #9aa3b5)',
              },
            },
              '当前 profile 未开启本地看板，因此这里没有可嵌入的页面。',
              h('br'),
              '在 cordis.patch.yml 的 provider-console 配置里把 dashboard.enabled 设为 true，保存后宿主会热重载。',
              h('br'),
              '也可以直接调用会话里的 provider_status / provider_balances 工具查看状态。',
            ),
          )
        }

        return h(
          'div',
          {
            style: {
              height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0,
              background: 'var(--dsw-alias-bg-layer-0, #171a21)',
              color: 'var(--dsw-alias-text-primary, #e7eaf0)',
            },
          },
          bar,
          h('iframe', {
            key: String(nonce),
            src: embedUrl(base, nonce),
            title: 'AI 服务商账户控制台',
            style: { flex: 1, width: '100%', border: 0, minHeight: 0, background: 'transparent' },
          }),
          h('div', {
            style: {
              flex: '0 0 auto', padding: '6px 14px', fontSize: 11,
              color: 'var(--dsw-alias-text-secondary, #9aa3b5)',
              borderTop: '1px solid var(--dsw-alias-border-l1, #303746)',
            },
          }, '页面由插件本地 HTTP 服务提供，仅监听回环地址；若内嵌显示异常，点「在浏览器打开」。'),
        )
      }
    }

    function apply(ctx, config) {
      var opts = panelOptions(config)
      if (!opts.enabled) return
      var slots = ctx.slots || (ctx.get ? ctx.get('slots') : undefined)
      if (!slots || typeof slots.inject !== 'function') return

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

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    exports.__test = { dashboardUrl: dashboardUrl, embedUrl: embedUrl, dashboardEnabled: dashboardEnabled, PANEL_ID: PANEL_ID }
    return module.exports
  },
})
