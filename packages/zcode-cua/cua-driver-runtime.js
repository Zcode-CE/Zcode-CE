/**
 * Computer Use 运行时：把 ZCode 的 CUA broker 协议适配到 MIT 许可的
 * `@trycua/cua-driver`（Rust 原生 SDK，六平台预编译二进制）。
 *
 * 为什么需要这一层：两侧的接口面**不同构**，不能直接转发。
 * - ZCode 的模型可见面是 14 个 capability method（computer-use-client.mjs 的
 *   COMPUTER_METHOD_NAMES），按 Codex 的 `cua` 形状定义：`app_ref` 定位应用、
 *   `target` 定位元素/坐标、观察结果回传 `state_id` 与元素表。
 * - cua-driver 的工具面是 59 个 MCP 风格工具，按 `pid` + `window_id` 定位窗口，
 *   元素必须带 `element_token` 或 `snapshot_id` 才允许点击。
 * 所以这里是**协议翻译**：应用名 → pid、窗口解析、元素索引 → element_token、
 * 观察结果 → state_id，以及驱动错误码 → broker 错误码。目标解析的细节在
 * `./cua-driver-targets.js`，信封与错误码在 `./cua-driver-errors.js`。
 *
 * 安全语义（三条，来自 DSH 的 GUIDANCE，必须保留）：
 * 1. 后台投递优先。**拒绝不代表可以改用前台重投** —— 本文件从不传
 *    `delivery_mode: "foreground"`（那个值会真的激活目标窗口抢用户焦点）。
 *    驱动返回 background_unavailable 时映射成 FOREGROUND_REQUIRED 交给模型，
 *    由模型改走元素/键盘路径，而不是我们替它升级。
 * 2. 动作下发成功 ≠ 结果达成。收据里的 `delivery`/`effect` 原样带出去，
 *    让模型自己从**新的观察**里确认结果。
 * 3. 取消后已完成的输入不会回滚：`actionSent` 只在收据明确说下发过时才置 true，
 *    模型据此先观察再决定重试。
 */

import {
  CuaBrokerError,
  actionDelivered,
  brokerCodeForDriverCode,
  errorResult,
  jsonBlock,
  okResult,
  readDriverEnvelope,
  refusalOf,
  textBlock,
} from "./cua-driver-errors.js";
import { CUA_ACTIONS } from "./cua-driver-actions.js";
import {
  appKeyOf,
  matchesRef,
  pickWindow,
  resolveTarget,
  toElement,
  usableWindows,
} from "./cua-driver-targets.js";

const DRIVER_PACKAGE = "@trycua/cua-driver";

/**
 * 驱动在 KDE/GNOME Wayland 会话下默认关闭原生 Wayland 后端（上游标为 experimental），
 * 关闭时 `list_windows` 恒返回 0 行 —— Computer Use 直接不可用（实测：同一会话下
 * 开启后 30 行、关闭 0 行）。我们只在**用户没表态**且检测到 Wayland 会话时打开它，
 * 否则保持用户/上游的选择。这是驱动自己的开关，不是 ZCode 的环境变量约定。
 */
const WAYLAND_ENABLE_ENV = "CUA_DRIVER_RS_ENABLE_WAYLAND";

/**
 * @param {{ loadDriver?: () => Promise<unknown> }} [options]
 *   `loadDriver` 是测试注入点：默认动态 import 真实驱动；回归测试用一个记录调用的假驱动，
 *   从而在没有图形会话的 CI 上也能覆盖路由、错误映射与资源释放。
 *   生产路径永远不传它。
 */
