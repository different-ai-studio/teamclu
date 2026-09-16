import { fetchDocuments } from '@/lib/daemon/daemon-local-client'
import {
  distillFromDocument,
  documentFileKind,
} from '@/lib/knowledge/document-knowledge-draft'
import { proposeKnowledgeCandidate } from '@/lib/knowledge/inbox-client'
import { distillDocumentWithTeamLlm } from '@/lib/knowledge/session-knowledge-llm'
import { openKnowledgeReview } from '@/lib/tabs/knowledge-tabs'
import { useKnowledgeInboxStore } from '@/stores/knowledge-inbox'

export type ProposeDocumentInput = {
  absPath: string
  /** Sync key, e.g. `documents/hr/合同.pdf`. */
  documentPath: string
  workspacePath: string
  /** Listed in the manifest but not on this device — fetch first. */
  needsFetch?: boolean
  teamId?: string
  readText: (workspacePath: string, absPath: string) => Promise<string | undefined>
}

function fileNameOf(documentPath: string, absPath: string): string {
  const fromKey = documentPath.split('/').pop()
  if (fromKey) return fromKey
  return absPath.split(/[/\\]/).pop() || 'untitled'
}

export async function proposeDocumentToKnowledge(input: ProposeDocumentInput): Promise<string> {
  if (input.needsFetch) {
    if (!input.teamId) {
      throw new Error('Cannot fetch this document without a current team')
    }
    await fetchDocuments(input.teamId, [input.documentPath])
  }

  const fileName = fileNameOf(input.documentPath, input.absPath)
  const kind = documentFileKind(fileName)
  let content: string | null = null
  if (kind !== 'binary') {
    const text = await input.readText(input.workspacePath, input.absPath)
    content = text ?? null
  }

  const heuristic = distillFromDocument({
    fileName,
    documentPath: input.documentPath,
    content,
  })
  const draft =
    content != null
      ? ((await distillDocumentWithTeamLlm({
          title: heuristic.title,
          text: content,
          documentPath: input.documentPath,
        })) ?? heuristic)
      : heuristic

  const candidate = await proposeKnowledgeCandidate({
    title: draft.title,
    content: draft.body,
    suggestedPath: draft.suggestedPath,
    source: 'document',
    documentPath: input.documentPath,
    summary: draft.summary,
    suggestions: draft.suggestions,
  })
  await useKnowledgeInboxStore.getState().load()
  openKnowledgeReview(candidate.id, candidate.title || draft.title)
  return candidate.id
}
