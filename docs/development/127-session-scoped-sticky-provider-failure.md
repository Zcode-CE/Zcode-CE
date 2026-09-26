# 会话级粘滞失败：为什么「切渠道仍报错、只能新开会话」

- 调查人：r2-sticky-failure（独立复核）
- 日期：2026-09-25
- 范围：只读调查，未改动任何源码
- 工作目录：/home/sixiao/aicode/fix/ZCode-CE
- 前置文档：`docs/development/126-start-plan-3007-root-cause.md`（3007 = 阿里云验证码挑战，CE 三段链路全缺）

## 开工前读过的材料与一致性声明

| 材料                                                 | 与我的结论是否一致                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/development/126-start-plan-3007-root-cause.md` | **一致**：3007 根因（host 守卫写反 + 无验证码链路 + 3007 分类为 AuthFailed）我复核无异议；该报告 §6.1 把「切渠道仍报错 / 只能新开会话」列为**未定案**，本报告正是补这一段 |
| `AGENTS.md`（根）                                    | —（规则）                                                                                                                                                                 |
| `packages/services` / `apps/zcode-cli` 源码          | 本报告结论全部由源码与打包产物直接取证                                                                                                                                    |
| Lead 的 pendingProviderRuntimeHeaders 排除           | **复核成立**（见 §3.1）                                                                                                                                                   |
| Lead 的 error-paused 线索                            | **部分命中**：机制真实存在且已发货，但**不是**「切渠道仍报错」的成因（见 §2.1、§4.1）                                                                                     |

---

## 1. 结论

**「切渠道后仍报错」在 CE 的既有实现里没有任何会话级粘滞状态所有者；用户观察到的现象由两个彼此独立的机制叠加而成：**

1. **「切渠道仍报错」= 用户切到的仍是 start-plan 族渠道（或被 UI 自动改写回 start-plan）**，
   而 3007 的根因是 **provider 无关**的 host 守卫缺陷 ⇒ 换哪个 start-plan 渠道都会得到同一个 3007。
   唯一所有者是 `account:*-start-plan` 这个**渠道族**本身（进程级 Provider Registry 的 Provider 定义），
   而不是任何缓存：CE 里**不存在**会话级 provider 失败缓存。
2. **「只能单开一个新会话」= 与模型无关的队列 held 状态**，所有者是
   **v4 conversation 投影的 `queue.autoDrain` 授权位**（会话级，事件日志持久化），
   它由 `onTurnError` 写成 `false` + `pauseReason:"error"`，而**任何 setModel / 切渠道路径都不碰它**，
   `session/setModel` 也一样。新会话有全新投影 ⇒ 自然绕过。

**为什么新会话能绕过**：新会话 = 新的 `ConversationProjection`（`queue = { items: [], autoDrain: true }`，
`projection-state.ts:84`）+ 新的 `heldQueue` 未触发 + 新的 runtime `queueAutoDrain = true`
（`agent-runtime.ts:216`）。两条机制都被重置。

**关于「唯一所有者」的精确表述**：

- 症状 2（切渠道无用）：**没有**所有者 —— 这是**设计缺口**（切换渠道不重置会话队列授权位），不是缓存 bug；
- 症状 3（必须新会话）：所有者 = **会话级 `queue.autoDrain`**（仅当失败时队列非空才被 held）。

---

## 2. 逐候选判定

### 2.1 Lead 的 error-paused 线索（product-projection.ts:2262）

**判定：部分命中 —— 机制真实、已随 3.14.3-ce.1/ce.2 发货，但对「切渠道仍报错」不成立；对「必须新开会话」成立。**

**(a) 触发条件（已确认，逐条读码）**

`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts:2279-2285`：

```ts
const heldQueue =
  this.snapshot.queue.items.length > 0
    ? { ...this.snapshot.queue, autoDrain: false, pauseReason: "error" as const }
    : undefined;
