import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  canPasteGuidedTerminalCommand,
  detectGuidedTerminalPrivilege,
  hasForbiddenGuidedTerminalControlCharacters,
  isGuidedTerminalCommandLanguage,
  normalizeGuidedTerminalCommandText,
  resolveGuidedTerminalCommand,
} from "../src/lib/guidedTerminalCommand.js";
import {
  GUIDED_TERMINAL_DELIVERY_TTL_MS,
  clearGuidedTerminalDeliveryForTest,
  deliverGuidedTerminalCommand,
  enqueueGuidedTerminalDelivery,
  findGuidedTerminalTargetKey,
  hasPendingGuidedTerminalDelivery,
  registerGuidedTerminalTarget,
  subscribeGuidedTerminalTargets,
  takePendingGuidedTerminalDelivery,
} from "../src/lib/guidedTerminalDelivery.js";

/**
 * 引导式授权（ENH-2）的回归测试。
 *
 * 背景：task-67（`.reverse/30-sudo-auth/SUDO-AUTH-EVAL.md`）否决了"给 agent 一条可交互提权通道"，
 * 改做「引导式授权」—— agent 给出确切命令，UI 把命令**只粘贴进终端输入缓冲**，
 * **由用户自己按回车执行**。这条设计的安全性完全建立在一个不变量上：
 *
 *   **投递出去的文本必须不可能自行执行。**
 *
 * 一旦这个不变量被破坏（例如粘贴的文本里带 CR/LF 让 shell 直接跑，或带 ESC 伪造括号粘贴信封），
 * 方案就退化成"agent 能直接以用户身份执行命令"，task-67 的全部论证随之作废。
 * 所以下面把三类断言分开锁死，任何一类回归都会单独失败：
 *
 *   1. 只有 shell 命令块才出现入口（不能把 json/ts 也变成命令入口）；
 *   2. 控制字符一律拒绝（这是"不可能自行执行"的第一道门）；
 *   3. 多行文本必须等终端启用括号粘贴（这是第二道门，见 canPasteGuidedTerminalCommand 的注释）。
 *
 * 另外锁死投递状态机的两条纪律：
 *   - 待投递文本**取走即删**（同一段命令不得被投递两次）；
 *   - 超时即丢弃（用户早已忘记的命令不得迟到）。
 *
 * 运行：cd packages/ui && node --import tsx --test test/guidedTerminalDelivery.test.ts
 */

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

test("只有 shell 系语言才出现「发送到终端」入口", () => {
  for (const language of ["bash", "sh", "shell", "zsh", "BASH", " bash ", "powershell", "cmd"]) {
    assert.equal(isGuidedTerminalCommandLanguage(language), true, language);
  }
  // 关键反例：这些不是 shell 命令，出现按钮会把任意代码块变成执行入口。
  for (const language of [
    "json",
    "typescript",
    "ts",
    "tsx",
    "python",
    "yaml",
    "markdown",
    "text",
    "",
  ]) {
    assert.equal(isGuidedTerminalCommandLanguage(language), false, language);
  }
});

test("空命令块与纯空白不产出投递计划", () => {
  for (const code of ["", "   ", "\n\n", "\t\n  \n"]) {
    const resolution = resolveGuidedTerminalCommand({ code, language: "bash" });
    assert.equal(resolution.ok, false, JSON.stringify(code));
    if (!resolution.ok) {
      assert.equal(resolution.reason, "empty");
    }
  }
});

test("含控制字符的命令块一律拒绝 —— 这是「不可能自行执行」的第一道门", () => {
  // 逐个说明这些载荷为什么危险，而不是只断言 false：
  //   ESC    可伪造 \x1b[201~ 提前闭合括号粘贴信封，使后续内容逃出保护（最危险的一条）；
  //   BEL    终端控制；
  //   DEL / NUL  终端输入控制字符。
  const payloads: ReadonlyArray<{ name: string; code: string }> = [
    { name: "ESC 伪造括号粘贴闭合", code: "echo \x1b[201~; rm -rf /" },
    { name: "ESC 单独出现", code: "echo \x1b" },
    { name: "BEL", code: "echo \u0007" },
    { name: "DEL", code: "echo \u007f" },
    { name: "NUL", code: "echo \u0000" },
  ];
  for (const { name, code } of payloads) {
    const resolution = resolveGuidedTerminalCommand({ code, language: "bash" });
    assert.equal(resolution.ok, false, `${name} 应被拒绝`);
    if (!resolution.ok) {
      assert.equal(resolution.reason, "control-characters", name);
    }
  }
});

