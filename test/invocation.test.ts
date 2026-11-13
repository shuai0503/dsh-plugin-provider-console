import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConsole, type Console } from '../src/server.ts'
import { jsonResponse, mockTransport, TEST_ENV, textResponse } from './helpers.ts'

const CHAT_RESPONSE = {
  id: 'chatcmpl-1',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: '你好，我是测试回复。', reasoning_content: '先打个招呼' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
}

function fixture(extra: Record<string, unknown> = {}) {
  let modelsStatus = 200
  const mock = mockTransport((request) => {
    if (request.url.endsWith('/models')) {
      return modelsStatus === 200
        ? jsonResponse(200, { data: [{ id: 'model-b' }, { id: 'model-a' }] })
        : jsonResponse(404, { error: { message: 'not found' } })
    }
    if (request.url.includes('/chat/completions')) return jsonResponse(200, CHAT_RESPONSE)
    return jsonResponse(404, { error: { message: 'unknown' } })
  })
  const consoleInstance = createConsole(
    {
      retries: 0,
      retryBaseMs: 1,
      accounts: [{ id: 'ds', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY', defaultModel: 'deepseek-chat' }],
      ...extra,
    },
    { transport: mock.transport, env: TEST_ENV, dashboard: false },
  )
  return { consoleInstance, mock, setModelsStatus: (status: number) => (modelsStatus = status) }
}

async function withFixture<T>(fn: (ctx: ReturnType<typeof fixture>) => Promise<T>): Promise<T> {
  const ctx = fixture()
  try {
    return await fn(ctx)
  } finally {
    await ctx.consoleInstance.close()
  }
}

test('dry-run：不联网、不读密钥，且请求头已脱敏', async () => {
  const { consoleInstance, mock } = fixture()
  try {
    const result = await consoleInstance.call({
      accountId: 'ds',
      prompt: '你好',
      parameters: { temperature: 0.2 },
      dryRun: true,
    })
    assert.equal(result.ok, true)
    assert.equal(result.dryRun, true)
    assert.equal(mock.calls.length, 0, 'dry-run 不应触发传输层')
    assert.equal(result.request?.url, 'https://api.deepseek.com/chat/completions')
    assert.equal(result.request?.headers.Authorization, '<redacted>')
    const body = result.request?.body as Record<string, unknown>
    assert.equal(body.model, 'deepseek-chat')
    assert.equal(body.temperature, 0.2)
    assert.deepEqual(body.messages, [{ role: 'user', content: '你好' }])
  } finally {
    await consoleInstance.close()
  }
})

test('通用 chat 调用：构造 OpenAI 兼容请求，提取文本/思考/用量', async () => {
  const { consoleInstance, mock } = fixture()
  try {
    const result = await consoleInstance.call({
      accountId: 'ds',
      model: 'deepseek-reasoner',
      messages: [
        { role: 'system', content: '简洁' },
        { role: 'user', content: '你好' },
      ],
      parameters: { temperature: 0.3, max_tokens: 100 },
      includeRaw: true,
    })
    assert.equal(result.ok, true)
    assert.equal(result.httpStatus, 200)
    assert.equal(result.content, '你好，我是测试回复。')
    assert.equal(result.reasoningContent, '先打个招呼')
    assert.equal(result.finishReason, 'stop')
    assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 8, totalTokens: 20 })
    assert.ok(result.raw)

    const sent = mock.calls[0]
    assert.equal(sent.method, 'POST')
    assert.equal(sent.headers?.Authorization, 'Bearer sk-unit-test-deepseek')
    const body = sent.body as Record<string, unknown>
    assert.equal(body.model, 'deepseek-reasoner')
    assert.equal((body.messages as unknown[]).length, 2)
    assert.equal(body.max_tokens, 100)
  } finally {
    await consoleInstance.close()
  }
})

test('parameters 不能悄悄覆盖显式 model / messages', async () => {
  const { consoleInstance, mock } = fixture()
  try {
    await consoleInstance.call({
      accountId: 'ds',
      model: 'deepseek-chat',
      prompt: '正确的问题',
      parameters: { model: 'evil-model', messages: 'oops' },
    })
    const body = mock.calls[0].body as Record<string, unknown>
    assert.equal(body.model, 'deepseek-chat')
    assert.deepEqual(body.messages, [{ role: 'user', content: '正确的问题' }])
  } finally {
    await consoleInstance.close()
  }
})

