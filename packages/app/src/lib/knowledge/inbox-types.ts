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
}

export type KnowledgePublishResult = {
  id?: string
  path: string
  status?: string
  overwritten?: boolean
  teamSync?: string
  teamSyncNote?: string
}