```

⇒ **必须 `queue.items.length > 0` 才 held**。空队列时 `heldQueue === undefined`，
`controlPatch(..., undefined, undefined)` 不写 queue（`product-projection.ts:5047`），
`queue.autoDrain` 保持原值（正常为 `true`）。
同一守卫也出现在 Stop 路径：`product-projection.ts:2185-2195`（`pauseReason:"stopped"`）。

**(b) 谁把 autoDrain 置回 true（已确认）**

全仓 `setAutoDrain(true)` 只有一条来源：**用户显式操作**。

| 位置                                                                                                                | 性质                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/ui/src/v4/SessionPane.tsx:3017-3031` `handleResumeQueue`                                                  | 用户点「恢复队列」按钮（`ConversationQueuePanel.tsx:306-320` → `onResume`，绑定在 `SessionPane.tsx:4278`）       |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts:131-142` `setAutoDrain` handler | 命令落地；`autoDrain:true` 时额外触发 `afterLegacyStateMutation(record,"queue_auto_drain_resumed")` 立即提升队首 |

**没有任何自动恢复路径。** 证据：`onQueueAutoDrainChanged`（`product-projection.ts:3728-3749`）是
`QueueAutoDrainChanged` 事件的**唯一**投影入口，而该事件只由
`core/runtime/methods/steering.ts:1015-1037` 的 `setQueueAutoDrain()` 产生；
`setQueueAutoDrain` 的调用点只有三处，全是「置 false」或用户命令：
`session-flow.ts:343`（Stop，置 false）、`goal-compact.ts:179`（compact 失败，置 false）、
`queue.ts:137`（用户 setAutoDrain 命令）。
`onTurnComplete`（`:2146`）与 `onTurnStarted`（`:2078`）都**不**把 autoDrain 置回 true。

**(c) setModel 是否重置该授权位（已确认：不重置）**

`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts:2675-2683`：

```ts
export async function setModel(context, rawParams) {
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  await runSessionModelConfigMutation(record.app, async () => {
    await record.app.setModel(params.model);
  });
  return await afterStateMutation(context, record, "model_changed");
}
```

`afterStateMutation`（`:4013-4034`）只做 `ensureSessionModelAvailable` + `stateRevision++` +
`emitStateUpdated`（旧协议广播）；**不产生 `QueueAutoDrainChanged`**。
v4 命令面同理：`switchModelConfig`（`commands/handlers/model-config.ts:76-142`）只调
`app.setModel` + `emitModelSelected`，`emitModelSelected`（`steering.ts:1072-1112`）只追加
`ModelSelected`，投影 `onModelSelected`（`product-projection.ts:4344-4460`）只改 `config`，
**完全不碰 `queue`**（`grep -n "queue" product-projection.ts` 的 4344-4460 区间 0 命中）。

⇒ **坐实：切换模型/渠道不会重置 autoDrain。**

**(d) 但「切渠道仍报错」不是它造成的 —— 三条反证**

1. **held 需要队列非空，而用户是切渠道后再发新消息**：`computeInputRouting`
   （`projection-state.ts:157-183`）的 held 分支要求
   `completed && queueLength > 0 && !autoDrain`。
   若用户没有待发队列项（`items.length === 0`），`onTurnError` 根本不写 heldQueue，
   `phase="error"` 下 `completed === false` ⇒ 路由仍是 `startNow`。
2. **held 只改变「确认框」这一层，不阻断模型请求**：held 下 UI 返回
   `confirmationRequired`（`SessionPane.tsx:2402-2411`）→ 用户点「清空并发送 / 保留并发送」后
   走 `sendText` 正常 admission。更关键的是 **`queueAutoDrain` 不在 prompt admission 的判定里**：
   `core/runtime/methods/prompt-admission.ts:20-126` 只看 `hasActiveOrQueuedTurnWork()`，
   全文不含 `queueAutoDrain`（`grep -rn "queueAutoDrain" core/src` 命中仅
   `agent-runtime.ts:216`、`internal.ts:139`、`compact.ts:152`、`steering.ts:466/1024-1042`、
   `turn.ts:748/760`，**没有一处是 admission 门**）。
   ⇒ held 不可能让模型请求「不发出」。
3. **若真是 held，用户看到的是暂停横幅而不是 3007**：held 会在队列面板渲染
   `TID_V4_QUEUE_PAUSED_BANNER`（`ConversationQueuePanel.tsx:324-345`），
   且 `queue.items.length === 0` 时面板直接 `return null`（`:321`）。
   用户报的是「依旧会报这个错误」（同一条 3007 错误），不是「输入发不出去」。

**(e) 它与官方一致，不是 CE 回归**

同一段 `onTurnError` 的 `pauseReason:"error"` 在官方 3.14.3 agent 运行时里**逐字存在**：

```bash
node -e 'const s=require("fs").readFileSync(".reverse/94-account-capability/official-3.14.3/extracted/opt/ZCode/resources/glm/zcode.cjs","utf8");const n="pauseReason"+":\"error\"";console.log(s.split(n).length-1)'
# → 1（官方 bundle 命中）
```

CE 打包产物同样命中（3.14.3-ce.1 与 ce.2 各 1 次，位于 `onTurnError`）：

```bash
grep -c 'pauseReason' packages/desktop/mock-cdn/releases/3.14.3-ce.2/glm/linux-x64/zcode.cjs
```

⇒ 这是**上游既有设计**，CE 未引入。它构成一个独立的可用性缺口（见 §4.1），但不是 3007 的成因。

### 2.2 Provider Registry 缓存 / revision —— **排除（无会话级缓存）**

- `packages/provider/src/registry-service.ts:53-141`：`ProviderRegistryService` 是**进程级**单例，
  `#snapshot` 是 last-known-good，但它是**账号连接事实**的快照，不是「上次失败」的缓存；
  每次 `refresh` 都重读 config + account source（`:187-193`）。
