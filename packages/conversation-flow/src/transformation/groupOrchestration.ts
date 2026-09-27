import type { Message } from '../types';

/**
 * Whether a message was authored by the group's supervisor agent.
 * Reads the canonical `metadata.orchestrationRole` snapshot, falling back to the
 * deprecated boolean `metadata.isSupervisor` for messages written before the
 * field existed.
 */
export const isSupervisorMessage = (message: Message | undefined): boolean =>
  message?.metadata?.orchestrationRole === 'supervisor' || !!message?.metadata?.isSupervisor;

const MEMBER_BARRIER_ANCHOR_CALL_ID = /::m\d+$/;

/**
 * Server-runtime group orchestration persists one `role: 'tool'` row per member
 * (`tool_call_id = <groupToolCallId>::m<i>`) under a multi-member tool
 * (broadcast / executeAgentTasks) as its completion barrier. They are
 * bookkeeping for the async-tool resume, never user-visible messages.
 */
export const isMemberBarrierAnchor = (message: Message | undefined): boolean =>
  message?.role === 'tool' && MEMBER_BARRIER_ANCHOR_CALL_ID.test(message.tool_call_id ?? '');
