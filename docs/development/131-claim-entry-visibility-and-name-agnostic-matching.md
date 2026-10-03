# Spec：免费额度领取入口的可见性 + 额度计划的名称无关识别

- 状态：**已实现**（2026-10-03，claim-quota-ux）——spec 先行、按本 spec 落地；验收场景 1–8 由 `packages/ui/test/chatStartPlanClaimEntry.test.ts`（8 条）与真浏览器 harness 证据（`.reverse/94-account-capability/harness/facts-claim-entry.json`）覆盖
- 背景证据：
  - [126 start-plan 3007 根因报告](./126-start-plan-3007-root-cause.md)（claim 平面协议）
  - [130 start-plan captcha spec](./130-start-plan-captcha-spec.md)（验证码链路）
  - `.reverse/94-account-capability/C-SUCCESS-TICKET.md`（领取成功票券卡片：数据来源与四态分界）
  - `.reverse/94-account-capability/BANNER-BUNDLE-ANALYSIS.md`（官方横幅/票券渲染物分析）
  - `.reverse/08-entitlement/REPORT.md`（billing/preview 与 claim 的接口契约）
- 影响范围：`packages/ui/src/chat-input-toolbar/**`、`packages/ui/src/settings/model-provider-section/**`、i18n、测试

---

## 1. 问题陈述

用户反馈两条：

### 1.1 领取入口"看不见"（表示层缺陷，无需改服务层）

上一批改动（`b460271` + `59f2bb6`）补齐了 claim 平面前端链路与自画票券，
但**领取入口在全仓只有一个挂载点**：设置页 → Model Provider → 套餐详情的
`CodingPlanStatusPanel`（`StatusCards.tsx` 中 `ManualClaimPlanCard`）。

聊天工作区里"左下角"（聊天输入栏左侧的 context usage 面板）**完全没有领取入口**：

| 事实                       | 证据                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 唯一挂载点在设置页深处     | `grep ManualClaimPlanCard` 全仓仅 `StatusCards.tsx:652` 一处消费                                                                                                     |
| context 面板无领取入口     | `ChatStartPlanBalancePanel` 只渲染余额条 + "升级"按钮                                                                                                                |
| context 面板无显式刷新     | 余额刷新只能靠 hover 自动触发（`onAccess`），用户看不到任何"刷新"按钮                                                                                                |
| 触发器外层门控不含领取信号 | `ChatContextUsage` 在「无 context usage + 无 Coding Plan + 无 Start Plan 余额」时整块 `return null` ⇒ 即使账号下有可领取活动，左下角也不出现触发器，领取卡片无从挂载 |

对照官方 3.14.4 客户端（只读复核 `/tmp/zcode-3144-artifact`）：
官方的领取横幅挂在**侧边栏底部**（`Oin` footer 的 `banner` 槽位），由
`marketing/touch` 投递驱动，点击执行 `claim_zcode_plan` 动作（带 captcha 预求解）。
CE 按既有产品决策**不引入 marketing/touch**（见 C-SUCCESS-TICKET §1 非目标），
因此 CE 的对等入口落在既有 context usage 面板（左下角额度面板）——这是 CE 已有的
"额度"展示面，不新增营销通道。

### 1.2 名称相关匹配（官方改名即失效）

官方本次活动的展示名是 "ZCode Trust Build"（服务端/运营侧命名，官方 3.14.4 asar 中
**0 命中**）。CE 表示层存在两处按**展示名**判断套餐身份的代码，官方一旦改名即失效：

| 位置                                                     | 当前实现                                                                                 | 失效后果                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `StatusCards.tsx` `isStartPlanEntitlementName`           | 匹配 `"start"`/`"start plan"`/`"… start plan"`（作用于 `planLevel`，通常就是后端展示名） | Start Plan provider 承载真实 Start 权益时不再显示"体验套餐"标题，回退成原始后端名 |
| `Detail.tsx` `resolveStartPlanPurchaseChoiceBannerTitle` | `/^start\s+plan$/i` 匹配远端标题                                                         | 远端改名后本地化回落失效                                                          |

claim 平面的数据侧（`manualClaimPlanClient` → `parseManualClaimPlanPreviews` →
`pickManualClaimPlan`）本身已经**名称无关**：解析只要求 `plan_id` 存在，选取只按
`planId` 命中或 `priority` 排序，从不读取 `name`。因此 (b) 只需修表示层。

