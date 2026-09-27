// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { messagePlugins, messages, topics, users } from '@/database/schemas';

import { AgentRuntimeService } from '../AgentRuntimeService';

vi.mock('@/libs/trusted-client', () => ({
  generateTrustedClientToken: vi.fn().mockReturnValue(undefined),
  getTrustedClientTokenForSession: vi.fn().mockResolvedValue(undefined),
  isTrustedClientEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('@/server/modules/AgentRuntime/factory', async () => {
  const { InMemoryAgentStateManager } =
    await import('@/server/modules/AgentRuntime/InMemoryAgentStateManager');
  const { InMemoryStreamEventManager } =
    await import('@/server/modules/AgentRuntime/InMemoryStreamEventManager');
  return {
    createAgentStateManager: () => new InMemoryAgentStateManager(),
    createStreamEventManager: () => new InMemoryStreamEventManager(),
    isRedisAvailable: () => false,
  };
});

vi.mock('@/server/modules/AgentRuntime/redis', () => ({
  createAgentRuntimeRedisClient: vi.fn().mockReturnValue(null),
  getAgentRuntimeRedisClient: vi.fn().mockReturnValue(null),
}));

vi.mock('@/server/services/queue', () => ({
  QueueService: vi.fn().mockImplementation(function () {
    return { getImpl: vi.fn().mockReturnValue(null), scheduleMessage: vi.fn() };
  }),
}));

const db = await getTestDB();
const userId = 'barrier-user';

/** One `speak` tool row: `content` empty + `pending` state = still waiting. */
const insertToolRow = async (params: {
  content: string;
  createdAt: Date;
  id: string;
  status: 'completed' | 'pending';
  threadId?: string;
  topicId: string;
}) => {
  await db.insert(messages).values({
    content: params.content,
    createdAt: params.createdAt,
    id: params.id,
    role: 'tool',
    threadId: params.threadId,
    topicId: params.topicId,
    userId,
  });
  await db.insert(messagePlugins).values({
    apiName: 'speak',
    id: params.id,
    identifier: 'lobe-group-management',
    state: { status: params.status },
    toolCallId: 'call_1',
    userId,
  });
};

// G-18: providers that mint deterministic tool-call ids (`call_1`, Kimi's
// `functions.x:0`) reuse them across turns and topics. The barrier looked the
// id up globally, matched an old completed row in another topic, and resumed
// the supervisor at park time — before its member had even started.
describe('AgentRuntimeService async-tool barrier', () => {
  const service = new AgentRuntimeService(db, userId);
  const barrier = (topicId: string) =>
    (service as any).allPendingToolsFulfilled([{ id: 'call_1' }], undefined, { topicId });

  beforeEach(async () => {
    await db.delete(users);
    await db.insert(users).values({ id: userId });
    await db.insert(topics).values([
      { id: 'tpc-old', userId },
      { id: 'tpc-current', userId },
    ]);
  });

  it('ignores a completed row with the same tool_call_id in another topic', async () => {
    await insertToolRow({
      content: 'Agent Carol responded in the group.',
      createdAt: new Date('2026-09-27T06:00:00Z'),
      id: 'msg-old-speak',
      status: 'completed',
      topicId: 'tpc-old',
    });
    await insertToolRow({
      content: '',
      createdAt: new Date('2026-09-27T06:22:25Z'),
      id: 'msg-current-speak',
      status: 'pending',
      topicId: 'tpc-current',
    });

    expect(await barrier('tpc-current')).toBe(false);
  });

  it('checks the newest row when the id repeats inside the same topic', async () => {
    await insertToolRow({
      content: 'Agent Carol responded in the group.',
      createdAt: new Date('2026-09-27T06:00:00Z'),
      id: 'msg-turn1-speak',
      status: 'completed',
      topicId: 'tpc-current',
    });
    await insertToolRow({
      content: '',
      createdAt: new Date('2026-09-27T06:22:25Z'),
      id: 'msg-turn2-speak',
      status: 'pending',
      topicId: 'tpc-current',
    });

    expect(await barrier('tpc-current')).toBe(false);
  });

  it('passes once the parked turn’s own tool row is fulfilled', async () => {
    await insertToolRow({
      content: '',
      createdAt: new Date('2026-09-27T06:00:00Z'),
      id: 'msg-old-pending',
      status: 'pending',
      topicId: 'tpc-old',
    });
    await insertToolRow({
      content: 'Agent Carol responded in the group.',
      createdAt: new Date('2026-09-27T06:22:25Z'),
      id: 'msg-current-speak',
      status: 'completed',
      topicId: 'tpc-current',
    });

    expect(await barrier('tpc-current')).toBe(true);
  });
});
