/** 小型通用工具（无副作用、无宿主依赖）。 */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export type EnvSource = Record<string, string | undefined>

/** `${ENV_VAR}` 展开；缺失变量替换为空串，由上层判定「密钥未配置」。 */
export function expandEnv(value: string, env: EnvSource = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? '')
}

export function expandHeaders(
  headers: Record<string, string> | undefined,
  env: EnvSource,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) out[key] = expandEnv(value, env)
  return out
}

/** 拼接 base + path；path 为绝对 URL 时原样返回。 */
export function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  if (!base) return path
  const left = base.replace(/\/+$/, '')
  const right = path.startsWith('/') ? path : `/${path}`
  return `${left}${right}`
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 有并发上限的 map；不抛异常（结果由 fn 自己保证）。 */
export async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const limit = Math.max(1, Math.min(concurrency, items.length || 1))
  const workers = Array.from({ length: limit }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}
