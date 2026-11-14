# dsh-plugin-provider-console

**DeepSeek Harness 服务商控制台插件** —— 用 DSH 里**已经存好的那把 API Key**，按账户身份查看余额、调用任意端点，并把各家模型接进对话框的模型选择器。

> Provider console for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): check balances, debug endpoints, and register model routes — all reusing the credentials DSH already stores.

**和通用 HTTP 客户端的区别**：别的工具要你把 Key 再贴一遍；这里只按 `accountId` 从宿主的凭据服务解析，
`/models`、`/chat/completions`、`/embeddings`、`/user/balance`、任意专有路径共用同一把已存 Key、同一 baseUrl、同一协议。

- **API 调试台**（设置页 / 左侧栏）：选账户 → 选方法与路径 → 填 JSON body → **先看请求预览（dryRun）** → 确认后再发送 → 看状态码、耗时、响应体
- **对话框里选模型**：已配置的服务商自动注册为模型 provider，在 DSH 的模型选择器里直接选
- 多账户余额查询：DeepSeek、Kimi（国内/国际）走官方余额接口，实时读数
- 套餐配额查询：智谱 GLM Coding Plan 按 5 小时 / 周 / 月窗口显示用量
- 没有余额接口的平台不编造数字，明确标「不支持」并给出替代方案
- 通用调用：`chat/completions`、`/models`、embeddings、任意专有端点
- 本地实时看板（只绑 `127.0.0.1`）+ 左侧栏入口 + 设置页分区
- **完全跟随宿主外观**：颜色一律取自宿主 `--dsw-*` token，亮/暗主题自动切换
- 零运行时依赖：只用 Node 内置模块

## 安装

```bash
dsh plugin --profile <你的profile> add dsh-plugin-provider-console
```

装完重启 DSH 即可。

## 零配置：自动识别已配置的服务商

**大多数用户不需要写任何配置。**

如果你的 DSH 已经配过某个服务商的 API Key（`DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` /
`ZHIPU_API_KEY` / `DASHSCOPE_API_KEY` / `SILICONFLOW_API_KEY` 等），插件启动时会自动探测到，
直接生成对应账户。装完就能问「我还剩多少钱」。

设计上刻意注意了三点：

- **探测行为说明** —— 首轮对每个服务商调用一次 `ctx.credentials.resolve()`（与 DSH 自身调用等价），
  取到的值**只存在于注册中心的内存私有表**里，不落盘、不进配置文件、不进日志；
  `listAccounts()`、工具输出、诊断报告一律只见 `hasApiKey` 布尔值
- **不会发任何网络请求** —— 探测只问 DSH 的凭据服务，不碰外部接口
- **按需降级** —— 宿主没有凭据服务时静默跳过，其余功能完全不受影响（`credentials` 不是硬依赖）

配置项：

```yaml
config:
  autoDiscover: true          # 默认 true，设为 false 可完全关闭自动探测
  autoDiscoverProviders: []   # 可选，只探测点名的服务商，如 [deepseek, zhipu]
```

探测结果可以随时问模型：「运行 `provider_status`」，它会告诉你开关状态、探测到几个、
以及每个服务商是「已配置」还是「未配置」。

> **顺序很重要**：你显式配置的账户**永远优先**。自动探测遇到同名账户会跳过，一个字节都不改。

## 手动配置（需要多账户或自定义时）

自动探测只覆盖「一个服务商一个账户」的常见情况。要管理多个账户、自定义 label、
设置预警阈值时，再在 profile 的 `cordis.patch.yml` 里挂载：

```yaml
- insert:
    - id: provider-console
      name: dsh-plugin-provider-console
      config:
        accounts:
          - id: ds-main
            provider: deepseek
            label: DeepSeek 主账号
            apiKeyEnv: DEEPSEEK_API_KEY
            defaultModel: deepseek-chat
            lowBalanceThreshold: 20
```

**密钥放在哪里（按推荐顺序）：**

1. **推荐：DSH 设置页 → 模型 / 凭据，填一次。** 值会写进 `~/.dsh/.credentials.yaml` 的 `refs:` 下，
   自动探测读的就是这里，配完立即生效，无需重启。

2. 也可以直接在账户里引用环境变量：

   ```yaml
   apiKey: "${DEEPSEEK_API_KEY}"
   ```

3. **环境变量（有坑，最后选）**：把变量设到**系统/用户环境变量**里，然后**重启 DSH 应用**。

   > ⚠️ DSH 桌面版是 Electron 进程，只继承启动它时的环境变量。
   > **在另一个 PowerShell 窗口里 `export` 对已经运行的 DSH 完全无效**——
   > 这是最常见的「我明明设了却提示没有 Key」的原因。

配置落点写清楚之后，验证只有三步：

1. 重启 DSH
2. 打开左侧栏「服务商控制台」——**看到账户表就是生效了**
3. 看不到就跑一次 `provider_status`，把输出贴上来排查

也可以把账户写成 JSON 文件放进 `accountsDir` 目录批量管理，见 [`examples/accounts.json`](./examples/accounts.json)。

## 支持的平台

