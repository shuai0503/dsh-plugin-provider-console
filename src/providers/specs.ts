/**
 * 内置服务商规格表（声明式）。
 *
 * 新增平台 = 在这里加一条 spec（必要时再加一个 mapper），不需要改
 * BalanceService / InvocationService / tools。协议差异被压缩成：
 *   base URL + 鉴权方式 + 余额探针 + 响应映射器名。
 *
 * 端点依据（2026-11 核实）：
 *  - DeepSeek   : api-docs.deepseek.com/zh-cn/api/get-user-balance
 *  - Kimi       : platform.moonshot.cn/docs/api/balance（国内 CNY / 国际 USD）
 *  - SiliconFlow: docs.siliconflow.com/cn/api-reference/userinfo/get-user-info
 *  - 百炼/通义  : help.aliyun.com 的 OpenAI 兼容模式；无按 Key 的余额接口
 *  - 智谱        : 官方文档未列余额接口，下列为控制台同源 / 历史端点，标 unreliable
 *  - 火山方舟/千帆/混元 : 余额需云账号 AK/SK 走管控面，按 Key 不可查 → unsupported
 */
import type { ProviderSpec } from '../types.ts'

const BEARER = { scheme: 'bearer' } as const

export const BUILTIN_PROVIDER_SPECS: ProviderSpec[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    site: 'cn',
    chatBaseUrl: 'https://api.deepseek.com',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    balanceBaseUrl: 'https://api.deepseek.com',
    auth: BEARER,
    defaultModels: ['deepseek-chat', 'deepseek-reasoner'],
    balance: { kind: 'money', method: 'GET', url: '/user/balance', mapper: 'deepseek' },
    docs: 'https://api-docs.deepseek.com/zh-cn/api/get-user-balance/',
    notes: '官方余额接口，返回 CNY/USD 的 total/granted/topped_up 三段。',
  },
  {
    id: 'moonshot-cn',
    label: 'Kimi / 月之暗面（国内站）',
    site: 'cn',
    chatBaseUrl: 'https://api.moonshot.cn/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    balanceBaseUrl: 'https://api.moonshot.cn',
    auth: BEARER,
    defaultModels: ['kimi-k2', 'moonshot-v1-8k', 'moonshot-v1-32k'],
    balance: { kind: 'money', method: 'GET', url: '/v1/users/me/balance', mapper: 'moonshot' },
    docs: 'https://platform.moonshot.cn/docs/api/balance',
    notes: '官方余额接口，单位 CNY；available_balance ≤ 0 时推理 API 会返回 exceeded_current_quota_error。',
  },
  {
    id: 'moonshot-global',
    label: 'Kimi / Moonshot（国际站）',
    site: 'global',
    chatBaseUrl: 'https://api.moonshot.ai/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    balanceBaseUrl: 'https://api.moonshot.ai',
    auth: BEARER,
    defaultModels: ['kimi-k2', 'moonshot-v1-8k'],
    balance: { kind: 'money', method: 'GET', url: '/v1/users/me/balance', mapper: 'moonshot' },
    docs: 'https://platform.kimi.ai/docs/api/balance',
    notes: '国际站 Key 与国内站完全独立，混用返回 401；余额单位 USD。',
  },
  {
    id: 'dashscope',
    label: '通义千问 / 阿里云百炼',
    site: 'cn',
    chatBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    auth: BEARER,
    defaultModels: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-flash'],
    balance: {
      kind: 'unsupported',
      note: '百炼没有「用 API Key 查余额」的公开接口。主账号余额需阿里云 BssOpenApi QueryAccountBalance（AK/SK + RPC 签名 + bss:DescribeAcccount 授权），本插件默认不启用；可设 balancePreset=manual 手工录入。',
    },
    docs: 'https://help.aliyun.com/zh/model-studio/getting-started/models',
    notes: '北京地域用 dashscope.aliyuncs.com；子业务空间/其它地域需用 {WorkspaceId}.<region>.maas.aliyuncs.com，可在账户 baseUrl 覆盖。',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM / BigModel',
    site: 'cn',
    chatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    chatPath: '/chat/completions',
    auth: BEARER,
    defaultModels: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    // 官方 API 参考未列余额接口；下列端点来自控制台/历史版本，全部标 unreliable，
    // 任一失败都会自动尝试下一个，全失败则回落到「不支持」而不是让整个面板报错。
    balance: {
      kind: 'money',
      method: 'GET',
      url: '/api/paas/v4/users/me/balance',
      mapper: 'zhipu-legacy',
      unreliable: true,
      note: '旧版资源接口（非官方文档），套餐账号常返回 0。',
    },
    balanceFallbacks: [
      {
        kind: 'money',
        method: 'GET',
        url: '/api/biz/account/query-customer-account-report',
        mapper: 'zhipu-report',
        unreliable: true,
        note: '控制台财务页同源端点（非官方文档），字段可能随账号类型变化。',
      },
      {
        kind: 'quota',
        method: 'GET',
        url: '/api/monitor/usage/quota/limit',
        mapper: 'zhipu-quota',
        unreliable: true,
        note: '套餐窗口用量（5 小时 / 周 / 月度工具次数），不是现金余额。',
      },
    ],
    docs: 'https://open.bigmodel.cn/',
    notes: '按量付费账号建议 balancePreset=money；GLM Coding Plan 套餐账号建议 balancePreset=quota（看到的是配额窗口而非余额）。',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    site: 'cn',
    chatBaseUrl: 'https://api.siliconflow.cn/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models?sub_type=chat',
    balanceBaseUrl: 'https://api.siliconflow.cn',
    auth: BEARER,
    defaultModels: ['Qwen/Qwen3-8B', 'deepseek-ai/DeepSeek-V3'],
    balance: { kind: 'money', method: 'GET', url: '/v1/user/info', mapper: 'siliconflow' },
    docs: 'https://docs.siliconflow.com/cn/api-reference/userinfo/get-user-info',
    notes: '官方用户信息接口含 balance（赠金）、chargeBalance（充值）、totalBalance。',
  },
  {
    id: 'volcengine',
    label: '火山方舟 / 豆包',
    site: 'cn',
    chatBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    chatPath: '/chat/completions',
    auth: BEARER,
    defaultModels: [],
    balance: {
      kind: 'unsupported',
      note: '方舟按 Key 无余额接口；套餐用量需 IAM 子用户 AK/SK 对 open.volcengineapi.com 做 HMAC 签名查询。可设 balancePreset=manual。',
    },
    notes: 'model 通常填接入点 ID（ep-xxxxxxxx）或控制台模型 ID；请在账户 models 里列明。',
  },
  {
    id: 'qianfan',
    label: '百度千帆',
    site: 'cn',
    chatBaseUrl: 'https://qianfan.baidubce.com/v2',
    chatPath: '/chat/completions',
    auth: BEARER,
    defaultModels: [],
    balance: { kind: 'unsupported', note: '千帆无按 API Key 查询余额的公开接口；可设 balancePreset=manual。' },
    notes: 'model 名与可用列表以千帆控制台为准。',
  },
  {
    id: 'hunyuan',
    label: '腾讯混元',
    site: 'cn',
    chatBaseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    chatPath: '/chat/completions',
    auth: BEARER,
    defaultModels: ['hunyuan', 'hunyuan-turbo'],
    balance: { kind: 'unsupported', note: '混元无按 API Key 查询余额的公开接口；可设 balancePreset=manual。' },
  },
]

export const BUILTIN_PROVIDER_IDS = BUILTIN_PROVIDER_SPECS.map((spec) => spec.id)
