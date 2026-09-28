import { useMemo } from 'react';

import {
  deriveOperationGoals,
  type OperationGoal,
} from '@/features/Conversation/Messages/GoalTaskCard/deriveOperationGoals';
import {
  getGoalTaskProgress,
  type GoalTaskPhase,
} from '@/features/Conversation/Messages/GoalTaskCard/goalTaskProgress';
import { useChatStore } from '@/store/chat';
import { messageMapKey } from '@/store/chat/utils/messageMapKey';
import { goalSelectors, useGoalStore } from '@/store/goal';

import { useAgentContext } from '../../useAgentContext';
import {
  buildWorkflowRows,
  goalPhaseToStageIndex,
  type GoalWorkflowRow,
  type GoalWorkflowSummary,
  summarizeWorkflow,
} from './goalWorkflowView';

/** Every Goal a conversation created — the sidebar shows one card per goal. */
export const useTopicOperationGoals = (): OperationGoal[] => {
  const context = useAgentContext();
  const chatKey = messageMapKey(context);
  const dbMessages = useChatStore((s) => s.dbMessagesMap[chatKey]);

  return useMemo(() => deriveOperationGoals(dbMessages ?? []), [dbMessages]);
};

export interface GoalWorkflowView {
  goalId: string;
  pendingDecisions: number;
  phase: GoalTaskPhase;
  rows: GoalWorkflowRow[];
  stageIndex: number;
  startedAt?: Date | null;
  summary: GoalWorkflowSummary;
  title?: string;
}

/**
 * One goal's live workflow view for the sidebar card: the graph snapshot →
 * lifecycle phase, stage rail index, ordered task rows (with their assignees)
 * and open decision gates. The card only holds the goal id, so everything is
 * fetched here, polling while the coordinator advances the graph.
 */
export const useGoalWorkflow = (goal: OperationGoal): GoalWorkflowView => {
  const useFetchGoalGraph = useGoalStore((s) => s.useFetchGoalGraph);
  useFetchGoalGraph(goal.goalId);
  const snapshot = useGoalStore(goalSelectors.goalGraph(goal.goalId));

  const taskNodes = snapshot?.nodes.filter((node) => node.kind === 'task') ?? [];
  // The graph numbers Tasks in creation order; the workflow rows must read the same.
  const orderedTaskNodes = [...taskNodes].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  const progress = getGoalTaskProgress({
    criteriaCount: goal.criteriaCount,
    pendingDecisions:
      snapshot?.decisions.filter((decision) => decision.status === 'pending').length ?? 0,
    status: snapshot?.goal.status,
    taskDone: taskNodes.filter((node) => ['rejected', 'resolved', 'retired'].includes(node.status))
      .length,
    taskTotal: taskNodes.length,
  });
  const rows = buildWorkflowRows(orderedTaskNodes, snapshot?.assignees);

  return {
    goalId: goal.goalId,
    pendingDecisions:
      snapshot?.decisions.filter((decision) => decision.status === 'pending').length ?? 0,
    phase: progress.phase,
    rows,
    stageIndex: goalPhaseToStageIndex(progress.phase),
    startedAt: snapshot?.goal.startedAt,
    summary: summarizeWorkflow(rows),
    title: snapshot?.goal.title ?? goal.name,
  };
};
