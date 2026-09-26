# start-plan（官方赠送额度）模型请求 3007 根因报告

- 调查人：r1-root-cause（独立复核，未照抄 Lead 假设链）
- 日期：2026-09-25
- 范围：只读调查，未改动任何源码
- 工作目录：`/home/sixiao/aicode/fix/ZCode-CE`

## 开工前读过的既有材料（及一致性声明）

| 材料                                                                  | 结论是否一致                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `AGENTS.md`（根）                                                     | —（规则，无结论冲突）                                                                |
| `.reverse/94-account-capability/ACCOUNT-CAPABILITY-DIAGNOSIS.md`      | 一致：account 能力面按 provider 分族处理                                             |
| `.reverse/07-reference/zcode-api/`（用户指明的参考实现）              | **一致且是最强旁证**：该反代已实现同一套 3007 挑战重试，并记录了两种挑战变体         |
| `.reverse/91-upstream-checkout/zai-org-ZCode/`（v3.14.3 = `29628c9`） | **不一致（重要）**：开源检出**全仓 captcha 0 命中**，见 §2.7 旁注与 §3「假设 A」判定 |
| `docs/development/*`                                                  | 无同主题既有文档，本报告为首次                                                       |

> **对 Lead 假设链的一处更正（独立复核得出，非照抄）**：Lead 说「官方 host 把请求转发给渲染层」是对的，
> 但**转发条件**被漏掉了。官方 host 的转发有精确的 `mode !== "start-plan"` 守卫：**只有非 start-plan 才短路自答，
> start-plan 一律转发渲染层**。CE 恰好把这个守卫写反成了「有 accountAccess 就短路」。这是本次调查最关键的一处差异，
> 也是「为什么偏偏只有 start-plan 出事」的直接解释。详见 §2.3 与 §4。

---

## 1. 结论

**3007 不是鉴权失败，是阿里云验证码挑战（captcha challenge）。**

start-plan（官方赠送额度）的模型请求经 ZCode 平台网关 `zcode.z.ai/api/v1/zcode-plan/anthropic` 转发，该网关对
start-plan 启用了阿里云无痕验证（Captcha V3）风控：请求必须携带 `X-Aliyun-Captcha-Verify-Param`
（及可选 `-Region`）头，否则网关以 `code=3007` 拒绝。官方客户端为此建了一条**三段式链路**——
① 渲染层用 `AliyunCaptcha.js` 求解验证码；② host 把渲染层给的验证码头并入模型请求的 `requestAuth.headers`；
③ agent 收到 3007 后用 `reason="captcha-retry"` **重试一次**，重新求解拿新 token。

**CE 三段全缺**：host 在 `zcodeAgentService.ts:2266` 对任何 account provider 直接短路自答
（不转发渲染层），协议 schema 无 `runtimeProviderHeaders` 字段、reason 枚举无 `captcha-retry`，
agent 侧无 `CaptchaRequestRetry`/`isCaptchaRejection`。于是 start-plan 请求**永远不带验证码头**发出，
网关**必然**回 3007；CE 又把这个码映射成 `AuthFailed + retryable:false`
（`failure-provider-business-codes.ts:100-108`），workflow 策略对 AuthFailed 直接 `stop`
（`workflow-model-failure-policy.ts:86`）——用户看到的就是这条链的终点。

**opencode 没问题**，因为 opencode **根本不走 ZCode 的 provider-runtime-headers 协议，也不经
`zcode.z.ai` 的 start-plan 网关**（start-plan 的 baseUrl 由内置配置直接指向该网关，
见 `zcode-builtin.json` 的 `account:zai-start-plan` / `account:bigmodel-start-plan`；
opencode 的 baseUrl 是 `https://opencode.ai/zen/go/v1`，不经任何 ZCode 网关），因此完全不触发这套验证码挑战。

> **2026-09-25 订正（r3-reference-parity 独立复核提出，Lead 已实测确认）**：本节初稿把 start-plan 的
> 网关路径写成 `ultra*`，**这是事实错误**。实测 `~/.zcode/v2/runtime/provider/*/zcode-builtin.json`：
> `account:zai-start-plan` 与 `account:bigmodel-start-plan` 的 baseUrl 均为
> `https://zcode.z.ai/api/v1/zcode-plan/anthropic`；`ultra[-zai]` 是 **coding-plan** 的重写目标
> （见 `official-coding-plan-gateway.ts:22-31` 的路由表，源端点是 `api.z.ai/api/anthropic` 与
> `open.bigmodel.cn/api/anthropic`，**不含** start-plan）。因此 CE 的硬编码网关路由表与 start-plan
> **不冲突**（`endpointKey` 精确匹配，未命中即原样返回），它只是「等价但静态」的实现。
> 该订正不影响本报告的主结论（验证码挑战链路缺失）。

一句话：**这不是鉴权坏了，是「验证码挑战 → 求解 → 带新 token 重试」这条链路在 CE 从未被实现，
而 CE 又把挑战码误判成不可重试的鉴权失败。**

---

## 2. 证据链

