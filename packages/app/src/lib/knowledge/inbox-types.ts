export type KnowledgeSuggestionKind = 'decision' | 'fact' | 'followup'

export type KnowledgeSuggestion = {
  id: string
  kind: KnowledgeSuggestionKind
  text: string
}

export type KnowledgeCandidateSource =
  | 'session-header'
  | 'agent-propose'
  | 'message'
  | 'document'
  | 'unknown'

export type KnowledgeCandidateStatus = 'pending' | 'published' | 'discarded'

export type KnowledgeCandidate = {
  id: string
  teamId: string
  sessionId: string
  title: string
  body: string
  suggestedPath: string
  source: KnowledgeCandidateSource
  createdAt: string
  status: KnowledgeCandidateStatus
  publishedPath?: string
  summary?: string
  suggestions?: KnowledgeSuggestion[]
  /** Sync key of the 资料库 file this draft was distilled from, e.g. `documents/hr/合同.pdf`. */
  documentPath?: string
}

export type KnowledgePublishResult = {
  id?: string
  path: string
  status?: string
  overwritten?: boolean
  teamSync?: string
  teamSyncNote?: string
}
