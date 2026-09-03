import { describe, expect, it } from "vitest";
import { createActorsModule } from "@/lib/backend/cloud-api/actors";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

interface MockClient extends CloudApiClient {
  lastPutBody: unknown;
}

function mockClient(responses: Record<string, unknown>): MockClient {
  let lastPutBody: unknown = undefined;
  const client = {
    async get(path: string) {
      const key = Object.keys(responses).find((k) => k.startsWith("GET ") && (k === `GET ${path}` || path.startsWith(k.replace("GET ", ""))));
      if (key) return responses[key] as never;
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path: string) {
      const key = `POST ${path}`;
      if (key in responses) return responses[key] as never;
      throw new Error(`unexpected POST ${path}`);
    },
    async patch(path: string) {
      const key = Object.keys(responses).find((k) => k === `PATCH ${path}` || (k.startsWith("PATCH ") && path.startsWith(k.replace("PATCH ", ""))));
      if (key) return responses[key] as never;
      return undefined as never;
    },
    async put(path: string, body?: unknown) {
      lastPutBody = body;
      const key = `PUT ${path}`;
      if (key in responses) return responses[key] as never;
      throw new Error(`unexpected PUT ${path}`);
    },
    async delete() { return undefined as never; },
    async postRaw() { throw new Error("not impl"); },
    async getRaw() { throw new Error("not impl"); },
    get lastPutBody() { return lastPutBody; },
  } as unknown as MockClient;
  return client;
}

const cloudActor = { id: "actor-1", teamId: "team-1", kind: "member", displayName: "Alice", avatarUrl: null };

