import type { TeamMqttClient } from "../../lib/mqtt/team-mqtt";
import type { ActorPresenceSnapshot } from "./actor-presence";

/**
 * Watches each agent's retained `amux/{team}/{actor}/state` (`ActorPresence`).
 *
 * This used to subscribe `…/{actor}/runtime/+/state`, a per-spawn topic the
 * daemon stopped publishing (ADR-0004) — so agent status, model lists and
 * slash commands never arrived.
 */
export type RuntimeStateSubscriber = {
  watchActor: (actorId: string) => void;
  unwatchActor: (actorId: string) => void;
  watchedActors: () => Set<string>;
  dispose: () => void;
};

type Deps = {
  mqtt: Pick<TeamMqttClient, "subscribe">;
  teamId: string;
  decode: (payload: Uint8Array) => ActorPresenceSnapshot | null;
  onPresence: (actorId: string, presence: ActorPresenceSnapshot) => void;
};

export function actorStateTopic(teamId: string, actorId: string): string {
  return `amux/${teamId}/${actorId}/state`;
}

export function createRuntimeStateSubscriber(deps: Deps): RuntimeStateSubscriber {
  const unsubscribes = new Map<string, () => void>();

  return {
    watchActor(actorId) {
      if (unsubscribes.has(actorId)) return;
      const off = deps.mqtt.subscribe(actorStateTopic(deps.teamId, actorId), (payload) => {
        const presence = deps.decode(payload);
        if (!presence) return;
        deps.onPresence(actorId, presence);
      });
      unsubscribes.set(actorId, off);
    },
    unwatchActor(actorId) {
      const off = unsubscribes.get(actorId);
      if (off) { off(); unsubscribes.delete(actorId); }
    },
    watchedActors() {
      return new Set(unsubscribes.keys());
    },
    dispose() {
      for (const off of unsubscribes.values()) off();
      unsubscribes.clear();
    },
  };
}