test('raw 模式：任意端点可用；越权主机被白名单拦下且不会发出请求', async () => {
  const { consoleInstance, mock } = fixture()
  try {
    const ok = await consoleInstance.call({ accountId: 'ds', mode: 'raw', method: 'GET', path: '/models' })
    assert.equal(ok.ok, true)
    assert.equal(ok.request?.url, 'https://api.deepseek.com/models')
    const calls = mock.calls.length

    const blocked = await consoleInstance.call({
      accountId: 'ds',
      mode: 'raw',
      path: 'https://evil.example.com/steal',
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error?.kind, 'config')
    assert.match(blocked.error?.message ?? '', /白名单/)
    assert.equal(mock.calls.length, calls, '被拦下的请求不应到达传输层')

    const insecure = await consoleInstance.call({ accountId: 'ds', mode: 'raw', path: 'http://api.deepseek.com/x' })
    assert.equal(insecure.error?.kind, 'config')
    assert.match(insecure.error?.message ?? '', /https/)
  } finally {
    await consoleInstance.close()
  }
})

test('stream：默认拒绝；allowStream=true 时聚合 SSE 片段', async () => {
  const { consoleInstance } = fixture()
  try {
    const rejected = await consoleInstance.call({
      accountId: 'ds',
      prompt: 'x',
      parameters: { stream: true },
    })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error?.kind, 'config')
    assert.match(rejected.error?.hint ?? '', /allowStream/)
  } finally {
    await consoleInstance.close()
  }

  const sse = [
    'data: {"choices":[{"delta":{"content":"你"},"index":0}]}',
    'data: {"choices":[{"delta":{"content":"好"},"index":0}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
    'data: [DONE]',
    '',
  ].join('\n')
  const streamMock = mockTransport(() => textResponse(200, sse))
  const streaming = createConsole(
    {
      retries: 0,
      allowStream: true,
      accounts: [{ id: 'ds', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY' }],
    },
    { transport: streamMock.transport, env: TEST_ENV, dashboard: false },
  )
  try {
    const result = await streaming.call({ accountId: 'ds', prompt: 'x', parameters: { stream: true } })
    assert.equal(result.ok, true)
    assert.equal(result.content, '你好')
    assert.equal(result.finishReason, 'stop')
    assert.equal(result.usage?.totalTokens, 3)
  } finally {
    await streaming.close()
  }
})

test('模型列表：实时拉取成功；/models 不可用时回退静态清单并标注来源', async () => {
  const { consoleInstance, setModelsStatus } = fixture()
  try {
    const live = await consoleInstance.models('ds')
    assert.equal(live.source, 'live')
    assert.deepEqual(live.models, ['model-a', 'model-b'])

    setModelsStatus(404)
    const fallback = await consoleInstance.models('ds', { refresh: true })
    // 拉取失败但存在上次成功结果时，保留缓存并给出告警，而不是清空列表
    assert.equal(fallback.source, 'live')
    assert.deepEqual(fallback.models, ['model-a', 'model-b'])
    assert.ok(fallback.warnings.some((w) => w.includes('在线模型列表不可用')))
  } finally {
    await consoleInstance.close()
  }
})

test('模型列表：无缓存且 /models 不可用时回退静态清单', async () => {
  const broken = mockTransport(() => jsonResponse(404, { error: { message: 'not found' } }))
  const consoleInstance = createConsole(
    {
      retries: 0,
      accounts: [{ id: 'ds', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY' }],
    },
    { transport: broken.transport, env: TEST_ENV, dashboard: false },
  )
  try {
    const result = await consoleInstance.models('ds')
    assert.equal(result.source, 'fallback')
    assert.ok(result.models.includes('deepseek-chat'))
    assert.ok(result.warnings.some((w) => w.includes('在线模型列表不可用')))
  } finally {
    await consoleInstance.close()
  }
})

test('缺密钥：真实调用返回可操作的配置错误，dry-run 仍可用', async () => {
  const noKey = createConsole(
    {
      retries: 0,
      accounts: [{ id: 'ds', provider: 'deepseek', apiKeyEnv: 'NOT_SET_ANYWHERE' }],
    },
    { transport: mockTransport(() => jsonResponse(200, CHAT_RESPONSE)).transport, env: {}, dashboard: false },
  )
  try {
    const result = await noKey.call({ accountId: 'ds', prompt: 'x' })
    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, 'config')
    assert.match(result.error?.hint ?? '', /dry-run/)

    const preview = await noKey.call({ accountId: 'ds', prompt: 'x', dryRun: true })
    assert.equal(preview.ok, true)
  } finally {
    await noKey.close()
  }
})

test('输出超长时截断并保留原始响应预览', async () => {
  const longMock = mockTransport(() =>
    jsonResponse(200, {
      choices: [{ message: { content: 'x'.repeat(500) }, finish_reason: 'stop' }],
    }),
  )
  const consoleInstance: Console = createConsole(
    {
      retries: 0,
      maxOutputChars: 64,
      accounts: [{ id: 'ds', provider: 'deepseek', apiKeyEnv: 'TEST_DS_KEY' }],
    },
    { transport: longMock.transport, env: TEST_ENV, dashboard: false },
  )
  try {
    const result = await consoleInstance.call({ accountId: 'ds', prompt: 'x', includeRaw: true })
    assert.equal(result.truncated, true)
    // maxOutputChars 下限被 clamp 到 256，截断后为 256 字符 + 省略号
    assert.ok((result.content?.length ?? 0) <= 257)
    assert.ok(result.warnings.some((w) => w.includes('截断')))
  } finally {
    await consoleInstance.close()
  }
})