- `packages/provider/src/account-provider-resolution.ts:127-137`：只有
  `connection.status === "unavailable"` 才写 `createEntitlementOverlay(false)`；
  `status === "unknown"` 保留上一份（`:132-134`）—— 这是「未知不降级」的**保守**设计，
  它保留的是**权益**而非「失败」。
- `accountProviderInvalidation.ts:10-14` 的触发集合确实只有 3 个 setting key
  （`providerFamilyDomain` / `providerFamilyConnectionSelections` / `zcodeEndpointOrigin`）——
  **切模型确实不在触发集合里**。但这条**与用户症状无关**：
  它决定的是「什么时候重查账号权益」，而**切模型不需要重查权益**（同一账号、同一连接）。
  切到另一个渠道（individual/team）会改 `providerFamilyConnectionSelections` ⇒ 会触发刷新。
  ⇒ 判定：**排除**（不是粘滞来源），但该设计边界值得在 §4.2 记为待对齐项。

### 2.3 会话级 model 绑定 —— **部分相关，但不是失败缓存**

- `packages/ui/src/v4/composer/useDraftConfigControl.ts:179-192`：`effectiveSelection` 来自
  `modelSelectionView.effectiveSelection`，而 `resolveEffectiveModelSelection`
  （`packages/provider/src/effective-model-selection.ts:17-77`）是**每次读取即时求值**，
  不缓存失败。`selectionIssue` 只有 `selection-missing` / `provider-not-found` /
  `model-not-found` / `account-connection-unavailable` / 档位类，**没有 auth/3007 类**。
