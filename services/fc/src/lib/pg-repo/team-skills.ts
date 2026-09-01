/**
 * Team skills registry — pg-repo implementation.
 *
 * Design: docs/architecture/team-skills-registry.md
 *
 * Two things worth knowing before editing:
 *
 * 1. Version metadata is snapshotted onto every team_skill_versions row on
 *    purpose. team_skills carries "current"; a version row carries "the fact
 *    at that version". Without the snapshot, editing a description rewrites
 *    the notes for every historical version, so somebody sitting on v1 reads
 *    v3's when_not_to_use.
 *
 * 2. installs.actor_id generalises over both install subjects — a member actor
 *    installing for themselves, and a visibility='team' agent actor an admin
 *    installs for. assertCanInstallFor is the single gate; it mirrors the RLS
 *    policy in the migration, because the supabase backend enforces via RLS and
 *    the postgres backend has no RLS to lean on.
 *
 * 3. Editing the registry is open to every team member: publish, revert, patch
 *    metadata, delete. `owner_actor_id` stays as the answer to "who is
 *    responsible for this", not as a permission — the registry is team
 *    property, and the publish gate is the required fields, never an approver.
 *    Installing is the exception that stays gated (see assertCanInstallFor):
 *    it writes to somebody's machine rather than to shared content.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  teamSkills,
  teamSkillVersions,
  teamSkillInstalls,
  marketplaceSkills,
  marketplaceSkillVersions,
  actors,
  agents,
  amuxcBlobs,
} from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";
import { checkAgentOwnership, requireActorForTeam, resolveTeamRole } from "./authz.js";
import { alignTeamSkillToMarketplace } from "./marketplace.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

interface TeamSkillsCtx {
  userId?: string;
}

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

const CATEGORIES = [
  "general",
  "coding",
  "devops",
  "data",
  "research",
  "writing",
  "communication",
  "integration",
] as const;

const STATUSES = ["draft", "published", "deprecated"] as const;

/**
 * The publish gate. Every field here is required because the whole point of the
 * registry is that "who owns this / when to use it / when NOT to use it" stops
 * being buried in one free-text description blob.
 */
function requirePublishFields(body: any, { partial = false } = {}) {
  const out: Record<string, unknown> = {};
  const need = (key: string, value: unknown, label: string) => {
    if (value === undefined) {
      if (partial) return;
      throw new ApiError(400, "validation_failed", `${label} is required`);
    }
    if (typeof value !== "string" || !value.trim()) {
      throw new ApiError(400, "validation_failed", `${label} must be a non-empty string`);
    }
    out[key] = value.trim();
  };
  // Present-but-empty is a real answer here, and it is stored as one.
  const optional = (key: string, value: unknown) => {
    if (value === undefined) return;
    out[key] = typeof value === "string" ? value.trim() : "";
  };

  // `summary` and `category` stay required: one is the list subtitle, the other
  // drives filtering, and a registry full of blanks in either is unusable.
  // The two guidance fields are not — they are what a thoughtful author writes,
  // not a gate on sharing at all. Demanding them up front mostly produced
  // placeholder text, which is worse than an empty field: it reads as guidance
  // and isn't.
  need("summary", body.summary, "summary");
  need("category", body.category, "category");
  optional("whenToUse", body.whenToUse);
  optional("whenNotToUse", body.whenNotToUse);

  if (out.summary !== undefined && (out.summary as string).length > 200) {
    throw new ApiError(400, "validation_failed", "summary must be 200 characters or fewer");
  }
  if (out.category !== undefined && !CATEGORIES.includes(out.category as never)) {
    throw new ApiError(
      400,
      "validation_failed",
      `category must be one of: ${CATEGORIES.join(", ")}`,
    );
  }
  if (body.requires !== undefined) out.requires = body.requires ?? null;
  return out;
}

