import { draftFromSession } from '@/lib/knowledge/session-knowledge-draft'
import { proposeKnowledgeCandidate } from '@/lib/knowledge/inbox-client'
import { openKnowledgeReview } from '@/lib/tabs/knowledge-tabs'
import { useKnowledgeInboxStore } from '@/stores/knowledge-inbox'
import { useSessionMessageStore } from '@/stores/session-message-store'
import { useSessionListStore } from '@/stores/session-list-store'
import { useSessionStore } from '@/stores/session-store'

export async function proposeSessionToKnowledge(sessionId: string): Promise<string> {
  const messages =
    useSessionMessageStore.getState().messages[sessionId] ??
    useSessionStore.getState().messages[sessionId] ??
    []
  const title =
    useSessionListStore.getState().rows.find((row) => row.id === sessionId)?.title ??
    useSessionStore.getState().sessions.find((row) => row.id === sessionId)?.title ??
    ''
  const draft = draftFromSession({ sessionId, title, messages })
  const candidate = await proposeKnowledgeCandidate({
    title: draft.title,
    content: draft.body,
    suggestedPath: draft.suggestedPath,
    sessionId,
    source: 'session-header',
  })
  await useKnowledgeInboxStore.getState().load()
  openKnowledgeReview(candidate.id, candidate.title || draft.title)
  return candidate.id
}
