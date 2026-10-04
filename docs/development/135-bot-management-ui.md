# 135 · Bot 管理面（桌面端 UI 接线）与 botDeliveryTarget 消费链

> 状态：**已实现（ce.5，工作树待提交）**。本文覆盖 backlog「ce.5 第一件事（桌面端 bot UI 接线，代价 L）」与同批项
> 「botDeliveryTarget 消费链打通（代价 M）」——两者是同一条链的两端：UI 让用户能「同意」，
> 消费链让「回推地址」能落库。只做一端会给出「看起来能用、实际不生效」的形态。
> 编号说明：任务书写的「132-号」已被 `132-not-started-state-semantics.md` 占用（131×2/132/133/134 均已存在），故取下一可用号 **135**。

## 0. 开工前读了什么 / 结论一致性

| 材料                                                    | 结论                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 根 `AGENTS.md`（「上游形态说明」块的 Bot 权威口径）     | **一致**。权威口径「与官方同步、默认关闭、用户同意后即可使用」是本 spec 的产品规则基线。                                                                                                                                                                                                                                                                                                                                     |
| `docs/development/backlog.md`（ce.5 两行 + 有意偏离表） | **一致**。两行判据（「同意」无处可点 / 静默丢弃）即本 spec 的两条验收主线。                                                                                                                                                                                                                                                                                                                                                  |
| `.reverse/98-ce4/IMPL-CE4-REMAINING.md` §3              | **一致**，且**修正一处**：其 §3.3 路线 A 说「上游组件直接 `useServices`…会引入第二条服务访问路径」。实测 CE 自身就有 `packages/ui/src/hooks/useServices.tsx`（`GitActionMenu`/`GitPane`/`command-center` 等 10+ 处直接 `const { xService } = useServices()`） ⇒ 搬运上游组件沿用 `useServices()` **就是** CE 的「hooks 访问服务」纪律，不构成第二条路径。真正需要新增的是 `IServiceAccessor` 上的 `botsService`（见 §5.1）。 |
| `.reverse/98-ce4/IMPL-BOT-DELIVERY-TARGET.md`（全文）   | **一致**（断链 13 处清单逐条复核，见 §6）。**一处推进**：其 §2.2 把 #12（v1 协议面）列为「需裁决 v1 是否仍维护」。实测：v1 `zcodeAutomationCreateParamsSchema` 被 `zcodeAgentService.ts:2769`（CronCreate 路径）**仍在此消费**，且该 schema 是 `.strict()`；而 #5（automation-port）的 CronCreate 唯一落点正是 \`context.requestClient(automationCreate)\` ⇒ **#12 与 #5 强耦合，不能分开做**（详见 §6.6）。                 |
| `.reverse/93-bot-ingress/BOT-INGRESS-SPEC.md`           | **一致**。入站面 \`/bot/\*\*\` 已落地（`packages/server/src/botIngress.ts`、`resolveBotIngressEnabled`，默认不启用、惰性 gate）。本 spec 只做桌面端 UI 与内部消费链，不动入站面。                                                                                                                                                                                                                                            |
| `docs/development/133-im-bot-approval-loop.md`          | **一致**。其读法 I（`channel` 恒 undefined ⇒ 点了没结果、重挂载回确认界面）正好是本 spec §4.2 要修的形态；其 B1（局部 state 重挂载归零）通过把弹窗状态提升到宿主层解决。                                                                                                                                                                                                                                                     |
| `docs/development/upstream-sync.md`                     | **一致**。「IM 机器人…部分跟进——入口与启用流程同步且默认关闭；服务端能力与遥测处理待定」本 spec 把「入口」补齐。                                                                                                                                                                                                                                                                                                             |
| `.agents/skills/architecture-governance/SKILL.md`       | 基线检查已跑：`pnpm architecture:check --changed` → 0 violations / baseline 0（改动前实测）。                                                                                                                                                                                                                                                                                                                                |

## 1. 产品规则（bot 管理面）

1. **默认关闭是状态，不是缺失入口**：远控面板「IM 机器人」标签页在宿主注入通道后渲染；未注入（Web 客户端、旧 host）时按 `canRenderRemoteControlImBotTab` 整块不渲染（fix.2 纪律：不渲染点了没结果的按钮）。
2. **「同意后即可使用」是可验收动作**：用户在标签页点「启用」→ 确认弹窗（三条事实 + 重启生效提示，P4 已落地）→ `onEnable` 结算后**打开 BotsDialog**（bot 管理面）。BotsDialog 提供：建 bot、配渠道（ telegram/飞书/Lark/微信/webhook）、扫码绑定（飞书/Lark/微信）、Telegram token、webhook secret、工作区授权、回复粒度、启停、删除。**同意动作的落点必须是真实能力**，不得停在「已请求」。
3. **Webhook 渠道受入站面约束**：webhook bot 的 secret 保存后，入站回调需服务重启才生效（BOT-INGRESS-SPEC §2.3 P4）。该提示已在 `REMOTE_CONTROL_IM_BOT_RESTART_NOTICE_MESSAGE_ID` 常显，BotsDialog 内不重复。
4. **不搬 \`WebRemoteControlDialog\`**：上游把 BotsDialog 挂在该弹窗下；CE 的远控面板（RemoteControlPanel 标签页共存）是既定入口，BotsDialog 从宿主层挂载（§4.2）。这是**有意偏离上游形态**，理由：CE 的伞名/命名纪律（「Web 控制」/「IM 机器人」两页共存）已由 `RemoteControlPanel.tsx` 落地，再搬上游弹窗会出现两个重叠入口。
5. **能力范围不变**：`BOT_PROVIDERS` 中 dingding/discord/wecom 为 `implemented: false`（上游同样只留位），渲染为「即将支持」禁用态。

## 2. 状态所有者

| 状态                                           | 唯一所有者                                                                                                                                    | 读取方                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| bot 配置（启停、渠道、授权、命令白名单）       | \`BotsRepo\` → \`getAppConfigDir()/bot-config.v3.json\`（`bots/config.ts:15`），写者收口在 \`IBotsService.saveBot/deleteBot/removeBotSecret\` | BotsDialog 轮询 `getConfig/getStatus`；入站 gate 运行期读 \`listBots\`       |
| bot 运行态（连接/轮询/投递错误）               | \`botsService\` 的 channel runtime（`handleProviderCallbackResponse` 等回写）                                                                 | \`getStatus()\`（`BotServiceStatus.botRuntime\`）；入站 404/401 判定不依赖它 |
| 「IM 机器人」标签页 channel                    | 宿主层（`useRemoteControlWiring` 产出，`RemoteControlPanelHost` 注入），面板不自己宣布已启用                                                  | \`resolveRemoteControlImBotView\`（model 唯一解析者）                        |
| BotsDialog 开闭 + 入口渠道                     | 宿主层（`RemoteControlPanelHost` 同层），**不是组件局部**——修复 133 报告 B1（重挂载归零）                                                     | \`entryProvider\` prop                                                       |
| \`activeBotDeliveryTarget\`（turn 级回推地址） | v4 session record（\`prompt-turn.ts:91-104\` 已在位：turn 开始写、结束恢复）                                                                  | \`automation-port\` 的 CronCreate（本轮内读）                                |
| \`bot_delivery_target\`（持久化）              | \`automationRepo\`（sqlite，列已存在于 \`schema-v1.ts:95\`）                                                                                  | scheduler 终态回推经 \`getBotDeliveryTarget\`                                |

## 3. 「同意 → 可用」链（事件顺序）

\`\`\`
用户切到「IM 机器人」页
→ canRenderRemoteControlImBotTab(imBot) 为真（宿主已注入）→ 渲染「启用」
用户点「启用」→ 确认弹窗（三条事实）→ 点「继续启用」
→ confirmEnable: requested=true, inFlight=true（组件局部，本次挂载内有效）
→ await channel.onEnable()
→ 宿主层：打开 BotsDialog（状态提升到宿主，切页/关面板不丢）
→ BotsDialog: refresh() → getConfig/getStatus/listWorkspaceRefs/getBotStates
用户在 BotsDialog 建 bot / 配渠道 / 扫码 / 授权 / 启停
→ botsService.saveBot(...) → BotsRepo 落盘 → runtime 状态回写
宿主通道 status 判定（轮询或打开时读一次）
→ enabledBotsCount > 0 ⇒ status="enabled" ⇒ 标签页徽标「已启用」
\`\`\`

**幂等/时序边界**：`onEnable` 只负责打开管理面，不负责把 bot 变 enabled；bot 的启停唯一写者是 \`saveBot\`。`requested` 档只在同一次挂载内有效（133 报告 B1 的处置），跨挂载真相源是宿主 `status`。

## 4. 接口

### 4.1 服务访问（`IServiceAccessor` + 客户端访问器）

\`\`\`ts
// packages/services/src/accessor.ts —— 新增（可选，旧 host/测试 double 可不提供）
readonly botsService?: IBotsService;

// packages/client/src/remoteServiceAccess.ts —— 新增（channel 由 exposeOnChannelServer 自动暴露）
readonly botsService: IBotsService; // constructor: ProxyChannel.toService(channelClient.getChannel(IBotsService.channelName))
\`\`\`

判据（防回退）：`IBotsService.channelName === ServiceChannels.Bots`，桌面 host 经 \`createLocalServices\` 注册（`node.ts:2496`）且 \`exposeOnChannelServer\` 遍历全部已注册服务 ⇒ **channel 层无需新增代码**（IMPL-CE4-REMAINING §3.2 实测结论，本 spec 复核成立）。

### 4.2 IM Bot 通道（既有契约，新增产出者）

\`\`\`ts
// remoteControlPanelModel.ts（既有，不改）
export interface RemoteControlImBotChannel {
status: "disabled" | "enabled";
onEnable: () => void | Promise<void>;
}
\`\`\`

宿主层（`useRemoteControlWiring`）产出该通道：
`status`：`enabledBotsCount > 0`（从 `botsService.getStatus()`，打开面板时读一次 + 每 2s 与 BotsDialog 同节奏轮询——**复用既有轮询纪律，不新增事件通道**）。
`onEnable`：打开 BotsDialog（宿主持有 `botsDialogOpen` state；133 报告 B1 的修复——不放进组件局部）。

### 4.3 BotsDialog（搬运上游，props 契约不变）

\`\`\`tsx
BotsDialog({ open, onOpenChange, workspacePath, workspaceIdentity, entryProvider? })
\`\`\`
子组件 \`BotSummaryCard\`/\`ProviderSettingsCard\`/\`WorkspaceAccessCard\`/\`shared\` + \`botsUi.ts\` 一并搬运；`useServices()` 取 `botsService`（服务经 hooks 访问，符合「UI 与平台边界」纪律——§0 已登记该结论对 §3.3 的修正）。

## 5. 验收场景

| #   | 场景                                   | 判据                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 通道未注入（Web 客户端）               | 「IM 机器人」标签触发器与内容整块不渲染（既有 \`canRenderRemoteControlImBotTab\` 护栏，remoteControlPanel.test.ts 已覆盖，变更后须仍绿）                                                                                                                                                                                     |
| A2  | 注入后点「启用」→ 确认 → `onEnable`    | BotsDialog 出现（标题 \`bots.title\`、侧栏「添加机器人」）；面板落到 \`requested\` 档                                                                                                                                                                                                                                        |
| A3  | 建 bot                                 | 选渠道 → 保存 → 侧栏出现该 bot（\`formatBotDisplayName\` + 渠道名）；`saveBot\` 落盘后 \`getConfig()\` 可见                                                                                                                                                                                                                  |
| A4  | 扫码绑定（飞书/Lark/微信）             | 二维码区域出现；轮询 \`poll\*Registration\` 成功后收起并 toast                                                                                                                                                                                                                                                               |
| A5  | 工作区授权                             | \`WorkspaceAccessCard\` all/selected 切换 + 逐工作区勾选 → \`allowedWorkspaces\` 落盘                                                                                                                                                                                                                                        |
| A6  | 启停                                   | \`Switch\` 翻 \`enabled\` → \`saveBot\` 落盘；侧栏圆点 \`runtimeDot\` 随之变化                                                                                                                                                                                                                                               |
| A7  | i18n                                   | 259 个 \`bots.\*\` 键中英双语均在位；渲染无 \`missing key\` 回退字面量                                                                                                                                                                                                                                                       |
| A8  | 通道 status                            | 有已启用 bot ⇒ 徽标「已启用」、无「启用」按钮；无 bot ⇒ 反之                                                                                                                                                                                                                                                                 |
| B1  | 回推地址落库（**必须打到最终消费点**） | 从 \`botsService\` 发起带 \`botDeliveryTarget\` 的 prompt → 值活着穿过 adapter（\`sendPrompt\`/\`sendPromptToAgent\`）→ v4 \`prompt-turn\` 写 \`record.activeBotDeliveryTarget\` → \`automation-port\` 注入 → CronCreate → \`automationRepo.getBotDeliveryTarget(id)\` 返回该值（即 INSERT 已落 \`bot_delivery_target\` 列） |
| B2  | 终态回推                               | scheduler 读 \`getBotDeliveryTarget\` 得到的目标，其 \`provider/botId/providerUserId/chatType\` 与发起时一致                                                                                                                                                                                                                 |
| B3  | 键被删不会静默绿                       | 反向验证：去掉任一环（adapter 转发 / repo 写列 / schema 声明）⇒ B1 断言变红（zod \`.strict()\` 会**拒绝**未声明键，不是剥离——IMPL-BOT-DELIVERY-TARGET §4.1 的教训）                                                                                                                                                          |

## 6. botDeliveryTarget 消费链（同批项）

分 5 层，顺序即实现顺序（依据 IMPL-BOT-DELIVERY-TARGET §2.2，逐条复核上游 diff 后落实）：

1. **类型面**：`automation-types.ts` create 入参字段（#6）+ `zcodeAgent.ts` turn 参数字段（#11）+ `zcodeAgentService.ts` compat-field 清单两处（#9，`:368`/`:399`）与降级重试白名单透传（`:726-728`）——**纯 additive**。
2. **服务面**：`zcodeTaskServiceAdapter.ts` \`sendPromptToAgent\` 入参声明 + 两处转发（#10，`:385`/`:436`/`:458`）与 \`sendPrompt\` 转发（`:1934`）；`zcodeAgentService.ts` CronCreate 取 `parsed.data.botDeliveryTarget` → `automationService.create({...})`（#8）。
3. **持久化面**：`automationRepo.ts` 行类型 \`bot_delivery_target\` + INSERT 列/值/参数 + `getBotDeliveryTarget\` 方法 + SELECT 列（#7）。**schema 已有列，无 migration**（`schema-v1.ts:95` + \`migrations.ts:22\` 复核在位）。
4. **bootstrap 面**：`automation-port.ts` 读 \`activeSession.activeBotDeliveryTarget\` 注入 \`requestClient(automationCreate)\` 参数（#5）；`server-operations.ts` v1 \`sendPrompt\`/\`runPromptTurnInBackground\` 透传与 record 写/恢复（#13，`:2004`/`:2376`/`:2390`/`:2408`/`:2473-2475`）；`server-types.ts` record 字段声明（#13）。
5. **协议面（#12）**：见 §6.6。

### 6.6 #12 不是「可选」——与 #5 强耦合（本 spec 对任务书的推进）

**任务书指示**：#12（`packages/shared/src/zcode-protocol/index.ts:1746,3381`）「先不要做… 只做证据收集交 Lead」。

**证据（实测，非推理）**：

- v1 \`zcodeAutomationCreateParamsSchema\` 被 \`zcodeAgentService.ts:2769\`（`automationCreate` 方法）**仍在此消费** ⇒ **v1 协议面仍在维护**（裁决问题的答案是「是」）。
- 该 schema 是 \`.strict()\`（`:3402-3421`）。zod strict 对未声明键是**拒绝**（-32602），不是剥离。
- #5 的落点 \`automation-port.ts\` 的 CronCreate **唯一出口**是 \`context.requestClient(zcodeProtocolMethods.automationCreate, {...})\`——即走该 v1 schema。
- ⇒ 若只做 #5 不做 #12：bot 会话里每次 CronCreate 都会带上 \`botDeliveryTarget\`，被 strict schema 判为 \`Invalid automation create params\` ⇒ **把「建定时任务能用但无回推」降级成「建定时任务直接失败」——制造回归**。

**处置（已在 ce.5 同批落实）**：按上游逐字节补 #12 两处 schema 声明（`:1746` 的 \`zcodeSessionSendParamsSchema\` 与 `:3381` 的 \`zcodeAutomationCreateParamsSchema\`，均 \`botDeliveryTarget: zcodeAutomationBotDeliveryTargetSchema.optional()\`）。这是让 #5 安全落地的最小必要项；**登记为「据证据推进任务书的\"先不要做\"」并交 Lead 复核**——若 Lead 判定 v1 面要整体废弃，#5 需改为直调服务（另一条改动单元）。

## 7. 有意偏离登记（上游形态 vs CE）

| 项                | 上游                                                           | CE（本 spec）                                              | 理由                                                                                                    |
| ----------------- | -------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 挂载点            | \`WebRemoteControlDialog\`（独立弹窗，上游唯一的远控入口形态） | 远控面板「IM 机器人」标签页 → 宿主层打开 \`BotsDialog\`    | CE 的 \`RemoteControlPanel\` 标签页共存是既定产品形态（ce.3）；不引入第二个伞名入口                     |
| \`onEnable\` 语义 | （上游无此通道）                                               | 打开 BotsDialog + \`status\` 由 \`enabledBotsCount\` 承载  | 「同意后即可使用」要求同意动作落点是真实能力（建 bot/配渠道），不是空操作                               |
| 弹窗状态位置      | 上游 \`WebRemoteControlDialog\` 顶层                           | \`RemoteControlPanelHost\` 同层（宿主）                    | 133 报告 B1：组件局部 state 会因 \`TabsContent\`/\`DialogContent\` 卸载而归零，形成「回到确认界面」闭环 |
| \`useServices\`   | 上游组件直接用                                                 | **沿用不改**（实测 CE 既有 10+ 处同款）                    | §0 已修正 IMPL-CE4-REMAINING §3.3 的判断——这就是 CE 的 hooks 访问服务纪律                               |
| 遥测/验证码差异   | —                                                              | 搬运 \`botDeliveryTarget\` 时不携带 CE 的 captcha/遥测改动 | 两边 diff 只取 \`botDeliveryTarget\` 相关闭 hunks（见 §6）                                              |

## 8. 不做（防范围溢出）

- 不动入站面 \`/bot/\*\*\`（BOT-INGRESS-SPEC 已落地，默认关闭 + 逐请求判定不变）。
- 不搬 \`WebRemoteControlDialog\`（§4 决策 4）。
- 不实现 dingding/discord/wecom 渠道（上游也只留位）。
- 不新增令牌/凭据环境变量；secret 仍走 \`ICredentialService\`（`bot:<botId>:webhook-secret`）。
- 不做 bot 命令白名单的 UI 编辑入口（上游注释明确暂不暴露，避免用户在 bot 可用前关掉关键命令）。

## 9. 测试落点

- B1/B2/B3：`packages/services/test/`（`automationRepo` 真实 sqlite + adapter 真实转发，不停在 safeParse 层——§5 B3 判据）。
- A1/A2：`packages/ui/test/remoteControlPanel.test.ts`（既有，通道注入后断言不回退）+ 新增 \`botsDialogWiring.test.ts\`（宿主注入通道 ⇒ 标签页出现 + onEnable 打开 BotsDialog）。
- 搬运源码的逐字节核对：`cmp` 与上游（允许 oxfmt 差异与 §7 登记的本地适配）。
