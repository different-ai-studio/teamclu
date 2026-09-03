import { beforeEach, describe, expect, it } from "vitest";
import { AgentType, RuntimeLifecycle } from "@/lib/proto/amux_pb";
import type { RuntimeStateEntry } from "@/stores/runtime-state-store";
import {
  agentModelDisplayLabel,
  agentModelIdsMatch,
  backendTypeFromRuntimeEntry,
  normalizeAgentModelId,
  resolveCommandRuntimeId,
  resolvePermissionCommandTarget,
  resolveRuntimeIdForAgent,
  resolveRuntimeStateEntryForAgent,
  resolveSetModelId,
  selectAgentModel,
} from "@/lib/agent/runtime-state-resolve";
import { useAgentModelPickStore } from "@/stores/agent-model-pick-store";

function entry(
  agentId: string,
  sessionId: string,
  models: Array<{ id: string; displayName: string }> = [],
  state: RuntimeLifecycle = RuntimeLifecycle.ACTIVE,
): RuntimeStateEntry {
  return {
    daemonActorId: agentId,
    lastUpdated: Date.now(),
    info: {
      runtimeId: sessionId,
      agentType: AgentType.OPENCODE,
      availableModels: models,
      currentModel: "",
      state,
    } as RuntimeStateEntry["info"],
  };
}

function attachmentStore(
  agentId: string,
  sessionId: string,
  models: Array<{ id: string; displayName: string }> = [],
  state: RuntimeLifecycle = RuntimeLifecycle.ACTIVE,
  lastUpdated?: number,
): Record<string, RuntimeStateEntry> {
  const row = entry(agentId, sessionId, models, state);
  if (lastUpdated !== undefined) row.lastUpdated = lastUpdated;
  return { [`${agentId}::${sessionId}`]: row };
}

beforeEach(() => {
  useAgentModelPickStore.setState({ bySessionAgent: {} });
});

describe("resolveRuntimeStateEntryForAgent", () => {
  it("finds attachment by composite key when session hint matches", () => {
    const byRuntimeId = attachmentStore("agent-mac", "uuid-from-db", [
      { id: "m-1", displayName: "Model 1" },
    ]);
    const resolved = resolveRuntimeStateEntryForAgent("agent-mac", byRuntimeId, "uuid-from-db");
    expect(resolved?.info.availableModels).toHaveLength(1);
    expect(resolveRuntimeIdForAgent("agent-mac", byRuntimeId, "uuid-from-db")).toBe("uuid-from-db");
  });

  it("prefers the newest attachment when multiple sessions are live", () => {
    const agentUuid = "b3cbc44e-0000-4000-8000-000000000001";
    const stale = entry(agentUuid, "session-a", [{ id: "big-pickle", displayName: "Big Pickle" }]);
    stale.info.currentModel = "big-pickle";
    stale.lastUpdated = 1;
    const fresh = entry(agentUuid, "session-b", [
      { id: "big-pickle", displayName: "Big Pickle" },
      { id: "mimo-v2.5-free", displayName: "Mimo" },
    ]);
    fresh.info.currentModel = "mimo-v2.5-free";
    fresh.lastUpdated = 2;
    const byRuntimeId = {
      [`${agentUuid}::session-a`]: stale,
      [`${agentUuid}::session-b`]: fresh,
    };
    expect(resolveRuntimeStateEntryForAgent(agentUuid, byRuntimeId)?.info.currentModel).toBe(
      "mimo-v2.5-free",
    );
  });

  it("ignores stale DB session hint and falls back to any live attachment", () => {
    const agentUuid = "b3cbc44e-0000-4000-8000-000000000001";
    const live = entry(agentUuid, "session-1");
    const byRuntimeId = {
      [`${agentUuid}::session-1`]: live,
      "stale-db-uuid": entry("other-agent", "other-session"),
    };
    expect(resolveRuntimeStateEntryForAgent(agentUuid, byRuntimeId, "stale-db-uuid")).toBe(live);
    expect(resolveRuntimeIdForAgent(agentUuid, byRuntimeId, "stale-db-uuid")).toBe("session-1");
  });

  it("returns session id from the matched attachment", () => {
    const agentUuid = "b3cbc44e-0000-4000-8000-000000000001";
    const byRuntimeId = attachmentStore(agentUuid, "session-1", [
      { id: "opencode/big-pickle", displayName: "Big Pickle" },
    ]);
    expect(resolveRuntimeIdForAgent(agentUuid, byRuntimeId)).toBe("session-1");
  });

  it("falls back to DB runtime id when no retain exists yet", () => {
    expect(resolveRuntimeIdForAgent("a-1", {}, "rt-from-db")).toBe("rt-from-db");
  });

  it("derives backend type from runtime agent type", () => {
    expect(backendTypeFromRuntimeEntry(entry("a", "a"), null)).toBe("opencode");
  });
});

