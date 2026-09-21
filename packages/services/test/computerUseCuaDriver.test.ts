import assert from "node:assert/strict";
import test from "node:test";
import { createComputerUseRuntime } from "../../zcode-cua/index.js";

/**
 * Computer Use 运行时（cua-driver 适配层）的回归测试。
 *
 * 为什么用假驱动而不是真驱动：真驱动需要图形会话 + 平台原生二进制，CI 上跑不了；
 * 而这一层要守的恰恰**不是**驱动的桌面能力，是适配层自己的契约 ——
 *   ① 14 个 broker method 到驱动工具的**路由形状**（应用名→pid、target→element_token、
 *      key 和弦拆分…）。这些字段名一旦写错，真机上表现为「每次观察都被 unrecognized_keys
 *      打回」或「静默点到别的控件」，而且只有真机才能发现。
 *   ② 错误码映射。客户端只认 broker 码，映射错了全部退化成 INTERNAL，
 *      模型就失去「先重新观察」与「绝不重试」的区别。
 *   ③ 资源释放。dispose 必须真的 shutdown + uniffiDestroy，否则原生句柄泄漏。
 * 假驱动把每次调用记下来，于是这三条都能在无图形会话下断言。
 *
 * 运行：cd packages/services && node --import tsx --test test/computerUseCuaDriver.test.ts
 */

const SESSION = { sessionId: "sess-1", runtimeScope: "main", workspaceKey: "ws-1" };

/** 记录调用的假驱动。`script` 按工具名给出要返回的信封。 */
function createFakeDriver(script = {}) {
  const calls = [];
  return {
    calls,
    shutdownCalls: 0,
    destroyCalls: 0,
    async callTool(name, argumentsJson, options) {
      assert.ok(options?.signal, "适配层必须传 signal：@ubjs/core 直接读 options.signal.aborted");
      calls.push({ name, args: JSON.parse(argumentsJson) });
      const entry = script[name];
      const value = typeof entry === "function" ? entry(JSON.parse(argumentsJson)) : entry;
      return { rawJson: JSON.stringify(value ?? { content: [] }) };
    },
    async shutdown() {
      this.shutdownCalls += 1;
    },
    uniffiDestroy() {
      this.destroyCalls += 1;
    },
  };
}

const envelope = (structured, texts = []) => ({
  content: texts.map((text) => ({ type: "text", text })),
  ...(structured ? { structuredContent: structured } : {}),
});

/** 一个能被 resolveAppWindow 解析的最小驱动：list_apps + list_windows 固定返回一行。 */
function baseScript(extra = {}) {
  return {
    list_apps: envelope({
      apps: [
        {
          name: "Dolphin",
          pid: 42,
          running: true,
          bundle_id: "org.kde.dolphin",
          kind: "desktop",
          launch_path: "dolphin",
        },
      ],
    }),
    list_windows: envelope({
      windows: [
        { pid: 42, window_id: 7, app_name: "dolphin", title: "t", width: 800, height: 600 },
        // 0x0 合成窗口必须被过滤，否则会被当成主窗口。
        { pid: 42, window_id: 8, app_name: "dolphin", title: "ghost", width: 0, height: 0 },
      ],
    }),
    get_window_state: envelope({
      snapshot_id: "s00000001",
      window_id: 7,
      pid: 42,
      app_name: "dolphin",
      window_title: "t",
      element_count: 2,
      tree_markdown: '- frame = "t"',
      elements: [
        {
          element_index: 0,
          role: "push button",
          label: "OK",
          actions: ["Press"],
          element_token: "s00000001:0",
        },
        {
          element_index: 1,
          role: "text",
          label: "field",
          actions: ["SetFocus"],
          element_token: "s00000001:1",
        },
      ],
    }),
    ...extra,
  };
}

async function withRuntime(script, run) {
  const driver = createFakeDriver(script);
  const runtime = createComputerUseRuntime({ loadDriver: async () => driver });
  try {
    await run({ runtime, driver });
  } finally {
    await runtime.dispose();
  }
}

const execute = (runtime, toolName, args, context = SESSION) =>
  runtime.execute({ toolName, arguments: args, context });
const bodyOf = (result) => JSON.parse(result.content[0].text);
const APP = { app_ref: { bundle_id: "org.kde.dolphin" } };

// ─────────────────────────────────────────── 工具路由

