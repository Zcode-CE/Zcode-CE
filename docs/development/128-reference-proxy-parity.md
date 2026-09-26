# 参考反代 vs CE：必须复刻的机制清单与适配结论

- 调查人：r3-reference-parity（独立核实，未照抄 Lead 假设链）
- 日期：2026-09-25
- 范围：只读调查，未改动任何源码（本文件是唯一写入）
- 参考实现：`.reverse/07-reference/zcode-api/`（= 用户指明目录；v4.6.8）
  与 `/home/sixiao/软件/zcode-proxy/zcode-api`（v4.5.2 + git 历史，master = `a4e56c6`）

## 开工前读过的既有材料（及一致性声明）

| 材料                                                          | 结论是否一致                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 根 `AGENTS.md`「能力来源与取舍」                              | 一致：外部能力按来源分三类，搬载荷必须走许可登记；本报告 §4 据此判定       |
| `docs/development/126-start-plan-3007-root-cause.md`          | **大部分一致，但有一处事实错误**，见下方「订正」                           |
| `third-party/README.md`、`third-party/copied-components.json` | 一致：逐字节搬运需登记 id/revision/source/sha256/license                   |
| `.reverse/08-entitlement/00-签名协议还原-Lead.md`             | 一致：CE 对 Client Request Signing V4 与 `proxyEndpoint` 动态映射均 0 命中 |
| 参考实现源码（本次逐文件读）                                  | —（本报告的原始证据来源）                                                  |

> **订正 126 的一处事实错误（我复核出的，非照抄）**
> 126 §1 写「start-plan 的模型请求经 ZCode 平台网关 `zcode.z.ai/api/v1/ultra*` 转发」——**不成立**。
> 证据：官方 bundle `zcode.cjs` @710631 的端点构造器里，
> `zcodePlanAnthropicBaseUrl: \`${origin}/api/v1/zcode-plan/anthropic\``；
CE 自己的内置 provider 目录 `config/provider/zcode-builtin.json:747`、`:810`给`account:zai-start-plan`/`account:bigmodel-start-plan`的 baseUrl 同样是`https://zcode.z.ai/api/v1/zcode-plan/anthropic`。
> `/api/v1/ultra[-zai]/` 是 **coding-plan（individual/team）** 的重写目标，不是 start-plan 的路径。
> 126 §2.9 的结论（opencode 不经该网关）不受影响，但它对「哪条路径带风控」的表述需要按本节改写。
> 本报告 §3 给出完整路径关系。

---

## 1. 结论：参考项目没有 3007 的真实原因

**参考项目不是「碰巧没问题」，而是它把「每个 start-plan 模型请求都必须自带一枚新鲜验证码 token」当成硬前提来满足 —— 这正是 CE 完全没做的那件事。**

参考实现里，`startPlan` 分支在**每一次**上游模型请求之前都主动取一枚已验证 token 并作为
`x-aliyun-captcha-verify-param`(+ `-region`) 发出（`src/proxy/handler.ts:138,169-182`；
`/v1/responses` 路径同样，`src/proxy/responses-handler.ts:195-206`），token 由**进程内**
happy-dom 求解器预先铸好放在池子里（`src/proxy/captcha.ts:57-64`、`src/proxy/captcha-pool.ts`），
并且额外做了「万一仍被挑战 → 重新求解 + 重试一次」的兜底（`src/proxy/captcha-retry.ts:61-119`）。
CE 则相反：模型请求链路上**没有任何验证码头来源**，host 在收到 runtime-headers 请求时对
start-plan 也直接短路自答（`packages/services/src/zcode-agent/zcodeAgentService.ts:2266`），
于是请求**必然**不带 token 发出，网关**必然**回 3007。

**「使用方式不同」这一半也成立，但它解释的是「为什么参考项目能那样修」，而不是「为什么它没坏」。**
参考项目是一个**独立 Bun 进程反代**（`package.json` 的 `dev/start = bun run src/index.ts`、
`build = bun build --compile`，依赖只有 happy-dom/undici/yaml），没有 Electron、没有渲染层，
所以它**别无选择**只能把求解器塞进进程内（`src/proxy/captcha-solver.ts:10-20` 明确写「fully in-process,
self-contained … No external Node.js, no browser」）。CE 是 Electron 应用，
**本可以走官方那条「渲染层求解 → host 合并 → agent 重试」的路**，
但它连这条路的**接线**都不存在（§2 M2/M6/M8）。两句话的关系是：
**「CE 缺的是必要机制」是主因；「参考项目是无渲染层的独立进程」只决定了它给出的是无头解，而不是 CE 该照抄的形态。**

