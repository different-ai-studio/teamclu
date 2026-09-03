import { appShortName } from '@/lib/build-config'
import { create } from 'zustand'
import type {
  TelemetryConsent,
  FeedbackRating,
  StarRating,
} from '@/lib/telemetry/types'
import { ScoringEngine } from '@/lib/telemetry/scoring-engine'
import { buildSessionReport } from '@/lib/telemetry/report-builder'
import { useSessionStore } from '@/stores/session-store'
import { insertFeedback } from '@/lib/telemetry/supabase-feedback'
import { insertSessionReport } from '@/lib/telemetry/supabase-session-report'
import { getBackend } from '@/lib/backend'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useAuthStore } from '@/stores/auth-store'
// Permissive proxy until the amuxd daemon client is wired up;
// telemetry's session-report builder is non-functional.
// TODO(amuxd): wire to daemon
const getAgentClient: () => any = () =>
  new Proxy({}, {
    get() {
      return () => {
        throw new Error('Agent client not wired to amuxd daemon yet');
      };
    },
  });
import { isTauri } from '@/lib/utils'
type AgentMessage = any;

// ─── Helpers ─────────────────────────────────────────────────────────────

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

export async function trackEvent(eventName: string, props?: Record<string, unknown>): Promise<void> {
  try {
    await invoke('telemetry_track', { eventName, props: props ?? null })
  } catch {
    // Non-critical — ignore failures
  }
}

// ─── Types ───────────────────────────────────────────────────────────────

interface TelemetryState {
  // State
  consent: TelemetryConsent
  isInitialized: boolean
  feedbackCache: Map<string, FeedbackRating> // messageId -> rating
  starRatingCache: Map<string, StarRating> // messageId -> 1-5
  isGeneratingReports: boolean

  // Actions
  init: () => Promise<void>
  setConsent: (consent: TelemetryConsent) => Promise<void>
  setFeedback: (sessionId: string, messageId: string, rating: FeedbackRating) => Promise<void>
  removeFeedback: (sessionId: string, messageId: string) => Promise<void>
  setStarRating: (sessionId: string, messageId: string, rating: StarRating) => Promise<void>
  removeStarRating: (sessionId: string, messageId: string) => Promise<void>
  loadFeedbacks: (sessionId: string) => Promise<void>
  getFeedback: (messageId: string) => FeedbackRating | undefined
  getStarRating: (messageId: string) => StarRating | undefined
  handleSessionIdle: (sessionId: string) => void
  generateAllSessionReports: (workspacePath?: string) => Promise<void>
  destroy: () => void
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

// ─── Internal state ──────────────────────────────────────────────────────

const scoringEngine = new ScoringEngine()
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
const scoredSessions = new Set<string>()

/**
 * Ensure a session's messages are loaded before building session report.
 * Prevents token statistics from being 0 for historical sessions.
 */
async function ensureSessionMessagesLoaded(sessionId: string): Promise<void> {
  const sessionStore = useSessionStore.getState()
  const messages = sessionStore.sessions.find((s) => s.id === sessionId)?.messages ?? []
  
  // If session has messages with token data, we're good
  if (messages && messages.length > 0) {
    const hasTokenData = messages.some((msg: any) => msg.role === 'assistant' && msg.tokens)
    if (hasTokenData) {
      return
    }
  }
  
  // Session has no messages or no token data - load from API
  console.log(`[telemetry] Loading messages for session ${sessionId}`)
  
  try {
    const client = getAgentClient()
    const apiMessages = await client.getMessages(sessionId)
    
    // Convert agent messages to our format
    const convertedMessages = apiMessages.map((msg: AgentMessage) => ({
      id: msg.info.id,
      sessionId: msg.info.sessionID,
      role: msg.info.role as 'user' | 'assistant' | 'system',
      content: msg.parts
        ?.filter((p: any) => p.type === 'text')
        .map((p: any) => p.text || '')
        .join('') || '',
      parts: (msg.parts || []).map((p: any) => ({
        id: p.id,
        type: p.type,
        text: p.text,
        content: p.text,
      })),
      timestamp: msg.info.time?.created ? new Date(msg.info.time.created) : new Date(),
      tokens: msg.info.tokens,
      cost: msg.info.cost,
      modelID: msg.info.modelID,
      providerID: msg.info.providerID,
      agent: msg.info.agent,
      toolCalls: [],
    }))
    
    // Update the session in the store
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId ? { ...s, messages: convertedMessages } : s
      )
    }))
    
    console.log(`[telemetry] Loaded ${convertedMessages.length} messages for session ${sessionId}`)
  } catch (err) {
    console.error(`[telemetry] Failed to load messages for session ${sessionId}:`, err)
    // Don't throw - let the report builder handle the empty message case
  }
}

