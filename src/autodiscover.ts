/**
 * 凭证自动探测（zero-config）：从 DSH 的 credentials 接缝
 * （`ctx.credentials` 的 `resolve` / `describe`）探测已经配置好的 API Key，
 * 命中即为对应的内置服务商生成一个账户，用户不必再手写 cordis.patch.yml。
 *
 * 三条设计约束（也是与竞品的差异点）：
 *  1. **credentials 服务是可选的** —— 本模块不 import 也不声明依赖；调用方拿不到
 *     服务时传 `seam: undefined`，探测静默跳过，插件其余能力（工具 / 余额 / 看板）
 *     完全不受影响。竞品把 'credentials' 写进 inject，缺少该服务的宿主会直接加载失败。
 *  2. **密钥只进不出** —— 命中的值只交给
 *     `ConsoleRegistry.registerDiscoveredAccount()` 存进注册中心的私有表，
 *     不写进 `AccountConfig` / `ResolvedConfig`，也不出现在报告与工具输出里。
 *  3. **显式配置优先** —— 自动账户用 provider id 当账户 id；用户已经配置了同名
 *     账户时保留用户的，绝不覆盖。
 *
 * 关于 `credentialRef`：`@deepseek-ai/dsh-credentials` 的品牌函数在运行时是恒等
 * 映射（`dsh-brand` 的 `brandString` 原样返回值），而引用的合法域就是下面这个
 * POSIX shell 标识符正则。因此按 `KEY_ENV_PATTERN` 校验通过后的原始字符串就是
 * 合法的 `CredentialRef`，可以直接交给 seam —— 这样既不需要在宿主缺包时
 * 冒 `ERR_MODULE_NOT_FOUND` 的风险，也不会改变引用语义。
 */
import type { LogFn } from './types.ts'
import { BUILTIN_PROVIDER_SPECS } from './providers/specs.ts'
import type { ConsoleRegistry } from './core/registry.ts'

/**
 * 合法凭证引用名（POSIX shell 标识符），与 `dsh-credentials` 的
 * `REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/` 完全一致。
 */
export const KEY_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `ctx.credentials` 的最小形状：两个方法都可缺省，缺失的部分静默降级。 */
export interface CredentialSeam {
  resolve?(ref: string): unknown
  describe?(ref: string): unknown
}

/** 一个内置服务商的探测声明：环境变量按顺序尝试，第一个命中的生效。 */
export interface AutoDiscoverSpec {
  /** 服务商 id，同时用作自动生成账户的账户 id。 */
  provider: string
  /** 依次尝试的凭证引用名（环境变量名）。 */
  keyEnv: readonly string[]
  /** 覆盖账户 label；缺省取内置 spec 的 label。 */
  label?: string
}

/**
 * 内置探测表：9 个服务商。
 *
 * moonshot-global 先试专用的 `MOONSHOT_GLOBAL_API_KEY`，再退回国内站常用的
 * `MOONSHOT_API_KEY`（国际站与国内站 Key 互不通用，两个都可能是用户实际配置的）。
 */
export const AUTO_DISCOVER_SPECS: readonly AutoDiscoverSpec[] = [
  { provider: 'deepseek', keyEnv: ['DEEPSEEK_API_KEY'] },
  { provider: 'moonshot-cn', keyEnv: ['MOONSHOT_API_KEY'] },
  { provider: 'moonshot-global', keyEnv: ['MOONSHOT_GLOBAL_API_KEY', 'MOONSHOT_API_KEY'] },
  { provider: 'dashscope', keyEnv: ['DASHSCOPE_API_KEY'] },
  { provider: 'zhipu', keyEnv: ['ZHIPU_API_KEY'] },
  { provider: 'siliconflow', keyEnv: ['SILICONFLOW_API_KEY'] },
  { provider: 'volcengine', keyEnv: ['ARK_API_KEY'] },
  { provider: 'qianfan', keyEnv: ['QIANFAN_API_KEY'] },
  { provider: 'hunyuan', keyEnv: ['HUNYUAN_API_KEY'] },
]

/** 单个服务商的探测结论（不含密钥值）。 */
export interface ProviderProbe {
  provider: string
  label: string
  /** 命中的引用名；未命中时是首个合法候选。 */
  keyEnv: string
  configured: boolean
  /** seam 报告的来源（`file` / `env` …），便于排查，永远不是密钥本身。 */
  source?: string
  /** 跳过或降级的原因。 */
  note?: string
}