### 2.1 官方 agent 运行时确实有 3007 重试机制（假设 A 的 agent 段：证实）

命令：

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('.reverse/94-account-capability/official-3.14.3/extracted/opt/ZCode/resources/glm/zcode.cjs','utf8');const i=s.indexOf('CaptchaRequestRetry');console.log(s.slice(i-500,i+900))"
```

`extracted/opt/ZCode/resources/glm/zcode.cjs`（offset 4013457 起）原文：

```js
function uOe(e){return iG(e).providerErrorCode===x4s}   // isCaptchaRejection
var x4s, $0e, ...; x4s="3007";
$0e=class{ static{r(this,"CaptchaRequestRetry")}
  request; model; used=!1; pending=!1;
  get extraAttempts(){return Number(this.used)}
  takeReason(){ let t=this.pending?"captcha-retry":"model-request"; return this.pending=!1,t }
  claim(t,n=!1){
    return n || this.used || this.request.abortSignal?.aborted
      || !this.request.refreshRuntimeHeadersBeforeAttempt
      || this.model.accountAccess?.mode!=="start-plan"
      || !uOe(t) ? !1 : (this.used=!0,this.pending=!0,!0)
  }
}
```

要点：

- `claim()` 的短路条件含 `this.model.accountAccess?.mode !== "start-plan"` ⇒ **该机制只对 start-plan 生效**，
  与用户症状「只有 start-plan 出问题」完全吻合。
- `used` 保证**只重试一次**；`extraAttempts` 被并入重试预算（offset 4022411 附近
  `kst(t,_,e.retry.maxAttempts+Number(u)+f.extraAttempts)`）。
- 重试时 `takeReason()` 返回 `"captcha-retry"`，经 `tat()`（`resolveModelForAttempt`，offset 4013959）
  传给 `refreshRuntimeHeadersBeforeAttempt({attempt, reason, ...})` ⇒ **重试会重新去要一次鉴权头**。

重试触发点（offset 4026068 附近）：

```js
let Pe=f.claim($, R===void 0);
Pe && (E={...E, maxAttempts:n(Number(u)+f.extraAttempts)});
let Tt = Pe || ze || rt;          // Tt = 本次是否可重试
...
if(!Tt) throw tB({attempt:_,canRetry:Tt,...});
if(Pe){ await Fln(e,E,_,0,{...ae,retryReason:Qc.AuthRefresh},U,Ce); continue }
```

⇒ `claim()` 命中时**不走 throw，而是 continue 重试**。这正是 CE 缺失的那一步。

### 2.2 官方协议确实有 captcha-retry（假设 B 的「官方侧」：证实）

`zcode.cjs` offset 768771：

```js
((Ysr = m.enum(["model-request", "captcha-retry"])),
  (fUi = m
    .object({
      requestId: Dn,
      sessionId: Dn,
      turnId: Dn.optional(),
      workspace: rd,
      modelSelection: Pu,
      providerId: Dn,
      accountAccess: ssr.optional(),
      reason: Ysr,
    })
    .strict()));
```

Electron 侧同样：`asar-out/out/host/chunk-B7L5SK4K.js` @631222、
`asar-out/out/main/chunk-GJUBRD53.js` @651449、`asar-out/out/renderer/assets/src-BkoFK6Bn.js` @226011
均为 `enum(["model-request","captcha-retry"])`。

### 2.3 官方 host 的转发守卫是 `mode !== "start-plan"`（★ 最关键，Lead 未覆盖）

命令：

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('.reverse/94-account-capability/official-3.14.3/asar-out/out/host/index.js','utf8');console.log(s.slice(316100,316700))"
```

`asar-out/out/host/index.js`（offset 316337）原文：

```js
let Ze = K.data.accountAccess;
if (mr && Ze && Ze.mode !== "start-plan") {
  vt({ key: ee, pending: le });
  return;
} // ← 只有非 start-plan 才短路自答
(Wt(x, K.data.sessionId, { type: "providerRuntimeHeaders.request", request: K.data }),
  u.get(ie(x))?.fire(K.data)); // ← start-plan 转发渲染层
return;
```

（`vt` = `respondAccountRequestAuthWithoutInteraction`，见 `i(vt,"respondAccountRequestAuthWithoutInteraction")`；
`mr = e?.accountRequestAuthService`。）

**语义**：官方对**非** start-plan 的 account provider 走「host 自答、零 UI」快路径；
对 **start-plan 必须转发渲染层**——因为只有渲染层能求解验证码。
CE 在 `zcodeAgentService.ts:2266` 把条件写成了 `if (accountRequestAuthService && accountAccess)`
（**丢掉了 `mode !== "start-plan"` 这一半**），于是 start-plan 也被短路自答，渲染层永远收不到请求。

### 2.4 官方 host 会把渲染层的验证码头并入 requestAuth（假设 A 的 host 段：证实）