// ─── Store ───────────────────────────────────────────────────────────────

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  consent: 'undecided',
  isInitialized: false,
  feedbackCache: new Map(),
  starRatingCache: new Map(),
  isGeneratingReports: false,

  init: async () => {
    if (!isTauri()) {
      set({ isInitialized: true })
      return
    }

    try {
      const consent = await invoke<string>('telemetry_get_consent')

      set({
        consent: consent as TelemetryConsent,
        isInitialized: true,
      })

      // Keep startup lightweight: historical reports can still be generated
      // explicitly, but init must not bulk-load all session history into WebView.
    } catch (err) {
      console.error('[telemetry] Failed to initialize:', err)
      set({ isInitialized: true })
    }
  },

  setConsent: async (consent: TelemetryConsent) => {
    if (!isTauri()) return

    try {
      await invoke('telemetry_set_consent', { state: consent })
      set({ consent })
    } catch (err) {
      console.error('[telemetry] Failed to set consent:', err)
    }
  },

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

      // Trigger session report creation/update for this session
      get().handleSessionIdle(sessionId)

    } catch (err) {
      console.error('[telemetry] Failed to set feedback:', err)
    }
  },

  removeFeedback: async (sessionId: string, messageId: string) => {
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

      // Trigger session report creation/update for this session
      get().handleSessionIdle(sessionId)

    } catch (err) {
      console.error('[telemetry] Failed to remove feedback:', err)
    }
  },

  loadFeedbacks: async (sessionId: string) => {
    try {
      const teamId = useCurrentTeamStore.getState().team?.id
      if (!teamId) return

      const data = await getBackend().telemetry.listFeedbacks({ teamId, sessionId })

      set((state) => {
        const fb = new Map(state.feedbackCache)
        const sr = new Map(state.starRatingCache)
        for (const r of data ?? []) {
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

      // Trigger session report creation/update for this session
      get().handleSessionIdle(sessionId)

    } catch (err) {
      console.error('[telemetry] Failed to set star rating:', err)
    }
  },

  removeStarRating: async (sessionId: string, messageId: string) => {
    try {
      const teamId = useCurrentTeamStore.getState().team?.id
      const actorId = teamId ? await resolveActorId(teamId) : undefined
      await getBackend().telemetry.deleteFeedback({ messageId, actorId: actorId ?? undefined })

      set((state) => {
        const cache = new Map(state.starRatingCache)
        cache.delete(messageId)
        return { starRatingCache: cache }
      })

      // Trigger session report creation/update for this session
      get().handleSessionIdle(sessionId)

    } catch (err) {
      console.error('[telemetry] Failed to remove star rating:', err)
    }
  },

  getStarRating: (messageId: string) => {
    return get().starRatingCache.get(messageId)
  },

  handleSessionIdle: (sessionId: string) => {
    const { consent } = get()
    if (consent !== 'granted') return

    // Cancel any existing timer for this session
    const existingTimer = idleTimers.get(sessionId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    // Set a 2-second debounce timer
    const timer = setTimeout(async () => {
      idleTimers.delete(sessionId)

      // Deduplication: don't score same session twice in quick succession
      if (scoredSessions.has(sessionId)) return
      scoredSessions.add(sessionId)

      // Allow re-scoring after 60 seconds
      setTimeout(() => scoredSessions.delete(sessionId), 60_000)

      try {
        const { feedbackCache, starRatingCache } = get()

        // Ensure session messages are loaded before building report
        await ensureSessionMessagesLoaded(sessionId)

        // Build the session report
        const report = buildSessionReport(sessionId, feedbackCache, starRatingCache)
        if (!report) {
          console.warn(`[telemetry] Failed to build report for session ${sessionId} - no messages or session not found`)
          return
        }

        // Run scoring engine
        const scores = await scoringEngine.score(report)
        report.scores = JSON.stringify(scores)

        // Remove internal scorer metadata before saving
        const cleanReport = { ...report }
        delete (cleanReport as Record<string, unknown>)._feedbackPositive
        delete (cleanReport as Record<string, unknown>)._feedbackNegative
        delete (cleanReport as Record<string, unknown>)._starRatings

        // Save to Supabase
        const teamId = useCurrentTeamStore.getState().team?.id
        const actorId = teamId ? await resolveActorId(teamId) : null
        if (teamId && actorId) {
          await insertSessionReport({
            actorId,
            teamId,
            sessionId: cleanReport.session_id,
            tokensUsed: (cleanReport.total_tokens_input ?? 0) + (cleanReport.total_tokens_output ?? 0),
            costUsd: cleanReport.total_cost ?? 0,
            model: cleanReport.model_id ?? null,
            agentKind: cleanReport.agent ?? null,
            endedAt: cleanReport.completed_at ? new Date(cleanReport.completed_at).toISOString() : null,
          })
        }
        console.log(`[telemetry] Scored session ${sessionId}:`, scores.length, 'scores')

      } catch (err) {
        console.error('[telemetry] Scoring failed for session:', sessionId, err)
      }
    }, 2000)

    idleTimers.set(sessionId, timer)
  },

  generateAllSessionReports: async (_workspacePath?: string) => {
    if (!isTauri()) return
    const { consent, isGeneratingReports } = get()
    if (consent !== 'granted') {
      console.log('[telemetry] Skipping report generation - consent not granted')
      return
    }
    if (isGeneratingReports) {
      console.log('[telemetry] Report generation already in progress')
      return
    }

    set({ isGeneratingReports: true })
    console.log('[telemetry] Starting automatic session report generation')

    try {
      const sessionStore = useSessionStore.getState()
      const sessions = sessionStore.sessions
      console.log(`[telemetry] Processing ${sessions.length} sessions`)

      const { feedbackCache, starRatingCache } = get()
      let successCount = 0
      let skipCount = 0
      let errorCount = 0

      // Process sessions in batches of 5 to avoid overwhelming the system
      const BATCH_SIZE = 5
      for (let i = 0; i < sessions.length; i += BATCH_SIZE) {
        const batch = sessions.slice(i, i + BATCH_SIZE)
        
        await Promise.allSettled(
          batch.map(async (session) => {
            try {
              // Skip if this session was already scored recently (within 60s)
              if (scoredSessions.has(session.id)) {
                skipCount++
                return
              }

              // Check if session has messages with token data
              const hasTokenData = session.messages.some(
                (msg: any) => msg.role === 'assistant' && msg.tokens
              )
              
              if (!hasTokenData) {
                skipCount++
                return
              }

              // Build session report
              const report = buildSessionReport(session.id, feedbackCache, starRatingCache)
              if (!report) {
                skipCount++
                return
              }

              // Run scoring engine
              const scores = await scoringEngine.score(report)
              report.scores = JSON.stringify(scores)

              // Remove internal scorer metadata before saving
              const cleanReport = { ...report }
              delete (cleanReport as Record<string, unknown>)._feedbackPositive
              delete (cleanReport as Record<string, unknown>)._feedbackNegative
              delete (cleanReport as Record<string, unknown>)._starRatings

              // Save to Supabase
              const teamId = useCurrentTeamStore.getState().team?.id
              const actorId = teamId ? await resolveActorId(teamId) : null
              if (!teamId || !actorId) { skipCount++; return }
              await insertSessionReport({
                actorId,
                teamId,
                sessionId: cleanReport.session_id,
                tokensUsed: (cleanReport.total_tokens_input ?? 0) + (cleanReport.total_tokens_output ?? 0),
                costUsd: cleanReport.total_cost ?? 0,
                model: cleanReport.model_id ?? null,
                agentKind: cleanReport.agent ?? null,
                endedAt: cleanReport.completed_at ? new Date(cleanReport.completed_at).toISOString() : null,
              })
              
              // Mark as scored to prevent re-processing
              scoredSessions.add(session.id)
              setTimeout(() => scoredSessions.delete(session.id), 60_000)
              
              successCount++
            } catch (err) {
              console.error(`[telemetry] Failed to generate report for session ${session.id}:`, err)
              errorCount++
            }
          })
        )
      }

      console.log(`[telemetry] Report generation complete: ${successCount} created, ${skipCount} skipped, ${errorCount} errors`)

    } catch (err) {
      console.error('[telemetry] Failed to generate session reports:', err)
    } finally {
      set({ isGeneratingReports: false })
    }
  },

  destroy: () => {
    for (const timer of idleTimers.values()) {
      clearTimeout(timer)
    }
    idleTimers.clear()
    scoredSessions.clear()
  },
}))

// ─── Debug Helper ────────────────────────────────────────────────────

/**
 * Expose telemetry store for debugging in browser console.
 * Usage: window[`__${appShortName}_TELEMETRY__`].generateAllSessionReports()
 */
if (typeof window !== 'undefined') {
  (window as any)[`__${appShortName.toUpperCase()}_TELEMETRY__`] = useTelemetryStore.getState()
}