describe("agentModelIdsMatch", () => {
  it("treats prefixed and short ids as the same model", () => {
    const available = [{ id: "big-pickle", displayName: "Big Pickle" }];
    expect(agentModelIdsMatch("opencode/big-pickle", "big-pickle", available)).toBe(true);
  });
});

describe("agentModelDisplayLabel", () => {
  it("prefers exact id row over earlier fuzzy alias in the list", () => {
    const available = [
      { id: "alibaba-cn/qwen3-coder-plus", displayName: "Alibaba (China)/QwQ Plus" },
      { id: "opencode/mimo-v2.5-free (medium)", displayName: "OpenCode Zen/MiMo V2.5 Free (medium)" },
    ];
    expect(agentModelDisplayLabel("opencode/mimo-v2.5-free (medium)", available)).toBe(
      "OpenCode Zen/MiMo V2.5 Free (medium)",
    );
  });
});

describe("selectAgentModel — canonical model resolver", () => {
  const agentUuid = "agent-mac";
  const sessionId = "session-1";
  const available = [
    { id: "big-pickle", displayName: "Big Pickle" },
    { id: "mimo-v2.5-free", displayName: "Mimo" },
  ];
  const byRuntimeId = {
    [`${agentUuid}::${sessionId}`]: {
      ...entry(agentUuid, sessionId, available),
      info: { ...entry(agentUuid, sessionId, available).info, currentModel: "big-pickle" },
    },
  };

  it("pick always wins over MQTT retain — regression test for 弹回去 bug", () => {
    useAgentModelPickStore.getState().setPick(sessionId, agentUuid, "mimo-v2.5-free");
    const res = selectAgentModel({ sessionId, agentId: agentUuid, available, byRuntimeId });
    expect(res.source).toBe("pick");
    expect(res.modelId).toBe("mimo-v2.5-free");
  });

  it("falls back to retain when there is no user pick", () => {
    const res = selectAgentModel({ sessionId, agentId: agentUuid, available, byRuntimeId });
    expect(res.source).toBe("retain");
    expect(res.modelId).toBe("big-pickle");
  });

  it("falls back to provider/model key when neither pick nor retain available", () => {
    const empty = {
      ...byRuntimeId,
      [`${agentUuid}::${sessionId}`]: {
        ...byRuntimeId[`${agentUuid}::${sessionId}`],
        info: { ...byRuntimeId[`${agentUuid}::${sessionId}`].info, currentModel: "" },
      },
    };
    const res = selectAgentModel({
      sessionId,
      agentId: agentUuid,
      available,
      byRuntimeId: empty,
      providerFallback: "openai/gpt-4o",
    });
    expect(res.source).toBe("fallback");
    expect(res.modelId).toBe("openai/gpt-4o");
  });

  it("falls back to provider fallback when neither pick nor retain available", () => {
    const empty = {
      ...byRuntimeId,
      [`${agentUuid}::${sessionId}`]: {
        ...byRuntimeId[`${agentUuid}::${sessionId}`],
        info: { ...byRuntimeId[`${agentUuid}::${sessionId}`].info, currentModel: "" },
      },
    };
    const res = selectAgentModel({
      sessionId,
      agentId: agentUuid,
      available,
      byRuntimeId: empty,
      providerFallback: "mimo-v2.5-free",
    });
    expect(res.source).toBe("fallback");
    expect(res.modelId).toBe("mimo-v2.5-free");
  });

  it("returns none when nothing can be resolved", () => {
    const res = selectAgentModel({
      sessionId: null,
      agentId: agentUuid,
      available: [],
      byRuntimeId: {},
    });
    expect(res.source).toBe("none");
    expect(res.modelId).toBe("");
  });

  it("defaults to the first advertised model when no higher-priority source exists", () => {
    const emptyRetain = {
      [`${agentUuid}::${sessionId}`]: {
        ...entry(agentUuid, sessionId, available),
        info: { ...entry(agentUuid, sessionId, available).info, currentModel: "" },
      },
    };
    const res = selectAgentModel({
      sessionId,
      agentId: agentUuid,
      available,
      byRuntimeId: emptyRetain,
    });
    expect(res.source).toBe("fallback");
    expect(res.modelId).toBe("big-pickle");
  });

  it("canonicalizes short pick to advertised prefixed id", () => {
    useAgentModelPickStore.getState().setPick(sessionId, agentUuid, "mimo-v2.5-free");
    const prefixed = [{ id: "opencode/mimo-v2.5-free", displayName: "Mimo" }];
    const prefixByRuntime = {
      [`${agentUuid}::${sessionId}`]: {
        ...entry(agentUuid, sessionId, prefixed),
        info: { ...entry(agentUuid, sessionId, prefixed).info, currentModel: "" },
      },
    };
    const res = selectAgentModel({
      sessionId,
      agentId: agentUuid,
      available: prefixed,
      byRuntimeId: prefixByRuntime,
    });
    expect(res.source).toBe("pick");
    expect(res.modelId).toBe("opencode/mimo-v2.5-free");
  });

  it("ignores empty session id when reading pick", () => {
    useAgentModelPickStore.getState().setPick(sessionId, agentUuid, "mimo-v2.5-free");
    const res = selectAgentModel({
      sessionId: "",
      agentId: agentUuid,
      available,
      byRuntimeId,
    });
    expect(res.source).toBe("retain");
    expect(res.modelId).toBe("big-pickle");
  });
});

