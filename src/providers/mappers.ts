/**
 * 余额响应映射器：把各家千奇百怪的 JSON 归一成 BalancePayload。
 *
 * 映射器是「可插拔字典」：registerMapper('xxx', fn) 即可给自定义服务商
 * 加一种解析规则，无需改动任何核心类。数值统一走 toNumber()，兼容
 * 字符串金额（DeepSeek/SiliconFlow 返回 string）与数值金额（Kimi 返回 number）。
 */
import type {
  BalanceMapSpec,
  BalancePayload,
  HttpResponse,
  ProviderSpec,
  QuotaWindow,
  ResolvedAccount,
  HttpRequestSpec,
} from '../types.ts'
import { parseError } from '../core/errors.ts'

export interface MapperContext {
  response: HttpResponse
  account: ResolvedAccount
  spec: ProviderSpec
  request: HttpRequestSpec
}

export type BalanceMapper = (context: MapperContext) => BalancePayload

const MAPPERS = new Map<string, BalanceMapper>()

export function registerMapper(name: string, mapper: BalanceMapper): () => void {
  MAPPERS.set(name, mapper)
  return () => {
    if (MAPPERS.get(name) === mapper) MAPPERS.delete(name)
  }
}

export function getMapper(name: string | undefined): BalanceMapper | undefined {
  return name ? MAPPERS.get(name) : undefined
}

export function mapperNames(): string[] {
  return [...MAPPERS.keys()].sort()
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function at(root: unknown, path: string | undefined): unknown {
  if (!path) return undefined
  let current: unknown = root
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(part)
      current = Number.isInteger(index) ? current[index] : undefined
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return current
}

function bodyOf(ctx: MapperContext): unknown {
  return ctx.response.json
}

function requireObject(value: unknown, ctx: MapperContext, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw parseError(`${label} 缺失或格式异常`, ctx.response)
  }
  return value as Record<string, unknown>
}

function noteFromProbe(ctx: MapperContext): string | undefined {
  const probe = ctx.request.balanceProbe
  if (!probe) return undefined
  const prefix = probe.unreliable ? '非官方端点 · ' : ''
  return probe.note ? `${prefix}${probe.note}` : undefined
}

// ---------------------------------------------------------------------------
// 各平台映射器
// ---------------------------------------------------------------------------

/** DeepSeek: { is_available, balance_infos:[{currency,total_balance,granted_balance,topped_up_balance}] } */
registerMapper('deepseek', (ctx) => {
  const root = requireObject(bodyOf(ctx), ctx, 'DeepSeek 余额响应')
  const infos = root.balance_infos
  if (!Array.isArray(infos) || infos.length === 0) {
    throw parseError('DeepSeek 响应缺少 balance_infos', ctx.response)
  }
  const info = (infos.find((item) => (item as Record<string, unknown>).currency === 'CNY') ?? infos[0]) as Record<string, unknown>
  const total = toNumber(info.total_balance)
  if (total === undefined) throw parseError('DeepSeek total_balance 无法解析', ctx.response)
  const breakdown: Record<string, number> = {}
  const granted = toNumber(info.granted_balance)
  const toppedUp = toNumber(info.topped_up_balance)
  if (granted !== undefined) breakdown['赠金'] = granted
  if (toppedUp !== undefined) breakdown['充值'] = toppedUp
  return {
    currency: typeof info.currency === 'string' ? info.currency : 'CNY',
    total,
    breakdown,
    available: root.is_available === true ? true : total > 0,
    note: noteFromProbe(ctx),
  }
})

/** Moonshot / Kimi: { code:0, data:{available_balance,voucher_balance,cash_balance}, status:true } */
registerMapper('moonshot', (ctx) => {
  const root = requireObject(bodyOf(ctx), ctx, 'Kimi 余额响应')
  const data = requireObject(root.data, ctx, 'Kimi data')
  const total = toNumber(data.available_balance)
  if (total === undefined) throw parseError('Kimi available_balance 无法解析', ctx.response)
  const breakdown: Record<string, number> = {}
  const voucher = toNumber(data.voucher_balance)
  const cash = toNumber(data.cash_balance)
  if (voucher !== undefined) breakdown['代金券'] = voucher
  if (cash !== undefined) breakdown['现金'] = cash
  const warnings: string[] = []
  if (total <= 0) warnings.push('可用余额 ≤ 0，推理 API 将返回 exceeded_current_quota_error。')
  if (cash !== undefined && cash < 0) warnings.push('现金余额为负（欠费），当前可用额度仅来自代金券。')
  return {
    currency: ctx.spec.site === 'global' ? 'USD' : 'CNY',
    total,
    breakdown,
    available: total > 0,
    warnings,
    note: noteFromProbe(ctx),
  }
})

