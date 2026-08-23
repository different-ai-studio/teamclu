import { ApiError } from "../http-utils.js";
import { requireString } from "../routing-utils.js";
import { randomUUID } from "node:crypto";
import { mintAgentManagementGrant, verifyAgentManagementGrant } from "../agent-management-grant.js";

const AGENT_MANAGEMENT_SCOPES = new Set([
  "capabilities:read",
  "skills:list",
  "skills:install",
  "skills:uninstall",
  "skills:retry",
  "skills:remove-personal",
  "mcp:list",
  "mcp:install",
  "mcp:uninstall",
  "mcp:retry",
]);

const DEFAULT_ACTOR_LIMIT = 200;
const MAX_ACTOR_LIMIT = 500;

function parseActorLimit(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_ACTOR_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACTOR_LIMIT) {
    throw new ApiError(400, "validation_failed", "limit must be an integer from 1 to 500");
  }
  return limit;
}

export function registerActors(router) {
  router.get("/v1/teams/:teamId/actors", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const kind = ctx.query.get("kind") ?? null;
    const limit = parseActorLimit(ctx.query.get("limit"));
    const page = await ctx.repository.listTeamActors(teamId, { kind, limit });
    return { body: { items: page.items, nextCursor: null } };
  });

  router.get("/v1/actors/:actorId", async (ctx) => {
    const actorId = decodeURIComponent(ctx.params.actorId);
    const actor = await ctx.repository.getActor(actorId);
    if (!actor) throw new ApiError(404, "not_found", "actor not found");
    return { body: actor };
  });

  router.patch("/v1/actors/:actorId/profile", async (ctx) => {
    const actorId = decodeURIComponent(ctx.params.actorId);
    const body = ctx.json ?? {};
    requireString(body.displayName, "displayName");
    const actor = await ctx.repository.updateCurrentActorProfile(actorId, {
      displayName: body.displayName,
      avatarUrl: body.avatarUrl ?? null,
    });
    return { body: actor };
  });

  router.delete("/v1/actors/:actorId", async (ctx) => {
    const actorId = decodeURIComponent(ctx.params.actorId);
    await ctx.repository.removeTeamActor(null, actorId);
    return { statusCode: 204, body: null };
  });

  router.post("/v1/actors/external", async (ctx) => {
    const body = ctx.json;
    if (!body) throw new ApiError(400, "validation_failed", "body is required");
    requireString(body.teamId, "teamId");
    requireString(body.source, "source");
    requireString(body.sourceId, "sourceId");
    requireString(body.displayName, "displayName");
    const result = await ctx.repository.upsertExternalActor({
      teamId: body.teamId,
      source: body.source,
      sourceId: body.sourceId,
      displayName: body.displayName,
    });
    return { body: { actorId: result.actorId } };
  });

  router.get("/v1/teams/:teamId/agents/connected", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const result = await ctx.repository.listConnectedAgents(teamId);
    return { body: { items: result.items } };
  });

  // Read-only lookup the desktop runs before binding: found → bind silently,
  // not found → ask the user to name their new agent, then ensure-for-device.
  router.get("/v1/teams/:teamId/agents/for-device", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const deviceId = ctx.query.get("deviceId");
    if (!deviceId) throw new ApiError(400, "validation_failed", "deviceId is required");
    const result = await ctx.repository.findAgentForDevice(teamId, { deviceId });
    return { body: { agentId: result.agentId ?? null, displayName: result.displayName ?? null } };
  });

  // Idempotent per (team, device): the desktop calls this after login instead of
  // asking the user to create an agent, bind an existing one, or reset a machine
  // bound to another team. deviceId is write-only — it is deliberately absent
  // from the connected-agents response so one member cannot enumerate another's
  // machines.
  router.post("/v1/teams/:teamId/agents/ensure-for-device", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const body = ctx.json ?? {};
    requireString(body.deviceId, "deviceId");
    requireString(body.displayName, "displayName");
    const result = await ctx.repository.ensureAgentForDevice(teamId, {
      deviceId: body.deviceId,
      displayName: body.displayName,
    });
    return { body: result };
  });

  // Per-member default agent. "me" is resolved server-side from the bearer
  // token + team — the route never accepts a client-supplied member id, so a
  // caller can only read/write their own default.
  router.get("/v1/teams/:teamId/members/me/default-agent", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const result = await ctx.repository.getMemberDefaultAgent(teamId);
    return { body: { defaultAgentId: result.defaultAgentId ?? null } };
  });

  router.put("/v1/teams/:teamId/members/me/default-agent", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const body = ctx.json ?? {};
    const agentId =
      body.agentId === undefined || body.agentId === null ? null : String(body.agentId);
    const result = await ctx.repository.setMemberDefaultAgent(teamId, agentId);
    return { body: { defaultAgentId: result.defaultAgentId ?? null } };
  });

  // Team-level default agent (fallback when a member has no default). Owner/
  // admin only on PUT — enforced in the RPC/repository layer.
  router.get("/v1/teams/:teamId/default-agent", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const result = await ctx.repository.getTeamDefaultAgent(teamId);
    return { body: { defaultAgentId: result.defaultAgentId ?? null } };
  });

  router.put("/v1/teams/:teamId/default-agent", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const body = ctx.json ?? {};
    const agentId =
      body.agentId === undefined || body.agentId === null ? null : String(body.agentId);
    const result = await ctx.repository.setTeamDefaultAgent(teamId, agentId);
    return { body: { defaultAgentId: result.defaultAgentId ?? null } };
  });

  // Effective default for the calling member (member default, else team default).
  router.get("/v1/teams/:teamId/members/me/effective-default-agent", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const result = await ctx.repository.getEffectiveDefaultAgent(teamId);
    return { body: { defaultAgentId: result.defaultAgentId ?? null } };
  });

  router.patch("/v1/agents/:agentActorId", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    const body = ctx.json ?? {};
    await ctx.repository.updateOwnedAgentProfile(agentActorId, {
      displayName: body.displayName ?? null,
      avatarUrl: body.avatarUrl ?? null,
      description: body.description ?? null,
      visibility: body.visibility ?? null,
    });
    return { statusCode: 204, body: null };
  });

  router.patch("/v1/agents/:agentActorId/defaults", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    const body = ctx.json ?? {};
    await ctx.repository.updateAgentDefaults(agentActorId, {
      defaultAgentType: body.defaultAgentType ?? null,
      supportedAgentTypes: body.supportedAgentTypes ?? null,
      defaultWorkspaceId: body.defaultWorkspaceId ?? null,
      agentKind: body.agentKind ?? null,
    });
    return { statusCode: 204, body: null };
  });

  router.get("/v1/agents/:agentActorId/permission", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    const actorId = ctx.query.get("actorId");
    if (!actorId) throw new ApiError(400, "validation_failed", "actorId is required");
    const result = await ctx.repository.checkAgentPermission(agentActorId, actorId);
    return { body: { allowed: result.allowed, role: result.role ?? null } };
  });

  router.get("/v1/agents/:agentActorId/access", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    const result = await ctx.repository.listAgentAccess(agentActorId);
    return { body: { items: result.items } };
  });

  router.post("/v1/agents/:agentActorId/access", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    const body = ctx.json;
    if (!body) throw new ApiError(400, "validation_failed", "body is required");
    requireString(body.actorId, "actorId");
    requireString(body.role, "role");
    const result = await ctx.repository.grantAgentAccess(agentActorId, {
      actorId: body.actorId,
      role: body.role,
    });
    return { body: result };
  });

  router.post("/v1/agents/:agentActorId/share-to-team", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    await ctx.repository.shareAgentToTeam(agentActorId);
    return { statusCode: 204, body: null };
  });

  router.post("/v1/agents/:agentActorId/make-personal", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    await ctx.repository.makeAgentPersonal(agentActorId);
    return { statusCode: 204, body: null };
  });

  router.delete("/v1/agents/:agentActorId/access/:actorId", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    const actorId = decodeURIComponent(ctx.params.actorId);
    await ctx.repository.revokeAgentAccess(agentActorId, actorId);
    return { statusCode: 204, body: null };
  });

  router.get("/v1/agents/:agentActorId/admin-members", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    const result = await ctx.repository.listAgentAdminMembers(agentActorId);
    return { body: { items: result.items } };
  });

  router.post("/v1/agents/:agentActorId/management-grants", async (ctx) => {
    const targetAgentId = decodeURIComponent(ctx.params.agentActorId);
    const body = ctx.json ?? {};
    // Team-scoped on purpose: authorization resolves the target through the
    // caller's own team membership, which is the only lookup that can see a
    // personal Agent the caller reaches through an explicit access grant.
    const teamId = requireString(body.teamId, "teamId");
    if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
      throw new ApiError(400, "validation_failed", "scopes must be a non-empty array");
    }
    const scopes: string[] = [...new Set((body.scopes as unknown[]).map((scope) => String(scope)))];
    if (scopes.some((scope) => !AGENT_MANAGEMENT_SCOPES.has(scope))) {
      throw new ApiError(400, "validation_failed", "unsupported agent management scope");
    }
    const principal = await ctx.repository.authorizeAgentManagement(targetAgentId, teamId);
    const result = await mintAgentManagementGrant({
      teamId: principal.teamId,
      requesterActorId: principal.requesterActorId,
      targetAgentId,
      scopes,
      // FC picks the request id the grant may be spent on; the requester must
      // send this back as the RPC `request_id` (see `nonce` on the claims).
      nonce: randomUUID(),
    });
    return { body: { ...result, requesterActorId: principal.requesterActorId, targetAgentId, scopes } };
  });

  router.post("/v1/agents/:agentActorId/management-grants/verify", async (ctx) => {
    const targetAgentId = decodeURIComponent(ctx.params.agentActorId);
    const body = ctx.json ?? {};
    requireString(body.grant, "grant");
    requireString(body.scope, "scope");
    requireString(body.requesterActorId, "requesterActorId");
    // The request id is part of what the grant authorizes. Without it a
    // captured grant would be a bearer token good for arbitrarily many
    // mutations until it expires; bound to one request id, a replay can only
    // re-ask for the call the Agent has already answered and cached.
    requireString(body.requestId, "requestId");
    const claims = await verifyAgentManagementGrant(body.grant);
    if (
      claims.targetAgentId !== targetAgentId ||
      claims.requesterActorId !== body.requesterActorId ||
      claims.nonce !== body.requestId ||
      !claims.scopes.includes(body.scope)
    ) {
      throw new ApiError(403, "agent_management_grant_mismatch", "agent management grant does not match this request");
    }
    const caller = await ctx.repository.resolveCallerActorForTeam(claims.teamId);
    if (!caller || caller.id !== targetAgentId) {
      throw new ApiError(403, "agent_management_target_mismatch", "only the target agent may verify this grant");
    }
    return { body: { valid: true, ...claims } };
  });

  router.post("/v1/actors/by-ids", async (ctx) => {
    const body = ctx.json ?? {};
    if (!Array.isArray(body.actorIds)) {
      throw new ApiError(400, "validation_failed", "actorIds must be an array");
    }
    const teamId = typeof body.teamId === "string" && body.teamId.length > 0 ? body.teamId : null;
    const items = await ctx.repository.listActorDirectoryByIds(body.actorIds, teamId);
    return { body: { items } };
  });

  router.get("/v1/actors/:actorId/sessions", async (ctx) => {
    const actorId = decodeURIComponent(ctx.params.actorId);
    const items = await ctx.repository.listSessionIdsForActor(actorId);
    return { body: { items } };
  });

  router.delete("/v1/actors/access/:accessId", async (ctx) => {
    const accessId = decodeURIComponent(ctx.params.accessId);
    await ctx.repository.removeAgentAccessById(accessId);
    return { statusCode: 204, body: null };
  });
}
