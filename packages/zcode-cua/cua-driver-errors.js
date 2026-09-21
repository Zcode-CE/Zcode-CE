/**
 * cua-driver 失败形态 → ZCode CUA broker 错误码，以及 MCP 结果信封的构造。
 *
 * 为什么需要这一层（而不是把 cua-driver 自己的 refusal.code 直接抛给模型）：
 * 模型可见的错误码由 `computer-use-client.mjs` 的 ERROR_CODE_BY_BROKER 决定 —— 它只认
 * broker 码（snake_case），映射不到的一律归 INTERNAL。若这里原样透传
 * `snapshot_id_required` / `window_target_not_found`，每次失败都会退化成 INTERNAL，
 * 模型就失去「先重新观察再试」与「绝不重试」的区别 —— 而那正是这张表存在的理由。
 *
 * 取值口径：本文件只发 broker 码；映射不到的一律 internal（→ INTERNAL），不猜。
 */

/**
 * cua-driver refusal/error code → ZCode broker code。
 * 右侧取值必须落在 computer-use-client.mjs 的 ERROR_CODE_BY_BROKER 键集合内。
 */
const BROKER_CODE_BY_DRIVER_CODE = Object.freeze({
  // 快照/元素失效：客户端映射成 ELEMENT_UNAVAILABLE，retry 决策为 reobserve。
  // 这类失败的正确反应是「重新观察后按新索引重做」，不是重放旧动作。
  snapshot_id_required: "element_unavailable",
  stale_element_token: "element_unavailable",
  stale_snapshot: "element_unavailable",
  element_not_found: "element_unavailable",
  element_unavailable: "element_unavailable",
  // 目标窗口/应用已不在：同样先刷新再试。
  window_target_not_found: "element_unavailable",
  window_not_found: "element_unavailable",
  // 后台投递不可用是**能力**拒绝，不是暂时故障：客户端映射成 FOREGROUND_REQUIRED，
  // 落在 NEVER_RETRY_CODES。适配层绝不因此改用前台重投 —— 安全语义
  // 「a refusal does not authorize a foreground retry」就靠这条守住。
  background_unavailable: "foreground_required",
  foreground_required: "foreground_required",
  // 权限与授权
  permission_denied: "permission_denied",
  accessibility_denied: "permission_denied",
  screen_locked: "permission_denied",
  not_authorized: "not_authorized",
  // 启动
  launch_failed: "launch_failed",
  // 可设置/可选择语义
  not_settable: "not_settable",
  not_selectable: "not_selectable",
  // 该能力在本驱动/本平台上不存在。归 unimplemented → ACTION_UNAVAILABLE（永不重试），
  // 让模型改用别的路径，而不是反复重试一个根本不存在的能力。
  unimplemented: "unimplemented",
  unsupported: "unimplemented",
  action_unavailable: "action_unavailable",
  // 会话与并发
  controller_busy: "controller_busy",
  session_not_found: "controller_busy",
  // 会话已结束（stop 之后、或显式 end_session 之后）。客户端没有 CONTROL_STOPPED 的
  // broker 码，最接近的语义是 controller_busy → CONTROLLER_BUSY（永不重试），
  // 让模型停下而不是当成 INTERNAL 反复重试。
  session_ended: "controller_busy",
  // 驱动本体不可用
  driver_unavailable: "broker_unavailable",
  transport_error: "broker_unavailable",
  // 参数与内部错误
  invalid_arguments: "invalid_request",
  invalid_request: "invalid_request",
  timeout: "timeout",
  internal: "internal",
});

/** 驱动错误码 → broker 码。未知码归 internal，绝不静默当成成功。 */
export function brokerCodeForDriverCode(code) {
  if (typeof code !== "string" || !code) return "internal";
  return BROKER_CODE_BY_DRIVER_CODE[code] ?? "internal";
}

/**
 * 适配层内部错误：带上 broker 码与「动作是否可能已下发」。
 *
 * actionSent 的方向是**故意保守**的：只有在收据明确说下发过时才置 true。
 * 反过来（默认 true）会让模型对一个从未下发的动作放弃重试。
 */
