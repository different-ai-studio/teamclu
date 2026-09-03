/** Tracks amuxd re-init: previous local actor ids are "stale" for engaged pills. */

import { appStoragePrefix } from '@/lib/config/build-config'

const PERSISTED_LOCAL_DAEMON_ACTOR_KEY = `${appStoragePrefix}-local-daemon-actor-id`

const supersededLocalActorIds = new Set<string>()
let lastKnownLocalActorId: string | null = null

function readPersistedLocalDaemonActorId(): string | null {
  try {
    const value = localStorage.getItem(PERSISTED_LOCAL_DAEMON_ACTOR_KEY)?.trim()
    return value || null
  } catch {
    return null
  }
}

function writePersistedLocalDaemonActorId(actorId: string): void {
  try {
    localStorage.setItem(PERSISTED_LOCAL_DAEMON_ACTOR_KEY, actorId)
  } catch {
    /* ignore storage errors */
  }
}

function markSuperseded(actorId: string): void {
  const id = actorId.trim()
  if (id) supersededLocalActorIds.add(id)
}

export function noteLocalDaemonActorId(current: string | null): void {
  const next = current?.trim() || null
  if (next && lastKnownLocalActorId && next !== lastKnownLocalActorId) {
    markSuperseded(lastKnownLocalActorId)
  }
  if (next) {
    const persisted = readPersistedLocalDaemonActorId()
    if (persisted && persisted !== next) {
      markSuperseded(persisted)
    }
    supersededLocalActorIds.delete(next)
    lastKnownLocalActorId = next
    writePersistedLocalDaemonActorId(next)
  }
}

export function isSupersededLocalAgent(agentId: string): boolean {
  const id = agentId.trim()
  if (!id) return false
  const current = getKnownLocalDaemonActorId()
  if (current && id === current) return false
  return supersededLocalActorIds.has(id)
}

/**
 * True when agentId was a prior local amuxd actor identity on THIS client.
 * Gates stale/rebind UX — must not be true for remote teammates' agents.
 */
export function wasEverLocalDaemonIdentity(agentId: string): boolean {
  const id = agentId.trim()
  if (!id) return false

  const current = getKnownLocalDaemonActorId()
  if (current && id === current) return false

  if (isSupersededLocalAgent(id)) return true

  const persisted = readPersistedLocalDaemonActorId()
  if (persisted && persisted === id && current && current !== id) return true

  return false
}

/** Latest local daemon actor id observed this app session (HTTP /v1/info). */
export function getKnownLocalDaemonActorId(): string | null {
  return lastKnownLocalActorId ?? readPersistedLocalDaemonActorId()
}

/** @internal test helper */
export function __resetLocalDaemonIdentityForTest(): void {
  supersededLocalActorIds.clear()
  lastKnownLocalActorId = null
  try {
    localStorage.removeItem(PERSISTED_LOCAL_DAEMON_ACTOR_KEY)
  } catch {
    /* ignore */
  }
}
