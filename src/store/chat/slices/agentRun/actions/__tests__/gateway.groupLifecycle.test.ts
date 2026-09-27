// Loaded first, as in gateway.test.ts: it settles the chat-store module cycle
// before the transport module is evaluated.
import '@/store/agentGroup';

import type { AgentStreamEvent } from '@lobechat/agent-gateway-client';
import { AgentStreamClient } from '@lobechat/agent-gateway-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ConstVersion from '@/const/version';
import { aiAgentService } from '@/services/aiAgent';
import { messageService } from '@/services/message';
import { topicService } from '@/services/topic';

import { GatewayActionImpl } from '../transports/gateway/gateway';

vi.mock('@/services/aiAgent', () => ({
  aiAgentService: {
    execAgentTask: vi.fn(),
    interruptTask: vi.fn(),
    refreshGatewayToken: vi.fn(),
  },
}));

vi.mock('@/services/shareChat', () => ({
  shareChatService: {
    execAgentTask: vi.fn(),
    interruptTask: vi.fn(),
    refreshGatewayToken: vi.fn(),
  },
}));

vi.mock('@/services/message', () => ({
  messageService: {
    getMessages: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/services/topic', () => ({
  topicService: {
    settleRunningOperation: vi.fn().mockResolvedValue(undefined),
    updateTopicMetadata: vi.fn().mockResolvedValue(undefined),
  },
}));

const moveChatContextSelections = vi.hoisted(() => vi.fn());
vi.mock('@/store/file/store', () => ({
  getFileStoreState: () => ({ moveChatContextSelections }),
}));

const mockUserDefaultConfig = vi.hoisted(() => ({
  disableGatewayMode: undefined as boolean | undefined,
}));
const mockToolInterventionConfig = vi.hoisted(() => ({
  allowList: [] as string[],
  approvalMode: 'manual' as 'allow-list' | 'auto-run' | 'manual',
}));
const mockUserState = vi.hoisted(() => ({
  profile: { id: 'user-1' },
  workspaceUserPreference: { agentDeviceOverrides: {} as Record<string, any> },
}));

vi.mock('@/store/user', () => ({
  useUserStore: {
    getState: vi.fn(() => mockUserState),
  },
}));

vi.mock('@/store/user/selectors', () => ({
  // Lab flag off: this suite pins the v1 per-operation socket path.
  labPreferSelectors: { enableGatewayMux: () => false },
  settingsSelectors: {
    defaultAgentConfig: () => ({
      chatConfig: { disableGatewayMode: mockUserDefaultConfig.disableGatewayMode },
    }),
  },
  toolInterventionSelectors: {
    allowList: () => mockToolInterventionConfig.allowList,
    approvalMode: () => mockToolInterventionConfig.approvalMode,
  },
  userProfileSelectors: {
    userId: (state: typeof mockUserState) => state.profile.id,
  },
}));

// ─── Local-device activation (本机) test seams ───
// Controlled per-test; default off so the rest of the suite runs as web (no
// device resolution, no electron IPC).
const mockEnv = vi.hoisted(() => ({ isDesktop: false }));
const mockGateway = vi.hoisted(() => ({ getDeviceInfo: vi.fn() }));
// Effective runtime mode === 'local' (what isLocalSystemEnabledById returns)
// and chat mode (what isChatModeById returns).
const mockRuntime = vi.hoisted(() => ({ isChatMode: false, isLocal: false }));
const mockAgentStore = vi.hoisted(() => ({
  state: { activeAgentId: undefined, agentMap: {} } as any,
}));

vi.mock('@/const/version', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstVersion>();
  return {
    ...actual,
    get isDesktop() {
      return mockEnv.isDesktop;
    },
  };
});

vi.mock('@/services/electron/gatewayConnection', () => ({
  gatewayConnectionService: { getDeviceInfo: mockGateway.getDeviceInfo },
}));

vi.mock('@/store/agent', () => ({ getAgentStoreState: () => mockAgentStore.state }));

vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: {
    getAgencyConfigById: (agentId: string) => (state: any) =>
      state.agentMap?.[agentId]?.agencyConfig,
    getAgentById: (agentId: string) => (state: any) => state.agentMap?.[agentId],
  },
  agentSelectors: { currentAgentWorkingDirectory: () => () => undefined },
  chatConfigByIdSelectors: {
    getChatConfigById: (agentId: string) => (state: any) =>
      state.agentMap?.[agentId]?.chatConfig ?? {},
    isChatModeById: () => () => mockRuntime.isChatMode,
    isLocalSystemEnabledById: () => () => mockRuntime.isLocal,
  },
}));

