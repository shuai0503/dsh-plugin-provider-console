/**
 * 完全离线的功能演练：不需要 DSH 宿主、不需要真实密钥、不发起任何网络请求。
 *
 *   node examples/demo.ts
 *
 * 用注入的 mock transport 模拟各家余额/调用响应，走的是与插件运行时
 * 完全相同的 BalanceService / InvocationService / 渲染链路。
 */
import type { HttpRequestSpec, HttpResponse, Transport } from '../src/types.ts'
import { createConsole } from '../src/server.ts'
import { renderAccounts, renderBalanceReport, renderInvocation, renderModels } from '../src/format.ts'

const FAKE_ENV: Record<string, string | undefined> = {
  DEMO_DS_KEY: 'sk-demo-deepseek',
  DEMO_KIMI_KEY: 'sk-demo-kimi',
  DEMO_QWEN_KEY: 'sk-demo-qwen',
  DEMO_SF_KEY: 'sk-demo-siliconflow',
}

function json(status: number, body: unknown): HttpResponse {
  const text = JSON.stringify(body)
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { 'content-type': 'application/json' },
    text,
    json: body,
    elapsedMs: 18,
  }
}

const transport: Transport = async (request: HttpRequestSpec) => {
  const url = request.url
  if (url.includes('/user/balance')) {
    return json(200, {
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '112.95', granted_balance: '10.00', topped_up_balance: '102.95' }],
    })
  }
  if (url.includes('/users/me/balance')) {
    return json(200, { code: 0, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 }, status: true })
  }
  if (url.endsWith('/models')) {
    return json(200, { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'qwen-plus' }] })
  }
  if (url.includes('/chat/completions')) {
    return json(200, {
      id: 'chatcmpl-demo',
      choices: [{ index: 0, message: { role: 'assistant', content: '你好！这是一条离线模拟回复。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 11, total_tokens: 20 },
    })
  }
  return json(404, { error: { message: `未模拟的端点 ${url}` } })
}

const consoleInstance = createConsole(
  {
    retries: 0,
    accounts: [
      { id: 'ds', provider: 'deepseek', label: 'DeepSeek 主账号', apiKeyEnv: 'DEMO_DS_KEY', lowBalanceThreshold: 20 },
      { id: 'kimi', provider: 'moonshot-cn', label: 'Kimi', apiKeyEnv: 'DEMO_KIMI_KEY' },
      // 硅基流动：官方 /user/info 已于 2026-08-14 停用，按 API Key 查不了余额，
      // 这里演示推荐的替代做法 —— 从控制台抄录后设 balancePreset=manual。
      {
        id: 'sf',
        provider: 'siliconflow',
        label: '硅基流动',
        apiKeyEnv: 'DEMO_SF_KEY',
        balancePreset: 'manual',
        manual: { total: 88.88, currency: 'CNY', note: '演示值：官方余额接口已停用，实际需从控制台抄录' },
      },
      { id: 'qwen', provider: 'dashscope', label: '通义千问', apiKeyEnv: 'DEMO_QWEN_KEY', balancePreset: 'manual', manual: { total: 66, currency: 'CNY' } },
    ],
  },
  { transport, env: FAKE_ENV, dashboard: false, log: () => undefined },
)

console.log('# 离线演练：AI 服务商账户控制台\n')
console.log(renderAccounts(consoleInstance.listAccounts(), consoleInstance.listProviders()))
console.log('\n---\n')

const report = await consoleInstance.refreshBalances({ force: true })
console.log(renderBalanceReport(report))
console.log('\n---\n')

const models = await consoleInstance.models('ds')
console.log(renderModels(models))
console.log('\n---\n')

const preview = await consoleInstance.call({
  accountId: 'ds',
  model: 'deepseek-chat',
  prompt: '你好',
  parameters: { temperature: 0.2 },
  dryRun: true,
})
console.log(renderInvocation(preview))
console.log('\n---\n')

const result = await consoleInstance.call({
  accountId: 'ds',
  model: 'deepseek-chat',
  prompt: '你好',
  parameters: { temperature: 0.2, max_tokens: 64 },
  includeRaw: true,
})
console.log(renderInvocation(result))

await consoleInstance.close()
console.log('\n演练结束：全程未联网、未使用真实密钥。')
