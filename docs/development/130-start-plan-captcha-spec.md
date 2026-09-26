# Spec：start-plan 验证码挑战链路（captcha challenge）+ 切渠道队列授权位复位

- 状态：待实现（ce.3-fix.1）
- 背景与证据：[126 根因报告](./126-start-plan-3007-root-cause.md)、[127 粘滞机制](./127-session-scoped-sticky-provider-failure.md)、[128 参考项目对照](./128-reference-proxy-parity.md)、[129 缺陷扫描](./129-ce-defect-scan.md)
- 影响范围：协议契约（shared）、host 服务（services）、agent 运行时（zcode-cli）、UI（ui）

---

## 1. 问题陈述

start-plan（官方赠送额度）渠道的模型请求**必然失败**并报 `provider_code=3007`。

**已定案根因**：3007 是**阿里云验证码挑战**，不是鉴权失败。start-plan 的模型请求经
`zcode.z.ai/api/v1/zcode-plan/anthropic` 网关转发，该网关对 start-plan 启用阿里云无痕验证，
强制要求 `X-Aliyun-Captcha-Verify-Param` 头。官方客户端为此有一条三段式链路，CE **三段全缺**：

| 段                   | 官方行为                                                                                      | CE 现状                                                               |
| -------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| ① 渲染层求解         | AliyunCaptcha 求解 → 回传 `runtimeProviderHeaders`                                            | 求解器只服务 claim 平面，模型请求平面 0 命中                          |
| ② host 转发 + 头合并 | `mode !== "start-plan"` 才短路；start-plan 转发渲染层，并把验证码头并入 `requestAuth.headers` | 守卫写反成「有 accountAccess 就短路」；无头合并；**无渲染层应答入口** |
| ③ agent 单次重试     | `CaptchaRequestRetry.claim()` 命中 3007 → `reason="captcha-retry"` 重试一次                   | 无此机制，3007 直接终态                                               |

**第二个独立缺陷**：`turn.failed` 后若队列非空，会话队列授权位 `queue.autoDrain` 被置 `false`
（`pauseReason="error"`），而**任何切模型路径都不复位它**；新会话因初值为 `true` 而绕过。
⇒ 用户观感是「切渠道仍报错，只能新开会话」。

**不在本 spec 范围**：参考反代的无头 happy-dom 求解器。该项目**无 LICENSE 文件**（`package.json` 亦无
`license` 字段），按 `third-party/README.md` §3 属 `incomplete-unverified`（阻断发布），不可搬运。
本方案走官方路径：**验证码由用户手动完成**。

---

## 2. 产品规则

1. **验证码只对 start-plan 生效**。非 start-plan 的 account provider（individual / team / off-peak）
   与自建 provider 一律不触发求解，保持「host 自答、零 UI」快路径不变。
2. **用户手动完成**。无痕验证优先（traceless）；无痕不通过时展示交互挑战，由用户完成。
   不实现任何自动绕过。
3. **求解失败必须快速失败并给出明确原因**，不得让请求悬挂到超时。
4. **切渠道（setModel）必须复位会话队列授权位**，使失败后的会话无需新开即可继续。
5. **单次重试**：3007 挑战最多触发一次重新求解 + 重试；重试仍失败才向用户报错。

---

## 3. 状态所有者（唯一所有者原则）

| 状态                                 | 所有者                                                                   | 说明                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 待应答的 runtime-headers 请求        | `zcodeAgentService` 的 `pendingProviderRuntimeHeaders` map（**已存在**） | 键 = `workspace + sessionId + requestId`；requestId 每次 `randomUUID`，天然不复用 |
| 验证码求解过程态（进行中/成功/失败） | **渲染层组件**（各前端本地 state）                                       | 一次性凭据，**不落盘、不入 store**                                                |
| 求解结果（verifyParam / region）     | 通过协议响应**一次性回传**，不持久化                                     | 与 claim 平面同口径                                                               |
| 会话队列授权位 `queue.autoDrain`     | v4 投影 `ConversationProjection.snapshot.queue`（**已存在**）            | 复位由 `session/setModel` 链路显式触发                                            |
| 3007 重试额度（用没用过）            | agent 侧请求作用域对象（每次模型请求新建）                               | 不跨请求复用，保证「只重试一次」                                                  |

