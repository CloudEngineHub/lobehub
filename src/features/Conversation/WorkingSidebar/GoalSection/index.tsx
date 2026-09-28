import { memo } from 'react';

import GoalWorkflowCardContainer from './GoalWorkflowCard';
import { useTopicOperationGoals } from './useGoalSection';

/**
 * The conversation's Goals as workflow cards in the working sidebar — one card
 * per goal the topic created. Topics that created no goal render nothing.
 */
const GoalSection = memo<{ className?: string }>(({ className }) => {
  const goals = useTopicOperationGoals();

  if (goals.length === 0) return null;

  return (
    <div className={className}>
      {goals.map((goal) => (
        <GoalWorkflowCardContainer
          criteriaCount={goal.criteriaCount}
          goalId={goal.goalId}
          key={goal.goalId}
          name={goal.name}
        />
      ))}
    </div>
  );
});

GoalSection.displayName = 'WorkingSidebarGoalSection';

export default GoalSection;