---

## 2. 机制对照表

> 判定口径：**已实现** = CE 有等价能力且被接上；**部分实现** = 有零件但没接线/不完整；**完全缺失** = 全仓零命中。
> 「必须复刻」= 缺了它 start-plan 就一定 3007；「形态可不同」= 机制必要但实现方式不必照抄。

| #   | 机制                           | 参考项目行为 + 行号                                                                                                                                                                        | CE 现状 + 行号                                                                                                                                                                                                                                        | 是否必须复刻               | 理由                                                                                                           |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| M1  | start-plan 上游 URL + 鉴权方式 | `src/proxy/upstream.ts:44,80-88`：固定 `https://zcode.z.ai/api/v1/zcode-plan` + `/anthropic/v1/messages`；`:114-147` start-plan 用 `Authorization: Bearer {jwt}`（无 `x-api-key`）         | **已实现**：`config/provider/zcode-builtin.json:735,747,798,810` baseUrl = `https://zcode.z.ai/api/v1/zcode-plan/anthropic`；JWT 由 `packages/services/src/model-provider/accountProviderRequestAuthService.ts:73-76` 提供                            | 否（已一致）               | 路径与鉴权与官方一致，不是差异点                                                                               |
| M2  | **模型请求注入验证码头**       | `src/proxy/handler.ts:169-182`：`if (startPlan)` → `getCaptchaToken()` → `captchaHeaders` 并入上游头；`src/proxy/responses-handler.ts:195-206` 同                                          | **完全缺失**：模型请求链路无 captcha 概念。`grep -rn 'captcha' apps/zcode-cli/packages/{adapters,core,bootstrap}/src` → 0 命中；host 的 `respondAccountRequestAuthWithoutInteraction`（`zcodeAgentService.ts:1266-1308`）只回 `requestAuth:{apiKey}`  | **必须**                   | 这是 3007 的直接成因                                                                                           |
| M3  | claim 平面注入验证码头         | `src/claim/client.ts:196-210`：claim 带 `X-Aliyun-Captcha-Verify-Param`(+Region)；`src/claim/runtime.ts:111-112`                                                                           | **已实现**：`packages/services/src/coding-plan-subscription/manualClaimPlanClient.ts:36-37,168-169`                                                                                                                                                   | 否（已一致）               | claim 平面 CE 已有，与本次症状无关                                                                             |
| M4  | 验证码配置拉取 + 60s 快照      | `src/proxy/captcha.ts:28-30,41-50`：`GET https://zcode.z.ai/api/v1/client/configs`，缓存 60s                                                                                               | **已实现**：`packages/services/src/coding-plan-subscription/manualClaimCaptcha.ts:30-33,83-92`（同路径、同 TTL）                                                                                                                                      | 否（已一致，可直接复用）   | 配置面 CE 已有现成实现                                                                                         |
| M5  | 求解器形态                     | `src/proxy/captcha-solver.ts:10-20` + `src/proxy/captcha-happy.ts:1-25`：进程内 happy-dom + pe-VM 补丁，2451 行                                                                            | **部分实现（另一形态）**：`packages/ui/src/settings/manualClaimCaptchaPage.ts`（宿主页 + 注入脚本）+ `ManualClaimCaptchaDialog.tsx`（Electron `<webview>`）；**但只服务 claim**                                                                       | 机制必须，形态不必照抄     | 见 §4：参考实现**无许可文件，不可搬**；CE 走真实 webview 是唯一合规且体验一致的形态                            |
| M6  | **3007 检测（响应头变体）**    | `src/proxy/captcha.ts:35-38` `detectCaptchaChallenge`（读响应头）；`captcha-retry.ts:61-67` 统一入口                                                                                       | **完全缺失**：`grep -rn 'aliyun' apps packages --include=*.ts` 在模型链路 0 命中（仅 claim 平面命中）                                                                                                                                                 | **必须**                   | 无检测就不会重试                                                                                               |
| M7  | **3007 检测（in-body 变体）**  | `src/proxy/captcha-retry.ts:25-28,45-58`：HTTP 400 + body `{"code":3007}`（含空格变体、gzip 嗅探），64KB 上限、读 clone 不消费原体                                                         | **完全缺失**：CE 只在 `failure-provider-business-codes.ts:100-107` 把 3007 归成 `AuthFailed/retryable:false`；`model-execution.ts:445-472` 会解析业务码但**只用于报错分类，不用于重试**                                                               | **必须**                   | 用户命中的正是这一变体（126 §2.6 已证）                                                                        |
| M8  | **挑战后重新求解 + 重试一次**  | `src/proxy/captcha-retry.ts:96-119`：cancel 旧体 → `getCaptchaToken()` 取**下一枚** token → 重建头/请求 → 重发**一次**（绝不循环）；`handler.ts:323-355` 调用点                            | **完全缺失**：`grep -rn 'CaptchaRequestRetry\|isCaptchaRejection\|captcha-retry' apps packages --include=*.ts --include=*.tsx` → 0 命中；`runner-runtime.ts:33` / `contracts/src/model/invocation-context.ts:35` 的 `reason?: "model-request"` 是单值 | **必须**                   | 兜底路径；也是官方 `CaptchaRequestRetry` 的等价物                                                              |
| M9  | 3007 的语义分类                | 参考实现把 3007 当「可自愈的挑战」（`captcha-retry.ts`）                                                                                                                                   | **错误分类**：`failure-provider-business-codes.ts:100-107` → `AuthFailed` + `retryable:false`；`workflow-model-failure-policy.ts:86` → `stop/auth`                                                                                                    | **必须修正**               | 即便补了 M6-M8，分类不改仍会被 `stop` 截断                                                                     |
| M10 | 端点重写（动态 mapping）       | `src/proxy/endpoint-routing.ts:18-23,105-122,139-187`：`GET {origin}/api/v1/agent/configs` → `data.proxyEndpoint.mapping`，精确 URL 匹配重写，TTL 300s / 失败冷却 30s / **严格 fail-open** | **完全缺失**（动态部分）：`grep -rn 'proxyEndpoint\|agent/configs' apps packages --include=*.ts` → 0 命中；CE 只有**硬编码**表 `official-coding-plan-gateway.ts:22-31`                                                                                | **不是本次成因**，但需评估 | 见 §3：硬编码表**不覆盖** start-plan，所以不冲突；但它会静默漂移                                               |
| M11 | Client Request Signing V4      | `src/proxy/client-signing.ts:56-60`（免签名白名单含 `/api/v1/zcode-plan/anthropic/v1/messages`）、`:225-234`、`:560-580`（两次 401 后 bypass）                                             | **完全缺失**：`grep -rn 'x-client-sig\|clientSigning\|ClientRequestSigning' apps packages --include=*.ts` → 0 命中（与 `.reverse/08-entitlement/00-签名协议还原-Lead.md` 一致）                                                                       | **待定，非本次成因**       | 参考实现自己把 start-plan 路径列进**免签名**白名单 ⇒ 说明 start-plan 不需要签名。CE 走 start-plan 时同样不需要 |
| M12 | 求解串行化 / 合并 / 取消       | 参考实现：token 池 + `captcha-pool.ts` 的 take/refill/race；官方渲染层：`jnn` 串行队列 + `m3` map 合并同 requestId + `Bnn` 取消                                                            | **完全缺失**：CE host 有 pending map 与取消（`zcodeAgentService.ts:1105-1109,1866-1881`），但**没有求解器可被排队**                                                                                                                                   | **必须**（若走 UI 求解）   | 高频请求下会并发生成多个 webview 挑战                                                                          |
| M13 | 预求解 / 预热                  | `src/index.ts:187-192`：start-plan 启动时后台 `startCaptchaPool()` 预热；官方渲染层 `Ynn` useEffect + `Nnn`→`ann` 在页面可见时预热 SDK（`styles-DEELZGp2.js` @4186241 / @4172932）         | **完全缺失**                                                                                                                                                                                                                                          | **建议**（非必须）         | 只影响首请求延迟，不影响正确性                                                                                 |

