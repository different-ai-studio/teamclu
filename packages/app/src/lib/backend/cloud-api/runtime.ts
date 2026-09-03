import type { AgentDefaultRow, RuntimeBackend } from "@/lib/backend/types";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

type CloudAgentDefault = {
  id: string;
  agentTypes?: string[] | null;
  defaultAgentType?: string | null;
};

// Everything else this module carried — runtime hints, targets, session models,
// the daemon runtime list — read `agent_runtimes`. That table is gone; the
// actor retain answers all of it now (ADR-0004).
export function createRuntimeModule(client: CloudApiClient): RuntimeBackend {
  return {
    async listAgentDefaults(agentActorIds) {
      if (agentActorIds.length === 0) return [];
      const params = new URLSearchParams();
      for (const id of agentActorIds) params.append("agentId", id);
      const out = await client.get<{ items: CloudAgentDefault[] }>(`/v1/runtime/agent-defaults?${params}`);
      return out.items.map((row): AgentDefaultRow => ({
        id: row.id,
        agent_types: row.agentTypes ?? null,
        default_agent_type: row.defaultAgentType ?? null,
      }));
    },
  };
}
