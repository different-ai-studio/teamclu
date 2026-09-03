import { getBackend } from '@/lib/backend'

export type FeedbackKind = 'positive' | 'negative'

interface FeedbackInsert {
  actorId: string
  teamId: string
  sessionId?: string | null
  messageId?: string | null
  kind: FeedbackKind
  starRating?: number | null
  skill?: string | null
}

export async function insertFeedback(input: FeedbackInsert): Promise<void> {
  await getBackend().telemetry.insertFeedback({
    messageId: input.messageId ?? null,
    actorId: input.actorId,
    teamId: input.teamId,
    sessionId: input.sessionId ?? null,
    kind: input.kind,
    starRating: input.starRating ?? null,
    skill: input.skill ?? null,
  })
}