/** 一次自动探测的完整报告（可直接序列化，绝不含密钥值）。 */
export interface AutoDiscoverReport {
  enabled: boolean
  /** credentials 接缝是否可用。 */
  serviceAvailable: boolean
  /** 本次真正创建出来的账户 id。 */
  discovered: string[]
  skipped: Array<{ provider: string; reason: string }>
  providers: ProviderProbe[]
  warnings: string[]
  at: number
}

export interface AutoDiscoverOptions {
  /** `ctx.get('credentials')` 的结果；缺失/非对象时静默跳过探测。 */
  seam?: CredentialSeam
  registry: ConsoleRegistry
  /** 默认 true；false 时一次探测也不发。 */
  enabled?: boolean
  /** 视为「显式配置」的账户 id；缺省取注册中心当前全部账户。 */
  explicitIds?: Iterable<string>
  /** 覆盖探测表（测试或未来扩展用）。 */
  specs?: readonly AutoDiscoverSpec[]
  log?: LogFn
}

/** 探测结果：`value` 只在本模块内部流转，绝不进入报告。 */
export interface CredentialProbe {
  configured: boolean
  keyEnv: string
  value?: string
  source?: string
  /** 被跳过的非法引用名（不匹配 POSIX 标识符）。 */
  invalid: string[]
  note?: string
}

/** 供状态工具读取的探测状态快照。 */
export interface DiscoveryState {
  enabled: boolean
  pending: boolean
  serviceAvailable: boolean | null
  report: AutoDiscoverReport | null
  /** 首轮探测落定的 promise；未探测时为 null，工具据此不必等待。 */
  settled: Promise<AutoDiscoverReport | null>
}

export interface DiscoverySnapshot {
  enabled: boolean
  pending: boolean
  serviceAvailable: boolean | null
  discovered: number
  providers: ProviderProbe[]
  warnings: string[]
}

export function isCredentialSeam(value: unknown): value is CredentialSeam {
  if (!value || typeof value !== 'object') return false
  const bag = value as Record<string, unknown>
  return typeof bag.resolve === 'function' || typeof bag.describe === 'function'
}

/**
 * 探测一个服务商的密钥。
 *
 * `resolve` 是取值的唯一权威来源；`describe` 只用来区分「已配置但接缝不给值」
 * 这一种情况，好让报告说清楚为什么没建账户。任何一个方法抛错都只算「没探到」，
 * 绝不让调用方失败。
 */
export async function probeCredential(
  seam: CredentialSeam | undefined,
  keyEnvNames: readonly string[],
): Promise<CredentialProbe> {
  const invalid: string[] = []
  let fallbackKeyEnv = ''
  for (const keyEnv of keyEnvNames) {
    if (!KEY_ENV_PATTERN.test(keyEnv)) {
      // 非法引用名在 seam 里没有对应记录，直接跳过（也不要拿去调用）
      invalid.push(keyEnv)
      continue
    }
    if (!fallbackKeyEnv) fallbackKeyEnv = keyEnv
    const hit = await callSeam(seam, 'resolve', keyEnv)
    const value = valueOf(hit)
    if (value) return { configured: true, keyEnv, value, source: sourceOf(hit), invalid }
    const info = await callSeam(seam, 'describe', keyEnv)
    if (configuredOf(info)) {
      return {
        configured: true,
        keyEnv,
        invalid,
        note: '密钥已配置，但 credentials 接缝未返回值，无法建立账户',
      }
    }
  }
  return { configured: false, keyEnv: fallbackKeyEnv, invalid }
}

/**
 * 跑一轮自动探测并注册命中的账户。
 *
 * 单账户失败只记 warning，不影响其它服务商，也不会让插件加载失败。
 */
