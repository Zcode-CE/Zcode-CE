import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ZCODE_PRODUCT_FLAVOR } from "@zcode/shared";
import { resolveLinuxDesktopFileNameForFlavor } from "../../scripts/desktop-product-identity.mjs";
import { installLinuxAppImageDesktopIconBestEffort } from "./desktopLinuxAppImageIcon.js";
import {
  runXdgCommand,
  XDG_COMMAND_TIMEOUT_MS,
  type LinuxDesktopCommandRunner,
  type LinuxDeepLinkRegistrationLogger,
} from "./desktopLinuxXdg.js";

// 桌面条目文件名必须与安装包身份一致。electron-builder 按 linux.executableName 命名这个文件：
// app-builder-lib 的 fpm target 写 /usr/share/applications/<executableName>.desktop，AppImage target
// 写 <productFilename>.desktop，而 productFilename 就是 sanitize 过的 executableName。
// 这里曾经写死 "zcode.desktop"：fork 前产品身份就是 zcode，所以那时是对的；CE 改名成 zcode-ce 之后，
// 这段代码会去操作官方 ZCode 的桌面条目，在同时装了官方版的机器上把 zcode:// 的默认 handler 让给
// 官方版，用户点登录后由官方版接管回调。协议名仍是 zcode://（官网中转页回传的就是它），改的是文件名。
const LINUX_DEEP_LINK_DESKTOP_FILE = resolveLinuxDesktopFileNameForFlavor(ZCODE_PRODUCT_FLAVOR);
const LINUX_DEEP_LINK_MIME_TYPE = "x-scheme-handler/zcode";
const LINUX_DESKTOP_ENTRY_DEFAULT_PRODUCT_NAME = "ZCode";
// 归属标记：用于识别用户级桌面条目是否由本应用写入，只有带标记的条目才允许清理。
// 标记跟随产品身份，与 electron-builder 按 description 写进系统级条目的 Comment 同源，
// 这样运行时写的用户级条目与安装包写的系统级条目自我描述一致，也不会自称官方 ZCode。
// 只在本应用身份名的文件路径上比对标记，因此不会误判或清理官方 ZCode 的 zcode.desktop。
function resolveLinuxDesktopEntryOwnershipMarker(productName: string): string {
  return `Comment=${productName} Desktop App`;
}

type LinuxDesktopEnv = {
  APPIMAGE?: string;
  XDG_DATA_HOME?: string;
  XDG_DATA_DIRS?: string;
};

interface RegisterLinuxDeepLinkProtocolOptions {
  executablePath: string;
  homeDir: string;
  productName?: string;
  iconSourcePath?: string;
  env?: LinuxDesktopEnv;
  argv?: string[];
  logger: LinuxDeepLinkRegistrationLogger;
  runCommand?: LinuxDesktopCommandRunner;
  systemApplicationDirs?: string[];
  /** 桌面条目文件名（含 .desktop 后缀）。缺省按编译期产品身份取；显式传入只用于测试。 */
  desktopFileName?: string;
}

interface LinuxDeepLinkCommand {
  executablePath: string;
  args: string[];
}

const APPIMAGE_DEEP_LINK_ARG_NAMES = new Set([
  "--no-sandbox",
  "--disable-gpu",
  "--disable-software-rasterizer",
]);

const APPIMAGE_DEEP_LINK_ARG_PREFIXES = [
  "--use-gl=",
  "--use-angle=",
  "--disable-features=",
  "--enable-features=",
];

function resolveLinuxDeepLinkCommand(params: {
  env?: { APPIMAGE?: string };
  executablePath: string;
  argv?: string[];
}): LinuxDeepLinkCommand {
  const appImagePath = params.env?.APPIMAGE?.trim();
  if (!appImagePath) {
    return { executablePath: params.executablePath, args: [] };
  }

  return {
    executablePath: appImagePath,
    // AppImage 的 zcode:// 回调会由 xdg-open 按 .desktop Exec 二次启动。
    // 用户手动启动时附加的 sandbox/GPU 参数不会自动继承，二次启动可能在 Electron 初始化前崩溃。
    // 这里只持久化影响启动成败的 allowlist 参数，避免把 deep link URL、调试端口或工作区路径写死。
    args: resolveAppImageDeepLinkArgs(params.argv ?? []),
  };
}

function quoteDesktopExecPath(value: string): string {
  return `"${value.replace(/[\\"`$]/g, (match) => `\\${match}`)}"`;
}

function isAllowedAppImageDeepLinkArg(arg: string): boolean {
  return (
    APPIMAGE_DEEP_LINK_ARG_NAMES.has(arg) ||
    APPIMAGE_DEEP_LINK_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix))
  );
}

function resolveAppImageDeepLinkArgs(argv: string[]): string[] {
  const args: string[] = [];
  const seen = new Set<string>();
  for (const arg of argv) {
    if (!isAllowedAppImageDeepLinkArg(arg) || seen.has(arg)) {
      continue;
    }
    seen.add(arg);
    args.push(arg);
  }
  return args;
}

function quoteDesktopExecToken(value: string): string {
  return quoteDesktopExecPath(value);
}

