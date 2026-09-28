import type {
  GoalStep,
  GoalTaskPhase,
} from '@/features/Conversation/Messages/GoalTaskCard/goalTaskProgress';

export const GOAL_WORKFLOW_STAGE_KEYS = [
  'workingPanel.goal.stage.planning',
  'workingPanel.goal.stage.running',
  'workingPanel.goal.stage.verifying',
  'workingPanel.goal.stage.review',
  'workingPanel.goal.stage.achieved',
] as const;

/**
 * Which rail stage a lifecycle phase lights up. Sub-states that still mean
 * "work is happening" (waiting on a person, repairing, paused) stay on the
 * running stage — the phase pill next to the header carries the nuance.
 */
export const goalPhaseToStageIndex = (phase: GoalTaskPhase): number => {
  switch (phase) {
    case 'verifying': {
      return 2;
    }
    case 'review': {
      return 3;
    }
    case 'achieved': {
      return 4;
    }
    default: {
      return 1;
    }
  }
};

export type GoalWorkflowRowState = 'done' | 'running' | 'waiting' | 'pending';

export interface GoalWorkflowRow {
  assigneeId?: string;
  id: string;
  state: GoalWorkflowRowState;
  title: string;
}

const CLOSED_STEP_STATUSES = new Set(['rejected', 'resolved', 'retired']);

/** Task nodes as display rows: closed steps read as done, `active` as running. */
export const buildWorkflowRows = (
  nodes: { id: string; status: GoalStep['status']; title: string }[],
  assignees?: Record<string, string>,
): GoalWorkflowRow[] =>
  nodes.map((node) => ({
    assigneeId: assignees?.[node.id],
    id: node.id,
    state: CLOSED_STEP_STATUSES.has(node.status)
      ? 'done'
      : node.status === 'active'
        ? 'running'
        : node.status === 'waiting'
          ? 'waiting'
          : 'pending',
    title: node.title,
  }));

export interface GoalWorkflowSummary {
  done: number;
  running: number;
  total: number;
}

export const summarizeWorkflow = (rows: GoalWorkflowRow[]): GoalWorkflowSummary => ({
  done: rows.filter((row) => row.state === 'done').length,
  running: rows.filter((row) => row.state === 'running').length,
  total: rows.length,
});

/** A chat sidebar keeps at most this many rows before folding into "N more". */
export const MAX_VISIBLE_WORKFLOW_ROWS = 4;

export const sliceVisibleWorkflowRows = (
  rows: GoalWorkflowRow[],
  expanded: boolean,
): GoalWorkflowRow[] => (expanded ? rows : rows.slice(0, MAX_VISIBLE_WORKFLOW_ROWS));
