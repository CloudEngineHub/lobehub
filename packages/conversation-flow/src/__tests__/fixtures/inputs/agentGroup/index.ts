import type { Message } from '../../../../types';
import serverBroadcastSummary from './server-broadcast-summary.json';
import serverExecuteAgentTasks from './server-execute-agent-tasks.json';
import serverSpeakSequentialMembers from './server-speak-sequential-members.json';
import serverSpeakSingleMember from './server-speak-single-member.json';
import speakDifferentAgent from './speak-different-agent.json';
import supervisorAfterMultiTasks from './supervisor-after-multi-tasks.json';
import supervisorContentOnly from './supervisor-content-only.json';

export const agentGroup = {
  serverBroadcastSummary: serverBroadcastSummary as Message[],
  serverExecuteAgentTasks: serverExecuteAgentTasks as Message[],
  serverSpeakSequentialMembers: serverSpeakSequentialMembers as Message[],
  serverSpeakSingleMember: serverSpeakSingleMember as Message[],
  speakDifferentAgent: speakDifferentAgent as Message[],
  supervisorAfterMultiTasks: supervisorAfterMultiTasks as Message[],
  supervisorContentOnly: supervisorContentOnly as Message[],
};