## 2. 产品规则

1. **有可领取活动时必须出现领取入口**：入口出现在左下角 context 面板（聊天工作区
   的既有额度面），与设置页卡片共用同一套四态分界规则（`resolveManualClaimPlanCardView`）。
2. **无活动不占位**：与既有产品决策一致——「当前没有可领的活动」不是用户需要处理的
   信息，不渲染空态、不占位。
3. **读取失败必须给失败态与重试入口**：静默消失是被禁止的（c09f86a 修过的静默降级，
   新入口同样遵守）。
4. **领取必须由用户点击触发**：不做后台自动领取或轮询。
5. **验证码链路不变**：复用 `ManualClaimCaptchaDialog`（webview 求解，Web/手机判
   unsupported）；本 spec 不改动验证码求解链路（另一成员的写范围）。
6. **名称无关**：额度计划的识别与展示一律按接口返回的**类型/结构字段**（`plan_id`、
   `priority`、`meter`、`unit_type`、`period`、provider 的 account mode）驱动，
   不得出现对展示名（"ZCode Weekend Build"、"ZCode Trust Build" 或任何中文名）的
   字符串匹配。展示名原样显示（`plan.name`），客户端不做名称翻译。
7. **刷新是显式动作**：Start Plan 余额段提供"刷新"按钮（复用既有 `onAccess` 静默
   刷新链路）；领取列表的失败重试复用既有 retry。

## 3. 状态所有者（唯一所有者原则）

| 状态                                          | 所有者                                                            | 说明                                                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 可领取列表 / 验证码配置 / 领取结果 / 票券快照 | `useManualClaimPlan`（既有，不换主人）                            | 新增模块级**预览共享缓存**（in-flight 去重 + 60s TTL），使设置页卡片与 context 面板**不会各自重复请求**；`refresh()` 显式绕过缓存 |
| 门控信号（面板是否出现领取入口）              | 纯函数 `resolveManualClaimPlanCardView`（既有导出，已被测试钉住） | 触发器可见性 = 该纯函数结果 `!== "hidden"`                                                                                        |
| 验证码求解过程态                              | 渲染层组件（一次性凭据，不落盘）                                  | 与设置页卡片同口径                                                                                                                |

不新增 store、不新增第二份"领取结果"（C-SUCCESS-TICKET §2 的既定决策保持不变）。

## 4. 接口与契约

### 4.1 `useManualClaimPlan`（packages/ui/src/settings/model-provider-section/useManualClaimPlan.ts）

- 对外签名不变；新增模块级共享缓存：
  - 预览请求 in-flight 去重（同一时刻多消费者共享一个 promise）；
  - 预览结果 60s TTL 缓存（plans + captchaConfig）；
  - `refresh()` 显式绕过缓存（用户重试 / 领取成功后刷新走这里）。
- 导出类型 `ManualClaimPlanStateApi = ReturnType<typeof useManualClaimPlan>`，
  供 context 面板把同一份状态注入卡片组件。

### 4.2 `ManualClaimPlanCard`（既有组件，扩展可选注入）

```ts
export function ManualClaimPlanCard({
  providerId,
  state,
}: {
  providerId: string;
  /** 不传时组件内部自行 useManualClaimPlan()（设置页既有形态不变）。
   *  context 面板传入同一份状态，避免面板门控与卡片各持一份。 */
  state?: ManualClaimPlanStateApi;
});
```

四态分界、验证码对话框、票券渲染完全复用既有实现——**不新增第二条渲染路径**。

### 4.3 `ChatContextUsage`（packages/ui/src/chat-input-toolbar/contextUsage.tsx）

- 新增内部调用 `useManualClaimPlan()`（面板既是展示组件也是该面的聚合点，与既有
  `useSyncExternalStore`/`useCodingPlanQuotaResetUi` 同级）。
- 外层门控追加领取信号：`… || hasStartPlanClaimEntry`，其中
  `hasStartPlanClaimEntry = resolveManualClaimPlanCardView({...}) !== "hidden"`。
- 触发器 `aria-label` 回落链追加领取标题（仅有领取入口时不再误标"今日余额"）。
- 面板内在 Start Plan 余额段之后渲染 `<ManualClaimPlanCard state={…} providerId={…} />`
  （卡片自身在 hidden 态返回 null，因此无需额外可见性条件）。
- `providerId` 仅用于日志归属（claim 本身与 family 无关）：start-plan 连接时取其
  providerId，否则传空串。

