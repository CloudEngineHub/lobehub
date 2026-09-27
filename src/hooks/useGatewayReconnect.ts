import useSWR from 'swr';

import { gatewayKeys } from '@/libs/swr/keys';
import { useChatStore } from '@/store/chat';
import { topicSelectors } from '@/store/chat/selectors';
import { useServerConfigStore } from '@/store/serverConfig';
import { isTrpcErrorCode } from '@/utils/trpcError';

interface RunningOperation {
  assistantMessageId: string;
  heteroType?: string | null;
  operationId: string;
  scope?: string;
  startedAt?: string;
  threadId?: string | null;
}

/**
 * Auto-reconnect to a running Gateway operation on the given topic.
 *
 * The caller sources `runningOperation` itself — the chat-store topic map
 * (main agent) and the task-detail activity (task drawer) live in different
 * stores, so this hook stays source-agnostic.
 *
 * Reconnect only depends on whether the server has a Gateway URL configured;
 * the user's lab toggle controls *new* requests, not resuming an op that's
 * already running on the Gateway.
 *
 * SWR key is the operationId, so the same operation deduplicates and only
 * one reconnect attempt fires per op.
 */
export const useGatewayReconnect = (
  topicId: string | null | undefined,
  runningOperation: RunningOperation | null | undefined,
  /**
   * Agent owning the rendered conversation. Required off the agent route (task
   * detail / home run drawer), where the chat store's `activeAgentId` is stale or
   * unset — see `reconnectToGatewayOperation`.
   */
  agentId?: string,
  /**
   * Present on the agent-share visitor surface. Routes the reconnect's token
   * refresh and cancellation through the share-authorized `shareChat`
   * procedures instead of the owner-scoped ones — see
   * `reconnectToGatewayOperation`'s param JSDoc.
   */
  agentShareId?: string,
  /**
   * Conversation shape of a surface that is not a plain agent chat. A group chat
   * passes its `groupId` so the reconnected supervisor stream — and the member
   * events forwarded onto it — land in the group's bucket; the group builder
   * passes its `scope` so the builder panel's bucket is the one that updates.
   */
  conversation?: { groupId?: string; scope?: string },
) => {
  const agentGatewayUrl = useServerConfigStore((s) => s.serverConfig.agentGatewayUrl);

  useSWR(
    runningOperation && topicId && agentGatewayUrl
      ? gatewayKeys.reconnect(runningOperation.operationId)
      : null,
    async () => {
      if (!runningOperation || !topicId) return;

      await useChatStore.getState().reconnectToGatewayOperation({
        agentId,
        agentShareId,
        assistantMessageId: runningOperation.assistantMessageId,
        groupId: conversation?.groupId,
        heteroType: runningOperation.heteroType,
        operationId: runningOperation.operationId,
        scope: conversation?.scope ?? runningOperation.scope,
        startedAt: runningOperation.startedAt,
        threadId: runningOperation.threadId,
        topicId,
      });
    },
    {
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      // Never retry the stale-marker case (operation already gone → NOT_FOUND) so a
      // dead op can't loop 404s even if it escapes the fetcher-level catch; transient
      // network/server errors keep SWR's default retry so a live run still resumes.
      shouldRetryOnError: (error) => !isTrpcErrorCode(error, 'NOT_FOUND'),
    },
  );
};

/**
 * `useGatewayReconnect` for a surface whose topic lives in the chat store's
 * topic map: resume the run its `runningOperation` marker says is still going.
 *
 * The group chat and the group builder panel both need this; without it a
 * reload mid-run left them with no stream, no stop button and a stale view
 * until the next manual refresh after the run ended.
 */
export const useTopicGatewayReconnect = (
  topicId: string | null | undefined,
  agentId: string | undefined,
  conversation?: { groupId?: string; scope?: string },
) => {
  const runningOperation = useChatStore((s) =>
    topicId ? topicSelectors.getTopicById(topicId)(s)?.metadata?.runningOperation : undefined,
  );
  useGatewayReconnect(topicId, runningOperation, agentId, undefined, conversation);
};
