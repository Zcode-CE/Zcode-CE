import { memo, useCallback, useState } from "react";
import {
  TID_V4_WORKSPACE_HOOK_PENDING_BANNER,
  TID_V4_WORKSPACE_HOOK_PENDING_DISMISS,
  TID_V4_WORKSPACE_HOOK_PENDING_REVIEW,
  TID_V4_WORKSPACE_MCP_PENDING_BANNER,
  TID_V4_WORKSPACE_MCP_PENDING_DISMISS,
  TID_V4_WORKSPACE_MCP_PENDING_REVIEW,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  setPendingSettingsPluginIntent,
  setPendingSettingsSectionIntent,
} from "@/lib/settingsNavigation.js";
import { logger } from "@/logger.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import {
  findWorkspaceHookCommandBinding,
  useWorkspaceHookReviewStore,
  type WorkspaceHookCommandBinding,
} from "@/store/workspaceHookReviewStore.js";
import { sendWorkspaceHookCommand } from "@/settings/workspaceHookReviewCommands.js";

/**
 * 软门禁 dismiss store：轻量模块级 Map。
 * 幂等 key = sessionId + bundleDigest；bundle 变化后提示条重新出现。
 * 不落盘——刷新或重载后重新提示，符合「用户应该知道」的产品语义。
 */
class WorkspaceHookPendingDismissStore {
  private dismissed = new Set<string>();

  /** 标记某个 session+bundle 组合已 dismiss */
  dismiss(sessionId: string, bundleDigest: string): void {
    this.dismissed.add(this.key(sessionId, bundleDigest));
  }

  /** 查询是否已 dismiss */
  isDismissed(sessionId: string, bundleDigest: string): boolean {
    return this.dismissed.has(this.key(sessionId, bundleDigest));
  }

  /** 清空全部 dismiss 记录（测试用） */
  clear(): void {
    this.dismissed.clear();
  }

  private key(sessionId: string, bundleDigest: string): string {
    return `${sessionId}:${bundleDigest}`;
  }
}

const workspaceHookPendingDismissStore = new WorkspaceHookPendingDismissStore();

/**
 * MCP 待信任提示的 dismiss 记录：与 Hooks 同一套「不落盘、按 bundle 幂等」语义。
 * 拆成独立实例，避免两个门禁共用 key 空间互相压掉提示。
 */
const workspaceMcpPendingDismissStore = new WorkspaceHookPendingDismissStore();

interface WorkspaceHookAdmissionInfo {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

interface WorkspaceHookPendingBannerProps {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  admission: WorkspaceHookAdmissionInfo | null;
}

/**
 * 软门禁常驻提示条。
 *
 * 当 snapshot.workspaceHookAdmission.pendingCount > 0 时显示，提供 [去审核] 与 [忽略]。
 * - [去审核]：打开设置页 Hooks 分区 + 发送 requestWorkspaceHookReview 命令。
 *   命令发送失败不阻断导航（容错，logger 记 warn）。
 * - [忽略]：renderer 本地 dismiss，幂等 key = sessionId + bundleDigest。
 */
export const WorkspaceHookPendingBanner = memo(function WorkspaceHookPendingBanner({
  sessionId,
  workspacePath,
  workspaceIdentity,
  admission,
}: WorkspaceHookPendingBannerProps) {
  const { intl } = useZCodeIntl();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const commandBindings = useWorkspaceHookReviewStore((state) => state.commandBindings);
  const [, setDismissRevision] = useState(0);

  const handleReview = useCallback(() => {
    // 两行式打开设置页：设置 intent 再 open tab（仿 V4ComposerToolbar 的 handleOpenModelProviderSettings）
    setPendingSettingsSectionIntent("hooks");
    openSettingsTab?.();

    // 通过 command binding 发送 requestWorkspaceHookReview 命令。
    // 该通道正是为无 pending review interaction 时保留命令通道而设。
    const binding = findWorkspaceHookCommandBinding(
      commandBindings,
      workspacePath,
      workspaceIdentity,
    );
    if (binding && admission) {
      const payload = {
        sessionId,
        workspaceIdentity: admission.workspaceIdentity ?? workspaceIdentity ?? workspacePath,
        bundleDigest: admission.bundleDigest,
      };
      void sendWorkspaceHookCommand(
        binding as Pick<WorkspaceHookCommandBinding, "sendCommand" | "onCommandSettled">,
        sessionId,
        "requestWorkspaceHookReview",
        payload,
      ).catch((error) => {
        // 命令发送失败不阻断导航（容错）——用户已到达设置页，可手动操作。
        logger.warn("[workspace-hook-pending] requestWorkspaceHookReview 发送失败", {
          sessionId,
          bundleDigest: admission.bundleDigest,
          error,
        });
      });
    }
  }, [admission, commandBindings, openSettingsTab, sessionId, workspaceIdentity, workspacePath]);

  const handleDismiss = useCallback(() => {
    if (admission) {
      runUserAction({
        input: { featureId: "conversation.blocking.hook", action: "dismiss", trigger: "button" },
        operation: () => {
          workspaceHookPendingDismissStore.dismiss(sessionId, admission.bundleDigest);
          // Bug 原因：模块级 Set 的写入不属于 React 状态，memo 组件不会重渲染。
          setDismissRevision((revision) => revision + 1);
        },
        completed: { resultSource: "local_commit" },
        failureStage: "hook_dismiss",
      });
    }
  }, [admission, sessionId]);

  if (!admission || admission.pendingCount <= 0) {
    return null;
  }

  // 幂等 dismiss 检查：同 bundle 已 dismiss 则隐藏
  if (workspaceHookPendingDismissStore.isDismissed(sessionId, admission.bundleDigest)) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid={TID_V4_WORKSPACE_HOOK_PENDING_BANNER}
      className="mb-3 flex w-full shrink-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-ui-base text-foreground backdrop-blur-md"
    >
      <p className="min-w-0 flex-1">
        {intl.formatMessage(
          { id: "chat.workspaceHookPending.message" },
          { count: admission.pendingCount },
        )}
      </p>
      <button
        type="button"
        data-testid={TID_V4_WORKSPACE_HOOK_PENDING_REVIEW}
        className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/80"
        onClick={handleReview}
      >
        {intl.formatMessage({ id: "chat.workspaceHookPending.review" })}
      </button>
      <button
        type="button"
        data-testid={TID_V4_WORKSPACE_HOOK_PENDING_DISMISS}
        className="shrink-0 rounded-md px-2 py-1 text-foreground-subtle hover:bg-hover"
        onClick={handleDismiss}
      >
        {intl.formatMessage({ id: "chat.workspaceHookPending.dismiss" })}
      </button>
    </div>
  );
});

