import { describe, expect, it, vi } from "vitest";

import { removeSessionParticipant } from "../features/sessions/remove-participant";

function fakes(overrides: { cloudFails?: boolean; stopFails?: boolean } = {}) {
  const calls: string[] = [];
  const removeFromCloud = vi.fn(async () => {
    calls.push("cloud");
    if (overrides.cloudFails) throw new Error("forbidden");
  });
  const runtimeRpc = {
    runtimeStop: vi.fn(async () => {
      calls.push("runtimeStop");
      if (overrides.stopFails) throw new Error("timeout");
      return {} as never;
    }),
    removeParticipant: vi.fn(async () => {
      calls.push("removeParticipant");
    }),
  };
  return { calls, removeFromCloud, runtimeRpc };
}

describe("removeSessionParticipant (iOS #1600)", () => {
  it("deletes in the cloud first, then stops the runtime and drops it from the daemon", async () => {
    const { calls, removeFromCloud, runtimeRpc } = fakes();
    await removeSessionParticipant(
      { removeFromCloud, runtimeRpc },
      { sessionId: "s1", actorId: "a1", isAgent: true, runtimeId: "rt-1", workspaceId: "ws-1" },
    );
    expect(calls).toEqual(["cloud", "runtimeStop", "removeParticipant"]);
    expect(removeFromCloud).toHaveBeenCalledWith("s1", "a1");
    expect(runtimeRpc.runtimeStop).toHaveBeenCalledWith({
      targetActorId: "a1",
      runtimeId: "rt-1",
      purgeBinding: true,
      workspaceId: "ws-1",
    });
    expect(runtimeRpc.removeParticipant).toHaveBeenCalledWith({
      targetActorId: "a1",
      sessionId: "s1",
      actorId: "a1",
    });
  });

  it("a refused cloud delete rejects and leaves the agent running", async () => {
    const { calls, removeFromCloud, runtimeRpc } = fakes({ cloudFails: true });
    await expect(
      removeSessionParticipant(
        { removeFromCloud, runtimeRpc },
        { sessionId: "s1", actorId: "a1", isAgent: true, runtimeId: "rt-1" },
      ),
    ).rejects.toThrow("forbidden");
    expect(calls).toEqual(["cloud"]);
  });

  it("skips runtimeStop without a runtime id but still tells the daemon", async () => {
    const { calls, removeFromCloud, runtimeRpc } = fakes();
    await removeSessionParticipant(
      { removeFromCloud, runtimeRpc },
      { sessionId: "s1", actorId: "a1", isAgent: true, runtimeId: null },
    );
    expect(calls).toEqual(["cloud", "removeParticipant"]);
  });

  it("treats the daemon steps as best-effort", async () => {
    const onDaemonStepError = vi.fn();
    const { calls, removeFromCloud, runtimeRpc } = fakes({ stopFails: true });
    await expect(
      removeSessionParticipant(
        { removeFromCloud, runtimeRpc, onDaemonStepError },
        { sessionId: "s1", actorId: "a1", isAgent: true, runtimeId: "rt-1" },
      ),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(["cloud", "runtimeStop", "removeParticipant"]);
    expect(onDaemonStepError).toHaveBeenCalledWith("runtimeStop", expect.any(Error));
  });

  it("only deletes in the cloud for a human, or when MQTT is down", async () => {
    const human = fakes();
    await removeSessionParticipant(
      { removeFromCloud: human.removeFromCloud, runtimeRpc: human.runtimeRpc },
      { sessionId: "s1", actorId: "m2", isAgent: false },
    );
    expect(human.calls).toEqual(["cloud"]);

    const offline = fakes();
    await removeSessionParticipant(
      { removeFromCloud: offline.removeFromCloud, runtimeRpc: null },
      { sessionId: "s1", actorId: "a1", isAgent: true, runtimeId: "rt-1" },
    );
    expect(offline.calls).toEqual(["cloud"]);
  });
});
