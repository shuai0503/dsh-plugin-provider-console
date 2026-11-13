/**
 * 宿主依赖接缝：拿 `@deepseek-ai/dsh-tools` 的 `defineTool`。
 *
 * 与 dsh-plugin-subagent-hub 同一套解析策略：桌面版 profile 的
 * `autoInstallPeers: false` 不会安装 peer，裸 import 会在加载期
 * `ERR_MODULE_NOT_FOUND` 让整条插件不激活。逐级找宿主树，
 * 全找不到就退到本地等价实现（参数不做 JSON Schema 校验，但能力不缺失）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

export type DefineTool = (options: any) => any

export interface HostDeps {
  defineTool: DefineTool
  source: string
  notes: string[]
}

const TOOLS_PKG = 'dsh-tools'
const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

function push(list: string[], value: string | undefined | null): void {
  if (value && !list.includes(value)) list.push(value)
}

export function candidateRoots(): string[] {
  const roots: string[] = []
  push(roots, process.env.DSH_HOST_MODULES)

  const resources = (process as unknown as { resourcesPath?: string }).resourcesPath
  push(roots, resources ? join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai') : undefined)

  const exeDir = process.execPath ? dirname(process.execPath) : undefined
  push(roots, exeDir ? join(exeDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai') : undefined)
  push(roots, exeDir ? join(exeDir, '..', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai') : undefined)

  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules', '@deepseek-ai')
    push(roots, join(npm, 'dsh', 'node_modules', '@deepseek-ai'))
    push(roots, npm)
    try {
      for (const name of readdirSync(npm)) push(roots, join(npm, name, 'node_modules', '@deepseek-ai'))
    } catch {
      /* 目录不存在 */
    }
  }

  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const profile of readdirSync(join(dshHome, 'profiles'))) {
      push(roots, join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai'))
    }
  } catch {
    /* 目录不存在 */
  }

  push(roots, SELF_MODULES)
  return roots
}

function entryUrlFor(root: string, name: string): string | null {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as {
      exports?: Record<string, string | { default?: string; import?: string }>
      module?: string
      main?: string
    }
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string' ? dot : (dot?.import ?? dot?.default ?? pkg.module ?? pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch {
    return null
  }
}

async function fromHostTree(name: string, notes: string[]): Promise<unknown | null> {
  const fails: string[] = []
  for (const root of candidateRoots()) {
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      notes.push(`${name}: 从宿主树取到 ${url.replace(/^file:\/\/\//, '')}`)
      return mod
    } catch (error) {
      fails.push(`${(error as { code?: string }).code ?? 'ERR'}:${root}`)
    }
  }
  if (fails.length) notes.push(`${name}: 宿主树都不行（${fails.slice(0, 3).join(' ')}）`)
  return null
}

function fallbackDefineTool(options: any): any {
  return options
}

let cached: HostDeps | null = null

export async function loadHostDeps(): Promise<HostDeps> {
  if (cached) return cached
  const notes: string[] = []
  let mod = await fromHostTree(TOOLS_PKG, notes)
  if (!mod) {
    try {
      // 宿主包名由常量拼接，避免 TypeScript 在编译期要求该模块必须存在：
      // 这段 import 包在 try/catch 里，宿主没装时会走下面的本地等价实现。
      const toolsSpecifier: string = TOOLS_PKG
      mod = await import(toolsSpecifier)
      notes.push(`${TOOLS_PKG}: 裸 import 成功`)
    } catch (error) {
      notes.push(`${TOOLS_PKG}: 裸 import 失败（${(error as { code?: string }).code ?? ''}）`)
    }
  }
  const defineTool = (mod as { defineTool?: DefineTool } | null)?.defineTool
  if (typeof defineTool === 'function') {
    cached = { defineTool, source: 'host', notes }
    return cached
  }
  notes.push(`${TOOLS_PKG}: 使用本地等价实现`)
  cached = { defineTool: fallbackDefineTool, source: 'fallback', notes }
  return cached
}
