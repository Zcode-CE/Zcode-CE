import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { writeTextToClipboard } from "../src/lib/clipboardText.js";

/**
 * writeTextToClipboard 的回退路径回归。
 *
 * 背景：手机经 http://<局域网 / tailnet IP> 打开 Web 远控时 `isSecureContext === false`，
 * `navigator.clipboard` 是 undefined。此时唯一可用的写剪贴板手段是已废弃的
 * `document.execCommand("copy")`。它看起来像可以"清理"的遗留代码 —— 这组用例锁死：
 *
 * 1. 没有 Clipboard API 时确实走 execCommand("copy")，且选中的正是要复制的文本；
 * 2. 临时节点一定被移除、用户原有选区一定被恢复（成功 / 返回 false / 抛异常三条路径）；
 * 3. 失败时 Promise 被拒绝（调用方负责处理，不能伪装成功）；
 * 4. 有 Clipboard API 时优先用它，只在它拒绝时才回退。
 *
 * 测试不引入 DOM 库（仓库测试零新依赖约束），只桩出 helper 实际用到的最小 DOM 面。
 *
 * 运行：cd packages/ui && node --import tsx --test test/clipboardText.test.ts
 */

interface FakeNode {
  textContent: string;
  attributes: Record<string, string>;
  style: Record<string, string>;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

interface FakeRange {
  selectedNode: FakeNode | null;
  selectNodeContents(node: FakeNode): void;
}

interface FakeDom {
  bodyChildren: FakeNode[];
  selectionRanges: FakeRange[];
  execCommandCalls: Array<{ command: string; selectedText: string | null }>;
  execCommandImpl: () => boolean;
}

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

let dom: FakeDom;

function installFakeDocument(): FakeDom {
  const state: FakeDom = {
    bodyChildren: [],
    selectionRanges: [],
    execCommandCalls: [],
    execCommandImpl: () => true,
  };
  const selection = {
    get rangeCount() {
      return state.selectionRanges.length;
    },
    getRangeAt(index: number) {
      return state.selectionRanges[index];
    },
    removeAllRanges() {
      state.selectionRanges = [];
    },
    addRange(range: FakeRange) {
      state.selectionRanges.push(range);
    },
  };
  const fakeDocument = {
    body: {
      appendChild(node: FakeNode) {
        state.bodyChildren.push(node);
        return node;
      },
    },
    getSelection: () => selection,
    createElement(): FakeNode {
      const node: FakeNode = {
        textContent: "",
        attributes: {},
        style: {},
        setAttribute(name, value) {
          node.attributes[name] = value;
        },
        remove() {
          state.bodyChildren = state.bodyChildren.filter((child) => child !== node);
        },
      };
      return node;
    },
    createRange(): FakeRange {
      const range: FakeRange = {
        selectedNode: null,
        selectNodeContents(node) {
          range.selectedNode = node;
        },
      };
      return range;
    },
    execCommand(command: string) {
      const selected = state.selectionRanges[0]?.selectedNode ?? null;
      state.execCommandCalls.push({ command, selectedText: selected?.textContent ?? null });
      return state.execCommandImpl();
    },
  };
  Object.defineProperty(globalThis, "document", {
    value: fakeDocument,
    configurable: true,
    writable: true,
  });
  return state;
}

function setNavigatorClipboard(clipboard: { writeText(text: string): Promise<void> } | undefined) {
  // 模拟非安全上下文：navigator 存在，但 clipboard 属性是 undefined。
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard },
    configurable: true,
    writable: true,
  });
}

function restoreGlobal(name: "document" | "navigator", descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    delete (globalThis as Record<string, unknown>)[name];
  }
}

beforeEach(() => {
  dom = installFakeDocument();
});

afterEach(() => {
  restoreGlobal("document", originalDocument);
  restoreGlobal("navigator", originalNavigator);
});

test("无 Clipboard API（非安全上下文）时回退到 execCommand('copy')，并清理临时节点、恢复原选区", async () => {
  setNavigatorClipboard(undefined);
  const userRange: FakeRange = { selectedNode: null, selectNodeContents() {} };
  dom.selectionRanges = [userRange];

  await writeTextToClipboard("full assistant turn");

  assert.deepEqual(dom.execCommandCalls, [
    { command: "copy", selectedText: "full assistant turn" },
  ]);
  assert.equal(dom.bodyChildren.length, 0, "临时节点必须被移除");
  assert.deepEqual(dom.selectionRanges, [userRange], "用户原有选区必须被恢复");
});

test("execCommand 返回 false 时拒绝 Promise，且依然清理临时节点", async () => {
  setNavigatorClipboard(undefined);
  dom.execCommandImpl = () => false;

  await assert.rejects(writeTextToClipboard("x"), /clipboard_unavailable/);
  assert.equal(dom.execCommandCalls.length, 1);
  assert.equal(dom.bodyChildren.length, 0);
});

test("execCommand 抛异常时拒绝 Promise，且依然清理临时节点", async () => {
  setNavigatorClipboard(undefined);
  dom.execCommandImpl = () => {
    throw new Error("boom");
  };

  await assert.rejects(writeTextToClipboard("x"), /clipboard_unavailable/);
  assert.equal(dom.bodyChildren.length, 0);
  assert.equal(dom.selectionRanges.length, 0);
});

test("有 Clipboard API 时优先使用它，不触发 execCommand", async () => {
  const written: string[] = [];
  setNavigatorClipboard({
    writeText: async (text) => {
      written.push(text);
    },
  });

  await writeTextToClipboard("hello");

  assert.deepEqual(written, ["hello"]);
  assert.equal(dom.execCommandCalls.length, 0);
});

test("Clipboard API 拒绝时回退到 execCommand('copy')", async () => {
  setNavigatorClipboard({
    writeText: () => Promise.reject(new Error("NotAllowedError")),
  });

  await writeTextToClipboard("fallback text");

  assert.deepEqual(dom.execCommandCalls, [{ command: "copy", selectedText: "fallback text" }]);
  assert.equal(dom.bodyChildren.length, 0);
});