**不做**：不在 host 或 services 层缓存验证码凭据；不引入第二个 provider 失败状态源。

---

## 4. 接口与契约

### 4.1 协议扩展（`packages/shared/src/zcode-protocol/index.ts`）

1. `zcodeProviderRuntimeHeadersRequestReasonSchema`：`["model-request"]` → `["model-request","captcha-retry"]`
   （**放宽**，向后兼容）。
2. `zcodeProviderRuntimeHeadersResponseSchema` 的 `headersApplied:true` 分支新增
   **可选** `runtimeProviderHeaders?: Record<string, string>`（两个分支均为 `.strict()`，不加则被拒）。

> 注：`zcodeAgent.ts:267` 的 `runtimeProviderHeaders` 是 sendPrompt 入参上的**死字段**（全仓仅声明处出现），
> 与本响应字段无关。实现时不要被它误导；本 spec 不改动它。

### 4.2 host 转发守卫（`packages/services/src/zcode-agent/zcodeAgentService.ts`）

`interaction/requestProviderRuntimeHeaders` 处理分支的判定改为**对齐官方**：

```ts
// 非 start-plan 才走「host 自答、零 UI」快路径；start-plan 必须转发渲染层求解验证码。
if (accountRequestAuthService && accountAccess && accountAccess.mode !== "start-plan") {
  void respondAccountRequestAuthWithoutInteraction({ key: pendingKey, pending });
  return;
}
// start-plan：转发渲染层并等待应答（进入 pending map）
```

**关键约束（r4 实证）**：CE **没有**渲染层应答入口（全仓 0 命中 `respondProviderRuntimeHeaders`）。
因此守卫、应答入口、渲染层接线、头合并**必须同一个提交落地**——只改守卫会把故障从
「必然 3007」变成「必然立即失败」（落到 `:2275-2281` 的 `headersApplied:false` 分支）。

### 4.3 渲染层应答入口（新增）

新增一个与 `respondProviderRuntimeHeaders` 语义对齐的 host API：渲染层求解完成后调用它，
host 把 `runtimeProviderHeaders` 中**大小写不敏感**匹配
`X-Aliyun-Captcha-Verify-Param` / `X-Aliyun-Captcha-Verify-Region` 的项并入
账号鉴权材料（`requestAuth.headers`），再应答 agent。

- 白名单合并（只接受这两个头），与官方一致——**不得**让渲染层任意注入请求头。
- 应答后必须从 pending map 删除；已删除/已取消的请求重复应答要幂等返回，不抛错给 UI。

### 4.4 无渲染层场景（Web / 手机远控 / Bot）

- **Web / 手机远控**：走 CE 既有的 v4 `PendingInteraction` 通道（`kind` 枚举
  `["permission","userInput","workspaceHookReview"]`）。这些前端是浏览器，**可在页面内直接加载
  `AliyunCaptcha.js`**（官方 renderer 亦如此），不依赖 Electron `webview`。
  `isManualClaimCaptchaWebviewSupported` 只约束 claim 平面的隔离选择，**不适用于**本链路。

  **已实测的可行性依据**：
  - 求解脚本 `buildManualClaimCaptchaSolveScript`（`manualClaimCaptchaPage.ts:184`）是**纯字符串 + 纯函数**，
    通过 `window.initAliyunCaptcha` 驱动 SDK，**不含任何 Electron 专有 API** ⇒ 浏览器可直接执行；
  - 归一化函数 `RESOLVE_VERIFY_PARAM_SOURCE`（`:261`）、消息解析 `parseManualClaimCaptchaMessage`（`:314`）、
    结果映射 `toManualClaimCaptchaSolution`（`:374`）均为可复用纯函数；
  - **CSP 不构成阻碍**：`packages/server/src/webExposureGuard.ts:394-399` 下发的策略只有
    `frame-ancestors 'none'`，**没有 `script-src` / `connect-src` 限制** ⇒ 加载 `o.alicdn.com` 的 SDK
    与访问 `*.aliyuncs.com` 验证接口均不被拦。
    （若将来把 CSP 收紧为 enforce 全量策略，必须同步把阿里云验证码域名加入白名单——届时这是一处必须记得改的点。）