// ─── Mock Client Factory ───

function createMockClient(): any {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();

  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    emitEvent(event: string, ...args: any[]) {
      listeners.get(event)?.forEach((listener) => listener(...args));
    },
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
    }),
    reconnect: vi.fn(async () => {}),
    sendToolResult: vi.fn(() => true),
    updateToken: vi.fn(),
  };
}

// ─── Group-run lifecycle regressions (T-505: G-12 / G-13 / G-14 / G-15) ───

const SERVER_OP = 'server-sup-op';
const GROUP_CONTEXT = {
  agentId: 'sup-agent',
  groupId: 'group-1',
  scope: 'group' as const,
  threadId: null,
  topicId: 'topic-1',
};

const execResult = (overrides: Record<string, unknown> = {}) => ({
  agentId: 'sup-agent',
  assistantMessageId: 'ast-1',
  autoStarted: true,
  createdAt: new Date().toISOString(),
  // A native server run (not an external CLI producer).
  heteroType: null,
  message: 'ok',
  operationId: SERVER_OP,
  status: 'created',
  success: true,
  timestamp: new Date().toISOString(),
  token: 'test-token',
  topicId: 'topic-1',
  userMessageId: 'usr-1',
  ...overrides,
});

/**
 * A store with just enough of the chat store for `executeGatewayAgent` and the
 * shared run lifecycle to run end-to-end against a mocked socket.
 */
const setupRun = (stateOverrides: Record<string, any> = {}) => {
  let opSeq = 0;
  const connectToGateway = vi.fn();
  const completeOperation = vi.fn();
  const internalPinTopicStatus = vi.fn();
  const internalDispatchTopic = vi.fn();
  const drainQueuedMessages = vi.fn(() => [] as any[]);
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const startOperation = vi.fn(() => ({ operationId: `local-op-${++opSeq}` }));
  const state: Record<string, any> = {
    activeAgentId: 'sup-agent',
    activeGroupId: 'group-1',
    activeTopicId: 'topic-1',
    dbMessagesMap: {},
    gatewayConnections: {},
    messagesMap: {},
    operations: {},
    topicDataMap: {},
    ...stateOverrides,
  };
  const set = vi.fn((updater: any) => {
    if (typeof updater === 'function') Object.assign(state, updater(state));
    else Object.assign(state, updater);
  });
  const get = vi.fn(() => ({
    ...state,
    associateMessageWithOperation: vi.fn(),
    completeOperation,
    connectToGateway,
    drainQueuedMessages,
    internal_dispatchMessage: vi.fn(),
    internal_dispatchTopic: internalDispatchTopic,
    internal_toggleToolCallingStreaming: vi.fn(),
    internal_pinTopicStatus: internalPinTopicStatus,
    markTopicUnread: vi.fn(),
    moveQueuedMessages: vi.fn(),
    moveVoiceMessages: vi.fn(),
    onOperationCancel: vi.fn(),
    refreshThreads: vi.fn().mockResolvedValue(undefined),
    replaceMessages: vi.fn(),
    sendMessage,
    startOperation,
    updateOperationMetadata: vi.fn(),
    updateTopicStatus: vi.fn(),
  })) as any;

  (globalThis as any).window = {
    global_serverConfigStore: {
      getState: () => ({ serverConfig: { agentGatewayUrl: 'https://gateway.test.com' } }),
    },
  };

  const action = new GatewayActionImpl(set as any, get, undefined);
  action.createClient = vi.fn(() => createMockClient());

  return {
    action,
    completeOperation,
    connectToGateway,
    drainQueuedMessages,
    internalDispatchTopic,
    internalPinTopicStatus,
    sendMessage,
    startOperation,
    state,
  };
};