describe("actors module", () => {
  it("listActorDirectory maps agentOwnerMemberId", async () => {
    const client = mockClient({
      "GET /v1/teams/team-1/actors?limit=500": {
        items: [{ ...cloudActor, kind: "agent", visibility: "personal", agentOwnerMemberId: "owner-1" }],
        nextCursor: null,
      },
    });
    const mod = createActorsModule(client);
    const out = await mod.listActorDirectory("team-1");
    expect(out[0].agent_owner_member_id).toBe("owner-1");
  });

  it("listActorDirectory calls /v1/teams/:teamId/actors and maps fields", async () => {
    const client = mockClient({ "GET /v1/teams/team-1/actors?limit=500": { items: [cloudActor], nextCursor: null } });
    const mod = createActorsModule(client);
    const out = await mod.listActorDirectory("team-1");
    expect(out[0].id).toBe("actor-1");
    expect(out[0].team_id).toBe("team-1");
    expect(out[0].actor_type).toBe("member");
    expect(out[0].display_name).toBe("Alice");
  });

  it("listConnectedAgents calls /v1/teams/:teamId/agents/connected", async () => {
    const cloudAgent = { ...cloudActor, kind: "agent", agentId: "a-1" };
    const client = mockClient({ "GET /v1/teams/team-1/agents/connected": { items: [cloudAgent] } });
    const mod = createActorsModule(client);
    const out = await mod.listConnectedAgents("team-1");
    expect(out[0].id).toBe("actor-1");
    expect(out[0].agent_id).toBe("a-1");
  });

  it("listConnectedAgents forwards server-computed isOwner/permissionLevel (onboarding bind relies on it)", async () => {
    const owned = { ...cloudActor, kind: "agent", agentId: "a-own", isOwner: true, permissionLevel: "admin" };
    const other = { ...cloudActor, id: "actor-2", kind: "agent", agentId: "a-other", isOwner: false, permissionLevel: "view" };
    const client = mockClient({
      "GET /v1/teams/team-1/agents/connected": { items: [owned, other] },
    });
    const mod = createActorsModule(client);
    const out = await mod.listConnectedAgents("team-1");
    expect(out[0].is_owner).toBe(true);
    expect(out[0].permission_level).toBe("admin");
    expect(out[1].is_owner).toBe(false);
    // Mirrors the onboarding "bind existing" filter.
    expect(out.filter((r) => r.is_owner).map((r) => r.agent_id)).toEqual(["a-own"]);
  });

  it("listConnectedAgents defaults is_owner to false when the server omits it", async () => {
    const cloudAgent = { ...cloudActor, kind: "agent", agentId: "a-1" };
    const client = mockClient({ "GET /v1/teams/team-1/agents/connected": { items: [cloudAgent] } });
    const mod = createActorsModule(client);
    const out = await mod.listConnectedAgents("team-1");
    expect(out[0].is_owner).toBe(false);
  });

  it("listActorDirectoryByIds returns [] for empty input", async () => {
    const client = mockClient({});
    const mod = createActorsModule(client);
    const out = await mod.listActorDirectoryByIds([]);
    expect(out).toEqual([]);
  });

  it("listActorDirectoryByIds POSTs to /v1/actors/by-ids", async () => {
    const client = mockClient({ "POST /v1/actors/by-ids": { items: [cloudActor] } });
    const mod = createActorsModule(client);
    const out = await mod.listActorDirectoryByIds(["actor-1"]);
    expect(out[0].id).toBe("actor-1");
  });

  it("getMemberDefaultAgent GETs /v1/teams/:teamId/members/me/default-agent", async () => {
    const client = mockClient({
      "GET /v1/teams/team-1/members/me/default-agent": { defaultAgentId: "a-9" },
    });
    const mod = createActorsModule(client);
    expect(await mod.getMemberDefaultAgent("team-1")).toBe("a-9");
  });

  it("getMemberDefaultAgent returns null when unset", async () => {
    const client = mockClient({
      "GET /v1/teams/team-1/members/me/default-agent": { defaultAgentId: null },
    });
    const mod = createActorsModule(client);
    expect(await mod.getMemberDefaultAgent("team-1")).toBeNull();
  });

  it("setMemberDefaultAgent PUTs the agentId and returns the confirmed value", async () => {
    const client = mockClient({
      "PUT /v1/teams/team-1/members/me/default-agent": { defaultAgentId: "a-9" },
    });
    const mod = createActorsModule(client);
    expect(await mod.setMemberDefaultAgent("team-1", "a-9")).toBe("a-9");
    expect(client.lastPutBody).toEqual({ agentId: "a-9" });
  });

  it("setMemberDefaultAgent PUTs null to clear", async () => {
    const client = mockClient({
      "PUT /v1/teams/team-1/members/me/default-agent": { defaultAgentId: null },
    });
    const mod = createActorsModule(client);
    expect(await mod.setMemberDefaultAgent("team-1", null)).toBeNull();
    expect(client.lastPutBody).toEqual({ agentId: null });
  });

  it("getTeamDefaultAgent GETs /v1/teams/:teamId/default-agent", async () => {
    const client = mockClient({
      "GET /v1/teams/team-1/default-agent": { defaultAgentId: "a-99" },
    });
    const mod = createActorsModule(client);
    expect(await mod.getTeamDefaultAgent("team-1")).toBe("a-99");
  });

  it("getTeamDefaultAgent returns null when unset", async () => {
    const client = mockClient({
      "GET /v1/teams/team-1/default-agent": { defaultAgentId: null },
    });
    const mod = createActorsModule(client);
    expect(await mod.getTeamDefaultAgent("team-1")).toBeNull();
  });

  it("setTeamDefaultAgent PUTs the agentId to /v1/teams/:teamId/default-agent", async () => {
    const client = mockClient({
      "PUT /v1/teams/team-1/default-agent": { defaultAgentId: "a-99" },
    });
    const mod = createActorsModule(client);
    expect(await mod.setTeamDefaultAgent("team-1", "a-99")).toBe("a-99");
    expect(client.lastPutBody).toEqual({ agentId: "a-99" });
  });

  it("setTeamDefaultAgent PUTs null to clear the team default", async () => {
    const client = mockClient({
      "PUT /v1/teams/team-1/default-agent": { defaultAgentId: null },
    });
    const mod = createActorsModule(client);
    expect(await mod.setTeamDefaultAgent("team-1", null)).toBeNull();
    expect(client.lastPutBody).toEqual({ agentId: null });
  });

  it("getEffectiveDefaultAgent GETs /v1/teams/:teamId/members/me/effective-default-agent", async () => {
    const client = mockClient({
      "GET /v1/teams/team-1/members/me/effective-default-agent": { defaultAgentId: "a-77" },
    });
    const mod = createActorsModule(client);
    expect(await mod.getEffectiveDefaultAgent("team-1")).toBe("a-77");
  });

  it("getEffectiveDefaultAgent returns null when no default is set", async () => {
    const client = mockClient({
      "GET /v1/teams/team-1/members/me/effective-default-agent": { defaultAgentId: null },
    });
    const mod = createActorsModule(client);
    expect(await mod.getEffectiveDefaultAgent("team-1")).toBeNull();
  });

  it("getTeamDefaultAgent GETs /v1/teams/:teamId/default-agent", async () => {
    const client = mockClient({
      "GET /v1/teams/team-1/default-agent": { defaultAgentId: "a-99" },
    });
    const mod = createActorsModule(client);
    expect(await mod.getTeamDefaultAgent("team-1")).toBe("a-99");
  });

  it("getTeamDefaultAgent returns null when unset", async () => {
    const client = mockClient({
      "GET /v1/teams/team-1/default-agent": { defaultAgentId: null },
    });
    const mod = createActorsModule(client);
    expect(await mod.getTeamDefaultAgent("team-1")).toBeNull();
  });

  it("setTeamDefaultAgent PUTs the agentId to /v1/teams/:teamId/default-agent", async () => {
    const client = mockClient({
      "PUT /v1/teams/team-1/default-agent": { defaultAgentId: "a-99" },
    });
    const mod = createActorsModule(client);
    expect(await mod.setTeamDefaultAgent("team-1", "a-99")).toBe("a-99");
    expect(client.lastPutBody).toEqual({ agentId: "a-99" });
  });

  it("setTeamDefaultAgent PUTs null to clear the team default", async () => {
    const client = mockClient({
      "PUT /v1/teams/team-1/default-agent": { defaultAgentId: null },
    });
    const mod = createActorsModule(client);
    expect(await mod.setTeamDefaultAgent("team-1", null)).toBeNull();
    expect(client.lastPutBody).toEqual({ agentId: null });
  });

  it("getEffectiveDefaultAgent GETs /v1/teams/:teamId/members/me/effective-default-agent", async () => {
    const client = mockClient({
      "GET /v1/teams/team-1/members/me/effective-default-agent": { defaultAgentId: "a-77" },
    });
    const mod = createActorsModule(client);
    expect(await mod.getEffectiveDefaultAgent("team-1")).toBe("a-77");
  });

  it("getEffectiveDefaultAgent returns null when no default is set", async () => {
    const client = mockClient({
      "GET /v1/teams/team-1/members/me/effective-default-agent": { defaultAgentId: null },
    });
    const mod = createActorsModule(client);
    expect(await mod.getEffectiveDefaultAgent("team-1")).toBeNull();
  });
});