- **Bot**：官方闭源包**同样不支持**该场景（实测官方 host 无任何无订阅者兜底；`x-zcode-bot-secret`
  仅用于 webhook 收发与 `elicitation_response`，与 captcha 零关联）。
  ⇒ **明确不支持 + 快速失败**，返回稳定错误码，**不得**悬挂到 180s 超时。

### 4.5 agent 重试（`apps/zcode-cli/packages/adapters/src/model/`）

- `reason` 类型由 `"model-request"` 放宽为 `"model-request" | "captcha-retry"`
  （`runner-runtime.ts:33`、`runner-runtime-headers.ts:14`、`contracts/src/model/invocation-context.ts:35`）。
- 新增 `isCaptchaRejection(failure)`：判 `providerCode === "3007"`。
- 新增单次重试：命中 3007 且未用过 → 重试一次，且重试 attempt 以 `reason:"captcha-retry"` 重新请求
  runtime headers（触发渲染层重新求解新 token），并把额外额度并入重试预算。

**必须遵守（r4 订正）**：拦截点在**分类器之前**。
`failure-provider-business-codes.ts` 与 `workflow-model-failure-policy.ts` 与官方开源检出**逐字一致**
（已实测 `diff`），官方 3007 同样是 `AuthFailed + retryable:false`——**不改业务码表，不改 workflow 策略**。

### 4.6 队列授权位复位（第二缺陷）

**统一判据**：只要**会话的模型选型发生变更**且队列处于 held（`autoDrain === false` 且
`pauseReason !== "stopped"`），就复位为 `true`（复用既有 `setQueueAutoDrain`，不新建机制）。
复位必须发生在**选型变更生效之后**；变更失败不复位。

> **2026-09-25 订正（impl-queue-reset 实测提出，Lead 已复核确认）**：
> 本节初稿把落点写成「`session/setModel` 成功链路」，**这是事实错误 —— 只改它修不好桌面端症状**。
> 实测有三条互不相同的模型选型路径：
>
> | 路径             | 入口                                                                                                                       | 消费方                                                                                    | 是否覆盖桌面 v4 UI |
> | ---------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------ |
> | 旧协议 op        | `session/setModel` → `server-operations.ts:2675` → `record.app.setModel`                                                   | `zcodeSessionService.setModel`、`zcodeTaskServiceAdapter`（replayable / bot 的 `/model`） | 否                 |
> | v4 命令          | `model-config.ts:76 switchModelConfig`                                                                                     | `zcodeTaskServiceAdapter`（setThoughtLevel 同模型路径、automation）                       | 否                 |
> | **提交携带选型** | **`sendText` 的 `modelSelection`** → `turn-model.ts:40 applySubmissionExecutionState` → `runtime.setSessionModelSelection` | 桌面 v4 Composer                                                                          | **是**             |
>
> 桌面 v4 Composer 切模型**只改 renderer 草稿**（`useDraftConfigControl.ts:410 handleDraftSelectModel`），
> 真正生效发生在**下一次 `sendText` 携带 `modelSelection`** 时（`turn-model.ts:51-70`）。
> ⇒ **三条路径都必须覆盖**，共用同一个判据共用件，不复制实现。
>
> 判据（共用件）：`submission.modelSelection`（或 setModel/switchModelConfig 的目标选型）
> 与**会话当前选型**不同 ⇒ 视为「用户主动换渠道」⇒ 若队列 held 则复位。
> 会话当前选型取 `runtime.getSessionModelSelection()`（`config.ts:98` 的读侧）。
> 同一选型的重复提交（`sameModelSelection` 为真）**不复位**，避免每次发消息都抖动 revision。
>
> **error/stopped 区分**：可区分。`pauseReason` 虽只在投影层（`shared/src/zcode-protocol-v4/snapshot.ts:222`），
> 但 v4 命令层已有「读投影」的既有钩子模式（`getInputRoutingMode` / `getQueueLength` / `hasQueueItemKind`
> 均走 `context.v4Gateway`）。按同一模式加只读钩子读取 `{autoDrain, pauseReason}`，不新建机制。
> **投影不可得（null）时不复位**——宁可漏清，也不误清用户主动停止的 held。

