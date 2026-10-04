# IM 机器人「同意继续后回到确认界面」调查（Task R4）

- 调查人：r4-bot-approval（只读调查，未改动任何源码）
- 日期：2026-09-26
- 工作目录：`/home/sixiao/aicode/fix/ZCode-CE`
- 目标版本：`ce.3-fix.1`（本版修复提交 `8b3e459` "fix(start-plan): 补齐官方赠送额度渠道的验证码校验链路 + 切渠道复位队列授权位"）

## 开工前读过的材料（一致性声明）

| 材料                                                                            | 结论是否一致                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/development/126-start-plan-3007-root-cause.md`                            | **一致**。它定案的是「start-plan 三段链路缺失 + host 守卫写反」，与本症状无因果关系（见 §3 c）。                                                                                  |
| `docs/development/129-ce-defect-scan.md`                                        | **一致**。D1（host 无渲染层应答入口）已被本版补齐（`zcodeAgentService.ts:1403-1492`），不再是缺陷。                                                                               |
| `docs/development/130-start-plan-captcha-spec.md`（本版新增，代码注释多处引用） | **一致**。§4.4「Bot 场景不得悬挂」就是本版快速失败分支的依据。                                                                                                                    |
| `packages/services/src/bots/` 下 elicitation/permission 相关注释                | **一致**，且是本报告的主要证据来源（`botsService.ts:3421-3422`、`:6220-6222`、`:4074-4075`）。                                                                                    |
| `.reverse/93-bot-ingress/DOCS-AND-UI.md`                                        | **一致且是关键旁证**。其 §0.1 明写「任务书写的 UI 落点是 `BotsDialog`，实际不存在这个组件……本仓库的 bot 配置界面是桌面端远程控制面板的『IM 机器人』标签页」。这正是本症状的现场。 |

> **一处需要提醒 Lead 的认知前提**：用户这句症状在代码里有**两个**可对应的交互面，二者的机制不同、修复方向也不同。我没有拿到用户截图/日志，因此**两个都查了**，并给出各自的可复现证据。两个读法的结论**相同**：均为「既有未接线」，**不是本版引入**。见 §1。

---

## 1. 结论

**「同意继续后回到确认界面」不是本版（ce.3-fix.1）引入的，而是 Bot/远控链路既有的「动作已渲染、宿主未接线」形态。** 两种读法各自的机制：

**读法 I（与用户原话逐字最贴合）—— 远控面板「IM 机器人」标签页的启用确认弹窗。**
用户点「启用」→ 弹窗「启用 IM 机器人？」（`remotePanel.imBot.confirm.title`）→ 点「继续启用」（`remotePanel.imBot.confirm.continue`，`RemoteControlImBotTab.tsx:217-219`）→ `confirmEnable()` 调 `channel?.onEnable()`（`:88`）。**当前树的接线状态（ce.5/fix.2 起）**：`RemoteControlPanelHost` 已注入 `imBot` 通道（`useImBotChannel` 产出 channel：状态轮询 + `onEnable` 落点为打开 `BotsDialog`），`channel` 为必填并以 `canRenderRemoteControlImBotTab` 宿主门控；弹窗→`confirmEnable()`→`channel.onEnable()` 链路完整。**读法 I 的「宿主未接线」形态已是历史**：下表链路按 ce.3 时点记录，保留作排查参照。于是 `channel?.onEnable()` 是**空操作且立即 resolve** ⇒ **不会出现任何下一步弹窗**（产品里也根本不存在这个弹窗：`createBindCode` 全仓唯一调用点是它自己的声明，UI 侧 `BotsDialog*` 0 命中）。
「回到确认界面」的机制是**组件重挂载**：`requested` / `inFlight` / `confirmOpen` 都是 `RemoteControlImBotTab` 的**组件局部 state**（`:72-74`），而 Radix `TabsContent` 未加 `forceMount`（`components/ui/tabs.tsx:68-76`），`RemoteControlPanelHost` 的 `DialogContent` 同样在关闭时卸载 ⇒ **切到「Web 控制」再切回、或关掉面板再打开，都会卸载本组件**，三个局部标记全部归零 ⇒ 状态回到 `disabled`（`remoteControlPanelModel.ts:465-471`，`showEnableAction: true`）⇒ 用户又看到「启用」按钮，再点又是**同一个确认弹窗**。这就是「一直回到确认界面」。

**读法 II（若「同意」指的是 Bot 会话里的权限/计划审批）—— 确认回执被当作幂等成功但状态未落到 `handledAt`。**
Bot 的 `/approve` 与 `/elicitation` 最终收敛成 v4 `resolveInteraction` 命令（`zcodeTaskServiceAdapter.ts:2183-2209`），其 ACK 语义把 **`noop`（未命中即幂等成功）也判为成功**（`zcodeV4HostCommand.ts:107`）。而 `noop` 的真实含义是「该 interactionId 已不在登记表里」（`interaction-registry.ts:160-167` 返回 `false`；`interaction-background.ts:55-61` 记 `no pending interaction (idempotent)`）。此时 Bot 侧 `submitted === true`，`handledAt` 只写回 `pendingPermissionOptions` 中 **requestId 匹配**的那一项（`botsService.ts:6223-6236`）；若该权限已从投影消失（`permission_resolved`），匹配不上，`handledAt` 就**没生效**，pending 只在下一次 `permission_request` 事件（`:4076-4087` 整体覆盖）或 `/new`（`:986-987`）才被清掉 ⇒ 存在「提交成功但状态未持久化 ⇒ 同一确认可被再次提交/再次显示」的窄路径。`handledAt` 注释（`:6220-6222`、`:3421-3422`）说明作者已考虑过「ACK 失败前不能持久化」，但**没有覆盖「ACK 说成功、实际未命中」这一半**。

**两者都与本版无关**，证据见 §3。本版对 Bot 链路**唯一**的可感知影响是：Bot + start-plan 渠道从「悬挂到 CLI 侧 180s 超时」变成「**立即失败**」（`zcodeAgentService.ts:2530-2557`），用户看到的是**任务失败文案**，不是确认界面。

---

## 2. 链路图

### 2.1 读法 I：面板启用确认（用户原话「同意继续」=「继续启用」）

| #   | 步骤                              | 所有者                                                                                | 状态变化                                                                                                             |
| --- | --------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | 用户在远控面板切到「IM 机器人」页 | `RemoteControlPanel.tsx:109`                                                          | `activeTab="imBot"`（组件局部）                                                                                      |
| 2   | 渲染启用按钮                      | `RemoteControlImBotTab.tsx:113-125`                                                   | `view.showEnableAction=true`（`channel` 未注入 ⇒ `pendingServer` 说明）                                              |
| 3   | 点击 → 确认弹窗                   | `:120` `setConfirmOpen(true)`                                                         | `confirmOpen=true`（**组件局部**）                                                                                   |
| 4   | 点「继续启用」                    | `:217-219` → `:81-93` `confirmEnable`                                                 | `confirmOpen=false`; `requested=true`; `inFlight=true`（**均组件局部**）                                             |
| 5   | `await channel?.onEnable()`       | `RemoteControlImBotTab.tsx:88`                                                        | **channel === undefined ⇒ 空操作，立即 resolve**；`WorkspaceSidebar.tsx:1843-1847` 从不注入                          |
| 6   | `finally setInFlight(false)`      | `:91`                                                                                 | 落到 `requested` 档（`remoteControlPanelModel.ts:457-464`）                                                          |
| 7   | **用户期望的「新的机器人弹窗」**  | ——                                                                                    | **不存在**。`createBindCode`（`botsService.ts:5433`）无 UI 调用者；UI 侧无任何 bot 配置弹窗（`DOCS-AND-UI.md` §0.1） |
| 8   | 用户切页/关面板                   | `components/ui/tabs.tsx:68-76`（无 `forceMount`）、`RemoteControlPanelHost.tsx:47-73` | **组件卸载 ⇒ `requested/inFlight/confirmOpen` 全部归零**                                                             |
| 9   | 再次渲染                          | `remoteControlPanelModel.ts:465-471`                                                  | 回到 `disabled`，「启用」按钮重现 ⇒ **回到第 3 步，闭环**                                                            |

### 2.2 读法 II：Bot 会话内确认回执

| #   | 步骤                                          | 所有者                                                                   | 状态变化                                                                                      |
| --- | --------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 1   | agent 请求权限/问答                           | CLI `interaction-broker.ts:47-57`；host `zcodeAgentService.ts:2406-2433` | host 登记 `pendingPermissions`，emit `permission.request`                                     |
| 2   | Bot 收到 `permission_request`                 | `botsService.ts:4045-4100`                                               | 写 `context.pendingPermissionOptions`（`:4086-4087`），发确认卡片                             |
| 3   | 用户点「允许」/回复序号                       | `:6196-6254` `permission.respond`                                        | 命中 `option`，`handledAt` 尚为空                                                             |
| 4   | `respondPermission` → v4 `resolveInteraction` | `zcodeTaskServiceAdapter.ts:2195-2208`                                   | ——                                                                                            |
| 5   | CLI 投递应答                                  | `interaction-registry.ts:160-167`                                        | 命中 ⇒ 删登记并 resolve；**未命中 ⇒ 返回 false**                                              |
| 6   | ACK 收口                                      | `zcodeV4HostCommand.ts:107`                                              | **`noop` 也算成功** ⇒ adapter 返回 `true`                                                     |
| 7   | Bot 写 `handledAt`                            | `botsService.ts:6223-6236`                                               | **只在 requestId 仍匹配时生效**；若投影已 `permission_resolved`，该项已被覆盖/清空 ⇒ 写不进去 |
| 8   | 重放/重复显示                                 | `:4076-4087`（新事件整体覆盖）、`:986-987`（`/new` 才清）                | 同一确认可能再次可见/可提交 ⇒ 回到第 3 步                                                     |

> 读法 II 的**触发前提更窄**（需要 `noop` + 投影已清 + pending 未覆盖三者同时成立），我在 §6 明确标注为**待验证假设**；读法 I 的每一步都是**已确认**的静态事实。

---

## 3. 逐候选判定

### (a) 本版改动引入 —— **排除**（对「同意后回到确认界面」这一症状）

**(a-1) queue-held-reset 与 Bot 链路无数据通路。**

```bash
grep -rn "heldQueue\|inputRouting\|queueAutoDrain\|autoDrain" packages/services/src/bots --include=*.ts
# → 无输出（0 命中）
```

`resetHeldQueueAfterModelSelectionChange` 只做一件事：`app.setQueueAutoDrain(true)`（`queue-held-reset.ts:101-104`），四道门见 `:92-99`。它不触碰 `pendingPermissions`、`pendingElicitation`、`pendingPermissionOptions`，也不 emit 任何交互事件。Bot 侧既不读 `autoDrain` 也不读 `inputRouting.mode`。

**(a-2) 三条复位路径里，Bot 只会走 `sendText`，且不会反复复位。**

```bash
grep -n "heldQueueDisposition\|modelSelection" packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts | sed -n '1,20p'
# 446: heldQueueDisposition: "keepQueueAndSend",
```

Bot 的每次输入都固定携带 `modelSelection`（`botsService.ts:5011` 首建、`:5057` 续发）⇒ `session-flow.ts:297-302` 的复位分支**每次都会走**。但判据件门 1 用 `sameModelSelection`（`turn-model.ts:80-89`，只比 providerId/modelId/reasoningLevel）做幂等短路（`queue-held-reset.ts:92`）：Bot 不改选型时**恒为 no-op**，不会产生重复事件或 revision 抖动。更重要的是队列 held 只在 `queue.items.length > 0` 时成立（`product-projection.ts:2279-2286`），Bot 串行发送时队列通常为空 ⇒ 复位根本无从触发。
另外 `heldQueueDisposition` 是 adapter 硬编码的 `"keepQueueAndSend"`，`applyHeldQueueDisposition`（`session-flow.ts:106-132`）只对 `routing === "choice"` 生效，Bot 侧没有任何 UI 能表达 `clearQueueAndSend` ⇒ **Bot 链路不存在「队列裁决确认界面」**，「同意继续」不可能是它。

**(a-3) start-plan 快速失败造成的不是「回到确认界面」。**
`zcodeAgentService.ts:2500-2565` 的快速失败只在 `accountAccess.mode === "start-plan"` 且收到 runtime-headers 请求时触发，回 `headersApplied:false`；CLI 侧 `model-runtime-headers.ts:54-56` 直接 `throw`，adapter 包成 `RuntimeHeadersRefreshError`（`runner-runtime-headers.ts:41-50`）⇒ 结果是 **turn 失败**，Bot 走 `task_error` 分支发 `taskFailed` 文案（`botsService.ts:4161-4183`）。**没有**任何确认弹窗被重新显示。

### (b) Bot 链路既有缺陷 —— **命中（主因）**

**时间线证据（本版未碰 bots/ 与 UI bot 面板）**

```bash
git log --format='%h %ad %s' --date=iso -3 -- packages/services/src/bots/
# a768b5f 2026-09-25 19:57:09 +0800 fix(services): 修 Web 白屏回归 …
# ee491bf 2026-09-25 00:17:13 +0800 style(bot): 清掉 /bot 入站新增注释里的 markdown 强调 …
# 4896f42 2026-09-24 23:19:35 +0800 fix(server): IM 机器人入站独立接入 …