test("list_apps only surfaces user-addressable apps", async () => {
  await withRuntime(
    baseScript({
      list_apps: envelope({
        apps: [
          { name: "Dolphin", pid: 42, running: true, kind: "desktop" },
          // 内核线程：Linux 上驱动把 800+ 个进程全报成应用，必须被挡在模型上下文之外。
          { name: "kworker/R-rcu_gp", pid: 9, running: true, kind: null },
          { name: "Konsole", pid: 0, running: false, kind: "desktop", launch_path: "konsole" },
        ],
      }),
    }),
    async ({ runtime }) => {
      const result = await execute(runtime, "list_apps", {});
      assert.equal(result.isError, undefined);
      assert.deepEqual(
        bodyOf(result).apps.map((app) => app.name),
        ["Dolphin", "Konsole"],
      );
    },
  );
});

test("get_app_state resolves the app to a pid and returns a usable state_id", async () => {
  await withRuntime(baseScript(), async ({ runtime, driver }) => {
    const result = await execute(runtime, "get_app_state", APP);
    const state = result.structuredContent;
    assert.equal(state.state_id, "s00000001");
    assert.equal(state.app.pid, 42);
    assert.equal(state.elements.length, 2);
    // 元素表必须带上驱动索引与动作，模型据此选目标。
    assert.equal(state.elements[0].index, 0);
    assert.deepEqual(state.elements[0].actions, ["Press"]);
    // 观察必须走 get_window_state，且落在被选中的窗口（7）而不是 0x0 的幽灵窗口（8）。
    const observe = driver.calls.find((call) => call.name === "get_window_state");
    assert.equal(observe.args.pid, 42);
    assert.equal(observe.args.window_id, 7);
  });
});

test("left_click sends an element token, never a bare index", async () => {
  await withRuntime(
    baseScript({
      click: envelope({
        delivery: { mode: "background", delivered_count: 1 },
        effect: "unverifiable",
      }),
    }),
    async ({ runtime, driver }) => {
      await execute(runtime, "get_app_state", APP);
      const result = await execute(runtime, "left_click", {
        ...APP,
        target: { type: "element", index: 1 },
      });
      assert.equal(result.isError, undefined);
      const click = driver.calls.find((call) => call.name === "click");
      // 驱动拒绝裸 element_index（snapshot_id_required），token 才携带快照身份。
      assert.equal(click.args.element_token, "s00000001:1");
      assert.equal(click.args.element_index, undefined);
      // 后台投递是默认值；适配层永不主动升级到前台。
      assert.equal(click.args.delivery_mode, undefined);
      // 收据原样回传，让模型从新观察里确认结果。
      assert.equal(result.structuredContent.delivery.mode, "background");
    },
  );
});

test("an element index without a live observation is refused instead of guessed", async () => {
  await withRuntime(baseScript(), async ({ runtime, driver }) => {
    const result = await execute(runtime, "left_click", {
      ...APP,
      target: { type: "element", index: 0 },
    });
    assert.equal(result.isError, true);
    assert.equal(bodyOf(result).code, "element_unavailable");
    assert.equal(driver.calls.filter((call) => call.name === "click").length, 0);
  });
});

test("an element index stays valid across several actions in one cell", async () => {
  // 官方契约允许「click 一个索引，然后往它里面输入」而不重新观察。
  await withRuntime(
    baseScript({
      click: envelope({ delivery: { mode: "background", delivered_count: 1 } }),
      type_text: envelope({ delivery: { mode: "background", delivered_count: 1 } }),
    }),
    async ({ runtime }) => {
      await execute(runtime, "get_app_state", APP);
      const first = await execute(runtime, "left_click", {
        ...APP,
        target: { type: "element", index: 1 },
      });
      const second = await execute(runtime, "type", { ...APP, text: "hello" });
      assert.equal(first.isError, undefined);
      assert.equal(second.isError, undefined);
    },
  );
});

test("key splits a normalized chord into key plus modifiers", async () => {
  await withRuntime(
    baseScript({ press_key: envelope({ delivery: { mode: "background", delivered_count: 1 } }) }),
    async ({ runtime, driver }) => {
      await execute(runtime, "key", { ...APP, text: "ctrl+shift+a" });
      const press = driver.calls.find((call) => call.name === "press_key");
      assert.equal(press.args.key, "a");
      assert.deepEqual(press.args.modifiers, ["ctrl", "shift"]);
    },
  );
});

test("scroll maps pages onto the driver's page unit", async () => {
  await withRuntime(
    baseScript({ scroll: envelope({ delivery: { mode: "background", delivered_count: 1 } }) }),
    async ({ runtime, driver }) => {
      // scroll 的签名里 target 必填，先观察再滚动。
      await execute(runtime, "get_app_state", APP);
      await execute(runtime, "scroll", {
        ...APP,
        target: { type: "element", index: 0 },
        scroll_direction: "down",
        scroll_amount: 3,
      });
      const scroll = driver.calls.find((call) => call.name === "scroll");
      assert.equal(scroll.args.direction, "down");
      assert.equal(scroll.args.by, "page");
      assert.equal(scroll.args.amount, 3);
    },
  );
});

