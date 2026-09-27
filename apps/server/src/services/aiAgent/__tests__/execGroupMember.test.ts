import { ThreadStatus, ThreadType } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecGroupMemberParams } from '@/server/services/agentRuntime/types';

import { AiAgentService } from '../index';

// Mock trusted client to avoid server-side env access
vi.mock('@/libs/trusted-client', () => ({
  generateTrustedClientToken: vi.fn().mockReturnValue(undefined),
  getTrustedClientTokenForSession: vi.fn().mockResolvedValue(undefined),
  isTrustedClientEnabled: vi.fn().mockReturnValue(false),
}));

// Mock ThreadModel
const mockThreadModel = {
  claimForRun: vi.fn(),
  create: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
};

const mockOperationFindById = vi.fn();
const mockFindMessagePlugin = vi.fn();

vi.mock('@/database/models/thread', () => ({
  ThreadModel: vi.fn().mockImplementation(function () {
    return mockThreadModel;
  }),
}));

vi.mock('@/database/models/agentOperation', () => ({
  AgentOperationModel: vi.fn().mockImplementation(function () {
    return {
      findById: mockOperationFindById,
    };
  }),
}));

// Mock other models
vi.mock('@/database/models/agent', () => ({
  AgentModel: vi.fn().mockImplementation(function () {
    return {
      getAgentConfig: vi.fn(),
      queryAgents: vi.fn().mockResolvedValue([]),
    };
  }),
}));

vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn().mockImplementation(function () {
    return {
      create: vi.fn().mockResolvedValue({ id: 'msg-1' }),
      findMessagePlugin: mockFindMessagePlugin,
      getLatestNonToolMessageId: vi.fn().mockResolvedValue(undefined),
      getLatestSpineMessageId: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    };
  }),
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn().mockImplementation(function () {
    return {
      query: vi.fn().mockResolvedValue([]),
    };
  }),
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(function () {
    return {
      releaseTaskCallbackReservation: vi.fn().mockResolvedValue(undefined),
      tryReserveTaskCallback: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockResolvedValue({ id: 'topic-1' }),
      findById: vi.fn().mockResolvedValue(null),
    };
  }),
}));

// Mock AgentService
vi.mock('@/server/services/agent', () => ({
  AgentService: vi.fn().mockImplementation(function () {
    return {
      getAgentConfig: vi.fn().mockResolvedValue({
        chatConfig: {},
        id: 'agent-1',
        model: 'gpt-4',
        plugins: [],
        provider: 'openai',
      }),
    };
  }),
}));

const mockScheduleGroupMemberTimeout = vi.fn();

// Mock AgentRuntimeService
vi.mock('@/server/services/agentRuntime', () => ({
  AgentRuntimeService: vi.fn().mockImplementation(function () {
    return {
      createOperation: vi.fn().mockResolvedValue({
        autoStarted: true,
        messageId: 'queue-msg-1',
        operationId: 'op-123',
        success: true,
      }),
      scheduleGroupMemberTimeout: mockScheduleGroupMemberTimeout,
    };
  }),
}));

// Mock MarketService
vi.mock('@/server/services/market', () => ({
  MarketService: vi.fn().mockImplementation(function () {
    return {
      getLobehubSkillManifests: vi.fn().mockResolvedValue([]),
    };
  }),
}));

// Mock ComposioService
vi.mock('@/server/services/composio', () => ({
  ComposioService: vi.fn().mockImplementation(function () {
    return {
      getComposioManifests: vi.fn().mockResolvedValue([]),
    };
  }),
}));

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: vi.fn(),
}));

const execAgentResult = {
  agentId: 'agt_carol',
  assistantMessageId: 'assistant-msg-1',
  autoStarted: true,
  createdAt: new Date().toISOString(),
  message: 'Agent operation created successfully',
  messageId: 'queue-msg-1',
  operationId: 'op-member',
  status: 'created',
  success: true,
  timestamp: new Date().toISOString(),
  topicId: 'topic-1',
  userMessageId: 'user-msg-1',
};

const memberParams = (overrides: Partial<ExecGroupMemberParams> = {}): ExecGroupMemberParams => ({
  agentId: 'agt_carol',
  anchorMessageId: 'anchor-1',
  expectedMembers: 1,
  groupId: 'group-1',
  groupToolMessageId: 'anchor-1',
  instruction: 'Run the script',
  mode: 'in_group',
  onComplete: 'resume',
  parentOperationId: 'op-sup',
  supervisorMessageId: 'sup-msg-1',
  topicId: 'topic-1',
  ...overrides,
});

describe('AiAgentService.execGroupMember', () => {
  let service: AiAgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockThreadModel.create.mockResolvedValue({
      agentId: 'agt_carol',
      groupId: 'group-1',
      id: 'thread-123',
      status: ThreadStatus.Active,
      topicId: 'topic-1',
      type: ThreadType.Isolation,
    });
    mockThreadModel.update.mockResolvedValue({});
    mockOperationFindById.mockResolvedValue({ trigger: 'chat' });
    service = new AiAgentService({} as any, 'test-user-id');
  });

  // G-05: a member answers to the approval mode the user picked for the turn.
  // A hard-coded headless let a member silently run a `humanIntervention:
  // 'required'` tool (execScript) that the supervisor itself had to ask for.
  describe('approval policy', () => {
    const manual = { approvalMode: 'manual' } as const;

    it.each(['in_group', 'isolated'] as const)(
      'forwards the supervisor approval mode to a %s member',
      async (mode) => {
        const execAgentSpy = vi.spyOn(service, 'execAgent').mockResolvedValue(execAgentResult);

        await service.execGroupMember(memberParams({ mode, userInterventionConfig: manual }));

        expect(execAgentSpy).toHaveBeenCalledWith(
          expect.objectContaining({ userInterventionConfig: manual }),
        );
      },
    );

    it('keeps headless when the supervisor carries no approval policy', async () => {
      const execAgentSpy = vi.spyOn(service, 'execAgent').mockResolvedValue(execAgentResult);

      await service.execGroupMember(memberParams());

      expect(execAgentSpy).toHaveBeenCalledWith(
        expect.objectContaining({ userInterventionConfig: { approvalMode: 'headless' } }),
      );
    });
  });
});
