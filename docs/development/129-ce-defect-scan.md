# CE 缺陷扫描报告（对照官方 3.14.3 裁剪面）

- 调查人：r4-defect-scan（只读扫描，未改动任何源码）
- 日期：2026-09-25
- 工作目录：/home/sixiao/aicode/fix/ZCode-CE
- 参照系：`docs/development/126-start-plan-3007-root-cause.md`（已定案的「裁剪时把守卫写反」缺陷）
- 对照物：`.reverse/94-account-capability/official-3.14.3/asar-out/out/{host,renderer,main,scheduler}/` 与
  `.reverse/94-account-capability/official-3.14.3/extracted/opt/ZCode/resources/glm/zcode.cjs`（官方 3.14.3）

## 开工前读过的材料（一致性声明）

| 材料                                                               | 结论                                                                                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`（根 + `apps/zcode-cli/AGENTS.md`）                     | —（规则）                                                                                                                                           |
| `docs/development/126-start-plan-3007-root-cause.md`               | **基本一致**；对 §5-1 的修复顺序（D1）、§6.2 的风险形态（D1）、§5-9 的 UI 归因必要性（C3）**有三处订正**；§2.7 的死字段旁注（C1）**经独立复核一致** |
| `docs/development/128-reference-proxy-parity.md`                   | 一致（引用其 §222 对 3007 归因的处置）                                                                                                              |
| `.reverse/91-upstream-checkout/zai-org-ZCode/`（v3.14.3 开源检出） | 一致：CE 相对该检出的协议差异极小（79 行 diff），**captcha 三段链路在开源基线里本就不存在**，说明它是官方闭源打包期的补丁，不是 CE 裁掉的           |

---

## 1. 摘要表

| #      | 严重度 | 一句话                                                                                                                                                                                     | 文件:行号                                                                                                                                              | 与 3007 同模式                 |
| ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| **D1** | **高** | CE 的 host **没有渲染层应答入口**：runtime-headers 请求只有「账号短路自答」和「立即失败」两个出口，**只改 126 §5-1 的守卫会让 start-plan 从「必然 3007」变成「必然立即失败」**，而不是变好 | `packages/services/src/zcode-agent/zcodeAgentService.ts:2266`、`:2275-2281`；官方对照 `host/index.js` @356111                                          | ✅ 同模式（分支被简化）        |
| **A1** | **高** | 协议响应 schema 缺 `runtimeProviderHeaders` 字段，且两分支都是 `.strict()` —— 渲染层即便回传也会被 zod 拒绝                                                                                | `packages/shared/src/zcode-protocol/index.ts:2424-2445`                                                                                                | ✅ 同模式（字段级裁剪）        |
| **A2** | 中     | reason 枚举缺 `captcha-retry`（已知，126 §2.7[1]）                                                                                                                                         | `packages/shared/src/zcode-protocol/index.ts:2395`                                                                                                     | ✅                             |
| **C1** | 中     | 死字段 `runtimeProviderHeaders`（已知，126 §2.7 旁注）；含测试在内全仓 **0 引用**                                                                                                          | `packages/services/src/zcode-agent/zcodeAgent.ts:267`                                                                                                  | ❌（接线断）                   |
| **C2** | 中     | 死字段 `rulesRevision`：官方 host 会回填、CE 的 session 映射器**从不写**它，全仓 0 引用                                                                                                    | `packages/shared/src/zcode-protocol/index.ts:928`；生产点 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts:265-267`             | ❌（接线断）                   |
| **C3** | 中     | **`packages/ui/src/lib/chatErrorAttribution.ts` 整模块是死代码**（唯一导出 `resolveTelemetryAttribution` 全仓 0 引用）。⇒ 126 §5-9「UI 归因误导用户去重新登录」**在 CE 当前不成立**        | `packages/ui/src/lib/chatErrorAttribution.ts:177`                                                                                                      | ❌（接线断，**订正既有文档**） |
| **C4** | 低     | `getProviderBusinessErrorUiAction` / `isProviderBusinessErrorCode` 死代码（0 引用）；⇒ 3007 的「恢复动作」表整体未被消费                                                                   | `packages/ui/src/lib/providerBusinessError.ts:78`、`:94`                                                                                               | ❌（接线断）                   |
| **A3** | 中     | 协议 `automation/create`、`automation/update` 参数缺 `botDeliveryTarget`（官方**保留**该字段），且 adapter 收到后**丢弃** ⇒ 机器人定时任务的回推地址无法持久化                             | `packages/shared/src/zcode-protocol/index.ts:3386-3401`、`:3428-3439`；丢弃点 `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`（0 命中） | ✅ 同模式（字段级裁剪）        |
| **D2** | 低     | 官方把 `CAPTCHA_VERIFY_FAILED` 码与三类文案变体都归一到 3007（`sw()`），CE 无此归一；但当前无消费者 ⇒ **无用户可感知影响**                                                                 | 官方 `styles-DEELZGp2.js` @1001224；CE 全仓 0 命中                                                                                                     | ✅                             |
| —      | —      | **A/B/C/D/E 五类中，A 类基本对齐（仅 3 处缺口）、D 类业务码表 47/47 完全一致**                                                                                                             | 见 §3                                                                                                                                                  | —                              |

