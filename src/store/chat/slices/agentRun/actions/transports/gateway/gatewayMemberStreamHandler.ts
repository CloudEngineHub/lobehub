import type {
  AgentStreamEvent,
  StreamChunkData,
  StreamStartData,
} from '@lobechat/agent-gateway-client';
import type { ConversationContext, UIChatMessage } from '@lobechat/types';

import type { ChatStore } from '@/store/chat/store';
import { messageMapKey } from '@/store/chat/utils/messageMapKey';

/**
 * Pulls a conversation's canonical tree from the DB into its store bucket.
 *
 * `force` re-reads even when the bucket was already hydrated for this run: a
 * member's later steps create rows (tool results, the next assistant message)
 * that the first hydration could not have seen.
 */
export type GatewayMemberHydrate = (
  context: ConversationContext,
  options?: { force?: boolean },
) => Promise<void>;

export interface GatewayMemberStreamHandlerParams {
  /**
   * The shared group conversation context (groupId / topicId / scope='group').
   * Members render in the same `messageMapKey` bucket as the supervisor — the
   * key is derived from groupId, not agentId — so this resolves the member's
   * assistant row to the supervisor's bucket for dispatch. An isolated member
   * (executeAgentTask/s) runs in its own thread instead; the handler switches
   * to that thread's context once the member's first message names it.
   */
  context: ConversationContext;
  /**
   * Hydrate a conversation bucket. Shared across a run's member handlers and
   * single-flight per bucket, so concurrent members don't repeatedly
   * `replaceMessages` and clobber each other's in-flight streamed content. The
   * council only forms when the `agentCouncil` tool message AND the member rows
   * are all present, so inserting bare member rows is not enough.
   */
  hydrate: GatewayMemberHydrate;
  /**
   * The member's server-side operationId (the op whose events are forwarded
   * onto the supervisor's WebSocket).
   */
  memberOperationId: string;
  /**
   * An isolated member started or finished in a thread — refresh the topic's
   * thread list so the thread shows up (and settles) without a reload.
   */
  onThreadActivity?: (threadId: string) => void;
  /**
   * The supervisor's LOCAL operation id, so the member's local loading op is
   * recorded as its child for lineage (and cancelled with it).
   */
  parentOperationId?: string;
}

export interface GatewayMemberStreamHandler {
  (event: AgentStreamEvent): void;
  /** Re-dispatch the accumulated live content, e.g. after a hydration replaced the bucket. */
  repaint: () => void;
  /**
   * The supervisor run is over: retire this member's local op even if its own
   * terminal never arrived (socket closed first, event dropped).
   */
  retire: () => void;
}

/**
 * A render-only handler for a group member whose streaming events are
 * multiplexed onto the supervisor's Gateway WebSocket (server forwards member
 * events onto the supervisor op channel, single-connection multiplexing).
 *
 * Scope is deliberately narrow — it owns ONLY the member's live text/reasoning/
 * tool-call streaming into its row. It does NOT drive any run lifecycle (the
 * supervisor op owns the K=N barrier, unread, queue drain and notification).
 *
 * Structure availability: during the streaming window the supervisor is parked
 * on the group tool, so the client store has neither the `agentCouncil` tool
 * message nor the member rows — and without the council tool message the members
 * would render as a vertical stack instead of parallel columns. On the first
 * member `stream_start` we therefore hydrate the full canonical tree (shared
 * across members) so the council forms, then stream content into the member row
 * via targeted `updateMessage`. A later step's row (after a tool call) or a tool
 * result is not in the store either, so those re-hydrate on demand. Because we
 * dispatch the full accumulated content (not deltas), any chunk that lands
 * before hydration completes is repainted once the row exists — self-healing.
 */
