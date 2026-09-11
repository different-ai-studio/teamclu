import { daemonRequest } from '@/lib/daemon/daemon-local-client'
import type { KnowledgeCandidate, KnowledgePublishResult } from '@/lib/knowledge/inbox-types'

export type ProposeKnowledgeInput = {
  title: string
  content: string
  sessionId?: string
  suggestedPath?: string
  source?: KnowledgeCandidate['source']
}

export async function listKnowledgeInbox(): Promise<KnowledgeCandidate[]> {
  const result = await daemonRequest<{ items?: KnowledgeCandidate[] }>('/v1/knowledge/inbox')
  return Array.isArray(result.items) ? result.items : []
}

export async function getKnowledgeCandidate(id: string): Promise<KnowledgeCandidate> {
  return daemonRequest<KnowledgeCandidate>(`/v1/knowledge/inbox/${encodeURIComponent(id)}`)
}

export async function proposeKnowledgeCandidate(
  input: ProposeKnowledgeInput,
): Promise<KnowledgeCandidate> {
  return daemonRequest<KnowledgeCandidate>('/v1/knowledge/inbox', {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      content: input.content,
      sessionId: input.sessionId,
      suggestedPath: input.suggestedPath,
      source: input.source ?? 'session-header',
    }),
  })
}

export async function discardKnowledgeCandidate(id: string): Promise<void> {
  await daemonRequest(`/v1/knowledge/inbox/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function publishKnowledgeCandidate(
  id: string,
  input: { title: string; content: string; path: string; overwrite?: boolean },
): Promise<KnowledgePublishResult> {
  return daemonRequest<KnowledgePublishResult>(
    `/v1/knowledge/inbox/${encodeURIComponent(id)}/publish`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        content: input.content,
        path: input.path,
        overwrite: input.overwrite ?? false,
      }),
    },
  )
}

export function isAlreadyExistsError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err)
  return /already_exists|already exists/i.test(raw)
}