> 严重度口径：**高** = 会造成功能整块失效或让既定修复方案失效；**中** = 能力静默缺失但当前无用户可感知路径，或属于修复前置；**低** = 有缺口但无消费者 / 无影响面。

---

## 2. 每条缺陷详情

### D1（高）host 没有渲染层应答入口 —— 单独修 126 §5-1 会让故障变成「立即失败」

**现象**
CE 的 `interaction/requestProviderRuntimeHeaders` 处理器只有两个出口：

1. `accountRequestAuthService && accountAccess` 为真 → `respondAccountRequestAuthWithoutInteraction`（账号短路自答，**不含验证码头**）；
2. 否则 → **删除 pending 并立即回 `headersApplied:false`**（快速失败）。

**没有任何第三条路径**能让渲染层回传 headers：CE 全仓 **0 命中** `respondProviderRuntimeHeaders`，
而官方 host 的 `createZCodeSessionService` 上就有这个方法（`respondProviderRuntimeHeaders(f){return e.respondProviderRuntimeHeaders(f)}`），
它是渲染层应答的唯一入站 API。

**证据**

```bash
# CE：只有两个出口，没有第三条
sed -n '2266,2282p' packages/services/src/zcode-agent/zcodeAgentService.ts
# 2266:          if (accountRequestAuthService && accountAccess) {
# 2267-2268:        // Account API Key / Team Runtime Key / Start Plan JWT 都不需要 Renderer 交互。
# 2269-2272:        void respondAccountRequestAuthWithoutInteraction({ ... }); return;
# 2275:          // 没有账号凭据解析器的请求无人应答只会滞留到 CLI 侧 180s 超时，直接快速失败。
# 2276:          pendingProviderRuntimeHeaders.delete(pendingKey);
# 2277-2280:      void pending.client.respond(pending.protocolRequestId, {
#                       headersApplied: false,
#                       errorMessage: "Provider request auth is unavailable" });

# CE 无渲染层应答入口（0 命中）
grep -rn "respondProviderRuntimeHeaders" packages apps --include=*.ts --include=*.tsx | grep -v dist
# → 无输出

# 官方有该入口（host 侧，3 处）
node -e "const fs=require('fs');const s=fs.readFileSync('.reverse/94-account-capability/official-3.14.3/asar-out/out/host/index.js','utf8');console.log(s.slice(356111,356320))"
# → async respondProviderRuntimeHeaders(m){let x=lC(m),z=pe.get(x); ... z.client.respond(z.protocolRequestId,{headersApplied:!0,requestAuth:G})}
```

**影响**
把 `zcodeAgentService.ts:2266` 的守卫按 126 §5-1 收紧成 `... && accountAccess.mode !== "start-plan"` 之后，
start-plan 请求会**掉进 2275-2281 的快速失败分支**：
用户看到的将是 `headersApplied:false / "Provider request auth is unavailable"`（几乎瞬时），
**不是** 126 §6.2 预判的「180s 超时」。

⇒ 126 §6.2 的风险预判方向对（修守卫不够），但**具体形态要订正**；
更重要的是 §5 的修复顺序「1→2→3→4 先打通带验证码头发出」**不成立**：
1（守卫）与 5（渲染层接线）+「渲染层应答入口」必须**同一个提交**上线，否则等于把「必然 3007」换成「必然立即失败」，用户可感知结果更差（错误文案更含糊）。