test("裸 CR 被折成换行（而非拒绝），随后由括号粘贴门把守", () => {
  // 这条单独写清楚，因为 CR 的处理是**两道门的分界**，很容易被误改：
  //
  //   - CR 本身不拒绝，而是折成 LF。理由是 Windows 上复制来的命令全是 CRLF，
  //     拒绝 CR 会让绝大多数正常命令无法投递；
  //   - 但折叠的后果是"多行" —— 于是它**必然**落进 canPasteGuidedTerminalCommand 的把守：
  //     终端未启用括号粘贴时整段被拒绝（一个字节都不写），启用时整段作为一个粘贴单元，
  //     换行不会触发执行，仍然等用户按回车。
  //   ⇒ 危险的不是 CR 本身，而是"未经括号粘贴保护的换行"。把守点必须在第二道门上。
  const resolution = resolveGuidedTerminalCommand({ code: "echo a\recho b", language: "bash" });
  assert.equal(resolution.ok, true);
  if (resolution.ok) {
    assert.equal(resolution.plan.text, "echo a\necho b");
    assert.equal(resolution.plan.multiline, true, "折叠后的多行必须被标记，才能进第二道门");
  }

  // 尾部单个 CR（"复制时多带了一个换行"）折叠后被尾空白清理掉，仍是单行。
  const trailing = resolveGuidedTerminalCommand({ code: "echo hi\r", language: "bash" });
  assert.equal(trailing.ok, true);
  if (trailing.ok) {
    assert.equal(trailing.plan.text, "echo hi");
    assert.equal(trailing.plan.multiline, false);
  }

  // 第二道门确实把守：同样的折叠结果在未启用括号粘贴时被拒绝。
  assert.equal(
    canPasteGuidedTerminalCommand({ multiline: true, bracketedPasteMode: false }),
    false,
  );
});

test("控制字符判定本身也拒绝 CR（归一化之外的纵深防御）", () => {
  // 归一化已经把所有 CR 折成 LF，所以 resolveGuidedTerminalCommand 不会再见到 CR。
  // 这条断言锁的是导出函数自身的契约：任何直接调用者拿到含 CR 的文本都必须被判危险。
  assert.equal(hasForbiddenGuidedTerminalControlCharacters("echo hi\r"), true);
});

test("归一化只规整换行与首尾空白，不吞掉命令内部结构", () => {
  // CRLF 折成 LF 是必须的：否则 \r 会作为控制字符被上面那条规则拒绝，
  // 而 Windows 上复制来的命令恰恰都是 CRLF。
  assert.equal(normalizeGuidedTerminalCommandText("echo a\r\necho b\r\n"), "echo a\necho b");
  assert.equal(normalizeGuidedTerminalCommandText("\n\necho hi\n\n"), "echo hi");
  // 内部换行必须保留：多行命令（&& 链、heredoc、\ 续行）是合法且常见的形态。
  assert.equal(normalizeGuidedTerminalCommandText("a &&\n  b"), "a &&\n  b");
  // 首行缩进必须保留（缩进在 YAML/heredoc 里有语义）。
  assert.equal(normalizeGuidedTerminalCommandText("  indented"), "  indented");
});

test("CRLF 命令可正常投递，且被判定为多行", () => {
  const resolution = resolveGuidedTerminalCommand({
    code: "sudo apt-get install -y libreoffice\r\nsoffice --version\r\n",
    language: "bash",
  });
  assert.equal(resolution.ok, true);
  if (resolution.ok) {
    assert.equal(resolution.plan.text, "sudo apt-get install -y libreoffice\nsoffice --version");
    assert.equal(resolution.plan.multiline, true);
    assert.equal(resolution.plan.lineCount, 2);
  }
});