function formatDesktopExec(command: LinuxDeepLinkCommand): string {
  return [command.executablePath, ...command.args]
    .map(quoteDesktopExecToken)
    .concat("%U")
    .join(" ");
}

function createLinuxDeepLinkDesktopEntry(params: {
  executablePath: string;
  args?: string[];
  productName?: string;
  iconName?: string;
  ownershipMarker: string;
}): string {
  const productName = params.productName ?? LINUX_DESKTOP_ENTRY_DEFAULT_PRODUCT_NAME;
  const iconName = params.iconName ?? "zcode";
  const command = {
    executablePath: params.executablePath,
    args: params.args ?? [],
  };
  return [
    "[Desktop Entry]",
    `Name=${productName}`,
    params.ownershipMarker,
    `Exec=${formatDesktopExec(command)}`,
    "Terminal=false",
    "Type=Application",
    `Icon=${iconName}`,
    "Categories=Development;",
    `MimeType=${LINUX_DEEP_LINK_MIME_TYPE};`,
    `StartupWMClass=${productName}`,
    "",
  ].join("\n");
}

function resolveLinuxUserDataDir(params: {
  env?: { XDG_DATA_HOME?: string };
  homeDir: string;
}): string {
  const xdgDataHome = params.env?.XDG_DATA_HOME?.trim();
  return xdgDataHome || join(params.homeDir, ".local", "share");
}

function resolveLinuxSystemApplicationDirs(env?: { XDG_DATA_DIRS?: string }): string[] {
  const raw = env?.XDG_DATA_DIRS?.trim();
  const entries = raw
    ? raw
        .split(":")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  // XDG 规范默认值为 /usr/local/share:/usr/share；全部为空的 XDG_DATA_DIRS 也回落默认值。
  const dataDirs = entries.length > 0 ? entries : ["/usr/local/share", "/usr/share"];
  return dataDirs.map((dir) => join(dir, "applications"));
}

function findSystemLevelDesktopEntryPath(
  systemApplicationDirs: string[],
  desktopFileName: string,
): string | undefined {
  for (const dir of systemApplicationDirs) {
    // 只找本应用身份名的系统级条目：官方 ZCode 的 zcode.desktop 属于另一个应用，
    // 既不构成遮蔽，也不会被下面的清理逻辑删除。
    const candidate = join(dir, desktopFileName);
    // 边界：目录或损坏的路径不应被当成有效系统级条目，否则纯 AppImage 用户
    // 的用户级注册会被病态路径误抑制。只有普通文件才参与遮蔽判断。
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // 路径不存在或不可 stat（权限），跳过该候选目录。
    }
  }
  return undefined;
}

function isOwnedDesktopEntry(path: string, ownershipMarker: string): boolean {
  try {
    const content = readFileSync(path, "utf8");
    // 去掉 \r 与行首尾空白，兼容 CRLF 行尾或手工编辑器引入的额外空白，
    // 避免可清理的遗留条目被误判为用户自定义条目而永久残留。
    return content.split("\n").some((line) => line.replaceAll("\r", "").trim() === ownershipMarker);
  } catch {
    return false;
  }
}

function removeOwnedUserDesktopEntry(
  desktopFilePath: string,
  ownershipMarker: string,
  logger: LinuxDeepLinkRegistrationLogger,
): void {
  if (!existsSync(desktopFilePath)) {
    return;
  }
  if (!isOwnedDesktopEntry(desktopFilePath, ownershipMarker)) {
    logger.warn("[deep-link] Linux 用户级桌面条目非本应用写入，保留不清理", {
      desktopFilePath,
    });
    return;
  }
  try {
    rmSync(desktopFilePath);
    logger.info("[deep-link] 已清理遗留的用户级桌面条目，恢复系统级条目", {
      desktopFilePath,
    });
  } catch (error) {
    logger.warn("[deep-link] 清理遗留用户级桌面条目失败", { desktopFilePath, error });
  }
}

function resolveLinuxDeepLinkDesktopFilePath(dataDir: string, desktopFileName: string): string {
  return join(dataDir, "applications", desktopFileName);
}

function writeFileIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) {
    return false;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return true;
}

