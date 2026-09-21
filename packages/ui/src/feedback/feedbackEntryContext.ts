import { create } from "zustand";

/**
 * 反馈入口上下文的交接通道。
 *
 * 为什么需要它：
 * 反馈入口（错误横幅、任务右键菜单、远程连接失败页…）天然握有「用户当时看到的东西」——
 * 报错原文、任务标题与日志路径、连接日志。而设置页的「反馈与诊断」分区刻意不接 workspace
 * 参数（保证本机 / 远端 workspace 行为一致），两者之间原本没有任何通道，
 * 于是从入口点进去的反馈会丢掉现场，用户必须自己再抄一遍。
 *
 * 这里用一个极小的 zustand store 只做「一次性交接」：
 * - 入口写入 → 打开设置页 → 分区挂载时**消费并清空**；
 * - 消费后立刻清空，避免用户下一次从别处进设置页时又被上一次的错误现场污染（A6）。
 *
 * 边界：本模块**不做脱敏**，它只负责搬运。脱敏由消费侧的
 * `feedbackEntryPlan.redactFeedbackEntryText` 统一收口——那是唯一保证
 * 「无论哪条路径进正文/标题都过 redactFeedbackText」的地方。
 *
 * 为什么不在写入侧要求调用方先脱敏：早期版本这样假设过，结果 `errorSummary` 与 issue 标题
 * 两条新路径都直接传了错误原文，JWT / api_key / password / token 实测全部泄漏到对外 URL（V-3）。
 * 把保证放在唯一消费点，而不是分散在 8 个入口的自觉上，才是可验证的边界。
 *
 * 本模块也不持有 deviceMid / 账号 / 凭据——它们不属于「入口上下文」。
 */
export interface FeedbackEntryContext {
  /**
   * 用户可见的错误摘要，进诊断的 error 字段。
   * 入口侧传**可读原文即可，不需要先脱敏**——消费点统一收口（见上方边界说明）。
   */
  errorSummary?: string;
  /**
   * 问题描述，进诊断的 notes 字段，同时参与 issue 标题推导。
   * 同样不需要入口先脱敏；已脱敏的 draft 文本再脱敏一次是幂等的。
   */
  description?: string;
  /** 可选标题；缺省时由 errorSummary / description 首行推导。同样在消费点脱敏。 */
  title?: string;
}

interface FeedbackEntryContextState {
  context: FeedbackEntryContext | null;
  setContext: (context: FeedbackEntryContext | null) => void;
}

export const useFeedbackEntryContextStore = create<FeedbackEntryContextState>((set) => ({
  context: null,
  setContext: (context) => set({ context }),
}));

/** 供非 React 上下文（事件回调、测试）写入入口上下文。 */
export function setFeedbackEntryContext(context: FeedbackEntryContext | null): void {
  useFeedbackEntryContextStore.getState().setContext(context);
}

/**
 * 一次性取出并清空入口上下文。
 *
 * 用「取出即清空」而不是「读取后由调用方手动清理」，是因为消费点（设置分区挂载）
 * 可能在 StrictMode 下重放、也可能因为用户反复进出分区而多次执行；
 * 由消费点负责清理会出现「漏清一次就长期残留」的隐蔽缺陷。
 */
export function consumeFeedbackEntryContext(): FeedbackEntryContext | null {
  const { context, setContext } = useFeedbackEntryContextStore.getState();
  if (context) {
    setContext(null);
  }
  return context;
}
