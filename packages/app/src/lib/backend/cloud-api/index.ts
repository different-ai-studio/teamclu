import type { ServerConfig } from "@/lib/server-config";
import type { TeamCluBackend } from "../types";
import { createCloudApiClient, type CloudApiClient } from "./http";
import { createAuthClient, createAuthModule } from "./auth";
import { createTeamsModule } from "./teams";
import { createSessionsModule } from "./sessions";
import { createAppsModule } from "./apps";
import { createMessagesModule } from "./messages";
import { createWorkspacesModule } from "./workspaces";
import { createTeamWorkspaceConfigModule } from "./team-workspace-config";
import { createActorsModule } from "./actors";
import { createDirectoryModule } from "./directory";
import { createSessionMembersModule } from "./session-members";
import { createIdeasModule } from "./ideas";
import { createShortcutsModule } from "./shortcuts";
import { createNotificationsModule } from "./notifications";
import { createRuntimeModule } from "./runtime";
import { createAttachmentsModule } from "./attachments";
import { createTelemetryModule } from "./telemetry";
import { createSyncModule } from "./sync";
import { createSystemModule } from "./system";
import { createTeamSkillsModule } from "./team-skills";
import { createMarketplaceModule } from "./marketplace";
import { createTeamMcpModule } from "./team-mcp";
import { createKnowledgeAclModule } from "./knowledge-acl";
import { createTeamEnvSecretsModule } from "./team-env-secrets";

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
