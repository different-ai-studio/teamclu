import { ApiError } from "../http-utils.js";
import { requireString } from "../routing-utils.js";

export function registerShortcuts(router) {
  // Scope-based list: `?scope=personal` or `?scope=team&teamId=...`
  // RLS gates personal shortcuts to the caller's member rows.
  router.get("/v1/shortcuts", async (ctx) => {
    const scope = ctx.query.get("scope");
    if (scope !== "personal" && scope !== "team") {
      throw new ApiError(400, "validation_failed", "scope must be 'personal' or 'team'");
    }
    const args: any = { scope };
    if (scope === "team") {
      const teamId = ctx.query.get("teamId");
      if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required for team scope");
      args.teamId = teamId;
    }
    const parentIdRaw = ctx.query.get("parentId");
    if (parentIdRaw !== null && parentIdRaw !== undefined) {
      args.parentId = parentIdRaw === "null" ? null : parentIdRaw;
    }
    const items = await ctx.repository.listShortcutsByScope(args);
    return { body: { items } };
  });

  router.get("/v1/teams/:teamId/shortcuts", async (ctx) => {
    const { teamId } = ctx.params;
    const args: any = {};
    const parentIdRaw = ctx.query.get("parentId");
    if (parentIdRaw !== null && parentIdRaw !== undefined) {
      args.parentId = parentIdRaw === "null" ? null : parentIdRaw;
    }
    const items = await ctx.repository.listShortcuts(teamId, args);
    return { body: { items } };
  });

  router.post("/v1/shortcuts", async (ctx) => {
    const body = ctx.json ?? {};
    const scope = body.scope ?? (body.teamId ? "team" : "personal");
    const nodeType = body.nodeType ?? body.kind;
    requireString(scope, "scope");
    requireString(body.label, "label");
    requireString(nodeType, "nodeType");
    const shortcut = await ctx.repository.createShortcut({ ...body, scope, nodeType });
    return { statusCode: 201, body: shortcut };
  });

  router.patch("/v1/shortcuts/:shortcutId", async (ctx) => {
    const shortcut = await ctx.repository.updateShortcut(ctx.params.shortcutId, ctx.json ?? {});
    if (!shortcut) throw new ApiError(404, "not_found", "shortcut not found");
    return { body: shortcut };
  });

  router.delete("/v1/shortcuts/:shortcutId", async (ctx) => {
    await ctx.repository.deleteShortcut(ctx.params.shortcutId);
    return { statusCode: 204, body: null };
  });

  router.post("/v1/shortcuts/batch-move", async (ctx) => {
    const body = ctx.json ?? {};
    if (!Array.isArray(body.moves)) {
      throw new ApiError(400, "validation_failed", "moves is required and must be an array");
    }
    await ctx.repository.batchMoveShortcuts({ moves: body.moves });
    return { statusCode: 204, body: null };
  });

  router.put("/v1/shortcuts/:shortcutId/visible-roles", async (ctx) => {
    const body = ctx.json ?? {};
    if (!Array.isArray(body.roleIds)) {
      throw new ApiError(400, "validation_failed", "roleIds is required and must be an array");
    }
    await ctx.repository.setShortcutVisibleRoles(ctx.params.shortcutId, { roleIds: body.roleIds });
    return { statusCode: 204, body: null };
  });

  // Relocated from /v1/teams/:teamId/roles — that path is now org roles
  // (docs/specs/2026-09-15-org-roles-permissions-design.md). Shortcuts RBAC
  // still reads amux.team_roles via listTeamRoles.
  router.get("/v1/teams/:teamId/shortcut-roles", async (ctx) => {
    const items = await ctx.repository.listTeamRoles(ctx.params.teamId);
    return { body: { items } };
  });

  router.get("/v1/teams/:teamId/permissions", async (ctx) => {
    const items = await ctx.repository.listTeamPermissions(ctx.params.teamId);
    return { body: { items } };
  });

  router.get("/v1/teams/:teamId/shortcut-role-bindings", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const items = await ctx.repository.listShortcutRoleBindings(teamId);
    return { body: { items } };
  });
}
