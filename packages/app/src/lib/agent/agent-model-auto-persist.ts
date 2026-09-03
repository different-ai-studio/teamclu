import type { SessionAgentUiState } from '@/lib/session/session-agent-ui-state'
import {
  isSettledLocalCatalog,
  type LocalDaemonCatalogStatus,
} from '@/stores/local-daemon-catalog-store'

/**
 * Decides which model id (if any) the agent pill may durably persist as this
 * session's pick when the user has not chosen one.
 *
 * # Why this is its own function
 *
 * A pick outranks every other level in `selectAgentModel` — transcript, live
 * retain, device MRU — so whatever lands here wins for good. That made an
 * over-eager write here the root of a *self-reinforcing* bug:
 *
 *   1. cold start, no retain yet → this wrote `available[0]`
 *   2. the pick outranks everything, so the session ran on `available[0]`
 *   3. the daemon recorded that run in its MRU (`config::model_mru`)
 *   4. the MRU head was now the wrong model, so the next new session
 *      inherited it — and every restart makes a new session
 *
 * Each restart re-confirmed the wrong answer, which is why simply serving the
 * MRU to the client did not fix it. The rule below therefore refuses to write
 * anything while an input it depends on is merely *not yet known*, which is
 * distinct from being known-absent.
 *
 * Returns `null` for "persist nothing (yet)".
 */
export function resolveAutoPersistModelId(input: {
  /** Empty until the session exists — nothing to key a pick on. */
  sessionId: string
  uiState: SessionAgentUiState
  /** Catalog still arriving; the list may yet change. */
  runtimeInfoLoading: boolean
  availableModelIds: string[]
  /** A pick already stored for this (session, agent). */
  existingPick: string | undefined
  /** Model this session already ran with, from its transcript. */
  sessionEstablishedModel: string | null | undefined
  /** `RuntimeInfo.currentModel` from the live retain. */
  retainCurrentModel: string | null | undefined
  /**
   * Best-effort **synchronous** local daemon actor id — callers should pass
   * `useLocalDaemonActorId() ?? getKnownLocalDaemonActorId()`.
   *
   * The hook alone reads `null` until an async round trip finishes, which made
   * the local daemon look remote for the first renders and skipped the MRU
   * guard below — that is how the wrong model got pinned. Blocking on `null`
   * instead is worse: outside Tauri (web build, tests) it never resolves, so
   * nothing would ever be persisted for *any* agent. The persisted id closes
   * the gap: on this device it is available on the first render, and `null`
   * then genuinely means "no local daemon here".
   */
  localDaemonActorId: string | null
  agentId: string
  /** Loopback catalog state; `undefined` when no probe result exists yet. */
  localCatalogStatus: LocalDaemonCatalogStatus | undefined
  /** First MRU entry the live catalog still offers, or '' when none applies. */
  localRecentModel: string
}): string | null {
  if (!input.sessionId.trim()) return null

  // Nothing runnable, or nothing worth pinning.
  if (
    input.uiState === 'offline' ||
    input.uiState === 'stale' ||
    input.uiState === 'runtime-error' ||
    input.uiState === 'unconfigured'
  ) {
    return null
  }
  if (input.runtimeInfoLoading) return null
  if (input.availableModelIds.length === 0) return null

  // Someone with more authority already answered.
  if (input.existingPick?.trim()) return null
  if (input.sessionEstablishedModel?.trim()) return null
  if (input.retainCurrentModel?.trim()) return null

  const isLocalAgent =
    !!input.localDaemonActorId && input.agentId === input.localDaemonActorId
  // For the local agent the MRU is the answer, so wait for it. `undefined`
  // (no entry yet) is as unsettled as `'pending'`.
  if (isLocalAgent && !isSettledLocalCatalog(input.localCatalogStatus)) return null

  // This client's history, or nothing. The resolver may use the first catalog
  // entry for a fresh send, but this auto-persist path must not turn that
  // transient default into a durable session pick that outranks later facts.
  return input.localRecentModel.trim() || null
}