git log --format='%h %ad %s' --date=iso -1 8b3e459
# 8b3e459 2026-09-26 22:29:00 +0800 fix(start-plan): 补齐官方赠送额度渠道的验证码校验链路 + 切渠道复位队列授权位

git show --stat --oneline 8b3e459 | grep -c "packages/services/src/bots/"
# → 0（本版 diff 里没有 bots/ 任何文件）

git log --format='%h %ad %s' --date=iso -S 'channel={imBot' -- .
# 7558130 2026-09-24 21:18:44 +0800 feat(ui): 远程控制入口的标签页共存 …
```

⇒ **bots/ 最后一次改动（2026-09-25 19:57）早于本版（2026-09-26 22:29）**；「IM 机器人」标签页与确认弹窗成型于 **2026-09-24 21:18**（`7558130`），比本版早两天。症状面在本版之前就已存在。

**「未接线」是作者已如实登记的已知限制**（`7558130` 提交信息「未做」）：

> ① **Bot 服务端能力零实现** ⇒ `onEnable` 无真实宿主，`requested` 档就是这个事实的表达；
> ② `WorkspaceSidebar` **未注入 `imBot`** ⇒ 产品里今天点进去是"未启用 + 启用按钮 + 尚未接入说明"。

代码侧同样如实标注：`remoteControlPanelModel.ts:348-351`「宿主没注入通道（**今天 Bot 服务端零产出路径**）」，`:465-471` 未注入时给 `pendingServer` 说明「现在启用只会记下请求，机器人还不会收发消息」。

**「回到确认界面」的直接机制（已确认）**：三个状态位都是组件局部，而组件会重挂载。

```bash
sed -n '72,74p' packages/ui/src/RemoteControlImBotTab.tsx
#   const [inFlight, setInFlight] = useState(false);
#   const [requested, setRequested] = useState(false);
#   const [confirmOpen, setConfirmOpen] = useState(false);
sed -n '68,76p' packages/ui/src/components/ui/tabs.tsx   # TabsContent 无 forceMount ⇒ 非激活页卸载
grep -n "forceMount" packages/ui/src/settings/PluginsSection.tsx | head -3  # 1337：需要保活时是显式加的
sed -n '1843,1847p' packages/ui/src/WorkspaceSidebar.tsx  # RemoteControlPanelHost 未传 imBot
grep -rn "imBot=" packages --include=*.tsx   # → 无输出
```

**「新的机器人弹窗」不存在（已确认）**：

```bash
grep -rn "createBindCode" packages --include=*.ts --include=*.tsx
# packages/services/src/bots/botsService.ts:5433   ← 实现
# packages/services/src/bots/bots.ts:152           ← 接口声明
# → 无任何 UI 调用者
```

### (c) start-plan 渠道相关 —— **部分成立，但不是本症状的成因**

成立的部分：**Bot + start-plan 确实会快速失败**，而且是本版新引入的行为变化（本版之前会悬挂到 180s 超时）。证据：

```bash
sed -n '2517,2543p' packages/services/src/zcode-agent/zcodeAgentService.ts
# 2525-2529: unavailableReasonCode = !sessionsWithSessionEventSubscriber.has(key)
#              ? ..._UNAVAILABLE : !hasCaptchaCapableSessionSubscriber(key)
#              ? ..._CAPABILITY_MISSING : null
# 2530-2543: if (unavailableReasonCode) { 删 pending; respond({headersApplied:false, errorMessage}) }
sed -n '665,686p' packages/services/test/providerRuntimeHeadersForwarding.test.ts
# "§4.4 能力判据：有订阅者但无能力声明 ⇒ 快速失败（Bot 场景回归护栏）"
```

`zcodeAgentService.ts:1152-1170` 的注释**逐字点名**了 Bot 链路（`zcodeTaskServiceAdapter.onDynamicTaskEvent → botsService.watchTaskStream`）就是「有订阅者但无求解能力」的那一类。这是 spec 130 §4.4 明令的取舍（「Bot 场景不得悬挂」），**不是缺陷**。

不成立的部分：**它不产生「确认界面」**。它的用户可见结果是 `taskFailed` 文案（`botsService.ts:4174-4182`），且 `errorMessage` 只有协议 schema 的单一承载位（`zcodeAgentService.ts:2534-2543` 的注释已说明），Bot 直接把前缀码透传给用户 —— 文案可读性差是**另一个**问题（见 §5）。

**因此闭环不成立**：见 §4。

---

## 4. 若成立为闭环

### 4.1 真实闭环（读法 I，每一步已确认）

```
点「启用」
   │
   ▼
