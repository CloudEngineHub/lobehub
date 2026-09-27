import type { AgentState } from '@lobechat/agent-runtime';
import type { MessagePluginItem } from '@lobechat/types';

import type { AgentHook } from '@/server/services/agentRuntime/hooks/types';
import type {
  GroupActionMemberMode,
  GroupActionOnComplete,
} from '@/server/services/agentRuntime/types';

import type { InternalExecAgentParams } from '../types';

/** Bridge params persisted on a group member run's serialized `group-member-bridge` hook. */
export interface GroupMemberBridgeParams {
  anchorMessageId: string;
  expectedMembers: number;
  groupToolMessageId: string;
  mode: GroupActionMemberMode;
  onComplete: GroupActionOnComplete;
  parentOperationId: string;
  threadId?: string;
}

export interface GroupMemberApprovalDeps {
  createBridgeHook: (params: GroupMemberBridgeParams) => AgentHook;
  /**
   * Rebuild the isolation thread's lifecycle hooks (metadata + completion
   * status) for a continued isolated member. Hooks are not carried over from
   * the parked op, so without these the thread never leaves processing.
   */
  createThreadHooks: (threadId: string) => Promise<AgentHook[]>;
  findMessagePlugin: (messageId: string) => Promise<MessagePluginItem | undefined>;
  loadState: (operationId: string) => Promise<AgentState | null>;
}

/**
 * Route an approval decision on a group MEMBER's tool back to that member.
 *
 * Members answer to the supervisor's approval mode, so a member can park on a
 * tool that needs approval. The client resolves it from the group conversation,
 * whose agent is the supervisor — taken literally, the continuation would run
 * the supervisor as a fresh op while the member never finishes and the parked
 * supervisor op waits forever on its member barrier.
 *
 * When the decision targets a tool parked by a member run, continue as that
 * member instead: same agent, group member context, the supervisor as parent
 * (topic reservation + stream mirroring + stop cascade), and the member's
 * completion bridge rebuilt from its serialized hook so the member's real
 * outcome backfills its anchor and resumes the supervisor.
 *
 * Returns undefined for every other resume (including a call that already
 * carries hooks, which is how the redirected call avoids re-entering).
 */
export const resolveGroupMemberApprovalContinuation = async (
  deps: GroupMemberApprovalDeps,
  params: InternalExecAgentParams,
): Promise<InternalExecAgentParams | undefined> => {
  if (params.hooks?.length) return undefined;

  const targetMessageId =
    params.resumeApproval?.parentMessageId ?? params.resumeApprovals?.[0]?.parentMessageId;
  if (!targetMessageId) return undefined;

  const sourceOperationId =
    params.approvalSourceOperationId ??
    (await deps.findMessagePlugin(targetMessageId))?.intervention?.operationId;
  if (!sourceOperationId) return undefined;

  const state = await deps.loadState(sourceOperationId);
  const origin = state?.origin;
  if (origin?.lineage?.orchestrationRole !== 'member' || !origin.agentId) return undefined;

  const bridge = state?.host?.hooks?.find((hook) => hook.id === 'group-member-bridge')?.webhook
    ?.body as GroupMemberBridgeParams | undefined;
  if (!bridge?.parentOperationId || !bridge.anchorMessageId || !bridge.groupToolMessageId) {
    return undefined;
  }

  const threadId = origin.threadId ?? undefined;
  // Same order as the original isolated start: thread hooks first, bridge last
  // so its tool-message backfill is the final write.
  const threadHooks = threadId ? await deps.createThreadHooks(threadId) : [];

  return {
    ...params,
    agentId: origin.agentId,
    appContext: {
      ...params.appContext,
      groupId: origin.groupId ?? params.appContext?.groupId,
      // An isolated member runs in its own thread on the supervisor's topic and
      // must not claim the topic's running mark (see `execAgentThreadRun`).
      ...(threadId && { isolationThread: true, isSubAgent: true, threadId }),
      orchestrationRole: 'member',
      scope: 'group',
      topicId: origin.topicId ?? params.appContext?.topicId,
    },
    hooks: [...threadHooks, deps.createBridgeHook(bridge)],
    parentOperationId: bridge.parentOperationId,
    slug: undefined,
    topicStartOwnerOperationId: bridge.parentOperationId,
  };
};