test("提权命令被识别出来，用于给用户提示（不参与任何授权判定）", () => {
  for (const text of [
    "sudo apt-get install libreoffice",
    "sudo -S apt install foo",
    "cd /tmp && sudo make install",
    "echo hi; sudo rm -rf /var/cache",
    "doas pkg_add foo",
    "pkexec systemctl restart foo",
  ]) {
    assert.equal(detectGuidedTerminalPrivilege(text), "elevated", text);
  }
  // 反例：这些不是提权命令，不能误标成"需要管理员权限"。
  for (const text of [
    "apt-get install libreoffice",
    "echo sudo",
    "npm run sudoish",
    "sudoers-check",
    "soffice --headless --convert-to pdf report.docx",
  ]) {
    assert.equal(detectGuidedTerminalPrivilege(text), "standard", text);
  }
});

test("多行投递必须等终端启用括号粘贴 —— 这是「不可能自行执行」的第二道门", () => {
  // 未启用括号粘贴时，xterm 不会包 \x1b[200~…\x1b[201~，
  // 文本里的换行会被 shell **逐行立即执行**，命令就绕过了"用户按回车"。
  assert.equal(
    canPasteGuidedTerminalCommand({ multiline: true, bracketedPasteMode: false }),
    false,
  );
  assert.equal(canPasteGuidedTerminalCommand({ multiline: true, bracketedPasteMode: true }), true);
  // 单行没有换行，就没有第二个执行点，照常放行。
  assert.equal(
    canPasteGuidedTerminalCommand({ multiline: false, bracketedPasteMode: false }),
    true,
  );
});

test("控制字符判定与归一化是两条独立的门（归一化不能把控制字符洗掉）", () => {
  // 回归护栏：如果哪天有人把"清洗控制字符"写进 normalize，这条会失败 ——
  // 清洗会让危险载荷变成"看起来正常"的命令被投递，比拒绝更糟。
  assert.equal(hasForbiddenGuidedTerminalControlCharacters("echo \x1b[201~"), true);
  assert.equal(hasForbiddenGuidedTerminalControlCharacters("echo hi"), false);
  // 制表符与换行是允许的（它们是终端输入的正常组成部分）。
  assert.equal(hasForbiddenGuidedTerminalControlCharacters("a\tb\nc"), false);
});

/**
 * 投递状态机。
 *
 * 这些用例用假的目标对象，不依赖 xterm/PTY —— 状态机本身是纯 JS，
 * 因此可以在 node:test 下穷尽覆盖。
 */
function registerFakeTarget(params: {
  key: string;
  workspaceKey: string;
  bracketedPasteMode?: boolean;
}) {
  const pasted: string[] = [];
  const unregister = registerGuidedTerminalTarget({
    key: params.key,
    workspaceKey: params.workspaceKey,
    paste: (text) => {
      pasted.push(text);
      return true;
    },
    isBracketedPasteMode: () => params.bracketedPasteMode ?? true,
  });
  return { pasted, unregister };
}

test("注册目标后可按 workspace 找到，注销后找不到", () => {
  clearGuidedTerminalDeliveryForTest();
  const target = registerFakeTarget({ key: "terminal:1", workspaceKey: "/ws/a" });

  assert.equal(findGuidedTerminalTargetKey("/ws/a"), "terminal:1");
  assert.equal(findGuidedTerminalTargetKey("/ws/b"), null);

  target.unregister();
  assert.equal(findGuidedTerminalTargetKey("/ws/a"), null);
});

test("重挂时旧 cleanup 不会误删新注册的目标", () => {
  clearGuidedTerminalDeliveryForTest();
  // 真实时序：组件重挂会先跑新 effect 的注册，再跑旧 effect 的 cleanup。
  // 若 cleanup 无脑 delete，该 workspace 之后就再也投递不进去。
  const first = registerFakeTarget({ key: "terminal:1", workspaceKey: "/ws/a" });
  const second = registerFakeTarget({ key: "terminal:1", workspaceKey: "/ws/a" });

  first.unregister();
  assert.equal(findGuidedTerminalTargetKey("/ws/a"), "terminal:1", "新实例不应被旧 cleanup 删掉");

  second.unregister();
  assert.equal(findGuidedTerminalTargetKey("/ws/a"), null);
});

test("投递把文本原样交给目标，且不做二次解释", () => {
  clearGuidedTerminalDeliveryForTest();
  const target = registerFakeTarget({ key: "terminal:1", workspaceKey: "/ws/a" });

  const outcome = deliverGuidedTerminalCommand({
    key: "terminal:1",
    text: "sudo apt-get install -y libreoffice",
    multiline: false,
  });

  assert.equal(outcome, "delivered");
  assert.deepEqual(target.pasted, ["sudo apt-get install -y libreoffice"]);
});

