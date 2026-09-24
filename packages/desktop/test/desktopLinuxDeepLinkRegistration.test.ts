import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZCODE_PRODUCT_FLAVOR } from "@zcode/shared";
import { resolveLinuxDesktopFileNameForFlavor } from "../scripts/desktop-product-identity.mjs";
import { registerLinuxDeepLinkProtocol } from "../src/main/desktopLinuxDeepLinkRegistration.js";

/**
 * Linux zcode:// deep link 注册的身份对齐契约。
 *
 * 为什么必须钉住：fork 把产品身份从 zcode 改成 zcode-ce，但注册代码里写死了官方 ZCode 的桌面条目名
 * \`zcode.desktop\`。在同时装了官方版的机器上（官方包占用 /usr/share/applications/zcode.desktop），
 * 这段代码会命中"系统级条目已存在"分支：删掉自己的用户级条目、却仍把 xdg-mime default 指向
 * zcode.desktop —— 于是 zcode:// 的默认 handler 归官方版，用户点登录后回调被官方版接管。
 * 这条回归是用户可见且静默的（日志还报"注册成功"），只能靠测试钉住。
 *
 * 运行：cd packages/desktop && node --import tsx --test test/desktopLinuxDeepLinkRegistration.test.ts
 */

const OFFICIAL_DESKTOP_ENTRY = [
  "[Desktop Entry]",
  "Name=ZCode",
  "Exec=zcode %U",
  "Terminal=false",
  "Type=Application",
  "Icon=zcode",
  "StartupWMClass=ZCode",
  "Comment=ZCode Desktop App",
  "MimeType=x-scheme-handler/zcode;",
  "Categories=Development;",
  "",
].join("\n");

interface Harness {
  root: string;
  homeDir: string;
  dataHome: string;
  systemDir: string;
  commands: string[][];
  logs: string[];
  dispose: () => void;
}