| provider id | 平台 | 余额能力 |
| --- | --- | --- |
| `deepseek` | DeepSeek | 官方接口 · ¥/$ 余额 |
| `moonshot-cn` | Kimi / 月之暗面（国内） | 官方接口 · ¥ 余额 |
| `moonshot-global` | Kimi / Moonshot（国际） | 官方接口 · $ 余额 |
| `siliconflow` | 硅基流动 | 无按 Key 余额接口（官方已于 2026-08-14 停用 `/user/info`） |
| `zhipu` | 智谱 GLM / BigModel | 非官方端点（best-effort），支持套餐配额 |
| `dashscope` | 通义千问 / 阿里云百炼 | 无按 Key 余额接口 |
| `volcengine` | 火山方舟 / 豆包 | 无按 Key 余额接口 |
| `qianfan` | 百度千帆 | 无按 Key 余额接口 |
| `hunyuan` | 腾讯混元 | 无按 Key 余额接口 |
| 自定义 | 任意 OpenAI 兼容端点 | 声明式 `balanceMap` 或 `unsupported` |

**关于「无余额接口」的诚实处理**：百炼主账号余额要走阿里云 `BssOpenApi`（AK/SK + RPC 签名 + RAM 授权），
火山方舟用量要做 IAM HMAC 签名——这些都不是「拿 API Key 就能查」。硅基流动则是另一种情况：
原本官方提供了 `/user/info`，但平台已公告该端点自 **2026-08-14** 起停用，替代接口尚未公布。
插件不会猜测未核实过的端点，而是明确标注「不支持」，并给出两种替代：`balancePreset: manual` 手工录入、
`balancePreset: quota` 看配额窗口。

