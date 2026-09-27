/**
 * @vitest-environment happy-dom
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useGatewayReconnect, useTopicGatewayReconnect } from './useGatewayReconnect';

const mocks = vi.hoisted(() => ({
  reconnectToGatewayOperation: vi.fn().mockResolvedValue(undefined),
  topics: {} as Record<string, { metadata?: { runningOperation?: unknown } }>,
}));

vi.mock('@/store/chat', () => {
  const state = () => ({
    reconnectToGatewayOperation: mocks.reconnectToGatewayOperation,
    topics: mocks.topics,
  });
  const useChatStore = (selector: (s: ReturnType<typeof state>) => unknown) => selector(state());
  useChatStore.getState = state;
  return { useChatStore };
});
vi.mock('@/store/chat/selectors', () => ({
  topicSelectors: {
    getTopicById: (id: string) => (s: { topics: typeof mocks.topics }) => s.topics[id],
  },
}));
vi.mock('@/store/serverConfig', () => ({
  useServerConfigStore: (selector: (s: any) => unknown) =>
    selector({ serverConfig: { agentGatewayUrl: 'https://gateway.test' } }),
}));

describe('useGatewayReconnect', () => {
  beforeEach(() => {
    mocks.reconnectToGatewayOperation.mockClear();
  });

  it('carries the group and scope of the surface into the reconnect (G-14)', async () => {
    renderHook(() =>
      useGatewayReconnect(
        'tpc_1',
        { assistantMessageId: 'msg_1', operationId: 'op_reconnect_group' },
        'agt_supervisor',
        undefined,
        { groupId: 'cg_1', scope: 'group' },
      ),
    );

    await waitFor(() =>
      expect(mocks.reconnectToGatewayOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agt_supervisor',
          groupId: 'cg_1',
          operationId: 'op_reconnect_group',
          scope: 'group',
          topicId: 'tpc_1',
        }),
      ),
    );
  });
});

describe('useTopicGatewayReconnect', () => {
  beforeEach(() => {
    mocks.reconnectToGatewayOperation.mockClear();
  });

  it('resumes the group supervisor run a reloaded group chat still has running (G-14)', async () => {
    mocks.topics = {
      tpc_group: {
        metadata: { runningOperation: { assistantMessageId: 'msg_1', operationId: 'op_sup' } },
      },
    };

    renderHook(() =>
      useTopicGatewayReconnect('tpc_group', 'agt_supervisor', { groupId: 'cg_1', scope: 'group' }),
    );

    await waitFor(() =>
      expect(mocks.reconnectToGatewayOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agt_supervisor',
          groupId: 'cg_1',
          operationId: 'op_sup',
          scope: 'group',
          topicId: 'tpc_group',
        }),
      ),
    );
  });

  it('resumes a builder run in the builder scope (G-14)', async () => {
    mocks.topics = {
      tpc_builder: {
        metadata: { runningOperation: { assistantMessageId: 'msg_b', operationId: 'op_builder' } },
      },
    };

    renderHook(() =>
      useTopicGatewayReconnect('tpc_builder', 'agt_builder', { scope: 'group_agent_builder' }),
    );

    await waitFor(() =>
      expect(mocks.reconnectToGatewayOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agt_builder',
          operationId: 'op_builder',
          scope: 'group_agent_builder',
          topicId: 'tpc_builder',
        }),
      ),
    );
  });

  it('does nothing for a topic with no running marker', async () => {
    mocks.topics = { tpc_idle: { metadata: {} } };

    renderHook(() => useTopicGatewayReconnect('tpc_idle', 'agt_supervisor', { scope: 'group' }));

    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.reconnectToGatewayOperation).not.toHaveBeenCalled();
  });
});
