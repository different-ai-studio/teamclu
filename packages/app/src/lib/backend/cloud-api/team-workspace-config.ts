import type {
  TeamLlmConfig,
  TeamLlmConfigInput,
  TeamWorkspaceConfigBackend,
  TeamWorkspaceConfigRow,
} from "@/lib/backend/types";
import { CloudApiError, type CloudApiClient } from "@/lib/backend/cloud-api/http";

export function createTeamWorkspaceConfigModule(client: CloudApiClient): TeamWorkspaceConfigBackend {
  return {
    async load(teamId) {
      try {
        const out = await client.get<TeamWorkspaceConfigRow | null>(
          `/v1/teams/${encodeURIComponent(teamId)}/workspace-git-config`,
        );
        return out ?? null;
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async save(input) {
      const body: Record<string, unknown> = {};
      for (const key of [
        "workspace_path",
        "git_url",
        "git_branch",
        "git_token",
        "ai_gateway_endpoint",
        "enabled",
        "metadata",
      ] as const) {
        const value = (input as unknown as Record<string, unknown>)[key];
        if (value !== undefined) body[key] = value;
      }
      await client.put(
        `/v1/teams/${encodeURIComponent(input.team_id)}/workspace-git-config`,
        body,
      );
    },
    async loadLlmConfig(teamId) {
      try {
        const out = await client.get<{ llm?: TeamLlmConfig | null }>(
          `/v1/teams/${encodeURIComponent(teamId)}/workspace-config`,
        );
        return out?.llm ?? null;
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async saveLlmConfig(teamId, input) {
      return await client.put<TeamLlmConfigInput>(
        `/v1/teams/${encodeURIComponent(teamId)}/llm-config`,
        {
          enabled: input.enabled,
          baseUrl: input.baseUrl,
          models: input.models,
        },
      );
    },
  };
}
