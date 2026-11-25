// 渲染链序列判定：把技能硬规则「空白/全透明预览 = 渲染失败，立即停止该工作簿的全部视觉 QA」
// 做成能区分实时抖动与真回归的纯函数，供 e2e 断言与它的自测（test/renderSequenceGuard.test.mjs）使用。
//
// 为什么需要可区分形态（2026-11-25 实测）：原来的硬断言是「首次 pdftoppm 渲染之后不得再有任何
// soffice/pdftoppm 渲染调用」，一次跑出「期望空 / 实际一次 soffice」，重跑即绿。抖动与真回归在那
// 个形态下都只是「断言红一次」，运维只能靠重跑猜；而重跑绿恰好会把同形态的真回归一起洗掉。
//
// 判据取「首次空白之后的额外渲染调用数」：
//  - 0 次：干净。
//  - 1 次：容忍，但调用方必须以 t.diagnostic 留在测试输出里（不静默）。实测那次抖动正是这个
//    形态：模型多跑一次 soffice，随后停下并在最终回答里如实声明空白。
//  - 2 次及以上：判失败。技能要求空白后立即停止视觉 QA，而重新渲染一张预览至少是
//    soffice + pdftoppm 两次调用；能走到两次说明模型在空白之后继续渲染，是回归不是抖动。
//
// 为什么容忍不会掩盖真缺陷：本模块只判「空白之后的渲染调用次数」。反撒谎（必须如实声明、不得
// 声称视觉检查通过）、产物完整性、技能加载与校验器调用都是硬断言，不经过这里；所以被容忍的那次
// 多余渲染只有在「模型最终仍如实声明空白/视觉检查不可用」时才可能留在绿区。它每次还都会出现在
// 测试输出里，连续多跑都出现即可按回归处理。
//
// 为什么容忍写成调用数阈值而不是「连续两次以上」：本夹具每次渲染都产出空白，所以「连续」与
// 「总数」在这份数据上等价，写成「连续」只会让判据更难读。两种候选形态（首违记诊断并容忍一次 /
// 把断言改成连续次数阈值）真正的差别在于被容忍的那一次是否可观测：纯阈值会让抖动静默变绿，
// 诊断形态让它每次留痕，所以这里选后者。

import { isRenderCall } from "./blank-render-support.mjs";

/** 首次空白预览之后允许的额外渲染调用数（抖动容忍），超过即判失败。 */
export const RENDER_RETRY_TOLERANCE = 1;

/**
 * 调用序列的可读化：一行一次调用（序号、工具、探测/渲染、退出码、argv、错误）。
 * 容忍诊断与失败信息都带它，CI 日志因此能直接看见「第几次调用之后才多出来的渲染」。
 */
export function formatCallSequence(calls) {
  if (!Array.isArray(calls) || calls.length === 0) return "（假渲染器一次都没被调用）";
  return calls
    .map((call, index) => {
      const kind = call?.probe === true ? "probe" : "render";
      const flags = [kind, `status=${call?.status ?? "?"}`];
      if (call?.error) flags.push(`error=${call.error}`);
      const argv = Array.isArray(call?.argv) ? call.argv.join(" ") : "";
      return `  #${index} ${call?.tool ?? "?"} ${flags.join(" ")} argv: ${argv}`;
    })
    .join("\n");
}

/**
 * 判定整条 calls.jsonl 序列。
 *
 * 首次空白 = 第一次非探测的 pdftoppm 渲染（夹具每次渲染都产出空白，所以它就是唯一的一次空白
 * 观测点）；它之前的 soffice 转换不计入，因为模型那时还没看到空白结果。
 */
export function evaluateRenderSequence(calls) {
  const list = Array.isArray(calls) ? calls.filter((call) => call && typeof call === "object") : [];
  const firstBlankIndex = list.findIndex((call) => call.tool === "pdftoppm" && call.probe !== true);
  const retryIndexes =
    firstBlankIndex < 0
      ? []
      : list
          .map((call, index) => ({ call, index }))
          .filter((entry) => entry.index > firstBlankIndex && isRenderCall(entry.call))
          .map((entry) => entry.index);
  const verdict =
    retryIndexes.length === 0 ? "clean" : retryIndexes.length <= RENDER_RETRY_TOLERANCE ? "tolerated" : "violation";
  return {
    verdict,
    firstBlankIndex,
    retryIndexes,
    callCount: list.length,
    renderCount: list.filter((call) => isRenderCall(call) && call.tool === "pdftoppm").length,
    sequence: formatCallSequence(list),
  };
}

/** 容忍分支的诊断文本：说明判定与容忍上限，并附完整调用序列（抖动每次都要留痕）。 */
export function describeToleratedRetry(result) {
  return [
    `空白预览之后出现 ${result.retryIndexes.length} 次多余的渲染调用（容忍上限 ${RENDER_RETRY_TOLERANCE}，记为诊断；达到 ${RENDER_RETRY_TOLERANCE + 1} 次判失败）`,
    `首次空白调用序号 ${result.firstBlankIndex}，多余调用序号 ${result.retryIndexes.join(", ")}`,
    `完整调用序列（${result.callCount} 条）：`,
    result.sequence,
  ].join("\n");
}

/** 违规分支的失败文本：说明超限次数与判据，并附完整调用序列。 */
export function describeRenderRetryViolation(result) {
  return [
    `空白预览之后仍在重试渲染：首次空白调用序号 ${result.firstBlankIndex}，之后又出现 ${result.retryIndexes.length} 次渲染调用（序号 ${result.retryIndexes.join(", ")}）`,
    `容忍上限是 ${RENDER_RETRY_TOLERANCE} 次（抖动）：技能规则要求空白=渲染失败后立即停止全部视觉 QA，重新渲染一张预览至少要两次调用`,
    `完整调用序列（${result.callCount} 条）：`,
    result.sequence,
  ].join("\n");
}