export const createGatewayMemberStreamHandler = (
  get: () => ChatStore,
  params: GatewayMemberStreamHandlerParams,
): GatewayMemberStreamHandler => {
  const { context, hydrate, memberOperationId, onThreadActivity, parentOperationId } = params;

  // Where this member's rows live: the group bucket for in-group members, the
  // member's thread for isolated tasks (known from its first message).
  let targetContext: ConversationContext = context;
  let isolatedThreadId: string | undefined;

  let localOperationId: string | undefined;
  let currentAssistantMessageId: string | undefined;
  let accumulatedContent = '';
  let accumulatedReasoning = '';
  let ended = false;
  // The row a missing-row hydration was last requested for, so a burst of
  // chunks for a row that is still absent costs one read, not one per chunk.
  let hydrationRequestedFor: string | undefined;

  const bucketKey = () =>
    messageMapKey({
      agentId: targetContext.agentId ?? '',
      groupId: targetContext.groupId,
      scope: targetContext.scope,
      threadId: targetContext.threadId,
      topicId: targetContext.topicId,
    });

  const findInStore = (id: string): UIChatMessage | undefined =>
    (get().dbMessagesMap[bucketKey()] ?? []).find((m) => m.id === id);

  // Every thread of a group topic shares ONE `group_agent` bucket, holding
  // whichever thread is open. Only touch it when this member's thread is the
  // one on screen; otherwise the thread is fetched when the user opens it.
  const canHydrateTarget = () => !isolatedThreadId || get().activeThreadId === isolatedThreadId;

  const hydrateTarget = (force?: boolean) =>
    canHydrateTarget() ? hydrate(targetContext, { force }) : Promise.resolve();

  const dispatch = (value: Partial<UIChatMessage>) => {
    if (!currentAssistantMessageId || !localOperationId) return;
    // Self-healing guard: skip until the member row lands in the store (via the
    // shared hydration). The next chunk repaints the full accumulated content
    // once it's present.
    if (!findInStore(currentAssistantMessageId)) {
      // An isolated member's thread may have been opened after its first
      // message: the thread view's own fetch is dropped while the topic is
      // streaming, so nothing else will ever bring the rows in.
      if (
        isolatedThreadId &&
        canHydrateTarget() &&
        hydrationRequestedFor !== currentAssistantMessageId
      ) {
        hydrationRequestedFor = currentAssistantMessageId;
        void hydrateTarget(true).then(repaint);
      }
      return;
    }
    get().internal_dispatchMessage(
      { id: currentAssistantMessageId, type: 'updateMessage', value },
      { conversationContext: targetContext, operationId: localOperationId },
    );
  };

  const repaint = () => {
    if (ended) return;
    if (accumulatedContent) dispatch({ content: accumulatedContent });
    if (accumulatedReasoning) dispatch({ reasoning: { content: accumulatedReasoning } });
  };

  const finish = () => {
    if (ended) return;
    ended = true;
    if (localOperationId) get().completeOperation(localOperationId);
    if (isolatedThreadId) {
      onThreadActivity?.(isolatedThreadId);
      // The open thread's own refetch was dropped while the topic streamed and
      // does not re-run afterwards; land the final rows directly.
      if (canHydrateTarget()) void hydrate(targetContext, { force: true });
    }
  };

  const ensureLocalOp = () => {
    if (localOperationId) return;
    const { operationId } = get().startOperation({
      context: targetContext,
      metadata: { serverOperationId: memberOperationId },
      parentOperationId,
      type: 'execServerAgentRuntime',
    });
    localOperationId = operationId;

    // Stopping a member column stops the run it belongs to. The supervisor's
    // cancel handler interrupts the server op, and the server cascades that
    // stop to every member. The reverse direction (supervisor cancelled →
    // this op cancelled as its child) must not bounce back, so only forward
    // while the parent is still live.
    get().onOperationCancel(operationId, async () => {
      ended = true;
      if (!parentOperationId) return;
      const parent = get().operations[parentOperationId];
      if (parent?.status === 'running') await get().cancelOperation(parentOperationId);
    });
  };

  const handler = (event: AgentStreamEvent) => {
    if (ended) return;

    switch (event.type) {
      case 'stream_start': {
        const data = event.data as StreamStartData | undefined;
        const seed = data?.assistantMessage as
          { id?: string; threadId?: string | null } | undefined;
        const id = seed?.id;
        if (!id) break;

        if (seed.threadId && seed.threadId !== context.threadId && !isolatedThreadId) {
          isolatedThreadId = seed.threadId;
          targetContext = { ...context, scope: 'group_agent', threadId: seed.threadId };
          onThreadActivity?.(seed.threadId);
        }

        ensureLocalOp();
        currentAssistantMessageId = id;
        if (localOperationId) get().associateMessageWithOperation(id, localOperationId);
        accumulatedContent = '';
        accumulatedReasoning = '';
        // Bring in the canonical structure (council tool message + all member
        // rows), then repaint anything already accumulated. A row created by a
        // later step is not covered by the run's first hydration — force a
        // fresh read for it.
        void hydrateTarget().then(() => {
          if (ended) return;
          if (currentAssistantMessageId === id && !findInStore(id)) {
            void hydrateTarget(true).then(repaint);
            return;
          }
          repaint();
        });
        break;
      }

      case 'stream_chunk': {
        const data = event.data as StreamChunkData | undefined;
        if (!data) break;

        if (data.chunkType === 'text' && data.content) {
          accumulatedContent += data.content;
          dispatch({ content: accumulatedContent });
        }
        if (data.chunkType === 'reasoning' && data.reasoning) {
          accumulatedReasoning += data.reasoning;
          dispatch({ reasoning: { content: accumulatedReasoning } });
        }
        if (data.chunkType === 'tools_calling' && data.toolsCalling) {
          dispatch({ tools: data.toolsCalling });
        }
        break;
      }

      case 'step_start': {
        if (localOperationId && typeof event.stepIndex === 'number') {
          get().updateOperationMetadata(localOperationId, { stepCount: event.stepIndex + 1 });
        }
        break;
      }

      case 'tool_end': {
        // The tool result is its own row, persisted server-side; only a fresh
        // read brings it (and the call's final arguments/state) into the store.
        void hydrateTarget(true).then(repaint);
        break;
      }

      case 'visible_output_end': {
        // Example: forwarded member streams can finish text before the
        // supervisor's terminal barrier refetches the group tree. Clear only
        // the member column's visible loading; terminal reconciliation still
        // belongs to the member's terminal.
        //
        // Same guard as the main handler: if the member row isn't
        // in the store yet (group hydration in flight) or its streamed text
        // hasn't landed, clearing loading would show a "done" column with no
        // text — skip the hint and let the terminal barrier reconcile both.
        if (currentAssistantMessageId) {
          const stored = findInStore(currentAssistantMessageId);
          if (!stored || (accumulatedContent && !stored.content)) break;
        }
        if (localOperationId) {
          get().updateOperationMetadata(localOperationId, { visibleLoadingDone: true });
        }
        break;
      }

      // `member_runtime_end` is how the server mirrors a member's terminal onto
      // the supervisor's channel; `agent_runtime_end` is the pre-rename shape
      // older servers still send.
      case 'member_runtime_end':
      case 'agent_runtime_end':
      case 'error': {
        // The member row's final structure (tools, content, metadata) is
        // reconciled by the supervisor op's terminal refetch / council barrier.
        // This handler owns only the live text, so just retire the loading op.
        // A member parked on a human approval is the exception: the supervisor
        // waits on it, so no terminal refetch comes, and the pending tool row
        // (the approval card) only lands with a read of its own.
        const reason = (event.data as { reason?: string } | undefined)?.reason;
        if (reason === 'waiting_for_human' && canHydrateTarget()) {
          void hydrate(targetContext, { force: true });
        }
        finish();
        break;
      }
    }
  };

  return Object.assign(handler, { repaint, retire: finish });
};

