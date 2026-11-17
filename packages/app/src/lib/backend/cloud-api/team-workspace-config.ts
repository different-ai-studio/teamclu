import type {
  TeamLlmConfig,
  TeamLlmConfigInput,
  TeamWorkspaceConfigBackend,
} from "@/lib/backend/types";
import { CloudApiError, type CloudApiClient } from "@/lib/backend/cloud-api/http";
import { createCoalescedRead } from "@/lib/backend/cloud-api/coalesced-read";

export function createTeamWorkspaceConfigModule(client: CloudApiClient): TeamWorkspaceConfigBackend {
  const llmRead = createCoalescedRead<TeamLlmConfig | null>({});
  return {
    async loadLlmConfig(teamId) {
      const llm = await llmRead.get(teamId, async () => {
        try {
          const out = await client.get<{ llm?: TeamLlmConfig | null }>(
            `/v1/teams/${encodeURIComponent(teamId)}/workspace-config`,
          );
          return out?.llm ?? null;
        } catch (e) {
          if (e instanceof CloudApiError && e.status === 404) return null;
          throw e;
        }
      });
      if (!llm) return null;
      return {
        ...llm,
        models: Array.isArray(llm.models) ? llm.models.map((model) => ({ ...model })) : llm.models,
      };
    },
    async saveLlmConfig(teamId, input) {
      try {
        return await client.put<TeamLlmConfigInput>(
          `/v1/teams/${encodeURIComponent(teamId)}/llm-config`,
          {
            enabled: input.enabled,
            baseUrl: input.baseUrl,
            models: input.models,
          },
        );
      } finally {
        llmRead.invalidate(teamId);
      }
    },
  };
}