interface WorkspaceMcpAdmissionInfo {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

/**
 * 工作区 MCP 软门禁提示条（chat.workspaceMcpPending.*）。
 *
 * 数据源是 v4 快照/增量里的 workspaceMcpAdmission：project 作用域的 MCP 声明在用户信任前不会被
 * CLI 加载，所以这里必须给出「去审核」入口，否则该作用域的 MCP 对用户永久不可用。
 * [去审核] 打开设置页 MCP 分区并把作用域钉到当前工作区；[忽略] 只压住这一次 bundle 的提示，
 * 待审核集合变化（bundleDigest 变）后重新出现。
 */
export const WorkspaceMcpPendingBanner = memo(function WorkspaceMcpPendingBanner({
  sessionId,
  workspacePath,
  workspaceIdentity,
  admission,
}: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  admission: WorkspaceMcpAdmissionInfo | null;
}) {
  const { intl } = useZCodeIntl();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const [, setDismissRevision] = useState(0);

  const handleReview = useCallback(() => {
    // 与 Hooks 同一两行式导航：先写 intent 再开 tab，作用域固定到当前工作区，
    // 不能沿用设置页上一次查看的其它目标。
    setPendingSettingsPluginIntent("mcps", {
      scopeKey: workspaceIdentity?.trim() || workspacePath,
    });
    openSettingsTab?.();
  }, [openSettingsTab, workspaceIdentity, workspacePath]);

  const handleDismiss = useCallback(() => {
    if (!admission) return;
    workspaceMcpPendingDismissStore.dismiss(sessionId, admission.bundleDigest);
    // 模块级 Set 的写入不属于 React 状态，memo 组件不会自行重渲染。
    setDismissRevision((revision) => revision + 1);
  }, [admission, sessionId]);

  if (!admission || admission.pendingCount <= 0) {
    return null;
  }
  if (workspaceMcpPendingDismissStore.isDismissed(sessionId, admission.bundleDigest)) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid={TID_V4_WORKSPACE_MCP_PENDING_BANNER}
      className="mb-3 flex w-full shrink-0 flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning/5 px-3 py-2 text-ui-base text-foreground backdrop-blur-md"
    >
      <p className="min-w-0 flex-1">
        {intl.formatMessage(
          { id: "chat.workspaceMcpPending.message" },
          { count: admission.pendingCount },
        )}
      </p>
      <button
        type="button"
        data-testid={TID_V4_WORKSPACE_MCP_PENDING_REVIEW}
        className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/80"
        onClick={handleReview}
      >
        {intl.formatMessage({ id: "chat.workspaceMcpPending.review" })}
      </button>
      <button
        type="button"
        data-testid={TID_V4_WORKSPACE_MCP_PENDING_DISMISS}
        className="shrink-0 rounded-md px-2 py-1 text-foreground-subtle hover:bg-hover"
        onClick={handleDismiss}
      >
        {intl.formatMessage({ id: "chat.workspaceMcpPending.dismiss" })}
      </button>
    </div>
  );
});
