import { create } from 'zustand'
import type { FeedbackRating, StarRating } from '@/lib/telemetry/types'
import { insertFeedback } from '@/lib/telemetry/supabase-feedback'
import { getBackend } from '@/lib/backend'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useAuthStore } from '@/stores/auth-store'

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * Per-message thumbs and star ratings the user gives an agent reply.
 *
 * The server keeps ONE row per (actor, message) holding both: `kind` (the
 * thumb, not nullable) and `star_rating`. The two maps below are views of that
 * row, so every write here sends the whole row and updates both maps from what
 * it sent. Treating them as independent used to lose data silently: a thumb
 * upserted `star_rating: null` over the stars, a star rating overwrote the
 * thumb with one derived from the number, and either "remove" deleted the row
 * while leaving the other map claiming it was still there.
 */
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

/** The thumb a bare star rating implies; `kind` cannot be null on the row. */
function kindForStars(rating: StarRating): FeedbackRating {
  return rating >= 3 ? 'positive' : 'negative'
}

type RowView = Pick<TelemetryState, 'feedbackCache' | 'starRatingCache'>

/** Mirror the row just written (or `null` for a deleted row) into both maps. */
function withRow(
  state: RowView,
  messageId: string,
  row: { kind: FeedbackRating; starRating: StarRating | null } | null,
): RowView {
  const feedbackCache = new Map(state.feedbackCache)
  const starRatingCache = new Map(state.starRatingCache)
  if (row) {
    feedbackCache.set(messageId, row.kind)
    if (row.starRating != null) starRatingCache.set(messageId, row.starRating)
    else starRatingCache.delete(messageId)
  } else {
    feedbackCache.delete(messageId)
    starRatingCache.delete(messageId)
  }
  return { feedbackCache, starRatingCache }
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

      // Send the stars back with the thumb: the upsert replaces the whole row.
      const starRating = get().starRatingCache.get(messageId) ?? null
      await insertFeedback({
        actorId,
        teamId,
        sessionId,
        messageId,
        kind: rating, // FeedbackRating = 'positive' | 'negative' matches FeedbackKind
        starRating,
      })

      set((state) => withRow(state, messageId, { kind: rating, starRating }))
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

      // The delete took the stars with it — the row is gone, not one column.
      set((state) => withRow(state, messageId, null))
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

      // A thumb the user already gave wins over the one the stars imply. No
      // delete first: the upsert is keyed on (actor, message) and re-rating is
      // already idempotent, while delete-then-insert dropped the row for good
      // when the insert failed.
      const kind = get().feedbackCache.get(messageId) ?? kindForStars(rating)
      await insertFeedback({
        actorId,
        teamId,
        sessionId,
        messageId,
        kind,
        starRating: rating,
      })

      set((state) => withRow(state, messageId, { kind, starRating: rating }))
    } catch (err) {
      console.error('[telemetry] Failed to set star rating:', err)
    }
  },

  removeStarRating: async (_sessionId: string, messageId: string) => {
    try {
      const teamId = useCurrentTeamStore.getState().team?.id
      const actorId = teamId ? await resolveActorId(teamId) : undefined
      await getBackend().telemetry.deleteFeedback({ messageId, actorId: actorId ?? undefined })

      set((state) => withRow(state, messageId, null))
    } catch (err) {
      console.error('[telemetry] Failed to remove star rating:', err)
    }
  },

  getStarRating: (messageId: string) => {
    return get().starRatingCache.get(messageId)
  },
}))
