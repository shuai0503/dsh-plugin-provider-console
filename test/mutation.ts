#!/usr/bin/env node
/**
 * 变异测试运行器。
 *
 * 目的：证明「全绿」不是因为测试太松。每条变异往源码里注入一个真实缺陷，
 * 跑对应测试文件，**必须变红**；若仍全绿说明该测试没有守到点上。
 *
 * 关键设计（踩过的坑）：
 *   · 每条变异先打印**替换匹配次数**，0 次 = 变异没生效 = 结果无意义。
 *   · 只在进程内改文件、跑完立刻还原；还原走 finally，测试抛异常也不会留脏文件。
 *   · 用 buffer 读写，避免 Windows 控制台 GBK 把中文源码写坏。
 *
 * 用法：node test/mutation.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

interface Mutation {
  id: string
  file: string
  /** 要替换的字面量。必须**恰好**出现 count 次，否则视为变异失败。 */
  find: string
  replace: string
  /** 期望变红的测试文件（相对 test/）。 */
  test: string
  /** 为什么这条变异代表一个真实缺陷。 */
  why: string
}

const MUTATIONS: Mutation[] = [
  {
    id: 'M1-token-typo',
    file: 'client.js',
    // 把修好的真实 token 改回 0.3.0 里的错名 —— 这正是线上黑底白字的成因
    find: "'--dsw-alias-label-primary',",
    replace: "'--dsw-alias-text-primary',",
    test: 'tokens.test.ts',
    why: '退回 0.3.0 的错拼 token：必须被「token 真实存在」守卫抓住',
  },
  {
    id: 'M2-theme-ignores-host',
    file: 'client.js',
    find: "return body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'",
    replace: "return 'light'",
    test: 'client-entry.test.ts',
    why: '主题判定恒返回 light：暗色宿主会被渲染成亮色，themeOf 断言必须变红',
  },
  {
    id: 'M3-iframe-no-theme-param',
    file: 'client.js',
    find: "return base + sep + 'embed=1&theme=' + (theme === 'dark' ? 'dark' : 'light') + (nonce ? '&t=' + nonce : '')",
    replace: "return base + sep + 'embed=1' + (nonce ? '&t=' + nonce : '')",
    test: 'client-entry.test.ts',
    why: 'iframe URL 丢掉 theme 参数：iframe 主题跟随整条链路失效',
  },
  {
    id: 'M4-corner-shape-dropped',
    file: 'public/index.html',
    find: '.track {\n    height: 6px; border-radius: 999px; corner-shape: round;',
    replace: '.track {\n    height: 6px; border-radius: 999px;',
    test: 'tokens.test.ts',
    why: '进度条丢了 corner-shape:round：会被宿主 superellipse 拉成畸形',
  },
  {
    id: 'M5-inline-fallback-returns',
    file: 'client.js',
    find: "background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);",
    replace: "background:var(--dsw-alias-bg-layer-2,#232936);color:var(--dsw-alias-label-primary,#e7eaf0);",
    test: 'tokens.test.ts',
    why: '把 inline fallback 加回来：拼写错误会重新变成静默错误',
  },
  {
    id: 'M6-prefers-color-scheme',
    file: 'client.js',
    find: "return body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'",
    replace: "return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'",
    test: 'client-entry.test.ts',
    why: '改用 prefers-color-scheme：会覆盖用户手动选的主题（DSH 已经解析过系统偏好）',
  },
  {
    id: 'M7-status-tone-wrong',
    file: 'public/index.html',
    find: "const TONE = { ok: 'ok', stale: 'warn', manual: 'warn', error: 'err', unsupported: 'idle' };",
    replace: "const TONE = { ok: 'ok', stale: 'ok', manual: 'ok', error: 'ok', unsupported: 'ok' };",
    test: 'tokens.test.ts',
    why: '状态色映射塌成一个色：缓存/失败/不支持将无法区分',
  },
  {
    id: 'M8-settings-section-id-mismatch',
    file: 'client.js',
    find: "return slots.register({ name: 'settings.section.icon', id: PANEL_ID }, PanelIcon)",
    replace: "return slots.register({ name: 'settings.section.icon', id: 'wrong-id' }, PanelIcon)",
    test: 'client-entry.test.ts',
    why: 'settings.section.icon 的 id 与 section 不一致：设置页导航图标挂不上',
  },
  {
    id: 'M9-sidebar-disabled-kills-settings',
    file: 'client.js',
    find: "      // 设置页与左侧栏开关解耦：用户关掉入口图标时，仍然要能在设置里看到配置。",
    replace: "      if (!opts.enabled) return\n      // 设置页与左侧栏开关解耦：用户关掉入口图标时，仍然要能在设置里看到配置。",
    test: 'client-entry.test.ts',
    why: '把设置页也挂在 sidebar.enabled 下：用户关掉图标后再也没有入口改回来',
  },
  {
    id: 'M10-yaml-leaks-apikey',
    file: 'client.js',
    find: "        '        autoDiscover: ' + (c.autoDiscover !== false),",
    replace: "        '        apiKey: sk-leaked',\n        '        autoDiscover: ' + (c.autoDiscover !== false),",
    test: 'client-entry.test.ts',
    why: 'YAML 片段里混进密钥字段：只读页面的底线被破坏',
  },
  {
    id: 'M11-dashboard-config-not-sent',
    file: 'src/dashboard.ts',
    find: '          config: publicConfig(options.config),',
    replace: '          config: options.config,',
    test: 'dashboard.test.ts',
    why: '直接把 ResolvedConfig 塞进 API：accounts 里的字段会随 JSON 一起出网',
  },
  {
    id: 'M12-sidebar-default-order-drift',
    file: 'src/config.ts',
    find: 'order: clamp(config.sidebar?.order ?? 20, -1_000_000, 1_000_000),',
    replace: 'order: clamp(config.sidebar?.order ?? 30, -1_000_000, 1_000_000),',
    test: 'client-entry.test.ts',
    why: '宿主侧 sidebar 默认 order 改成 30：与 client.js 的 20 不一致，入口排序漂移',
  },

  // -------------------------------------------------------------------------
  // 调试台（0.5.0 新增）：同源路由 + 前端构造/校验
  // -------------------------------------------------------------------------

  {
    id: 'M13-debug-skip-whitelist',
    file: 'src/debug-api.ts',
    // 砍掉同源栅栏：任何来源都能驱动这个端点（DNS rebinding / CSRF 敞口）
    find: '    const gate = fence(request)\n    if (!gate.ok) return refuse(response, gate.reason)\n    const contentType',
    replace: '    const gate = fence(request)\n    if (!gate.ok) { /* 静默放行 */ }\n    const contentType',
    test: 'debug-api.test.ts',
    why: '路由不再执行同源栅栏：evil.com 的页面（Host 伪造）能直接驱动调试端点',
  },
  {
    id: 'M14-debug-leak-secret',
    file: 'src/debug-api.ts',
    // 回包不再脱敏：上游回显的密钥原样出网
    find: '      sendJson(response, 200, { result: redactDeep(result, secrets) })',
    replace: '      sendJson(response, 200, { result })',
    test: 'debug-api.test.ts',
    why: '响应不再过 redactDeep：中转站回显的 Authorization 会把明文密钥写进页面',
  },
  {
    id: 'M15-debug-dryrun-sends',
    file: 'src/debug-api.ts',
    // 把 dryRun 丢掉：点「预览」真的会发一次请求
    find: '        dryRun: options.dryRun,',
    replace: '        dryRun: false,',
    test: 'debug-api.test.ts',
    why: 'dryRun 被写死成 false：预览按钮会真的打上游（还会烧额度）',
  },
  {
    id: 'M16-debug-json-line-0',
    file: 'client.js',
    // 引擎不给位置时不再自己扫：行号退化成 0，错误提示变成没法用的废话
    find: '        var scanned = enginePosition ? null : bracketScanner(raw)',
    replace: '        var scanned = null',
    test: 'debug-ui.test.ts',
    why: '去掉 bracketScanner 兜底：V8 不给 position 时（如 tru 拼错）报不出行号',
  },
  {
    id: 'M17-debug-preview-send-diverges',
    file: 'client.js',
    // 预览与发送不再共用同一份构造：预览显示 A，真发出去 B
    find: "      var payload = { accountId: accountId, method: method, path: path, dryRun: dryRun, includeRaw: true }",
    replace: "      var payload = { accountId: accountId, method: method, path: path, dryRun: dryRun, includeRaw: dryRun }",
    test: 'debug-ui.test.ts',
    why: '预览与发送的 payload 不再同构：dryRun 改了 includeRaw，两边发的请求不一样',
  },
  {
    id: 'M18-debug-invalid-still-sends',
    file: 'client.js',
    // 发送按钮不再看「请求是否构造得出来」：没选账户 / JSON 非法都能点发送
    find: '      var canSend = form.ok && state.sending !== true',
    replace: '      var canSend = state.sending !== true',
    test: 'debug-ui.test.ts',
    why: '发送按钮不看 form.ok：没选账户或 body 非法时用户仍能点发送，请求被静默丢弃',
  },
]

