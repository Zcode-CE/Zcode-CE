export type DesktopProductFlavor = "production" | "preview";

/** runtime.isPackaged === false 时返回开发态历史身份 cn.aminer.zcode，否则返回对应 flavor 的 appId。 */
export function resolveWindowsAppUserModelIdForFlavor(
  flavor: DesktopProductFlavor,
  runtime?: { isPackaged?: boolean },
): string;
