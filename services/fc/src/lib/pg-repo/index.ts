/**
 * Path B business repository — Drizzle + app-layer authz (BACKEND_KIND=postgres).
 *
 * Parity target: lib/supabase-repo.ts (Path A). Any new repository method needs
 * a matching implementation here and in the contract tests above.
 */
import type { PgDatabase } from "drizzle-orm/pg-core";
import { ApiError } from "../http-utils.js";
import { makeTeamsRepo, type TeamsRepoDeps } from "./teams.js";
import { fetchLiteLlmModels } from "../team-provisioning.js";
import { litellmFetch } from "../litellm.js";
import { makeIdeasRepo } from "./ideas.js";
import { makeSessionsRepo, type SessionsRepoDeps } from "./sessions.js";
import { makeMessagesRepo, type MessagesRepoDeps } from "./messages.js";
import { makeWorkspacesRepo } from "./workspaces.js";
import { makeShortcutsRepo } from "./shortcuts.js";
import { makeActorsRepo } from "./actors.js";
import { makeAgentsRepo } from "./agents.js";
import { makeAppsRepo, type AppsRepoDeps } from "./apps.js";
import { makeHeartbeatRepo } from "./heartbeat.js";
import { makeNotificationsRepo } from "./notifications.js";
import { makeTelemetryRepo } from "./telemetry.js";
import { makeAttachmentsRepo } from "./attachments.js";
import { makeTeamSkillsRepo } from "./team-skills.js";
import { makeMarketplaceRepo } from "./marketplace.js";
import { makeTeamMcpRepo } from "./team-mcp.js";
import { makeTeamEnvSecretsRepo } from "./team-env-secrets.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPgBusinessRepository({ db, accessToken, userId, callerActorId, provisionLiteLlm, fetchLiteLlmModels: fetchLiteLlmModelsOpt, provisionMemberKey, queryLiteLlmUsage, startDeploy, finalizeDeploy, deployUnavailableReason, gitea, giteaUnavailableReason, gotrue, gotrueUnavailableReason, dispatchPush, publishReadEvent, deleteMemberKey }: { db: PgDatabase<any, any>; accessToken?: string; userId?: string; callerActorId?: string; provisionLiteLlm?: TeamsRepoDeps["provisionLiteLlm"]; fetchLiteLlmModels?: TeamsRepoDeps["fetchLiteLlmModels"]; provisionMemberKey?: TeamsRepoDeps["provisionMemberKey"]; queryLiteLlmUsage?: TeamsRepoDeps["queryLiteLlmUsage"]; deleteMemberKey?: TeamsRepoDeps["deleteMemberKey"]; startDeploy?: AppsRepoDeps["startDeploy"]; finalizeDeploy?: AppsRepoDeps["finalizeDeploy"]; deployUnavailableReason?: AppsRepoDeps["deployUnavailableReason"]; gitea?: AppsRepoDeps["gitea"]; giteaUnavailableReason?: AppsRepoDeps["giteaUnavailableReason"]; gotrue?: AppsRepoDeps["gotrue"]; gotrueUnavailableReason?: AppsRepoDeps["gotrueUnavailableReason"]; dispatchPush?: MessagesRepoDeps["dispatchPush"]; publishReadEvent?: SessionsRepoDeps["publishReadEvent"] }) {
  // accessToken is verified upstream (makeBusinessRepoFactory) and its `sub`
  // claim is passed here as `userId`. It is kept in the signature only for the
  // few methods that need to forward the raw bearer (none currently); identity
  // for authz flows exclusively through ctx.userId.
  void accessToken;
  const ctx = { userId, callerActorId };
  // queryLiteLlmUsage was declared in TeamsRepoDeps but never forwarded here, so
  // the seam existed in the types while every caller still hit the real LiteLLM
  // Postgres. Wiring it through matches the supabase repo, which has always
  // accepted the same injection.
  const teamsRepo = makeTeamsRepo(db, { provisionLiteLlm, fetchLiteLlmModels: fetchLiteLlmModelsOpt ?? fetchLiteLlmModels, provisionMemberKey, queryLiteLlmUsage, deleteMemberKey, litellmFetch });
  const teamsCtx = { userId };
  const ideasRepo = makeIdeasRepo(db, ctx);
  const sessionsRepo = makeSessionsRepo(db, ctx, { publishReadEvent });
  // dispatchPush's helper RPCs (push_idempotency_claim, list_session_push_targets)
  // still use the Supabase service-role client — documented follow-up to migrate
  // those RPCs to pg-repo once the push domain is ported.
  const messagesRepo = makeMessagesRepo(db, { dispatchPush });
  const workspacesRepo = makeWorkspacesRepo(db);
  const shortcutsRepo = makeShortcutsRepo(db, ctx);
  const actorsRepo = makeActorsRepo(db, ctx);
  // mintAgentInvite is injected so the agents repo can hand device binding its
  // one-shot invite without importing the teams repo — the owner check on
  // targetActorId stays in createTeamInvite alone.
  const agentsRepo = makeAgentsRepo(db, {
    ...ctx,
    mintAgentInvite: (teamId, input) =>
      teamsRepo.createTeamInvite(
        teamId,
        {
          kind: "agent",
          agentKind: "claude",
          displayName: input.displayName,
          targetActorId: input.targetActorId,
          ttlSeconds: input.ttlSeconds,
        },
        teamsCtx,
      ),
  });
  const appsRepo = makeAppsRepo(db, ctx, { startDeploy, finalizeDeploy, deployUnavailableReason, gitea, giteaUnavailableReason, gotrue, gotrueUnavailableReason });
  const heartbeatRepo = makeHeartbeatRepo(db, ctx);
  const notificationsRepo = makeNotificationsRepo(db, ctx);
  const telemetryRepo = makeTelemetryRepo(db, ctx);
  const teamSkillsRepo = makeTeamSkillsRepo(db, ctx);
  const marketplaceRepo = makeMarketplaceRepo(db, ctx);
  const teamMcpRepo = makeTeamMcpRepo(db, ctx);
  const teamEnvSecretsRepo = makeTeamEnvSecretsRepo(db, ctx);
  return {
    ...teamsRepo,
    ...ideasRepo,
    ...sessionsRepo,
    ...messagesRepo,
    // workspacesRepo methods shadow teamsRepo.getTeamWorkspaceConfig / putTeamWorkspaceConfig
    // with the contract-shape-returning implementations
    ...workspacesRepo,
    ...shortcutsRepo,
    ...actorsRepo,
    ...agentsRepo,
    ...appsRepo,
    ...heartbeatRepo,
    ...notificationsRepo,
    ...telemetryRepo,
    ...teamSkillsRepo,
    ...marketplaceRepo,
    ...teamMcpRepo,
    ...teamEnvSecretsRepo,
    ...makeAttachmentsRepo(),
    listTeams: (args: { limit?: number } = {}) => teamsRepo.listTeams(args, teamsCtx),
    listAllMyTeams: () => teamsRepo.listAllMyTeams(teamsCtx),
    listDiscoverableTeams: () => teamsRepo.listDiscoverableTeams(teamsCtx),
    joinPublicTeam: (teamId: string) => teamsRepo.joinPublicTeam(teamId, teamsCtx),
    setTeamVisibility: (teamId: string, input: { visibility: string }) => teamsRepo.setTeamVisibility(teamId, input, teamsCtx),
    createTeam: (input: any) => teamsRepo.createTeam(input, teamsCtx),
    bootstrapTeam: (input: any) => teamsRepo.bootstrapTeam(input, teamsCtx),
    createTeamInvite: (teamId: string, input: any) => teamsRepo.createTeamInvite(teamId, input, teamsCtx),
    ensureMemberKey: (teamId: string) => teamsRepo.ensureMemberKey(teamId, teamsCtx),
    listLiteLlmKeys: (teamId: string) => teamsRepo.listLiteLlmKeys(teamId, teamsCtx),
    setLiteLlmBudget: (teamId: string, input: { maxBudget?: unknown }) => teamsRepo.setLiteLlmBudget(teamId, input, teamsCtx),
    getLiteLlmUsage: (teamId: string, opts?: { range?: string; date?: string }) => teamsRepo.getLiteLlmUsage(teamId, opts ?? {}, teamsCtx),
    removeTeamActor: (teamId: string, actorId: string) => teamsRepo.removeTeamActor(teamId, actorId, teamsCtx),
    // Account upgrade (default-org → own org) is org-model-specific and only
    // implemented on the supabase backend (postgres has no org model).
    upgradeAccount: async () => {
      throw new ApiError(501, "upgrade_unsupported", "account upgrade is only available under BACKEND_KIND=supabase");
    },
    bindPhone: async () => {
      throw new ApiError(501, "phone_bind_unsupported", "phone bind is only available under BACKEND_KIND=supabase");
    },
  } as any;
}
