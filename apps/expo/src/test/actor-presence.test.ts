import { create, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import {
  AcpAvailableCommandSchema,
  ActorPresenceSchema,
  AgentType,
  LiveSessionSchema,
  ModelInfoSchema,
} from "@teamclu/app/proto/amux_pb";
import { describe, expect, it } from "vitest";

import {
  decodeActorPresence,
  runtimeInfoByAgentForSession,
  runtimeInfoForSession,
} from "../features/actors/actor-presence";

function encoded(overrides: MessageInitShape<typeof ActorPresenceSchema> = {}) {
  return toBinary(
    ActorPresenceSchema,
    create(ActorPresenceSchema, {
      online: true,
      activeAgentType: AgentType.PI,
      catalogModels: [
        create(ModelInfoSchema, { id: "m1", displayName: "Model One" }),
        create(ModelInfoSchema, { id: "m1", displayName: "dup" }),
        create(ModelInfoSchema, { id: "m2", displayName: "" }),
      ],
      availableCommands: [create(AcpAvailableCommandSchema, { name: "compact", description: "d", inputHint: "" })],
      liveSessions: [
        create(LiveSessionSchema, { sessionId: "s1", lifecycle: 2, status: 2, workspaceId: "w1", currentModel: "m1", worktree: "/srv/app" }),
      ],
      ...overrides,
    }),
  );
}

describe("decodeActorPresence", () => {
  it("decodes online state, deduplicated models, commands and live sessions", () => {
    const p = decodeActorPresence(encoded());
    expect(p?.online).toBe(true);
    expect(p?.activeAgentType).toBe(AgentType.PI);
    expect(p?.models).toEqual([
      { id: "m1", displayName: "Model One" },
      { id: "m2", displayName: "m2" },
    ]);
    expect(p?.availableCommands.map((c) => c.name)).toEqual(["compact"]);
    expect(p?.liveSessions[0]).toMatchObject({ sessionId: "s1", status: 2, currentModel: "m1" });
  });

  it("falls back to the default workspace's models while the catalog is empty", () => {
    const p = decodeActorPresence(
      encoded({ catalogModels: [], defaultWorkspaceModels: [create(ModelInfoSchema, { id: "dw", displayName: "DW" })] }),
    );
    expect(p?.models).toEqual([{ id: "dw", displayName: "DW" }]);
  });

  it("reads an empty payload (a cleared retain) as offline with nothing attached", () => {
    const p = decodeActorPresence(new Uint8Array());
    expect(p?.online).toBe(false);
    expect(p?.liveSessions).toEqual([]);
  });

  it("returns null for garbage", () => {
    expect(decodeActorPresence(new Uint8Array([0xff, 0xff, 0xff]))).toBeNull();
  });
});

describe("runtimeInfoForSession", () => {
  it("maps the session's attachment and addresses it by session id", () => {
    const p = decodeActorPresence(encoded())!;
    const info = runtimeInfoForSession(p, "s1");
    expect(info).toMatchObject({
      runtimeId: "s1",
      agentType: AgentType.PI,
      status: 2,
      state: 2,
      workspaceId: "w1",
      worktree: "/srv/app",
      currentModel: "m1",
    });
    expect(info?.availableModels.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("is undefined when the agent is cold for the session", () => {
    expect(runtimeInfoForSession(decodeActorPresence(encoded())!, "other")).toBeUndefined();
  });

  it("builds an agent map for one session only", () => {
    const presence = new Map([["agent-1", decodeActorPresence(encoded())!]]);
    expect([...runtimeInfoByAgentForSession(presence, "s1").keys()]).toEqual(["agent-1"]);
    expect(runtimeInfoByAgentForSession(presence, "s2").size).toBe(0);
  });
});