describe("resolveSetModelId", () => {
  it("uses short id when retain advertises short ids", () => {
    const byRuntimeId = attachmentStore("agent-mac", "session-1", [
      { id: "big-pickle", displayName: "Big Pickle" },
    ]);
    expect(resolveSetModelId("agent-mac", "opencode/big-pickle", byRuntimeId)).toBe(
      "big-pickle",
    );
  });
});

describe("resolvePermissionCommandTarget", () => {
  it("prefers session runtime row over fresher stale retain", () => {
    const byRuntimeId = {
      "stale-spawn": {
        ...entry("agent-a", "stale-spawn", [], RuntimeLifecycle.STOPPED),
        lastUpdated: Date.now() + 10_000,
      },
      "live-spawn": entry("agent-a", "live-spawn"),
    };
    const target = resolvePermissionCommandTarget({
      agentActorId: "agent-a",
      sessionRuntimeRows: [{ agent_id: "agent-a", runtime_id: "live-spawn" }],
      byRuntimeId,
    });
    expect(target).toEqual({ actorId: "agent-a", runtimeId: "live-spawn" });
  });

  it("prefers live MQTT retain when it is registered for the session and DB row is stale", () => {
    const byRuntimeId = {
      "live-spawn": entry("agent-a", "live-spawn"),
    };
    const target = resolvePermissionCommandTarget({
      agentActorId: "agent-a",
      sessionRuntimeRows: [
        { agent_id: "agent-a", runtime_id: "stale-spawn" },
        { agent_id: "agent-a", runtime_id: "live-spawn" },
      ],
      byRuntimeId,
    });
    expect(target).toEqual({ actorId: "agent-a", runtimeId: "live-spawn" });
  });

  it("does not follow MQTT retain from another session when DB row disagrees", () => {
    const byRuntimeId = {
      "other-session-spawn": entry("agent-a", "other-session-spawn"),
    };
    const target = resolvePermissionCommandTarget({
      agentActorId: "agent-a",
      sessionRuntimeRows: [{ agent_id: "agent-a", runtime_id: "session-spawn" }],
      byRuntimeId,
    });
    expect(target).toEqual({ actorId: "agent-a", runtimeId: "session-spawn" });
  });

  it("does not follow MQTT retain from another session when agent has no DB row", () => {
    const byRuntimeId = {
      "other-session-spawn": entry("agent-a", "other-session-spawn"),
    };
    const target = resolvePermissionCommandTarget({
      agentActorId: "agent-a",
      sessionRuntimeRows: [{ agent_id: "agent-b", runtime_id: "agent-b-spawn" }],
      byRuntimeId,
    });
    expect(target).toBeNull();
  });

  it("fails closed when session DB hint is dead and live retain is outside the session", () => {
    const byRuntimeId = {
      "rt-stale": entry("agent-a", "rt-stale", [], RuntimeLifecycle.STOPPED),
      "rt-live": entry("agent-a", "rt-live"),
    };
    const target = resolvePermissionCommandTarget({
      agentActorId: "agent-a",
      sessionRuntimeRows: [{ agent_id: "agent-a", runtime_id: "rt-stale" }],
      byRuntimeId,
    });
    expect(target).toBeNull();
  });

  it("hops to another live retain only when it is also registered for the session", () => {
    const byRuntimeId = {
      "rt-stale": entry("agent-a", "rt-stale", [], RuntimeLifecycle.STOPPED),
      "rt-live": entry("agent-a", "rt-live"),
    };
    const target = resolvePermissionCommandTarget({
      agentActorId: "agent-a",
      sessionRuntimeRows: [
        { agent_id: "agent-a", runtime_id: "rt-stale" },
        { agent_id: "agent-a", runtime_id: "rt-live" },
      ],
      byRuntimeId,
    });
    expect(target).toEqual({ actorId: "agent-a", runtimeId: "rt-live" });
  });

  it("fails closed instead of hopping to another session's live retain when this session has no rows", () => {
    // The former fast path passed sessionRuntimeRows: [] and let the resolver
    // pick "the agent's latest live retain", which could cancel a DIFFERENT
    // session's turn. With no session-scoped row, resolution must return null.
    const byRuntimeId = {
      "other-session-spawn": entry("agent-a", "other-session-spawn"),
    };
    const target = resolvePermissionCommandTarget({
      agentActorId: "agent-a",
      sessionRuntimeRows: [],
      byRuntimeId,
    });
    expect(target).toBeNull();
  });
});

