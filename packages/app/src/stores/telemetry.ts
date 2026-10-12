import { create } from 'zustand'
import type { FeedbackRating, StarRating } from '@/lib/telemetry/types'
import { insertFeedback } from '@/lib/telemetry/supabase-feedback'
import { getBackend } from '@/lib/backend'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useAuthStore } from '@/stores/auth-store'

// ─── Types ───────────────────────────────────────────────────────────────

/** Per-message thumbs and star ratings the user gives an agent reply. */
interface TelemetryState {
  feedbackCache: Map<string, FeedbackRating> // messageId -> rating
  starRatingCache: Map<string, StarRating> // messageId -> 1-5

  setFeedback: (sessionId: string, messageId: string, rating: FeedbackRating) => Promise<void>
  removeFeedback: (sessionId: string, messageId: string) => Promise<void>
  setStarRating: (sessionId: string, messageId: string, rating: StarRating) => Promise<void>
  removeStarRating: (sessionId: string, messageId: string) => Promise<void>
  loadFeedbacks: (sessionId: string) => Promise<void>
  getFeedback: (messageId: string) => FeedbackRating | undefined
  getStarRating: (messageId: string) => StarRating | undefined
}

// ─── Supabase actor-ID resolver ─────────────────────────────────────────

/**
 * Return the current user's actor ID for the current team, or null if not
 * available. Looks up from the `actors` table keyed on auth.uid() + team_id.
 */
async function resolveActorId(teamId: string): Promise<string | null> {
  const userId = useAuthStore.getState().session?.user?.id
  if (!userId) return null
  const actor = await getBackend().directory.resolveCurrentMemberActor(teamId, userId)
  return actor?.id ?? null
}

// ─── Store ───────────────────────────────────────────────────────────────

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  feedbackCache: new Map(),
  starRatingCache: new Map(),

  setFeedback: async (sessionId: string, messageId: string, rating: FeedbackRating) => {
    try {
      const teamId = useCurrentTeamStore.getState().team?.id
      if (!teamId) return
      const actorId = await resolveActorId(teamId)
      if (!actorId) return

      await insertFeedback({
        actorId,
        teamId,
        sessionId,
        messageId,
        kind: rating, // FeedbackRating = 'positive' | 'negative' matches FeedbackKind
      })

      set((state) => {
        const cache = new Map(state.feedbackCache)
        cache.set(messageId, rating)
        return { feedbackCache: cache }
      })
    } catch (err) {
      console.error('[telemetry] Failed to set feedback:', err)
    }
  },

  removeFeedback: async (_sessionId: string, messageId: string) => {
    try {
      // Scope to our own row — an unscoped delete removes teammates'
      // feedback on the pg backend.
      const teamId = useCurrentTeamStore.getState().team?.id
      const actorId = teamId ? await resolveActorId(teamId) : undefined
      await getBackend().telemetry.deleteFeedback({ messageId, actorId: actorId ?? undefined })

      set((state) => {
        const cache = new Map(state.feedbackCache)
        cache.delete(messageId)
        return { feedbackCache: cache }
      })
    } catch (err) {
      console.error('[telemetry] Failed to remove feedback:', err)
    }
  },

  loadFeedbacks: async (sessionId: string) => {
    try {
      const teamId = useCurrentTeamStore.getState().team?.id
      if (!teamId) return

      const actorId = await resolveActorId(teamId)
      const data = await getBackend().telemetry.listFeedbacks({ teamId, sessionId })

      set((state) => {
        const fb = new Map(state.feedbackCache)
        const sr = new Map(state.starRatingCache)
        for (const r of data ?? []) {
          const rowActorId = typeof r.actorId === 'string' ? r.actorId : null
          if (actorId && rowActorId && rowActorId !== actorId) continue
          const messageId = typeof r.messageId === 'string' ? r.messageId : null
          if (messageId) {
            fb.set(messageId, r.kind as FeedbackRating)
            if (r.starRating != null) sr.set(messageId, r.starRating as StarRating)
          }
        }
        return { feedbackCache: fb, starRatingCache: sr }
      })
    } catch (err) {
      console.error('[telemetry] Failed to load feedbacks:', err)
    }
  },

  getFeedback: (messageId: string) => {
    return get().feedbackCache.get(messageId)
  },

  setStarRating: async (sessionId: string, messageId: string, rating: StarRating) => {
    try {
      const teamId = useCurrentTeamStore.getState().team?.id
      if (!teamId) return
      const actorId = await resolveActorId(teamId)
      if (!actorId) return

      // Delete any prior star_rating row for this message (idempotent
      // re-rate), scoped to our own row.
      await getBackend().telemetry.deleteFeedback({ messageId, actorId })

      await insertFeedback({
        actorId,
        teamId,
        sessionId,
        messageId,
        kind: rating >= 3 ? 'positive' : 'negative',
        starRating: rating,
      })

      set((state) => {
        const cache = new Map(state.starRatingCache)
        cache.set(messageId, rating)
        return { starRatingCache: cache }
      })
    } catch (err) {
      console.error('[telemetry] Failed to set star rating:', err)
    }
  },

  removeStarRating: async (_sessionId: string, messageId: string) => {
    try {
      const teamId = useCurrentTeamStore.getState().team?.id
      const actorId = teamId ? await resolveActorId(teamId) : undefined
      await getBackend().telemetry.deleteFeedback({ messageId, actorId: actorId ?? undefined })

      set((state) => {
        const cache = new Map(state.starRatingCache)
        cache.delete(messageId)
        return { starRatingCache: cache }
      })
    } catch (err) {
      console.error('[telemetry] Failed to remove star rating:', err)
    }
  },

  getStarRating: (messageId: string) => {
    return get().starRatingCache.get(messageId)
  },
}))