export async function runAutoDiscover(options: AutoDiscoverOptions): Promise<AutoDiscoverReport> {
  const { registry } = options
  const enabled = options.enabled !== false
  const specs = options.specs ?? AUTO_DISCOVER_SPECS
  const seam = isCredentialSeam(options.seam) ? options.seam : undefined
  const serviceAvailable = seam !== undefined
  const report: AutoDiscoverReport = {
    enabled,
    serviceAvailable,
    discovered: [],
    skipped: [],
    providers: [],
    warnings: [],
    at: Date.now(),
  }

  if (!enabled) {
    report.warnings.push('autoDiscover=false：未探测任何凭证。')
    options.log?.('凭证自动探测已关闭（autoDiscover=false）')
    return report
  }

  const explicit = new Set<string>(options.explicitIds ?? registry.listAccounts().map((item) => item.id))

  for (const spec of specs) {
    const label = spec.label ?? labelOf(spec.provider)
    const probe = await probeCredential(seam, spec.keyEnv)
    const entry: ProviderProbe = {
      provider: spec.provider,
      label,
      keyEnv: probe.keyEnv || spec.keyEnv[0] || '',
      configured: probe.configured,
      source: probe.source,
    }
    if (probe.invalid.length) {
      entry.note = `跳过非法引用名：${probe.invalid.join(', ')}`
      report.warnings.push(
        `${spec.provider}：跳过非法凭证引用名 ${probe.invalid.join(', ')}（需匹配 ${KEY_ENV_PATTERN}）`,
      )
    }
    if (probe.note) entry.note = entry.note ? `${entry.note}；${probe.note}` : probe.note
    report.providers.push(entry)

    if (!probe.configured || !probe.value) {
      if (probe.note) report.warnings.push(`${spec.provider}：${probe.note}`)
      continue
    }
    if (!serviceAvailable) {
      report.skipped.push({ provider: spec.provider, reason: 'credentials 服务不可用' })
      continue
    }
    if (explicit.has(spec.provider)) {
      const reason = '已由用户显式配置，显式配置优先'
      report.skipped.push({ provider: spec.provider, reason })
      entry.note = entry.note ? `${entry.note}；${reason}` : reason
      continue
    }
    if (!registry.hasProvider(spec.provider)) {
      const reason = '服务商未注册（可能 includeBuiltinProviders=false）'
      report.skipped.push({ provider: spec.provider, reason })
      entry.note = entry.note ? `${entry.note}；${reason}` : reason
      continue
    }
    try {
      const result = registry.registerDiscoveredAccount(
        { id: spec.provider, provider: spec.provider, label, apiKeyEnv: entry.keyEnv },
        probe.value,
      )
      if (result === 'skipped') {
        // 注册中心发现了同名显式账户（竞态或运行时注册）；不覆盖，如实记一条
        const reason = '已由用户显式配置，显式配置优先'
        report.skipped.push({ provider: spec.provider, reason })
        entry.note = entry.note ? `${entry.note}；${reason}` : reason
        continue
      }
      report.discovered.push(spec.provider)
      options.log?.(
        `凭证自动探测：${spec.provider} 已配置（${entry.keyEnv}），${result === 'created' ? '已生成账户' : '已更新账户'}`,
      )
    } catch (error) {
      const reason = (error as Error).message
      report.skipped.push({ provider: spec.provider, reason })
      report.warnings.push(`${spec.provider}：自动账户注册失败（${reason}）`)
      options.log?.(`凭证自动探测：${spec.provider} 注册失败: ${reason}`)
    }
  }

  if (!serviceAvailable) {
    report.warnings.push(
      '宿主未提供 credentials 服务（ctx.get("credentials") 为空），已跳过自动探测；其余能力不受影响。',
    )
    options.log?.('宿主未提供 credentials 服务，跳过凭证自动探测（其余能力不受影响）')
  } else {
    options.log?.(`凭证自动探测完成：命中 ${report.discovered.length} 个服务商`)
  }
  return report
}

/** 把运行态状态收敛成状态工具能直接渲染的快照。 */
export function snapshotOf(state: DiscoveryState): DiscoverySnapshot {
  const report = state.report
  return {
    enabled: state.enabled,
    pending: state.pending,
    serviceAvailable: state.serviceAvailable,
    discovered: report?.discovered.length ?? 0,
    providers: report?.providers ?? [],
    warnings: report?.warnings ?? [],
  }
}

function labelOf(provider: string): string {
  return BUILTIN_PROVIDER_SPECS.find((spec) => spec.id === provider)?.label ?? provider
}

async function callSeam(
  seam: CredentialSeam | undefined,
  method: 'resolve' | 'describe',
  keyEnv: string,
): Promise<unknown> {
  const fn = seam?.[method]
  if (typeof fn !== 'function') return undefined
  try {
    return await fn.call(seam, keyEnv)
  } catch {
    // seam 抛错（未就绪 / 存储损坏）只意味着「这个引用探不到」，不能影响探测流程
    return undefined
  }
}

function valueOf(hit: unknown): string {
  if (typeof hit === 'string') return hit.trim()
  if (hit && typeof hit === 'object') {
    const value = (hit as Record<string, unknown>).value
    if (typeof value === 'string') return value.trim()
  }
  return ''
}

function sourceOf(hit: unknown): string | undefined {
  if (hit && typeof hit === 'object') {
    const source = (hit as Record<string, unknown>).source
    if (typeof source === 'string') return source
  }
  return undefined
}

function configuredOf(info: unknown): boolean {
  if (!info || typeof info !== 'object') return false
  return (info as Record<string, unknown>).configured === true
}
