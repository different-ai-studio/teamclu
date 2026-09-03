import * as React from 'react'
import { backendTypeFromRuntimeEntry } from '@/lib/runtime-state-resolve'
import { attachmentsForSession, useRuntimeStateStore } from '@/stores/runtime-state-store'

type EngagedAgentRuntimeMaps = {
  agentToRuntimeId: Map<string, string>
  agentToBackendType: Map<string, string>
}

/**
 * agentId → runtime_id / backend_type for the active session (single source for ChatPanel).
 *
 * This used to be three effects that fetched `agent_runtimes` hints and
 * runtime-targets from the cloud and merged them with the MQTT retain, plus
 * re-fetch logic for whatever the retain had not delivered yet. All of it was
 * scaffolding around a DB copy the code itself called "often stale; treat as a
 * hint, not as truth".
 *
 * The retain is now the only source and it is keyed by session, so this is a
 * pure derivation — no fetching, no cancellation, no refetch keys. An agent
 * absent from the maps means the session is cold, which is the same thing an
 * empty fetch used to mean.
 */
export function useEngagedAgentRuntimeMap(
  activeSessionId: string | null,
  engagedAgentIds: string[],
): EngagedAgentRuntimeMaps {
  const runtimeStates = useRuntimeStateStore((s) => s.byRuntimeId)
  const engagedAgentIdSignature = engagedAgentIds.join(',')

  return React.useMemo(() => {
    const agentToRuntimeId = new Map<string, string>()
    const agentToBackendType = new Map<string, string>()
    const ids = engagedAgentIdSignature.split(',').filter(Boolean)
    if (!activeSessionId || ids.length === 0) {
      return { agentToRuntimeId, agentToBackendType }
    }

    for (const agentId of ids) {
      // This agent's own attachment to THIS session, and nothing else. There
      // is deliberately no per-agent fallback: that would scan every entry and
      // happily return another session's attachment, which is the cross-session
      // leak the pre-retain code spent three effects fighting.
      const entry = attachmentsForSession(activeSessionId, runtimeStates).find(
        (e) => e.daemonActorId === agentId,
      )
      if (!entry) continue

      const runtimeId = entry.info.runtimeId?.trim() || activeSessionId
      if (runtimeId) agentToRuntimeId.set(agentId, runtimeId)

      const backendType = backendTypeFromRuntimeEntry(entry)
      if (backendType) agentToBackendType.set(agentId, backendType)
    }

    return { agentToRuntimeId, agentToBackendType }
  }, [activeSessionId, engagedAgentIdSignature, runtimeStates])
}