function mapSkill(row: any, extra: Record<string, unknown> = {}) {
  return {
    id: row.id,
    teamId: row.teamId,
    slug: row.slug,
    ownerActorId: row.ownerActorId,
    summary: row.summary,
    category: row.category,
    whenToUse: row.whenToUse,
    whenNotToUse: row.whenNotToUse,
    requires: row.requires ?? null,
    status: row.status,
    supersededBy: row.supersededBy ?? null,
    latestVersion: row.latestVersion ?? 0,
    createdBy: row.createdBy,
    origin: row.origin ?? "local",
    upstreamSlug: row.upstreamSlug ?? null,
    upstreamSubscribed: !!row.upstreamSubscribed,
    upstreamDetachedAt: iso(row.upstreamDetachedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    ...extra,
  };
}

function mapVersion(row: any) {
  return {
    version: row.version,
    contentHash: row.contentHash,
    size: row.size ?? 0,
    changelog: row.changelog,
    summary: row.summary,
    whenToUse: row.whenToUse,
    whenNotToUse: row.whenNotToUse,
    requires: row.requires ?? null,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
  };
}

function mapInstall(row: any) {
  return {
    id: row.id,
    teamId: row.teamId,
    actorId: row.actorId,
    skillId: row.skillId,
    installedVersion: row.installedVersion,
    scope: row.scope,
    workspaceId: row.workspaceId ?? null,
    installedAt: iso(row.installedAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function makeTeamSkillsRepo(db: DbLike, ctx: TeamSkillsCtx) {
  function requireUser(): string {
    if (!ctx.userId) throw new ApiError(401, "unauthorized", "authentication required");
    return ctx.userId;
  }

  async function isTeamAdmin(userId: string, teamId: string): Promise<boolean> {
    const role = await resolveTeamRole(db, userId, teamId);
    return role === "owner" || role === "admin";
  }

  async function loadSkill(teamId: string, slug: string) {
    const [row] = await db
      .select()
      .from(teamSkills)
      .where(and(eq(teamSkills.teamId, teamId), eq(teamSkills.slug, slug)))
      .limit(1);
    if (!row) throw new ApiError(404, "not_found", `skill not found: ${slug}`);
    return row;
  }

  /**
   * The install gates:
   *   - target is the caller's own member actor   → allow
   *   - target is an agent the caller owns        → allow
   *   - target is a visibility='team' agent actor → require team admin
   *   - target is somebody else's member actor    → deny, always
   *
   * The last one is deliberate: an admin owns the team's shared agents, not a
   * teammate's personal setup. "Push a skill onto a person" is not a thing.
   *
   * The owner gate exists because a member's own machine is an agent, not a
   * member actor: sharing or publishing a skill from the desktop installs it
   * into that machine's skills root, and the install has to be recorded against
   * the agent that will be asked "what do you have installed". Without this
   * branch that record could only land on the member, where the agent's own
   * inventory never looks — the skill then sat on disk, loaded by the runtime,
   * and missing from the skills column.
   */
  async function assertCanInstallFor(userId: string, teamId: string, targetActorId: string) {
    const callerActorId = await requireActorForTeam(db, userId, teamId);
    if (targetActorId === callerActorId) return callerActorId;

    const [target] = await db
      .select({ id: actors.id, teamId: actors.teamId })
      .from(actors)
      .where(eq(actors.id, targetActorId))
      .limit(1);
    if (!target) throw new ApiError(404, "not_found", "target actor not found");
    if (target.teamId !== teamId) {
      throw new ApiError(403, "forbidden", "target actor belongs to a different team");
    }

    const [agentRow] = await db
      .select({ visibility: agents.visibility })
      .from(agents)
      .where(eq(agents.id, targetActorId))
      .limit(1);

    if (!agentRow) {
      throw new ApiError(
        403,
        "forbidden",
        "cannot install on behalf of another member — only on yourself or a team agent",
      );
    }
    if (await checkAgentOwnership(db, userId, targetActorId)) return callerActorId;
    if (agentRow.visibility !== "team") {
      throw new ApiError(
        403,
        "forbidden",
        "that agent is personal; only its owner can install skills on it",
      );
    }
    if (!(await isTeamAdmin(userId, teamId))) {
      throw new ApiError(403, "forbidden", "only a team admin may install skills on a team agent");
    }
    return callerActorId;
  }

  return {
    /**
     * Full registry list. `actorId` (defaults to the caller) decides whose
     * install state decorates each row — that's how the desktop list column
     * paints "installed / has update" and how an admin inspects a team agent.
     */
    async listTeamSkills(teamId: string, opts: any = {}) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);
      const subjectActorId = opts.actorId ?? callerActorId;

      const conditions = [eq(teamSkills.teamId, teamId)];
      if (opts.status) {
        if (!STATUSES.includes(opts.status)) {
          throw new ApiError(400, "validation_failed", `unknown status: ${opts.status}`);
        }
        conditions.push(eq(teamSkills.status, opts.status));
      }
      if (opts.category) conditions.push(eq(teamSkills.category, opts.category));

      let rows = await db
        .select()
        .from(teamSkills)
        .where(and(...conditions))
        .orderBy(teamSkills.slug);

      // Lazy marketplace align (§7.1): project upstream latest into subscribed
      // rows before decorating install state. Idempotent under concurrent polls.
      let alignedAny = false;
      for (const r of rows) {
        if (r.upstreamSubscribed && r.origin === "marketplace") {
          if (await alignTeamSkillToMarketplace(db, r)) alignedAny = true;
        }
      }
      // Only re-read when something actually moved. This is the endpoint every
      // daemon polls on a 10-minute tick, and for a team with no marketplace
      // skills the loop above is a no-op — paying for a second full scan of the
      // registry on every poll to observe nothing is the wrong default.
      if (alignedAny) {
        rows = await db
          .select()
          .from(teamSkills)
          .where(and(...conditions))
          .orderBy(teamSkills.slug);
      }

      if (!rows.length) return [];

      const installs = await db
        .select()
        .from(teamSkillInstalls)
        .where(
          and(
            eq(teamSkillInstalls.actorId, subjectActorId),
            inArray(
              teamSkillInstalls.skillId,
              rows.map((r: any) => r.id),
            ),
          ),
        );
      const bySkill = new Map<string, any>();
      for (const i of installs) bySkill.set(i.skillId, i);

      return rows.map((r: any) => {
        const installed = bySkill.get(r.id);
        return mapSkill(r, {
          installed: !!installed,
          installedVersion: installed?.installedVersion ?? null,
          installScope: installed?.scope ?? null,
          hasUpdate: !!installed && installed.installedVersion < r.latestVersion,
        });
      });
    },

    async getTeamSkill(teamId: string, slug: string, opts: any = {}) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);
      const subjectActorId = opts.actorId ?? callerActorId;

      const skill = await loadSkill(teamId, slug);
      const versions = await db
        .select()
        .from(teamSkillVersions)
        .where(eq(teamSkillVersions.skillId, skill.id))
        .orderBy(desc(teamSkillVersions.version));
      const [installed] = await db
        .select()
        .from(teamSkillInstalls)
        .where(
          and(
            eq(teamSkillInstalls.actorId, subjectActorId),
            eq(teamSkillInstalls.skillId, skill.id),
          ),
        )
        .limit(1);

      return {
        ...mapSkill(skill, {
          installed: !!installed,
          installedVersion: installed?.installedVersion ?? null,
          installScope: installed?.scope ?? null,
          hasUpdate: !!installed && installed.installedVersion < skill.latestVersion,
        }),
        versions: versions.map(mapVersion),
      };
    },

    /**
     * Publish v1. The zip is uploaded separately (amuxc blob prepare/complete);
     * this records the metadata and points at the resulting contentHash.
     */
    async createTeamSkill(teamId: string, body: any = {}) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);

      const slug = String(body.slug ?? "").trim();
      if (!SLUG_RE.test(slug)) {
        throw new ApiError(
          400,
          "validation_failed",
          "slug must be 2-64 chars of [a-z0-9-] and start with a letter or digit",
        );
      }
      const fields = requirePublishFields(body);
      const changelog = String(body.changelog ?? "").trim();
      if (!changelog) throw new ApiError(400, "validation_failed", "changelog is required");
      const contentHash = String(body.contentHash ?? "").trim();
      if (!contentHash) throw new ApiError(400, "validation_failed", "contentHash is required");

      const [existing] = await db
        .select({ id: teamSkills.id })
        .from(teamSkills)
        .where(and(eq(teamSkills.teamId, teamId), eq(teamSkills.slug, slug)))
        .limit(1);
      if (existing) {
        throw new ApiError(
          409,
          "conflict",
          `a skill named ${slug} already exists — publish a new version instead`,
        );
      }

      const [skill] = await (db.insert(teamSkills) as any)
        .values({
          teamId,
          slug,
          ownerActorId: body.ownerActorId ?? callerActorId,
          summary: fields.summary as string,
          category: fields.category as string,
          whenToUse: fields.whenToUse as string,
          whenNotToUse: fields.whenNotToUse as string,
          requires: (fields.requires as any) ?? null,
          status: body.status && STATUSES.includes(body.status) ? body.status : "published",
          latestVersion: 1,
          createdBy: callerActorId,
        })
        .returning();

      await (db.insert(teamSkillVersions) as any).values({
        skillId: skill.id,
        version: 1,
        contentHash,
        size: Number(body.size ?? 0),
        changelog,
        summary: fields.summary as string,
        whenToUse: fields.whenToUse as string,
        whenNotToUse: fields.whenNotToUse as string,
        requires: (fields.requires as any) ?? null,
        createdBy: callerActorId,
      });

      return mapSkill(skill);
    },

    /** Publish a new version. Metadata is snapshotted onto the version row. */
    async createTeamSkillVersion(teamId: string, slug: string, body: any = {}) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);

      const changelog = String(body.changelog ?? "").trim();
      if (!changelog) throw new ApiError(400, "validation_failed", "changelog is required");
      const contentHash = String(body.contentHash ?? "").trim();
      if (!contentHash) throw new ApiError(400, "validation_failed", "contentHash is required");

      if (body.expectedLatestVersion === undefined || body.expectedLatestVersion === null) {
        throw new ApiError(400, "validation_failed", "expectedLatestVersion is required");
      }
      const expectedLatestVersion = Number(body.expectedLatestVersion);
      if (!Number.isInteger(expectedLatestVersion) || expectedLatestVersion < 0) {
        throw new ApiError(
          400,
          "validation_failed",
          "expectedLatestVersion must be a non-negative integer",
        );
      }

      const patch = requirePublishFields(body, { partial: true });

      return db.transaction(async (tx: any) => {
        const [skill] = await tx
          .select()
          .from(teamSkills)
          .where(and(eq(teamSkills.teamId, teamId), eq(teamSkills.slug, slug)))
          .for("update")
          .limit(1);
        if (!skill) throw new ApiError(404, "not_found", `skill not found: ${slug}`);

        let current = skill;
        if (skill.upstreamSubscribed) {
          const [detached] = await (tx.update(teamSkills) as any)
            .set({
              upstreamSubscribed: false,
              upstreamDetachedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(teamSkills.id, skill.id))
            .returning();
          current = detached;
        }

        const latest = current.latestVersion ?? 0;
        if (latest !== expectedLatestVersion) {
          throw new ApiError(
            409,
            "stale_team_skill_base",
            `team skill base version mismatch: expected v${expectedLatestVersion}, registry is v${latest}`,
          );
        }

        const merged = {
          summary: (patch.summary as string) ?? current.summary,
          whenToUse: (patch.whenToUse as string) ?? current.whenToUse,
          whenNotToUse: (patch.whenNotToUse as string) ?? current.whenNotToUse,
          requires: patch.requires !== undefined ? patch.requires : current.requires,
          category: (patch.category as string) ?? current.category,
        };

        const nextVersion = latest + 1;
        const [version] = await (tx.insert(teamSkillVersions) as any)
          .values({
            skillId: current.id,
            version: nextVersion,
            contentHash,
            size: Number(body.size ?? 0),
            changelog,
            summary: merged.summary,
            whenToUse: merged.whenToUse,
            whenNotToUse: merged.whenNotToUse,
            requires: (merged.requires as any) ?? null,
            createdBy: callerActorId,
            blobScope: "team",
          })
          .returning();

        await (tx.update(teamSkills) as any)
          .set({
            latestVersion: nextVersion,
            summary: merged.summary,
            whenToUse: merged.whenToUse,
            whenNotToUse: merged.whenNotToUse,
            requires: (merged.requires as any) ?? null,
            category: merged.category,
          })
          .where(eq(teamSkills.id, current.id));

        return mapVersion(version);
      });
    },

    /**
     * Re-publish an earlier version's content as the new latest.
     *
     * This is the undo for a bad publish, and it has to exist before installs
     * auto-follow: without it a broken version reaches every member within one
     * reconcile tick and the only remedy is for the author to reconstruct the
     * old bytes by hand.
     *
     * Rolling `latest_version` backwards would be the obvious alternative and is
     * deliberately not offered — it would leave members whose
     * `installed_version` exceeds `latest_version`, at which point "is there an
     * update" has no answer and the reconcile cannot tell whether to move them
     * forward or back. Versions only ever go up; a revert is a new one carrying
     * old content.
     */
    async revertTeamSkillVersion(teamId: string, slug: string, targetVersion: number, body: any = {}) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);
      let skill = await loadSkill(teamId, slug);

      // A revert is a team-authored version like any other, so it detaches a
      // subscribed skill exactly as `createTeamSkillVersion` does. Without this
      // the new version carries no `upstream_version`, the next align reads
      // that as "upstream 0" and immediately re-projects marketplace latest —
      // the revert is undone on the very next list request, silently.
      if (skill.upstreamSubscribed) {
        await (db.update(teamSkills) as any)
          .set({
            upstreamSubscribed: false,
            upstreamDetachedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(teamSkills.id, skill.id));
        skill = await loadSkill(teamId, slug);
      }

      const [source] = await db
        .select()
        .from(teamSkillVersions)
        .where(
          and(
            eq(teamSkillVersions.skillId, skill.id),
            eq(teamSkillVersions.version, targetVersion),
          ),
        )
        .limit(1);
      if (!source) throw new ApiError(404, "not_found", `version ${targetVersion} not found`);
      if (targetVersion === skill.latestVersion) {
        throw new ApiError(409, "conflict", `v${targetVersion} is already the latest version`);
      }

      const changelog =
        String(body.changelog ?? "").trim() || `Reverted to v${targetVersion}`;
      const nextVersion = (skill.latestVersion ?? 0) + 1;

      // The metadata snapshot travels with the content. "Revert to v3" that
      // restored v3's files under v7's description would produce a package
      // whose SKILL.md frontmatter contradicts itself on every install.
      const [version] = await (db.insert(teamSkillVersions) as any)
        .values({
          skillId: skill.id,
          version: nextVersion,
          contentHash: source.contentHash,
          size: source.size ?? 0,
          changelog,
          summary: source.summary,
          whenToUse: source.whenToUse,
          whenNotToUse: source.whenNotToUse,
          requires: (source.requires as any) ?? null,
          createdBy: callerActorId,
          // Blob ownership travels with the content. A marketplace-sourced
          // version lives at `object_path` and is deliberately absent from
          // `amuxc_blobs` (design §4.1), so a revert that dropped these two
          // columns produced a row whose download fell into the team-blob
          // branch, found nothing, and 409'd forever.
          blobScope: source.blobScope ?? "team",
          objectPath: source.objectPath ?? null,
          // Provenance only — the skill is detached above, so nothing aligns
          // against it. Keeping it means a later re-adopt can still tell which
          // upstream version these bytes came from.
          upstreamVersion: source.upstreamVersion ?? null,
        })
        .returning();

      await (db.update(teamSkills) as any)
        .set({
          latestVersion: nextVersion,
          summary: source.summary,
          whenToUse: source.whenToUse,
          whenNotToUse: source.whenNotToUse,
          requires: (source.requires as any) ?? null,
        })
        .where(eq(teamSkills.id, skill.id));

      return mapVersion(version);
    },

    /** Metadata edit, owner transfer, deprecation. */
    async updateTeamSkill(teamId: string, slug: string, patch: any = {}) {
      const userId = requireUser();
      // Team membership is the whole gate. Metadata, ownership and deprecation
      // are the team's to change, not one member's to hold.
      await requireActorForTeam(db, userId, teamId);
      const skill = await loadSkill(teamId, slug);

      // Subscribed marketplace skills: snapshot fields are owned by upstream
      // align. Refuse edits rather than silently overwrite next tick (§7.2).
      const snapshotKeys = ["summary", "category", "whenToUse", "whenNotToUse", "requires"];
      if (skill.upstreamSubscribed && snapshotKeys.some((k) => patch[k] !== undefined)) {
        throw new ApiError(
          409,
          "subscribed",
          "disconnect from the marketplace before editing metadata",
        );
      }

      const fields = requirePublishFields(patch, { partial: true });
      const update: Record<string, unknown> = { ...fields };

      if (patch.ownerActorId !== undefined) {
        const [next] = await db
          .select({ id: actors.id, teamId: actors.teamId })
          .from(actors)
          .where(eq(actors.id, patch.ownerActorId))
          .limit(1);
        if (!next || next.teamId !== teamId) {
          throw new ApiError(400, "validation_failed", "new owner must be an actor in this team");
        }
        update.ownerActorId = patch.ownerActorId;
      }

      if (patch.status !== undefined) {
        if (!STATUSES.includes(patch.status)) {
          throw new ApiError(400, "validation_failed", `unknown status: ${patch.status}`);
        }
        update.status = patch.status;
      }
      if (patch.supersededBy !== undefined) {
        update.supersededBy = patch.supersededBy || null;
      }

      if (!Object.keys(update).length) return mapSkill(skill);

      const [row] = await (db.update(teamSkills) as any)
        .set(update)
        .where(eq(teamSkills.id, skill.id))
        .returning();
      return mapSkill(row);
    },

    async deleteTeamSkill(teamId: string, slug: string) {
      const userId = requireUser();
      await requireActorForTeam(db, userId, teamId);
      const skill = await loadSkill(teamId, slug);
      await db.delete(teamSkills).where(eq(teamSkills.id, skill.id));
    },

    /** Resolve the blob to download for a given version. */
    async getTeamSkillVersion(teamId: string, slug: string, version: number) {
      requireUser();
      await requireActorForTeam(db, requireUser(), teamId);
      const skill = await loadSkill(teamId, slug);
      const [row] = await db
        .select()
        .from(teamSkillVersions)
        .where(
          and(eq(teamSkillVersions.skillId, skill.id), eq(teamSkillVersions.version, version)),
        )
        .limit(1);
      if (!row) throw new ApiError(404, "not_found", `version ${version} not found`);
      return { ...mapVersion(row), slug: skill.slug, skillId: skill.id, teamId };
    },

    /**
     * Resolve a version to its blob location so the route can hand back a
     * signed URL. Marketplace-origin versions skip amuxc_blobs and use the
     * object_path snapshotted onto the version row (§4.3 / §8.2).
     */
    async getTeamSkillDownload(teamId: string, slug: string, version: number) {
      const userId = requireUser();
      await requireActorForTeam(db, userId, teamId);
      const skill = await loadSkill(teamId, slug);
      const [ver] = await db
        .select()
        .from(teamSkillVersions)
        .where(
          and(eq(teamSkillVersions.skillId, skill.id), eq(teamSkillVersions.version, version)),
        )
        .limit(1);
      if (!ver) throw new ApiError(404, "not_found", `version ${version} not found`);

      if (ver.blobScope === "marketplace") {
        if (!ver.objectPath) {
          throw new ApiError(
            409,
            "blob_missing",
            `marketplace package path missing for ${slug}@${version}`,
          );
        }
        return { contentHash: ver.contentHash, size: ver.size ?? 0, ossKey: ver.objectPath };
      }

      const [row] = await db
        .select({
          contentHash: teamSkillVersions.contentHash,
          size: teamSkillVersions.size,
          ossKey: amuxcBlobs.ossKey,
        })
        .from(teamSkillVersions)
        .leftJoin(
          amuxcBlobs,
          and(
            eq(amuxcBlobs.teamId, teamId),
            eq(amuxcBlobs.contentHash, teamSkillVersions.contentHash),
          ),
        )
        .where(
          and(eq(teamSkillVersions.skillId, skill.id), eq(teamSkillVersions.version, version)),
        )
        .limit(1);
      if (!row) throw new ApiError(404, "not_found", `version ${version} not found`);
      if (!row.ossKey) {
        throw new ApiError(
          409,
          "blob_missing",
          `package blob for ${slug}@${version} is not uploaded yet`,
        );
      }
      return { contentHash: row.contentHash, size: row.size ?? 0, ossKey: row.ossKey };
    },

    /**
     * Adopt a marketplace catalog entry into the team registry (subscribed).
     * Zero-byte: package already lives at marketplace/blobs/….
     */
    async adoptMarketplaceSkill(teamId: string, body: any = {}) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);
      const marketplaceSlug = String(body.marketplaceSlug ?? "").trim();
      if (!marketplaceSlug) {
        throw new ApiError(400, "validation_failed", "marketplaceSlug is required");
      }

      const [m] = await db
        .select()
        .from(marketplaceSkills)
        .where(eq(marketplaceSkills.slug, marketplaceSlug))
        .limit(1);
      if (!m || m.status !== "published" || !m.latestVersion) {
        throw new ApiError(404, "not_found", `marketplace skill not found: ${marketplaceSlug}`);
      }

      const teamSlug = String(body.slug ?? marketplaceSlug).trim();
      if (!SLUG_RE.test(teamSlug)) {
        throw new ApiError(
          400,
          "validation_failed",
          "slug must be 2-64 chars of [a-z0-9-] and start with a letter or digit",
        );
      }

      const [existing] = await db
        .select({ id: teamSkills.id })
        .from(teamSkills)
        .where(and(eq(teamSkills.teamId, teamId), eq(teamSkills.slug, teamSlug)))
        .limit(1);
      if (existing) {
        throw new ApiError(
          409,
          "conflict",
          `a skill named ${teamSlug} already exists — pick a different slug`,
        );
      }

      const wantVersion = body.version != null ? Number(body.version) : m.latestVersion;
      const [mVer] = await db
        .select()
        .from(marketplaceSkillVersions)
        .where(
          and(
            eq(marketplaceSkillVersions.skillId, m.id),
            eq(marketplaceSkillVersions.version, wantVersion),
          ),
        )
        .limit(1);
      if (!mVer || !mVer.publishedAt) {
        throw new ApiError(404, "not_found", `marketplace version ${wantVersion} not found`);
      }

      // Similarity hint (P2): surface overlapping when_to_use among existing skills.
      const siblings = await db
        .select({ slug: teamSkills.slug, summary: teamSkills.summary, whenToUse: teamSkills.whenToUse })
        .from(teamSkills)
        .where(and(eq(teamSkills.teamId, teamId), eq(teamSkills.status, "published")));
      const needle = (m.whenToUse || m.summary || "").toLowerCase();
      const similar = siblings
        .filter((s: any) => {
          const hay = `${s.whenToUse || ""} ${s.summary || ""}`.toLowerCase();
          if (!needle || !hay) return false;
          const words = needle.split(/\s+/).filter((w: string) => w.length > 2);
          return words.filter((w: string) => hay.includes(w)).length >= 2;
        })
        .slice(0, 3)
        .map((s: any) => ({ slug: s.slug, summary: s.summary }));

      // Both inserts or neither. Committing the skill row and then failing on
      // the version row leaves a skill stuck at "v1" with no v1 to download,
      // and — because the slug is now taken — no way to re-adopt it either.
      // The failure modes are real: RLS on team_skill_versions, a unique
      // violation from a concurrent adopt, a dropped connection.
      const skill = await (db as any).transaction(async (tx: any) => {
        const [created] = await (tx.insert(teamSkills) as any)
          .values({
            teamId,
            slug: teamSlug,
            ownerActorId: callerActorId,
            summary: m.summary,
            category: m.category,
            whenToUse: m.whenToUse,
            whenNotToUse: m.whenNotToUse,
            requires: m.requires,
            status: "published",
            latestVersion: 1,
            createdBy: callerActorId,
            origin: "marketplace",
            upstreamSlug: marketplaceSlug,
            upstreamSubscribed: true,
          })
          .returning();

        await (tx.insert(teamSkillVersions) as any).values({
          skillId: created.id,
          version: 1,
          contentHash: mVer.contentHash,
          size: mVer.size,
          changelog: `引自市场 ${marketplaceSlug} v${wantVersion}`,
          summary: mVer.summary,
          whenToUse: mVer.whenToUse,
          whenNotToUse: mVer.whenNotToUse,
          requires: mVer.requires,
          createdBy: callerActorId,
          upstreamVersion: wantVersion,
          blobScope: "marketplace",
          objectPath: mVer.objectPath,
        });

        return created;
      });

      return { ...mapSkill(skill), similarSkills: similar };
    },

    async detachMarketplaceSkill(teamId: string, slug: string) {
      const userId = requireUser();
      await requireActorForTeam(db, userId, teamId);
      const skill = await loadSkill(teamId, slug);
      if (skill.origin !== "marketplace") {
        throw new ApiError(400, "validation_failed", "skill is not from the marketplace");
      }
      const [row] = await (db.update(teamSkills) as any)
        .set({
          upstreamSubscribed: false,
          upstreamDetachedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(teamSkills.id, skill.id))
        .returning();
      return mapSkill(row);
    },

    /**
     * Record an install. Upsert on (actor, skill, scope, workspace) so a version
     * bump overwrites rather than piling up rows.
     */
    async installTeamSkill(teamId: string, slug: string, body: any = {}) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);
      const targetActorId = body.actorId ?? callerActorId;
      await assertCanInstallFor(userId, teamId, targetActorId);

      const skill = await loadSkill(teamId, slug);
      const scope = body.scope === "workspace" ? "workspace" : "global";
      const workspaceId = scope === "workspace" ? (body.workspaceId ?? null) : null;
      if (scope === "workspace" && !workspaceId) {
        throw new ApiError(400, "validation_failed", "workspaceId is required for workspace scope");
      }
      const version = Number(body.version ?? skill.latestVersion);
      if (!Number.isInteger(version) || version < 1 || version > skill.latestVersion) {
        throw new ApiError(400, "validation_failed", `unknown version: ${body.version}`);
      }

      // Delete-then-insert rather than ON CONFLICT, for the same reason the
      // Supabase implementation does it: the unique index coalesces
      // `workspace_id`, and an expression index cannot be named as a conflict
      // target here. Drizzle 0.36 does not render an `sql` fragment in
      // `target` — it emitted the literal identifier `"undefined"`, so the
      // statement was `on conflict ("actor_id","skill_id","scope","undefined")`
      // and every install died on `42703 column "undefined" does not exist`.
      // Nothing caught it because no test had ever executed this method; the
      // route tests stub the repo, and the daemon logs the failure at warn and
      // retries forever.
      await db
        .delete(teamSkillInstalls)
        .where(
          and(
            eq(teamSkillInstalls.actorId, targetActorId),
            eq(teamSkillInstalls.skillId, skill.id),
            eq(teamSkillInstalls.scope, scope),
          ),
        );
      const [row] = await (db.insert(teamSkillInstalls) as any)
        .values({
          teamId,
          actorId: targetActorId,
          skillId: skill.id,
          installedVersion: version,
          scope,
          workspaceId,
        })
        .returning();
      return mapInstall(row);
    },

    async uninstallTeamSkill(teamId: string, slug: string, body: any = {}) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);
      const targetActorId = body.actorId ?? callerActorId;
      await assertCanInstallFor(userId, teamId, targetActorId);

      const skill = await loadSkill(teamId, slug);
      await db
        .delete(teamSkillInstalls)
        .where(
          and(
            eq(teamSkillInstalls.actorId, targetActorId),
            eq(teamSkillInstalls.skillId, skill.id),
          ),
        );
    },

    /**
     * Ensure an amuxc_blobs placeholder exists for a skill package. The route
     * layer then asks Supabase Storage for a signed PUT when the blob isn't
     * verified yet. Keeps skill packages on the same content-addressed store
     * as sync without creating an amuxc_files path entry.
     */
    async prepareTeamSkillBlob(teamId: string, body: any = {}) {
      const userId = requireUser();
      await requireActorForTeam(db, userId, teamId);
      const contentHash = String(body.contentHash ?? "").trim();
      if (!/^[a-f0-9]{64}$/i.test(contentHash)) {
        throw new ApiError(400, "validation_failed", "contentHash must be a sha256 hex digest");
      }
      const size = Number(body.size ?? NaN);
      if (!Number.isFinite(size) || size < 0) {
        throw new ApiError(400, "validation_failed", "size must be a non-negative number");
      }
      const hash = contentHash.toLowerCase();
      const ossKey = `teams/${teamId}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
      await (db.insert(amuxcBlobs) as any)
        .values({ teamId, contentHash: hash, ossKey, size, verified: false })
        .onConflictDoNothing();
      const [row] = await db
        .select({ ossKey: amuxcBlobs.ossKey, size: amuxcBlobs.size, verified: amuxcBlobs.verified })
        .from(amuxcBlobs)
        .where(and(eq(amuxcBlobs.teamId, teamId), eq(amuxcBlobs.contentHash, hash)))
        .limit(1);
      return { contentHash: hash, size: row.size ?? size, ossKey: row.ossKey, verified: row.verified };
    },

    /** Mark a skill package blob verified after the client PUTs to OSS. */
    async completeTeamSkillBlob(teamId: string, body: any = {}) {
      const userId = requireUser();
      await requireActorForTeam(db, userId, teamId);
      const contentHash = String(body.contentHash ?? "").trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(contentHash)) {
        throw new ApiError(400, "validation_failed", "contentHash must be a sha256 hex digest");
      }
      const [row] = await db
        .select({
          ossKey: amuxcBlobs.ossKey,
          size: amuxcBlobs.size,
        })
        .from(amuxcBlobs)
        .where(and(eq(amuxcBlobs.teamId, teamId), eq(amuxcBlobs.contentHash, contentHash)))
        .limit(1);
      if (!row) {
        throw new ApiError(404, "not_found", "blob placeholder not found — call prepare first");
      }
      await (db.update(amuxcBlobs) as any)
        .set({ verified: true })
        .where(and(eq(amuxcBlobs.teamId, teamId), eq(amuxcBlobs.contentHash, contentHash)));
      return { contentHash, size: row.size ?? 0, ossKey: row.ossKey };
    },

    /**
     * The full "what should this actor have installed" list. The daemon that
     * hosts a team agent reconciles against this — full set, not a delta,
     * because notifications get dropped and daemons go offline, and a
     * delta-only consumer drifts the moment it misses one.
     */
    async listTeamSkillInstalls(teamId: string, opts: any = {}) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);
      const subjectActorId = opts.actorId ?? callerActorId;

      const rows = await db
        .select({
          install: teamSkillInstalls,
          slug: teamSkills.slug,
          latestVersion: teamSkills.latestVersion,
          status: teamSkills.status,
        })
        .from(teamSkillInstalls)
        .innerJoin(teamSkills, eq(teamSkills.id, teamSkillInstalls.skillId))
        .where(
          and(
            eq(teamSkillInstalls.teamId, teamId),
            eq(teamSkillInstalls.actorId, subjectActorId),
          ),
        )
        .orderBy(teamSkills.slug);

      return rows.map((r: any) => ({
        ...mapInstall(r.install),
        slug: r.slug,
        latestVersion: r.latestVersion,
        status: r.status,
        hasUpdate: r.install.installedVersion < r.latestVersion,
      }));
    },
  };
}
