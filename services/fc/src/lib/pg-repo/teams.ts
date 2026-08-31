import { and, asc, eq, exists, inArray, isNull, or, sql } from "drizzle-orm";
import { aliasedTable } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { teams, teamWorkspaceConfig, actors, members, teamMembers, teamInvites } from "../../db/schema/index.js";
import { workspaces } from "../../db/schema/workspaces.js";
import { agentMemberAccess, agents } from "../../db/schema/agents.js";
import { aiGateway } from "../ai-gateway.js";
import { ApiError } from "../http-utils.js";
import { requireActorForTeam, requireTeamOwner, checkAgentOwnership, assertCanRemoveTeamActor, mapActorDeleteFkError } from "./authz.js";
import { randomBytes, randomUUID } from "node:crypto";
import { generateDisplayName } from "../display-name.js";

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Lowercased + trimmed, or null. Both sides of a contact match normalize this way. */
export const normalizeInviteEmail = (e: string | null | undefined) =>
  (e ?? "").trim().toLowerCase() || null;


function mapTeam(r: any) {
  return {
    id: r.id, name: r.name, slug: r.slug, createdAt: iso(r.createdAt),
    visibility: r.visibility ?? "private",
  };
}

export interface TeamsRepoDeps {
  /** Fetch available models from the LiteLLM gateway. */
  /**
   * LiteLLM admin HTTP client — injected in production from litellm.ts's
   * `litellmFetch`, stubbed in tests. Used by listLiteLlmKeys.
   */
  litellmFetch?: (path: string, method: string, body?: unknown) => Promise<{ ok: boolean; status: number; data: unknown }>;
  /**
   * LiteLLM per-team usage aggregator — injected in tests to avoid touching a
   * real LiteLLM RDS. Defaults to querying the migrated LiteLLM Postgres via
   * `queryTeamUsage(getLiteLlmSql(), …)`, mirroring supabase-repo's
   * `queryLiteLlmUsage` option. Never invoked for teams that have not
   * provisioned LiteLLM (getLiteLlmUsage returns the empty shape first).
   */
}

function actorMembershipFilter(db: PgDatabase<any, any>, userId: string) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(actors)
      .where(and(eq(actors.userId, userId), eq(actors.teamId, teams.id))),
  );
}

// PgDatabase base accepts both postgres-js and pglite drivers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
/** Every credits route is authenticated; a missing user is a 401, not a crash. */
function requireUser(ctx?: { userId?: string }): string {
  const userId = ctx?.userId;
  if (!userId) throw new ApiError(401, "missing_auth", "authenticated user required");
  return userId;
}

