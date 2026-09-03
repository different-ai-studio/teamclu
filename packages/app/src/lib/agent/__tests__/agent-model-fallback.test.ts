import { describe, expect, it } from "vitest";
import {
  agentAvailableModelsWithLocalCatalog,
  localRecentModelFallback,
  resolveAgentCatalogModels,
} from "@/lib/agent/agent-model-fallback";
import type { RuntimeInfo } from "@/lib/proto/amux_pb";

const LOCAL = "local-daemon-actor";
const REMOTE = "some-other-agent";

function runtimeInfo(modelIds: string[]): RuntimeInfo {
  return {
    availableModels: modelIds.map((id) => ({ id, displayName: id })),
  } as unknown as RuntimeInfo;
}

describe("localRecentModelFallback", () => {
  const available = [
    { id: "anthropic/claude-haiku-4-5-20251001", displayName: "Haiku" },
    { id: "minimax-cn/MiniMax-M2", displayName: "MiniMax" },
  ];

  it("returns the newest MRU entry that the agent still offers", () => {
    expect(
      localRecentModelFallback({
        agentId: LOCAL,
        localDaemonActorId: LOCAL,
        recentModels: ["gone/model", "anthropic/claude-haiku-4-5-20251001"],
        available,
      }),
    ).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("stays empty for a remote agent — this device's history is not its history", () => {
    expect(
      localRecentModelFallback({
        agentId: REMOTE,
        localDaemonActorId: LOCAL,
        recentModels: ["anthropic/claude-haiku-4-5-20251001"],
        available,
      }),
    ).toBe("");
  });

  it("stays empty when the local daemon identity is not known yet", () => {
    expect(
      localRecentModelFallback({
        agentId: LOCAL,
        localDaemonActorId: null,
        recentModels: ["anthropic/claude-haiku-4-5-20251001"],
        available,
      }),
    ).toBe("");
  });
});

describe("agentAvailableModelsWithLocalCatalog", () => {
  it("prefers the runtime retain when it has landed", () => {
    const models = agentAvailableModelsWithLocalCatalog({
      agentId: LOCAL,
      localDaemonActorId: LOCAL,
      runtimeInfo: runtimeInfo(["from/retain"]),
      catalogModels: [{ id: "from/catalog", displayName: "catalog" }],
    });
    expect(models.map((m) => m.id)).toEqual(["from/retain"]);
  });

  it("falls back to the loopback catalog for the local agent — the cold-start case", () => {
    const models = agentAvailableModelsWithLocalCatalog({
      agentId: LOCAL,
      localDaemonActorId: LOCAL,
      runtimeInfo: undefined,
      catalogModels: [{ id: "from/catalog", displayName: "catalog" }],
    });
    expect(models.map((m) => m.id)).toEqual(["from/catalog"]);
  });

  it("does not lend the local catalog to a remote agent", () => {
    const models = agentAvailableModelsWithLocalCatalog({
      agentId: REMOTE,
      localDaemonActorId: LOCAL,
      runtimeInfo: undefined,
      catalogModels: [{ id: "from/catalog", displayName: "catalog" }],
    });
    expect(models).toEqual([]);
  });

  it("falls back to MQTT default workspace catalog for a remote agent", () => {
    const models = agentAvailableModelsWithLocalCatalog({
      agentId: REMOTE,
      localDaemonActorId: LOCAL,
      runtimeInfo: undefined,
      catalogModels: [{ id: "from/catalog", displayName: "catalog" }],
      remoteDefaultCatalogModels: [{ id: "from/mqtt", displayName: "mqtt" }],
    });
    expect(models.map((m) => m.id)).toEqual(["from/mqtt"]);
  });
});

describe("resolveAgentCatalogModels", () => {
  it("draft local agent uses selected workspace loopback catalog only", () => {
    const models = resolveAgentCatalogModels({
      agentId: LOCAL,
      localDaemonActorId: LOCAL,
      sessionId: null,
      byRuntimeId: {},
      runtimeInfo: runtimeInfo(["from/retain"]),
      localWorkspaceCatalogModels: [{ id: "from/http", displayName: "http" }],
      remoteDefaultCatalogModels: [{ id: "from/mqtt", displayName: "mqtt" }],
    });
    expect(models.map((m) => m.id)).toEqual(["from/http"]);
  });

  it("draft remote agent uses default workspace catalog from actor state", () => {
    const models = resolveAgentCatalogModels({
      agentId: REMOTE,
      localDaemonActorId: LOCAL,
      sessionId: null,
      byRuntimeId: {},
      runtimeInfo: runtimeInfo(["from/retain"]),
      localWorkspaceCatalogModels: [{ id: "from/http", displayName: "http" }],
      remoteDefaultCatalogModels: [{ id: "from/mqtt", displayName: "mqtt" }],
    });
    expect(models.map((m) => m.id)).toEqual(["from/mqtt"]);
  });

  it("attached remote agent falls back to default workspace catalog when retain is empty", () => {
    const models = resolveAgentCatalogModels({
      agentId: REMOTE,
      localDaemonActorId: LOCAL,
      sessionId: "session-1",
      byRuntimeId: {
        [`${REMOTE}::session-1`]: {
          daemonActorId: REMOTE,
          lastUpdated: 1,
          info: runtimeInfo([]),
        },
      },
      runtimeInfo: runtimeInfo([]),
      localWorkspaceCatalogModels: [{ id: "from/http", displayName: "http" }],
      remoteDefaultCatalogModels: [{ id: "from/mqtt", displayName: "mqtt" }],
    });
    expect(models.map((m) => m.id)).toEqual(["from/mqtt"]);
  });
});
