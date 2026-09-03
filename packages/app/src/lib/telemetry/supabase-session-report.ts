import { getBackend } from '@/lib/backend'

interface SessionReportInsert {
  actorId: string
  teamId: string
  sessionId?: string | null
  tokensUsed: number
  costUsd: number
  model?: string | null
  agentKind?: string | null
  endedAt?: string | null
}

export async function insertSessionReport(input: SessionReportInsert): Promise<void> {
  await getBackend().telemetry.insertSessionReport({
    actorId: input.actorId,
    teamId: input.teamId,
    sessionId: input.sessionId ?? null,
    tokensUsed: input.tokensUsed,
    costUsd: input.costUsd,
    model: input.model ?? null,
    agentKind: input.agentKind ?? null,
    endedAt: input.endedAt ?? null,
  })
}
