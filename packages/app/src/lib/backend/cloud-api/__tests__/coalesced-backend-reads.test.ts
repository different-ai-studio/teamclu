import { describe, expect, it, vi } from "vitest";
import { createActorsModule } from "@/lib/backend/cloud-api/actors";
import { CloudApiError, type CloudApiClient } from "@/lib/backend/cloud-api/http";
import { createSessionMembersModule } from "@/lib/backend/cloud-api/session-members";
import { createTeamWorkspaceConfigModule } from "@/lib/backend/cloud-api/team-workspace-config";

type Method = (...args: unknown[]) => Promise<unknown>;

function client(methods: Partial<Record<"get" | "post" | "patch" | "put" | "delete", Method>>) {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected ${name}`);
  };
  return {
    get: methods.get ?? unexpected("get"),
    post: methods.post ?? unexpected("post"),
    patch: methods.patch ?? unexpected("patch"),
    put: methods.put ?? unexpected("put"),
    delete: methods.delete ?? unexpected("delete"),
    postRaw: unexpected("postRaw"),
    getRaw: unexpected("getRaw"),
  } as unknown as CloudApiClient;
}

const roster = { items: [{ sessionId: "s1", actorId: "a1", actorType: "agent", displayName: "Agent" }] };

describe("session roster reads", () => {
  it("serves a burst of reads for one session with one request", async () => {
    const get = vi.fn(async () => roster);
    const members = createSessionMembersModule(client({ get }));

    const [a, b, c] = await Promise.all([
      members.listParticipants("s1"),
      members.listParticipants("s1"),
      members.listParticipants("s1"),
    ]);

    expect(get).toHaveBeenCalledTimes(1);
    expect(a.map((r) => r.id)).toEqual(["a1"]);
    expect(b).not.toBe(a);
    expect(c[0]).not.toBe(a[0]);
  });

  it("asks again after an empty roster", async () => {
    const get = vi.fn(async () => ({ items: [] }));
    const members = createSessionMembersModule(client({ get }));
    await members.listParticipants("s1");
    await members.listParticipants("s1");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("adding or removing a participant is seen by the next read", async () => {
    const get = vi.fn(async () => roster);
    const members = createSessionMembersModule(
      client({ get, post: vi.fn(async () => ({})), delete: vi.fn(async () => undefined) }),
    );

    await members.listParticipants("s1");
    await members.addParticipant("s1", "a2");
    await members.listParticipants("s1");
    await members.removeParticipant("s1", "a2");
    await members.listParticipants("s1");

    expect(get).toHaveBeenCalledTimes(3);
  });

  it("a change made elsewhere is seen once the roster is forgotten", async () => {
    const get = vi.fn(async () => roster);
    const members = createSessionMembersModule(client({ get }));

    await members.listParticipants("s1");
    members.forgetParticipants?.("s1");
    await members.listParticipants("s1");

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("goes to the network when the caller asks for a fresh roster", async () => {
    const get = vi.fn(async () => roster);
    const members = createSessionMembersModule(client({ get }));
    await members.listParticipants("s1");
    await members.listParticipants("s1", { fresh: true });
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("connected agent reads", () => {
  const connected = {
    items: [{ id: "ag1", teamId: "t1", kind: "agent", displayName: "Mac", agentId: "ag1", isOwner: true }],
  };

  it("serves a burst for one team with one request", async () => {
    const get = vi.fn(async () => connected);
    const actors = createActorsModule(client({ get }));

    const [a, b] = await Promise.all([actors.listConnectedAgents("t1"), actors.listConnectedAgents("t1")]);

    expect(get).toHaveBeenCalledTimes(1);
    expect(a[0].is_owner).toBe(true);
    expect(b).not.toBe(a);
  });

  it("asks again while no agent is connected", async () => {
    const get = vi.fn(async () => ({ items: [] }));
    const actors = createActorsModule(client({ get }));
    await actors.listConnectedAgents("t1");
    await actors.listConnectedAgents("t1");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("a write through the module is seen by the next read", async () => {
    const get = vi.fn(async () => connected);
    const actors = createActorsModule(client({ get, post: vi.fn(async () => ({})) }));

    await actors.listConnectedAgents("t1");
    await actors.upsertAgentAccess({ agentId: "ag1", memberId: "m1", permissionLevel: "prompt" });
    await actors.listConnectedAgents("t1");

    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("team LLM config reads", () => {
  const llm = { llm: { enabled: true, baseUrl: "https://gw", models: [{ id: "m", name: "M" }] } };

  it("serves a burst for one team with one request", async () => {
    const get = vi.fn(async () => llm);
    const config = createTeamWorkspaceConfigModule(client({ get }));

    const [a, b] = await Promise.all([config.loadLlmConfig("t1"), config.loadLlmConfig("t1")]);

    expect(get).toHaveBeenCalledTimes(1);
    expect(a?.baseUrl).toBe("https://gw");
    expect(b).not.toBe(a);
  });

  it("does not share the model list between callers", async () => {
    const get = vi.fn(async () => llm);
    const config = createTeamWorkspaceConfigModule(client({ get }));

    const [a, b] = await Promise.all([config.loadLlmConfig("t1"), config.loadLlmConfig("t1")]);
    a!.models.length = 0;

    expect(b?.models).toHaveLength(1);
    expect(llm.llm.models).toHaveLength(1);
  });

  it("shares a team with no config as null", async () => {
    const get = vi.fn(async () => {
      throw new CloudApiError(404, "not_found", "no config", null);
    });
    const config = createTeamWorkspaceConfigModule(client({ get }));

    expect(await config.loadLlmConfig("t1")).toBeNull();
    expect(await config.loadLlmConfig("t1")).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("saving is seen by the next read", async () => {
    const get = vi.fn(async () => llm);
    const config = createTeamWorkspaceConfigModule(client({ get, put: vi.fn(async () => ({})) }));

    await config.loadLlmConfig("t1");
    await config.saveLlmConfig("t1", { enabled: true, baseUrl: "https://gw2", models: [] });
    await config.loadLlmConfig("t1");

    expect(get).toHaveBeenCalledTimes(2);
  });
});
