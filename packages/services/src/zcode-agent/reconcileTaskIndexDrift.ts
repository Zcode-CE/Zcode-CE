import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type { IZCodeAgentService, ZCodeAgentWorkspaceTarget } from "#src/zcode-agent/zcodeAgent.js";

/** 协议 schema 单次上限也是 256；索引行多于它就分批对账。 */
const RECONCILE_BATCH_SIZE = 256;

/**
 * 冷基线快照之后校准 task index 的漂移行。
 *
 * 为什么需要它：sessions-index 的 snapshot 只覆盖列表可见会话（类型过滤 + 条数上限），
 * 所以"索引有行、快照里没有"既可能是分页/过滤差异，也可能是 CLI 侧确实删了。
 * 唯一能区分的是 CLI 的持久事实，因此只对这批 ID 发 reconcile 查询。
 *
 * 两条判据（与上游 3.16.2 一致）：
 * - 只消费 CLI 明确报告的删除（`deleted === true`）：列表缺席不是删除，不能据 `exists:false`
 *   反推删除——宿主索引里的行可能来自历史迁移或尚未落盘的导入，静默删掉用户会话不可逆。
 * - 旧 CLI 没有该能力时整体跳过，保持既有轮询语义，不用启发式补位。
 *
 * CE 的 CLI session store 目前没有软删列（上游 time_deleted 属另一波 store 改动），
 * 所以今天的 reconcile 不会返回 `deleted:true`——这条链在 store 支持软删后自动生效。
 */
export async function reconcileTaskIndexDrift(params: {
  target: ZCodeAgentWorkspaceTarget;
  visibleSessionIds: ReadonlySet<string>;
  agentService: Pick<IZCodeAgentService, "reconcileSessionsIndexV4">;
  taskIndexRepo: Pick<TaskIndexRepo, "listTaskMetas" | "updateTaskState">;
  isCurrent: () => boolean;
  onRemoved: () => void;
}): Promise<void> {
  const reconcile = params.agentService.reconcileSessionsIndexV4;
  if (!reconcile) return;
  const { target, taskIndexRepo, isCurrent } = params;
  const rows = await taskIndexRepo.listTaskMetas({ ...target, provider: ZCODE_AGENT_PROVIDER });
  const ids = rows
    .filter((row) => !params.visibleSessionIds.has(row.taskId))
    .map((row) => row.taskId);
  for (let offset = 0; offset < ids.length; offset += RECONCILE_BATCH_SIZE) {
    if (!isCurrent()) return;
    const result = await reconcile({
      ...target,
      sessionIds: ids.slice(offset, offset + RECONCILE_BATCH_SIZE),
    });
    for (const fact of result.sessions) {
      if (!isCurrent()) return;
      // exists:false 只说明这次查询没命中（身份不匹配、分页外、导入未落盘），不是删除。
      if (!fact.deleted) continue;
      await taskIndexRepo.updateTaskState({
        ...target,
        taskId: fact.sessionId,
        patch: { deleted: true },
      });
      if (isCurrent()) params.onRemoved();
    }
  }
}