---

## 3. 路径关系澄清：`zcode-plan/anthropic` vs `ultra[-zai]`

两条路径是**两个不同的套餐面**，不是同一件事的两种写法：

| 路径                                                         | 归属                                                 | 证据                                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` | **start-plan（含领取到的体验套餐）**                 | 官方 bundle `zcode.cjs` @710631 `zcodePlanAnthropicBaseUrl`；CE `config/provider/zcode-builtin.json:747,810` |
| `https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages`      | **bigmodel individual/team coding-plan**（重写目标） | CE `official-coding-plan-gateway.ts:24-25`；参考实现 `endpoint-routing.test.ts:8`                            |
| `https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages`  | **zai individual/team coding-plan**（重写目标）      | CE `official-coding-plan-gateway.ts:28-29`                                                                   |

**重写关系**：`https://api.z.ai/api/anthropic/v1/messages` → `ultra-zai`；
`https://open.bigmodel.cn/api/anthropic/v1/messages` → `ultra`。
CE 的内置目录给 `account:zai-{individual,team}-coding-plan` 的 baseUrl 是 `https://api.z.ai/api/anthropic`
（`:705,726`），给 `account:bigmodel-{individual,team}-coding-plan` 是 `https://open.bigmodel.cn/api/anthropic`
（`:768,789`）—— 正好是硬编码表的两个 key。

