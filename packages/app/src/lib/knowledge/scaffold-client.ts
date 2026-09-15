import { daemonRequest } from '@/lib/daemon/daemon-local-client'

export type KnowledgeScaffoldReport = {
  knowledgeRoot: string
  dirsCreated: string[]
  filesCreated: string[]
  filesSkipped: string[]
}

/**
 * Initialize (or top up) the active team's knowledge vault with the standard
 * directory tree and bilingual templates. Idempotent — existing files are
 * never overwritten.
 */
export async function scaffoldKnowledgeVault(opts?: {
  teamName?: string
}): Promise<KnowledgeScaffoldReport> {
  return daemonRequest<KnowledgeScaffoldReport>('/v1/knowledge/scaffold', {
    method: 'POST',
    body: JSON.stringify({
      teamName: opts?.teamName?.trim() || undefined,
    }),
  })
}
