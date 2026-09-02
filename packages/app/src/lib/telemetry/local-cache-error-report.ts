import {
  captureTelemetry,
  shouldReportThrottled,
  truncateForExtra,
} from '@/lib/telemetry/capture'

/**
 * Sentry reporting for the libsql local-cache layer.
 *
 * The cache is a best-effort accelerator: every read/write here is allowed to
 * fail without blocking the cloud-backed render path. That makes silent
 * swallowing tempting and wrong — a persistent `team gate mismatch` is a real
 * defect that has to stay visible. Report it, then carry on.
 */

type LocalCacheFailureKind =
  /** Current-team gate rejected the row/team the caller asked for. */
  | 'team_gate_mismatch'
  /** The caller passed an empty team id — a bug in the caller, not the gate. */
  | 'empty_team_id'
  /** Anything else (db open failure, serialization, ...). */
  | 'unknown'

const THROTTLE_WINDOW_MS = 60_000

/**
 * Codes emitted by `apps/desktop/src/local_cache/commands.rs`. Matched as
 * stable tokens rather than prose so the two sides can't drift apart silently.
 */
const ERR_TEAM_GATE_MISMATCH = 'local_cache: team_gate_mismatch'
const ERR_EMPTY_TEAM_ID = 'local_cache: empty_team_id'

export function classifyLocalCacheFailure(reason: string | undefined): LocalCacheFailureKind {
  const text = (reason ?? '').trim()
  if (!text) return 'unknown'
  if (text.includes(ERR_EMPTY_TEAM_ID)) return 'empty_team_id'
  if (text.includes(ERR_TEAM_GATE_MISMATCH)) return 'team_gate_mismatch'
  return 'unknown'
}

/**
 * Report a local-cache failure. Throttled per (command, kind) so a team that
 * stays mismatched cannot produce hundreds of identical events — the previous
 * unhandled-rejection path did exactly that.
 */
export function reportLocalCacheFailure(
  command: string,
  error: unknown,
  context: { teamId?: string | null; sessionId?: string | null } = {},
): void {
  const reason = error instanceof Error ? error.message : String(error)
  const kind = classifyLocalCacheFailure(reason)
  if (!shouldReportThrottled(`local_cache|${command}|${kind}`, THROTTLE_WINDOW_MS)) return

  captureTelemetry({
    message: `local_cache_failed: ${command} (${kind})`,
    // The cache failing degrades performance, not correctness — the caller is
    // required to carry on without it. Warning, not error.
    level: 'warning',
    fingerprint: ['local_cache', command, kind],
    tags: { local_cache_command: command, local_cache_failure_kind: kind },
    extra: {
      reason: truncateForExtra(reason),
      teamId: context.teamId ?? null,
      sessionId: context.sessionId ?? null,
    },
  })

  if (kind === 'team_gate_mismatch') void repairTeamGate()
}

/**
 * A team-scoped cache call was made with no team id. The command never runs,
 * so there is no error to attach — capture the call site instead, which is the
 * only thing that identifies the offending caller.
 */
export function reportLocalCacheEmptyTeamId(command: string): void {
  if (!shouldReportThrottled(`local_cache_empty_team|${command}`, THROTTLE_WINDOW_MS)) return
  captureTelemetry({
    message: `local_cache_empty_team_id: ${command}`,
    level: 'warning',
    fingerprint: ['local_cache', command, 'empty_team_id'],
    tags: { local_cache_command: command, local_cache_failure_kind: 'empty_team_id' },
    extra: { callSite: truncateForExtra(new Error('local_cache empty team id').stack, 2000) },
  })
}

/**
 * A gate mismatch means the backend gate and the team the UI is working on
 * have diverged — the gate was moved (team switch, `load()` resolving a
 * different team) while this caller still held the old one.
 *
 * Re-pinning the gate to the current team is cheap, idempotent, and local: it
 * does not touch the server-side active org, so it cannot fight `enterTeam`.
 * Without it the divergence persists for the rest of the session and every
 * subsequent cache call fails the same way.
 */
async function repairTeamGate(): Promise<void> {
  try {
    const { useCurrentTeamStore, setLocalCacheTeamGate } = await import('@/stores/current-team')
    const teamId = useCurrentTeamStore.getState().team?.id ?? null
    if (teamId) await setLocalCacheTeamGate(teamId)
  } catch {
    // Best-effort repair; the caller has already degraded gracefully.
  }
}
