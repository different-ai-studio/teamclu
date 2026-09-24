import { describe, expect, it, vi } from "vitest";

import { createAgentAccessApi } from "../features/actors/agent-access-api";

function api(fetchImpl: ReturnType<typeof vi.fn>) {
  return createAgentAccessApi({
    baseUrl: "https://cloud.test",
    getAccessToken: async () => "tok",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe("createAgentAccessApi", () => {
  it("listConnectedAgents GETs and maps the cloud shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "a1",
              displayName: "Claude",
              agentTypes: ["claude", "opencode"],
              defaultAgentType: "claude",
              permissionLevel: "team",
              visibility: "team",
              isOwner: true,
              lastActiveAt: "2026-05-20T10:00:00.000Z",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const rows = await api(fetchImpl).listConnectedAgents("team1");
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.test/v1/teams/team1/agents/connected");
    expect(rows[0]).toEqual({
      agentId: "a1",
      displayName: "Claude",
      agentTypes: ["claude", "opencode"],
      defaultAgentType: "claude",
      permissionLevel: "team",
      visibility: "team",
      isOwner: true,
      lastActiveAt: "2026-05-20T10:00:00.000Z",
    });
  });

  it("shareAgentToTeam throws when the Cloud API rejects", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "denied" } }), { status: 403 }),
    );
    await expect(api(fetchImpl).shareAgentToTeam("a1")).rejects.toThrow("denied");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.test/v1/agents/a1/share-to-team");
    expect(init.method).toBe("POST");
  });

  it("listAuthorizedHumans filters members and maps access rows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              actorId: "m2",
              memberName: "Ada",
              role: "prompt",
              grantedByMemberId: "m1",
              lastActiveAt: "2026-05-20T10:00:00.000Z",
              actorType: "member",
            },
            { actorId: "agent-x", memberName: "Bot", role: "auto", actorType: "agent" },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(api(fetchImpl).listAuthorizedHumans("agent-1")).resolves.toEqual([
      {
        id: "m2",
        displayName: "Ada",
        permissionLevel: "prompt",
        grantedByActorId: "m1",
        lastActiveAt: "2026-05-20T10:00:00.000Z",
      },
    ]);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://cloud.test/v1/agents/agent-1/access");
  });

  it("grantAuthorizedHuman POSTs actorId + role (grantedBy derived server-side)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await api(fetchImpl).grantAuthorizedHuman("agent-1", "m2", "prompt", "m1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.test/v1/agents/agent-1/access");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ actorId: "m2", role: "prompt" });
  });

  it("revokeAuthorizedHuman DELETEs the access row", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await api(fetchImpl).revokeAuthorizedHuman("agent-1", "m2");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.test/v1/agents/agent-1/access/m2");
    expect(init.method).toBe("DELETE");
  });

  it("canManageAgent is true only when the permission role is owner", async () => {
    const ownerFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ allowed: true, role: "owner" }), { status: 200 }),
    );
    await expect(api(ownerFetch).canManageAgent("agent-1", "m1")).resolves.toBe(true);
    expect(ownerFetch.mock.calls[0][0]).toBe(
      "https://cloud.test/v1/agents/agent-1/permission?actorId=m1",
    );

    const adminFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ allowed: true, role: "admin" }), { status: 200 }),
    );
    await expect(api(adminFetch).canManageAgent("agent-1", "m1")).resolves.toBe(false);
  });

  it("agentAccessRole returns the role only when access is allowed", async () => {
    const adminFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ allowed: true, role: "admin" }), { status: 200 }),
    );
    await expect(api(adminFetch).agentAccessRole("agent-1", "m1")).resolves.toBe("admin");

    const deniedFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ allowed: false, role: "admin" }), { status: 200 }),
    );
    await expect(api(deniedFetch).agentAccessRole("agent-1", "m1")).resolves.toBeNull();
  });
});
