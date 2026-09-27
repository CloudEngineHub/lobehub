import type { AgentStreamEvent } from '@lobechat/agent-gateway-client';
import type { ConversationContext } from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';

import type { ChatStore } from '@/store/chat/store';
import { messageMapKey } from '@/store/chat/utils/messageMapKey';

import {
  createGatewayMemberRegistry,
  createGatewayMemberStreamHandler,
} from './gatewayMemberStreamHandler';

const context = {
  agentId: 'member-agent',
  groupId: 'group-1',
  scope: 'group',
  topicId: 'topic-1',
} as ConversationContext;

const keyOf = (ctx: ConversationContext) =>
  messageMapKey({
    agentId: ctx.agentId ?? '',
    groupId: ctx.groupId,
    scope: ctx.scope,
    threadId: ctx.threadId,
    topicId: ctx.topicId,
  });

const bucketKey = keyOf(context);
const threadContext = {
  ...context,
  scope: 'group_agent',
  threadId: 'thd-1',
} as ConversationContext;
const threadKey = keyOf(threadContext);

const makeEvent = (
  type: AgentStreamEvent['type'] | 'member_runtime_end',
  data?: AgentStreamEvent['data'],
  stepIndex = 0,
) =>
  ({
    data,
    id: 'event-1',
    operationId: 'server-member-op',
    stepIndex,
    timestamp: 0,
    type,
  }) as AgentStreamEvent;

const createStore = (dbMessagesMap: Record<string, any[]> = {}) =>
  ({
    associateMessageWithOperation: vi.fn(),
    cancelOperation: vi.fn(),
    completeOperation: vi.fn(),
    dbMessagesMap,
    internal_dispatchMessage: vi.fn(),
    onOperationCancel: vi.fn(),
    operations: {},
    startOperation: vi.fn(() => ({
      abortController: new AbortController(),
      operationId: 'local-member-op',
    })),
    updateOperationMetadata: vi.fn(),
  }) as unknown as ChatStore;

/**
 * Params accepted by both the current handler (`hydrate`) and the pre-fix one
 * (`ensureGroupHydrated`), so the behavioral assertions below are what fails
 * on the old implementation — not a missing parameter.
 */