**修复方向**
在 `zcodeAgentService` 的 service 面上补一个与官方同形的 `respondProviderRuntimeHeaders`（入参 requestId/sessionId/workspace/response），
作为 pending map 的**第三条出口**；它与 126 §5-1/§5-4 必须原子提交。

**置信度**：已确认（代码路径穷尽，CE 侧 0 命中 + 官方 3 处实体对照）。

---

### A1（高）协议响应 schema 缺 `runtimeProviderHeaders`

**现象**：`zcodeProviderRuntimeHeadersResponseSchema` 的 `headersApplied:true` 分支只有 `requestAuth` + `errorMessage`，两分支均 `.strict()`。
渲染层回传 `{headersApplied:true, runtimeProviderHeaders:{...}}` 会被 zod 判非法。

**证据**

```bash
sed -n '2424,2446p' packages/shared/src/zcode-protocol/index.ts
# 2424: export const zcodeProviderRuntimeHeadersResponseSchema = z.discriminatedUnion("headersApplied", [
# 2427-2439: headersApplied: z.literal(true) → { requestAuth, errorMessage } .strict()
# 2440-2444: headersApplied: z.literal(false) → { errorMessage } .strict()
# → 两分支都没有 runtimeProviderHeaders

# 官方渲染层确实回传该字段
node -e "const fs=require('fs');const s=fs.readFileSync('.reverse/94-account-capability/official-3.14.3/asar-out/out/renderer/assets/styles-DEELZGp2.js','utf8');const i=s.indexOf('runtimeProviderHeaders');console.log(s.slice(i-160,i+120))"
# → response:r?{headersApplied:!0,runtimeProviderHeaders:r}:{headersApplied:!1,...}
```

（已知项，126 §2.7[1] 已记录，此处给出精确行号与官方对照。）

**影响**：修复时若只补 host 转发不补 schema，渲染层的回传会在 CLI 侧校验被拒 → `-32602`。
**修复方向**：`headersApplied:true` 分支加 `runtimeProviderHeaders: z.record(nonEmptyString, nonEmptyString).optional()`（向后兼容）。
**置信度**：已确认。

---

### A2（中）reason 枚举缺 `captcha-retry`

**证据**

```bash
grep -n 'z.enum(\["model-request"\])' packages/shared/src/zcode-protocol/index.ts
# 2395: export const zcodeProviderRuntimeHeadersRequestReasonSchema = z.enum(["model-request"]);
# 官方：M([`model-request`,`captcha-retry`])  — 见 126 §2.2 / styles-DEELZGp2.js @225995 区
```

**影响**：已知（126 §3 假设 B：当前不会走到，但补重试时必须先补）。属**修复前置**，不是当前故障原因。
**修复方向**：放宽为 `["model-request","captcha-retry"]`（放宽枚举安全）。
**置信度**：已确认。

---

### C1（中）死字段 `runtimeProviderHeaders`（`ZCodeAgentSendPromptParamsBase`）

**证据**

```bash
grep -n "runtimeProviderHeaders?: Record<string, string>" packages/services/src/zcode-agent/zcodeAgent.ts
# 267:  runtimeProviderHeaders?: Record<string, string>;
# 含测试的全仓引用计数 = 0（排除声明文件自身）
```

**影响**：它是 sendPrompt 入参、与 runtime-headers **响应**无关；修复时极易被误认为「已有能力」。
**修复方向**：接入或删除（126 §5-10 已列）。
**置信度**：已确认。

---

### C2（中）死字段 `rulesRevision`

**现象**：官方 `resolveSessionRuntimePreferences` 返回该字段（`host/index.js` @1370220 附近 `modelContextBudgetStrategy` 同段），
CE 的 `mapSessionSettings` 只回 `permission:{mode}`，**从不写 `rulesRevision`**，全仓 0 引用。

**证据**

```bash
grep -n "rulesRevision" packages/shared/src/zcode-protocol/index.ts
# 928:        rulesRevision: z.number().int().nonnegative().optional(),

grep -rn "rulesRevision" packages apps --include=*.ts --include=*.tsx | grep -v dist
# → 仅 index.ts:928 一处（含测试）

sed -n '265,267p' apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts
# 265:    permission: {
# 266:      mode: app.getMode(),
# 267:    },
```

**影响**：协议声明了一个永不出现的字段。若 UI 将来按它做「权限规则已变更」判定，会永远读到 undefined。
当前无消费者 ⇒ 用户不可感知。
**修复方向**：接入（由 CLI 回填 rulesRevision）或删除声明，二选一，勿留悬空。
**置信度**：已确认（引用计数 + 生产点缺失双向验证）。

