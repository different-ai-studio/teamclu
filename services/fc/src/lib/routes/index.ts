import { registerAuth } from "./auth.js";
import { registerTeams } from "./teams.js";
import { registerSessions } from "./sessions.js";
import { registerApps } from "./apps.js";
import { registerMessages } from "./messages.js";
import { registerInvites } from "./invites.js";
import { registerWorkspaces } from "./workspaces.js";
import { registerSystem } from "./system.js";
import { registerActors } from "./actors.js";
import { registerNotifications } from "./notifications.js";
import { registerIdeas } from "./ideas.js";
import { registerShortcuts } from "./shortcuts.js";
import { registerRuntime } from "./runtime.js";
import { registerAttachments } from "./attachments.js";
import { registerTelemetry } from "./telemetry.js";
import { registerConfig } from "./config.js";
import { registerDirectory } from "./directory.js";
import { registerSync } from "./sync.js";
import { registerTeamShare } from "./team-share.js";
import { registerTeamCredits } from "./team-credits.js";
import { registerStripe } from "./stripe.js";
import { registerTeamLiteLlm } from "./team-litellm.js";
import { registerAccount } from "./account.js";
import { registerTeamSkills } from "./team-skills.js";
import { registerMarketplace } from "./marketplace.js";
import { registerTeamMcp } from "./team-mcp.js";
import { registerTeamEnvSecrets } from "./team-env-secrets.js";

export function registerAllRoutes(router) {
  registerAuth(router);
  registerAccount(router);
  registerTeams(router);
  registerSessions(router);
  registerApps(router);
  registerMessages(router);
  registerInvites(router);
  // team-share routes must be registered BEFORE workspaces so the new merged
  // GET /v1/teams/:teamId/workspace-config (share+litellm shape) wins over
  // the legacy default/pinned-workspace GET in workspaces.mjs. The legacy
  // PUT remains reachable since it's a distinct verb.
  registerTeamShare(router);
  // Same ordering reason as team-share / team-skills: these own
  // /v1/teams/:teamId/credits* and must not be shadowed by the broader team
  // match in workspaces.
  registerTeamCredits(router);
  // Not under /v1/teams/:teamId, so registration order is irrelevant here —
  // unlike the team-scoped routes above, which must precede workspaces.
  registerStripe(router);
  registerTeamLiteLlm(router);
  // Before workspaces for the same reason team-share is: these own
  // /v1/teams/:teamId/skills* and must not be shadowed by a broader match.
  registerTeamSkills(router);
  registerMarketplace(router);
  // Same ordering reason: these own /v1/teams/:teamId/mcp-servers* and
  // /v1/teams/:teamId/env-secrets* and must not be shadowed by workspaces'
  // broader team match.
  registerTeamMcp(router);
  registerTeamEnvSecrets(router);
  registerWorkspaces(router);
  registerSystem(router);
  registerActors(router);
  registerNotifications(router);
  registerIdeas(router);
  registerShortcuts(router);
  registerRuntime(router);
  registerAttachments(router);
  registerTelemetry(router);
  registerConfig(router);
  registerDirectory(router);
  registerSync(router);
}

export { registerAuth, registerTeams, registerSessions, registerApps, registerMessages, registerInvites, registerWorkspaces, registerSystem, registerActors, registerNotifications, registerIdeas, registerShortcuts, registerRuntime, registerAttachments, registerTelemetry, registerConfig, registerTeamSkills, registerMarketplace, registerTeamMcp, registerTeamEnvSecrets };