export class CuaBrokerError extends Error {
  constructor(message, { code = "internal", actionSent = false, details } = {}) {
    super(message);
    this.name = "CuaBrokerError";
    this.code = code;
    this.actionSent = actionSent === true;
    if (details !== undefined) this.details = details;
  }
}

export function textBlock(text) {
  return { type: "text", text };
}

export function jsonBlock(value) {
  return { type: "text", text: JSON.stringify(value) };
}

export function imageBlock(base64, mimeType) {
  return { type: "image", data: base64, mimeType };
}

/** 成功信封。content 为 [] 时也要保留 structuredContent，宿主展示面板需要它。 */
export function okResult({ content = [], structuredContent } = {}) {
  return { content, ...(structuredContent ? { structuredContent } : {}) };
}

/**
 * 失败信封。
 *
 * 为什么不是 throw：broker 会把抛出的异常压成 `{ok:false,error:"字符串"}`，客户端
 * `bridge.call` 只能再抛一个普通 Error —— 模型拿到的是没有 code、没有 actionSent 的
 * 一句话。所以工具级失败必须以 isError 结果回传，让 assertOk 能读到 code/action_sent。
 */
export function errorResult({ code, message, actionSent = false, details }) {
  const payload = {
    code,
    message,
    ...(details === undefined ? {} : { details }),
  };
  return {
    content: [jsonBlock(payload)],
    structuredContent: {
      code,
      message,
      ...(actionSent ? { action_sent: true, dispatch_status: "possibly_sent" } : {}),
    },
    isError: true,
  };
}

/**
 * 读 driver 的 rawJson 信封。
 *
 * 形态（实测 0.28.2）：{content:[{type:"text",text}], structuredContent?, isError?}。
 * 拒绝分两种落点：老一些的路径给 structuredContent.refusal + status:"refused"，
 * 另一些只给 isError + structuredContent.code（或干脆只有一段文本）。
 */
export function readDriverEnvelope(rawJson) {
  let parsed;
  if (typeof rawJson === "string") {
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      throw new CuaBrokerError("cua-driver returned a malformed tool result", {
        code: "internal",
        details: { raw: String(rawJson).slice(0, 200) },
      });
    }
  } else if (rawJson && typeof rawJson === "object") {
    parsed = rawJson;
  } else {
    throw new CuaBrokerError("cua-driver returned an empty tool result", { code: "internal" });
  }
  const content = Array.isArray(parsed.content) ? parsed.content : [];
  return {
    parsed,
    isError: parsed.isError === true,
    structured:
      parsed.structuredContent && typeof parsed.structuredContent === "object"
        ? parsed.structuredContent
        : {},
    texts: content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text),
    images: content.filter((block) => block?.type === "image"),
  };
}

/** 从信封里取出驱动自己的拒绝原因（code + message）。取不到返回 undefined。 */
export function refusalOf(envelope) {
  const { structured, texts, isError } = envelope;
  const refusal = structured.refusal;
  if (refusal && typeof refusal === "object" && typeof refusal.code === "string") {
    return {
      code: refusal.code,
      message:
        typeof refusal.message === "string" && refusal.message ? refusal.message : refusal.code,
    };
  }
  if (typeof structured.code === "string" && structured.code) {
    const text = texts.find((value) => value && value !== structured.code);
    return { code: structured.code, message: text ?? structured.code };
  }
  if (!isError) return undefined;
  // 只剩一段纯文本的失败（例如 "Window target pid 1, window_id 2 is stale..."）。
  // 归 element_unavailable：语义是「刷新后再试」，不是重放动作。
  return { code: "element_unavailable", message: texts[0] ?? "cua-driver refused the request" };
}

/**
 * 动作是否**可能已经下发**。
 *
 * 只认驱动收据里的 delivered_count：effect 为 suspected_noop 也算已下发 ——
 * 输入确实进了目标应用，只是界面没变，重放会真的多点一次。
 */
export function actionDelivered(envelope) {
  const delivery = envelope.structured.delivery;
  return typeof delivery?.delivered_count === "number" && delivery.delivered_count > 0;
}