const memberEvent = (type: string, data: unknown, operationId = 'server-member-op') =>
  ({ data, operationId, stepIndex: 0, timestamp: Date.now(), type }) as AgentStreamEvent;

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('GatewayActionImpl — group run lifecycle', () => {
  beforeEach(() => {
    vi.mocked(topicService.settleRunningOperation).mockResolvedValue(undefined as never);
    vi.mocked(messageService.getMessages).mockResolvedValue([]);
    mockAgentStore.state = { activeAgentId: undefined, agentMap: {} };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).window;
  });

  it('retires a member op still running when the supervisor session completes (G-12)', async () => {
    const run = setupRun();
    vi.mocked(aiAgentService.execAgentTask).mockResolvedValue(execResult() as any);

    await run.action.executeGatewayAgent({ context: GROUP_CONTEXT, message: 'hi' });
    const { onEvent, onSessionComplete } = run.connectToGateway.mock.calls[0][0];

    // A member starts streaming over the supervisor's socket, then the socket
    // closes before that member's own terminal is delivered.
    onEvent(memberEvent('stream_start', { assistantMessage: { id: 'member-msg' } }));
    const memberOpId = run.startOperation.mock.results.at(-1)!.value.operationId;
    run.completeOperation.mockClear();

    onSessionComplete({ succeeded: true, terminalReceived: true });

    expect(run.completeOperation).toHaveBeenCalledWith(memberOpId);
  });

  it('retires the running status of a new topic that never had a local marker (G-13)', async () => {
    // A brand-new topic: the row exists (pinned `running` at run start) but the
    // optimistic marker was never written because there was no stale one.
    const run = setupRun({
      topicDataMap: {
        'group_agent_group-1_sup-agent': {
          items: [{ id: 'topic-1', metadata: {}, status: 'running' }],
        },
      },
    });
    vi.mocked(aiAgentService.execAgentTask).mockResolvedValue(execResult() as any);

    await run.action.executeGatewayAgent({ context: GROUP_CONTEXT, message: 'hi' });
    const { onSessionComplete } = run.connectToGateway.mock.calls[0][0];
    run.internalPinTopicStatus.mockClear();

    onSessionComplete({ succeeded: true, terminalReceived: true });

    expect(run.internalPinTopicStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', topicId: 'topic-1' }),
    );
  });

  it('leaves a newer live run on the same topic alone (G-13)', async () => {
    const run = setupRun({
      operations: {
        'other-op': {
          context: { topicId: 'topic-1' },
          metadata: { serverOperationId: 'server-other-op' },
          status: 'running',
          type: 'execServerAgentRuntime',
        },
      },
      topicDataMap: {
        'group_agent_group-1_sup-agent': {
          items: [{ id: 'topic-1', metadata: {}, status: 'running' }],
        },
      },
    });
    vi.mocked(aiAgentService.execAgentTask).mockResolvedValue(execResult() as any);

    await run.action.executeGatewayAgent({ context: GROUP_CONTEXT, message: 'hi' });
    const { onSessionComplete } = run.connectToGateway.mock.calls[0][0];
    run.internalPinTopicStatus.mockClear();

    onSessionComplete({ succeeded: true, terminalReceived: true });

    expect(run.internalPinTopicStatus).not.toHaveBeenCalled();
  });

  it('drains queued follow-ups when the session ends without a terminal event (G-15)', async () => {
    const run = setupRun();
    run.drainQueuedMessages.mockReturnValue([
      { content: '[STEER] 追加：请用中文', createdAt: Date.now(), files: [], id: 'q-1' },
    ]);
    vi.mocked(aiAgentService.execAgentTask).mockResolvedValue(execResult() as any);

    await run.action.executeGatewayAgent({ context: GROUP_CONTEXT, message: 'hi' });
    const { onSessionComplete } = run.connectToGateway.mock.calls[0][0];

    // The terminal agent event was lost; the gateway reports a completed op.
    onSessionComplete({
      authFailed: false,
      completion: { source: 'resume_status', status: 'completed' },
      succeeded: false,
      terminalReceived: false,
    });
    await flush();

    expect(run.drainQueuedMessages).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 150));
    expect(run.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: '[STEER] 追加：请用中文' }),
    );
  });

  it('reconnects a group run into the group bucket (G-14)', async () => {
    const run = setupRun();
    vi.mocked(aiAgentService.refreshGatewayToken).mockResolvedValue({ token: 't' } as any);

    await (run.action.reconnectToGatewayOperation as any)({
      agentId: 'sup-agent',
      assistantMessageId: 'ast-1',
      groupId: 'group-1',
      heteroType: null,
      operationId: SERVER_OP,
      topicId: 'topic-1',
    });

    expect(run.startOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ groupId: 'group-1', scope: 'group' }),
      }),
    );

    // Members forwarded onto the reconnected socket hydrate the group bucket.
    const { onEvent } = run.connectToGateway.mock.calls[0][0];
    onEvent(memberEvent('stream_start', { assistantMessage: { id: 'member-msg' } }));
    await flush();
    expect(messageService.getMessages).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'group-1', topicId: 'topic-1' }),
    );
  });

  it("clears a reconnected builder run's marker in the builder's own topic bucket (G-14)", async () => {
    // The builder panel lives on the group's profile page, so `activeGroupId`
    // is set — but the builder's topics belong to `agent_<builder>`.
    const run = setupRun({
      activeTopicId: 'tpc_builder',
      topicDataMap: {
        agent_agt_builder: {
          items: [
            {
              id: 'tpc_builder',
              metadata: { runningOperation: { operationId: 'op_builder' } },
              status: 'running',
            },
          ],
        },
      },
    });
    vi.mocked(aiAgentService.refreshGatewayToken).mockResolvedValue({ token: 't' } as any);

    await (run.action.reconnectToGatewayOperation as any)({
      agentId: 'agt_builder',
      assistantMessageId: 'ast-b',
      heteroType: null,
      operationId: 'op_builder',
      scope: 'group_agent_builder',
      topicId: 'tpc_builder',
    });
    const { onSessionComplete } = run.connectToGateway.mock.calls[0][0];
    onSessionComplete({ succeeded: true, terminalReceived: true });

    expect(run.internalDispatchTopic).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agt_builder',
        id: 'tpc_builder',
        scope: 'agent',
        value: { metadata: { runningOperation: null } },
      }),
    );
    expect(run.internalPinTopicStatus).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'agent', status: 'active', topicId: 'tpc_builder' }),
    );
  });

  it('settles a group run finished off-screen as unread despite an old gateway echoing the member end (G-19)', async () => {
    // Real transport client over a fake socket: the gateway (pre-fix build)
    // answers a member's mirrored `agent_runtime_end` with `session_complete`.
    const sockets: FakeSocket[] = [];
    vi.stubGlobal(
      'WebSocket',
      Object.assign(
        class extends FakeSocket {
          constructor(url: string) {
            super(url);
            sockets.push(this);
          }
        },
        { CLOSED: 3, CLOSING: 2, CONNECTING: 0, OPEN: 1 },
      ),
    );

    // The user switched to another topic while the group run was going.
    const run = setupRun({ activeTopicId: 'topic-other' });
    run.connectToGateway.mockImplementation((params: any) => run.action.connectToGateway(params));
    run.action.createClient = (options) =>
      new AgentStreamClient({ ...options, autoReconnect: false });
    vi.mocked(aiAgentService.execAgentTask).mockResolvedValue(execResult() as any);
    vi.mocked(topicService.settleRunningOperation).mockClear();

    await run.action.executeGatewayAgent({ context: GROUP_CONTEXT, message: 'hi' });
    await new Promise((r) => setTimeout(r, 5));
    const ws = sockets.at(-1)!;
    ws.receive({ type: 'auth_success' });

    // Member finishes (old server shape) → old gateway ends "the session".
    ws.receive({
      event: memberEvent('agent_runtime_end', { reason: 'done' }),
      id: '1',
      type: 'agent_event',
    });
    ws.receive({ id: '2', type: 'session_complete' });
    await flush();

    // Nothing may settle the topic yet: the supervisor is still running.
    expect(topicService.settleRunningOperation).not.toHaveBeenCalled();

    // The supervisor's own reply and terminal arrive on the same socket.
    ws.receive({
      event: {
        data: { reason: 'done' },
        operationId: SERVER_OP,
        stepIndex: 2,
        timestamp: Date.now(),
        type: 'agent_runtime_end',
      },
      id: '3',
      type: 'agent_event',
    });
    await vi.waitFor(() => expect(topicService.settleRunningOperation).toHaveBeenCalled());

    expect(topicService.settleRunningOperation).toHaveBeenCalledTimes(1);
    expect(topicService.settleRunningOperation).toHaveBeenCalledWith(
      'topic-1',
      SERVER_OP,
      'unread',
    );
    vi.unstubAllGlobals();
  });
});

class FakeSocket {
  readyState = 0;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;

  constructor(public url: string) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  receive(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
