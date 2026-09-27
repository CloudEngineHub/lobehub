import { mutate } from '@/libs/swr';
import { portalKeys } from '@/libs/swr/keys';

import { agentDocumentSWRKeys, documentSWRKeys, notebookSWRKeys } from './swrKeys';

export type DocumentMutationCause =
  'agent-document' | 'document-service' | 'notebook' | 'page-title';

export interface InvalidateDocumentMutationParams {
  agentDocumentId?: string;
  agentId?: string;
  cause?: DocumentMutationCause;
  documentId?: string;
  refreshDocumentEditor?: boolean;
  refreshPageDocuments?: boolean;
  topicId?: string;
}

type AgentDocumentsInvalidationListener = (agentId: string) => void;

const agentDocumentsInvalidationListeners = new Set<AgentDocumentsInvalidationListener>();

/**
 * Subscribe to agent document list invalidations. The agent store registers here
 * (it cannot be imported from this module without a cycle) to drop the cached
 * list the chat runtime uses for `<agent_documents_index>`.
 */
export const onAgentDocumentsInvalidated = (listener: AgentDocumentsInvalidationListener) => {
  agentDocumentsInvalidationListeners.add(listener);
  return () => {
    agentDocumentsInvalidationListeners.delete(listener);
  };
};

export const invalidateDocumentMutation = async (
  params: InvalidateDocumentMutationParams,
): Promise<void> => {
  const {
    agentDocumentId,
    agentId,
    documentId,
    refreshDocumentEditor,
    refreshPageDocuments,
    topicId,
  } = params;
  const revalidations: Promise<unknown>[] = [];

  if (documentId) {
    if (refreshDocumentEditor !== false) {
      revalidations.push(mutate(documentSWRKeys.editor(documentId)));
    }
    revalidations.push(mutate(documentSWRKeys.pageDetail(documentId)));
    revalidations.push(mutate(documentSWRKeys.pageMeta(documentId)));
    revalidations.push(mutate(portalKeys.documentHeader(documentId)));
  }

  if (documentId || refreshPageDocuments) {
    revalidations.push(mutate(documentSWRKeys.pageDocuments()));
  }

  if (topicId) {
    revalidations.push(mutate(notebookSWRKeys.documents(topicId)));
  }

  if (agentId) {
    // The chat runtime builds `<agent_documents_index>` from the agent store's
    // cached list, not from SWR.
    for (const listener of agentDocumentsInvalidationListeners) listener(agentId);
    revalidations.push(mutate(agentDocumentSWRKeys.documents(agentId)));
    // Prefix match so every `agent:documentsList` variant (full list + the
    // `non-web` hot-path variant, in both personal and workspace scope where the
    // workspace id is appended) revalidates together. The scoped `mutate` passes
    // function keys through untouched, so this predicate sees the real cache key.
    revalidations.push(
      mutate((key) => Array.isArray(key) && key[0] === 'agent:documentsList' && key[1] === agentId),
    );
  }

  if (agentId && agentDocumentId) {
    revalidations.push(mutate(agentDocumentSWRKeys.readDocument(agentId, agentDocumentId)));
  }

  const results = await Promise.allSettled(revalidations);

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[DocumentInvalidation] Failed to revalidate document cache:', result.reason);
    }
  }
};
