import { getKnownLocalDaemonActorId } from "@/lib/daemon/local-daemon-identity";
import { useActorPresenceStore } from "@/stores/actor-presence-store";
import { DEVICE_PRESENCE_GATE_TIMEOUT_MS } from "@/lib/teamclu/runtime-rpc-timeouts";

export type AgentDevicePresence = "online" | "offline" | "unknown";

const LOCAL_DAEMON_SIGNAL_CACHE_TTL_MS = 5_000;

type LocalDaemonSignalCache = {
  actorId: string;
  daemonMqttConnected: boolean | null;
  localHttpOk: boolean | null;
  at: number;
};

let localDaemonSignalCache: LocalDaemonSignalCache | null = null;

/** @internal test helper */
export function __resetLocalDaemonSignalCacheForTest(): void {
  localDaemonSignalCache = null;
}

export function noteLocalDaemonSignals(input: {
  actorId: string;
  daemonMqttConnected?: boolean | null;
  localHttpOk?: boolean | null;
}): void {
  const actorId = input.actorId.trim();
  if (!actorId) return;
  const prev = localDaemonSignalCache?.actorId === actorId ? localDaemonSignalCache : null;
  localDaemonSignalCache = {
    actorId,
    daemonMqttConnected:
      input.daemonMqttConnected !== undefined
        ? input.daemonMqttConnected
        : (prev?.daemonMqttConnected ?? null),
    localHttpOk:
      input.localHttpOk !== undefined ? input.localHttpOk : (prev?.localHttpOk ?? null),
    at: Date.now(),
  };
}

function readCachedLocalDaemonSignals(actorId: string): {
  daemonMqttConnected: boolean | null;
  localHttpOk: boolean | null;
} | null {
  const cache = localDaemonSignalCache;
  if (!cache || cache.actorId !== actorId) return null;
  if (Date.now() - cache.at > LOCAL_DAEMON_SIGNAL_CACHE_TTL_MS) return null;
  return {
    daemonMqttConnected: cache.daemonMqttConnected,
    localHttpOk: cache.localHttpOk,
  };
}

/**
 * Single merge rule for "is this agent's daemon reachable?".
 *
 * - For the local desktop daemon, live `/v1/info.mqtt_connected` is the
 *   strongest signal: it overrides both stale offline LWT and ghost online retain.
 * - MQTT `online: true` / `false` otherwise apply (remote agents: LWT is authoritative).
 * - Missing MQTT retain is `unknown`, never offline (except when local HTTP proves down
 *   after an offline retain with unknown daemon mqtt).
 */
export function mergeAgentDevicePresence(input: {
  mqttOnline: boolean | undefined;
  isLocalDaemon: boolean;
  /** From daemon GET /v1/info — authoritative over stale LWT / ghost retain when known. */
  daemonMqttConnected?: boolean | null;
  /** Local HTTP probe result; only consulted when MQTT retain is missing or override needs a fallback. */
  localHttpOk?: boolean | null;
}): AgentDevicePresence {
  if (input.isLocalDaemon) {
    if (input.daemonMqttConnected === true) return "online";
    if (input.daemonMqttConnected === false) return "offline";
  }

  if (input.mqttOnline === true) return "online";

  if (input.mqttOnline === false) {
    if (!input.isLocalDaemon) return "offline";
    if (input.localHttpOk === true) return "unknown";
    if (input.localHttpOk === false) return "offline";
    return "offline";
  }

  // Retain missing / not yet known.
  if (input.isLocalDaemon && input.localHttpOk === true) return "online";
  if (input.isLocalDaemon && input.localHttpOk === false) return "unknown";
  return "unknown";
}

export function presenceOnlineFlag(presence: AgentDevicePresence): boolean | undefined {
  if (presence === "online") return true;
  if (presence === "offline") return false;
  return undefined;
}

/**
 * Sync presence for UI / wake filters. Uses MQTT store + known local actor id +
 * short-lived local daemon signal cache (warmed by sidebar / async resolve).
 */
export function resolveAgentDevicePresenceSync(agentActorId: string): AgentDevicePresence {
  const id = agentActorId.trim();
  if (!id) return "unknown";

  const mqttOnline = useActorPresenceStore.getState().byActorId[id]?.online;
  const localId = getKnownLocalDaemonActorId();
  const isLocalDaemon = !!localId && localId === id;
  const cached = isLocalDaemon ? readCachedLocalDaemonSignals(id) : null;

  return mergeAgentDevicePresence({
    mqttOnline,
    isLocalDaemon,
    daemonMqttConnected: cached?.daemonMqttConnected ?? null,
    localHttpOk: cached?.localHttpOk ?? null,
  });
}