确认弹窗「启用 IM 机器人？」（remotePanel.imBot.confirm.title）
   │  点「继续启用」
   ▼
confirmEnable(): requested=true, inFlight=true        ← 均为组件局部 state
   │  await channel?.onEnable()   ← channel 恒 undefined ⇒ 空操作
   ▼
requested 档：「已请求启用，等待服务端就绪」
   │  ★ 用户期望的「新的机器人弹窗」不存在（无宿主、无 UI 实现）
   ▼
切页 / 关面板 ⇒ TabsContent(无 forceMount) + DialogContent 卸载组件
   │
   ▼
requested / inFlight / confirmOpen 全部归零 ⇒ 状态回到 disabled
   │
   ▼
「启用」按钮重现 ──────────────► 回到第一步（同一个确认弹窗）
```

### 4.2 读法 II 的窄闭环（**待验证假设**，未取到运行时证据）

```
确认卡（requestId=R）→ 用户点「允许」
   │  respondPermission → v4 resolveInteraction
   ▼
登记表未命中（已 auto-resolution / 已由别端应答 / runtime 换代）⇒ delivered=false
   │  ACK 收口把 noop 判为成功（zcodeV4HostCommand.ts:107）
   ▼
submitted === true
   │  写 handledAt：仅在 pendingPermissionOptions 里 requestId===R 时生效
   ▼