---

### C3（中）`chatErrorAttribution.ts` 整模块死代码 —— **订正 126 §5-9**

**现象**：`packages/ui/src/lib/chatErrorAttribution.ts` 唯一导出 `resolveTelemetryAttribution` 全仓 **0 引用**（含测试）。
它在官方由 `chatErrorBannerTelemetry.ts` 消费，而后者在 CE **整文件不存在**（官方上游检出里有该文件，CE 无）。

**证据**

```bash
grep -rn "resolveTelemetryAttribution" . --include=*.ts --include=*.tsx | grep -v node_modules | grep -v '\.reverse' | grep -v dist
# → 仅 packages/ui/src/lib/chatErrorAttribution.ts:177（自身声明）

# 官方上游有消费者，CE 无
grep -rn "resolveVisibleChatErrorTelemetryRecoveryAction" .reverse/91-upstream-checkout/zai-org-ZCode/packages --include=*.ts
# → .../ui/src/lib/chatErrorBannerTelemetry.ts:44
#    .../ui/src/v4/telemetry/conversationTelemetrySupervisor.ts:1325

grep -rn "chatErrorBannerTelemetry" packages apps --include=*.ts | grep -v dist
# → 无输出
```

**影响 / 对既有文档的订正**：
126 §5-9 与 §2.8 把 `chatErrorAttributionEvidence.ts:52` 的 `"3007":"auth_failed"` 列为「会误导用户去重新登录」，
**在 CE 当前不成立**：该表只被死模块 `chatErrorAttribution.ts` 引用，不进入任何用户可见输出。
⇒ 它**不应**排进 ce.3-fix.1 的必改项，应按「随死代码一并处理」处置（要么整块删除，要么等遥测链路恢复时再改）。
（`packages/development/128-reference-proxy-parity.md:222` 把它列为需同步项，同样应降级。）

**修复方向**：整块删除 `chatErrorAttribution.ts`（连同其 9 个 evidence 导出），或明确标注「遥测链路移除后的遗留，待恢复」。
**置信度**：已确认（引用计数穷尽，含测试与 `.reverse` 排除）。

---

### C4（低）`providerBusinessError.ts` 的「恢复动作」表整体未被消费

**证据**

```bash
grep -rn "getProviderBusinessErrorUiAction\|isProviderBusinessErrorCode" packages apps --include=*.ts --include=*.tsx | grep -v dist
# → 仅 providerBusinessError.ts 自身（:78 定义、:88/:94/:97 自用）
```

被真正消费的只有 `getProviderBusinessErrorMessageId`（ChatErrorBanner.tsx:81）与
`resolveOffPeakTicketExpiredBusinessCode`/`isSuspiciousEmptyModelResultMessage`（同文件）。

**影响**：`PROVIDER_BUSINESS_ERROR_UI_ACTIONS`（含 `"3007": null`、`"3002":"retry-later"` 等）当前不驱动任何 UI。
⇒ 与 3007 相关的「恢复动作」缺口（官方 3007 → `retry-captcha`）**目前无用户可感知影响**；
但它与 D2 一样，是修复链路接通后**必须同时补齐**的部分。
**修复方向**：随 D1/126 §5 一并决定「接回还是删除」，不要单独改。
**置信度**：已确认。

---

### A3（中）`botDeliveryTarget` 被从协议删除、且 adapter 丢弃

**现象**：官方 `automation/create` 参数含 `botDeliveryTarget:nh.optional()`；CE 的同名 schema **没有该字段**，
且 `zcodeTaskServiceAdapter` 收到 `botDeliveryTarget` 后**不向下传递**（0 命中）。

**证据**

```bash
sed -n '3386,3401p' packages/shared/src/zcode-protocol/index.ts   # automationCreate：无 botDeliveryTarget
sed -n '3428,3439p' packages/shared/src/zcode-protocol/index.ts   # automationUpdate：无 botDeliveryTarget

# 官方保留该字段
node -e "const fs=require('fs');const s=fs.readFileSync('.reverse/94-account-capability/official-3.14.3/asar-out/out/renderer/assets/src-BkoFK6Bn.js','utf8');console.log(/botDeliveryTarget:\w+\.optional\(\)/.test(s))"
# → true

# CE：生产端有，消费端丢
grep -rn "botDeliveryTarget" packages/services/src/bots/botsService.ts | head
# 4821:    botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget,
# 4834:          botDeliveryTarget,
grep -c "botDeliveryTarget" packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts
# → 0
```