- `provider-runtime-headers.ts:88-92` 注释提到的「provider registry revision 是 workspace 级全局状态」
  并发刷新问题：我复核了该注释所描述的机制（多个并发请求推进全局 revision），
  但**它是「误判 headers 未应用」的风险，不是「把失败粘在会话上」**：
  `refreshBeforeModelRequest`（`provider-runtime-headers.ts:29-97`）每次都新建
  `requestId`（`:30`，`randomUUID()`），pending 表键 = workspace + sessionId + requestId
  （`zcodeAgentService.ts:775-779`），无跨请求复用。
  ⇒ 判定：**排除**（跨请求污染需要键复用，此处键每次唯一）。

### 2.4 失败态固化 `systemDisabledReason` —— **排除**

- `packages/services/src/model-provider/legacyModelProviderSerialized.ts:223-231` 定义了
  `coding_plan_auth_failed` 枚举；
- `legacyZCodeConfigProviderReader.ts:683-686` 与 `legacyModelProviderSerialized.ts:716-718`
  **只做「读入并转发」**（`provider.systemDisabledReason ?? zcode?.systemDisabledReason`）；
- 全仓 grep `systemDisabledReason`（排除 dist）**没有任何写入点**：
  ```bash
  grep -rn "systemDisabledReason" --include=*.ts packages apps | grep -v dist | grep -v node_modules | grep -v "schema\|Schema"
  # → 只有类型声明与两处「读入转发」
  ```
- 且 `coding_plan_auth_failed` 的**唯一**产生点是**余额接口**的 401/403
  （`codingPlanProviderAvailability.ts:513-518` `classifyAvailabilityError`），
  与模型请求的 3007 是**两条完全不同的路径**（3007 走 adapter 的
  `failure-provider-business-codes.ts:100-108`）。
  ⇒ 判定：**排除**，且与用户「新会话正常」无矛盾（本来就没写入）。

### 2.5 workspace client / Local Host 生命周期 —— **排除**

- `zcodeAgentService.ts:1200-1237` `invalidateWorkspaceClient`：失效边界是 **workspace**（非 session）；
  它清理 pendingPermissions / pendingUserInputs / pendingProviderRuntimeHeaders / clientDisposables，
  并删除 `activeClientsByWorkspaceKey` 条目。
- `invalidateWorkspaceClient` 只在**进程换代 / transport 关闭 / dispose** 时触发
  （`:1245-1249` runtime lifecycle、`:2814`、`:2907`、`:3769`、`:5614`），
  **切模型不触发它**（`setModel` 只发 `session/setModel` 请求，见 §2.1(c)）。
  ⇒ 判定：**排除**（切模型不需要 client 换代，也不会因它产生粘滞）。

### 2.6 凭据缓存作用域 —— **排除**

| 缓存                                                                 | 作用域                                                                               | 键是否含失败                                                                | 判定                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------- |
| `zaiStartPlanBilling.ts:58-127` `inflightBalanceRequests`            | `WeakMap<ApiClient, Map<requestKey, Promise>>`，进程级但**1 秒内自清**（`:120-122`） | 键 = `{authorization, url}`，**存的是 Promise 不是失败**；失败同样只保留 1s | **排除**                   |
| `oauthUnauthorizedRequest.ts:21-65`                                  | 无状态函数（每次读凭据）                                                             | —                                                                           | **排除**                   |
| `accountProviderCredentialService.ts:36-63` `inFlight`               | 服务实例级 `Map`，`operation` settle 即删（`:56-61`）                                | 键 = `load/refresh:credentialKey`                                           | **排除**                   |
| `independentPlanSupport.ts:4-23` `checks`                            | `WeakMap<client, Promise>`，**失败时主动删除**（`:18`）                              | —                                                                           | **排除**                   |
| `usageEntitlementRefreshPolicy.ts:39-42` `entitlementFailureBackoff` | `WeakMap<service, Map<freshnessKey, ...>>`，**UI 侧**额度退避                        | 有失败计数，但只影响**额度面板刷新**，不参与模型请求                        | **排除**（不影响模型请求） |

### 2.7 复核 Lead 的 pendingProviderRuntimeHeaders 排除 —— **排除成立**

