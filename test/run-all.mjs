/**
 * 基线：逐个文件跑全部测试，汇总 pass/fail。
 * 为什么不用 node --test：沙箱里 --test 的进程/管道模型会 EPERM（已踩）。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const files = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.ts')).sort()
const lines = []
let totalPass = 0
let totalFail = 0
for (const file of files) {
  const res = spawnSync(process.execPath, [join('test', file)], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const raw = `${res.stdout ?? ''}${res.stderr ?? ''}`
  // node:test 的 TAP 摘要行形如 `ℹ pass 6` / `ℹ fail 0`（GBK 控制台下会乱码，
  // 所以匹配的是 ASCII 的 "pass <n>" 而不是符号）
  const pass = Number(/\bpass (\d+)/.exec(raw)?.[1] ?? -1)
  const fail = Number(/\bfail (\d+)/.exec(raw)?.[1] ?? -1)
  const exit = res.status
  if (pass > 0) totalPass += pass
  if (fail > 0) totalFail += fail
  lines.push(`${fail === 0 && exit === 0 ? 'PASS' : 'FAIL'}  ${file.padEnd(28)} pass=${pass} fail=${fail} exit=${exit}`)
  if (fail !== 0 || exit !== 0) {
    lines.push(raw.split(/\r?\n/).filter((l) => /not ok|Error|error:/.test(l)).slice(0, 12).join('\n'))
  }
}
lines.push('-'.repeat(70))
lines.push(`TOTAL pass=${totalPass} fail=${totalFail} files=${files.length}`)
const report = lines.join('\n')
console.log(report)
process.exit(totalFail === 0 ? 0 : 1)