> ⚠️ 硅基流动的**对话调用不受影响**——`chatBaseUrl` / `modelsPath` 照常可用，只是余额看不了。
> 停用公告见 [Release Notes 2026.08.11](https://docs.siliconflow.com/cn/release-notes/overview)：
> "This API will be officially retired on **August 14, 2026 (Friday)** and will no longer be available thereafter."
> 注意其 API Reference 页面目前仍列着该端点，属文档滞后，以 Release Notes 为准。

国内站与国际站 Key 不通用（Kimi、Z.AI 皆然），所以拆成独立 provider id，避免 401 被误判成余额问题。

## API 调试台

在**设置页「服务商控制台」**或**左侧栏面板**里切到「调试台」标签，可以不动命令行就调试任意端点：

1. **选账户** —— 下拉只列已配置密钥的账户
2. **填请求** —— 方法（GET/POST/PUT/PATCH/DELETE）+ 路径（如 `/models`、`/embeddings`、`/chat/completions`）
3. **Headers / Body** —— 可增删 header 行；Body 是 JSON 编辑器，格式非法会实时报错并禁用「发送」
4. **预览请求** —— 点「预览」走 `dryRun`，显示即将发出的完整请求（**密钥已脱敏**），不发任何网络数据
5. **发送** —— 真实请求后显示状态码、耗时、响应体大小与格式化后的响应；可折叠、可复制
6. **错误可读** —— 401 / 403 / 超时 / 白名单拒绝 / 网络断开各给一条可操作的建议

内置快捷模板：`GET /models`、`POST /embeddings`、`POST /chat/completions`、`GET /user/balance`。

**安全边界**：
- 路径默认只接受相对该账户 baseUrl 的路径；绝对 URL 需显式允许且仍受白名单约束
- 非 `https` 的绝对 URL、路径穿越（`..`）、白名单外主机一律拒绝
- 同源路由带 Host / Origin / `sec-fetch-site` 校验，防止任意网页诱导本机发起付费调用
- 调试请求默认 `retries: 0`，避免重复点「发送」造成多次计费
- 响应、日志、错误信息**永不回显密钥明文**

## 模型可见的工具

| 工具 | 作用 |
| --- | --- |
| `provider_balances` | 查询/刷新全部或指定账户余额，输出 Markdown 表格 + 合计 + 预警 |
| `provider_accounts` | 列出账户与服务商、运行时增删启停、重读凭据 |
| `provider_models` | 拉取在线模型列表，失败回退静态清单并标注来源 |
| `provider_call` | 通用 `chat/completions` 调用，支持 `dryRun` |
| `provider_request` | 任意 method/path/body（embeddings、rerank、专有端点） |
| `provider_status` | 插件诊断：白名单、缓存/重试配置、配置警告 |

`provider_balances` 的输出示例：

```
## 账户余额（2026/11/6 01:58:08）
| 账户 | 服务商 | 状态 | 余额 / 配额 | 构成 | 更新于 |
| DeepSeek 主账号 | deepseek | 实时 | ¥112.95 | 赠金 ¥10.00 / 充值 ¥102.95 | 01:58:08 |
| 通义千问 | dashscope | 手工 | ¥66.00 | — | 01:58:08 |
合计：¥317.42（4 个账户）
实时 3 · 缓存 0 · 失败 0 · 不支持 0 · 手工 1
```

## 界面与主题

插件在宿主界面里占三个位置，**全部只使用宿主的 `--dsw-*` 设计 token**，不写死任何
颜色，因此亮色 / 暗色主题自动跟随，不需要额外配置：

| 位置 | 注册的 slot | 说明 |
|---|---|---|
| 左侧栏图标 | `sidebar.panellist`（list，需要 `id`） | 图标 + 标签，`sidebar.enabled/label/order` 可配 |
| 中央面板 | `main`（keyed，需要 `key`） | 工具条 + 内嵌本地看板 iframe |
| 设置页分区 | `settings.section` + `settings.section.icon`（list，需要 `id`） | 只读展示当前配置 + 复制 YAML 片段 |

主题判定只有一个来源：`document.body[data-ds-dark-theme]`。DSH 的「跟随系统」
已经由宿主的 ThemePresenter 解析成这个属性，所以插件**不读** `prefers-color-scheme`
—— 否则用户在设置里手动选的主题会被系统偏好覆盖。

看板 iframe 与宿主不同源（8788 vs 65110），拿不到宿主的样式表，因此主题通过
`postMessage` 传递：client.js 用 `getComputedStyle` 读出 token 的计算值推给 iframe，
iframe 自己 `setProperty` 到 `:root`。iframe 侧不接受 `--dsw-*` 以外的变量名。

**设置页是只读的。** 它展示 9 个关键开关的当前生效值，并提供「复制 YAML 片段」按钮。
插件不会替你写配置文件 —— 写回 YAML 会破坏注释、且会与插件管理器的写入互相覆盖，
风险高于收益。改配置请复制片段后粘到自己的 profile 里，宿主会热重载。

## 安全设计

- **密钥不出本机**：只从环境变量或宿主凭据服务读取，配置树上不落明文，工具输出一律脱敏
- **自动探测只问存在性**：首轮只用 `describe` 判断「配没配」，不取值；密钥在首次查询余额时才经 `resolve` 读取
- **密钥不进配置对象**：自动探测到的密钥只存在注册中心的私有表里，不写入 `AccountConfig` / `ResolvedConfig`，
  不出现在报告、日志或任何工具返回值中
- **不硬依赖宿主服务**：`credentials` 走 `ctx.get()` 可选获取，宿主没有该服务时静默降级，插件照常加载
- **浏览器半端不碰密钥**：左侧栏面板只是 iframe 壳，数据全部由宿主的本地看板页面提供
- **看板只绑 `127.0.0.1`**：不监听外网接口
- **配置快照走白名单**：`/api/state` 里的 `config` 由 `publicConfig()` 逐个字段挑选，
  不直接把 `ResolvedConfig` 序列化出去（`test/dashboard.test.ts` 用真实 HTTP 断言这一条）
- **出站主机白名单**：`raw` 模式和自定义 `baseUrl` 受白名单约束，默认自动并入已配置账户的端点
- **重试有边界**：只有网络错误 / 5xx / 限流会重试；401 / 402 / 解析错误立即失败，不会把鉴权失败刷成噪音

## 开发

```bash
npm run build      # tsc -p tsconfig.build.json（src → lib，**先编译再测试**）
npm run typecheck  # tsc --noEmit（含 test/）
node test/<file>.test.ts   # 逐个文件跑；不要用 node --test（沙箱禁止管道 stdio）
node test/mutation.ts      # 变异测试：12 条变异必须全部让测试变红
```

测试分三层：

- `test/tokens.test.ts` —— **token 存在性守卫**。把宿主真实发布的 token 名单固化在
  `test/tokens.fixture.json`，逐个断言插件引用的每个 `--dsw-*` 都真的存在。
  这是 0.3.0「亮色主题下永远黑底白字」那类 bug 的专用防线。
- `test/client-entry.test.ts` / `test/render.test.ts` —— 浏览器半端。用 `vm` 沙箱执行
  `client.js` 验证 slot 注册、主题判定、postMessage，并把渲染出的 DOM 结构落到
  `test/render-evidence/` 供人工核对。
- `test/mutation.ts` —— 往源码注入真实缺陷，确认测试会变红（而不是只看「全绿」）。
  每条变异先打印替换匹配次数，匹配数不是 1 就判为「变异未生效」。

源码是 TypeScript。开发时可用 Node 原生类型剥离直接跑 `src/`（`node >= 22.18`），
**但作为包被加载时走 `lib/`，所以改动后必须 `npm run build`**（`lib/` 已 gitignore，未构建的 checkout 无法被 import）。

```
src/
  index.ts          Cordis 入口，装配与卸载
  server.ts         Console 门面
  tools.ts          6 个模型可见工具
  config.ts         配置解析与校验
  dashboard.ts      本地看板（HTTP + 页面 + 脱敏配置快照）
  core/             余额、调用、注册中心、HTTP 重试、错误语义
  providers/        各平台协议适配（spec + mapper）
client.js           浏览器半端（slot 注册、主面板、设置页、主题桥）
public/index.html   看板页面（token 映射、卡片列表、进度条）
test/tokens.fixture.json   宿主 token 名单快照
```

宿主接缝全部是可选降级：`ctx.tools` 不存在时仍能通过 `ctx.get('providerConsole')` 使用编程 API。

## License

MIT