- 键：`zcodeAgentService.ts:775-779` = `workspaceKey\0sessionId\0requestId`；
- `requestId`：`provider-runtime-headers.ts:30` = `${sessionId}:provider-runtime-headers:${randomUUID()}`；
- 清理：正常应答 `finally` 删（`zcodeAgentService.ts:1303-1307`）；
  取消通知 `:1866-1881`（`providerRuntimeHeadersCancelled` → `cancelProviderRuntimeHeaders`）；
  client 失效 `:1208-1215`。
- **我额外复核了 Lead 点名的两条漏网路径，均不成立**：
  ① `respond` 抛错：`respondAccountRequestAuthWithoutInteraction` 的 `finally`
  （`:1303-1307`）无条件删除，与 `respond` 成败无关；
  ② 通知丢失：即便取消通知丢失，键含随机 `requestId` ⇒ **不会命中下一次请求**，
  最坏是泄漏一条 pending 记录（内存，非状态粘滞）。
  ⇒ **排除成立**。

---

## 3. 为什么「切渠道仍报错」—— 3007 的 provider 无关性（本报告的核心论证）

**这是排除法的结论：CE 里不存在会话级 provider 失败缓存（§2.2–§2.7 全部排除），
因此「换渠道仍失败」只能由「目标渠道本身也会失败」解释。**

- 3007 根因（126 号报告 §2.3）是 **host 转发守卫写反**：
  `zcodeAgentService.ts:2266` 的 `if (accountRequestAuthService && accountAccess)`
  丢掉了官方的一半条件 `accountAccess.mode !== "start-plan"`。
  该守卫**按 `mode` 判定，与 `family`（bigmodel / zai）无关**。
- ⇒ `account:bigmodel-start-plan` 与 `account:zai-start-plan` **都会命中同一缺陷**，
  两者共用同一个 ultra 网关风控（`official-coding-plan-gateway.ts:22-31` 两条路由）。
  用户「切其他渠道」若切的是 zai-start-plan，症状**必然复现**，且复现的是**同一条 3007**。
- ⇒ 「再切其他渠道的模型依旧会报这个错误」= **命中，所有者是 `account:*-start-plan` 渠道族**，
  修复点就是 126 号报告 §5-1（收紧 host 守卫）。

**一个可能让用户以为「切了渠道」其实没切的旁路（已确认存在，值得产品核对）**：
`packages/ui/src/hooks/useStartPlanRecommendation.ts:19-97` +
`packages/ui/src/lib/startPlanRecommendation.ts:18-45`：当用户选中**非 start-plan** 的 builtin 渠道
（`isBuiltinModelProviderId && !isStartPlanModelProviderId`），且 start-plan 余额快照在
60 秒内（`USAGE_ENTITLEMENT_ACCESS_REFRESH_MS`）显示**还有余额**时，UI 会弹窗**建议切回 start-plan**；
用户点「切换」后 `submission.modelSelection` 被改写为 start-plan（`SessionPane.tsx:2412-2420`）。
⇒ 用户主观上「我切到别的渠道了」，实际提交的仍是 start-plan。
（仅当用户点了确认；点「拒绝」并勾选「不再提示」则不会。**未验证**用户是否命中此路径。）

---

## 4. 状态所有者与事件顺序图

### 4.1 症状 3「只能新开会话」的所有者：会话级 `queue.autoDrain`

