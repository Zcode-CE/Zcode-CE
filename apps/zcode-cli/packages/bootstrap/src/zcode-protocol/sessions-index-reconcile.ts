// sessions-index reconcile 的持久事实查询（V4 只读查询，绝不创建或恢复运行实例）。
//
// 为什么单独成模块：v4-bridge 的 `reconcileSessions` 钩子只是转调，真正的
// "按 workspaceId + sessionIds 查 store" 语义必须能被单测直接钉住——它的三个判据
// （workspace 归属、标题来源归一、缺失即 exists:false）错一个都会让桌面索引
// 静默删错行或写回错误标题。查询面只取 `getSession`，类型层就杜绝激活 runtime。
import type { SessionId, SessionStorePort, WorkspaceId } from "@zcode/contracts";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import type { SessionSummary, SessionsIndexReconcileResult } from "@zcode/shared/zcode-protocol-v4";

/** 持久化的标题来源归一：旧记录可能缺列或写成未知值，一律按 generated 处理。 */
export function normalizeStoredTitleSource(
  source: string | undefined,
): NonNullable<SessionSummary["titleSource"]> {
  if (source === "custom") return "custom";
  if (source === "default") return "default";
  return "generated";
}

/**
 * 按明确 ID 查询持久事实。
 *
 * 语义约束：
 * - snapshot 缺席不是删除：调用方只能拿这里的结果裁定，不能从"列表里没有"推断不存在。
 * - 远端 workspaceId 是隔离 identity，directory 是实际文件路径，两者必须同时匹配，
 *   否则同路径下其他 authority 的会话会被误认成当前 workspace。
 * - CE 的 session store 没有软删列：会话要么在库里、要么整条不在，
 *   故这里 deleted 恒为 false（协议字段保留，供将来 store 支持软删时按 true 回填）。
 */
export async function reconcileStoredSessions(params: {
  store: Pick<SessionStorePort, "getSession">;
  workspaceId: string;
  sessionIds: readonly string[];
}): Promise<SessionsIndexReconcileResult> {
  const remote = parseRemoteWorkspaceIdentity(params.workspaceId);
  const directory = remote?.workspacePath ?? params.workspaceId;
  const workspaceID = params.workspaceId as WorkspaceId;
  const sessions = await Promise.all(
    [...new Set(params.sessionIds)].map(async (sessionId) => {
      const session = await params.store.getSession(sessionId as SessionId);
      // 本地 workspace 的历史会话可能带空 identity（3.3.6 之前），只允许空/相等两种；
      // 远端 workspace 必须精确匹配 identity，不能只凭目录认领。
      const sameWorkspace =
        session !== null &&
        session.directory === directory &&
        (remote
          ? session.workspaceID === workspaceID
          : !session.workspaceID || session.workspaceID === workspaceID);
      if (!sameWorkspace) {
        return { sessionId, exists: false as const, deleted: false as const };
      }
      return {
        sessionId,
        exists: true as const,
        deleted: false,
        title: session.title,
        titleSource: normalizeStoredTitleSource(session.titleSource),
        createdAt: session.time.created,
        updatedAt: session.time.updated,
      };
    }),
  );
  return { sessions };
}