### 4.4 `ChatStartPlanBalancePanel`（StartPlanContextBalance.tsx）

- 标题行新增显式"刷新"图标按钮：门控 `config.onAccess` 存在；`loading/refreshing`
  时禁用并保留既有 spinner（刷新反馈语义与 Coding Plan 段一致）。

### 4.5 名称无关识别（表示层）

- `StatusCards.tsx`：`isStartPlanEntitlementName(planLevel)` →
  `isStartPlanEntitlementProductId(productId)`：按 productId 的**类型段**
  `start-plan` 判定（`/(^|[-_])start-plan([-_]|$)/`，小写匹配）。
  `resolveCodingPlanStatusCardTitle` 改收 `planProductId`（结构 id）而非展示名。
  判据依据：真实载荷里 start-plan 的 plan_id 形如
  `zcode-v3-start-plan-0918` / `zcode-v3-start-plan-0924-wk`（`.reverse/08-entitlement`
  实测 516 条），`start-plan` 是**类型段**而非营销名；官方标识符体系同样以类型区分
  （claim_plan / claim_zcode_plan / zcode-plan / coding-plan / start-plan /
  individual-coding-plan / team-coding-plan）。
- `Detail.tsx`：`resolveStartPlanPurchaseChoiceBannerTitle` 删除
  `/^start\s+plan$/i` 展示名特例——远端名原样展示，缺失时才回落 i18n 文案。

## 5. 判据：为什么"官方再改名不需要改代码"

1. **识别链不含展示名**。领取入口的可见性由 `billing/preview` 的 `plans[]` 是否非空
   决定；领取目标由 `plan_id` 指定；默认目标按 `priority` 排序。全程不读 `name`。
2. **展示名是数据，不是判据**。`plan.name` 原样渲染（可能是 "ZCode Weekend Build"、
   "ZCode Trust Build" 或任何新名字），客户端不存在任何针对它的匹配/分支。
3. **套餐身份按类型段判定**。Start Plan 权益的识别走 productId 的 `start-plan` 类型段
   与 provider 的 account mode（`start-plan`），这些都是接口契约里的稳定类型标识，
   与运营命名解耦。
4. 反例（被本 spec 消除）：`endsWith(" start plan")` 与 `/^start\s+plan$/i`——
   官方把 "Start Plan" 改成 "Trust Build" 后两者立即失效。

## 6. 验收场景

1. **左下角领取卡片出现**：账号下有可领取活动（plan 名为 "ZCode Trust Build"）时，
   聊天输入栏左下角 context 触发器可见，hover 打开后出现领取卡片（名称、权益、
   有效期、"领取"按钮）；点击走与设置页一致的验证码/领取链路；成功显示票券反馈。
2. **仅有领取活动时触发器也出现**：无 context usage、无 Coding/Start Plan 余额，
   但有可领取活动 ⇒ 触发器与领取卡片照常出现（外层门控追加信号）。
3. **无活动不占位**：preview 返回空列表且无错误 ⇒ 触发器（若无其他段）与卡片均不渲染。
4. **读取失败可见可重试**：preview 抛错 ⇒ 面板内出现失败文案与"重试"。
5. **Start Plan 余额段有显式刷新按钮**：点击触发 `onAccess` 静默刷新，刷新中禁用。
6. **名称无关回归**：plan 名为 "ZCode Trust Build"（或任意名字）时入口、识别、
   展示均正常；源码内不存在对英文名/中文名的匹配字符。
7. **设置页卡片行为不变**：state 注入是可选的，既有四态/验证码/票券行为回归通过。
8. **多消费者不双取**：context 面板与设置页卡片同时挂载时，60s 窗口内 preview
   只发一次（in-flight 去重 + TTL 缓存）；显式 refresh/领取成功后立即重取。

## 7. 不在本 spec 范围

- 不搬 `marketing/touch` / `cloud-content`（C-SUCCESS-TICKET §1 非目标，保持）。
- 不做侧边栏底部常驻横幅（官方形态在 sidebar footer；CE 该文件不在本任务写范围，
  如需对齐官方形态由 Lead 排期）。
- 不改服务层（`manualClaimPlanClient` / provider / captcha 求解器）：数据侧已名称无关；
  服务层另有成员负责。
- 不改验证码求解链路（`ManualClaimCaptchaDialog` 等，另一成员写范围）。
