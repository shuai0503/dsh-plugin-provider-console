/**
 * 注入 DSH `ctx.systemPrompt.section()` 的提示词段。
 *
 * 内容与 `prompts/system.md` 正文保持一致：那份 Markdown 是给人看的文档
 * （说明如何手工粘贴），这里是运行时默认文本。宿主没有 systemPrompt 服务时
 * 完全不生效，插件其余能力不受影响。
 *
 * 注意 `interpolate: false`：文本里的 `{ "force": true }` 等示例片段必须原样
 * 保留，不能被 DSH 的 `{{variable}}` 插值器误处理。
 */
export const PROMPT_SECTION_NAME = 'provider-console:usage'
export const PROMPT_SECTION_ORDER = 9000

export const DEFAULT_PROMPT_SECTION = `## AI 服务商账户控制台 · 工具使用提示

### 何时使用

- 用户问「还剩多少钱 / 余额 / 额度 / 哪个账号快用完了」→ provider_balances
- 用户要「刷新 / 重新查 / 实时余额」→ provider_balances 且 force: true（或 action: "refresh"）
- 用户问「有哪些平台 / 账号 / key 配好了」→ provider_accounts（action: "list"）
- 用户要「用某平台的某模型跑一句话 / 测一下参数」→ 先 provider_models 确认模型名，再 provider_call
- 用户要调非 chat 端点（embeddings、rerank、/models、平台专有接口）→ provider_request
- 报「插件没生效 / 余额查不到 / 调用被拒」→ 先 provider_status 看诊断

### 约定

1. 先 dry-run 再真调：配置刚改过、模型名不确定、或用户只是想看请求长什么样时，用 provider_call / provider_request 的 dryRun: true。它不联网、不消耗额度、不回显密钥。
2. 不要编造余额：状态为「不支持」的平台没有按 API Key 查余额的接口，应如实说明并建议 balancePreset: manual 或改看配额 / 控制台；stale / 缓存 表示是旧数据。
3. 不要输出密钥：所有工具结果都已脱敏；也不要把环境变量的值写进回复或日志。
4. 区分余额与配额：zhipu 的 quota 模式显示的是 5 小时 / 周 / 月度窗口用量，不是现金余额。
5. 失败先看 hint：结果里的 error.kind + error.hint 已给出可操作建议，例如 auth 通常是国内站 / 国际站 Key 混用，quota 需要充值，parse 可能是端点改版。
6. 批量刷新有成本：provider_balances 默认读 TTL 缓存；只有用户明确要求实时才 force: true。

### 示例

provider_balances { "force": true }
provider_models   { "accountId": "ds-main" }
provider_call     { "accountId": "ds-main", "model": "deepseek-chat", "prompt": "用一句话说明你是谁", "parameters": { "temperature": 0.2 }, "dryRun": true }
provider_request  { "accountId": "kimi-cn", "method": "GET", "path": "/models" }`