**影响**：机器人（Telegram/飞书/微信）创建的**定时任务**无法把回推地址带到运行时；
cron 触发的运行缺少稳定回推目标。官方另有 `watchCronRunBotDelivery`（CE 全仓 0 命中）作为配套。
**修复方向**：先确认 CE 的 cron→bot 回复是否走 `watchTaskStream` 兜底（`botsService.ts:3692`）；
若是，则这是有意裁剪（应记入 official-diff）；若不是，则需补回协议字段与传递链。
**置信度**：**可疑待验证**（静态证据充分，但「用户是否真的收不到回推」需运行时确认）。

---

### D2（低）3007 的挑战码归一缺失

**证据**：官方渲染层 `sw(e,t)` 把 `code==="3007"`、`"CAPTCHA_VERIFY_FAILED"` 与三类文案变体统一归到 3007
（`styles-DEELZGp2.js` @1001224 附近），CE 全仓 **0 命中** `CAPTCHA_VERIFY_FAILED` / `verify token was rejected`。
**影响**：因 C3/C4（归因表死代码），当前无用户可感知影响；属修复前置。
**置信度**：已确认（缺口存在）；影响面 = 无（已确认）。

---

## 3. 明确排除的类目（避免重复劳动）

### A. 协议/契约裁剪缺口 —— **基本对齐，仅 3 处缺口**

方法与结果（都是穷尽比对，不是抽样）：

| 比对项                                | 官方       | CE                    | 结论                                                                                                                                                            |
| ------------------------------------- | ---------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议方法表                            | 74         | 74                    | **逐项完全相同**（含 `interaction/*`、`session/*`、`provider/*`、`plugins/*`）                                                                                  |
| session 事件枚举                      | 25         | 25                    | **完全相同**                                                                                                                                                    |
| 协议对象字段名集合                    | 640        | 12929（全 shared 面） | 差集 27 项，**26 项是我的正则误抓枚举 key**（如 `sessionSend`/`pluginsInstall`），真正字段缺口仅 `botDeliveryTarget`、`runtimeProviderHeaders`、`rulesRevision` |
| zod 枚举值逐项                        | 286 个枚举 | —                     | **只有 2 处部分缺失**：`captcha-retry`（A2，真缺口）、`done`（CE 在 `zcode-protocol-v4/sessions-index-workflow-activity.ts:32` 有同值，非缺口）                 |
| CE 相对开源检出（v3.14.3）的协议 diff | —          | 79 行                 | 仅 4 处：`disabledTools`(+)、`dangerousCommandPolicy`(+)、`botDeliveryTarget`(−×2)、常量收敛；**无其它静默裁剪**                                                |

复现命令：