命令：

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('.reverse/94-account-capability/official-3.14.3/asar-out/out/host/index.js','utf8');console.log(s.slice(356900,357700))"
```

`asar-out/out/host/index.js`（`respondProviderRuntimeHeaders`，offset 357101）：

```js
let H = { ...G?.headers };
for (let [le, Ze] of Object.entries(m.response.runtimeProviderHeaders ?? {})) {
  let De = ["X-Aliyun-Captcha-Verify-Param", "X-Aliyun-Captcha-Verify-Region"].find(
    (Nt) => Nt.toLowerCase() === le.trim().toLowerCase(),
  );
  De && Ze.trim() && (H[De] = Ze.trim());
}
let K =
  G?.apiKey || Object.keys(H).length > 0
    ? {
        ...(G?.apiKey ? { apiKey: G.apiKey } : {}),
        ...(Object.keys(H).length > 0 ? { headers: H } : {}),
      }
    : void 0;
await z.client.respond(
  z.protocolRequestId,
  K
    ? { headersApplied: !0, requestAuth: K }
    : { headersApplied: !1, errorMessage: "Provider request auth is missing" },
);
```

⇒ host 是「账号鉴权材料 **+** 渲染层验证码头」的**合并点**。

### 2.5 官方渲染层是真正的求解点（回答 Lead 的追问）

`asar-out/out/renderer/assets/styles-DEELZGp2.js`（5.9 MB）：

| 符号              | offset          | 作用                                                                               |
| ----------------- | --------------- | ---------------------------------------------------------------------------------- |
| `ztn`             | 4153485 附近    | `https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`             |
| `bnn`             | 4171034         | `e?.access?.type==='zhipu-account' && e.access.mode==='start-plan'` ⇒ **求解门禁** |
| `Mnn`             | 4172356         | 求解主流程（队列串行 + `timeoutMs=Htn(120s)`）                                     |
| `Fnn`             | 4173269         | 「求解 + 构造头」，返回 `{captchaVerifyParam, headers}`                            |
| `snn`/`cnn`/`lnn` | 4169730/4169807 | `X-Aliyun-Captcha-Verify-Param`/`-Region` 头构造器                                 |
| `Rnn`             | 4174070         | 响应 provider runtime headers 请求的主函数                                         |

`Rnn` 关键分支（offset 4175221 附近）：

```js
... bnn(t) && (r = (await Fnn({
      ..., source: e.request.reason===`captcha-retry` ? `captcha_retry` : `send_preflight`, ...
    }))?.headers)
