import { describe, expect, it, vi } from "vitest";

import type { TeamMqttClient } from "../lib/mqtt/team-mqtt";
import { OFFLINE_PRESENCE, type ActorPresenceSnapshot } from "../features/actors/actor-presence";
import { createRuntimeStateSubscriber } from "../features/actors/runtime-state-subscriber";

function fakeMqtt(): Pick<TeamMqttClient, "subscribe"> & { fire: (topic: string, payload: Uint8Array) => void } {
  const handlers = new Map<string, (p: Uint8Array, t: string) => void>();
  return {
    subscribe(filter, handler) {
      handlers.set(filter, handler);
      return () => { handlers.delete(filter); };
    },
    fire(topic, payload) {
      handlers.get(topic)?.(payload, topic);
    },
  };
}

const presence: ActorPresenceSnapshot = { ...OFFLINE_PRESENCE, online: true };

describe("RuntimeStateSubscriber", () => {
  it("subscribes to the actor's retained state topic, not the retired runtime fan-out", () => {
    const mqtt = fakeMqtt();
    const subscribeSpy = vi.spyOn(mqtt, "subscribe");
    const sub = createRuntimeStateSubscriber({
      mqtt, teamId: "team1", decode: () => presence, onPresence: () => {},
    });
    sub.watchActor("actor1");
    expect(subscribeSpy).toHaveBeenCalledWith("amux/team1/actor1/state", expect.any(Function));
  });

  it("hands each decoded presence to onPresence with the watched actor id", () => {
    const mqtt = fakeMqtt();
    const cb = vi.fn();
    const sub = createRuntimeStateSubscriber({
      mqtt, teamId: "team1", decode: () => presence, onPresence: cb,
    });
    sub.watchActor("actor1");
    mqtt.fire("amux/team1/actor1/state", new Uint8Array([1, 2]));
    expect(cb).toHaveBeenCalledWith("actor1", presence);
  });

  it("drops payloads that don't decode", () => {
    const mqtt = fakeMqtt();
    const cb = vi.fn();
    const sub = createRuntimeStateSubscriber({
      mqtt, teamId: "team1", decode: () => null, onPresence: cb,
    });
    sub.watchActor("actor1");
    mqtt.fire("amux/team1/actor1/state", new Uint8Array([9]));
    expect(cb).not.toHaveBeenCalled();
  });

  it("unwatch stops delivery", () => {
    const mqtt = fakeMqtt();
    const cb = vi.fn();
    const sub = createRuntimeStateSubscriber({
      mqtt, teamId: "team1", decode: () => presence, onPresence: cb,
    });
    sub.watchActor("actor1");
    sub.unwatchActor("actor1");
    mqtt.fire("amux/team1/actor1/state", new Uint8Array([1]));
    expect(cb).not.toHaveBeenCalled();
    expect(sub.watchedActors().size).toBe(0);
  });
});
