import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { HttpRequestSpec } from '../src/types.ts'
import {
  classifyBodyFailure,
  classifyHttpFailure,
  classifyTransportError,
  lossless,
  redact,
  retryAfterMs,
} from '../src/core/errors.ts'
import { HttpClient } from '../src/core/http.ts'
import { jsonResponse, mockTransport, textResponse } from './helpers.ts'

const req = (url = 'https://api.deepseek.com/user/balance'): HttpRequestSpec => ({ method: 'GET', url })

test('HTTP 错误分类：401 鉴权 / 429 限流 / 429 配额 / 5xx 服务端 / 4xx 客户端', () => {
  const auth = classifyHttpFailure(jsonResponse(401, { error: { message: 'Invalid API key', type: 'auth' } }))
  assert.equal(auth.kind, 'auth')
  assert.equal(auth.retryable, false)
  assert.match(auth.hint, /Key/)

  const limited = classifyHttpFailure(jsonResponse(429, { error: { message: 'rate limit exceeded' } }, { 'retry-after': '2' }))
  assert.equal(limited.kind, 'rate_limit')
  assert.equal(limited.retryable, true)

  const quota = classifyHttpFailure(jsonResponse(429, { error: { message: 'exceeded_current_quota_error' } }))
  assert.equal(quota.kind, 'quota')
  assert.equal(quota.retryable, false)

  assert.equal(classifyHttpFailure(jsonResponse(503, { message: 'busy' })).kind, 'server')
  assert.equal(classifyHttpFailure(jsonResponse(400, { message: 'bad model' })).kind, 'client')
})

test('HTTP 200 但 body 带业务错误码：智谱/Moonshot/硅基流动/OpenAI 形态', () => {
  assert.equal(classifyBodyFailure(jsonResponse(200, { code: 0, data: {} })), null)
  assert.equal(classifyBodyFailure(jsonResponse(200, { code: 200, data: {} })), null)
  assert.equal(classifyBodyFailure(jsonResponse(200, { code: 20000, data: {} })), null)
  assert.equal(classifyBodyFailure(jsonResponse(200, { code: 1000, message: '身份验证失败' }))?.kind, 'auth')
  assert.equal(classifyBodyFailure(jsonResponse(200, { code: 30014, message: '未授权' }))?.kind, 'auth')
  assert.equal(classifyBodyFailure(jsonResponse(200, { error: { code: 'insufficient_quota', message: '余额不足' } }))?.kind, 'quota')
})

test('脱敏：sk- token / Bearer / 请求头 / URL 参数都不外泄', () => {
  const raw = 'Authorization: Bearer sk-abcdef1234567890, "api_key":"sk-zzzzzzzzzz", ?api_key=sk-qqqqqqqqqq'
  const clean = redact(raw)
  assert.equal(clean.includes('sk-abcdef'), false)
  assert.equal(clean.includes('sk-zzzz'), false)
  assert.equal(clean.includes('sk-qqqq'), false)
  assert.match(clean, /\*\*\*/)
  assert.match(classifyHttpFailure(jsonResponse(401, { message: 'key sk-leaked123456 is bad' })).hint, /Key/)
  assert.equal(classifyHttpFailure(jsonResponse(401, { message: 'key sk-leaked123456 is bad' })).message.includes('sk-leaked'), false)
})

test('lossless 丢弃 undefined / NaN，保留嵌套数组与 0', () => {
  const value = lossless({ a: undefined, b: NaN, c: 0, d: [{ e: undefined, f: 1 }], g: false })
  assert.deepEqual(value, { c: 0, d: [{ f: 1 }], g: false })
})

test('Retry-After：秒数与 HTTP 日期都受上限约束', () => {
  assert.equal(retryAfterMs(jsonResponse(429, {}, { 'retry-after': '2' })), 2000)
  assert.equal(retryAfterMs(jsonResponse(429, {}, { 'retry-after': '999' }), 5000), 5000)
  assert.equal(retryAfterMs(jsonResponse(429, {})), undefined)
})

test('HttpClient：可重试错误按退避重试，认证错误立即停止', async () => {
  const flaky = mockTransport((_request, _signal) => {
    const count = flaky.calls.length
    return count < 3 ? jsonResponse(503, { message: 'busy' }) : jsonResponse(200, { ok: true })
  })
  const client = new HttpClient({ transport: flaky.transport, retries: 3, retryBaseMs: 1 })
  const response = await client.send(req())
  assert.equal(response.ok, true)
  assert.equal(flaky.calls.length, 3)

  const unauthorized = mockTransport(() => jsonResponse(401, { error: { message: 'bad key' } }))
  const client2 = new HttpClient({ transport: unauthorized.transport, retries: 3, retryBaseMs: 1 })
  await assert.rejects(() => client2.send(req()), /bad key|鉴权/)
  assert.equal(unauthorized.calls.length, 1, '401 不应重试')
})

test('HttpClient：超时可取消且归类为 timeout', async () => {
  const hanging = mockTransport(
    (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }),
  )
  const client = new HttpClient({ transport: hanging.transport, timeoutMs: 20, retries: 0 })
  await assert.rejects(async () => {
    try {
      await client.send(req())
    } catch (error) {
      assert.equal((error as { classified?: { kind?: string } }).classified?.kind, 'timeout')
      throw error
    }
  })
})

test('传输异常分类：网络错误可重试，外部取消不可重试', () => {
  const network = new TypeError('fetch failed')
  ;(network as unknown as { cause: { code: string } }).cause = { code: 'ECONNRESET' }
  assert.equal(classifyTransportError(network, { timedOut: false, externallyAborted: false }).kind, 'network')
  assert.equal(classifyTransportError(network, { timedOut: false, externallyAborted: true }).kind, 'aborted')
  assert.equal(classifyTransportError(network, { timedOut: true, externallyAborted: false }).retryable, true)
})

test('非 JSON 响应（登录页 HTML）保留脱敏片段以便诊断', () => {
  const failure = classifyHttpFailure(textResponse(401, '<html>login sk-abc123456</html>'))
  assert.equal(failure.kind, 'auth')
  assert.equal(failure.rawSnippet?.includes('sk-abc123456'), false)
})