export function makeTeamsRepo(db: PgDatabase<any, any>, deps: TeamsRepoDeps = {}) {
  return {
    async listTeams({ limit = 50 }: { limit?: number } = {}, ctx?: { userId?: string }) {
      const userId = ctx?.userId;
      const query = db.select().from(teams);
      const rows = userId
        ? await query
            .where(actorMembershipFilter(db, userId))
            .orderBy(asc(teams.createdAt))
            .limit(limit)
        : await query.orderBy(asc(teams.createdAt)).limit(limit);
      return rows.map(mapTeam);
    },
    async getTeam(teamId: string) {
      const [r] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
      return r ? mapTeam(r) : null;
    },
    async renameTeam(teamId: string, { name }: { name: string }) {
      const [r] = await (db.update(teams) as any).set({ name, updatedAt: new Date() }).where(eq(teams.id, teamId)).returning();
      if (!r) throw new ApiError(404, "not_found", "team not found");
      return mapTeam(r);
    },
    async getTeamWorkspaceConfig(teamId: string) {
      const [r] = await db.select().from(teamWorkspaceConfig).where(eq(teamWorkspaceConfig.teamId, teamId)).limit(1);
      return r ?? null;
    },
    async putTeamWorkspaceConfig(teamId: string, input: Record<string, any>) {
      const [r] = await (db.insert(teamWorkspaceConfig) as any)
        .values({ teamId, ...input, updatedAt: new Date() })
        .onConflictDoUpdate({ target: teamWorkspaceConfig.teamId, set: { ...input, updatedAt: new Date() } })
        .returning();
      return r;
    },
    async getWorkspaceConfig(teamId: string) {
      const [t] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
      const [wc] = await db.select().from(teamWorkspaceConfig).where(eq(teamWorkspaceConfig.teamId, teamId)).limit(1);
      // Falls back to the deployment-wide endpoint when a team has no override.
      // This is the cutover fallback design §11.2 relies on: pointing this env
      // at the new gateway moves every team that never set an explicit URL.
      const aiGatewayEndpoint =
        wc?.aiGatewayEndpoint ?? (process.env.AI_GATEWAY_ENDPOINT?.trim() || null);
      const storedModels = Array.isArray(wc?.llmModels) ? wc.llmModels : [];
      return {
        syncMode: wc?.syncMode ?? null,
        litellmTeamId: wc?.litellmTeamId ?? null,
        // `models` is the STORED, authoritative per-team list.
        llm: {
          enabled: wc?.llmEnabled ?? false,
          baseUrl: wc?.llmBaseUrl ?? null,
          models: storedModels,
          aiGatewayEndpoint,
        },
      };
    },

    /**
     * Persists the team's LLM config (enabled/baseUrl/models) into
     * team_workspace_config. Mirrors supabase-repo.setLlmConfig — no explicit
     * authz check there (the route enforces membership upstream), so parity is
     * preserved by NOT adding one here.
     */
    async setLlmConfig(teamId: string, input: { enabled: boolean; baseUrl: string | null; models: Array<{ id: string; name: string }> }) {
      const values = {
        teamId,
        llmEnabled: input.enabled,
        llmBaseUrl: input.baseUrl,
        llmModels: input.models,
        updatedAt: new Date(),
      };
      await (db.insert(teamWorkspaceConfig) as any)
        .values(values)
        .onConflictDoUpdate({
          target: teamWorkspaceConfig.teamId,
          set: {
            llmEnabled: input.enabled,
            llmBaseUrl: input.baseUrl,
            llmModels: input.models,
            updatedAt: new Date(),
          },
        });
      return { enabled: input.enabled, baseUrl: input.baseUrl, models: input.models };
    },

    /**
     * Lists ALL teams the caller belongs to across every org (cross-org team
     * picker). Postgres has no org model, so orgId/orgName are always null —
     * the shape still matches supabase-repo.listAllMyTeams for client parity.
     * Resolved via ctx.userId (all actors owned by the user → their teams).
     */
    async listAllMyTeams(ctx?: { userId?: string }) {
      const userId = ctx?.userId;
      if (!userId) throw new ApiError(401, "missing_auth", "authenticated user required");
      const defaultOrgId = process.env.DEFAULT_ORG_ID || null;

      // (a) Teams the caller is already an actor in.
      const mineRows = await db
        .select({ id: teams.id, name: teams.name, slug: teams.slug, oid: teams.oid, visibility: teams.visibility, createdAt: teams.createdAt })
        .from(teams)
        .innerJoin(actors, eq(actors.teamId, teams.id))
        .where(eq(actors.userId, userId))
        .orderBy(asc(teams.createdAt));

      // Dedup by team id (a user could theoretically have >1 actor per team).
      const seen = new Set<string>();
      const out: Array<{ id: string; name: string; slug: string | null; orgId: string | null; orgName: null; visibility: string; isMember: boolean; createdAt: string | null; memberCount: number | null; ownerName: string | null }> = [];
      for (const r of mineRows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push({ id: r.id, name: r.name, slug: r.slug ?? null, orgId: r.oid ?? null, orgName: null, visibility: r.visibility ?? "private", isMember: true, createdAt: iso(r.createdAt), memberCount: null, ownerName: null });
      }

      // (b) PUBLIC teams in the shared DEFAULT_ORG the caller can join.
      if (defaultOrgId) {
        const publicRows = await db
          .select({ id: teams.id, name: teams.name, slug: teams.slug, oid: teams.oid, createdAt: teams.createdAt })
          .from(teams)
          .where(and(eq(teams.oid, defaultOrgId), eq(teams.visibility, "public")))
          .orderBy(asc(teams.createdAt));
        for (const r of publicRows) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          out.push({ id: r.id, name: r.name, slug: r.slug ?? null, orgId: r.oid ?? null, orgName: null, visibility: "public", isMember: false, createdAt: iso(r.createdAt), memberCount: null, ownerName: null });
        }
      }

      // Member count + owner, for the client to disambiguate same-named teams.
      // Two batched queries rather than per-row lookups: the picker can list
      // every team a user belongs to, and this runs on every login.
      const ids = out.map((t) => t.id);
      if (ids.length > 0) {
        const counts = await db
          .select({ teamId: actors.teamId, n: sql<number>`count(*)::int` })
          .from(actors)
          .where(and(inArray(actors.teamId, ids), eq(actors.actorType, "member")))
          .groupBy(actors.teamId);
        const countByTeam = new Map(counts.map((c) => [c.teamId, Number(c.n)]));

        const owners = await db
          .select({ teamId: teamMembers.teamId, displayName: actors.displayName, createdAt: actors.createdAt, actorId: actors.id })
          .from(teamMembers)
          .innerJoin(actors, eq(actors.id, teamMembers.memberId))
          .where(and(inArray(teamMembers.teamId, ids), eq(teamMembers.role, "owner")))
          .orderBy(asc(actors.createdAt), asc(actors.id));
        // First row wins per team — same "oldest owner actor" tiebreak the
        // supabase RPC applies, so both backends name the same person.
        const ownerByTeam = new Map<string, string | null>();
        for (const o of owners) {
          if (!ownerByTeam.has(o.teamId)) ownerByTeam.set(o.teamId, o.displayName ?? null);
        }

        for (const t of out) {
          t.memberCount = countByTeam.get(t.id) ?? 0;
          t.ownerName = ownerByTeam.get(t.id) ?? null;
        }
      }
      return out;
    },

    async listDiscoverableTeams(ctx?: { userId?: string }) {
      const publicTeams = await db
        .select({ id: teams.id, name: teams.name, slug: teams.slug, oid: teams.oid })
        .from(teams)
        .where(eq(teams.visibility, "public"))
        .orderBy(asc(teams.createdAt));
      const joined = new Set<string>();
      if (ctx?.userId) {
        const mine = await db.select({ teamId: actors.teamId }).from(actors).where(eq(actors.userId, ctx.userId));
        mine.forEach((row) => joined.add(row.teamId));
      }
      return publicTeams.map((team) => ({
        id: team.id, name: team.name, slug: team.slug ?? null, orgId: team.oid ?? null,
        orgName: null, visibility: "public", isMember: joined.has(team.id),
      }));
    },

    // Self-service join of a PUBLIC default-org team as a plain member.
    // Idempotent when the caller is already an actor in the team.
    async joinPublicTeam(teamId: string, ctx?: { userId?: string }) {
      const userId = ctx?.userId;
      if (!userId) throw new ApiError(401, "missing_auth", "authenticated user required");
      const defaultOrgId = process.env.DEFAULT_ORG_ID || null;

      const [team] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
      if (!team) throw new ApiError(404, "not_found", "team not found");
      if (team.visibility !== "public" || !defaultOrgId || team.oid !== defaultOrgId) {
        throw new ApiError(403, "forbidden", "team is not a joinable public team");
      }

      const [existing] = await db
        .select({ id: actors.id })
        .from(actors)
        .where(and(eq(actors.teamId, teamId), eq(actors.userId, userId)))
        .limit(1);
      if (!existing) {
        await (db as any).transaction(async (tx: any) => {
          const actorId = randomUUID();
          const displayName = generateDisplayName(actorId);
          await tx.insert(actors).values({ id: actorId, teamId, actorType: "member", displayName, userId });
          await tx.insert(members).values({ id: actorId, status: "active" });
          await tx.insert(teamMembers).values({ teamId, memberId: actorId, role: "member" });
        });
      }
      return mapTeam(team);
    },

    // Visibility toggle (public | private) — PATCH /v1/teams/:id.
    async setTeamVisibility(teamId: string, { visibility }: { visibility: string }, ctx?: { userId?: string }) {
      const userId = ctx?.userId;
      if (!userId) throw new ApiError(401, "missing_auth", "authenticated user required");
      if (visibility !== "public" && visibility !== "private") {
        throw new ApiError(400, "validation_failed", "visibility must be 'public' or 'private'");
      }
      await requireActorForTeam(db, userId, teamId);
      const [r] = await (db.update(teams) as any).set({ visibility, updatedAt: new Date() }).where(eq(teams.id, teamId)).returning();
      if (!r) throw new ApiError(404, "not_found", "team not found");
      return mapTeam(r);
    },

    /**
     * Team-wide LiteLLM token + spend usage. Any team member may read (resolved
     * via requireActorForTeam). The LiteLLM team id is read from the persisted
     * team_workspace_config.litellm_team_id — NEVER reconstructed as
     * `tc-${teamId}`. If the team has never provisioned LiteLLM, returns an
     * empty usage shape WITHOUT touching the LiteLLM RDS. Mirrors
     * supabase-repo.getLiteLlmUsage.
     */

    /**
     * Provisions a LiteLLM team for the given teamId.
     *
     * Requires a `provisionLiteLlm` function to be injected via `deps`.
     * In production this is the real FC provisioner; in tests a stub is used.
     *
     * Persists `litellmTeamId` + `aiGatewayEndpoint` into `team_workspace_config`.
     * Returns `{ aiGatewayEndpoint, litellmKey }`.
     */

    /**
     * Idempotently issues the CALLER's own per-member LiteLLM virtual key,
     * auto-provisioning the team's LiteLLM team first if it hasn't been set
     * up yet (A2-1). There is intentionally NO actorId parameter: the caller
     * can only ever provision a key for themselves, resolved team-scoped via
     * requireActorForTeam (401 if unauthenticated, 403 if not a member of
     * teamId) — mirroring supabase-repo's requireCallerTeamMemberActor and
     * NOT the bugged, non-team-scoped current_member_id() pattern.
     */

    /**
     * Lists the team's LiteLLM virtual keys (masked). Any team member may
     * read — resolved via requireActorForTeam (401/403), mirroring
     * supabase-repo's requireCallerTeamMemberActor. The LiteLLM team id is
     * read from the persisted team_workspace_config.litellmTeamId, NOT
     * reconstructed as `tc-${teamId}`. If the team has never provisioned
     * LiteLLM, returns an empty keys list without calling LiteLLM.
     */

    /**
     * Sets the team's LiteLLM max budget. Owner-only — resolved via
     * requireTeamOwner (401/403), mirroring supabase-repo's
     * requireCallerTeamOwner. The LiteLLM team id is read from the persisted
     * team_workspace_config.litellmTeamId, NEVER reconstructed as
     * `tc-${teamId}`. If the team has never provisioned LiteLLM, throws 409
     * litellm_not_provisioned rather than implicitly setting it up.
     */

    // ── team credits ────────────────────────────────────────────────────────
    // Every read and write goes through the AI gateway rather than these
    // tables directly: it is the ledger's only writer (design §4.9.1), and
    // routing reads the same way keeps period boundaries and shapes identical
    // on both sides of the billing screen.
    //
    // Permission split per §12.6: balance and usage are visible to every
    // member — an exhausted wallet stops their work, so they must be able to
    // see why — while the ledger and every mutation are owner-only.

    /**
     * Resolve actor ids in a usage report to display names.
     *
     * Done here rather than in the gateway: the gateway owns spend, not how a
     * person is presented. It also has no business reading the actor directory
     * — its grant is deliberately narrow.
     */
    async _nameUsageActors(teamId: string, report: any) {
      const ids = (report?.byActor ?? []).map((r: any) => r.actorId).filter(Boolean);
      if (!ids.length) return report;
      const names = await (async () => {
        const rows = await db
          .select({ id: actors.id, displayName: actors.displayName })
          .from(actors)
          .where(and(eq(actors.teamId, teamId), inArray(actors.id, ids)));
        return new Map(rows.map((r) => [r.id, r.displayName]));
      })();
      return {
        ...report,
        byActor: report.byActor.map((r: any) => ({
          ...r,
          // null display name = the unattributed bucket; the UI renders a
          // localized label rather than a raw uuid.
          displayName: r.actorId ? (names.get(r.actorId) ?? null) : null,
        })),
      };
    },
    async getTeamCredits(teamId: string, ctx?: { userId?: string }) {
      await requireActorForTeam(db, requireUser(ctx), teamId);
      const [summary, usage] = await Promise.all([
        aiGateway.creditsSummary(teamId),
        aiGateway.usage(teamId, { range: "month" }),
      ]);
      return {
        teamId,
        balanceCredits: summary.balanceCredits ?? 0,
        period: { range: usage.range, startUtc: usage.startUtc, endUtc: usage.endUtc },
        usedCredits: usage.summary?.credits ?? 0,
      };
    },
    async getCreditUsage(teamId: string, opts: { range?: string; date?: string } = {}, ctx?: { userId?: string }) {
      await requireActorForTeam(db, requireUser(ctx), teamId);
      return this._nameUsageActors(teamId, await aiGateway.usage(teamId, opts));
    },
    async getCreditLedger(teamId: string, opts: { limit?: number } = {}, ctx?: { userId?: string }) {
      await requireTeamOwner(db, requireUser(ctx), teamId);
      return aiGateway.ledger(teamId, opts.limit);
    },
    async topUpCredits(teamId: string, input: any, ctx?: { userId?: string }) {
      await requireTeamOwner(db, requireUser(ctx), teamId);
      const amount = Number(input?.amountCredits);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new ApiError(400, "invalid_request", "amountCredits must be a positive integer");
      }
      // Required rather than generated here: an idempotency key the server
      // invents is a new key on every retry, which defeats the point.
      if (!input?.idempotencyKey) {
        throw new ApiError(400, "invalid_request", "idempotencyKey is required");
      }
      return aiGateway.topUp(teamId, {
        amountCredits: amount,
        kind: input.kind ?? "top_up",
        idempotencyKey: input.idempotencyKey,
        note: input.note ?? null,
      });
    },
    async getMemberQuotas(teamId: string, ctx?: { userId?: string }) {
      await requireActorForTeam(db, requireUser(ctx), teamId);
      return aiGateway.quotas(teamId);
    },
    async setMemberQuotas(teamId: string, input: any, ctx?: { userId?: string }) {
      await requireTeamOwner(db, requireUser(ctx), teamId);
      return aiGateway.setQuotas(teamId, input ?? {});
    },


    /**
     * Creates a new team for the given userId.
     * First-team-only: rejects if the caller already has an actor in any team.
     * Inserts: teams → actors(member) → members(active) → team_members(owner)
     *          → workspaces('General') → team_workspace_config
     */
    async createTeam(input: { name?: string | null; slug?: string; litellmTeamId?: string; aiGatewayEndpoint?: string; displayName?: string | null }, ctx?: { userId?: string }) {
      const userId = ctx?.userId;
      if (!userId) throw new ApiError(400, "bad_request", "userId is required to create a team");

      const teamName =
        (typeof input.name === "string" ? input.name.trim() : "") ||
        (typeof input.displayName === "string" ? input.displayName.trim() : "") ||
        "Personal";

      const created = await (db as any).transaction(async (tx: any) => {
        // First-team-only: check if caller already has an actor in any team
        const [existingActor] = await tx
          .select({ id: actors.id })
          .from(actors)
          .where(eq(actors.userId, userId))
          .limit(1);
        if (existingActor) {
          throw new ApiError(409, "conflict", "user already belongs to a team");
        }

        // Slug dedup: if no slug provided or slug conflicts, generate one
        let slug = input.slug ?? (teamName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "team");
        // Check for conflict and append random suffix if needed
        let attempt = 0;
        while (true) {
          const candidateSlug = attempt === 0 ? slug : `${slug}-${randomBytes(3).toString("hex")}`;
          const [existing] = await tx.select({ id: teams.id }).from(teams).where(eq(teams.slug, candidateSlug)).limit(1);
          if (!existing) { slug = candidateSlug; break; }
          attempt++;
          if (attempt > 5) throw new ApiError(500, "internal_error", "could not generate unique slug");
        }

        // INSERT team
        const [team] = await tx.insert(teams).values({ name: teamName, slug }).returning();

        // INSERT actor (member type, linked to userId). Caller-provided real
        // name wins; otherwise a deterministic "Adjective Animal" handle seeded
        // from the actor id (pre-generated so the name is stable). Never the
        // team name — that conflated personal identity with the workspace.
        const actorId = randomUUID();
        const displayName = input.displayName?.trim() || generateDisplayName(actorId);
        const [actor] = await tx.insert(actors).values({
          id: actorId,
          teamId: team.id,
          actorType: "member",
          displayName,
          userId,
        }).returning();

        // INSERT member (active)
        await tx.insert(members).values({ id: actor.id, status: "active" });

        // INSERT team_member (owner role)
        await tx.insert(teamMembers).values({ teamId: team.id, memberId: actor.id, role: "owner" });

        // INSERT default workspace
        await tx.insert(workspaces).values({ teamId: team.id, name: "General", createdByMemberId: actor.id });

        // INSERT team_workspace_config
        await tx.insert(teamWorkspaceConfig).values({
          teamId: team.id,
          litellmTeamId: input.litellmTeamId ?? null,
          aiGatewayEndpoint: input.aiGatewayEndpoint ?? null,
        });

        return { team: mapTeam(team), ownerActorId: actor.id, litellmTeamId: input.litellmTeamId ?? null };
      });

      return created.team;
    },

    async bootstrapTeam(input: { displayName?: string | null }, ctx?: { userId?: string }) {
      // This compatibility backend has no org table, so it cannot derive an
      // org name. Preserve the first-team atomicity with a neutral name.
      return this.createTeam({ name: "Personal", displayName: input.displayName ?? null }, ctx);
    },

    /**
     * Creates a team invite for the given teamId.
     * Resolves the caller's actorId via requireActorForTeam.
     * Returns { token, inviteId, expiresAt, deeplink }.
     */
    async createTeamInvite(
      teamId: string,
      input: { kind?: string; actorType?: string; displayName: string; teamRole?: string | null; role?: string; agentKind?: string | null; expiresAt?: string | null; ttlSeconds?: number | null; targetActorId?: string | null; inviteEmail?: string | null; invitePhone?: string | null },
      ctx?: { userId?: string },
    ) {
      const userId = ctx?.userId;
      // Allow creating invites without a userId for tests / admin paths — use a null invitedByActorId fallback
      let invitedByActorId: string | null = null;
      if (userId) {
        invitedByActorId = await requireActorForTeam(db, userId, teamId);
      }

      // Derive canonical field values from either production keys (kind/teamRole) or legacy keys (actorType/role)
      const kind = input.kind ?? input.actorType ?? "member";
      const teamRole = input.teamRole !== undefined ? input.teamRole : (input.role ?? null);

      // Default-org guard (parity with supabase-repo.createTeamInvite): a
      // personal team sitting in the shared DEFAULT_ORG is solo-only and cannot
      // pull in members — the user must first upgrade their account (which moves
      // the team into their own org). Agent invites (the daemon's amuxd init)
      // stay allowed so local runtimes keep working. No-op when DEFAULT_ORG_ID
      // is unset or the team carries no oid (the Postgres backend's default).
      const defaultOrgId = process.env.DEFAULT_ORG_ID || "";
      if (defaultOrgId && kind === "member") {
        const [t] = await db.select({ oid: teams.oid }).from(teams).where(eq(teams.id, teamId)).limit(1);
        if (t?.oid === defaultOrgId) {
          throw new ApiError(403, "upgrade_required", "升级账号后才能邀请成员加入团队");
        }
      }

      // Member re-invite was removed in 20260811110000, and this backend never
      // implemented it: the rebind path in auth.ts lives inside the agent claim
      // branch. Reject it by name rather than letting it fall through to the
      // agent-ownership check below and come back as "only the agent owner can
      // re-invite this agent", which says nothing true about a member.
      if (input.targetActorId && kind === "member") {
        throw new ApiError(400, "validation_failed", "member invites cannot target an existing actor");
      }

      // Owner check: only the agent owner may re-invite an existing agent actor
      if (input.targetActorId) {
        if (!userId) throw new ApiError(401, "missing_identity", "re-inviting an agent requires authentication");
        const owns = await checkAgentOwnership(db, userId, input.targetActorId);
        if (!owns) throw new ApiError(403, "forbidden", "only the agent owner can re-invite this agent");
      }

      // Optional invitee contact. Member-only: agent invites are claimed by a
      // daemon that provisions its own identity, so there is nobody to match.
      const inviteEmail = normalizeInviteEmail(input.inviteEmail);
      const invitePhone = (input.invitePhone ?? "").trim() || null;
      if (kind !== "member" && (inviteEmail || invitePhone)) {
        throw new ApiError(400, "validation_failed", "agent invites cannot carry invite_email/invite_phone");
      }
      if (inviteEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inviteEmail)) {
        throw new ApiError(400, "validation_failed", "invite_email is not a valid email address");
      }

      const token = randomBytes(24).toString("base64url");
      const ttlSeconds = input.ttlSeconds ?? 7 * 24 * 60 * 60; // 7 days default
      const expiresAt = input.expiresAt
        ? new Date(input.expiresAt)
        : new Date(Date.now() + ttlSeconds * 1000);

      // Supersede any live invite to the same email rather than letting the
      // partial unique index reject the call: re-sending an invite means "this
      // one is now current", and the old token stops working.
      if (inviteEmail) {
        await (db as any)
          .update(teamInvites)
          .set({ status: "expired", updatedAt: new Date() })
          .where(
            and(
              eq(teamInvites.teamId, teamId),
              eq(teamInvites.status, "pending"),
              sql`lower(btrim(${teamInvites.inviteEmail})) = ${inviteEmail}`,
            ),
          );
      }

      const [invite] = await (db as any)
        .insert(teamInvites)
        .values({
          teamId,
          token,
          kind,
          teamRole,
          agentKind: input.agentKind ?? null,
          displayName: input.displayName,
          invitedByActorId: invitedByActorId ?? "00000000-0000-0000-0000-000000000000",
          expiresAt,
          targetActorId: input.targetActorId ?? null,
          inviteEmail,
          invitePhone,
          status: "pending",
        })
        .returning();

      return {
        token: invite.token,
        inviteId: invite.id,
        expiresAt: invite.expiresAt ? new Date(invite.expiresAt).toISOString() : null,
        deeplink: null,
      };
    },

    /**
     * Removes an actor and all associated rows (cascade).
     * Authz mirrors amux.remove_team_actor (personal agent → owner; team agent → admin).
     */
    async removeTeamActor(teamId: string, actorId: string, ctx: { userId?: string } = {}) {
      if (!ctx.userId) {
        throw new ApiError(401, "unauthorized", "remove_team_actor requires authentication");
      }

      const [targetActor] = await db
        .select({ actorType: actors.actorType, teamId: actors.teamId })
        .from(actors)
        .where(eq(actors.id, actorId))
        .limit(1);

      if (!targetActor || targetActor.teamId !== teamId) {
        throw new ApiError(404, "not_found", "actor not found");
      }

      let agentMeta: { visibility: string | null; ownerMemberId: string | null } | null = null;
      if (targetActor.actorType === "agent") {
        const [ag] = await db
          .select({ visibility: agents.visibility, ownerMemberId: agents.ownerMemberId })
          .from(agents)
          .where(eq(agents.id, actorId))
          .limit(1);
        agentMeta = ag ?? null;
      }

      await assertCanRemoveTeamActor(db, ctx.userId, teamId, {
        id: actorId,
        actor_type: targetActor.actorType,
        visibility: agentMeta?.visibility ?? null,
        ownerMemberId: agentMeta?.ownerMemberId ?? null,
      });

      try {
        await (db as any).transaction(async (tx: any) => {
          if (targetActor.actorType === "member") {
            const ownedAgents = await tx
              .select({ id: agents.id })
              .from(agents)
              .where(eq(agents.ownerMemberId, actorId));

            for (const owned of ownedAgents) {
              await tx.delete(agentMemberAccess).where(
                or(
                  eq(agentMemberAccess.agentId, owned.id),
                  eq(agentMemberAccess.memberId, owned.id),
                ),
              );
              await tx.delete(teamMembers).where(eq(teamMembers.memberId, owned.id));
              await tx.delete(actors).where(eq(actors.id, owned.id));
            }
          }

          await tx.delete(agentMemberAccess).where(
            or(
              eq(agentMemberAccess.agentId, actorId),
              eq(agentMemberAccess.memberId, actorId),
            ),
          );
          await tx.delete(teamMembers).where(eq(teamMembers.memberId, actorId));

          if (targetActor.actorType === "member") {
            await tx.delete(members).where(eq(members.id, actorId));
          } else {
            await tx.delete(agents).where(eq(agents.id, actorId));
          }

          await tx.delete(actors).where(eq(actors.id, actorId));
        });
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        if (/foreign key|violates foreign key|23503/i.test(msg)) {
          throw mapActorDeleteFkError(msg);
        }
        throw e;
      }
    },

    /**
     * Loads the git-related columns from team_workspace_config.
     * Returns the raw row (null if absent) — matches supabase-repo shape.
     */
    async loadTeamWorkspaceGitConfig(teamId: string) {
      const [r] = await db
        .select({
          teamId: teamWorkspaceConfig.teamId,
          gitUrl: teamWorkspaceConfig.gitUrl,
          gitBranch: teamWorkspaceConfig.gitBranch,
          gitToken: teamWorkspaceConfig.gitToken,
          aiGatewayEndpoint: teamWorkspaceConfig.aiGatewayEndpoint,
          enabled: teamWorkspaceConfig.enabled,
          updatedAt: teamWorkspaceConfig.updatedAt,
        })
        .from(teamWorkspaceConfig)
        .where(eq(teamWorkspaceConfig.teamId, teamId))
        .limit(1);
      if (!r) return null;
      // Return in snake_case shape matching supabase-repo consumer expectations.
      return {
        team_id: r.teamId,
        git_url: r.gitUrl ?? null,
        git_branch: r.gitBranch ?? null,
        git_token: r.gitToken ?? null,
        ai_gateway_endpoint: r.aiGatewayEndpoint ?? null,
        enabled: r.enabled,
        updated_at: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
      };
    },

    /**
     * Upserts git-related columns in team_workspace_config.
     * Accepts a plain object whose keys mirror the DB row (snake_case or camelCase).
     */
    async saveTeamWorkspaceGitConfig(input: Record<string, any>) {
      const teamId = input.team_id ?? input.teamId;
      if (!teamId) throw new ApiError(400, "bad_request", "team_id is required");

      const row: Record<string, any> = {
        teamId,
        updatedAt: new Date(),
      };
      if (input.git_url !== undefined) row.gitUrl = input.git_url;
      if (input.gitUrl !== undefined) row.gitUrl = input.gitUrl;
      if (input.git_branch !== undefined) row.gitBranch = input.git_branch;
      if (input.gitBranch !== undefined) row.gitBranch = input.gitBranch;
      if (input.git_token !== undefined) row.gitToken = input.git_token;
      if (input.gitToken !== undefined) row.gitToken = input.gitToken;
      if (input.ai_gateway_endpoint !== undefined) row.aiGatewayEndpoint = input.ai_gateway_endpoint;
      if (input.aiGatewayEndpoint !== undefined) row.aiGatewayEndpoint = input.aiGatewayEndpoint;
      if (input.enabled !== undefined) row.enabled = input.enabled;

      await (db.insert(teamWorkspaceConfig) as any)
        .values(row)
        .onConflictDoUpdate({
          target: teamWorkspaceConfig.teamId,
          set: { ...row, updatedAt: new Date() },
        });
    },
  };
}
