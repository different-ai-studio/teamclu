import { ensureSessionLiveSubscribed } from '@/lib/session/session-live-subscriptions'
import { useSessionListStore, type SessionListEntry } from '@/stores/session-list-store'
import { useSessionStore } from '@/stores/session-store'
import { useUIStore } from '@/stores/ui'

type PromoteCreatedSessionArgs = {
  sessionId: string
  teamId: string
  title: string
  ideaId?: string | null
  /** Optional preview when the opening message is already known. */
  lastMessagePreview?: string | null
  focusComposer?: boolean
}

/**
 * Make a just-created session visible and active without waiting on a full
 * session-list refetch. MQTT subscribe + list reconcile run in the background.
 */
export async function promoteCreatedSessionToUi(
  args: PromoteCreatedSessionArgs,
): Promise<void> {
  const now = new Date().toISOString()
  const preview = args.lastMessagePreview?.trim() || null
  const row: SessionListEntry = {
    id: args.sessionId,
    title: args.title,
    team_id: args.teamId,
    last_message_at: preview ? now : null,
    last_message_preview: preview,
    mode: 'collab',
    idea_id: args.ideaId ?? null,
    has_unread: false,
    created_at: now,
    updated_at: now,
  }

  useSessionListStore.getState().upsertRows([row])
  useSessionStore.getState().addHighlightedSession(args.sessionId)

  void ensureSessionLiveSubscribed(args.teamId, args.sessionId).catch((e) => {
    console.warn('[promote-created-session] live subscribe failed (non-fatal):', e)
  })
  void useSessionListStore.getState().load().catch((e) => {
    console.warn('[promote-created-session] session list reconcile failed (non-fatal):', e)
  })

  await useUIStore.getState().switchToSession(args.sessionId)
  if (args.focusComposer) {
    useUIStore.getState().requestComposerFocus()
  }
}
