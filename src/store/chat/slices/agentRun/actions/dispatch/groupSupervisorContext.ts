import type { ConversationContext } from '@lobechat/types';

import { agentGroupByIdSelectors, getChatGroupStoreState } from '@/store/agentGroup';

/**
 * Whether `agentId` is the supervisor of the group conversation `groupId`.
 * Only real group supervisors qualify — an `@agent` mention in a 1:1 chat is
 * not a group turn.
 */
export const isGroupSupervisor = (groupId: string | null | undefined, agentId?: string) => {
  if (!groupId || !agentId) return false;
  const group = agentGroupByIdSelectors.groupById(groupId)(getChatGroupStoreState());
  return !!group?.supervisorAgentId && group.supervisorAgentId === agentId;
};

/**
 * The orchestration role a gateway run executes under.
 *
 * The server grants the `lobe-group-management` tools only when
 * `orchestrationRole === 'supervisor'`. Only the first send used to stamp it,
 * so regenerate, approve-and-resume and reject-and-continue re-entered the
 * group's supervisor as a plain agent without its orchestration tools. Every
 * gateway entry resolves the role here instead: an explicit role on the
 * context wins, otherwise the group's supervisor runs as `supervisor`.
 */
export const resolveGroupOrchestrationRole = (
  context: Pick<ConversationContext, 'agentId' | 'groupId' | 'orchestrationRole'>,
): ConversationContext['orchestrationRole'] => {
  if (context.orchestrationRole) return context.orchestrationRole;
  return isGroupSupervisor(context.groupId, context.agentId) ? 'supervisor' : undefined;
};