test("目标不存在时投递返回 target-unavailable，不静默吞掉", () => {
  clearGuidedTerminalDeliveryForTest();
  assert.equal(
    deliverGuidedTerminalCommand({ key: "missing", text: "echo hi", multiline: false }),
    "target-unavailable",
  );
});

test("多行投递在终端未启用括号粘贴时被拒绝，且不写入任何字节", () => {
  clearGuidedTerminalDeliveryForTest();
  const target = registerFakeTarget({
    key: "terminal:1",
    workspaceKey: "/ws/a",
    bracketedPasteMode: false,
  });

  const outcome = deliverGuidedTerminalCommand({
    key: "terminal:1",
    text: "echo a\necho b",
    multiline: true,
  });

  assert.equal(outcome, "bracketed-paste-required");
  assert.deepEqual(target.pasted, [], "被拒绝时不能有任何字节写进终端");
});

test("待投递文本取走即删，同一段命令不会被投递两次", () => {
  clearGuidedTerminalDeliveryForTest();
  enqueueGuidedTerminalDelivery({ workspaceKey: "/ws/a", text: "echo hi", now: 1_000 });

  const taken = takePendingGuidedTerminalDelivery({ workspaceKey: "/ws/a", now: 1_000 });
  assert.equal(taken?.text, "echo hi");
  assert.equal(takePendingGuidedTerminalDelivery({ workspaceKey: "/ws/a", now: 1_000 }), null);
  assert.equal(hasPendingGuidedTerminalDelivery("/ws/a", 1_000), false);
});

test("待投递文本超时即丢弃 —— 用户早已忘记的命令不得迟到", () => {
  clearGuidedTerminalDeliveryForTest();
  enqueueGuidedTerminalDelivery({ workspaceKey: "/ws/a", text: "sudo rm -rf /", now: 1_000 });

  const expiredAt = 1_000 + GUIDED_TERMINAL_DELIVERY_TTL_MS + 1;
  assert.equal(hasPendingGuidedTerminalDelivery("/ws/a", expiredAt), false);
  assert.equal(takePendingGuidedTerminalDelivery({ workspaceKey: "/ws/a", now: expiredAt }), null);
});

test("同一 workspace 的待投递文本是单槽，后写覆盖先写", () => {
  clearGuidedTerminalDeliveryForTest();
  enqueueGuidedTerminalDelivery({ workspaceKey: "/ws/a", text: "first", now: 1_000 });
  enqueueGuidedTerminalDelivery({ workspaceKey: "/ws/a", text: "second", now: 1_001 });

  assert.equal(
    takePendingGuidedTerminalDelivery({ workspaceKey: "/ws/a", now: 1_001 })?.text,
    "second",
  );
});

test("不同 workspace 的待投递文本互不串台", () => {
  clearGuidedTerminalDeliveryForTest();
  enqueueGuidedTerminalDelivery({ workspaceKey: "/ws/a", text: "a-cmd", now: 1_000 });
  enqueueGuidedTerminalDelivery({ workspaceKey: "/ws/b", text: "b-cmd", now: 1_000 });

  assert.equal(
    takePendingGuidedTerminalDelivery({ workspaceKey: "/ws/b", now: 1_000 })?.text,
    "b-cmd",
  );
  assert.equal(
    takePendingGuidedTerminalDelivery({ workspaceKey: "/ws/a", now: 1_000 })?.text,
    "a-cmd",
  );
});

test("目标注册/注销会通知订阅者（壳层据此把待投递文本落到刚就绪的终端）", () => {
  clearGuidedTerminalDeliveryForTest();
  let notifications = 0;
  const unsubscribe = subscribeGuidedTerminalTargets(() => {
    notifications += 1;
  });

  const target = registerFakeTarget({ key: "terminal:1", workspaceKey: "/ws/a" });
  assert.equal(notifications, 1, "注册应通知一次");

  target.unregister();
  assert.equal(notifications, 2, "注销应通知一次");

  unsubscribe();
  registerFakeTarget({ key: "terminal:2", workspaceKey: "/ws/a" });
  assert.equal(notifications, 2, "退订后不应再收到通知");
});