test("an unlaunched app is launched once through its desktop entry", async () => {
  let running = false;
  await withRuntime(
    baseScript({
      list_apps: () => {
        const apps = running
          ? [{ name: "Dolphin", pid: 42, running: true, bundle_id: "org.kde.dolphin" }]
          : [
              {
                name: "Dolphin",
                pid: 0,
                running: false,
                bundle_id: "org.kde.dolphin",
                launch_path: "dolphin",
              },
            ];
        return envelope({ apps });
      },
      launch_app: () => {
        running = true;
        return envelope({ launched: true });
      },
    }),
    async ({ runtime, driver }) => {
      const result = await execute(runtime, "list_windows", APP);
      assert.equal(result.isError, undefined);
      assert.equal(driver.calls.filter((call) => call.name === "launch_app").length, 1);
      assert.equal(
        driver.calls.find((call) => call.name === "launch_app").args.launch_path,
        "dolphin",
      );
    },
  );
});

test("an unknown app reports the retryable not-running message", async () => {
  await withRuntime(baseScript({ list_apps: envelope({ apps: [] }) }), async ({ runtime }) => {
    const result = await execute(runtime, "get_app_state", { app_ref: { name: "NoSuchApp" } });
    assert.equal(result.isError, true);
    const body = bodyOf(result);
    // 客户端按这个前缀决定「换字段再查一次」，改文案会静默废掉那条备用查询。
    assert.match(body.message, /target app is not running/u);
  });
});

// ─────────────────────────────────────────── 错误映射

test("driver refusal codes map onto the broker codes the client understands", async () => {
  const cases = [
    // 快照失效 → 客户端 ELEMENT_UNAVAILABLE（先重新观察）
    [
      {
        content: [{ type: "text", text: "stale" }],
        isError: true,
        structuredContent: { code: "stale_element_token" },
      },
      "element_unavailable",
    ],
    // 后台投递不可用 → 客户端 FOREGROUND_REQUIRED（永不重试，也绝不改前台重投）
    [
      {
        content: [{ type: "text", text: "no backend" }],
        isError: true,
        structuredContent: { code: "background_unavailable" },
      },
      "foreground_required",
    ],
    // 未知码不得静默成功
    [
      {
        content: [{ type: "text", text: "weird" }],
        isError: true,
        structuredContent: { code: "totally_new_code" },
      },
      "internal",
    ],
  ];
  for (const [raw, expected] of cases) {
    await withRuntime(baseScript({ click: raw }), async ({ runtime }) => {
      await execute(runtime, "get_app_state", APP);
      const result = await execute(runtime, "left_click", {
        ...APP,
        target: { type: "element", index: 0 },
      });
      assert.equal(result.isError, true, JSON.stringify(raw));
      assert.equal(bodyOf(result).code, expected);
    });
  }
});

test("a delivered action reports possibly-sent so a replay is never assumed safe", async () => {
  await withRuntime(
    baseScript({
      click: {
        content: [{ type: "text", text: "delivered but unconfirmed" }],
        isError: true,
        structuredContent: {
          code: "effect_unconfirmed",
          delivery: { mode: "background", delivered_count: 1 },
        },
      },
    }),
    async ({ runtime }) => {
      await execute(runtime, "get_app_state", APP);
      const result = await execute(runtime, "left_click", {
        ...APP,
        target: { type: "element", index: 0 },
      });
      assert.equal(result.isError, true);
      // 已下发的输入不会回滚：必须让模型先观察再决定重试。
      assert.equal(result.structuredContent.action_sent, true);
      assert.equal(result.structuredContent.dispatch_status, "possibly_sent");
    },
  );
});

test("methods without a driver equivalent fail as unimplemented rather than silently", async () => {
  await withRuntime(baseScript(), async ({ runtime, driver }) => {
    for (const method of ["select_text", "perform_action", "paste"]) {
      const result = await execute(runtime, method, {});
      assert.equal(result.isError, true, method);
      assert.equal(bodyOf(result).code, "unimplemented", method);
    }
    // 没有等价能力时不该白跑一次驱动。
    assert.equal(driver.calls.length, 0);
  });
});