/**
 * @deprecated 硅基流动的 `/user/info` 已于 2026-08-14 停用（官方 Release Notes
 * `[API Service Adjustment] /user/info Endpoint Deprecation`），替代余额接口尚未公布，
 * 因此内置的 `siliconflow` spec 已改为 `balance.kind = 'unsupported'`，**不会再构造
 * 该端点的请求**，这个 mapper 在默认配置下不会被调用。
 *
 * 之所以保留而不是删除：字段形状（`data.balance` / `chargeBalance` / `totalBalance`）
 * 是官方历史契约，若将来公布替代接口且字段沿用，或用户把自定义 provider 的
 * `balance.mapper` 显式设为 `siliconflow` 指向自建代理，仍然可用。
 * 若官方公布新接口且字段不同，应新增一个 mapper 而不是改这个。
 *
 * SiliconFlow: { code:20000, data:{balance,chargeBalance,totalBalance,...} }
 */
registerMapper('siliconflow', (ctx) => {
  const root = requireObject(bodyOf(ctx), ctx, '硅基流动响应')
  const data = requireObject(root.data, ctx, '硅基流动 data')
  const granted = toNumber(data.balance)
  const toppedUp = toNumber(data.chargeBalance)
  const total = toNumber(data.totalBalance) ?? (granted !== undefined && toppedUp !== undefined ? granted + toppedUp : undefined)
  if (total === undefined) throw parseError('硅基流动 totalBalance 无法解析', ctx.response)
  const breakdown: Record<string, number> = {}
  if (granted !== undefined) breakdown['赠金'] = granted
  if (toppedUp !== undefined) breakdown['充值'] = toppedUp
  return {
    currency: 'CNY',
    total,
    breakdown,
    available: total > 0,
    note: noteFromProbe(ctx) ?? '硅基流动 /user/info 已于 2026-08-14 停用，本结果来自自定义端点，仅供参考。',
    warnings: ['硅基流动官方余额接口已停用（2026-08-14），此映射仅在自定义 provider 显式指定时使用。'],
  }
})

/** 智谱旧版资源接口: { balanceInfo:{balance,giftBalance,voucherBalance,usedTokens} } */
registerMapper('zhipu-legacy', (ctx) => {
  const root = requireObject(bodyOf(ctx), ctx, '智谱余额响应')
  const info = requireObject(root.balanceInfo, ctx, '智谱 balanceInfo')
  const parts = [toNumber(info.balance), toNumber(info.giftBalance), toNumber(info.voucherBalance)]
  if (parts.every((value) => value === undefined)) throw parseError('智谱 balanceInfo 无可用金额字段', ctx.response)
  const breakdown: Record<string, number> = {}
  const labels = ['现金', '赠金', '代金券']
  parts.forEach((value, index) => {
    if (value !== undefined) breakdown[labels[index]] = value
  })
  return {
    currency: 'CNY',
    total: parts.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    breakdown,
    available: parts.reduce<number>((sum, value) => sum + (value ?? 0), 0) > 0,
    note: noteFromProbe(ctx),
    warnings: ['旧版接口，套餐账号常返回 0；如数值异常请改 balancePreset=quota。'],
  }
})

/** 智谱控制台财务同源: { code:200, data:{balance,rechargeAmount,giveAmount,totalSpendAmount} } */
registerMapper('zhipu-report', (ctx) => {
  const root = requireObject(bodyOf(ctx), ctx, '智谱账户报告响应')
  const data = requireObject(root.data, ctx, '智谱账户报告 data')
  const total = toNumber(data.balance)
  if (total === undefined) throw parseError('智谱账户报告 balance 无法解析', ctx.response)
  const breakdown: Record<string, number> = {}
  for (const [label, key] of [
    ['累计充值', 'rechargeAmount'],
    ['赠金', 'giveAmount'],
    ['累计消费', 'totalSpendAmount'],
  ] as const) {
    const value = toNumber(data[key])
    if (value !== undefined) breakdown[label] = value
  }
  return { currency: 'CNY', total, breakdown, available: total > 0, note: noteFromProbe(ctx) }
})