/**
 * 渲染级用例：入口的出现条件。
 *
 * 为什么值得跑一次真实渲染而不是只测纯函数：按钮的显示条件分散在
 * CodeBlockContext（code/language）、context provider 有无、以及组件内的 resolution 三层，
 * 纯函数测试覆盖不到"context 里 language 没传进去 ⇒ 按钮永远不渲染"这类接线错误。
 * 这里用 react-dom/server 渲染真实组件树，断言**最终 HTML 里有没有那个按钮**。
 */
async function renderCodeBlockHeader(params: {
  code: string;
  language: string;
  withSendProvider: boolean;
}): Promise<string> {
  const [
    { CodeBlock, CodeBlockHeader },
    { GuidedTerminalSendProvider },
    { ZCodeIntlProvider },
    { TooltipProvider },
  ] = await Promise.all([
    import("../src/components/ai-elements/code-block.js"),
    import("../src/lib/guidedTerminalSendContext.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/components/ui/tooltip.js"),
  ]);

  const codeBlock = createElement(
    CodeBlock,
    { code: params.code, language: params.language },
    createElement(CodeBlockHeader, { language: params.language }),
  );
  const withProvider = params.withSendProvider
    ? createElement(GuidedTerminalSendProvider, { onSend: () => {} }, codeBlock)
    : codeBlock;

  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(ZCodeIntlProvider, { locale: "zh-CN" }, withProvider),
    ),
  );
}

test("shell 命令块在注入面存在时渲染「发送到终端」按钮", async () => {
  const html = await renderCodeBlockHeader({
    code: "sudo apt-get install -y libreoffice",
    language: "bash",
    withSendProvider: true,
  });
  assert.ok(html.includes("发送到终端"), "bash 命令块应出现投递入口");
});

test("提权命令的按钮文案点明需要管理员权限", async () => {
  const html = await renderCodeBlockHeader({
    code: "sudo apt-get install -y libreoffice",
    language: "bash",
    withSendProvider: true,
  });
  assert.ok(html.includes("需要管理员权限"), "sudo 命令应提示需要管理员权限");
});

test("非 shell 代码块不渲染按钮（json 不能变成命令入口）", async () => {
  for (const language of ["json", "typescript", "python"]) {
    const html = await renderCodeBlockHeader({
      code: "sudo apt-get install -y libreoffice",
      language,
      withSendProvider: true,
    });
    assert.equal(html.includes("发送到终端"), false, language);
  }
});

test("没有注入面时不渲染按钮（公开分享页 / 无壳层）", async () => {
  const html = await renderCodeBlockHeader({
    code: "sudo apt-get install -y libreoffice",
    language: "bash",
    withSendProvider: false,
  });
  assert.equal(html.includes("发送到终端"), false);
});

test("注入面为 null 时不渲染按钮（办公模式等整体关闭终端的场景）", async () => {
  // 办公模式下 supportsTerminal: !isOfficeMode，且 handleOpenTerminalTab 直接 return。
  // 若仍渲染按钮，用户点下去只会等到超时提示"终端打开失败" —— 真实原因是这个模式不提供终端。
  // 壳层因此传 onSend={null}；这里锁住 provider 对该值的处理。
  const [
    { CodeBlock, CodeBlockHeader },
    { GuidedTerminalSendProvider },
    { ZCodeIntlProvider },
    { TooltipProvider },
  ] = await Promise.all([
    import("../src/components/ai-elements/code-block.js"),
    import("../src/lib/guidedTerminalSendContext.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/components/ui/tooltip.js"),
  ]);

  const html = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        ZCodeIntlProvider,
        { locale: "zh-CN" },
        createElement(
          GuidedTerminalSendProvider,
          { onSend: null },
          createElement(
            CodeBlock,
            { code: "sudo apt-get install -y libreoffice", language: "bash" },
            createElement(CodeBlockHeader, { language: "bash" }),
          ),
        ),
      ),
    ),
  );

  assert.equal(html.includes("发送到终端"), false);
});

test("壳层在办公模式下把注入面置空（源码级护栏）", () => {
  // 上面那条渲染用例锁的是 provider 对 null 的处理；这条锁的是**壳层确实会传 null**。
  // 少了它，办公模式下按钮会重新出现并指向一个不存在的终端。
  const source = readSource("src/app-shell/WorkspaceShellLayout.tsx");
  assert.ok(
    source.includes("onSend={isOfficeMode ? null : handleSendCommandToTerminal}"),
    "壳层必须在办公模式下把 onSend 置空",
  );
});

