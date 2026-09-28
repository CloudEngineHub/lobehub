import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GoalWorkflowCard } from './GoalWorkflowCard';
import type { GoalWorkflowView } from './useGoalSection';

const mocks = vi.hoisted(() => ({
  openGoal: vi.fn(),
}));

vi.mock('@/store/chat', () => ({
  useChatStore: (selector: (state: { openGoal: unknown }) => unknown) =>
    selector({ openGoal: mocks.openGoal }),
}));

vi.mock('@/features/AgentGoals/ProcessControl/AssigneeProfileAvatar', () => ({
  default: ({ agentId }: { agentId: string }) => <span data-testid={`assignee-${agentId}`} />,
}));

const baseView: GoalWorkflowView = {
  goalId: 'goal-1',
  pendingDecisions: 0,
  phase: 'running',
  rows: [
    { assigneeId: 'agt-1', id: 't1', state: 'done', title: '盘点凭证委托场景' },
    { assigneeId: 'agt-2', id: 't2', state: 'running', title: '设计代理输入交互' },
    { assigneeId: 'agt-3', id: 't3', state: 'running', title: '产出验证证据' },
    { id: 't4', state: 'pending', title: '整理场景分类' },
    { id: 't5', state: 'pending', title: '编写复现报告' },
  ],
  stageIndex: 1,
  startedAt: null,
  summary: { done: 1, running: 2, total: 5 },
  title: '凭证委托场景全景',
};

describe('GoalWorkflowCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the stage rail and the first batch of parallel rows', () => {
    render(<GoalWorkflowCard goal={baseView} />);

    // key-passthrough i18n mock: component tests assert locale keys, not copy
    for (const key of [
      'workingPanel.goal.stage.planning',
      'workingPanel.goal.stage.running',
      'workingPanel.goal.stage.verifying',
      'workingPanel.goal.stage.review',
      'workingPanel.goal.stage.achieved',
    ]) {
      expect(screen.getByText(key)).toBeInTheDocument();
    }
    expect(screen.getByText('盘点凭证委托场景')).toBeInTheDocument();
    expect(screen.getByText('设计代理输入交互')).toBeInTheDocument();
    // collapsed to the visible cap: the 5th task hides behind "more"
    expect(screen.queryByText('编写复现报告')).not.toBeInTheDocument();
    expect(screen.getByText('workingPanel.goal.more')).toBeInTheDocument();
    expect(screen.getByTestId('assignee-agt-2')).toBeInTheDocument();
  });

  it('expands the hidden rows from "more" and collapses them again', async () => {
    const user = userEvent.setup();
    render(<GoalWorkflowCard goal={baseView} />);

    await user.click(screen.getByText('workingPanel.goal.more'));
    expect(screen.getByText('编写复现报告')).toBeInTheDocument();

    await user.click(screen.getByText('workingPanel.goal.collapse'));
    expect(screen.queryByText('编写复现报告')).not.toBeInTheDocument();
  });

  it('shows the decision gate and opens the portal when it is clicked', async () => {
    const user = userEvent.setup();
    render(<GoalWorkflowCard goal={{ ...baseView, pendingDecisions: 1 }} />);

    await user.click(screen.getByText('workingPanel.goal.decision'));
    expect(mocks.openGoal).toHaveBeenCalledWith('goal-1');
  });

  it('opens the goal portal when a task row is clicked', async () => {
    const user = userEvent.setup();
    render(<GoalWorkflowCard goal={baseView} />);

    await user.click(screen.getByText('产出验证证据'));
    expect(mocks.openGoal).toHaveBeenCalledWith('goal-1');
  });

  it('carries the phase word when the goal is not plainly running', () => {
    render(<GoalWorkflowCard goal={{ ...baseView, phase: 'waiting' }} />);
    expect(screen.getByText('goalTask.status.waiting')).toBeInTheDocument();
  });
});