**CE 硬编码表会不会与官方行为冲突？——对 start-plan 不会，对 coding-plan 是「等价但静态」。**

- start-plan 的 provider endpoint（`zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`）**不在**
  `OFFICIAL_CODING_PLAN_GATEWAY_ROUTES` 的两个 key 里（`official-coding-plan-gateway.ts:46-51` 的
  `endpointKey` 是 protocol+host+port+path 精确匹配，`:61-64` 未命中即原样返回）
  ⇒ **start-plan 请求不会被 CE 重写**，与官方一致。
- coding-plan 面：官方是「`/api/v1/agent/configs` 下发 mapping、客户端按表重写、fail-open」
  （`zcode.cjs` @4062645 的 `b6s`/`PVr`/`RVr`/`S6s`；参考实现 `endpoint-routing.ts`），
  CE 是「源码里写死两条」。**当前两者结果相同**（都把 provider 端点指向 ultra），
  但**服务端一旦改表（新增/改向/下线），CE 会静默走错端点**，而官方与参考实现会自动跟随。
  这是 M10 的真实风险，**与本次 3007 无关**，但值得单列为一个后续项。

---

## 4. 许可与可行性判定

### 4.1 参考项目的许可状态（已核实）

| 检查项                           | 结果                                                                    | 命令                                                                               |
| -------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 仓库根 `LICENSE*`                | **不存在**                                                              | `ls LICENSE* ` → 无此文件                                                          |
| `package.json` 的 `license` 字段 | **不存在**（`undefined`）                                               | `node -e 'console.log(require("./package.json").license)'`                         |
| README 的 License 段             | 只有一行 `MIT`（`README.md:240-242`），**无版权行、无年份、无著作权人** | `grep -n -A3 '^## License' README.md`                                              |
| git 历史里是否曾有过 LICENSE     | **从未添加过**                                                          | `git log --all --diff-filter=A --name-only -- LICENSE LICENSE.md LICENSE.txt` → 空 |

### 4.2 判定

**结论：参考项目的验证码求解器（`captcha-happy.ts` 等）不可搬运。**

理由：仓库级许可声明缺失 —— 只有 README 里一行无著作权人的 `MIT` 字样，
按本项目 `third-party/README.md` §3 的证据档位，这属于 `incomplete-unverified`（**阻断**），
不满足 `publisher-declared-standard-terms` 的四条判据（至少缺 (c)「版权主体已发布」：
既无 `package.json` 的 author/license，也无许可文本里的 Copyright 行）。
即便强行搬，也无法完成「逐字节搬运 → 许可登记 → 差异文档」的既有流程，
因为登记表 `third-party/copied-components.json` 的必填项 `license` / `source` / `referenceRevision`
没有可核实的来源。

**并且：CE 也不应该搬。** 参考实现走的是「无头自动化求解」，它自己在
`captcha-happy.ts:1-16` 写明这是「对抗 pe 版本轮换」的补丁栈；
而 CE 是**用户正在操作的 Electron 应用**，本就有真实渲染层。
CE 侧已有的 `manualClaimCaptchaPage.ts` 头注释（`:1-30`）已经把这个判断写清楚：

> 「CE 不引入 happy-dom，走真实 webview + 真实用户交互 —— 这同时也是风控期望的形态（自动求解才是在和风控对抗）。」

**⇒ 走官方路径（渲染层求解 → host 合并 → agent 重试）是唯一既合规、又与官方体验一致的方案。**
它**不需要**任何外部许可登记，因为复用的是 CE 自己已有的代码（`manualClaimCaptchaPage.ts` /
`ManualClaimCaptchaDialog.tsx` / `manualClaimCaptcha.ts`）与官方形态（不是官方代码，是形态）。

### 4.3 现有可复用资产盘点（CE 自有，无许可问题）