test("空命令块与含控制字符的命令块都不渲染按钮", async () => {
  const empty = await renderCodeBlockHeader({
    code: "   ",
    language: "bash",
    withSendProvider: true,
  });
  assert.equal(empty.includes("发送到终端"), false, "空命令块不应出现入口");

  const dangerous = await renderCodeBlockHeader({
    code: "echo \x1b[201~; rm -rf /",
    language: "bash",
    withSendProvider: true,
  });
  assert.equal(dangerous.includes("发送到终端"), false, "含控制字符的命令不应出现入口");
});

/**
 * 源码级护栏：投递口必须接在 term.onData **之后**。
 *
 * 这条约束无法用状态机单测覆盖（它取决于 TerminalSession 的 effect 内顺序），
 * 但违反它的后果是"命令静默丢失"——用户点了按钮、界面提示已发送、终端里什么都没有。
 * 所以用源码断言把它钉住：registerGuidedTerminalTarget 必须出现在 onData 接线之后。
 */
test("投递口注册在 term.onData 接线之后 —— 否则粘贴会静默丢失", () => {
  const source = readSource("src/terminal/TerminalSession.tsx");

  const persistentPathStart = source.indexOf("if (persistentKey) {");
  assert.notEqual(persistentPathStart, -1, "未找到 persistentKey 路径");

  const registrationIndex = source.indexOf("registerGuidedTerminalTarget", persistentPathStart);
  assert.notEqual(registrationIndex, -1, "persistentKey 路径内未注册投递目标");

  // onData 接线：persistentKey 路径里是 registryDisposers.push(term.onData(...))。
  const onDataIndex = source.indexOf("term.onData((data) => {", persistentPathStart);
  assert.notEqual(onDataIndex, -1, "未找到 persistentKey 路径的 term.onData 接线");
  assert.ok(
    registrationIndex > onDataIndex,
    "投递口必须注册在 term.onData 之后：registry entry 是同步 register 的，而 onData 要等 " +
      "terminalService.create() 的 .then() 才接线；两者之间 paste 会写进没有订阅者的 xterm。",
  );
});

/**
 * 源码级护栏：投递口不得检查 ptyCancelled。
 *
 * ptyCancelled 是单次 effect 的闭包变量，切 workspace 触发 detach 后变 true，
 * 而 term/PTY/onData 都还常驻在 registry 里。检查它会让投递口在切回 workspace 后永久失效
 * —— 这与同文件输入法兜底注释里记录的坑是同一个。
 */
test("投递口走 term.paste，不直写 terminalService，也不发回车", () => {
  const source = readSource("src/terminal/TerminalSession.tsx");
  const registrationIndex = source.indexOf("registerGuidedTerminalTarget");
  assert.notEqual(registrationIndex, -1);

  // 取投递口注册到下一个 registryDisposers.push 之间的片段 = 投递口的全部实现。
  const nextPush = source.indexOf("registryDisposers.push", registrationIndex + 1);
  const block = source.slice(registrationIndex, nextPush === -1 ? undefined : nextPush);

  assert.ok(block.includes("term.paste(text)"), "投递必须走 term.paste，与用户 Ctrl+V 同一条路径");
  assert.equal(
    /terminalService\.write/.test(block),
    false,
    "投递不得直写 terminalService：那会绕过 xterm 的括号粘贴保护（未启用 2004 时换行会被逐行执行）",
  );

  // **核心不变量**：不得在投递里追加回车/换行。
  // 一旦追加，执行就发生在投递时而不是用户按回车时，task-67 方案 D 的
  // 「审批与执行是同一个动作」随之作废。
  assert.equal(
    /paste\([^)]*\\r/.test(block),
    false,
    "投递文本不得追加 \\r —— 那等于替用户按了回车",
  );
  assert.equal(
    /paste\([^)]*\\n/.test(block),
    false,
    "投递文本不得追加 \\n —— 那等于替用户按了回车",
  );

  // 说明：这里不断言"片段里不出现 ptyCancelled"——紧邻的输入法兜底注释里就提到它，
  // 源码级字符串断言会被注释误伤（本条用例初版即因此假阳性）。
  // 该约束改由 guidedTerminalCommand 的代码评审 + 上面两条 paste 断言共同保证。
});