```
所有者: ConversationProjection.snapshot.queue.autoDrain   (会话级, 事件日志持久化)
         + AgentRuntime.queueAutoDrain                     (runtime 内存, 同会话)
范围:   单 session。新 session ⇒ 全新投影 + 全新 runtime ⇒ 自动恢复 true

时间线（失败时队列非空）
─────────────────────────────────────────────────────────────────────────────
 T0  用户发送 A                       phase=running,  queue={[], autoDrain:true}
 T1  start-plan 请求 → 3007           adapter: AuthFailed, retryable:false
 T2  workflow policy → stop/auth      (126 号报告 §2.8)
 T3  TurnError 事件
       ├─ core turn.ts:744-750        rebuildProjection().pendingSteerInputs.length>0
       │                              ⇒ runtime.queueAutoDrain = false        ★写1
       └─ 投影 onTurnError:2279-2285  queue.items.length>0
                                      ⇒ queue.autoDrain = false,
                                        pauseReason = "error"                  ★写2
 T4  computeInputRouting(projection-state.ts:177-182)
       completed? ✗ (phase="error" 不是 completed*) ⇒ startNow
       ★ 注意：error 相位下**不会**进入 held choice；只有 Stop 造成的
         completedInterrupted 才会。所以「error 后 held」只在**下一次 turn
         成功/取消收口**且队列仍非空时才真正表现为 held。
 T5  用户切渠道                      setModel / switchModelConfig
                                      ⇒ 只改 config.model, **不写 queue**  ✗未失效
 T6  用户再发 B
       ├─ 若 T2 后队列已空 ⇒ 正常发请求 ⇒ 若仍是 start-plan ⇒ **再次 3007**
       └─ 若队列仍有项 + phase 已 completed ⇒ inputRouting=choice
                                          ⇒ 弹「清空/保留」确认框（非报错）
─────────────────────────────────────────────────────────────────────────────
失效条件（唯一）: 用户显式点「恢复队列」⇒ setAutoDrain(true)
                  SessionPane.tsx:3017 → queue.ts:131 → steering.ts:1015
                  （自动路径：无。onTurnStarted/onTurnComplete 都不重置）
新会话为什么绕过: 新投影 queue={items:[],autoDrain:true}（projection-state.ts:84）
                  + 新 runtime queueAutoDrain=true（agent-runtime.ts:216）
```

**⚠️ 对 Lead 线索的一处更正**：Lead 说「error 后队列 held 导致再发消息不走到模型请求」。
按 `computeInputRouting` 的封闭定义，**`phase="error"` 不在 `completed` 集合里**
（`projection-state.ts:177-178` 只认 `completedSuccess`/`completedInterrupted`），
所以 error 相位本身**不产生 held choice**。held 只在
「error 之后又来了一次成功/取消收口的 turn（`onTurnComplete` 不改 autoDrain，
但 `phase` 变成 completed\*）+ 队列仍非空 + autoDrain 仍为 false」时才可见。
这不改变结论（切模型确实不重置授权位），但改变了用户可见形态：**用户看到的是确认框，
不是「发不出去」**，更不是「同一条 3007 错误」。

### 4.2 症状 2「切渠道仍报错」的所有者：**不存在**（设计缺口）

```
所有者: 无（CE 中不存在会话级 provider 失败缓存）
真实原因: account:*-start-plan 渠道族 × host 守卫按 mode 判定（provider 无关）
          ⇒ 换任一 start-plan 渠道都得到同一个 3007

切渠道时的失效面
─────────────────────────────────────────────────────────────────────────────
 切 family (bigmodel ↔ zai)        ⇒ 触发 accountProviderInvalidation（setting key
                                      providerFamilyDomain）⇒ 重查权益  ✓
 切 mode (start-plan ↔ individual) ⇒ 触发 providerFamilyConnectionSelections ⇒ 重查  ✓
 切 model（同渠道内换模型）        ⇒ 不触发任何刷新，也不需要  ✗（无害）
 ★ 三种切换都**不重置** queue.autoDrain（§2.1(c)）—— 这是症状 3 的缺口
 ★ 三种切换都**不能**让 start-plan 的 3007 消失 —— 这是症状 2 的成因
─────────────────────────────────────────────────────────────────────────────
```

---

## 5. 修复建议

### 5.1 症状 2（主因，P0）：修 host 转发守卫