| 资产                                                                                                            | 位置                                                                          | 可复用性                                                                       |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 宿主页 HTML + `data:` URL 构造（纯函数）                                                                        | `packages/ui/src/settings/manualClaimCaptchaPage.ts:92-118`                   | **可直接复用**                                                                 |
| 求解注入脚本（纯函数，含 `AliyunCaptchaConfig`→`initAliyunCaptcha`→`getInstance`→`startTracelessVerification`） | 同文件 `:184-252`                                                             | **可直接复用**                                                                 |
| verifyParam 归一化（4 种 SDK 回调形态 + ≥200 字符下限）                                                         | 同文件 `:164,261-310`                                                         | **可直接复用**                                                                 |
| 结果解析 / 失败阶段枚举（`sdk_load`/`init`/`start`/`verify`/`timeout`/`unsupported`）                           | 同文件 `:55-72,314-371`                                                       | **可直接复用**                                                                 |
| webview 能力探测                                                                                                | 同文件 `:365-371`                                                             | 可复用                                                                         |
| 配置拉取 + 60s 快照 + 稳定错误码                                                                                | `packages/services/src/coding-plan-subscription/manualClaimCaptcha.ts:77-149` | **可直接复用**（但它挂在 subscription service 上，模型请求链路要另取一份入口） |
| 对话框组件（webview 生命周期、dom-ready 轮询、重试 key、卸载清理）                                              | `packages/ui/src/settings/ManualClaimCaptchaDialog.tsx:84-304`                | **不可直接复用**，见 §5                                                        |

---

## 5. 建议的修复形态

### 5.0 先回答 Lead 的可行性问题：CE 现有求解器能否被模型请求路径复用？

**分三层回答，结论是「脚本层能、组件层不能、缺的是服务层」：**

**(a) 求解脚本本身：能，而且是「无痕优先」的。**
`buildManualClaimCaptchaSolveScript`（`manualClaimCaptchaPage.ts:184-248`）在 `getInstance` 回调里调用
`instance.startTracelessVerification || instance.show`，且用 `mode:'popup'`。
这正是官方的 `auto` 档语义（`allowInteractive !== false`、`preferInteractive !== true` ⇒ `attemptKind='auto'`，
见官方 `styles-DEELZGp2.js` @4167043 的 `let r=t.allowInteractive!==!1,i=t.preferInteractive===!0,…f=i?'interactive':r?'auto':'traceless'`）。
所以**「无痕优先、必要时才弹窗」这个语义 CE 已经有了**，不需要重写脚本。
CE 的测试也把这一点钉住了：`packages/ui/test/manualClaimCaptcha.test.ts:123-126` 断言脚本必须含
`startTracelessVerification`。

**(b) 但 CE 少了官方的「无痕不响应 → 主动转交互」兜底。**
官方在 traceless 分支挂了一个 8s 定时器：若 traceless 到点没有响应且允许交互，
就主动 `buttonElement.click()` 把挑战弹出来（`styles-DEELZGp2.js` @4167043 附近，
常量 `Vtn=8e3`，@4153518）。CE 的脚本只有 `success`/`fail`/`onError` 三个出口 + 一个总超时
（`ManualClaimCaptchaDialog.tsx:67` `SOLVE_TIMEOUT_MS = 180_000`），
**traceless 若静默挂住，用户会干等 180 秒**。这是复用前必须补的一处。

**(c) 组件层不能复用，因为它把「求解」绑死在「用户点领取按钮」这个上下文里。**
`ManualClaimCaptchaDialog` 的形态是：`open` 由调用方控制（`ManualClaimPlanCard.tsx:200`）、
`onSolved` 把结果交给调用方去 claim、失败就显示「重试」按钮、关闭即卸载 webview（`:231-236`）。
它**没有**：请求队列、按 session/provider 的合并、取消传播、可见/隐藏切换、
以及「求解结果直接回给某个等待中的协议请求」这条出口。
模型请求路径需要的是「一个常驻、可被高频调用、必要时才可见的求解服务」，
这与「一个模态对话框」是两种组件。

**⇒ 因此不是「小改接线」，但也远不到「重写求解器」：**
需要**新写一个可复用的求解服务 + 一层 webview 宿主**（脚本与配置面全部复用），
再补协议接线。规模判断：**中等**（新增 1 个服务 + 1 个常驻宿主组件 + 协议 2 处扩展 + host 守卫 1 处 + agent 重试与分类）。

### 5.1 方案 A（推荐）：官方三段式，最小可用闭环

严格对齐官方形态，分三段：

**① 渲染层（新增可复用求解服务）**