export function createCuaDriverRuntime(options = {}) {
  const loadDriver =
    options.loadDriver ??
    (async () => {
      if (!process.env[WAYLAND_ENABLE_ENV] && process.env.WAYLAND_DISPLAY) {
        process.env[WAYLAND_ENABLE_ENV] = "1";
      }
      const mod = await import(DRIVER_PACKAGE);
      return mod.CuaDriver.create(undefined);
    });
  let driverPromise;
  let driverInstance;
  let disposed = false;
  /** 运行时生命周期信号：dispose() 时 abort，取消在途的原生调用。 */
  const lifetime = new AbortController();
  /** 串行化驱动调用：原生句柄不保证可重入。 */
  let queue = Promise.resolve();
  /** 每个 (sessionId, appKey) 最近一次观察，供元素索引解析与 state_id 回传。 */
  const observations = new Map();
  /**
   * 已被 stop_computer_control 关闭的 session。
   *
   * kill switch 必须在**会话生命周期内**持续生效：文档要求「Stop immediately after
   * agent.computerUse.stop()… and do not switch to a different UI-automation technology」。
   * 如果 stop 之后的下一次调用悄悄重建隐式会话，模型只要再发一个 cell 就能继续操作桌面 ——
   * 那等于没有 kill switch。这里把它钉到会话结束（closeSession）为止。
   */
  const stoppedSessions = new Set();

  const serialize = (run) => {
    const next = queue.then(run, run);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const sessionKeyOf = (context) => context?.sessionId?.trim() || "__unscoped__";

  const ensureDriver = async () => {
    if (disposed)
      throw new CuaBrokerError("Computer Use runtime is disposed", { code: "internal" });
    if (!driverPromise) {
      driverPromise = (async () => {
        try {
          driverInstance = await loadDriver();
        } catch (error) {
          // 平台二进制缺失（optionalDependencies 未装到本平台）会走到这里。
          // 归 broker_unavailable → HELPER_UNAVAILABLE：这是「本机没有可用后端」，
          // 不是可以盲目重试的暂时故障。
          throw new CuaBrokerError(
            `Computer Use driver is unavailable on this platform: ${error instanceof Error ? error.message : String(error)}`,
            { code: "broker_unavailable" },
          );
        }
        return driverInstance;
      })().catch((error) => {
        // 启动失败必须回滚，否则后续每次调用都复用一个已死的 promise，
        // 且 driverInstance 会留下半初始化的句柄。
        driverPromise = undefined;
        throw error;
      });
    }
    return await driverPromise;
  };

  /**
   * 调一次驱动工具，返回原始信封。
   *
   * **必须**传 signal，且不能传 undefined：`@ubjs/core@0.31.0-3` 的 async-rust-call
   * 里写的是 `asyncOpts?.signal.aborted` —— 可选链只护住了 `asyncOpts`，没护住
   * `signal`。于是 `{}`、`{signal: undefined}` 都会抛
   * "Cannot read properties of undefined (reading 'aborted')"，而 `{signal}` 正常。
   * 实测：no-signal / undef-signal 抛错，signal 通过。这是上游缺陷，不是我们的用法问题，
   * 所以这里永远合成一个信号，而不是把参数原样透传。
   *
   * 合成用 lifetime.signal：dispose() 时 abort 它，让在途的原生调用真正被取消，
   * 而不是等 Rust future 自己跑完。
   */
  const callDriverOnce = async (toolName, args, signal) => {
    const driver = await ensureDriver();
    if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
    if (lifetime.signal.aborted) throw new DOMException("aborted", "AbortError");
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const raw = await driver.callTool(toolName, JSON.stringify(args ?? {}), { signal: combined });
    const envelope = readDriverEnvelope(raw.rawJson);
    const refusal = refusalOf(envelope);
    if (refusal) {
      throw new CuaBrokerError(refusal.message, {
        code: brokerCodeForDriverCode(refusal.code),
        actionSent: actionDelivered(envelope),
        details: { driverCode: refusal.code, tool: toolName },
      });
    }
    return envelope;
  };

  /**
   * 带会话自愈的驱动调用。
   *
   * 驱动维护一个**隐式**生命周期会话，并在空闲到期后拒绝后续调用
   * （refusal code = `session_ended`）。没有自愈的话，一段超过会话 TTL 的闲置就会让
   * Computer Use 永久不可用，而模型只看到一句 session_ended —— 既不可自愈也不可诊断。
   *
   * 重放安全性：`session_ended` 表示驱动在**执行之前**就拒绝了，动作没有下发
   * （`actionDelivered` 为 false），所以补一次 start_session 再重放不会重复输入。
   * 这条守卫是必须的 —— 对可能已下发的动作重放会真的多点一次。
   */
  const callDriver = async (toolName, args, signal) => {
    try {
      return await callDriverOnce(toolName, args, signal);
    } catch (error) {
      const rearmable =
        error instanceof CuaBrokerError &&
        error.details?.driverCode === "session_ended" &&
        error.actionSent !== true &&
        toolName !== "start_session" &&
        toolName !== "end_session";
      if (!rearmable) throw error;
      await callDriverOnce("start_session", {}, signal);
      return await callDriverOnce(toolName, args, signal);
    }
  };

  // ─────────────────────────────────────────── 应用与窗口解析

  /** list_apps 的原始行。命中缓存避免每个动作都重扫 800 个进程。 */
  let appCache;
  const loadApps = async (signal, { fresh = false } = {}) => {
    if (!appCache || fresh) {
      const envelope = await callDriver("list_apps", {}, signal);
      appCache = Array.isArray(envelope.structured.apps) ? envelope.structured.apps : [];
    }
    return appCache;
  };

  /**
   * app_ref → 运行中的应用行。
   * 未运行且有 launch_path 时按文档承诺透明拉起一次（getApp 的语义是「需要时后台启动」）。
   */
  const resolveApp = async (appRef, signal) => {
    if (!appRef || typeof appRef !== "object") {
      throw new CuaBrokerError("app_ref is required", { code: "invalid_request" });
    }
    const find = (apps) =>
      apps.find((app) => app.running && app.pid > 0 && matchesRef(app, appRef));
    let hit = find(await loadApps(signal));
    if (!hit) {
      const candidate = (await loadApps(signal)).find((app) => matchesRef(app, appRef));
      if (candidate?.launch_path || candidate?.name) {
        try {
          await callDriver(
            "launch_app",
            candidate.launch_path
              ? { launch_path: candidate.launch_path }
              : { name: candidate.name },
            signal,
          );
        } catch {
          // 拉起失败不在这里抛：下面的重新查找会给出「找不到应用」这个更准确的结论。
        }
        appCache = undefined;
        hit = find(await loadApps(signal, { fresh: true }));
      }
    }
    if (!hit) {
      // 客户端把「target app is not running」当作可换字段重试的信号，文案必须保留这句。
      throw new CuaBrokerError(
        `target app is not running, and no installed application matched the ${appRef.bundle_id ? "bundle id" : "name"} ${appRef.bundle_id ?? appRef.name ?? appRef.pid}`,
        { code: "element_unavailable", details: { appRef } },
      );
    }
    return hit;
  };

  const listWindowsOf = async (pid, signal) => {
    const envelope = await callDriver("list_windows", pid ? { pid } : {}, signal);
    return usableWindows(envelope.structured.windows);
  };

  const resolveAppWindow = async (appRef, signal) => {
    const app = await resolveApp(appRef, signal);
    const windows = await listWindowsOf(app.pid, signal);
    const wanted = typeof appRef.window_id === "number" ? appRef.window_id : undefined;
    const window = pickWindow(windows, wanted);
    if (!window) {
      throw new CuaBrokerError(
        wanted === undefined
          ? `app "${app.name}" has no open window`
          : `window ${wanted} of "${app.name}" is not open; call list_windows to pick a fresh window_id`,
        { code: "element_unavailable" },
      );
    }
    return { app, window };
  };

  // ─────────────────────────────────────────── 观察状态

  const observationKey = (context, appRef) => `${sessionKeyOf(context)}|${appKeyOf(appRef)}`;

  // ─────────────────────────────────────────── 方法实现

  const methodListApps = async (context, signal) => {
    const apps = await loadApps(signal, { fresh: true });
    // 驱动在 Linux 上把 800+ 个进程全当应用返回（systemd/kworker 都在里面）。
    // 只保留用户可寻址的目标：XDG 桌面项，或当前持有窗口的进程 —— 否则单次
    // list_apps 就有 ~130KB 进模型上下文。
    const owners = new Set(
      usableWindows((await callDriver("list_windows", {}, signal)).structured.windows).map(
        (w) => w.pid,
      ),
    );
    const visible = apps.filter(
      (app) => app.kind === "desktop" || (app.running && app.pid > 0 && owners.has(app.pid)),
    );
    return okResult({
      content: [jsonBlock({ apps: visible })],
      structuredContent: { apps: visible },
    });
  };

  const methodListWindows = async (context, args, signal) => {
    const appRef = args?.app_ref;
    const pid = appRef ? (await resolveApp(appRef, signal)).pid : undefined;
    const windows = await listWindowsOf(pid, signal);
    return okResult({
      content: [jsonBlock({ windows })],
      structuredContent: { windows },
    });
  };

  const observe = async (context, args, signal) => {
    const appRef = args?.app_ref;
    const { app, window } = await resolveAppWindow(appRef, signal);
    const envelope = await callDriver(
      "get_window_state",
      {
        pid: app.pid,
        window_id: window.window_id,
        include_accessibility_tree: args?.include_accessibility_tree !== false,
        include_screenshot: args?.include_screenshot === true,
        ...(args?.max_elements === undefined ? {} : { max_elements: args.max_elements }),
      },
      signal,
    );
    const structured = envelope.structured;
    const elements = (Array.isArray(structured.elements) ? structured.elements : []).map(toElement);
    const stateId = typeof structured.snapshot_id === "string" ? structured.snapshot_id : undefined;
    const state = {
      state_id: stateId,
      app: {
        pid: app.pid,
        name: app.name ?? null,
        bundle_id: app.bundle_id ?? null,
        active: app.active === true,
      },
      window: {
        window_id: window.window_id,
        title: structured.window_title ?? window.title ?? null,
        bounds: structured.window_bounds ?? window.bounds ?? null,
      },
      elements,
      text: typeof structured.tree_markdown === "string" ? structured.tree_markdown : "",
      element_count: structured.element_count ?? elements.length,
      ...(structured.elements_complete === false ? { elements_complete: false } : {}),
      ...(typeof structured.truncation_reason === "string"
        ? { non_actionable_reason: structured.truncation_reason }
        : {}),
    };
    observations.set(observationKey(context, appRef), {
      stateId,
      elements,
      windowId: window.window_id,
      pid: app.pid,
    });
    return { state, envelope };
  };

  const methodGetAppState = async (context, args, signal) => {
    const { state, envelope } = await observe(context, args, signal);
    const content = [];
    if (state.text) content.push(textBlock(state.text));
    for (const block of envelope.images) {
      content.push({ type: "image", data: block.data, mimeType: block.mimeType ?? "image/png" });
    }
    const screenshotError = envelope.structured.screenshot_error;
    // 请求了像素却没拿到，必须说清原因：否则模型只能猜，历史上会升级成抢焦点。
    const reason = !screenshotError
      ? undefined
      : typeof screenshotError === "string"
        ? screenshotError
        : (screenshotError.reason ?? screenshotError.code);
    if (reason) content.push(textBlock(`[screenshot unavailable: ${reason}]`));
    return okResult({
      content,
      structuredContent: { ...state, ...(reason ? { non_actionable_reason: reason } : {}) },
    });
  };

  /** 动作类方法共用：解析目标 + 调驱动 + 把收据原样回传。 */
  const runAction = async (context, args, signal, plan) => {
    const appRef = args?.app_ref;
    const { app, window } = await resolveAppWindow(appRef, signal);
    // target 是**可选**的：`type` / `key` 的签名里 target 可省略（输入落到当前焦点），
    // `scroll` / `click` 等则必填。只有调用方确实给了目标才解析 —— 把 undefined 丢给
    // resolveTarget 会把「合法的不带目标输入」误判成参数错误。
    const requested = plan.target?.(args);
    const target =
      requested === undefined
        ? {}
        : resolveTarget(requested, observations.get(observationKey(context, appRef)));
    const envelope = await callDriver(
      plan.tool,
      { pid: app.pid, window_id: window.window_id, ...target, ...plan.args(args) },
      signal,
    );
    // **不**在动作后清掉观察记录。
    //
    // 官方契约（computer-use.md「Workflow」）明确允许复用同一个索引：
    // 「several actions may reuse one index without re-observing between them —
    // click an index, then type into it, in the same cell」。而 computer-use-client.mjs
    // 里那段注释记录了为什么客户端**移除**了同类守卫。真正知道元素是否还有效的是驱动：
    // element_token 自带快照身份，被新快照取代后返回 stale_element_token，元素消失时
    // fail closed。所以失效判定交给驱动，适配层不提前否决 —— 否则按文档写的
    // click(9); setValue(9, …) 会必然失败。
    return okResult({
      content: envelope.texts.filter(Boolean).map(textBlock),
      structuredContent: envelope.structured,
    });
  };

  const methodRequestAccess = async (context, args, signal) => {
    const envelope = await callDriver("check_permissions", {}, signal);
    const structured = envelope.structured;
    const status = {
      ready:
        structured.x11 === true || structured.wayland_enabled === true || structured.atspi === true,
      accessibility: structured.atspi === true ? "granted" : "unknown",
      screenRecording: structured.x11 === true ? "granted" : "unknown",
      message: envelope.texts.join("\n"),
    };
    return okResult({ content: [jsonBlock(status)], structuredContent: status });
  };

  const methodStop = async (context, args) => {
    // kill switch 只钉在**发起 stop 的那个会话**上（见 stoppedSessions 的说明）。
    //
    // 为什么不直接 end_session 驱动会话：驱动只有一个隐式会话，被别的会话
    // （另一个窗口 / 另一个 node_repl runtime）共用。停掉它等于替所有会话断电 ——
    // 实测 s1 stop 之后，s2 的下一次调用会撞 session_ended。这里改为：
    // 本会话此后一律拒绝（controller_busy），其他会话不受影响；驱动会话保持存活。
    const key = sessionKeyOf(context);
    stoppedSessions.add(key);
    const prefix = `${key}|`;
    for (const observationKey of observations.keys()) {
      if (observationKey.startsWith(prefix)) observations.delete(observationKey);
    }
    return okResult({ structuredContent: { stopped: true, reason: args?.reason ?? null } });
  };

  const handlers = {
    list_apps: (context, args, signal) => methodListApps(context, signal),
    list_windows: methodListWindows,
    get_app_state: methodGetAppState,
    request_access: methodRequestAccess,
    stop_computer_control: (context, args) => methodStop(context, args),
    ...Object.fromEntries(
      Object.entries(CUA_ACTIONS).map(([name, build]) => [
        name,
        (context, args, signal) => runAction(context, args, signal, build(args ?? {})),
      ]),
    ),
  };

  return {
    async execute({ toolName, arguments: args, context, signal }) {
      const handler = handlers[toolName];
      if (!handler) {
        // 驱动没有对应能力（select_text / perform_action / paste）。
        // 归 unimplemented → ACTION_UNAVAILABLE（客户端 NEVER_RETRY_CODES）：
        // 明确告诉模型这条路不存在，别反复重试，改走元素或键盘路径。
        return errorResult({
          code: "unimplemented",
          message: `Computer Use method "${toolName}" has no equivalent in the open-source driver; use element or keyboard actions instead.`,
        });
      }
      if (disposed) {
        return errorResult({
          code: "broker_unavailable",
          message: "Computer Use runtime is disposed",
        });
      }
      // kill switch：本会话已 stop，除再次 stop 外一律拒绝。
      // controller_busy → CONTROLLER_BUSY 在客户端是 NEVER_RETRY_CODES，
      // 模型据此停止而不是换个方法继续操作桌面。
      if (stoppedSessions.has(sessionKeyOf(context)) && toolName !== "stop_computer_control") {
        return errorResult({
          code: "controller_busy",
          message:
            "Computer Use control was stopped for this session. Do not continue; ask the user to start a new session.",
        });
      }
      try {
        return await serialize(() => handler(context, args ?? {}, signal));
      } catch (error) {
        if (error instanceof CuaBrokerError) {
          return errorResult({
            code: error.code,
            message: error.message,
            actionSent: error.actionSent,
            details: error.details,
          });
        }
        if (error?.name === "AbortError" || signal?.aborted) throw error;
        return errorResult({
          code: "internal",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async closeSession(context) {
      const sessionKey = sessionKeyOf(context);
      stoppedSessions.delete(sessionKey);
      const prefix = `${sessionKey}|`;
      for (const key of observations.keys()) if (key.startsWith(prefix)) observations.delete(key);
    },

    async dispose() {
      disposed = true;
      // 先取消在途调用再释放句柄：反序会让 shutdown() 与仍持锁的原生调用互相等待。
      lifetime.abort(new DOMException("Computer Use runtime is disposed", "AbortError"));
      observations.clear();
      const instance = driverInstance;
      driverInstance = undefined;
      driverPromise = undefined;
      if (!instance) return;
      // 真正释放原生资源：shutdown 结束会话，uniffiDestroy 释放 FFI 句柄。
      // 少了后者，Rust 侧对象会留到进程退出。
      await Promise.resolve()
        .then(() => instance.shutdown())
        .catch(() => undefined)
        .finally(() => {
          try {
            instance.uniffiDestroy();
          } catch {
            // 已释放时重复销毁会抛，忽略。
          }
        });
    },
  };
}

/** 平台是否具备驱动预编译二进制的目标三元组。用于在装配点给出可诊断的不可用原因。 */
export const CUA_DRIVER_SUPPORTED_PLATFORMS = Object.freeze([
  "darwin-x64",
  "darwin-arm64",
  "linux-x64-gnu",
  "linux-arm64-gnu",
  "win32-x64-msvc",
  "win32-arm64-msvc",
]);
