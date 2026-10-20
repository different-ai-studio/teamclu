import type { ConnectedAgent } from "./connected-agent-types";

export type ConnectedAgentsCacheDb = {
  runAsync: (sql: string, ...params: unknown[]) => Promise<unknown>;
  getAllAsync: (sql: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
};

export type ConnectedAgentsCache = {
  loadCache: (teamId: string) => Promise<ConnectedAgent[]>;
  saveCache: (teamId: string, agents: ConnectedAgent[]) => Promise<void>;
};

export function createConnectedAgentsCache(db: ConnectedAgentsCacheDb): ConnectedAgentsCache {
  // A save is a DELETE followed by one INSERT per agent, with awaits between.
  // A reload racing a presence update ran two of them at once, interleaved the
  // statements, inserted the same (team_id, agent_id) twice and surfaced as an
  // unhandled UNIQUE-constraint rejection. Saves now run one at a time.
  let saveChain: Promise<void> = Promise.resolve();

  async function writeCache(teamId: string, agents: ConnectedAgent[]) {
    await db.runAsync(`DELETE FROM connected_agents WHERE team_id = ?`, teamId);
    const now = Date.now();
    for (const a of agents) {
      // OR REPLACE: a list carrying the same agent twice must not abort the save.
      await db.runAsync(
        `INSERT OR REPLACE INTO connected_agents (
           team_id, agent_id, display_name, agent_types, default_agent_type, permission_level,
           visibility, is_owner, device_id, last_active_at, current_model, status, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        teamId, a.agentId, a.displayName, JSON.stringify(a.agentTypes), a.defaultAgentType, a.permissionLevel,
        a.visibility, a.isOwner ? 1 : 0,
        // legacy device_id column retained in the local cache schema; routing
        // now uses agentId (== actor id), so this is no longer populated.
        null,
        a.lastActiveAt ? Date.parse(a.lastActiveAt) : null,
        null, null, now,
      );
    }
  }

  return {
    async loadCache(teamId) {
      const rows = await db.getAllAsync(`SELECT * FROM connected_agents WHERE team_id = ?`, teamId);
      return rows.map((r) => ({
        agentId: String(r.agent_id),
        displayName: String(r.display_name),
        agentTypes: typeof r.agent_types === "string" ? JSON.parse(r.agent_types) : [],
        defaultAgentType: r.default_agent_type != null ? String(r.default_agent_type) : null,
        permissionLevel: String(r.permission_level),
        visibility: r.visibility === "personal" ? "personal" : "team",
        isOwner: r.is_owner === 1 || r.is_owner === true,
        lastActiveAt: r.last_active_at != null ? new Date(Number(r.last_active_at)).toISOString() : null,
      }));
    },
    saveCache(teamId, agents) {
      const next = saveChain.then(() => writeCache(teamId, agents));
      // Keep the chain alive after a failed save; the caller still sees the error.
      saveChain = next.catch(() => {});
      return next;
    },
  };
}