- 从 `manualClaimCaptchaPage.ts` 复用宿主页/脚本/归一化（纯函数，零改动）。
- 新增一个常驻的「验证码会话宿主」组件：一个**挂在 DOM 上但默认不可见**的 `<webview>`，
  加载 `buildManualClaimCaptchaHostPageUrl()`；启动即 `prewarm`（只初始化 SDK，不求解）。
- 收到求解请求 → 复用官方 `jnn` 的**串行队列**语义（同 providerId 串行），
  并发同 requestId 走**合并**；求解期间若需要交互，把宿主**提升为可见浮层**（用户手动完成）。
- 补 `Vtn` 等价的 8s「无痕不响应 → 触发交互」兜底。
- 结果按 `{headersApplied:true, runtimeProviderHeaders:{...}}` 回传。

**② host 侧（`packages/services/src/zcode-agent/zcodeAgentService.ts`）**

- 收紧守卫：把 `:2266` 的 `if (accountRequestAuthService && accountAccess)`
  改为 **非 start-plan 才短路**（官方守卫是 `Ze.mode !== "start-plan"`，
  `asar-out/out/host/index.js` @316421），start-plan 走转发。
- 新增转发：`emitSessionEvent(workspace, sessionId, { type: "providerRuntimeHeaders.request", request })`
  （CE 目前**没有**这个 session event 类型，需在 `packages/shared/src/zcode-protocol/index.ts`
  的事件表 `:1456-1480` 增加，或在既有 envelope 体系里新增一类）。
- 新增应答入口：渲染层回传后，把 `runtimeProviderHeaders` 中**大小写不敏感**匹配
  `X-Aliyun-Captcha-Verify-Param`/`-Region` 的项并入 `requestAuth.headers`
  （官方 `respondProviderRuntimeHeaders`，@357166）。
- 保留既有的取消通道 `providerRuntimeHeadersCancelled`（`:1866-1881`）与 pending map。

**③ agent 侧（`apps/zcode-cli/packages/adapters/src/model/`）**

- `runner-runtime.ts:33` / `contracts/src/model/invocation-context.ts:35` 的 reason 类型加 `"captcha-retry"`。
- 新增 `isCaptchaRejection`（`providerCode === "3007"`）与单次 `CaptchaRequestRetry` 语义：
  命中且未用过 → `extraAttempts + 1`、下一轮以 `reason:"captcha-retry"` 重新调
  `refreshRuntimeHeadersBeforeAttempt`（官方 `$0e`，`zcode.cjs` @4013457；调用点 @4026183 / @4041111）。
- 分类修正：`failure-provider-business-codes.ts:100-107` 的 3007 不应是 `AuthFailed + retryable:false`；
  `workflow-model-failure-policy.ts:86` 的 `AuthFailed → stop` 不应截断验证码重试；
  同步 `packages/ui/src/lib/chatErrorAttributionEvidence.ts` 的 `"3007": "auth_failed"` 与
  `packages/ui/src/lib/providerBusinessError.ts` 的 `"3007": null`。
- 协议响应 schema：`packages/shared/src/zcode-protocol/index.ts:2424-2447` 的
  `headersApplied:true` 分支增加可选 `runtimeProviderHeaders`（两分支都是 `.strict()`，不加会被 zod 拒）；
  `:2395` 的 reason 枚举加 `"captcha-retry"`。

**成本**：新增 1 个求解服务 + 1 个常驻宿主组件；改动 `zcodeAgentService.ts`（守卫 + 合并 + 转发）、
协议 schema 3 处、adapter 重试循环与分类 4 处、UI 归因 2 处。预计是本轮里最大的一块。
**风险**：

1. **无渲染层场景会退化**：Web 版 / 手机远控 / Bot channel 没有 Electron `webview`
   （`isManualClaimCaptchaWebviewSupported` `:365-371` 返回 false）。
   官方在桌面端永远有渲染层，CE 没有 —— 这些场景必须在**短时间内失败并给出明确文案**，
   绝不能变成 `:16` 的 180s 超时（126 §6.2 已把这条列为「最容易踩的坑」）。
2. 常驻 webview 的资源占用与后台节流（CE 主窗口已开 `webviewTag: true`，
   `desktopWindowChrome.ts:587`；`data:` 在允许协议集合内，`:42-48`，宿主页 URL 无需改白名单）。
3. 高频模型请求下的求解排队延迟会直接叠加到首 token 时间上。

### 5.2 方案 B：先只做「可自愈的 3007 重试」，验证码来源后补