const handlerParams = (hydrate: (ctx: ConversationContext, o?: any) => Promise<void>) =>
  ({
    context,
    ensureGroupHydrated: () => hydrate(context),
    hydrate,
    memberOperationId: 'server-member-op',
    parentOperationId: 'owner-op',
  }) as any;

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createGatewayMemberStreamHandler', () => {
  it('clears visible loading for the local member op without completing it', () => {
    // The member row is already hydrated into the store (group hydration done),
    // so the visible_output_end hint is honored.
    const store = createStore({
      [bucketKey]: [{ content: 'hello', id: 'member-msg', role: 'assistant' }],
    });
    const handler = createGatewayMemberStreamHandler(
      () => store,
      handlerParams(vi.fn().mockResolvedValue(undefined)),
    );

    handler(makeEvent('stream_start', { assistantMessage: { id: 'member-msg' } }));
    handler(makeEvent('visible_output_end'));

    expect(store.updateOperationMetadata).toHaveBeenCalledWith('local-member-op', {
      visibleLoadingDone: true,
    });
    expect(store.completeOperation).not.toHaveBeenCalled();
  });

  it('skips the visible loading hint while the member row is not yet in the store ', () => {
    // Group hydration is still in flight, so the member row hasn't landed. Clearing
    // loading here would show a "done" column with no text — the guard skips it and
    // lets the terminal barrier reconcile.
    const store = createStore();
    const handler = createGatewayMemberStreamHandler(
      () => store,
      handlerParams(vi.fn().mockResolvedValue(undefined)),
    );

    handler(makeEvent('stream_start', { assistantMessage: { id: 'member-msg' } }));
    handler(makeEvent('visible_output_end'));

    expect(store.updateOperationMetadata).not.toHaveBeenCalled();
  });

  it('retires the member op on the mirrored member_runtime_end (G-02)', () => {
    // The server now mirrors a member terminal onto the supervisor channel as
    // `member_runtime_end`, so the gateway does not end the supervisor session.
    const store = createStore({
      [bucketKey]: [{ content: '', id: 'member-msg', role: 'assistant' }],
    });
    const handler = createGatewayMemberStreamHandler(
      () => store,
      handlerParams(vi.fn().mockResolvedValue(undefined)),
    );

    handler(makeEvent('stream_start', { assistantMessage: { id: 'member-msg' } }));
    handler(makeEvent('member_runtime_end', { reason: 'done' }));

    expect(store.completeOperation).toHaveBeenCalledWith('local-member-op');
  });

  it('forwards a member stop to the running supervisor op and stops rendering (G-04)', async () => {
    const store = createStore({
      [bucketKey]: [{ content: '', id: 'member-msg', role: 'assistant' }],
    });
    (store as any).operations = { 'owner-op': { status: 'running' } };
    const handler = createGatewayMemberStreamHandler(
      () => store,
      handlerParams(vi.fn().mockResolvedValue(undefined)),
    );

    handler(makeEvent('stream_start', { assistantMessage: { id: 'member-msg' } }));
    expect(store.onOperationCancel).toHaveBeenCalledWith('local-member-op', expect.any(Function));

    const onCancel = (store.onOperationCancel as any).mock.calls[0][1];
    await onCancel({ operationId: 'local-member-op' });
    expect(store.cancelOperation).toHaveBeenCalledWith('owner-op');

    // Chunks still in flight after the stop no longer paint the cancelled column.
    handler(makeEvent('stream_chunk', { chunkType: 'text', content: 'late' }));
    expect(store.internal_dispatchMessage).not.toHaveBeenCalled();
  });

  it('does not bounce a supervisor-driven cancel back to the supervisor (G-04)', async () => {
    const store = createStore({
      [bucketKey]: [{ content: '', id: 'member-msg', role: 'assistant' }],
    });
    (store as any).operations = { 'owner-op': { status: 'cancelled' } };
    const handler = createGatewayMemberStreamHandler(
      () => store,
      handlerParams(vi.fn().mockResolvedValue(undefined)),
    );

    handler(makeEvent('stream_start', { assistantMessage: { id: 'member-msg' } }));
    const onCancel = (store.onOperationCancel as any).mock.calls[0][1];
    await onCancel({ operationId: 'local-member-op' });

    expect(store.cancelOperation).not.toHaveBeenCalled();
  });

  it('streams an isolated member into its thread bucket, not the group bucket (G-16)', async () => {
    // Isolated tasks (executeAgentTask/s) write the member's rows into a thread.
    const store = createStore({
      [threadKey]: [{ content: '', id: 'thread-msg', role: 'assistant', threadId: 'thd-1' }],
    });
    (store as any).activeThreadId = 'thd-1';
    const hydrate = vi.fn().mockResolvedValue(undefined);
    const handler = createGatewayMemberStreamHandler(() => store, handlerParams(hydrate));

    handler(
      makeEvent('stream_start', { assistantMessage: { id: 'thread-msg', threadId: 'thd-1' } }),
    );
    await flush();
    handler(makeEvent('stream_chunk', { chunkType: 'text', content: 'task progress' }));

    expect(hydrate).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'group_agent', threadId: 'thd-1' }),
      expect.anything(),
    );
    expect(store.internal_dispatchMessage).toHaveBeenCalledWith(
      { id: 'thread-msg', type: 'updateMessage', value: { content: 'task progress' } },
      expect.objectContaining({
        conversationContext: expect.objectContaining({ threadId: 'thd-1' }),
      }),
    );
  });

  it('hydrates an isolated thread the user opens after the member started (G-16)', async () => {
    // The thread was not on screen at the member's first message, so its rows
    // were never loaded; the thread view's own fetch is dropped while the
    // topic streams.
    const dbMessagesMap: Record<string, any[]> = {};
    const store = createStore(dbMessagesMap);
    (store as any).activeThreadId = null;
    const hydrate = vi.fn(async (ctx: ConversationContext) => {
      if (ctx.threadId === 'thd-1') {
        dbMessagesMap[threadKey] = [{ content: '', id: 'thread-msg', role: 'assistant' }];
      }
    });
    const handler = createGatewayMemberStreamHandler(() => store, handlerParams(hydrate));

    handler(
      makeEvent('stream_start', { assistantMessage: { id: 'thread-msg', threadId: 'thd-1' } }),
    );
    await flush();
    expect(hydrate).not.toHaveBeenCalled();

    // The user opens the thread mid-run.
    (store as any).activeThreadId = 'thd-1';
    handler(makeEvent('stream_chunk', { chunkType: 'text', content: 'partial' }));
    handler(makeEvent('stream_chunk', { chunkType: 'text', content: ' more' }));
    await flush();
    await flush();

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thd-1' }), {
      force: true,
    });
    expect(store.internal_dispatchMessage).toHaveBeenLastCalledWith(
      { id: 'thread-msg', type: 'updateMessage', value: { content: 'partial more' } },
      expect.anything(),
    );

    // The member ends: the open thread gets its final rows.
    hydrate.mockClear();
    handler(makeEvent('member_runtime_end', { reason: 'done' }));
    expect(hydrate).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thd-1' }), {
      force: true,
    });
  });

  it('re-hydrates on tool_end so the member tool result lands live (G-20)', async () => {
    const store = createStore({
      [bucketKey]: [{ content: '', id: 'member-msg', role: 'assistant' }],
    });
    const hydrate = vi.fn().mockResolvedValue(undefined);
    const handler = createGatewayMemberStreamHandler(() => store, handlerParams(hydrate));

    handler(makeEvent('stream_start', { assistantMessage: { id: 'member-msg' } }));
    await flush();
    hydrate.mockClear();

    handler(makeEvent('tool_end', { isSuccess: true, payload: { id: 'call-1' } }));

    expect(hydrate).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'group-1' }), {
      force: true,
    });
  });

  it("re-hydrates when a later step's row is missing, then streams into it (G-20)", async () => {
    // Step 1's row was hydrated; step 2 (after the member's tool call) creates
    // a new assistant row the first hydration could not have seen.
    const dbMessagesMap: Record<string, any[]> = {
      [bucketKey]: [{ content: 'step one', id: 'member-msg-1', role: 'assistant' }],
    };
    const store = createStore(dbMessagesMap);
    const hydrate = vi.fn(async (_ctx: ConversationContext, options?: { force?: boolean }) => {
      if (options?.force) {
        dbMessagesMap[bucketKey] = [
          ...dbMessagesMap[bucketKey],
          { content: '', id: 'member-msg-2', role: 'assistant' },
        ];
      }
    });
    const handler = createGatewayMemberStreamHandler(() => store, handlerParams(hydrate));

    handler(makeEvent('stream_start', { assistantMessage: { id: 'member-msg-1' } }));
    await flush();
    handler(makeEvent('stream_start', { assistantMessage: { id: 'member-msg-2' } }, 1));
    handler(makeEvent('stream_chunk', { chunkType: 'text', content: 'after script' }, 1));
    await flush();
    await flush();

    expect(hydrate).toHaveBeenCalledWith(expect.anything(), { force: true });
    expect(store.internal_dispatchMessage).toHaveBeenCalledWith(
      { id: 'member-msg-2', type: 'updateMessage', value: { content: 'after script' } },
      expect.anything(),
    );
  });

  it('retire() completes a member op whose own terminal never arrived (G-12)', () => {
    const store = createStore({
      [bucketKey]: [{ content: '', id: 'member-msg', role: 'assistant' }],
    });
    const handler = createGatewayMemberStreamHandler(
      () => store,
      handlerParams(vi.fn().mockResolvedValue(undefined)),
    );

    handler(makeEvent('stream_start', { assistantMessage: { id: 'member-msg' } }));
    (handler as any).retire?.();

    expect(store.completeOperation).toHaveBeenCalledWith('local-member-op');
  });
});