test("invalid arguments are rejected before touching the desktop", async () => {
  await withRuntime(baseScript(), async ({ runtime, driver }) => {
    const scroll = await execute(runtime, "scroll", { ...APP, scroll_direction: "sideways" });
    assert.equal(bodyOf(scroll).code, "invalid_request");
    const type = await execute(runtime, "type", { ...APP, text: "" });
    assert.equal(bodyOf(type).code, "invalid_request");
    assert.equal(
      driver.calls.filter((call) => call.name === "scroll" || call.name === "type_text").length,
      0,
    );
  });
});

test("a driver that cannot load reports unavailability and rolls the attempt back", async () => {
  let attempts = 0;
  const runtime = createComputerUseRuntime({
    loadDriver: async () => {
      attempts += 1;
      throw new Error("no platform binary for this target");
    },
  });
  try {
    const first = await execute(runtime, "list_apps", {});
    assert.equal(first.isError, true);
    assert.equal(bodyOf(first).code, "broker_unavailable");
    assert.match(bodyOf(first).message, /no platform binary/u);
    // 启动失败必须回滚：否则会复用一个已死的 promise，永久卡在不可用上。
    const second = await execute(runtime, "list_apps", {});
    assert.equal(bodyOf(second).code, "broker_unavailable");
    assert.equal(attempts, 2);
  } finally {
    await runtime.dispose();
  }
});

// ─────────────────────────────────────────── 生命周期

test("a stopped session is refused while other sessions keep working", async () => {
  await withRuntime(baseScript(), async ({ runtime, driver }) => {
    const stopped = await execute(runtime, "stop_computer_control", { reason: "user asked" });
    assert.equal(stopped.structuredContent.stopped, true);
    const refused = await execute(runtime, "list_windows", APP);
    assert.equal(bodyOf(refused).code, "controller_busy");

    // 驱动只有一个隐式会话，被所有会话共用：stop 不能把它一起断电。
    const other = { sessionId: "sess-2", runtimeScope: "main", workspaceKey: "ws-1" };
    const stillWorks = await execute(runtime, "list_windows", APP, other);
    assert.equal(stillWorks.isError, undefined);
    assert.equal(
      driver.calls.some((call) => call.name === "end_session"),
      false,
    );
  });
});

test("closeSession clears the kill switch and the observations of that session", async () => {
  await withRuntime(baseScript(), async ({ runtime }) => {
    await execute(runtime, "get_app_state", APP);
    await execute(runtime, "stop_computer_control", {});
    await runtime.closeSession(SESSION);
    const after = await execute(runtime, "list_windows", APP);
    assert.equal(after.isError, undefined);
    // 观察记录随会话一起释放，避免跨会话读到别人的索引。
    const stale = await execute(runtime, "left_click", {
      ...APP,
      target: { type: "element", index: 0 },
    });
    assert.equal(bodyOf(stale).code, "element_unavailable");
  });
});

test("an expired driver session is re-armed without replaying a delivered action", async () => {
  let ended = false;
  await withRuntime(
    baseScript({
      get_window_state: () => {
        if (!ended) {
          ended = true;
          return {
            content: [{ type: "text", text: "this session has ended" }],
            isError: true,
            structuredContent: { code: "session_ended" },
          };
        }
        return baseScript().get_window_state;
      },
      start_session: envelope({ active: true, session: "implicit" }),
    }),
    async ({ runtime, driver }) => {
      const result = await execute(runtime, "get_app_state", APP);
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      assert.equal(driver.calls.filter((call) => call.name === "start_session").length, 1);
      // 自愈只允许在动作未下发时发生；这里第二次调用才是真正的重放。
      assert.equal(driver.calls.filter((call) => call.name === "get_window_state").length, 2);
    },
  );
});

test("dispose releases the native handle exactly once and refuses later calls", async () => {
  const driver = createFakeDriver(baseScript());
  const runtime = createComputerUseRuntime({ loadDriver: async () => driver });
  await execute(runtime, "list_apps", {});
  await runtime.dispose();
  assert.equal(driver.shutdownCalls, 1);
  assert.equal(driver.destroyCalls, 1);

  const after = await execute(runtime, "list_apps", {});
  assert.equal(after.isError, true);
  assert.equal(bodyOf(after).code, "broker_unavailable");

  // 重复 dispose 必须幂等：原生句柄二次销毁会抛。
  await runtime.dispose();
  assert.equal(driver.shutdownCalls, 1);
});

test("the disabled mode keeps the placeholder fail-closed contract", async () => {
  const runtime = createComputerUseRuntime({ driver: "disabled" });
  const result = await execute(runtime, "list_apps", {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not available/u);
  await runtime.dispose();
});