describe("resolveCommandRuntimeId", () => {
  it("prefers live MQTT retain when DB hint is dead and live id is in session scope", () => {
    const byRuntimeId = {
      "rt-stale": entry("agent-a", "rt-stale", [], RuntimeLifecycle.STOPPED),
      "rt-live": entry("agent-a", "rt-live"),
    };
    expect(
      resolveCommandRuntimeId({
        agentId: "agent-a",
        dbRuntimeId: "rt-stale",
        byRuntimeId,
        sessionRuntimeIds: new Set(["rt-stale", "rt-live"]),
      }),
    ).toBe("rt-live");
  });

  it("does not hop to an out-of-session live retain when DB hint is dead", () => {
    const byRuntimeId = {
      "rt-stale": entry("agent-a", "rt-stale", [], RuntimeLifecycle.STOPPED),
      "rt-live": entry("agent-a", "rt-live"),
    };
    expect(
      resolveCommandRuntimeId({
        agentId: "agent-a",
        dbRuntimeId: "rt-stale",
        byRuntimeId,
        sessionRuntimeIds: new Set(["rt-stale"]),
      }),
    ).toBeUndefined();
  });

  it("returns undefined when DB hint and all MQTT retains are dead", () => {
    const byRuntimeId = {
      "rt-db": entry("agent-a", "rt-db", [], RuntimeLifecycle.STOPPED),
    };
    expect(
      resolveCommandRuntimeId({
        agentId: "agent-a",
        dbRuntimeId: "rt-db",
        byRuntimeId,
      }),
    ).toBeUndefined();
  });

  it("prefers a newer live attachment over a stale db hint when no session scope", () => {
    const now = Date.now();
    const byRuntimeId = {
      ...attachmentStore("agent-a", "session-stale", [], RuntimeLifecycle.ACTIVE, now - 1000),
      ...attachmentStore("agent-a", "session-live", [], RuntimeLifecycle.ACTIVE, now),
    };
    expect(
      resolveCommandRuntimeId({
        agentId: "agent-a",
        dbRuntimeId: "session-stale",
        byRuntimeId,
      }),
    ).toBe("session-live");
  });
});

describe("normalizeAgentModelId", () => {
  it("maps short picker ids to advertised ACP model ids", () => {
    const byRuntimeId = attachmentStore("agent-mac", "session-1", [
      { id: "opencode/mimo-v2.5-free", displayName: "Mimo" },
    ]);
    expect(normalizeAgentModelId("agent-mac", "mimo-v2.5-free", byRuntimeId)).toBe(
      "opencode/mimo-v2.5-free",
    );
  });
});