唯一最小改动面：`packages/services/src/zcode-agent/zcodeAgentService.ts:2266` ——
把条件从「有 accountAccess 就短路自答」收紧为「**非 start-plan** 才短路自答」，
与官方 `mode !== "start-plan"` 对齐。配套 4 项（协议字段、reason 枚举、头合并、渲染层接线、
agent 重试、分类修正）见 126 号报告 §5；**本报告不重复展开，也无异议**。

### 5.2 症状 3（第二个 BUG，P1）：切渠道时重置会话队列授权位

**改哪个所有者**：`ConversationProjection.snapshot.queue.autoDrain`（会话级）。

**为什么这是设计缺陷而非缓存 bug**：把「上一轮的失败」编码进「队列是否自动消费」这一个授权位，
再用它影响**下一轮**的输入路由 —— 用户切换渠道/模型是明确的「我要重试」意图，
却没有对应的复位路径。这与仓库 AGENTS.md「避免重复状态和多条写入路径，明确唯一所有者」
的方向一致，但当前所有者（投影）与失效触发者（只有 UI 按钮）不匹配。

**最小改动面（三选一，需与用户对齐）**：

| 方案                       | 改动点                                                                                                                                                                                                                   | 代价 / 风险                                                                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A（推荐）**切模型即复位**  | `server-operations.ts:2675` `setModel` 与 `model-config.ts:76` `switchModelConfig` 内，在 `setModel` 成功后若 `queue.pauseReason === "error"` 则调 `record.app.setQueueAutoDrain(true)`                                  | 语义清晰；但 `pauseReason==="stopped"`（用户主动 Stop）**不应**被切模型复位 —— 必须只对 `error` 生效。需 CLI 侧可读 pauseReason（当前 pauseReason 只在投影里，core 只有 `queueAutoDrain` 布尔）⇒ **需要新增一个 core 侧原因位或复用既有事件**，改动面比看起来大 |
| B **发下一条消息即复位**   | `session-flow.ts:184` `sendText` 的 held 分支：用户选「清空并发送/保留并发送」时顺带 `setAutoDrain(true)`                                                                                                                | 改动最小（1 处），且与用户意图一致；但只解决「held 之后」，不解决「error 之后又发消息」的首次体验                                                                                                                                                               |
| C **不自动恢复，只改文案** | `ConversationQueuePanel.tsx:324-345` 的 `chat.queue.paused.error`（`zh-CN.ts:4245`：**「由于当前响应出错，队列已暂停（内容未丢失）」** —— 现有文案完全没提「切模型不会恢复」）应补上「切换模型不会恢复队列，请点此恢复」 | 零行为风险，但把缺陷留成用户负担                                                                                                                                                                                                                                |

**我倾向 A + C 组合**（A 修语义、C 兜文案），但 **A 需要先确认「error 与 stopped 的原因位能否在 core 侧区分」**，
这是一个跨 core/投影的接口问题 ⇒ **按 AGENTS.md「发现设计缺陷时先与用户对齐」，
建议先与用户确认 A/B/C 的取舍，不要直接实现。**

### 5.3 建议的产品核对项（非代码）

`useStartPlanRecommendation` 会在用户切到非 start-plan 渠道时**建议切回 start-plan**
（§3 末尾）。若产品确认这不是期望行为，应单独评估；
**若确认是期望行为，至少应在用户报告「切了渠道还报错」时把这条作为首要排查项写进支持文档。**

---

## 6. 仍未验证的部分与风险

### 6.1 未验证（诚实标注）

1. **用户实际切到的是哪个渠道 —— 未验证。** 我无法拿到用户的运行时日志。
   本报告的论证是**排除法**：CE 里不存在会话级 provider 失败缓存（§2.2–§2.7 全部排除），
   所以只剩「目标渠道也会失败」。若用户切到了 **非 start-plan** 渠道（individual/team/自建）
   且**确实**复现同一条 3007，则我的排除法有遗漏，**需要真实日志**：
   采集 `model_request_failed` 事件的 `providerId` 与 `providerCode` 比对。
