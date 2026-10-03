import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

/**
 * 主题条目篡改守护（issue #2 回归）。
 *
 * issue #2 现象：注入页面向渲染层 localStorage 写入外来主题条目后，整个 UI 失去
 * 主题归属。实测：报告人写的 zcode-custom-themes / zcode-theme-palette 在本仓库
 * 与官方 3.14.3/3.14.4 发行包中都不存在，实际会被污染的是 zcode-theme。本仓库的
 * 失效形态是：非法值让 html 上 theme-zai-light / theme-zai-dark 两个类同时缺失，
 * 整个 UI 只剩 @theme 裸默认变量；修复后所有读取/采纳入口必须回退内置 palette
 * 并记录 warn。
 *
 * 注意：logger.ts 在模块加载时就把 console.warn 存进 consoleFns，所以必须
 * 先换装 console.warn、再动态导入被测模块，否则捕获不到告警。
 *
 * 运行：cd packages/ui && node --import tsx --test test/themeTamperingGuard.test.ts
 */

interface FakeClassList {
  state: Map<string, boolean>;
  toggle(name: string, force?: boolean): void;
}

interface FakeHtmlElement {
  classList: FakeClassList;
  hasAttribute(name: string): boolean;
}

interface FakeDocument {
  documentElement: FakeHtmlElement;
}

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalConsoleWarn = Object.getOwnPropertyDescriptor(console, "warn");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

let storage: Record<string, string>;
let storageGetItemThrows: boolean;
let warns: Array<{ prefix: unknown; payload: unknown[] }>;
let fakeHtml: FakeHtmlElement;
let themeModule: typeof import("../src/useTheme.js") | null = null;

function installFakeLocalStorage() {
  storage = {};
  storageGetItemThrows = false;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        if (storageGetItemThrows) {
          throw new Error("SecurityError: sandboxed context");
        }
        return key in storage ? storage[key] : null;
      },
      setItem(key: string, value: string) {
        storage[key] = value;
      },
    },
  });
}

function installFakeDocument() {
  fakeHtml = {
    classList: {
      state: new Map<string, boolean>(),
      toggle(name: string, force?: boolean) {
        this.state.set(name, force === undefined ? !this.state.get(name) : force);
      },
    },
    // 不带 data-zcode-browser-theme-surface 标记，syncBrowserThemeSurface 应直接返回，
    // 测试只断言 classList 这条采纳链路。
    hasAttribute: () => false,
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement: fakeHtml } as FakeDocument,
  });
}

beforeEach(async () => {
  installFakeLocalStorage();
  installFakeDocument();
  warns = [];
  Object.defineProperty(console, "warn", {
    configurable: true,
    value: (...args: unknown[]) => {
      warns.push({ prefix: args[0], payload: args.slice(1) });
    },
  });
  // console.warn 换装完成后才导入被测模块，让 logger 的 consoleFns 捕获到桩。
  themeModule = await import("../src/useTheme.js");
});

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  }
  if (originalConsoleWarn) {
    Object.defineProperty(console, "warn", originalConsoleWarn);
  }
  if (originalDocument) {
    Object.defineProperty(globalThis, "document", originalDocument);
  }
});

function mod() {
  return themeModule as typeof import("../src/useTheme.js");
}

test("readPersistedTheme: 未保存时静默回退默认主题，不告警", () => {
  assert.equal(mod().readPersistedTheme(), mod().DEFAULT_THEME);
  assert.equal(mod().readPersistedTheme(), "zai-dark");
  assert.equal(warns.length, 0);
});

test("readPersistedTheme: 合法条目被归一化且不告警", () => {
  storage[mod().THEME_STORAGE_KEY] = "dark";
  assert.equal(mod().readPersistedTheme(), "zai-dark");
  storage[mod().THEME_STORAGE_KEY] = "zai-light";
  assert.equal(mod().readPersistedTheme(), "zai-light");
  storage[mod().THEME_STORAGE_KEY] = "system";
  assert.equal(mod().readPersistedTheme(), "system");
  assert.equal(warns.length, 0);
});

test("readPersistedTheme: 外来/非法条目回退内置 palette 并告警一次", () => {
  storage[mod().THEME_STORAGE_KEY] = "custom:jarvis-vivid-quantum";
  assert.equal(mod().readPersistedTheme(), "zai-dark");
  // 相同的非法值重复读取只告警一次（进程内去重，避免刷屏）。
  assert.equal(mod().readPersistedTheme(), "zai-dark");
  assert.equal(warns.length, 1);
  const warn = warns[0];
  assert.match(String(warn.prefix), /ui/);
  // logger 输出形态：console.warn(prefix, 消息, 上下文对象)。
  assert.match(String(warn.payload[0]), /回退内置 palette/);
  const context = warn.payload[1] as Record<string, unknown>;
  assert.equal(context.key, mod().THEME_STORAGE_KEY);
  assert.equal(context.raw, "custom:jarvis-vivid-quantum");
});

test("readPersistedTheme: 不同的非法条目分别告警", () => {
  storage[mod().THEME_STORAGE_KEY] = "zcode-custom-themes";
  assert.equal(mod().readPersistedTheme(), "zai-dark");
  storage[mod().THEME_STORAGE_KEY] = "jarvis-vivid";
  assert.equal(mod().readPersistedTheme(), "zai-dark");
  assert.equal(warns.length, 2);
});

test("readPersistedTheme: localStorage 不可读时静默回退", () => {
  storageGetItemThrows = true;
  assert.equal(mod().readPersistedTheme(), "zai-dark");
  assert.equal(warns.length, 0);
});

test("sanitizeTheme: 运行时非法值回退默认主题并告警，合法值归一化", () => {
  assert.equal(mod().sanitizeTheme("light"), "zai-light");
  assert.equal(mod().sanitizeTheme("zai-dark"), "zai-dark");
  assert.equal(mod().sanitizeTheme(undefined), "zai-dark");
  assert.equal(mod().sanitizeTheme("custom:foreign"), "zai-dark");
  assert.equal(warns.length, 2);
});

test("applyTheme: 非法主题最终落到内置 palette 类上，不留裸样式", () => {
  mod().applyTheme("custom:jarvis-vivid-quantum" as never);
  // 修复前：两个 theme-zai-* 类都不设置，html 失去主题归属；
  // 修复后：回退 zai-dark，dark 与 theme-zai-dark 必然就位。
  assert.equal(fakeHtml.classList.state.get("dark"), true);
  assert.equal(fakeHtml.classList.state.get("theme-zai-dark"), true);
  assert.equal(fakeHtml.classList.state.get("theme-zai-light"), false);
  assert.ok(
    warns.some((w) => JSON.stringify(w.payload).includes("custom:jarvis-vivid-quantum")),
    "applyTheme 采纳入口应记录非法值告警",
  );
});

test("applyTheme: 合法主题不受影响", () => {
  mod().applyTheme("zai-light");
  assert.equal(fakeHtml.classList.state.get("dark"), false);
  assert.equal(fakeHtml.classList.state.get("theme-zai-light"), true);
  assert.equal(fakeHtml.classList.state.get("theme-zai-dark"), false);
  assert.equal(warns.length, 0);
});
