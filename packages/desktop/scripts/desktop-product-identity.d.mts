export type DesktopProductFlavor = "production" | "preview";

/** runtime.isPackaged === false 时返回开发态历史身份 cn.aminer.zcode，否则返回对应 flavor 的 appId。 */
export function resolveWindowsAppUserModelIdForFlavor(
  flavor: DesktopProductFlavor,
  runtime?: { isPackaged?: boolean },
): string;

/** 对应 flavor 的 Linux 桌面条目文件名，必须与 electron-builder 按 linuxExecutableName 生成的一致。 */
export function resolveLinuxDesktopFileNameForFlavor(flavor: DesktopProductFlavor): string;
