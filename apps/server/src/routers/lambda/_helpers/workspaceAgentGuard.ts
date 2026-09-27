import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';

import { agents, chatGroups, chatGroupsAgents } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assertCanPerformResourceAction } from '@/server/services/resourcePermission';

interface WorkspaceAgentGuardParams {
  agentId?: string;
  db: LobeChatDatabase;
  groupId?: string | null;
  slug?: string;
  userId: string;
  workspaceId?: string | null;
}

export const getWorkspaceAgentParentGroupIds = async ({
  agentId,
  db,
  workspaceId,
}: {
  agentId: string;
  db: LobeChatDatabase;
  workspaceId: string;
}): Promise<string[]> => {
  const linkedGroups = await db
    .select({ groupId: chatGroupsAgents.chatGroupId })
    .from(chatGroupsAgents)
    .innerJoin(agents, eq(chatGroupsAgents.agentId, agents.id))
    .where(
      and(
        eq(chatGroupsAgents.agentId, agentId),
        eq(chatGroupsAgents.workspaceId, workspaceId),
        eq(agents.virtual, true),
      ),
    );

  return [...new Set(linkedGroups.map((row) => row.groupId))];
};

/**
 * Reverse lookup: the virtual (group-owned) agents of a workspace group —
 * supervisor + generated members. Standalone agents linked into the group are
 * excluded; they keep their own ACL.
 */
export const getWorkspaceGroupVirtualAgentIds = async ({
  db,
  groupId,
  workspaceId,
}: {
  db: LobeChatDatabase;
  groupId: string;
  workspaceId: string;
}): Promise<string[]> => {
  const rows = await db
    .select({ agentId: chatGroupsAgents.agentId })
    .from(chatGroupsAgents)
    .innerJoin(agents, eq(chatGroupsAgents.agentId, agents.id))
    .where(
      and(
        eq(chatGroupsAgents.chatGroupId, groupId),
        eq(chatGroupsAgents.workspaceId, workspaceId),
        eq(agents.virtual, true),
      ),
    );

  return [...new Set(rows.map((row) => row.agentId))];
};

const assertOwnPersonalGroup = async ({
  db,
  groupId,
  userId,
}: {
  db: LobeChatDatabase;
  groupId: string;
  userId: string;
}) => {
  const group = await db.query.chatGroups.findFirst({
    columns: { id: true },
    where: and(
      eq(chatGroups.id, groupId),
      eq(chatGroups.userId, userId),
      isNull(chatGroups.workspaceId),
    ),
  });
  if (!group) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission to use this resource',
    });
  }
};

/**
 * Workspace `use` guard for agent execution entrypoints.
 *
 * Group-owned virtual agents are standalone rows and can be addressed by id,
 * but their execution capability must never exceed the parent group. Require
 * both the agent ACL and every linked group ACL so a direct `execAgent` call
 * cannot bypass a view-only group. An explicit group context is checked for
 * non-virtual members too.
 */
export const assertCanUseWorkspaceAgent = async ({
  agentId,
  db,
  groupId,
  slug,
  userId,
  workspaceId,
}: WorkspaceAgentGuardParams): Promise<void> => {
  if (!workspaceId) {
    // Personal space has no resource ACL, but an explicit group context still
    // has to be the caller's own group: it is written onto the topic and
    // messages and turns on the supervisor role, so a forged id would stamp
    // someone else's group onto the caller's data.
    if (groupId) await assertOwnPersonalGroup({ db, groupId, userId });
    return;
  }
  if (!agentId && !slug) return;

  let resourceId = agentId;
  if (!resourceId && slug) {
    const agent = await db.query.agents.findFirst({
      columns: { id: true },
      where: and(eq(agents.slug, slug), eq(agents.workspaceId, workspaceId)),
    });
    resourceId = agent?.id;
  }
  if (!resourceId) return;

  const groupIds = new Set(
    await getWorkspaceAgentParentGroupIds({ agentId: resourceId, db, workspaceId }),
  );
  if (groupId) groupIds.add(groupId);

  await Promise.all([
    assertCanPerformResourceAction({
      action: 'use',
      db,
      resourceId,
      resourceType: 'agent',
      userId,
      workspaceId,
    }),
    ...[...groupIds].map((resourceId) =>
      assertCanPerformResourceAction({
        action: 'use',
        db,
        resourceId,
        resourceType: 'agentGroup',
        userId,
        workspaceId,
      }),
    ),
  ]);
};
