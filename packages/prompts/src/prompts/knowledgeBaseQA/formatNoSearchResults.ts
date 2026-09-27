/**
 * Format prompt when no search results found using XML structure
 */
export const promptNoSearchResults = (query: string): string => {
  return `<knowledge_base_search_results query="${query}" totalCount="0">
<instruction>No relevant files found in the knowledge base for this query.</instruction>
<suggestions>
<suggestion>Try rephrasing your question with different keywords</suggestion>
<suggestion>Check if the information exists in the uploaded documents</suggestion>
<suggestion>Ask the user to provide more context or upload relevant documents</suggestion>
</suggestions>
</knowledge_base_search_results>`;
};

/**
 * Format prompt when the search had no knowledge base to cover at all — the
 * agent (and its task's project, if any) has no enabled knowledge base
 * attached. Distinct from `promptNoSearchResults` so the model does not read
 * an empty scope as "the content does not exist" (e.g. right after it created
 * a knowledge base and documents that are not attached to this agent).
 */
export const promptNoKnowledgeBaseInScope = (query: string): string => {
  return `<knowledge_base_search_results query="${query}" totalCount="0" searchedKnowledgeBases="0">
<instruction>No knowledge base is attached to this agent, so searchKnowledgeBase had nothing to search. This does NOT mean the content does not exist — knowledge bases and documents you created are not searchable until the knowledge base is attached to this agent.</instruction>
<suggestions>
<suggestion>If you already know the document or file IDs (e.g. from createDocument), call readKnowledge with those IDs directly</suggestion>
<suggestion>Call listKnowledgeBases and viewKnowledgeBase to browse a knowledge base's items, then readKnowledge the ones you need</suggestion>
<suggestion>Ask the user to attach the knowledge base to this agent to make it searchable</suggestion>
</suggestions>
</knowledge_base_search_results>`;
};