```bash
# 方法表差集（输出为空 = 完全一致）
node -e "
const fs=require('fs');
const s=fs.readFileSync('.reverse/94-account-capability/official-3.14.3/asar-out/out/renderer/assets/src-BkoFK6Bn.js','utf8');
const st=s.indexOf('var Uv={runtimeCapabilities:');const blk=s.slice(st,s.indexOf('};',st));
const off=new Set([...blk.matchAll(/([a-zA-Z0-9_]+):`([^`]+)`/g)].map(m=>m[2]));
const ce=fs.readFileSync('packages/shared/src/zcode-protocol/index.ts','utf8');
const b=ce.slice(ce.indexOf('export const zcodeProtocolMethods = {'));const e=b.slice(0,b.indexOf('} as const;'));
const c=new Set([...e.matchAll(/([a-zA-Z0-9_]+):\s*\"([^\"]+)\"/g)].map(m=>m[2]));
console.log('official',off.size,'CE',c.size,'official-only',[...off].filter(x=>!c.has(x)));
"
```

### B. 条件判断写反/丢失 —— **除已定案的 2266 外，未发现第二处**

- grep 全部 `if (x && y) { ... return; }` 短路分支（`packages/services/src/zcode-agent/`、`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/`、`core/src/runtime/methods/`）后，
  逐条核对注释与条件自洽性：**只有 `:2266` 一处注释（「不需要 Renderer 交互」）与官方语义（start-plan 需要 Renderer 交互）冲突**。
- 唯一另一条「不参与 UI」的注释在 `:2285`（官方 MCP 身份头），**与官方一致**：官方该分支同样不 emit、不进 pending、直接 `respond`。
- 官方 host 的 15 个 request 分支与 CE 逐一对齐（含 `sessionRequestRuntimePreferences` 的 local/forward 双路，CE `zcodeAgentService.ts:2103-2166` 与官方 @314xxx 语义一致，含超时与 `expireSessionRuntimePreferencesRequest`）。

### C. 死代码/死字段 —— **已穷尽，共 4 项**（C1–C4）

- 方法：对协议全部 537 个字段名做全仓（3954 个 `.ts/.tsx`，含测试）引用计数，
  「仅声明文件自身出现」= 1 项（`rulesRevision`）；「仅 1 个外部文件引用」= 21 项，
  逐项核对后**全部是合理的单一生产者/消费者对**（如 `cliRssKb`→`bash-resource-telemetry.ts`、`traceparent`→`network-capture.ts`），非死字段。
- 对 UI/核心 lib 的导出做引用计数，命中 C3（整模块死）与 C4（2 个函数死）。
- `runtimeProviderHeaders`（C1）与 126 §2.7 旁注一致。

### D. 3007 相邻的错误分类/重试语义 —— **业务码表逐项一致，无第二处缺陷**

| 比对项                                                           | 官方     | CE       | 结论                                                                            |
| ---------------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------- |
| 业务码映射表（码→reason/retryable）                              | 47 条    | 47 条    | **0 处差异**（含 `3007→AuthFailed/retryable:false` 这一条官方**本身就是如此**） |
| workflow 配额码集                                                | 18 项    | 18 项    | **完全一致**                                                                    |
| workflow not-configured 错误码集                                 | 5 项     | 5 项     | **完全一致**                                                                    |
| workflow stop 判定函数 `tVr`/`resolveWorkflowModelFailurePolicy` | 7 条分支 | 7 条分支 | **逐条一致**（含 `InvalidModelResponse` 例外）                                  |
| 分类器 401/403 → AuthFailed/retryable:false                      | 有       | 有       | **一致**                                                                        |
| UI 归因表 `PROVIDER_CODE_FAILURE_REASONS`                        | 39 条    | 39 条    | **0 处差异**                                                                    |

⇒ **关键结论**：126 §5-8 说的「分类修正」**不是 CE 独有的裁剪**——官方的 3007 也映射成 `AuthFailed + retryable:false`。
官方之所以不出问题，是因为它在 **agent 层用 `CaptchaRequestRetry.claim()` 在分类器之前拦截了 3007**（`claim` 命中则 `continue`，不走 throw）。
因此修复的正确落点是 **agent 侧的重试拦截**（126 §5-7），而**不是**改业务码表；
改表反而会偏离官方语义。这一点建议写进 ce.3-fix.1 的方案说明。

复现命令：

```bash
# 业务码表差集（输出 "(none)" = 完全一致）
node -e "
const fs=require('fs');
const off=fs.readFileSync('.reverse/94-account-capability/official-3.14.3/extracted/opt/ZCode/resources/glm/zcode.cjs','utf8');
const st=off.indexOf('GDe=new Map([[');const en=off.indexOf(']]);',st);
const om=new Map([...off.slice(st,en+4).matchAll(/\[\"([^\"]+)\",\{([^}]*)\}\]/g)].map(m=>[m[1],(/reason:_s\.(\w+)/.exec(m[2])?.[1]??'?')+'|'+(/retryable:!0/.test(m[2]))]));
const win=off.slice(st-1200,en+1200);const vd={};
for(const m of win.matchAll(/([\w$]+)=\{code:[\w$.]+,\s*reason:_s\.(\w+),\s*retryReason:[\w$.]+,\s*retryable:(!0|!1)\}/g)) vd[m[1]]=m[2]+'|'+(m[3]==='!0');
for(const m of win.matchAll(/for\(let e of\[([^\]]+)\]\)GDe\.set\(e,([\w$]+)\)/g)) for(const c of m[1].matchAll(/\"([^\"]+)\"/g)) om.set(c[1],vd[m[2]]);
const ce=fs.readFileSync('apps/zcode-cli/packages/adapters/src/model/failure-provider-business-codes.ts','utf8');
const b0=ce.indexOf('PROVIDER_BUSINESS_CODE_MAPPINGS = new Map'),b1=ce.indexOf('\n]);',b0);const cm=new Map();
for(const m of ce.slice(b0,b1).matchAll(/\[\s*\"([^\"]+)\",\s*\{([\s\S]*?)\n\s*\},\s*\]/g)) cm.set(m[1],(/ModelFailureReasonValue\.(\w+)/.exec(m[2])?.[1]??'?')+'|'+(/retryable:\s*(true|false)/.exec(m[2])?.[1]??'?'));
console.log('official',om.size,'CE',cm.size);
const d=[...new Set([...om.keys(),...cm.keys()])].filter(k=>om.get(k)!==cm.get(k));
console.log(d.length?d.map(k=>k+' off='+om.get(k)+' ce='+cm.get(k)).join('\n'):'(none)');
"
```

### E. 其它高危项 —— **部分扫描，未穷尽**

已做：`.catch(() => {})` / `.catch(() => undefined)` 全仓扫描（`packages/services/src`、`apps/zcode-cli/packages/{bootstrap,adapters}/src`）。
结果：命中集中在**清理路径**（`rm` 临时目录、`unlink` 锁文件、`realpath` 探测、`dispose` 链），
属有意的「清理失败不掩盖主流程」，**未发现吞掉主流程错误的实例**。
未做（本轮未覆盖，标注为**未扫描**）：竞态/超时上限/缓存失效三个子类的系统性排查；
`packages/desktop/src/main` 与 `packages/server` 的入站面。

### 明确判为「有意裁剪、非缺陷」的项

| 项                                                                                                                                                                                      | 依据                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outputStyle` 能力整块缺失（CE 有 core 消费面 `context/sections/identity.ts`、`methods/config.ts:65`，但无生产者；官方有 `createOutputStyleService`/`getActiveStyle`/`setActiveStyle`） | **有意**：CE 显式把 `outputStyles` 列入 `UNSUPPORTED_MANIFEST_FIELDS`（`adapters/src/plugins/marketplace.ts:66`）与 `diagnosticOnly`（`bootstrap/src/zcode-protocol/plugins.ts:481`）。属产品面裁剪，不是遗漏 |
| CUA Helper 安装/签名整族（`resolveCuaHelper*`、`verifyCuaHelperBundle` 等 30+ 个官方函数名 CE 0 命中）                                                                                  | **有意**：CUA Helper 是私有二进制，AGENTS.md 明确「仅发编译产物、多数不能搬」                                                                                                                                 |
| 遥测链路（`chatErrorBannerTelemetry`、`conversationTelemetrySupervisor`、`registerHost*Telemetry`）                                                                                     | **有意**：`docs/development/telemetry.md` 记录了 P1 遥测移除（`@arms/rum-*`、`@opentelemetry/*` 清理）。C3/C4 是它的**副作用**（死代码残留），已单列                                                          |
| `computer-use/operation-event` 在 CE 的 request 侧无 handler                                                                                                                            | **非缺陷**：它是 agent→host 的**通知**（`zcodeAgentService.ts:1941` 已消费），不需要 request handler。我的方法表比对里它只出现在通知侧                                                                        |
| 官方 MCP 身份头「不 emit、不进 pending」（`zcodeAgentService.ts:2285`）                                                                                                                 | **与官方一致**，非缺陷（对照 `host/index.js` @316xxx 同段）                                                                                                                                                   |

---

## 4. 修复优先级（围绕官方三段式链路，ce.3-fix.1）

前提（Lead 已拍板）：**走官方路径，验证码由用户手动完成，不引入无头求解器**。以下顺序据此排列。

| 优先级         | 项                                                                                                   | 理由                                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0**         | **D1 + 126 §5-1 + §5-4 + §5-5 必须同一提交**                                                         | D1 证明「只改守卫」会让 start-plan 从「必然 3007」变成「必然立即失败（headersApplied:false）」。守卫、渲染层应答入口、渲染层求解接线、host 头合并是一个不可分割的原子单元              |
| **P0**         | A1（响应 schema 加 `runtimeProviderHeaders`，optional）                                              | 不加则渲染层回传在 CLI 侧被 `-32602` 拒绝，P0 链路仍然不通                                                                                                                             |
| **P1**         | A2（reason 枚举加 `captcha-retry`）+ 126 §5-7（agent 侧 `isCaptchaRejection`/`CaptchaRequestRetry`） | **不要把 126 §5-8「分类修正」当成改业务码表**：官方 3007 同样是 `AuthFailed+retryable:false`（见 §3-D），正确落点是 agent 层在分类器之前拦截并 `continue` 重试一次。改表会偏离官方语义 |
| **P2**         | C1（死字段 `runtimeProviderHeaders`）、C2（`rulesRevision`）、C4（恢复动作表）                       | 都是「接线断」，随 P0/P1 一并决定接入或删除；**单独改无收益且会误导后续维护者**                                                                                                        |
| **P2（降级）** | 126 §5-9 / 128 §222 的 `"3007":"auth_failed"`                                                        | **从必改项降级**：C3 证明该表当前无消费者（`chatErrorAttribution.ts` 整模块死代码），改它**不改变任何用户可见行为**。应改为「随遥测链路恢复时一并处理」                                |
| **P3**         | A3（`botDeliveryTarget`）                                                                            | 先做运行时验证（cron→bot 回推是否被 `watchTaskStream` 兜底），确认后再决定补回还是记入 official-diff                                                                                   |
| **P3**         | D2（`CAPTCHA_VERIFY_FAILED` 归一）                                                                   | 与 P2 同批，无独立收益                                                                                                                                                                 |
| **不入本版**   | C3（删除 `chatErrorAttribution.ts` 整模块）                                                          | 属清理，与 3007 修复无耦合；可放入 ce.3 的常规清理                                                                                                                                     |

**上线判据建议**：P0 合并后必须实测「start-plan 首次请求 → 用户完成验证码 → 请求带 `X-Aliyun-Captcha-Verify-Param` 发出」这条完整链路，
不能只验「不再 3007」（D1 的反例正是「错误更快地失败」也算『不再 3007』）。

---

## 5. 未穷尽与剩余风险（诚实标注）

1. **A3 的用户可感知影响未验证**：静态证据链完整（协议缺字段 + adapter 丢弃），但未在真实机器人上验证定时任务回推是否真的丢失。
2. **E 类未穷尽**：竞态、超时上限、缓存失效三个子类未做系统性排查；`packages/desktop/src/main` 与 `packages/server` 的入站面未扫描。
3. **官方 asar 的 zod schema 提取是启发式的**：我用「字段名集合差集 + 枚举值逐项比对」两条独立路径交叉验证，
   两者结论一致（A 类仅 3 处缺口），但**不能排除**官方用非字面量方式构造的 schema 被漏掉。
4. **`runtimeProviderHeaders` 在官方 asar 的 host/renderer 里没有 zod 声明**（只在 `zcode.cjs` 之外的运行时构造中出现）——
   即官方是「宽进」而 CE 是「严出」。这不影响 A1 的结论（CE 侧确实会拒），但说明官方 CLI 对该响应可能不做严格校验，
   修复时不必过度设计。
5. **本轮为纯静态扫描**，未启动应用、未跑测试；所有「影响」判断均为代码路径推演。

## 附：关键复现命令

```bash
# D1：CE 只有两个出口 + 无渲染层应答入口
sed -n '2266,2282p' packages/services/src/zcode-agent/zcodeAgentService.ts
grep -rn "respondProviderRuntimeHeaders" packages apps --include=*.ts --include=*.tsx | grep -v dist
node -e "const fs=require('fs');const s=fs.readFileSync('.reverse/94-account-capability/official-3.14.3/asar-out/out/host/index.js','utf8');console.log(s.slice(356111,356320))"

# A1 / A2：协议缺口
sed -n '2395p;2424,2446p' packages/shared/src/zcode-protocol/index.ts

# C2：rulesRevision 死字段
grep -rn "rulesRevision" packages apps --include=*.ts --include=*.tsx | grep -v dist

# C3：归因模块死代码
grep -rn "resolveTelemetryAttribution" . --include=*.ts --include=*.tsx | grep -v node_modules | grep -v '\.reverse' | grep -v dist

# A3：botDeliveryTarget 生产端 vs 消费端
grep -rn "botDeliveryTarget" packages/services/src/bots/botsService.ts
grep -c "botDeliveryTarget" packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts

# 官方 vs CE 协议整体 diff（仅 79 行）
diff -u .reverse/91-upstream-checkout/zai-org-ZCode/packages/shared/src/zcode-protocol/index.ts \
        packages/shared/src/zcode-protocol/index.ts
```