export function registerLinuxDeepLinkProtocol(options: RegisterLinuxDeepLinkProtocolOptions): void {
  const command = resolveLinuxDeepLinkCommand({
    env: options.env,
    executablePath: options.executablePath,
    argv: options.argv,
  });
  const dataDir = resolveLinuxUserDataDir({ env: options.env, homeDir: options.homeDir });
  const desktopFileName = options.desktopFileName ?? LINUX_DEEP_LINK_DESKTOP_FILE;
  const desktopFilePath = resolveLinuxDeepLinkDesktopFilePath(dataDir, desktopFileName);
  const applicationsDir = dirname(desktopFilePath);
  const ownershipMarker = resolveLinuxDesktopEntryOwnershipMarker(
    options.productName ?? LINUX_DESKTOP_ENTRY_DEFAULT_PRODUCT_NAME,
  );
  const desktopEntry = createLinuxDeepLinkDesktopEntry({
    ...command,
    productName: options.productName,
    ownershipMarker,
  });
  let protocolRegistered = false;
  const runCommand = options.runCommand ?? runXdgCommand;

  // 用户级桌面条目在 XDG 解析中永远优先于系统级同名条目。rpm/deb 安装后，旧 AppImage 写入的
  // 用户级条目会把 /usr/share/applications/<身份名>.desktop 持续遮蔽，快捷方式和 zcode:// deep link
  // 一直指向旧 AppImage（文件还在时）或直接失效（文件被删后），只有手动跑一次新版才会被覆盖。
  // 现在只要检测到系统级同 ID 条目：
  // - 系统安装形态（rpm/deb）运行时：清掉本应用写入的遗留用户级条目，且不再写用户级；
  // - AppImage 运行时：不再写用户级条目和用户级图标，避免旧 AppImage 再度遮蔽系统安装。
  // 用户手写的自定义同名条目（无归属标记）不受影响，保留不清理。
  // 同 ID 只按本应用身份名（zcode-ce / zcode-ce-preview）比对：官方 ZCode 的 zcode.desktop 是
  // 另一个应用的文件，既不构成遮蔽也不会被清理，CE 也不再把自己的 handler 让给官方条目。
  const systemDesktopEntryPath = findSystemLevelDesktopEntryPath(
    options.systemApplicationDirs ?? resolveLinuxSystemApplicationDirs(options.env),
    desktopFileName,
  );

  try {
    let changed = false;
    if (systemDesktopEntryPath) {
      options.logger.info("[deep-link] Linux 系统级 desktop entry 已存在", {
        systemDesktopEntryPath,
        desktopFilePath,
      });
      removeOwnedUserDesktopEntry(desktopFilePath, ownershipMarker, options.logger);
    } else {
      changed = writeFileIfChanged(desktopFilePath, desktopEntry);
    }
    // AppImage 直跑不会像 deb 安装包一样稳定写入系统 desktop entry。
    // deep link 是 OAuth/支付/工作区打开的核心链路，必须先完成用户级协议处理器刷新；
    // 图标安装是可选增强，放到核心注册成功后独立降级，避免扩大登录回调失败域。
    const updateResult = runCommand("update-desktop-database", [applicationsDir]);
    const defaultResult = runCommand("xdg-mime", [
      "default",
      desktopFileName,
      LINUX_DEEP_LINK_MIME_TYPE,
    ]);

    if (defaultResult.status === 0) {
      protocolRegistered = true;
      const registeredFields = {
        desktopFileName,
        desktopFilePath,
        executablePath: command.executablePath,
        args: command.args,
        changed,
        systemDesktopEntryPath,
      };
      // 日志要如实说明 handler 由哪个条目提供：命中系统级条目时我们根本没写用户级文件，
      // 此时报"用户级协议注册成功"会让排障者去找一个不存在的文件 —— 本缺陷正是这样被掩盖的。
      if (systemDesktopEntryPath) {
        options.logger.info(
          "[deep-link] Linux 协议 handler 已指向系统级 desktop entry",
          registeredFields,
        );
      } else {
        options.logger.info("[deep-link] Linux 用户级协议注册成功", registeredFields);
      }
    } else {
      options.logger.warn("[deep-link] Linux 用户级协议注册失败", {
        desktopFileName,
        desktopFilePath,
        executablePath: command.executablePath,
        args: command.args,
        status: defaultResult.status,
        signal: defaultResult.signal,
        timeoutMs: defaultResult.signal === "SIGTERM" ? XDG_COMMAND_TIMEOUT_MS : undefined,
        error: defaultResult.error?.message,
        stderr: defaultResult.stderr?.trim(),
      });
    }

    if (updateResult.error) {
      options.logger.warn("[deep-link] update-desktop-database 不可用，已跳过", {
        desktopFilePath,
        message: updateResult.error.message,
      });
    } else if (updateResult.signal === "SIGTERM") {
      options.logger.warn("[deep-link] update-desktop-database 超时，已跳过", {
        desktopFilePath,
        timeoutMs: XDG_COMMAND_TIMEOUT_MS,
      });
    } else if (updateResult.status !== 0) {
      options.logger.warn("[deep-link] update-desktop-database 失败，已跳过", {
        desktopFilePath,
        status: updateResult.status,
        signal: updateResult.signal,
        stderr: updateResult.stderr?.trim(),
      });
    }
  } catch (error) {
    options.logger.warn("[deep-link] Linux 用户级协议注册异常", {
      desktopFileName,
      desktopFilePath,
      executablePath: command.executablePath,
      args: command.args,
      error,
    });
  }

  const iconInstallResult = systemDesktopEntryPath
    ? null
    : installLinuxAppImageDesktopIconBestEffort({
        dataDir,
        env: options.env,
        iconSourcePath: options.iconSourcePath,
        logger: options.logger,
        runCommand,
      });
  if (iconInstallResult) {
    options.logger.info("[deep-link] Linux AppImage 用户级图标安装完成", {
      protocolRegistered,
      iconFilePath: iconInstallResult.iconFilePath,
      iconInstalled: iconInstallResult.installed,
      iconChanged: iconInstallResult.changed,
    });
  }
}
