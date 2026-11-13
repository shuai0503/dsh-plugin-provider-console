import type { HttpRequestSpec, HttpResponse, Transport } from '../src/types.ts'

export interface MockTransport {
  transport: Transport
  calls: HttpRequestSpec[]
}

/** 完全离线的传输层：不触碰网络，也不接触任何真实密钥。 */
export function mockTransport(
  handler: (request: HttpRequestSpec, signal: AbortSignal) => HttpResponse | Promise<HttpResponse>,
): MockTransport {
  const calls: HttpRequestSpec[] = []
  return {
    calls,
    transport: async (request, signal) => {
      calls.push(request)
      return handler(request, signal)
    },
  }
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const text = JSON.stringify(body)
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { 'content-type': 'application/json', ...headers },
    text,
    json: body,
    elapsedMs: 12,
  }
}

export function textResponse(status: number, text: string): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers: {}, text, elapsedMs: 8 }
}

export const TEST_ENV: Record<string, string | undefined> = {
  TEST_DS_KEY: 'sk-unit-test-deepseek',
  TEST_KIMI_KEY: 'sk-unit-test-kimi',
  TEST_QWEN_KEY: 'sk-unit-test-qwen',
}
