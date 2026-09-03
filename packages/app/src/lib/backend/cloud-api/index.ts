import type { ServerConfig } from "@/lib/config/server-config";
import type { TeamCluBackend } from "@/lib/backend/types";
import { createCloudApiClient, type CloudApiClient } from "@/lib/backend/cloud-api/http";
import { createAuthClient, createAuthModule } from "@/lib/backend/cloud-api/auth";
import { createTeamsModule } from "@/lib/backend/cloud-api/teams";
import { createSessionsModule } from "@/lib/backend/cloud-api/sessions";
import { createAppsModule } from "@/lib/backend/cloud-api/apps";
import { createMessagesModule } from "@/lib/backend/cloud-api/messages";
import { createWorkspacesModule } from "@/lib/backend/cloud-api/workspaces";
import { createTeamWorkspaceConfigModule } from "@/lib/backend/cloud-api/team-workspace-config";
import { createActorsModule } from "@/lib/backend/cloud-api/actors";
import { createDirectoryModule } from "@/lib/backend/cloud-api/directory";
import { createSessionMembersModule } from "@/lib/backend/cloud-api/session-members";
import { createIdeasModule } from "@/lib/backend/cloud-api/ideas";
import { createShortcutsModule } from "@/lib/backend/cloud-api/shortcuts";
import { createNotificationsModule } from "@/lib/backend/cloud-api/notifications";
import { createRuntimeModule } from "@/lib/backend/cloud-api/runtime";
import { createAttachmentsModule } from "@/lib/backend/cloud-api/attachments";
import { createTelemetryModule } from "@/lib/backend/cloud-api/telemetry";
import { createSyncModule } from "@/lib/backend/cloud-api/sync";
import { createSystemModule } from "@/lib/backend/cloud-api/system";
import { createTeamSkillsModule } from "@/lib/backend/cloud-api/team-skills";
import { createMarketplaceModule } from "@/lib/backend/cloud-api/marketplace";
import { createTeamMcpModule } from "@/lib/backend/cloud-api/team-mcp";
import { createKnowledgeAclModule } from "@/lib/backend/cloud-api/knowledge-acl";
import { createTeamEnvSecretsModule } from "@/lib/backend/cloud-api/team-env-secrets";

export function hasCloudApiBackendConfig(config: ServerConfig): boolean {
  return Boolean(config.cloudApiUrl);
}

export function createCloudApiBackend(
  config: ServerConfig,
  options: { client?: CloudApiClient } = {},
): TeamCluBackend {
  const baseUrl = requiredCloudApiUrl(config);
  const authClient = createAuthClient({ baseUrl });
  // Build a temporary auth backend so the CloudApiClient can pull the bearer
  // token from the SessionStore.
  const tempAuth = createAuthModule(null as unknown as CloudApiClient, authClient);
  const client = options.client ?? createCloudApiClient({ baseUrl, auth: tempAuth });
  const auth = createAuthModule(client, authClient);

  return {
    kind: "cloud_api",
    auth,
    teams: createTeamsModule(client),
    sessions: createSessionsModule(client),
    apps: createAppsModule(client),
    messages: createMessagesModule(client),
    workspaces: createWorkspacesModule(client),
    teamWorkspaceConfig: createTeamWorkspaceConfigModule(client),
    actors: createActorsModule(client),
    directory: createDirectoryModule(client),
    sessionMembers: createSessionMembersModule(client),
    ideas: createIdeasModule(client),
    shortcuts: createShortcutsModule(client),
    notifications: createNotificationsModule(client),
    runtime: createRuntimeModule(client),
    attachments: createAttachmentsModule(client),
    telemetry: createTelemetryModule(client),
    sync: createSyncModule(client),
    system: createSystemModule(client),
    teamSkills: createTeamSkillsModule(client),
    marketplace: createMarketplaceModule(client),
    teamMcp: createTeamMcpModule(client),
    knowledgeAcl: createKnowledgeAclModule(client),
    teamEnvSecrets: createTeamEnvSecretsModule(client),
  };
}

function requiredCloudApiUrl(config: ServerConfig): string {
  if (!config.cloudApiUrl) throw new Error("Cloud API URL is not configured.");
  return config.cloudApiUrl;
}