...
await e.zcodeSessionService.respondProviderRuntimeHeaders({
  ...,
  response: r ? {headersApplied:!0, runtimeProviderHeaders:r}
              : {headersApplied:!1, ...(n?{errorMessage:n}:{})}
})
```

**回答 Lead 的追问「验证码头最初从哪来」**：
不是「服务端先回挑战、客户端再求解」。渲染层在**每次**模型请求前**主动求解**（`send_preflight`），
把 token 预置进请求头。`createZcodePlanCaptchaEmptyStreamBusinessError` 里读响应头的
`readCaptchaVerifyParam`（offset 4030164，常量 `J4s="x-aliyun-captcha-verify-param"`）只是**另一种**触发形态
（网关在响应里回带新 challenge param 时，把空流包装成 3007 业务错误），不是 token 的来源。
`source` 分支同时证明 `captcha-retry` 是**真实存在的运行分支**——重试时确实会再求解一次。

### 2.6 3007 的两种形态 —— 这解释了 `status=400` 与 `403` 的差异（假设 C 的关键）

用户报告里写 `status=400`，而官方 `createZcodePlanCaptchaEmptyStreamBusinessError` 造的是
`responseStatus:200, statusCode:403`。**两者不矛盾，是同一个挑战的两种变体**。

`zcode.cjs` offset 4030573：

```js
function hVr(e) {
  if (!(e.providerKind !== "openai-compatible" || !e.captcha) && mVr(e.headers))
    return new S2({
      providerCode: "3007",
      providerId: e.providerId,
      providerKind: e.providerKind,
      providerMessage: fVr,
      responseStatus: 200,
      statusCode: 403,
    });
}
// fVr = "Captcha verification failed or the verify token was rejected."
```

⇒ 变体①「响应头变体」：非 2xx 响应带 `x-aliyun-captcha-verify-param`，本地造 3007/403。

用户指明的参考实现 `.reverse/07-reference/zcode-api/src/proxy/captcha-retry.ts:1-8` 明确记录了**变体②**：

```
 * The challenge arrives in two variants (observed 2026-08-29, PR #38):
 *   1. response-header variant — `x-aliyun-captcha-verify-param` set on a
 *      non-2xx response (`captcha.detectCaptchaChallenge`);
 *   2. in-body variant — HTTP 400 with `{"code":3007,...}` in the JSON body
 *      and no captcha header.
```

且 `captcha-retry.ts:25`：

```ts
export const IN_BODY_CHALLENGE_MARKERS = ['"code":3007', '"code": 3007'] as const;
```

**因此 `status=400` 是上游真实 HTTP 状态**（变体②，网关直接回 HTTP 400 + body `{"code":3007}`），
**不是被谁改写的**。CE 侧也确实不会把 3007 改写成 400：
`model-execution.ts:941` 的 `providerCodeToStatusCode("3007")` 因 `isHttpStatusCode` 限定 100–599 而返回 `undefined`，
真正的 statusCode 来自 `failure-classifier.ts:520-530` 的 `normalizeHttpFailureStatus(statusCode)`（即上游真实状态）。
⇒ **Lead 假设里「403 被改写成 400」的猜想不成立**；两者是不同变体，用户命中的是 in-body 变体。

### 2.7 CE 侧的四段缺口（逐条复核）

**[1] 协议 schema** — `packages/shared/src/zcode-protocol/index.ts`

- `:2395` `export const zcodeProviderRuntimeHeadersRequestReasonSchema = z.enum(["model-request"]);` ← 缺 `captcha-retry`
- `:2424` `zcodeProviderRuntimeHeadersResponseSchema = z.discriminatedUnion("headersApplied", [...`
  `:2427-2439` 的 `headersApplied: z.literal(true)` 分支只有 `requestAuth` + `errorMessage`，**无 `runtimeProviderHeaders`**，且两个分支都是 `.strict()` ⇒ 渲染层若传该字段会被 zod 拒绝。

**[2] host 短路（最关键）** — `packages/services/src/zcode-agent/zcodeAgentService.ts:2266`

```ts
if (accountRequestAuthService && accountAccess) {
  void respondAccountRequestAuthWithoutInteraction({ key: pendingKey, pending });
  return; // ← 不 emitSessionEvent、不转发渲染层
}
```

对比官方 `Ze.mode!=="start-plan"` 守卫：**CE 少了这一半条件**。
`respondAccountRequestAuthWithoutInteraction`（`:1266-1308`）最终 `:1278-1281` 直接回
`{headersApplied:true, requestAuth}`，`requestAuth` 来自 `resolveAccountRequestAuth`（`:1252-1264`）
→ `accountProviderRequestAuthService.ts:73-76`（start-plan 只给 `apiKey: zcodeJwtToken`）⇒ **绝无验证码头**。

**[3] 渲染层未接线** — `grep -rn "respondProviderRuntimeHeaders\|providerRuntimeHeaders" packages/ui/src`
只命中 `packages/services/src/zcode-agent/zcodeAgentService.ts`（host 侧），**`packages/ui/src` 0 命中**。
CE 的求解器只服务 claim 平面：`packages/services/src/coding-plan-subscription/manualClaimCaptcha.ts`、
`packages/ui/src/settings/ManualClaimCaptchaDialog.tsx`。

**[4] agent 侧无重试** —

```bash
grep -rn 'CaptchaRequestRetry\|isCaptchaRejection\|captcha-retry\|captchaRetry' apps packages \
  --include=*.ts --include=*.tsx | grep -v dist | grep -v zcode-server-cli
# → 无输出（0 命中）
```

`apps/zcode-cli/packages/adapters/src/model/runner-runtime-headers.ts:21-24` 的
`resolveModelForAttempt` 签名里 `reason?: "model-request"` 也只有单值。

> **旁注（死字段）**：`packages/services/src/zcode-agent/zcodeAgent.ts:267` 有
> `runtimeProviderHeaders?: Record<string, string>`，但
> `grep -rn "runtimeProviderHeaders" --include=*.ts packages apps | grep -v dist` **全仓仅此一处**。
> 它挂在 `ZCodeAgentSendPromptParamsBase`（sendPrompt 入参）上，与 runtime-headers **响应**无关，
> 是**声明了但无人读写的死字段**。修 §5 时不要误以为它可用。

### 2.8 CE 的 3007 分类（假设 C：证实）

- `failure-provider-business-codes.ts:100-108`：`"3007" → { code: InvalidModelRequest, reason: AuthFailed, retryReason: AuthRefresh, retryable: false }`
- `workflow-model-failure-policy.ts:86`：`if (failure.reason === ModelFailureReason.AuthFailed) return { decision: "stop", kind: "auth" };`
- `packages/ui/src/lib/chatErrorAttributionEvidence.ts:52`：`"3007": "auth_failed"`
- `packages/ui/src/lib/providerBusinessError.ts:66`：`"3007": null`（无恢复动作）
- 文案 `packages/ui/src/i18n/locales/zh-CN.ts:5584`：
  `"zcode.error.providerBusiness.3007": "请求被网关安全校验拒绝，请稍后重试或联系支持。"`
  （原文含「网关安全校验拒绝」——**产品文案已承认这是安全校验，不是鉴权**；`en-US.ts:5850` 同条）
  > 订正记录：本报告初稿把该行写成 `zh-CN.ts:5694`，那是**开源检出**
  > （`.reverse/91-upstream-checkout/zai-org-ZCode/...`）的行号，CE 实际在 `:5584`。已按 CE 实测修正。

用户日志行的字段顺序与 `packages/zcode-cli/packages/core/src/errors/error-payload.ts:310-317` 的
`formatContextDetail` **完全一致**（provider / provider_code / model / request / code / reason / status / retryable）
⇒ **该日志行由 CE 的 error-payload 拼出，可确认用户跑的是 CE 而非官方客户端**。

### 2.9 为什么 opencode 没问题（假设验证）

CE 的官方网关路由表 `apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts:29-40`：

```ts
export const OFFICIAL_CODING_PLAN_GATEWAY_ROUTES = [
  {
    providerEndpoint: "https://open.bigmodel.cn/api/anthropic/v1/messages",
    gatewayPath: "/api/v1/ultra/anthropic/v1/messages",
  },
  {
    providerEndpoint: "https://api.z.ai/api/anthropic/v1/messages",
    gatewayPath: "/api/v1/ultra-zai/anthropic/v1/messages",
  },
];
```

**只覆盖 bigmodel 与 zai 两个 official coding-plan 端点**（注意：源端点是 `api.z.ai/api/anthropic` 与
`open.bigmodel.cn/api/anthropic`，**不是** start-plan 的 `zcode.z.ai/api/v1/zcode-plan/anthropic`）；
`opencode.ai` 不在表内，也不经任何 ZCode 网关（其 baseUrl 为 `https://opencode.ai/zen/go/v1`）。
CE 里 opencode 的唯一特殊处理是 `opencode-session.ts:4` `isOpenCodeGoBaseUrl` → 加一个
`x-opencode-session` 头（`runner-attribution.ts:32-44`），**与验证码无关**。

参考实现同样把验证码门禁绑定在 start-plan 上：

- `src/proxy/handler.ts:138` `const startPlan = config.plan === "start-plan";`
- `src/proxy/handler.ts:321` `const captcha = startPlan ? await loadCaptcha() : null;`
- `src/proxy/handler.ts:31-33` 注释：`captcha.ts is loaded lazily inside the `startPlan` branch (only path that ...)`
- `.github/ISSUE_TEMPLATE/bug_report.yml:54`：`403 / captcha 验证失败（start-plan）`

⇒ **opencode 不经该网关、不受该风控约束**，因此不触发 3007。这与「CE 用 opencode 就没问题」一致。

---

## 3. 三个假设的判定

### 假设 A：官方有 start-plan 验证码机制、CE 完全没有 —— **证实（并修正转发条件）**

证实部分：

- agent 段：`isCaptchaRejection` / `CaptchaRequestRetry` / `createZcodePlanCaptchaEmptyStreamBusinessError` 全部存在（§2.1、§2.6）。
- host 段：`respondProviderRuntimeHeaders` 合并 `X-Aliyun-Captcha-*`（§2.4）。
- 渲染层段：完整 AliyunCaptcha 求解器 + `Rnn`/`Fnn`/`bnn`（§2.5）。
- CE 段：`packages/ui/src` 0 命中；`CaptchaRequestRetry|isCaptchaRejection|captcha-retry` 全仓 0 命中（§2.7）。

修正部分：官方 host 并非无条件转发渲染层，而是 **`mode !== "start-plan"` 才短路自答、start-plan 转发**（§2.3）。
Lead 表述的「官方 host 转发渲染层 / CE 直接短路」方向正确，但**缺了守卫条件**；补上这一条后，
「为什么只有 start-plan 坏、其他 account 渠道正常」才被解释。

### 假设 B：reason 枚举不一致导致重试无法发生 —— **部分证实，但不是本次症状的成因（降级为潜在阻断）**

- 「官方用 `reason:"captcha-retry"` 重新请求 runtime headers」：**证实**（`takeReason()` + `tat()` + 渲染层 `source` 分支）。
- 「CE 枚举缺该值」：**证实**（`index.ts:2395`）。
- **但**「导致重试无法发生」：**证伪**。CE **根本不发起重试**（无 `CaptchaRequestRetry`、无 `isCaptchaRejection`，
  且 AuthFailed 直接 stop），所以 `captcha-retry` 这个值**从未被 CE 发出过**，
  zod `-32602` → CLI 180s 超时这条路径**在当前症状里不会走到**。
  该缺口是**修复时必须一并补上的前置**（否则补了重试也会被 schema 打回），但**不是**当前故障的原因。

### 假设 C：3007 被分类为 auth_failed 且不可重试 —— **证实；但「403 被改写成 400」的猜想证伪**

证实：

- `failure-provider-business-codes.ts:100-108` → `AuthFailed` / `retryable:false`；
  `workflow-model-failure-policy.ts:86` → `stop/auth`；`chatErrorAttributionEvidence.ts:52` → `auth_failed`。
- 用户看到的 `reason=auth_failed ... retryable=false` **就是这条映射的产物**（日志字段顺序与
  `error-payload.ts:310-317` 一致，§2.8）。
- 与官方语义**冲突**：官方视 3007 为「验证码挑战，应重试一次」（`claim()` → `continue`），
  CE 视其为「鉴权失败，终止」。

证伪（对 400/403 差异的猜想）：

- 「谁把 403 改写成 400」这个前提不成立。官方 `statusCode:403` 是**响应头变体**的本地构造值；
  用户 `status=400` 是**in-body 变体**的上游真实 HTTP 状态（参考实现 `captcha-retry.ts:5-8` 明确记录
  「HTTP 400 with `{"code":3007,...}` and no captcha header」，且观测日期 2026-08-29）。
- CE 也不会把 3007 变成 400：`providerCodeToStatusCode("3007")` 返回 `undefined`（100–599 限定），
  statusCode 实际取自上游真实状态（§2.6）。

---

## 4. 官方 vs CE 行为差异表

| #   | 环节                           | 官方 3.14.3 行为                                                                                            | CE 行为                                                                                                                                           | 后果                                                  |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | host 收到 runtime-headers 请求 | 仅当 `accountAccess.mode !== "start-plan"` 才短路自答；start-plan **转发渲染层**（`host/index.js` @316337） | `zcodeAgentService.ts:2266` 只要有 `accountRequestAuthService && accountAccess` 就短路自答                                                        | **start-plan 永远拿不到验证码头**；渲染层从不参与     |
| 2   | 协议 reason 枚举               | `["model-request","captcha-retry"]`（`zcode.cjs` @768771）                                                  | `z.enum(["model-request"])`（`index.ts:2395`）                                                                                                    | 重试请求会被 zod 拒（`-32602`）；当前因无重试而未触发 |
| 3   | 协议响应字段                   | 响应含 `runtimeProviderHeaders`（渲染层 `Rnn` 回传）                                                        | `index.ts:2424-2445` 两分支 `.strict()` 且**无该字段**                                                                                            | 渲染层即便回传也被拒                                  |
| 4   | host 合并验证码头              | `respondProviderRuntimeHeaders` 把 `X-Aliyun-Captcha-*` 并入 `requestAuth.headers`（@357101）               | **无此分支**（`zcodeAgentService.ts:1266-1308` 只回 `requestAuth`）                                                                               | 合并点缺失                                            |
| 5   | 渲染层求解                     | `bnn` 门禁 + `Mnn`/`Fnn` 求解 + `lnn` 构造头（`styles-DEELZGp2.js`）                                        | `packages/ui/src` 0 命中；求解器只在 claim 平面                                                                                                   | 模型请求平面无求解能力                                |
| 6   | 3007 分类                      | 验证码挑战（`isCaptchaRejection`）                                                                          | `AuthFailed` + `retryable:false`（`failure-provider-business-codes.ts:100-108`）                                                                  | 语义反转                                              |
| 7   | 3007 处置                      | `claim()` 命中 → `continue` 重试一次（`zcode.cjs` @4026068）                                                | `workflow-model-failure-policy.ts:86` → `stop/auth`                                                                                               | **回合终止，用户看到报错**                            |
| 8   | 重试预算                       | `extraAttempts` 并入 `maxAttempts`（@4022411）                                                              | 无 `extraAttempts` 概念                                                                                                                           | 无重试预算可加                                        |
| 9   | 非 start-plan account 渠道     | 短路自答（快路径，零 UI）                                                                                   | 短路自答（**行为一致**）                                                                                                                          | 无差异 —— 解释了「其他渠道正常」                      |
| 10  | opencode / 自建 provider       | 不经 ZCode 网关                                                                                             | 不经 ZCode 网关（baseUrl 为 `opencode.ai/zen/go/v1`；`official-coding-plan-gateway.ts:29-40` 的 ultra 表只覆盖 coding-plan 的 bigmodel/zai 端点） | 双方都不触发挑战                                      |

---

## 5. 修复所需的最小机制清单（只列机制，不含实现）

按依赖顺序排列；**1 是根因，其余是配套**。缺任一项，链路仍不通。

| #   | 机制                                                                                                                                                                                                                                      | 落点                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **host 转发守卫**：runtime-headers 请求在 `accountAccess.mode === "start-plan"` 时**不得**短路自答，须转发渲染层并进 pending map 等待渲染层应答                                                                                           | `packages/services/src/zcode-agent/zcodeAgentService.ts:2266`（条件收紧）＋ `:1873` 附近的转发/订阅路径                            |
| 2   | **协议响应字段**：`headersApplied:true` 分支增加可选 `runtimeProviderHeaders?: Record<string,string>`                                                                                                                                     | `packages/shared/src/zcode-protocol/index.ts:2424-2445`                                                                            |
| 3   | **协议 reason 枚举**：`["model-request","captcha-retry"]`                                                                                                                                                                                 | `packages/shared/src/zcode-protocol/index.ts:2395`                                                                                 |
| 4   | **host 头合并**：把 `runtimeProviderHeaders` 中匹配 `X-Aliyun-Captcha-Verify-Param`/`-Region`（**大小写不敏感**）的项并入 `requestAuth.headers`                                                                                           | `packages/services/src/zcode-agent/zcodeAgentService.ts:1266-1308`（`respondAccountRequestAuthWithoutInteraction` 或新增并行分支） |
| 5   | **渲染层接线**：订阅 provider runtime headers 请求，在 start-plan 时求解并回传 `runtimeProviderHeaders`；需处理取消与同 requestId 合并                                                                                                    | `packages/ui/src/`（新增 hook/service）＋ `packages/services/src/zcode-agent/` 的事件桥接                                          |
| 6   | **求解器复用判定**：确认 claim 平面求解器（`packages/services/src/coding-plan-subscription/manualClaimCaptcha.ts`）能否在**无用户交互**（`send_preflight` 预求解）路径复用；官方用 `AliyunCaptcha.js` + `allowInteractive:!0` + 120s 超时 | `packages/services/src/coding-plan-subscription/manualClaimCaptcha.ts`、`packages/ui/src/settings/ManualClaimCaptchaDialog.tsx`    |
| 7   | **agent 重试**：新增 `isCaptchaRejection`（`providerErrorCode === "3007"`）与单次 `CaptchaRequestRetry`；重试时以 `reason:"captcha-retry"` 重新请求 headers，并把 `extraAttempts` 并入重试预算                                            | `apps/zcode-cli/packages/adapters/src/model/runner-runtime-headers.ts:21-24`（reason 类型）＋ 重试循环（`runner*.ts`）             |
| 8   | ~~**分类修正**：3007 不应归 `AuthFailed`~~ **【已订正，见下方勘误】** 官方 3007 **同样**是 `AuthFailed + retryable:false`，业务码表与 workflow 策略均与官方逐项一致 ⇒ **不改码表**；重试拦截应发生在**分类器之前**（即 §5-7 的 agent 层） | ~~`failure-provider-business-codes.ts:100-108`、`workflow-model-failure-policy.ts:86`~~ **落点改为 §5-7**                          |
| 9   | ~~**UI 归因**：`chatErrorAttributionEvidence.ts:52` 需调整~~ **【已降级】** 该模块是**死代码**（唯一导出 0 引用），改它不改变任何用户可见行为；保留现状即可                                                                               | `packages/ui/src/lib/chatErrorAttributionEvidence.ts:52`（无消费者）                                                               |
| 10  | **清理死字段**：`runtimeProviderHeaders` 在 `zcodeAgent.ts:267` 是无人读写的死字段，要么接入要么删除，勿留误导                                                                                                                            | `packages/services/src/zcode-agent/zcodeAgent.ts:267`                                                                              |

> **【2026-09-25 勘误（r4-defect-scan 提出，Lead 已独立复核）】**
>
> **勘误 1（严重，改变实施顺序）**：本表初稿把 1→2→3→4 说成「先打通带验证码头发出」，
> **这个顺序不成立**。CE 的 host **没有渲染层应答入口**：`zcodeAgentService.ts:2266` 只有两个出口
> —— 账号短路自答，或 `:2275-2281` 立即回 `headersApplied:false` 快速失败；
> 全仓 `grep -rn respondProviderRuntimeHeaders` **0 命中**，而官方 host 有该方法作为渲染层应答的唯一入站 API。
> ⇒ **只改守卫（第 1 项）会把故障从「必然 3007」变成「必然立即失败」，用户可感知结果更差。**
> 因此 **1（守卫）+ 4（头合并）+ 新增「渲染层应答入口」+ 5（渲染层接线）必须作为一个原子提交**，
> 不能按 1→2→3→4 分批落地。§6.2 预判的「180s 超时」形态也应订正为「立即失败」（若只改守卫）。
>
> **勘误 2**：第 8 项「分类修正」**不成立**。已实测 `diff` 官方开源检出
> （`.reverse/91-upstream-checkout/zai-org-ZCode/apps/zcode-cli/packages/adapters/src/model/failure-provider-business-codes.ts`）
> 与 CE 的同名文件 **完全一致**，`workflow-model-failure-policy.ts` 亦 **完全一致**。
> 即官方 3007 本身就是 `AuthFailed + retryable:false`；官方不出问题是因为 agent 层用
> `CaptchaRequestRetry.claim()` 在**分类器之前**拦截重试。⇒ 修复落点是第 7 项（agent 层），**改码表反而偏离官方语义**。
>
> **勘误 3**：第 9 项降级。`packages/ui/src/lib/chatErrorAttribution.ts` 整模块为**死代码**
> （其唯一导出无外部引用，实测 `grep` 仅命中其自身与 `chatErrorAttributionEvidence` 的导入行），
> 修改 `"3007":"auth_failed"` **不改变任何用户可见行为**。
>
> 建议顺序（订正后）：**7（agent 重试骨架 + 分类前拦截，可独立单测）→ 然后 1+4+应答入口+5 作为一个原子提交**；
> 2、3（协议扩展）随原子提交一并落地。
> 7→8→9 再补「万一仍被挑战可自愈」。6 是独立风险点，需先做可行性验证。

---

## 6. 仍未验证的部分与风险

### 6.1 未验证（诚实标注）

1. **「切其他渠道模型依旧报这个错误」的机制未定案。**
   已确认的部分：**任何 start-plan 渠道**（`account:bigmodel-start-plan`、`account:zai-start-plan`）
   都会命中同一缺陷（守卫缺失是 provider 无关的），所以「换成 zai-start-plan 仍然 3007」可解释。
   **未确认**：切到**非 start-plan** 渠道（individual/team-coding-plan、自建 provider）是否也失败。
   理论上不应失败（官方与 CE 都短路自答、且这些渠道不受风控）。
   候选解释（均为**待验证假设**，本次未取到运行时证据）：
   - 用户实际切到的仍是 start-plan 族渠道；
   - UI 侧把上一轮 turn 的错误留在会话视图上（`chatErrorAttributionEvidence` 只做归因，未发现会话级错误持久化；
     `packages/ui/src/store/` 未搜到 `lastError` 之类的粘滞字段）；
   - 建议后续用真实会话复现并采集 `model_request_failed` 事件比对 `providerId`。
2. **「只能单开一个新会话」** 未定案。本次未找到会话级错误状态被持久化或 provider 被标记不可用的证据
   （`codingPlanProviderAvailability.ts` 的 `coding_plan_auth_failed` 只由**余额接口**的 401/403 触发，
   与模型请求的 3007 不是同一路径）。属**未验证**，需运行时日志确认。
3. **CE 的 claim 平面求解器能否复用到模型请求平面**未验证。
   官方渲染层用 `window.initAliyunCaptcha` + `allowInteractive:!0` + 120s 超时（`Htn`），
   而 CE 的 `manualClaimCaptcha` 走 Electron webview + 用户点击。
   模型请求平面需要**无交互预求解**（官方 `send_preflight` 就是预求解），这是**最大的实现风险点**。
4. **官方 3007 的确切触发阈值**未知（是「无 token」还是「token 过期/被风控」）。
   参考实现 `captcha-happy.ts:2209` 提到「degraded SDK result path and WILL 3007 upstream」，
   说明 token 质量也影响触发，但本次未取到线上证据。
5. **上游是否对 CE 有额外风控**（如客户端签名 `x-client-sig`/`x-client-pow`）未验证。
   `zcode.cjs` @3987074 的敏感头清单里同时出现 `x-client-sig`/`x-client-pow`/`x-aliyun-captcha-verify-param`，
   暗示除验证码外可能还有客户端签名校验；CE 是否有对应实现**本次未查**。

### 6.2 风险

- **越权/合规**：验证码是**平台风控**。以自动化方式（happy-dom 无头求解，如参考实现）绕过，
  可能违反服务条款。§5 的方案应在产品层面确认合规边界，而不是默认照搬参考实现的做法。
- **误改上游协议**：`zcode-protocol/index.ts` 是 Desktop↔Agent 的契约。
  加字段须保持向后兼容（`runtimeProviderHeaders` 用 `.optional()`；reason 枚举是**放宽**，安全）。
- **死字段陷阱**：`zcodeAgent.ts:267` 的 `runtimeProviderHeaders` 看起来「已经有了」，
  但它是 sendPrompt 入参、全仓无引用。改动时勿被它误导（§2.7 旁注）。
- **§5-1 的回归面**：把 start-plan 从「短路自答」改为「转发渲染层」后，
  **后台任务 / 无 pane 会话**将不再有 host 自答兜底——官方渲染层为此实现了请求合并（`m3` map）
  与取消（`Bnn`/`providerRuntimeHeadersCancelled`）。CE 若只改守卫不补这两条，
  会从「必然 3007」变成「180s 超时」（`provider-runtime-headers.ts:16`）。
  **这是本次修复最容易踩的坑。**

---

## 附：关键命令速查（复现用）

```bash
# 1. 官方 agent 的验证码重试类
node -e "const fs=require('fs');const s=fs.readFileSync('.reverse/94-account-capability/official-3.14.3/extracted/opt/ZCode/resources/glm/zcode.cjs','utf8');const i=s.indexOf('CaptchaRequestRetry');console.log(s.slice(i-500,i+900))"

# 2. 官方 host 的 start-plan 转发守卫（★）
node -e "const fs=require('fs');const s=fs.readFileSync('.reverse/94-account-capability/official-3.14.3/asar-out/out/host/index.js','utf8');console.log(s.slice(316100,316700))"

# 3. 官方 host 的验证码头合并
node -e "const fs=require('fs');const s=fs.readFileSync('.reverse/94-account-capability/official-3.14.3/asar-out/out/host/index.js','utf8');console.log(s.slice(356900,357700))"

# 4. 官方渲染层求解器与响应函数
node -e "const fs=require('fs');const s=fs.readFileSync('.reverse/94-account-capability/official-3.14.3/asar-out/out/renderer/assets/styles-DEELZGp2.js','utf8');console.log(s.slice(4174000,4176000))"

# 5. CE 模型请求平面 captcha 零命中
grep -rn 'CaptchaRequestRetry\|isCaptchaRejection\|captcha-retry' apps packages --include=*.ts --include=*.tsx | grep -v dist | grep -v zcode-server-cli

# 6. 开源检出（v3.14.3）captcha 零命中
cd .reverse/91-upstream-checkout/zai-org-ZCode && grep -rni 'captcha' --include='*' . | head

# 7. 参考实现的两种挑战变体
sed -n '1,30p' .reverse/07-reference/zcode-api/src/proxy/captcha-retry.ts
```
