/**
 * 服务商适配器层。
 *
 * `SpecAdapter` 是唯一的内置实现：它把「声明式 spec」翻译成 HTTP 请求，
 * 再交给 mapper 归一化响应。第三方插件若遇到非 OpenAI 兼容 / 需要签名
 * 的平台，可直接实现 `ProviderAdapter` 并调用 registry.registerProvider()
 * 覆盖同名 spec —— 上层完全不感知差异。
 */
import type {
  AccountConfig,
  BalancePayload,
  BalanceProbeSpec,
  CustomProviderSpec,
  HttpRequestSpec,
  HttpResponse,
  ProviderAdapter,
  ProviderSpec,
  ResolvedAccount,
} from '../types.ts'
import { configError, parseError } from '../core/errors.ts'
import { expandEnv, expandHeaders, joinUrl, originOf, type EnvSource } from '../core/util.ts'
import { getMapper, mapperNames, parseModelList, registerMapper, type BalanceMapper } from './mappers.ts'
import { BUILTIN_PROVIDER_SPECS } from './specs.ts'

export { BUILTIN_PROVIDER_SPECS, BUILTIN_PROVIDER_IDS } from './specs.ts'
export { getMapper, mapperNames, registerMapper, parseModelList, toNumber, at } from './mappers.ts'
export type { BalanceMapper } from './mappers.ts'

export function authHeaders(account: ResolvedAccount): Record<string, string> {
  if (!account.apiKey) return {}
  const { scheme, header, prefix } = account.auth
  if (scheme === 'header') return header ? { [header]: `${prefix ?? ''}${account.apiKey}` } : {}
  if (scheme === 'raw') return { Authorization: account.apiKey }
  return { Authorization: `Bearer ${account.apiKey}` }
}

/** 由声明式 spec 构造的通用适配器。 */
export class SpecAdapter implements ProviderAdapter {
  readonly spec: ProviderSpec
  private readonly env: EnvSource

  constructor(spec: ProviderSpec, env: EnvSource = process.env) {
    this.spec = spec
    this.env = env
  }

  balanceRequests(account: ResolvedAccount): HttpRequestSpec[] {
    const preset = account.balancePreset
    if (preset === 'manual' || preset === 'unsupported') return []
    const probes = [this.spec.balance, ...(this.spec.balanceFallbacks ?? [])].filter(Boolean)
    const selected =
      preset === 'money'
        ? probes.filter((probe) => probe.kind === 'money')
        : preset === 'quota'
          ? probes.filter((probe) => probe.kind === 'quota')
          : probes.filter((probe) => probe.kind !== 'unsupported' && probe.kind !== 'manual')

    const requests: HttpRequestSpec[] = []
    for (const probe of selected) {
      const request = this.toBalanceRequest(probe, account)
      if (request) requests.push(request)
    }
    return requests
  }

  private toBalanceRequest(probe: BalanceProbeSpec, account: ResolvedAccount): HttpRequestSpec | null {
    if (!probe.url) return null
    const url = /^https?:\/\//i.test(probe.url)
      ? expandEnv(probe.url, this.env)
      : joinUrl(account.balanceBaseUrl, expandEnv(probe.url, this.env))
    return {
      method: probe.method ?? 'GET',
      url,
      headers: {
        ...authHeaders(account),
        ...expandHeaders(this.spec.headers, this.env),
        ...expandHeaders(probe.headers, this.env),
      },
      purpose: `余额查询 · ${this.spec.label} · ${probe.mapper ?? 'unknown'}`,
      balanceProbe: probe,
    }
  }

  parseBalance(
    response: HttpResponse,
    account: ResolvedAccount,
    request: HttpRequestSpec,
  ): BalancePayload {
    const probe = request.balanceProbe
    const mapper = getMapper(probe?.mapper)
    if (!mapper) {
      throw parseError(
        `未注册的余额映射器 "${probe?.mapper ?? ''}"，可用：${mapperNames().join(', ')}`,
        response,
      )
    }
    const payload = mapper({ response, account, spec: this.spec, request })
    if (probe?.unreliable && !payload.note) payload.note = '非官方端点，结果仅供参考。'
    if (probe?.note && payload.note && !payload.note.includes(probe.note)) {
      payload.note = `${payload.note} ${probe.note}`
    }
    return payload
  }

  parseModels(response: HttpResponse): string[] {
    return parseModelList(response)
  }
}

/** 把配置里的自定义 provider JSON 编译成完整 spec。 */
export function compileCustomProvider(raw: CustomProviderSpec, env: EnvSource = process.env): ProviderSpec {
  if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) {
    throw configError('自定义服务商缺少 id')
  }
  if (!raw.chatBaseUrl) {
    throw configError(`自定义服务商 "${raw.id}" 缺少 chatBaseUrl`)
  }
  const chatBaseUrl = expandEnv(raw.chatBaseUrl, env)
  const balance: BalanceProbeSpec = {
    kind: 'unsupported',
    ...(raw.balance ?? {}),
    note: raw.balance?.note ?? '自定义服务商未声明余额探针；可设 balancePreset=manual。',
  }
  if (balance.kind === 'money' || balance.kind === 'quota') {
    balance.mapper ??= 'jsonPath'
  }
  return {
    id: raw.id.trim(),
    label: raw.label ?? raw.id,
    site: 'custom',
    chatBaseUrl,
    chatPath: raw.chatPath ?? '/chat/completions',
    modelsPath: raw.modelsPath ?? '/models',
    balanceBaseUrl: expandEnv(raw.balanceBaseUrl ?? '', env) || originOf(chatBaseUrl),
    auth: raw.auth ?? { scheme: 'bearer' },
    defaultModels: raw.defaultModels ?? [],
    balance,
    balanceFallbacks: raw.balanceFallbacks,
    quotaProbe: raw.quotaProbe,
    balanceMap: raw.balanceMap,
    headers: raw.headers,
    notes: raw.notes,
    docs: raw.docs,
  }
}

export function builtinAdapters(env: EnvSource = process.env): ProviderAdapter[] {
  return BUILTIN_PROVIDER_SPECS.map((spec) => new SpecAdapter(spec, env))
}

/** 账户实际可用的 chat / balance URL（用于主机白名单推导）。 */
export function providerUrls(spec: ProviderSpec): string[] {
  const urls = [spec.chatBaseUrl, spec.balanceBaseUrl ?? '']
  for (const probe of [spec.balance, ...(spec.balanceFallbacks ?? []), spec.quotaProbe]) {
    if (probe?.url && /^https?:\/\//i.test(probe.url)) urls.push(probe.url)
  }
  return urls.filter(Boolean)
}

export type { AccountConfig }
