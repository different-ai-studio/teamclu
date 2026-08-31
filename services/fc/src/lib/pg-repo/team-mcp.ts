/**
 * Team MCP catalog — pg-repo implementation.
 *
 * Design: docs/architecture/team-mcp-and-env-cloud.md
 *
 * Two things worth knowing before editing:
 *
 * 1. Adding a server to the catalog is NOT the same as running it. A server
 *    only reaches a member's machine once that member installs it, and you can
 *    only install for yourself. That split is the whole security model here:
 *    `command` is spawned locally, so "any member can write the catalog" is
 *    only safe because writing the catalog does not execute anything.
 *
 * 2. Secret-looking values in `env`/`headers` are rejected outright. The
 *    `${KEY}` placeholder convention (resolved at runtime from the encrypted
 *    team env store, see crates/teamclu-runtime-env/src/mcp_resolve.rs) used
 *    to be an unenforced suggestion while this data rode an encrypted OSS blob.
 *    Now that it lands in a server-readable column, the convention becomes a
 *    contract — see assertNoLiteralSecrets.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { teamMcpServers, teamMcpInstalls } from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";
import { requireActorForTeam, resolveTeamRole } from "./authz.js";
import {
  NAME_RE,
  assertTransportShape,
  readServerFields,
} from "../validation/team-mcp.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

interface TeamMcpCtx {
  userId?: string;
}

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

function mapServer(row: any, extra: Record<string, unknown> = {}) {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    transport: row.transport,
    command: row.command ?? null,
    args: row.args ?? null,
    url: row.url ?? null,
    headers: row.headers ?? null,
    env: row.env ?? null,
    description: row.description ?? null,
    createdBy: row.createdBy ?? null,
    updatedBy: row.updatedBy ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    ...extra,
  };
}

export function makeTeamMcpRepo(db: DbLike, ctx: TeamMcpCtx) {
  function requireUser(): string {
    if (!ctx.userId) throw new ApiError(401, "unauthorized", "authentication required");
    return ctx.userId;
  }

  async function isTeamAdmin(userId: string, teamId: string): Promise<boolean> {
    const role = await resolveTeamRole(db, userId, teamId);
    return role === "owner" || role === "admin";
  }

  async function loadServer(teamId: string, name: string) {
    const [row] = await db
      .select()
      .from(teamMcpServers)
      .where(and(eq(teamMcpServers.teamId, teamId), eq(teamMcpServers.name, name)))
      .limit(1);
    if (!row) throw new ApiError(404, "not_found", `mcp server not found: ${name}`);
    return row;
  }

  /** Creator or team admin. Mirrors the UPDATE/DELETE RLS policy. */
  async function assertCanEdit(userId: string, server: any, callerActorId: string) {
    if (server.createdBy === callerActorId) return;
    if (await isTeamAdmin(userId, server.teamId)) return;
    throw new ApiError(403, "forbidden", "only the server's creator or a team admin may do this");
  }

  return {
    /**
     * Full catalog, decorated with an actor's install state. `actorId`
     * defaults to the caller; passing another actor's id reads their install
     * state, which is how a client shows what a given agent has installed.
     *
     * Reading is not symmetric with writing here: install/uninstall still
     * refuse `actorId`, because you cannot install on anyone else's behalf.
     * The read used to be refused for the same reason — "inspecting another
     * actor's install state has no corresponding action" — which stopped being
     * true once a UI needed to display it.
     *
     * Membership in the team is the only gate, matching `listTeamSkills`. An
     * actor id from outside the team simply matches no installs.
     */
    async listTeamMcpServers(teamId: string, opts: { actorId?: string } = {}) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);
      const subjectActorId = opts.actorId ?? callerActorId;

      const rows = await db
        .select()
        .from(teamMcpServers)
        .where(eq(teamMcpServers.teamId, teamId))
        .orderBy(teamMcpServers.name);
      if (!rows.length) return [];

      const installs = await db
        .select()
        .from(teamMcpInstalls)
        .where(
          and(
            eq(teamMcpInstalls.actorId, subjectActorId),
            inArray(
              teamMcpInstalls.serverId,
              rows.map((r: any) => r.id),
            ),
          ),
        );
      const installed = new Set(installs.map((i: any) => i.serverId));

      return rows.map((r: any) => mapServer(r, { installed: installed.has(r.id) }));
    },

    /**
     * The daemon-facing shape: exactly a Cursor `mcpServers` map, containing
     * ONLY what the caller has installed. Returning the on-disk file's byte
     * shape is deliberate — the daemon writes the body straight to its cache
     * and the existing scan_team_mcp parses it with no new code.
     */
    async getTeamMcpConfig(teamId: string) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);

      const rows = await db
        .select({
          name: teamMcpServers.name,
          transport: teamMcpServers.transport,
          command: teamMcpServers.command,
          args: teamMcpServers.args,
          url: teamMcpServers.url,
          headers: teamMcpServers.headers,
          env: teamMcpServers.env,
        })
        .from(teamMcpInstalls)
        .innerJoin(teamMcpServers, eq(teamMcpServers.id, teamMcpInstalls.serverId))
        .where(
          and(eq(teamMcpInstalls.teamId, teamId), eq(teamMcpInstalls.actorId, callerActorId)),
        )
        .orderBy(teamMcpServers.name);

      const mcpServers: Record<string, unknown> = {};
      for (const r of rows as any[]) {
        const entry: Record<string, unknown> = {};
        if (r.transport === "remote") {
          entry.url = r.url;
          if (r.headers) entry.headers = r.headers;
        } else {
          entry.command = r.command;
          if (r.args) entry.args = r.args;
        }
        if (r.env) entry.env = r.env;
        mcpServers[r.name] = entry;
      }
      return { mcpServers };
    },

    async createTeamMcpServer(teamId: string, body: any = {}) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);

      const name = String(body.name ?? "").trim();
      if (!NAME_RE.test(name)) {
        throw new ApiError(
          400,
          "validation_failed",
          "name must be 1-64 chars of [A-Za-z0-9_.-] and start with a letter or digit",
        );
      }

      const fields = readServerFields(body);
      assertTransportShape({
        transport: fields.transport as string,
        command: fields.command,
        url: fields.url,
      });

      const [existing] = await db
        .select({ id: teamMcpServers.id })
        .from(teamMcpServers)
        .where(and(eq(teamMcpServers.teamId, teamId), eq(teamMcpServers.name, name)))
        .limit(1);
      if (existing) {
        throw new ApiError(409, "conflict", `an mcp server named ${name} already exists`);
      }

      const [row] = await (db.insert(teamMcpServers) as any)
        .values({
          teamId,
          name,
          transport: fields.transport as string,
          command: (fields.command as string | null) ?? null,
          args: (fields.args as any) ?? null,
          url: (fields.url as string | null) ?? null,
          headers: (fields.headers as any) ?? null,
          env: (fields.env as any) ?? null,
          description: (fields.description as string | null) ?? null,
          createdBy: callerActorId,
          updatedBy: callerActorId,
        })
        .returning();

      return mapServer(row, { installed: false });
    },

    async updateTeamMcpServer(teamId: string, name: string, patch: any = {}) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);
      const server = await loadServer(teamId, name);
      await assertCanEdit(userId, server, callerActorId);

      const fields = readServerFields(patch, { partial: true });
      if (!Object.keys(fields).length) return mapServer(server);

      // Re-check the transport invariants against the *merged* row: a patch
      // that only flips transport would otherwise leave a stale command/url and
      // fail as a raw CHECK violation instead of a readable 400.
      assertTransportShape({
        transport: (fields.transport as string) ?? server.transport,
        command: fields.command !== undefined ? fields.command : server.command,
        url: fields.url !== undefined ? fields.url : server.url,
      });

      const [row] = await (db.update(teamMcpServers) as any)
        .set({ ...fields, updatedBy: callerActorId })
        .where(eq(teamMcpServers.id, server.id))
        .returning();
      return mapServer(row);
    },

    async deleteTeamMcpServer(teamId: string, name: string) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);
      const server = await loadServer(teamId, name);
      await assertCanEdit(userId, server, callerActorId);
      await db.delete(teamMcpServers).where(eq(teamMcpServers.id, server.id));
    },

    /**
     * Install for the caller. There is no `actorId` parameter on purpose —
     * installing means "run this command on my machine", which is not a
     * decision anyone gets to make for someone else.
     */
    async installTeamMcpServer(teamId: string, name: string) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);
      const server = await loadServer(teamId, name);

      const [row] = await (db.insert(teamMcpInstalls) as any)
        .values({ teamId, actorId: callerActorId, serverId: server.id })
        .onConflictDoUpdate({
          target: [teamMcpInstalls.actorId, teamMcpInstalls.serverId],
          set: { updatedAt: new Date() },
        })
        .returning();

      return {
        id: row.id,
        teamId: row.teamId,
        actorId: row.actorId,
        serverId: row.serverId,
        name: server.name,
        installedAt: iso(row.installedAt),
        updatedAt: iso(row.updatedAt),
      };
    },

    async uninstallTeamMcpServer(teamId: string, name: string) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);
      const server = await loadServer(teamId, name);
      await db
        .delete(teamMcpInstalls)
        .where(
          and(
            eq(teamMcpInstalls.actorId, callerActorId),
            eq(teamMcpInstalls.serverId, server.id),
          ),
        );
    },
  };
}
