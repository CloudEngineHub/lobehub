import { describe, expect, it, vi } from 'vitest';

import { resolveGroupMemberApprovalContinuation } from './groupMemberApproval';

const bridgeBody = {
  anchorMessageId: 'msg_speak',
  expectedMembers: 1,
  groupToolMessageId: 'msg_speak',
  mode: 'in_group',
  onComplete: 'resume',
  parentOperationId: 'op_sup',
};

const memberState = {
  host: {
    hooks: [
      {
        id: 'group-member-bridge',
        type: 'onComplete',
        webhook: { body: bridgeBody, url: '/api/agent/webhooks/group-member-callback' },
      },
    ],
  },
  origin: {
    agentId: 'agt_carol',
    groupId: 'cg_team',
    lineage: { orchestrationRole: 'member', parentOperationId: 'op_sup' },
    scope: 'group',
    topicId: 'tpc_1',
  },
};

const approveParams = {
  agentId: 'agt_sup',
  appContext: { groupId: 'cg_team', orchestrationRole: 'supervisor', topicId: 'tpc_1' },
  prompt: '',
  resumeApproval: {
    decision: 'approved',
    parentMessageId: 'msg_exec_script',
    toolCallId: 'call_x',
  },
} as any;

const createDeps = (state: unknown) => {
  const bridgeHook = { handler: vi.fn(), id: 'group-member-bridge', type: 'onComplete' };
  return {
    bridgeHook,
    deps: {
      createBridgeHook: vi.fn().mockReturnValue(bridgeHook),
      createThreadHooks: vi
        .fn()
        .mockResolvedValue([{ handler: vi.fn(), id: 'thread-completion', type: 'onComplete' }]),
      findMessagePlugin: vi
        .fn()
        .mockResolvedValue({ intervention: { operationId: 'op_carol', status: 'pending' } }),
      loadState: vi.fn().mockResolvedValue(state),
    },
  };
};

// G-05 follow-through: approving a member's tool from the group conversation
// used to continue the SUPERVISOR as a fresh op — the member never finished and
// the parked supervisor op waited on its member barrier forever.
describe('resolveGroupMemberApprovalContinuation', () => {
  it('continues the member that parked the tool, under the supervisor op', async () => {
    const { bridgeHook, deps } = createDeps(memberState);

    const result = await resolveGroupMemberApprovalContinuation(deps as any, approveParams);

    expect(deps.findMessagePlugin).toHaveBeenCalledWith('msg_exec_script');
    expect(deps.loadState).toHaveBeenCalledWith('op_carol');
    expect(deps.createBridgeHook).toHaveBeenCalledWith(bridgeBody);
    expect(result).toMatchObject({
      agentId: 'agt_carol',
      appContext: {
        groupId: 'cg_team',
        orchestrationRole: 'member',
        scope: 'group',
        topicId: 'tpc_1',
      },
      hooks: [bridgeHook],
      parentOperationId: 'op_sup',
      resumeApproval: approveParams.resumeApproval,
      topicStartOwnerOperationId: 'op_sup',
    });
  });

  it('keeps an isolated member in its own thread', async () => {
    const { deps } = createDeps({
      ...memberState,
      origin: { ...memberState.origin, threadId: 'thd_1' },
    });

    const result = await resolveGroupMemberApprovalContinuation(deps as any, approveParams);

    expect(result?.appContext).toMatchObject({
      isolationThread: true,
      isSubAgent: true,
      threadId: 'thd_1',
    });
  });

  // Codex P1 on #20093: the continuation used to install only the bridge, so
  // the isolation thread never ran its completion hook and stayed processing.
  it("rebuilds an isolated member's thread lifecycle hooks before the bridge", async () => {
    const { bridgeHook, deps } = createDeps({
      ...memberState,
      origin: { ...memberState.origin, threadId: 'thd_1' },
    });

    const result = await resolveGroupMemberApprovalContinuation(deps as any, approveParams);

    expect(deps.createThreadHooks).toHaveBeenCalledWith('thd_1');
    expect(result?.hooks?.map((hook) => hook.id)).toEqual(['thread-completion', bridgeHook.id]);
  });

  it('adds no thread hooks for an in_group member', async () => {
    const { bridgeHook, deps } = createDeps(memberState);

    const result = await resolveGroupMemberApprovalContinuation(deps as any, approveParams);

    expect(deps.createThreadHooks).not.toHaveBeenCalled();
    expect(result?.hooks).toEqual([bridgeHook]);
  });

  it('leaves a non-member approval untouched', async () => {
    const { deps } = createDeps({
      ...memberState,
      origin: { agentId: 'agt_sup', topicId: 'tpc_1' },
    });

    expect(await resolveGroupMemberApprovalContinuation(deps as any, approveParams)).toBe(
      undefined,
    );
  });

  it('does not re-enter once the continuation carries hooks', async () => {
    const { deps } = createDeps(memberState);

    expect(
      await resolveGroupMemberApprovalContinuation(deps as any, {
        ...approveParams,
        hooks: [{ id: 'x' }],
      }),
    ).toBe(undefined);
    expect(deps.loadState).not.toHaveBeenCalled();
  });

  it('ignores a call that is not an approval resume', async () => {
    const { deps } = createDeps(memberState);

    expect(
      await resolveGroupMemberApprovalContinuation(
        deps as any,
        {
          agentId: 'agt_sup',
          prompt: 'hi',
        } as any,
      ),
    ).toBe(undefined);
    expect(deps.findMessagePlugin).not.toHaveBeenCalled();
  });
});
