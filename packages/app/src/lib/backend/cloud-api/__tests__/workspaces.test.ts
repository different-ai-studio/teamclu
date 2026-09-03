import { describe, expect, it } from "vitest";
import { createWorkspacesModule } from "@/lib/backend/cloud-api/workspaces";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

function mockClient(responses: Record<string, unknown>): CloudApiClient {
  return {
    async get(path) {
      const key = Object.keys(responses).find((k) => k === `GET ${path}` || path.startsWith(k.replace("GET ", "")));
      if (key) return responses[key] as never;
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path) {
      const key = `POST ${path}`;
      if (key in responses) return responses[key] as never;
      throw new Error(`unexpected POST ${path}`);
    },
    async patch(path) {
      const key = Object.keys(responses).find((k) => k.startsWith("PATCH ") && path.startsWith(k.replace("PATCH ", "")));
      if (key) return responses[key] as never;
      throw new Error(`unexpected PATCH ${path}`);
    },
    async put() { throw new Error("unexpected put"); },
    async delete() { throw new Error("unexpected delete"); },
    async postRaw() { throw new Error("not implemented"); },
    async getRaw() { throw new Error("not implemented"); },
  } as unknown as CloudApiClient;
}

const cloudWorkspace = { id: "w1", teamId: "t1", name: "Alpha", archived: false, createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" };

describe("workspaces module", () => {
  it("listDaemonWorkspaces calls /v1/workspaces and maps fields", async () => {
    const client = mockClient({
      "GET /v1/workspaces?teamId=t1&limit=200": {
        items: [{
          ...cloudWorkspace,
          slug: "/Users/me/TeamClu",
          agentId: "agent-1",
        }],
        nextCursor: null,
      },
    });
    const mod = createWorkspacesModule(client);
    const out = await mod.listDaemonWorkspaces("t1");
    expect(out[0].id).toBe("w1");
    expect(out[0].team_id).toBe("t1");
    expect(out[0].path).toBe("/Users/me/TeamClu");
    expect(out[0].agent_id).toBe("agent-1");
    expect(out[0].archived).toBe(false);
  });

  it("createDaemonWorkspace calls POST /v1/workspaces", async () => {
    const client = mockClient({ "POST /v1/workspaces": cloudWorkspace });
    const mod = createWorkspacesModule(client);
    const out = await mod.createDaemonWorkspace({ teamId: "t1", agentId: "a1", createdByMemberId: null, name: "Alpha", path: "/tmp" });
    expect(out.id).toBe("w1");
  });

  it("updateDaemonWorkspace calls PATCH /v1/workspaces/:id", async () => {
    const updated = { ...cloudWorkspace, name: "Beta", archived: true };
    const client = mockClient({ "PATCH /v1/workspaces/w1": updated });
    const mod = createWorkspacesModule(client);
    const out = await mod.updateDaemonWorkspace({ workspaceId: "w1", name: "Beta", path: "/tmp", archived: true });
    expect(out.name).toBe("Beta");
    expect(out.archived).toBe(true);
  });

  it("listWorkspacesByIds returns [] for empty input", async () => {
    const client = mockClient({});
    const mod = createWorkspacesModule(client);
    const out = await mod.listWorkspacesByIds("t1", []);
    expect(out).toEqual([]);
  });
});
