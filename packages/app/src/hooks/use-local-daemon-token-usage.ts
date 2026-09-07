import * as React from 'react'
import { getBackend } from '@/lib/backend'

/** Input + output tokens this actor burned in the current billing month. */
export interface LocalDaemonTokenUsage {
  inputTokens: number
  outputTokens: number
  requests: number
}

/** Slow on purpose: this is a sidebar footnote, not a live meter, and the
 *  report is an aggregate query on the gateway's ledger. */
const POLL_INTERVAL_MS = 5 * 60_000

/**
 * The local daemon agent's token consumption for the current month, or `null`
 * when there is nothing honest to show.
 *
 * `null` covers four different situations on purpose, because the card has one
 * line and they all render the same way — nothing:
 *
 * - the team has no AI gateway (`ai_gateway_unavailable`), which is the common
 *   case: `managed_llm.rs` only reports `Enabled` for a team with both
 *   `llm_enabled` and a `baseUrl`, and everyone else runs pi on their own
 *   provider keys, which the gateway never sees;
 * - the gateway is there but this actor has no row in the period;
 * - the row exists and is zero;
 * - the request failed.
 *
 * The distinction that matters is "we have a real number" vs "we do not". A
 * literal `0` under an agent that is visibly working reads as "this agent did
 * nothing", which is a claim about the agent rather than about our telemetry,
 * so it is deliberately not rendered. Settings › Token Usage is where the
 * team-wide breakdown, including genuine zeroes, belongs.
 */
export function useLocalDaemonTokenUsage(
  teamId: string | null,
  actorId: string | null,
): LocalDaemonTokenUsage | null {
  const [usage, setUsage] = React.useState<LocalDaemonTokenUsage | null>(null)

  React.useEffect(() => {
    if (!teamId || !actorId) {
      setUsage(null)
      return
    }

    let cancelled = false

    const load = async () => {
      try {
        const report = await getBackend().teams.getCreditUsage(teamId, { range: 'month' })
        if (cancelled) return
        const row = report.byActor.find((a) => a.actorId === actorId)
        const total = (row?.inputTokens ?? 0) + (row?.outputTokens ?? 0)
        setUsage(
          row && total > 0
            ? {
                inputTokens: row.inputTokens,
                outputTokens: row.outputTokens,
                requests: row.requests,
              }
            : null,
        )
      } catch {
        // Includes `ai_gateway_unavailable`, which is not an error condition
        // here — it is the majority of teams. Nothing to show either way.
        if (!cancelled) setUsage(null)
      }
    }

    void load()
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS)
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [teamId, actorId])

  return usage
}