若投影已 permission_resolved ⇒ 匹配失败 ⇒ handledAt 未持久化
   │  事件重放 / 同一卡片再次可点
   ▼
再次显示同一确认 ─────────────► 回到第一步
```

### 4.3 明确排除的闭环（任务书假设的那个）

**「turn 失败 → 队列 held → 用户看到「继续」确认 → 点同意 → 又失败 → 又回到确认」在本仓库不成立**，三条独立理由：

1. **Bot 链路没有队列裁决界面**：`grep -rn "heldQueue\|inputRouting\|autoDrain" packages/services/src/bots` = 0 命中；`heldQueueDisposition` 是 adapter 硬编码 `keepQueueAndSend`（`zcodeTaskServiceAdapter.ts:446`）。「继续」按钮（`chat.queue.resume`，`zh-CN.ts:4247`）只存在于桌面 v4 会话面板的队列条（`SessionPane.tsx:4270-4280`），IM 机器人里看不到它。
2. **Bot 每次输入都携带 `modelSelection` ⇒ 复位幂等**：`sameModelSelection` 只比三个字段，Bot 不改选型时门 1 恒短路（`queue-held-reset.ts:92`），不会「反复复位」。
3. **held 需要队列非空**（`product-projection.ts:2279-2286`），Bot 串行发送时队列通常为空。

---

## 5. 修复方向

### 5.1 本版回归：需要立即处理的只有「观感」这一条，不是逻辑缺陷

本版**没有**引入本症状。但本版确实让「Bot + start-plan」从「悬挂 180s」变成「立即失败」，而 Bot 侧的失败文案是**直接透传前缀码**：

```bash
sed -n '4174,4183p' packages/services/src/bots/botsService.ts
#   msg(await readMessageLocale(), "taskFailed", { message: event.error })
```

⇒ 用户会看到 `任务失败：ZCODE_PROVIDER_RUNTIME_HEADERS_CAPABILITY_MISSING: this client cannot solve…`。
**建议**（低风险、不动逻辑）：在 `messages.ts` 增一条可操作文案（「当前会话使用的模型渠道需要在 ZCode 桌面端完成一次安全校验；请在桌面端打开该会话后重试，或切换到其它渠道」），按 `errorMessage` 前缀码分流。这是**产品文案**问题，不应改协议或改判定。

### 5.2 既有缺陷（可排期，与 126/129 无关）

| #   | 缺陷                                                                                            | 落点                                                                  | 说明                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | **`requested` 是组件局部 state，任何重挂载都会「回到确认界面」**                                | `RemoteControlImBotTab.tsx:72-74`、`:81-93`                           | 状态必须提升到宿主（与 Web 面 `inFlight` 同一纪律，但 Web 面有宿主回传 `status`，Bot 面没有）。最小改法：宿主注入 `imBot.status`，把「已请求」持久化到宿主。                                                                                                          |
| B2  | **渲染了一个没有宿主的启用动作 —— 违反本仓自己的「不谎报」纪律**                                | `WorkspaceSidebar.tsx:1843-1847`                                      | `remoteControlPanelModel.ts:348-351` 已明写「今天 Bot 服务端零产出路径」。要么注入 `imBot`，要么按 `canRenderRemoteControlPanel` 的同一纪律**整页不渲染**（现在是「渲染 + 说明」，而说明文字用户不读 ⇒ 观感就是「点了没用」）。**这条与用户症状直接相关，建议优先。** |
| B3  | **ACK `noop` 与 `accepted` 未区分，`handledAt` 的幂等表依赖 `pendingPermissionOptions` 的匹配** | `zcodeV4HostCommand.ts:107`、`botsService.ts:6223-6236`、`:3424-3429` | 建议：① Bot 侧把 `noop` 与 `accepted` 分开处理（`noop` 至少记一条 info 日志，便于线上定位）；② 幂等键独立持久化（按 `requestId` 落一张有 TTL 的小表），不依赖 `pendingPermissionOptions` 是否仍持有该项。**先验证再改**（见 §6）。                                    |

**不建议的修法**：把 `assertV4CommandAckOk` 的 `noop` 判为失败。`noop` 是**多端先到先得**语义的载体（`interaction-registry.ts:155-167`、`interaction-background.ts:36-44` 的注释都写明「晚到应答是无害幂等操作，抛 failed 会误导客户端」），改成失败会打掉桌面+手机+Bot 并发应答的正常路径。

---

## 6. 未验证部分（诚实标注）

1. **用户指的是哪一个「同意继续」**。我没有截图/日志，无法在两种读法之间定案。两者都指向同一结论（既有、非本版），但修复落点不同（B2 vs B3）。**定案方法**：让用户提供操作路径（远控面板 / IM 会话内），或取 `~/.zcode/v2/logs/*.log` 里的两类关键行 ——
   - 读法 I：无日志特征（纯前端局部状态），只能靠操作路径确认；
   - 读法 II：`permission callback respond task=… submitted=true`（`botsService.ts:6226-6229`）与 `v4 resolveInteraction no pending interaction (idempotent)`（`interaction-background.ts:56`）**成对出现**即命中。
2. **读法 II 的 `noop` 触发频率未实测**。我未运行任何 Bot 会话；「投影已清但 pending 未覆盖」这个时间窗有多宽，需要真实会话日志。
3. **`requested` 归零是否一定发生**。我按 Radix 的默认卸载语义（`TabsContent` 无 `forceMount`、`DialogContent` 无 `forceMount`）推断重挂载会归零；**未在真浏览器里实测**。若宿主对面板做了保活（本仓无此代码，但 `DialogContent` 支持 `forceMount`），该步骤不成立，「回到确认界面」就只剩「点了没反应」。**这是本报告最需要实测的一步。**
4. **用户实际使用的模型渠道**未知。若确实是 start-plan，则他还会叠加看到 §5.1 的失败文案；若否，则 §3(c) 完全不参与。
5. **`RemoteControlImBotTab` 之外的第二个 bot 入口**：`DOCS-AND-UI.md` §0.1 说 UI 侧无 `BotsDialog`；我复核了 `packages/ui/src` 与 `packages/web/src`（`grep -rn "createBindCode\|BotsDialog" packages --include=*.ts* `），结论一致。但**未穷尽** `apps/` 与桌面 main 进程的菜单项（`grep -rn "imBot" packages/desktop` = 0 命中，已查）。

## 附：关键复现命令

```bash
# 1. 本版未碰 bots/（0 命中）
git show --stat --oneline 8b3e459 | grep -c "packages/services/src/bots/"

# 2. bots/ 最后一次改动早于本版
git log --format='%h %ad %s' --date=iso -1 -- packages/services/src/bots/
git log --format='%h %ad %s' --date=iso -1 8b3e459

# 3. 宿主从不注入 imBot（0 命中）
grep -rn "imBot=" packages --include=*.tsx

# 4. Bot 链路无队列语义（0 命中）
grep -rn "heldQueue\|inputRouting\|queueAutoDrain\|autoDrain" packages/services/src/bots --include=*.ts

# 5. 三个状态位是组件局部 + 卸载点
sed -n '72,74p;81,93p' packages/ui/src/RemoteControlImBotTab.tsx
sed -n '68,76p' packages/ui/src/components/ui/tabs.tsx
sed -n '1843,1847p' packages/ui/src/WorkspaceSidebar.tsx

# 6. 「新的机器人弹窗」不存在
grep -rn "createBindCode" packages --include=*.ts --include=*.tsx

# 7. ACK noop 判为成功
sed -n '102,111p' packages/services/src/zcode-agent/zcodeV4HostCommand.ts
sed -n '155,167p' apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/interaction-registry.ts

# 8. 快速失败判据（Bot 场景护栏测试）
sed -n '2517,2543p' packages/services/src/zcode-agent/zcodeAgentService.ts
sed -n '665,686p' packages/services/test/providerRuntimeHeadersForwarding.test.ts
```