只做 M6/M7/M8/M9（检测 + 单次重试 + 分类修正），先不动渲染层与 host 守卫。
**成本**：最小（adapter 内部 + 分类表 + 归因）。
**风险**：**没有 token 来源，重试一次仍然会 3007**，只是把「必然失败」变成「失败两次」。
除非同时补上 ①（渲染层）或一个 token 来源，否则这个方案**单独不解决问题**。
它的价值是：作为方案 A 的**第③段先行落地**，让 A 的其余部分有可验证的骨架。

### 5.3 方案 C（不推荐）：进程内无头求解器

把参考项目的 `captcha-happy.ts` 搬进 CE（或自研一份等价物）。
**成本**：极高（2451 行 + happy-dom 内部结构依赖 + 持续对抗 pe 版本轮换）。
**风险**：

1. **许可阻断**：参考项目无许可文件，`third-party/README.md` §3 判为 `incomplete-unverified`（阻断发布）；
2. **与用户拍板方向相反**：用户明确要求「验证码由用户手动完成」；
3. **产品面不一致**：CE 是用户正在操作的 GUI，自动求解与官方体验背离。

### 5.4 推荐

**推荐方案 A，并按「③ → ①/② 并行」的顺序落地：**
先做 ③（agent 侧重试骨架 + 分类修正，即方案 B 的内容，可独立测试），
再做 ①+②（渲染层求解服务 + host 守卫与合并），最后打开端到端。

理由：③ 是纯 adapter 内部改动，可用单测钉住「3007 → 重试一次 → 仍失败则按业务错误上报」，
不依赖 UI；①+② 是跨进程接线，需要真实 Electron 环境验证。
把两者分开，可以让「补了重试但还没 token 来源」这个中间态是**可测且可回滚**的。

**同时必须处理的一个决定**：无渲染层场景（Web / 远控 / Bot）在 start-plan 下如何收口。
建议：**快速失败 + 明确文案**（沿用 `captcha_unavailable` 这类稳定错误码，不用文案匹配），
并在该场景下不尝试求解 —— 而不是留一个必然超时的挂起请求。

---

## 6. 仍未验证的部分与风险

### 6.1 未验证（诚实标注）

1. **线上 `proxyEndpoint.mapping` 的实际内容未取到。**
   我只读到参考实现测试夹具里的 `from = https://api.z.ai/api/anthropic/v1/messages`
   （`endpoint-routing.test.ts:7-8`）与 CE 硬编码表的两个 key。
   **未验证**：线上表是否还包含 `zcode-plan/anthropic` 这类条目。
   如果包含，参考实现会对 start-plan 做二次重写而 CE 不会 —— 这会改变 §3 的结论。
   取证方式：带身份头请求 `GET https://zcode.z.ai/api/v1/agent/configs` 并打印 `data.proxyEndpoint.mapping`。
2. **官方 `CaptchaRequestRetry` 的重试是否也走 endpoint routing 之后**未验证（本次只确认了重试会重新取 header）。
3. **CE 的 claim 平面求解器在「无痕静默通过」路径下的实测成功率未知。**
   本次只做了静态分析（脚本调用 `startTracelessVerification`），**没有跑过真实挑战**。
   这直接决定方案 A 里「大多数请求无需用户交互」这个假设是否成立 —— 若不成立，
   每个模型请求都会弹窗，方案 A 的体验结论要改写。
4. **CE 是否具备 `AliyunCaptcha.js` 的 CSP / 网络白名单放行**未验证（claim 路径已在用，但走的是
   `data:` 宿主页 + `<script src>`，模型请求路径若换宿主形态需重新确认）。
5. **官方在「无痕 8s 超时后主动 click」这条路径上，是否对用户可见性有额外要求**未验证
   （官方渲染层始终可见；CE 的常驻宿主默认不可见）。
6. **M11（Client Request Signing V4）对 start-plan 是否真的完全不适用**未实测。
   参考实现把 `/api/v1/zcode-plan/anthropic/v1/messages` 列进免签名白名单（`client-signing.ts:56-60`），
   这是强旁证，但**未做线上验证**；如果实际需要签名，方案 A 之外还要补 M11。

### 6.2 风险

- **最大的回归面**：把 start-plan 从「host 短路自答」改为「转发渲染层」后，
  后台任务 / 无 pane 会话 / Bot / 远控不再有兜底。官方为此实现了请求合并（`m3` map）
  与取消（`Bnn` → `providerRuntimeHeadersCancelled`）；CE 只改守卫不补这两条，
  会从「必然 3007」变成「180s 超时」。