function createHarness(prefix: string): Harness {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const homeDir = join(root, "home");
  const dataHome = join(root, "xdgdata");
  const systemDir = join(root, "sysapplications");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(systemDir, { recursive: true });
  return {
    root,
    homeDir,
    dataHome,
    systemDir,
    commands: [],
    logs: [],
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runRegistration(
  harness: Harness,
  options: { desktopFileName?: string; xdgStatus?: number } = {},
): void {
  registerLinuxDeepLinkProtocol({
    executablePath: "/opt/ZCode-CE/zcode-ce",
    homeDir: harness.homeDir,
    productName: "ZCode-CE",
    env: { XDG_DATA_HOME: harness.dataHome },
    argv: ["/opt/ZCode-CE/zcode-ce"],
    logger: {
      info: (...args: unknown[]) => harness.logs.push("INFO " + args.map(String).join(" ")),
      warn: (...args: unknown[]) => harness.logs.push("WARN " + args.map(String).join(" ")),
    },
    runCommand: (command, args) => {
      harness.commands.push([command, ...args]);
      return { status: command === "xdg-mime" ? (options.xdgStatus ?? 0) : 0, stderr: "" };
    },
    systemApplicationDirs: [harness.systemDir],
    ...(options.desktopFileName ? { desktopFileName: options.desktopFileName } : {}),
  });
}

function userDesktopPath(harness: Harness, fileName: string): string {
  return join(harness.dataHome, "applications", fileName);
}

function xdgMimeTarget(harness: Harness): string | undefined {
  const call = harness.commands.find((entry) => entry[0] === "xdg-mime");
  return call?.[2];
}

test("桌面条目名跟随产品身份，不写死官方 ZCode 的名字", () => {
  assert.equal(resolveLinuxDesktopFileNameForFlavor("production"), "zcode-ce.desktop");
  assert.equal(resolveLinuxDesktopFileNameForFlavor("preview"), "zcode-ce-preview.desktop");
  // 缺省值必须是身份名：写死 zcode.desktop 会让 CE 去抢/让官方版的 handler。
  assert.notEqual(
    resolveLinuxDesktopFileNameForFlavor(ZCODE_PRODUCT_FLAVOR),
    "zcode.desktop",
    "CE 的桌面条目名不得与官方 ZCode 相同",
  );
});

test("只有官方 zcode.desktop 时，CE 仍写出自己的用户级条目并指向自己", () => {
  const harness = createHarness("ce-deeplink-official-");
  try {
    writeFileSync(join(harness.systemDir, "zcode.desktop"), OFFICIAL_DESKTOP_ENTRY);
    runRegistration(harness, { desktopFileName: "zcode-ce.desktop" });

    const ownPath = userDesktopPath(harness, "zcode-ce.desktop");
    assert.equal(existsSync(ownPath), true, "官方条目不是同 ID 条目，不得抑制 CE 的用户级注册");
    assert.match(readFileSync(ownPath, "utf8"), /Exec="\/opt\/ZCode-CE\/zcode-ce" %U/);
    assert.equal(xdgMimeTarget(harness), "zcode-ce.desktop", "handler 必须指向 CE 自己");
  } finally {
    harness.dispose();
  }
});

test("官方 zcode.desktop 不被 CE 修改或删除", () => {
  const harness = createHarness("ce-deeplink-untouched-");
  try {
    const officialPath = join(harness.systemDir, "zcode.desktop");
    writeFileSync(officialPath, OFFICIAL_DESKTOP_ENTRY);
    runRegistration(harness, { desktopFileName: "zcode-ce.desktop" });

    assert.equal(existsSync(officialPath), true, "官方包的文件不属于 CE，不许删");
    assert.equal(readFileSync(officialPath, "utf8"), OFFICIAL_DESKTOP_ENTRY, "逐字节不得改动");
    assert.equal(
      harness.commands.some((entry) => entry.includes("zcode.desktop")),
      false,
      "CE 不得再把 handler 指向官方条目",
    );
  } finally {
    harness.dispose();
  }
});

test("存在自己的系统级条目时清理遗留用户级条目，但仍指向自己的条目", () => {
  const harness = createHarness("ce-deeplink-system-own-");
  try {
    writeFileSync(join(harness.systemDir, "zcode-ce.desktop"), OFFICIAL_DESKTOP_ENTRY);
    // 旧 AppImage 写下的遗留用户级条目（带归属标记）应被清理。
    const legacyPath = userDesktopPath(harness, "zcode-ce.desktop");
    mkdirSync(join(harness.dataHome, "applications"), { recursive: true });
    writeFileSync(
      legacyPath,
      [
        "[Desktop Entry]",
        "Name=ZCode-CE",
        "Comment=ZCode-CE Desktop App",
        'Exec="/opt/old/zcode-ce" %U',
        "Type=Application",
        "",
      ].join("\n"),
    );

    runRegistration(harness, { desktopFileName: "zcode-ce.desktop" });

    assert.equal(existsSync(legacyPath), false, "本应用写的遗留用户级条目应被清理");
    assert.equal(xdgMimeTarget(harness), "zcode-ce.desktop");
  } finally {
    harness.dispose();
  }
});

test("用户手写的同名条目（无归属标记）保留不清理", () => {
  const harness = createHarness("ce-deeplink-user-authored-");
  try {
    writeFileSync(join(harness.systemDir, "zcode-ce.desktop"), OFFICIAL_DESKTOP_ENTRY);
    const handWritten = userDesktopPath(harness, "zcode-ce.desktop");
    mkdirSync(join(harness.dataHome, "applications"), { recursive: true });
    writeFileSync(handWritten, "[Desktop Entry]\nName=My Custom\nExec=custom %U\n");

    runRegistration(harness, { desktopFileName: "zcode-ce.desktop" });

    assert.equal(existsSync(handWritten), true, "无归属标记的条目是用户自定义，不许删");
    assert.match(readFileSync(handWritten, "utf8"), /My Custom/);
  } finally {
    harness.dispose();
  }
});

test("日志如实说明 handler 由谁提供，不把没写文件说成注册成功", () => {
  const harness = createHarness("ce-deeplink-log-");
  try {
    writeFileSync(join(harness.systemDir, "zcode-ce.desktop"), OFFICIAL_DESKTOP_ENTRY);
    runRegistration(harness, { desktopFileName: "zcode-ce.desktop" });

    const successLog = harness.logs.find((line) => line.includes("注册成功"));
    assert.equal(successLog, undefined, "没写用户级文件时不得报用户级注册成功");
    assert.ok(
      harness.logs.some((line) => line.includes("系统级 desktop entry")),
      "应说明 handler 由系统级条目提供",
    );
  } finally {
    harness.dispose();
  }
});

test("桌面条目内容：scheme 保持 zcode，归属标记跟随产品名", () => {
  const harness = createHarness("ce-deeplink-content-");
  try {
    runRegistration(harness, { desktopFileName: "zcode-ce.desktop" });

    const content = readFileSync(userDesktopPath(harness, "zcode-ce.desktop"), "utf8");
    // 官网中转页回传的就是 zcode://，协议名绝不能跟着改名。
    assert.match(content, /MimeType=x-scheme-handler\/zcode;/);
    assert.match(content, /^Name=ZCode-CE$/m);
    assert.match(content, /^Comment=ZCode-CE Desktop App$/m);
    assert.match(content, /^StartupWMClass=ZCode-CE$/m);
  } finally {
    harness.dispose();
  }
});