interface Outcome {
  id: string
  matched: number
  red: boolean
  passBefore: number
  failAfter: number
  detail: string
}

function runTest(testFile: string): { pass: number; fail: number; raw: string } {
  const result = spawnSync(process.execPath, [join('test', testFile)], {
    cwd: ROOT,
    encoding: 'utf8',
    // 沙箱禁止管道捕获；stdio:inherit 下的输出由 shell 直接落盘，这里改用文件重定向
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const pass = Number(/pass (\d+)/.exec(raw)?.[1] ?? -1)
  const fail = Number(/fail (\d+)/.exec(raw)?.[1] ?? -1)
  return { pass, fail, raw }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = 0
  for (;;) {
    const found = haystack.indexOf(needle, index)
    if (found === -1) break
    count += 1
    index = found + needle.length
  }
  return count
}

const outcomes: Outcome[] = []
let aborted = false

for (const mutation of MUTATIONS) {
  const path = join(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  const matched = countOccurrences(original, mutation.find)

  if (matched !== 1) {
    // 变异没生效：绝不能用「测试没红」当作「测试无效」的证据
    outcomes.push({
      id: mutation.id,
      matched,
      red: false,
      passBefore: -1,
      failAfter: -1,
      detail: `SKIPPED — 替换串命中 ${matched} 次（必须恰好 1 次），变异未生效`,
    })
    aborted = true
    continue
  }

  const before = runTest(mutation.test)
  let after = { pass: -1, fail: -1, raw: '' }
  try {
    writeFileSync(path, original.replace(mutation.find, mutation.replace), 'utf8')
    after = runTest(mutation.test)
  } finally {
    // 无论测试是否抛异常，源码必须还原
    writeFileSync(path, original, 'utf8')
  }

  const restored = readFileSync(path, 'utf8')
  if (restored !== original) {
    throw new Error(`${mutation.id}: 源码未正确还原，请手工检查 ${mutation.file}`)
  }

  outcomes.push({
    id: mutation.id,
    matched,
    red: after.fail > 0,
    passBefore: before.pass,
    failAfter: after.fail,
    detail: mutation.why,
  })
}

// 还原后再跑一次基线，证明变异没有留下后遗症
const baselineFiles = ['tokens.test.ts', 'client-entry.test.ts', 'dashboard.test.ts', 'debug-api.test.ts', 'debug-ui.test.ts']
const baselines = baselineFiles.map((file) => ({ file, ...runTest(file) }))

const lines: string[] = []
lines.push('变异测试报告')
lines.push('='.repeat(78))
for (const outcome of outcomes) {
  const verdict = outcome.matched !== 1 ? 'SKIP' : outcome.red ? 'RED ' : 'GREEN(!!)'
  lines.push(
    `${verdict}  ${outcome.id.padEnd(36)} 匹配=${outcome.matched}  ` +
      `变异前 pass=${outcome.passBefore} → 变异后 fail=${outcome.failAfter}`,
  )
  lines.push(`        ${outcome.detail}`)
}
lines.push('='.repeat(78))
const applied = outcomes.filter((o) => o.matched === 1)
const killed = applied.filter((o) => o.red)
lines.push(`变异生效 ${applied.length}/${outcomes.length}，被测试杀死 ${killed.length}/${applied.length}`)
lines.push(
  `还原后基线：${baselines.map((b) => `${b.file} pass=${b.pass}/fail=${b.fail}`).join(' · ')}`,
)

const report = lines.join('\n')
writeFileSync(join(ROOT, 'test', 'mutation-report.txt'), `${report}\n`, 'utf8')
console.log(report)

const ok =
  !aborted &&
  applied.length === outcomes.length &&
  killed.length === applied.length &&
  baselines.every((b) => b.fail === 0)
process.exit(ok ? 0 : 1)
