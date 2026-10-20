import { describe, expect, it } from "vitest";

import { createConnectedAgentsCache } from "../features/actors/connected-agents-cache";

function fakeDb() {
  const rows: any[] = [];
  return {
    rows,
    async runAsync(sql: string, ...params: unknown[]) {
      if (/^DELETE FROM connected_agents WHERE team_id = \?/i.test(sql)) {
        const [teamId] = params;
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].team_id === teamId) rows.splice(i, 1);
        return;
      }
      if (/^INSERT (OR REPLACE )?INTO connected_agents/i.test(sql)) {
        const [
          team_id, agent_id, display_name, agent_types, default_agent_type, permission_level,
          visibility, is_owner, device_id, last_active_at, current_model,
          status, updated_at,
        ] = params;
        rows.push({ team_id, agent_id, display_name, agent_types, default_agent_type, permission_level,
          visibility, is_owner, device_id, last_active_at, current_model, status, updated_at });
        return;
      }
      throw new Error("unhandled: " + sql);
    },
    async getAllAsync(_sql: string, ...params: unknown[]) {
      return rows.filter((r) => r.team_id === params[0]);
    },
  };
}

describe("connected-agents cache", () => {
  it("saveCache replaces all rows for a team", async () => {
    const db = fakeDb();
    const cache = createConnectedAgentsCache(db as any);
    await cache.saveCache("t1", [
      { agentId: "a1", displayName: "Claude", agentTypes: ["claude"],
        defaultAgentType: "claude",
        permissionLevel: "team", visibility: "team", isOwner: true,
        lastActiveAt: "2026-05-20T10:00:00.000Z" },
    ]);
    expect(db.rows.length).toBe(1);
    await cache.saveCache("t1", []);
    expect(db.rows.length).toBe(0);
  });
});

describe("connected agents cache — concurrent saves", () => {
  it("runs overlapping saves one after another so rows are never inserted twice", async () => {
    const rows = new Map<string, unknown>();
    const log: string[] = [];
    const db = {
      async runAsync(sql: string, ...params: unknown[]) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (sql.startsWith("DELETE")) {
          log.push("delete");
          rows.clear();
          return;
        }
        const key = `${params[0]}/${params[1]}`;
        if (rows.has(key) && !sql.includes("OR REPLACE")) throw new Error("UNIQUE constraint failed");
        log.push(`insert ${params[1]}`);
        rows.set(key, params);
      },
      async getAllAsync() {
        return [];
      },
    };
    const cache = createConnectedAgentsCache(db);
    const agent = (agentId: string) => ({
      agentId, displayName: agentId, agentTypes: ["pi"], defaultAgentType: "pi",
      permissionLevel: "owner", visibility: "team" as const, isOwner: true, lastActiveAt: null,
    });
    await Promise.all([
      cache.saveCache("t", [agent("a"), agent("b")]),
      cache.saveCache("t", [agent("a"), agent("b")]),
    ]);
    expect(log).toEqual(["delete", "insert a", "insert b", "delete", "insert a", "insert b"]);
    expect(rows.size).toBe(2);
  });
});
