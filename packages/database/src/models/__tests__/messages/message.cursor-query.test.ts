// Regression + behavior tests for MessageModel.queryTopicMessagesByCursor
// (round-boundary cursor pagination — LOBE-12011, stage 2 server layer).
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../../core/getTestDB';
import { messages, topics, users } from '../../../schemas';
import type { LobeChatDatabase } from '../../../type';
import { MessageModel } from '../../message';

const serverDB: LobeChatDatabase = await getTestDB();

const userId = 'cursor-query-test';
const messageModel = new MessageModel(serverDB, userId);

beforeEach(async () => {
  await serverDB.transaction(async (trx) => {
    await trx.delete(users).where(eq(users.id, userId));
    await trx.insert(users).values([{ id: userId }]);
  });
});

afterEach(async () => {
  await serverDB.delete(users).where(eq(users.id, userId));
});

/**
 * Seed `rounds` rounds of (1 user + `stepsPerRound` assistant) as one contiguous
 * mainline parentId chain. Returns the ordered ids (oldest→newest) plus the
 * round-start user ids.
 */
const seedRounds = async (topicId: string, rounds: number, stepsPerRound: number) => {
  await serverDB.insert(topics).values([{ id: topicId, userId }]);
  const rows: any[] = [];
  const ids: string[] = [];
  const roundStarts: string[] = [];
  let seq = 0;
  let prevId: string | null = null;
  for (let r = 1; r <= rounds; r += 1) {
    const uid = `${topicId}-u${r}`;
    rows.push({
      id: uid,
      userId,
      topicId,
      role: 'user',
      parentId: prevId,
      content: `q${r}`,
      createdAt: new Date(2023, 0, 1, 0, seq),
    });
    seq += 1;
    ids.push(uid);
    roundStarts.push(uid);
    prevId = uid;
    for (let step = 1; step <= stepsPerRound; step += 1) {
      const sid = `${topicId}-a${r}-${step}`;
      rows.push({
        id: sid,
        userId,
        topicId,
        role: 'assistant',
        parentId: prevId,
        content: `a${r}.${step}`,
        createdAt: new Date(2023, 0, 1, 0, seq),
      });
      seq += 1;
      ids.push(sid);
      prevId = sid;
    }
  }
  await serverDB.insert(messages).values(rows);
  return { ids, lastId: prevId as string, roundStarts };
};

describe('MessageModel.queryTopicMessagesByCursor', () => {
  it('initial load returns the newest N rounds, round-aligned, with the final answer', async () => {
    const topicId = 't-cursor-initial';
    const { lastId } = await seedRounds(topicId, 5, 2); // 5 rounds x 3 = 15 msgs

    const page = await messageModel.queryTopicMessagesByCursor({ topicId, roundLimit: 2 });

    // Newest 2 rounds = round 4 (u4..a4-2) + round 5 (u5..a5-2) = 6 messages, asc.
    expect(page.messages).toHaveLength(6);
    expect(page.messages[0].id).toBe(`${topicId}-u4`); // round-aligned lower bound
    expect(page.messages[0].role).toBe('user');
    expect(page.messages.at(-1)!.id).toBe(lastId); // final answer present
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual({ createdAt: expect.any(String), id: `${topicId}-u4` });
  });

  it('walks older pages via nextCursor with no gaps and no splitting a round', async () => {
    const topicId = 't-cursor-walk';
    const { ids } = await seedRounds(topicId, 5, 2); // 15 msgs

    const collected: string[][] = [];
    let cursor: any = null;
    // Page backwards until exhausted.
    for (let i = 0; i < 10; i += 1) {
      const page = await messageModel.queryTopicMessagesByCursor({
        topicId,
        roundLimit: 2,
        cursor,
      });
      collected.push(page.messages.map((m) => m.id));
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      cursor = page.nextCursor;
    }

    // 5 rounds / 2 per page => pages of [round4,5], [round2,3], [round1].
    expect(collected).toHaveLength(3);
    expect(collected[2]).toHaveLength(3); // last page = round 1 only

    // Every page starts on a user message (never mid-round).
    for (const pageIds of collected) {
      expect(pageIds[0]).toMatch(/-u\d+$/);
    }

    // `collected` is newest-page-first and each page is already ascending, so
    // reversing the page order then flattening rebuilds the full transcript
    // oldest→newest. It must equal every seeded id exactly — nothing dropped in a
    // boundary gap, nothing duplicated. This is the property PR1's offset paging
    // could not hold.
    const rebuilt = [...collected].reverse().flat();
    expect(rebuilt).toEqual(ids);
    expect(new Set(rebuilt).size).toBe(ids.length);
  });

  it('returns the whole topic when it has fewer rounds than the limit', async () => {
    const topicId = 't-cursor-short';
    const { ids } = await seedRounds(topicId, 2, 2); // 6 msgs, 2 rounds

    const page = await messageModel.queryTopicMessagesByCursor({ topicId, roundLimit: 5 });

    expect(page.messages.map((m) => m.id)).toEqual(ids);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('caps the window by countBudget even when roundLimit is larger', async () => {
    const topicId = 't-cursor-budget';
    await seedRounds(topicId, 5, 0); // 5 single-message (user-only) rounds

    // Budget 3 forces at most ~3 rows despite roundLimit 10.
    const page = await messageModel.queryTopicMessagesByCursor({
      topicId,
      roundLimit: 10,
      countBudget: 3,
    });

    expect(page.messages).toHaveLength(3);
    expect(page.messages.at(-1)!.id).toBe(`${topicId}-u5`); // newest kept
    expect(page.messages[0].id).toBe(`${topicId}-u3`); // budget-capped lower bound
    expect(page.hasMore).toBe(true);
  });

  it('returns an empty page with no cursor for an empty topic', async () => {
    const topicId = 't-cursor-empty';
    await serverDB.insert(topics).values([{ id: topicId, userId }]);

    const page = await messageModel.queryTopicMessagesByCursor({ topicId });

    expect(page.messages).toHaveLength(0);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});