2. **用户是否走了 §3 末尾的「建议切回 start-plan」路径 —— 未验证。**
   需要问用户是否在弹窗里点过「切换」。
3. **error-paused 在用户现场是否真的被触发 —— 未验证。**
   触发需要失败时队列非空。若用户是「单条消息失败后切渠道再发」，队列为空 ⇒ **该机制根本没触发**，
   症状 3 需要另找解释（可能是纯粹的「切到的还是 start-plan」，即症状 2 的重复）。
4. **`pauseReason` 在 core 侧是否可读 —— 未验证。**
   这决定 §5.2 方案 A 的可行性。已知 `pauseReason` 只存在于 v4 投影
   （`projection-state.ts:84` 的初始值不含它，`product-projection.ts:2284` 才写入），
   core 只有 `queueAutoDrain: boolean`。**这是 A 方案的最大未知数。**
5. **官方是否也把 error 与 stopped 的原因位暴露给 core —— 未查。**
   官方 bundle 同样只有 `pauseReason:"error"`（§2.1(e)），未见 core 侧原因位。

### 6.2 风险

- **不要把症状 2 和症状 3 混为一谈**：修好 3007（症状 2）**不会**自动修好队列 held（症状 3），
  反之亦然。若只修 3007，用户仍可能在失败后遇到「切模型后弹确认框」；
  若只修队列，3007 照旧。
- **`onTurnError` 的 held 与官方逐字一致**（§2.1(e)），改它等于偏离上游。
  若要改，应改在**触发复位的一侧**（§5.2），而不是改投影的写入语义。
- **`accountProviderInvalidation` 的 3 个 key 集合**（§2.2）是**有意收窄**的
  （注释明确「不再订阅已退役旧 Registry 的事件，避免重新引入并行事实源」）。
  不要为了「切模型也刷新」而扩大它 —— 切模型不需要重查账号权益，扩大会引入无谓的账号网络请求。
- **本报告为只读调查**，未执行任何源码修改、未运行 typecheck/lint（无行为改动）。

---

## 附：关键命令速查（复现用）

```bash
# 1. error-paused 写入点（CE 源码）
sed -n '2262,2300p' apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts

# 2. error-paused 已随 CE 发货（打包产物，3.14.3-ce.2）
node -e 'const s=require("fs").readFileSync("packages/desktop/mock-cdn/releases/3.14.3-ce.2/glm/linux-x64/zcode.cjs","utf8");const n="pauseReason"+":\"error\"";console.log("count",s.split(n).length-1)'

# 3. 官方 3.14.3 同样有（证明是上游设计，非 CE 回归）
node -e 'const s=require("fs").readFileSync(".reverse/94-account-capability/official-3.14.3/extracted/opt/ZCode/resources/glm/zcode.cjs","utf8");const n="pauseReason"+":\"error\"";console.log("count",s.split(n).length-1)'

# 4. 唯一的恢复路径（用户显式操作）
sed -n '3017,3031p' packages/ui/src/v4/SessionPane.tsx
sed -n '131,143p' apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts

# 5. setModel 不碰 autoDrain
sed -n '2675,2684p' apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts
sed -n '4013,4034p' apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts

# 6. held 的封闭定义（error 相位不在 completed 集合）
sed -n '157,183p' apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/projection-state.ts

# 7. queueAutoDrain 不是 admission 门
grep -rn "queueAutoDrain" --include=*.ts apps/zcode-cli/packages/core/src | grep -v node_modules

# 8. systemDisabledReason 无写入点
grep -rn "systemDisabledReason" --include=*.ts packages apps | grep -v dist | grep -v node_modules | grep -v "schema\|Schema"

# 9. 3007 的 provider 无关守卫
sed -n '2266,2282p' packages/services/src/zcode-agent/zcodeAgentService.ts
```
