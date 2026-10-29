# Prompt 模型准入（X2 最小片）

## 1. 问题

模型选择不可用时，输入曾先被 Core admission 接收、后台再创建 Model 失败 ⇒ 输入丢失、会话停在
「没有反应」，用户看不到可操作的错误。上游 3.16.2 的 X2 修复把模型可用性检查前移到 ACK 之前。

## 2. 规则

- `preflightPromptTurn` 在任何 admission 之前执行：
  - 恢复告警（`restoreWarning`）仍按既有逻辑重评：宿主能给出可用目标就清除过期告警，否则拒绝；
  - 普通 Selection（`selectionScope !== "execution"`）必须在宿主 `listModels()` 的目录里存在，
    否则抛 `V4PromptRejectedError("modelUnavailable", ...)` —— 后台不再有机会静默失败；
  - execution Selection 暂不在这里校验：CE 尚未搬 `selectionFallback` 子系统，严格校验会误拒
    仍可在 Core 退回原模型的加速输入。这条差异是**有意的**，等 fallback 落地再收紧。
  - `requireQueue` 的输入按普通 Selection 预检（排队提升时模型可能已变化，但那属于提升边界）。
- 准入失败不修改 turn 生命周期、不消耗输入；成功后才进入原有 sendInput/admission 流程。

## 3. 验收

- 不可用普通 Selection：`preflightPromptTurn` 在 ACK 前拒绝，`reasonCode = modelUnavailable`；
- 可用 Selection、execution Selection：放行；
- 过期 restoreWarning 且宿主报告可用目标：清除告警后放行；
- 根 `typecheck` / `typecheck:cli` / `lint` 与 bootstrap 测试通过。

## 4. 未做 / 未验证

- 未搬 `selectionFallback`（Highspeed 退回原模型）整链；
- destructive edit/retry 的「branch cut 前预检、提交后直接消费」上游拆分为 `startPreflightedPromptTurn`，
  CE 当前仍在提交后走完整 `startPromptTurn`（会再次预检）；待编辑重发链路需要时再拆；
- 真实 provider 下模型列表缺失/竞态未实机复现。