/** 智谱套餐配额: { data:{limits:[{type,unit,usage,currentValue,remaining,percentage,nextResetTime}]} } */
registerMapper('zhipu-quota', (ctx) => {
  const root = requireObject(bodyOf(ctx), ctx, '智谱配额响应')
  const data = requireObject(root.data, ctx, '智谱配额 data')
  const limits = data.limits
  if (!Array.isArray(limits) || limits.length === 0) {
    throw parseError('智谱配额 limits 为空（普通 API Key 查套餐时常见），请改 balancePreset=money 或 manual', ctx.response)
  }
  const quotas: QuotaWindow[] = limits.map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>
    const type = typeof item.type === 'string' ? item.type : 'LIMIT'
    const unit = toNumber(item.unit)
    const name = unit === 3 ? '5 小时窗口' : unit === 6 ? '本周窗口' : type === 'TIME_LIMIT' ? '月度工具' : type
    const used = toNumber(item.currentValue)
    const limit = toNumber(item.usage)
    const remaining = toNumber(item.remaining) ?? (used !== undefined && limit !== undefined ? limit - used : undefined)
    const usedPercent =
      toNumber(item.percentage) ??
      (used !== undefined && limit !== undefined && limit > 0 ? Math.round((used / limit) * 100) : undefined)
    return {
      name,
      used,
      limit,
      remaining,
      usedPercent,
      resetAt: toNumber(item.nextResetTime),
      unit: type === 'TIME_LIMIT' ? '次' : 'TOKENS/CREDITS',
    }
  })
  return {
    quotas,
    note: noteFromProbe(ctx) ?? '套餐窗口用量，非现金余额。',
    warnings: ['显示的是套餐配额窗口，不是账户现金余额。'],
  }
})

/**
 * 声明式映射：自定义服务商在 JSON 里用点路径指定字段，无需写代码。
 * 例：{ "total": "data.balance", "currency": "data.currency" }
 */
registerMapper('jsonPath', (ctx) => {
  const map: BalanceMapSpec = ctx.spec.balanceMap ?? {}
  const root = bodyOf(ctx)
  const payload: BalancePayload = { note: noteFromProbe(ctx) }
  payload.total = toNumber(at(root, map.total))
  payload.currency = typeof at(root, map.currency) === 'string' ? (at(root, map.currency) as string) : undefined
  payload.available = map.available ? Boolean(at(root, map.available)) : payload.total === undefined ? undefined : payload.total > 0
  if (payload.total === undefined && !map.quotas) {
    throw parseError('自定义映射未取到 total（检查 balanceMap.total 的点路径）', ctx.response)
  }
  if (map.breakdown) {
    const breakdown: Record<string, number> = {}
    for (const [label, path] of Object.entries(map.breakdown)) {
      const value = toNumber(at(root, path))
      if (value !== undefined) breakdown[label] = value
    }
    if (Object.keys(breakdown).length) payload.breakdown = breakdown
  }
  if (map.granted || map.toppedUp) {
    payload.breakdown ??= {}
    const granted = toNumber(at(root, map.granted))
    const toppedUp = toNumber(at(root, map.toppedUp))
    if (granted !== undefined) payload.breakdown['赠金'] = granted
    if (toppedUp !== undefined) payload.breakdown['充值'] = toppedUp
  }
  if (map.quotas) {
    const list = at(root, map.quotas)
    if (Array.isArray(list)) {
      payload.quotas = list.map((raw, index) => {
        const item = (raw ?? {}) as Record<string, unknown>
        return {
          name: typeof item.name === 'string' ? item.name : `窗口 ${index + 1}`,
          used: toNumber(item.used ?? item.currentValue),
          limit: toNumber(item.limit ?? item.usage),
          remaining: toNumber(item.remaining),
          usedPercent: toNumber(item.percentage),
          resetAt: toNumber(item.nextResetTime),
        }
      })
    }
  }
  return payload
})

/** 通用模型列表解析（OpenAI 兼容 / SiliconFlow / 部分平台）。 */
export function parseModelList(response: HttpResponse): string[] {
  const root = response.json
  const list = Array.isArray(root) ? root : at(root, 'data') ?? at(root, 'models')
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    if (typeof item === 'string') out.push(item)
    else if (item && typeof item === 'object') {
      const id = (item as Record<string, unknown>).id ?? (item as Record<string, unknown>).name
      if (typeof id === 'string') out.push(id)
    }
  }
  return [...new Set(out)].sort()
}
