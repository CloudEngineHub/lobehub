import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { homeService } from '@/services/home';
import type * as AgentStoreModule from '@/store/agent';
import { useHomeStore } from '@/store/home';

vi.mock('@/business/client/hooks/useActiveWorkspaceId', () => ({
  getActiveWorkspaceId: vi.fn(() => null),
  useActiveWorkspaceId: vi.fn(() => null),
}));

vi.mock('@/store/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStoreModule>();

  return {
    ...actual,
    getAgentStoreState: vi.fn(() => ({ invalidateAvailableAgents: vi.fn() })),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agentList fetchAgentList', () => {
  // The group switcher reads this list from the store while no
  // `useFetchAgentList` hook is mounted, so a key-only SWR revalidation
  // refetched nothing and a group created by the builder never appeared.
  it('applies the refetched list to the store without a mounted list hook', async () => {
    const newGroup = { id: 'cg_new', title: 'Launch Crew', type: 'group' };
    vi.spyOn(homeService, 'getSidebarAgentList').mockResolvedValue({
      groups: [],
      pinned: [],
      ungrouped: [newGroup],
    } as any);

    act(() => {
      useHomeStore.setState({ isAgentListInit: true, ungroupedAgents: [] });
    });

    await act(async () => {
      await useHomeStore.getState().fetchAgentList();
    });

    expect(homeService.getSidebarAgentList).toHaveBeenCalledTimes(1);
    expect(useHomeStore.getState().ungroupedAgents).toEqual([newGroup]);
  });
});
