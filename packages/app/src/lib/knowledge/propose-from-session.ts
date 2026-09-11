import { distillFromSession, type SessionDraftMessage } from '@/lib/knowledge/session-knowledge-draft'
import { distillWithTeamLlm } from '@/lib/knowledge/session-knowledge-llm'
import { proposeKnowledgeCandidate } from '@/lib/knowledge/inbox-client'
import { MessageKind } from '@/lib/proto/teamclu_pb'
import { openKnowledgeReview } from '@/lib/tabs/knowledge-tabs'
import { useKnowledgeInboxStore } from '@/stores/knowledge-inbox'
import { useSessionMessageStore } from '@/stores/session-message-store'
import { useSessionListStore } from '@/stores/session-list-store'
import { useSessionParticipantStore } from '@/stores/session-participant-store'
import { useSessionStore } from '@/stores/session-store'

function toDraftMessages(
  sessionId: string,
  messages: Array<{ content?: string; kind?: number; senderActorId?: string }>,
): SessionDraftMessage[] {
  const agentIds = new Set(
    (useSessionParticipantStore.getState().participantsBySession[sessionId] ?? [])
      .filter((row) => row.isAgent)
      .map((row) => row.actorId),
  )
  return messages.map((message) => ({
    content: message.content,
    kind: message.kind,
    senderActorId: message.senderActorId,
    isAgent:
      Boolean(message.senderActorId && agentIds.has(message.senderActorId)) ||
      message.kind === MessageKind.AGENT_REPLY,
  }))
}

export async function proposeSessionToKnowledge(sessionId: string): Promise<string> {
  const messages =
    useSessionMessageStore.getState().messages[sessionId] ??
    useSessionStore.getState().messages[sessionId] ??
    []
  const title =
    useSessionListStore.getState().rows.find((row) => row.id === sessionId)?.title ??
    useSessionStore.getState().sessions.find((row) => row.id === sessionId)?.title ??
    ''
  const draftMessages = toDraftMessages(sessionId, messages)
  const draft =
    (await distillWithTeamLlm({ title, messages: draftMessages })) ??
    distillFromSession({ title, messages: draftMessages })
  const candidate = await proposeKnowledgeCandidate({
    title: draft.title,
    content: draft.body,
    suggestedPath: draft.suggestedPath,
    sessionId,
    source: 'session-header',
    summary: draft.summary,
    suggestions: draft.suggestions,
  })
  await useKnowledgeInboxStore.getState().load()
  openKnowledgeReview(candidate.id, candidate.title || draft.title)
  return candidate.id
}