async function resolveLocalDaemonSignals(agentActorId: string): Promise<{
  isLocalDaemon: boolean;
  daemonMqttConnected: boolean | null;
  localHttpOk: boolean | null;
}> {
  const { isTauri } = await import("@/lib/utils");
  if (!isTauri()) {
    return { isLocalDaemon: false, daemonMqttConnected: null, localHttpOk: null };
  }

  const knownLocal = getKnownLocalDaemonActorId();
  if (knownLocal && knownLocal !== agentActorId) {
    return { isLocalDaemon: false, daemonMqttConnected: null, localHttpOk: null };
  }

  const cached = readCachedLocalDaemonSignals(agentActorId);
  if (cached && (cached.daemonMqttConnected !== null || cached.localHttpOk !== null)) {
    // Still confirm identity when cache hit without knownLocal yet.
    if (knownLocal === agentActorId) {
      return { isLocalDaemon: true, ...cached };
    }
  }

  const { getLocalDaemonActorId, getDaemonMqttConnected } = await import("@/lib/daemon/daemon-agent-admin");
  const localId = await getLocalDaemonActorId();
  if (localId !== agentActorId) {
    return { isLocalDaemon: false, daemonMqttConnected: null, localHttpOk: null };
  }

  const daemonMqttConnected = await getDaemonMqttConnected();
  if (daemonMqttConnected === true || daemonMqttConnected === false) {
    noteLocalDaemonSignals({ actorId: agentActorId, daemonMqttConnected, localHttpOk: null });
    return { isLocalDaemon: true, daemonMqttConnected, localHttpOk: null };
  }

  const { probeDaemonHttp } = await import("@/lib/daemon/daemon-local-client");
  const probe = await probeDaemonHttp();
  noteLocalDaemonSignals({
    actorId: agentActorId,
    daemonMqttConnected: null,
    localHttpOk: probe.ok,
  });
  return { isLocalDaemon: true, daemonMqttConnected: null, localHttpOk: probe.ok };
}

/**
 * Resolve whether an agent's daemon is reachable (async; may wait briefly for MQTT retain).
 *
 * Fast-path only when safe:
 * - known remote agent with MQTT retain already online/offline
 * - known local agent whose daemonMqtt cache is warm (merge already applied)
 * Otherwise fall through so local `/v1/info` can override stale/ghost retains.
 */
export async function resolveAgentDevicePresence(
  agentActorId: string,
  opts?: { timeoutMs?: number },
): Promise<AgentDevicePresence> {
  const knownLocal = getKnownLocalDaemonActorId();
  if (knownLocal && knownLocal !== agentActorId) {
    const syncRemote = resolveAgentDevicePresenceSync(agentActorId);
    if (syncRemote === "online" || syncRemote === "offline") {
      return syncRemote;
    }
  } else if (knownLocal === agentActorId) {
    const cached = readCachedLocalDaemonSignals(agentActorId);
    if (cached?.daemonMqttConnected === true || cached?.daemonMqttConnected === false) {
      return resolveAgentDevicePresenceSync(agentActorId);
    }
  }

  const timeoutMs = opts?.timeoutMs ?? DEVICE_PRESENCE_GATE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entry = useActorPresenceStore.getState().byActorId[agentActorId];
    if (entry?.online === true || entry?.online === false) {
      const knownLocal = getKnownLocalDaemonActorId();
      // Remote + online: no need to hit local HTTP/info.
      if (entry.online === true && knownLocal && knownLocal !== agentActorId) {
        return "online";
      }
      if (entry.online === true && !knownLocal) {
        // Might still be the local daemon before identity is noted — check once.
        const local = await resolveLocalDaemonSignals(agentActorId);
        return mergeAgentDevicePresence({
          mqttOnline: true,
          isLocalDaemon: local.isLocalDaemon,
          daemonMqttConnected: local.daemonMqttConnected,
          localHttpOk: local.localHttpOk,
        });
      }
      const local = await resolveLocalDaemonSignals(agentActorId);
      return mergeAgentDevicePresence({
        mqttOnline: entry.online,
        isLocalDaemon: local.isLocalDaemon,
        daemonMqttConnected: local.daemonMqttConnected,
        localHttpOk: local.localHttpOk,
      });
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const entry = useActorPresenceStore.getState().byActorId[agentActorId];
  const local = await resolveLocalDaemonSignals(agentActorId);
  return mergeAgentDevicePresence({
    mqttOnline: entry?.online,
    isLocalDaemon: local.isLocalDaemon,
    daemonMqttConnected: local.daemonMqttConnected,
    localHttpOk: local.localHttpOk,
  });
}