/**
 * All member handlers of one supervisor run, sharing its hydration.
 *
 * Hydration is single-flight per bucket: a request while one is in flight
 * schedules exactly one trailing read, so a burst of member events costs at most
 * two fetches and the last one always reflects the latest DB state. After each
 * read every live handler repaints its accumulated content — `replaceMessages`
 * swaps the whole bucket, including rows other members are streaming into.
 */
export const createGatewayMemberRegistry = (
  get: () => ChatStore,
  params: {
    context: ConversationContext;
    fetchMessages: (context: ConversationContext) => Promise<UIChatMessage[]>;
    onThreadActivity?: (threadId: string) => void;
    parentOperationId?: string;
  },
) => {
  const { context, fetchMessages, onThreadActivity, parentOperationId } = params;
  const handlers = new Set<GatewayMemberStreamHandler>();
  const hydrations = new Map<
    string,
    { current: Promise<void>; trailing?: Promise<void>; done: boolean }
  >();

  const read = async (target: ConversationContext) => {
    try {
      const messages = await fetchMessages(target);
      get().replaceMessages(messages, { context: target });
    } catch {
      /* non-critical: the supervisor's terminal refetch reconciles */
    }
    for (const handler of handlers) handler.repaint();
  };

  const hydrate: GatewayMemberHydrate = (target, options) => {
    const key = messageMapKey({
      agentId: target.agentId ?? '',
      groupId: target.groupId,
      scope: target.scope,
      threadId: target.threadId,
      topicId: target.topicId,
    });
    const entry = hydrations.get(key);
    if (!entry) {
      const next: { current: Promise<void>; trailing?: Promise<void>; done: boolean } = {
        current: read(target).then(() => {
          next.done = true;
        }),
        done: false,
      };
      hydrations.set(key, next);
      return next.current;
    }
    if (!options?.force) return entry.current;
    if (entry.done) {
      entry.done = false;
      entry.current = read(target).then(() => {
        entry.done = true;
      });
      return entry.current;
    }
    // In flight: queue one trailing read behind it, shared by every caller.
    entry.trailing ??= entry.current.then(() => {
      entry.trailing = undefined;
      entry.done = false;
      entry.current = read(target).then(() => {
        entry.done = true;
      });
      return entry.current;
    });
    return entry.trailing;
  };

  return {
    createMemberHandler: (memberOperationId: string) => {
      const handler = createGatewayMemberStreamHandler(get, {
        context,
        hydrate,
        memberOperationId,
        onThreadActivity,
        parentOperationId,
      });
      handlers.add(handler);
      return handler;
    },
    /** The supervisor run ended: retire every member op still marked running. */
    retireAll: () => {
      for (const handler of handlers) handler.retire();
    },
  };
};