---

## 5. 不变量与失败语义

**不变量**

1. 非 start-plan 的 runtime-headers 请求**永不**转发渲染层（保持零 UI 快路径）。
2. 渲染层只能注入白名单内的两个验证码头。
3. 每个模型请求最多因 3007 触发**一次**重试。
4. 任何路径都不得让 runtime-headers 请求悬挂超过既有 180s 上限；无渲染层时必须**主动快速失败**。
5. 验证码凭据（verifyParam）不落盘、不入 store、不进日志。

**失败语义**

| 场景                   | 行为                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| 无渲染层（Bot）        | 立即回 `headersApplied:false` + 稳定错误码，附可读原因           |
| 求解失败 / 用户取消    | 回 `headersApplied:false` + 原因；agent 按业务错误上报，不重试   |
| 3007 重试一次后仍失败  | 按既有分类（`AuthFailed`）终态上报，文案保留「网关安全校验拒绝」 |
| 重试期间用户取消       | 走既有 `providerRuntimeHeadersCancelled` 清理，不泄漏 pending    |
| setModel 时队列非 held | 复位为 no-op（幂等）                                             |

---

## 6. 验收场景

**A. 根因消除**

1. start-plan 渠道发起模型请求 → host **转发**渲染层（不再短路自答）。
2. 渲染层求解成功 → host 把两个验证码头并入 `requestAuth.headers` → agent 带头发请求 → 不再 3007。

**B. 兼容性（不得回归）** 3. 非 start-plan account provider（individual/team）→ 仍走 host 自答零 UI 快路径。4. 自建 provider / opencode → 完全不受影响。

**C. 自愈** 5. 上游仍回 3007 → agent 以 `reason:"captcha-retry"` 重新取头（渲染层重新求解）→ 重试一次。6. 第二次仍 3007 → 按业务错误上报，**不再重试**（验证「只重试一次」）。

**D. 无渲染层** 7. Bot 场景 → 快速失败（**不得**出现 180s 悬挂）。

**E. 第二个缺陷** 8. 会话因 turn 失败进入 `autoDrain:false` → 切模型成功后 → `autoDrain` 复位 `true`，同会话可继续。9. 用户主动停止（`pauseReason:"stopped"`）后切模型 → **不**被复位（尊重用户停止意图）。

**F. 契约健壮性** 10. 渲染层回传白名单外的头 → 被忽略。11. 重复应答同一 requestId → 幂等，不抛错。

---

## 7. 迁移边界

- 协议两处改动均为**向后兼容**（枚举放宽 + 可选字段），新旧客户端可共存；无需数据迁移。
- 不新增环境变量。
- 不新增持久化格式。
- 实现顺序：**先 §4.5（agent 重试骨架，可独立单测）→ 再 §4.2+4.3+4.1+渲染层 作为一个原子提交
  （守卫/应答入口/头合并/接线缺一不可）→ 最后 §4.6（独立小改动）**。