- **协议向后兼容**：`zcode-protocol/index.ts` 是 Desktop↔Agent 契约。
  新增 `runtimeProviderHeaders` 必须 `.optional()`；reason 枚举是**放宽**（安全）；
  新增 session event 类型要注意老客户端不认识时的降级（不能因此抛 zod 错）。
- **死字段陷阱**：`packages/services/src/zcode-agent/zcodeAgent.ts:267` 的
  `runtimeProviderHeaders?: Record<string, string>` 全仓仅此一处、无人读写，
  它是 sendPrompt 的**入参**，与 runtime-headers **响应**无关。改动时勿被它误导。
- **静态硬编码路由的漂移**（M10）：与本次 3007 无关，但服务端改表时 CE 会静默走错端点。
  建议单列一个后续项，不要在本次修复里顺带改。

---

## 附：关键命令速查（复现用）

```bash
# 1. 参考项目 start-plan 注入验证码头（模型请求）
sed -n '138p;169,182p' .reverse/07-reference/zcode-api/src/proxy/handler.ts
# 2. 参考项目 3007 检测 + 单次重试
sed -n '25,67p;96,119p' .reverse/07-reference/zcode-api/src/proxy/captcha-retry.ts
# 3. 参考项目求解器后端与许可状态
sed -n '10,20p' .reverse/07-reference/zcode-api/src/proxy/captcha-solver.ts
ls .reverse/07-reference/zcode-api/LICENSE* ; node -p "require('/home/sixiao/aicode/fix/ZCode-CE/.reverse/07-reference/zcode-api/package.json').license"
# 4. 参考项目端点重写
sed -n '18,23p;105,122p;139,187p' .reverse/07-reference/zcode-api/src/proxy/endpoint-routing.ts
# 5. 参考项目免签名白名单
sed -n '56,60p' .reverse/07-reference/zcode-api/src/proxy/client-signing.ts

# 6. CE host 的 start-plan 短路（根因守卫）
grep -n 'accountRequestAuthService && accountAccess' -A 9 packages/services/src/zcode-agent/zcodeAgentService.ts
# 7. CE 协议 reason 枚举与响应 schema
sed -n '2395p;2424,2447p' packages/shared/src/zcode-protocol/index.ts
# 8. CE 模型链路 captcha 零命中
grep -rn 'captcha' apps/zcode-cli/packages/adapters/src apps/zcode-cli/packages/core/src apps/zcode-cli/packages/bootstrap/src
# 9. CE 3007 分类
sed -n '100,107p' apps/zcode-cli/packages/adapters/src/model/failure-provider-business-codes.ts
sed -n '86p'     apps/zcode-cli/packages/adapters/src/model/workflow-model-failure-policy.ts
# 10. CE start-plan provider 端点（证明不是 ultra）
grep -n 'zcode-plan/anthropic' config/provider/zcode-builtin.json
# 11. CE 硬编码网关表（不覆盖 start-plan）
sed -n '22,31p' apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts

# 12. 官方 host 的转发守卫（mode !== "start-plan"）
node -e "const s=require('fs').readFileSync('.reverse/94-account-capability/official-3.14.3/asar-out/out/host/index.js','utf8');const i=s.indexOf('providerRuntimeHeaders.request');console.log(s.slice(i-900,i+200))"
# 13. 官方 host 的验证码头合并
node -e "const s=require('fs').readFileSync('.reverse/94-account-capability/official-3.14.3/asar-out/out/host/index.js','utf8');const i=s.indexOf('runtimeProviderHeaders');console.log(s.slice(i-900,i+500))"
# 14. 官方渲染层的求解参数（allowInteractive / 超时常量）
node -e "const s=require('fs').readFileSync('.reverse/94-account-capability/official-3.14.3/asar-out/out/renderer/assets/styles-DEELZGp2.js','utf8');const i=s.indexOf('preferInteractive');console.log(s.slice(i-1200,i+700))"
# 15. 官方 agent 的 CaptchaRequestRetry
node -e "const s=require('fs').readFileSync('.reverse/94-account-capability/official-3.14.3/extracted/opt/ZCode/resources/glm/zcode.cjs','utf8');const i=s.indexOf('CaptchaRequestRetry');console.log(s.slice(i-500,i+900))"
# 16. 官方 start-plan 端点常量
node -e "const s=require('fs').readFileSync('.reverse/94-account-capability/official-3.14.3/extracted/opt/ZCode/resources/glm/zcode.cjs','utf8');const i=s.indexOf('zcodePlanAnthropicBaseUrl');console.log(s.slice(i-120,i+120))"
```
