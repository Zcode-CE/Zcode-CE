import type { IPlatformService } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { dismissToast, toast } from "@/components/ui/toast.js";

/** 导出成功时返回主进程给的产物信息（path 供调用方展示与「在文件管理器中显示」）。 */
export async function runExportLogsAction(
  platform: Pick<IPlatformService, "exportLogs">,
  intl: IntlInstance,
): Promise<{ success: boolean; path?: string; error?: string } | null> {
  const pendingToastId = toast(intl.formatMessage({ id: "sidebar.exportLogs.pending" }), {
    durationMs: Number.POSITIVE_INFINITY,
  });

  try {
    const result = await platform.exportLogs();
    if (!result.success) {
      toast(
        intl.formatMessage(
          { id: "sidebar.exportLogs.error" },
          { error: result.error ?? "unknown" },
        ),
      );
      return null;
    }
    return result;
  } catch (error) {
    toast(
      intl.formatMessage(
        { id: "sidebar.exportLogs.error" },
        { error: error instanceof Error ? error.message : String(error) },
      ),
    );
    return null;
  } finally {
    dismissToast(pendingToastId);
  }
}