describe('createGatewayMemberRegistry', () => {
  it('coalesces forced hydrations into one trailing read and repaints live members', async () => {
    const dbMessagesMap: Record<string, any[]> = {};
    const store = createStore(dbMessagesMap);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMessages = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate;
        return [{ content: '', id: 'member-msg', role: 'assistant' }];
      })
      .mockResolvedValue([{ content: '', id: 'member-msg', role: 'assistant' }]);
    (store as any).replaceMessages = vi.fn((messages: any[], { context: ctx }: any) => {
      dbMessagesMap[keyOf(ctx)] = messages;
    });

    const registry = createGatewayMemberRegistry(() => store, {
      context,
      fetchMessages,
      parentOperationId: 'owner-op',
    });
    const handler = registry.createMemberHandler('server-member-op');

    handler(makeEvent('stream_start', { assistantMessage: { id: 'member-msg' } }));
    handler(makeEvent('stream_chunk', { chunkType: 'text', content: 'hi' }));
    handler(makeEvent('tool_end', {}));
    handler(makeEvent('tool_end', {}));
    release();
    await flush();
    await flush();
    await flush();

    // The initial read plus ONE trailing read for the two tool_end bursts.
    expect(fetchMessages).toHaveBeenCalledTimes(2);
    // The accumulated text was repainted once the row landed.
    expect(store.internal_dispatchMessage).toHaveBeenCalledWith(
      { id: 'member-msg', type: 'updateMessage', value: { content: 'hi' } },
      expect.anything(),
    );

    registry.retireAll();
    expect(store.completeOperation).toHaveBeenCalledWith('local-member-op');
  });
});
