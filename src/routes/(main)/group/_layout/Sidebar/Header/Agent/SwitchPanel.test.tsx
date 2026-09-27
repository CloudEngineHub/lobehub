import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SwitchPanel from './SwitchPanel';

const { mockUseFetchAgentList } = vi.hoisted(() => ({ mockUseFetchAgentList: vi.fn() }));

vi.mock('@/hooks/useFetchAgentList', () => ({ useFetchAgentList: mockUseFetchAgentList }));
vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => vi.fn(),
}));
vi.mock('@/features/HomeSidebar/Body/Agent/List', () => ({ default: () => null }));
vi.mock('@/features/HomeSidebar/Body/Agent/ModalProvider', () => ({
  AgentModalProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe('group SwitchPanel', () => {
  // The switcher lists the home agent list. Without a subscription on the group
  // page, a directly opened group never loads it and a group created by the
  // builder (G-21) never shows up, because `refreshAgentList` has nothing to
  // revalidate.
  it('subscribes to the home agent list while the group header is mounted', () => {
    render(
      <SwitchPanel>
        <span>trigger</span>
      </SwitchPanel>,
    );

    expect(screen.getByText('trigger')).toBeInTheDocument();
    expect(mockUseFetchAgentList).toHaveBeenCalled();
  });
});
