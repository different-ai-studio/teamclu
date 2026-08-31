/**
 * First-party skills marketplace — pg-repo.
 *
 * Design: docs/architecture/skills-marketplace.md
 *
 * Admin methods do not require a user JWT: callers authenticate with
 * MARKETPLACE_ADMIN_SECRET (see routes/marketplace.ts). Read/adopt methods
 * require a team member as usual.
 */

import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  marketplaceSkills,
  marketplaceSkillVersions,
  teamSkills,
  teamSkillVersions,
} from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";
import { requireActorForTeam } from "./authz.js";
import { statSkillObject } from "../skills-storage.js";
import { marketplaceObjectPath } from "../validation/marketplace-paths.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

interface MarketplaceCtx {
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

const MARKET_STATUSES = ["draft", "published", "delisted"] as const;

function mapCatalogSkill(row: any, extra: Record<string, unknown> = {}) {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    publisher: row.publisher,
    summary: row.summary,
    category: row.category,
    whenToUse: row.whenToUse ?? "",
    whenNotToUse: row.whenNotToUse ?? "",
    requires: row.requires ?? null,
    tags: row.tags ?? [],
    status: row.status,
    latestVersion: row.latestVersion ?? 0,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    ...extra,
  };
}

function mapCatalogVersion(row: any) {
  return {
    version: row.version,
    contentHash: row.contentHash,
    size: row.size ?? 0,
    objectPath: row.objectPath,
    changelog: row.changelog,
    summary: row.summary,
    whenToUse: row.whenToUse ?? "",
    whenNotToUse: row.whenNotToUse ?? "",
    requires: row.requires ?? null,
    publishedAt: iso(row.publishedAt),
    createdBy: row.createdBy ?? null,
    createdAt: iso(row.createdAt),
  };
}

function requireCatalogFields(body: any) {
  const need = (key: string, label: string) => {
    const v = body[key];
    if (typeof v !== "string" || !v.trim()) {
      throw new ApiError(400, "validation_failed", `${label} is required`);
    }
    return v.trim();
  };
  const summary = need("summary", "summary");
  if (summary.length > 200) {
    throw new ApiError(400, "validation_failed", "summary must be 200 characters or fewer");
  }
  const category = need("category", "category");
  if (!CATEGORIES.includes(category as never)) {
    throw new ApiError(
      400,
      "validation_failed",
      `category must be one of: ${CATEGORIES.join(", ")}`,
    );
  }
  return {
    summary,
    category,
    whenToUse: typeof body.whenToUse === "string" ? body.whenToUse.trim() : "",
    whenNotToUse: typeof body.whenNotToUse === "string" ? body.whenNotToUse.trim() : "",
    requires: body.requires !== undefined ? body.requires ?? null : null,
  };
}

export function makeMarketplaceRepo(db: DbLike, ctx: MarketplaceCtx = {}) {
  const requireUser = () => {
    if (!ctx.userId) throw new ApiError(401, "unauthorized", "authentication required");
    return ctx.userId;
  };

  async function loadCatalog(slug: string) {
    const [row] = await db
      .select()
      .from(marketplaceSkills)
      .where(eq(marketplaceSkills.slug, slug))
      .limit(1);
    if (!row) throw new ApiError(404, "not_found", `marketplace skill not found: ${slug}`);
    return row;
  }

  async function loadCatalogVersion(skillId: string, version: number) {
    const [row] = await db
      .select()
      .from(marketplaceSkillVersions)
      .where(
        and(
          eq(marketplaceSkillVersions.skillId, skillId),
          eq(marketplaceSkillVersions.version, version),
        ),
      )
      .limit(1);
    if (!row) throw new ApiError(404, "not_found", `marketplace version ${version} not found`);
    return row;
  }

  return {
    /**
     * Browse published catalog. Optional `teamId` adds adoptedByTeam decoration.
     */
    async listMarketplaceSkills(opts: any = {}) {
      requireUser();
      const conditions = [eq(marketplaceSkills.status, "published")];
      if (opts.category) {
        if (!CATEGORIES.includes(opts.category)) {
          throw new ApiError(400, "validation_failed", `unknown category: ${opts.category}`);
        }
        conditions.push(eq(marketplaceSkills.category, opts.category));
      }
      if (opts.q && String(opts.q).trim()) {
        const q = `%${String(opts.q).trim()}%`;
        conditions.push(
          or(
            ilike(marketplaceSkills.slug, q),
            ilike(marketplaceSkills.displayName, q),
            ilike(marketplaceSkills.summary, q),
          )!,
        );
      }

      const rows = await db
        .select()
        .from(marketplaceSkills)
        .where(and(...conditions))
        .orderBy(marketplaceSkills.slug)
        .limit(Math.min(Number(opts.limit ?? 100) || 100, 200));

      let adopted = new Map<string, any>();
      if (opts.teamId) {
        const userId = requireUser();
        await requireActorForTeam(db, userId, opts.teamId);
        const adoptedRows = await db
          .select()
          .from(teamSkills)
          .where(
            and(
              eq(teamSkills.teamId, opts.teamId),
              eq(teamSkills.origin, "marketplace"),
            ),
          );
        for (const r of adoptedRows) {
          if (r.upstreamSlug) adopted.set(r.upstreamSlug, r);
        }
      }

      return rows.map((r: any) => {
        const a = adopted.get(r.slug);
        return mapCatalogSkill(r, {
          adoptedByTeam: a
            ? {
                slug: a.slug,
                latestVersion: a.latestVersion,
                upstreamSubscribed: a.upstreamSubscribed,
              }
            : null,
        });
      });
    },

    async getMarketplaceSkill(slug: string, opts: any = {}) {
      requireUser();
      const skill = await loadCatalog(slug);
      if (skill.status !== "published" && skill.status !== "delisted") {
        // Draft rows are admin-only; authenticated browse hides them.
        throw new ApiError(404, "not_found", `marketplace skill not found: ${slug}`);
      }
      const versions = await db
        .select()
        .from(marketplaceSkillVersions)
        .where(
          and(
            eq(marketplaceSkillVersions.skillId, skill.id),
            sql`${marketplaceSkillVersions.publishedAt} is not null`,
          ),
        )
        .orderBy(desc(marketplaceSkillVersions.version));

      let adoptCount = 0;
      const [countRow] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(teamSkills)
        .where(
          and(eq(teamSkills.origin, "marketplace"), eq(teamSkills.upstreamSlug, slug)),
        );
      adoptCount = countRow?.n ?? 0;

      let adoptedByTeam = null;
      if (opts.teamId) {
        await requireActorForTeam(db, requireUser(), opts.teamId);
        const [a] = await db
          .select()
          .from(teamSkills)
          .where(
            and(
              eq(teamSkills.teamId, opts.teamId),
              eq(teamSkills.origin, "marketplace"),
              eq(teamSkills.upstreamSlug, slug),
            ),
          )
          .limit(1);
        if (a) {
          adoptedByTeam = {
            slug: a.slug,
            latestVersion: a.latestVersion,
            upstreamSubscribed: a.upstreamSubscribed,
          };
        }
      }

      return {
        ...mapCatalogSkill(skill, { adoptCount, adoptedByTeam }),
        versions: versions.map(mapCatalogVersion),
      };
    },

    // ── Admin (shared secret) ──────────────────────────────────────────────

    async prepareMarketplaceSkillBlob(body: any = {}) {
      const contentHash = String(body.contentHash ?? "").trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(contentHash)) {
        throw new ApiError(400, "validation_failed", "contentHash must be a sha256 hex digest");
      }
      const size = Number(body.size ?? NaN);
      if (!Number.isFinite(size) || size < 0) {
        throw new ApiError(400, "validation_failed", "size must be a non-negative number");
      }
      const objectPath = marketplaceObjectPath(contentHash);
      const stat = await statSkillObject(objectPath);
      const verified = !!(stat && stat.size === size);
      return { contentHash, size, objectPath, verified, requiresUpload: !verified };
    },

    async completeMarketplaceSkillBlob(body: any = {}) {
      const contentHash = String(body.contentHash ?? "").trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(contentHash)) {
        throw new ApiError(400, "validation_failed", "contentHash must be a sha256 hex digest");
      }
      const size = Number(body.size ?? NaN);
      if (!Number.isFinite(size) || size < 0) {
        throw new ApiError(400, "validation_failed", "size must be a non-negative number");
      }
      const objectPath = marketplaceObjectPath(contentHash);
      const stat = await statSkillObject(objectPath);
      if (!stat || stat.size !== size) {
        throw new ApiError(
          422,
          "blob_missing",
          `Blob missing or size mismatch: expected ${size}, got ${stat?.size ?? "none"}`,
        );
      }
      return { contentHash, size, objectPath, verified: true };
    },

    async createMarketplaceSkill(body: any = {}) {
      const slug = String(body.slug ?? "").trim();
      if (!SLUG_RE.test(slug)) {
        throw new ApiError(
          400,
          "validation_failed",
          "slug must be 2-64 chars of [a-z0-9-] and start with a letter or digit",
        );
      }
      const displayName = String(body.displayName ?? body.display_name ?? "").trim();
      if (!displayName) throw new ApiError(400, "validation_failed", "displayName is required");
      const publisher = String(body.publisher ?? "").trim();
      if (!publisher) throw new ApiError(400, "validation_failed", "publisher is required");
      const fields = requireCatalogFields(body);
      const tags = Array.isArray(body.tags)
        ? body.tags.map((t: unknown) => String(t).trim()).filter(Boolean)
        : [];

      const [existing] = await db
        .select({ id: marketplaceSkills.id })
        .from(marketplaceSkills)
        .where(eq(marketplaceSkills.slug, slug))
        .limit(1);
      if (existing) {
        throw new ApiError(409, "conflict", `marketplace skill ${slug} already exists`);
      }

      const [row] = await (db.insert(marketplaceSkills) as any)
        .values({
          slug,
          displayName,
          publisher,
          summary: fields.summary,
          category: fields.category,
          whenToUse: fields.whenToUse,
          whenNotToUse: fields.whenNotToUse,
          requires: fields.requires,
          tags,
          status: "draft",
          latestVersion: 0,
        })
        .returning();
      return mapCatalogSkill(row);
    },

    async createMarketplaceSkillVersion(slug: string, body: any = {}) {
      const skill = await loadCatalog(slug);
      const contentHash = String(body.contentHash ?? "").trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(contentHash)) {
        throw new ApiError(400, "validation_failed", "contentHash must be a sha256 hex digest");
      }
      const size = Number(body.size ?? NaN);
      if (!Number.isFinite(size) || size < 0) {
        throw new ApiError(400, "validation_failed", "size must be a non-negative number");
      }
      const changelog = String(body.changelog ?? "").trim();
      if (!changelog) throw new ApiError(400, "validation_failed", "changelog is required");

      const patch = requireCatalogFields({
        summary: body.summary ?? skill.summary,
        category: body.category ?? skill.category,
        whenToUse: body.whenToUse ?? skill.whenToUse,
        whenNotToUse: body.whenNotToUse ?? skill.whenNotToUse,
        requires: body.requires !== undefined ? body.requires : skill.requires,
      });

      const objectPath = marketplaceObjectPath(contentHash);
      const stat = await statSkillObject(objectPath);
      if (!stat || stat.size !== size) {
        throw new ApiError(
          422,
          "blob_missing",
          "package blob must be uploaded and completed before creating a version",
        );
      }

      const nextVersion = (skill.latestVersion ?? 0) + 1;
      // nextVersion is "would-be" after promote; unpublished rows still need a
      // unique version number. Use max(existing)+1 so drafts don't collide.
      const [maxRow] = await db
        .select({ v: sql<number>`coalesce(max(${marketplaceSkillVersions.version}), 0)::int` })
        .from(marketplaceSkillVersions)
        .where(eq(marketplaceSkillVersions.skillId, skill.id));
      const version = Math.max(nextVersion, (maxRow?.v ?? 0) + 1);

      const [row] = await (db.insert(marketplaceSkillVersions) as any)
        .values({
          skillId: skill.id,
          version,
          contentHash,
          size,
          objectPath,
          changelog,
          summary: patch.summary,
          whenToUse: patch.whenToUse,
          whenNotToUse: patch.whenNotToUse,
          requires: patch.requires,
          publishedAt: null,
          createdBy: "marketplace-admin",
        })
        .returning();
      return mapCatalogVersion(row);
    },

    async promoteMarketplaceSkillVersion(slug: string, version: number) {
      const skill = await loadCatalog(slug);
      const row = await loadCatalogVersion(skill.id, version);
      // Idempotent promote of the already-live version.
      if (row.publishedAt && skill.latestVersion === version) return mapCatalogVersion(row);

      // Promoting backwards looks like a rollback and is not one. Teams that
      // already aligned carry `upstream_version` above the new latest, so
      // `alignTeamSkillToMarketplace` short-circuits and they keep running the
      // bad version — while the operator believes it was pulled. It would also
      // rewrite the older version's `published_at`, destroying the record of
      // when it actually shipped. Rolling back is `revert`, which moves
      // forward carrying old content (§5.2).
      if (version < (skill.latestVersion ?? 0)) {
        throw new ApiError(
          409,
          "conflict",
          `v${version} is older than the current latest v${skill.latestVersion} — use revert to roll back`,
        );
      }

      const [updated] = await (db.update(marketplaceSkillVersions) as any)
        // Never re-stamp: `published_at` records when this version first went
        // live, and a re-promote of the current latest already returned above.
        .set(row.publishedAt ? {} : { publishedAt: new Date() })
        .where(eq(marketplaceSkillVersions.id, row.id))
        .returning();

      await (db.update(marketplaceSkills) as any)
        .set({
          latestVersion: version,
          status: skill.status === "draft" ? "published" : skill.status,
          summary: row.summary,
          whenToUse: row.whenToUse,
          whenNotToUse: row.whenNotToUse,
          requires: row.requires,
          updatedAt: new Date(),
        })
        .where(eq(marketplaceSkills.id, skill.id));

      return mapCatalogVersion(updated);
    },

    async revertMarketplaceSkillVersion(slug: string, version: number) {
      const skill = await loadCatalog(slug);
      const source = await loadCatalogVersion(skill.id, version);
      // `contentHash` is NOT NULL and regex-validated on insert, so the old
      // `!publishedAt && !contentHash` could never fire — reverting to a
      // never-promoted draft silently published it. Publishing is `promote`;
      // revert only ever restores something that already shipped.
      if (!source.publishedAt) {
        throw new ApiError(
          409,
          "conflict",
          `v${version} was never promoted — there is nothing to revert to`,
        );
      }

      const [maxRow] = await db
        .select({ v: sql<number>`coalesce(max(${marketplaceSkillVersions.version}), 0)::int` })
        .from(marketplaceSkillVersions)
        .where(eq(marketplaceSkillVersions.skillId, skill.id));
      const next = (maxRow?.v ?? 0) + 1;

      const [created] = await (db.insert(marketplaceSkillVersions) as any)
        .values({
          skillId: skill.id,
          version: next,
          contentHash: source.contentHash,
          size: source.size,
          objectPath: source.objectPath,
          changelog: `撤回至 v${version}`,
          summary: source.summary,
          whenToUse: source.whenToUse,
          whenNotToUse: source.whenNotToUse,
          requires: source.requires,
          publishedAt: new Date(),
          createdBy: "marketplace-admin",
        })
        .returning();

      // Status is deliberately untouched. Forcing `published` here un-delisted
      // a skill without re-subscribing the teams that delisting detached
      // (§7.3) — and there is no re-subscribe endpoint, so those teams were
      // frozen at their last version with the catalog claiming to be live.
      // Un-delisting is an explicit PATCH, and it does not resurrect
      // subscriptions either: a detached team re-adopts.
      await (db.update(marketplaceSkills) as any)
        .set({
          latestVersion: next,
          summary: source.summary,
          whenToUse: source.whenToUse,
          whenNotToUse: source.whenNotToUse,
          requires: source.requires,
          updatedAt: new Date(),
        })
        .where(eq(marketplaceSkills.id, skill.id));

      return mapCatalogVersion(created);
    },

    async updateMarketplaceSkill(slug: string, body: any = {}) {
      const skill = await loadCatalog(slug);
      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (body.displayName !== undefined || body.display_name !== undefined) {
        const displayName = String(body.displayName ?? body.display_name ?? "").trim();
        if (!displayName) throw new ApiError(400, "validation_failed", "displayName must be non-empty");
        update.displayName = displayName;
      }
      if (body.publisher !== undefined) {
        const publisher = String(body.publisher).trim();
        if (!publisher) throw new ApiError(400, "validation_failed", "publisher must be non-empty");
        update.publisher = publisher;
      }
      if (body.summary !== undefined || body.category !== undefined || body.whenToUse !== undefined || body.whenNotToUse !== undefined || body.requires !== undefined) {
        const fields = requireCatalogFields({
          summary: body.summary ?? skill.summary,
          category: body.category ?? skill.category,
          whenToUse: body.whenToUse ?? skill.whenToUse,
          whenNotToUse: body.whenNotToUse ?? skill.whenNotToUse,
          requires: body.requires !== undefined ? body.requires : skill.requires,
        });
        Object.assign(update, fields);
      }
      if (body.tags !== undefined) {
        update.tags = Array.isArray(body.tags)
          ? body.tags.map((t: unknown) => String(t).trim()).filter(Boolean)
          : [];
      }
      if (body.status !== undefined) {
        if (!MARKET_STATUSES.includes(body.status)) {
          throw new ApiError(400, "validation_failed", `unknown status: ${body.status}`);
        }
        update.status = body.status;
        if (body.status === "delisted") {
          // Detach all subscribed teams (§7.3).
          await (db.update(teamSkills) as any)
            .set({
              upstreamSubscribed: false,
              upstreamDetachedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(teamSkills.origin, "marketplace"),
                eq(teamSkills.upstreamSlug, slug),
                eq(teamSkills.upstreamSubscribed, true),
              ),
            );
        }
      }

      const [row] = await (db.update(marketplaceSkills) as any)
        .set(update)
        .where(eq(marketplaceSkills.id, skill.id))
        .returning();
      return mapCatalogSkill(row);
    },

    /**
     * Optional acceleration: align every subscribed team to marketplace latest.
     * Correctness still comes from lazy align on listTeamSkills.
     */
    async alignAllMarketplaceSubscriptions() {
      const subscribed = await db
        .select()
        .from(teamSkills)
        .where(
          and(eq(teamSkills.origin, "marketplace"), eq(teamSkills.upstreamSubscribed, true)),
        );
      let aligned = 0;
      for (const row of subscribed) {
        if (!row.upstreamSlug) continue;
        const n = await alignTeamSkillToMarketplace(db, row);
        aligned += n;
      }
      return { aligned };
    },
  };
}

/**
 * Project marketplace latest into a subscribed team_skills row when behind.
 * Returns 1 if a version was inserted, 0 otherwise.
 */
export async function alignTeamSkillToMarketplace(db: DbLike, skill: any): Promise<number> {
  if (!skill.upstreamSubscribed || skill.origin !== "marketplace" || !skill.upstreamSlug) {
    return 0;
  }
  const [m] = await db
    .select()
    .from(marketplaceSkills)
    .where(eq(marketplaceSkills.slug, skill.upstreamSlug))
    .limit(1);
  if (!m) return 0;
  if (m.status === "delisted") {
    await (db.update(teamSkills) as any)
      .set({
        upstreamSubscribed: false,
        upstreamDetachedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(teamSkills.id, skill.id));
    return 0;
  }
  if (m.status !== "published" || !m.latestVersion) return 0;

  const [latestTeamVer] = await db
    .select()
    .from(teamSkillVersions)
    .where(eq(teamSkillVersions.skillId, skill.id))
    .orderBy(desc(teamSkillVersions.version))
    .limit(1);
  const currentUpstream = latestTeamVer?.upstreamVersion ?? 0;
  if (currentUpstream >= m.latestVersion) return 0;

  const [mVer] = await db
    .select()
    .from(marketplaceSkillVersions)
    .where(
      and(
        eq(marketplaceSkillVersions.skillId, m.id),
        eq(marketplaceSkillVersions.version, m.latestVersion),
      ),
    )
    .limit(1);
  if (!mVer || !mVer.publishedAt) return 0;

  // Merge changelogs for skipped upstream versions.
  const skipped = await db
    .select({ changelog: marketplaceSkillVersions.changelog, version: marketplaceSkillVersions.version })
    .from(marketplaceSkillVersions)
    .where(
      and(
        eq(marketplaceSkillVersions.skillId, m.id),
        sql`${marketplaceSkillVersions.version} > ${currentUpstream}`,
        sql`${marketplaceSkillVersions.version} <= ${m.latestVersion}`,
        sql`${marketplaceSkillVersions.publishedAt} is not null`,
      ),
    )
    .orderBy(marketplaceSkillVersions.version);
  const changelog =
    skipped.map((s: any) => `v${s.version}: ${s.changelog}`).join("\n") || mVer.changelog;

  const nextVersion = (skill.latestVersion ?? 0) + 1;
  let inserted: any;
  try {
    [inserted] = await (db.insert(teamSkillVersions) as any)
      .values({
        skillId: skill.id,
        version: nextVersion,
        contentHash: mVer.contentHash,
        size: mVer.size,
        changelog,
        summary: mVer.summary,
        whenToUse: mVer.whenToUse,
        whenNotToUse: mVer.whenNotToUse,
        requires: mVer.requires,
        upstreamVersion: m.latestVersion,
        blobScope: "marketplace",
        objectPath: mVer.objectPath,
        createdBy: skill.ownerActorId,
      })
      .onConflictDoNothing()
      .returning();
  } catch (err) {
    // Align is a side effect on a read path, so a failure here must not fail
    // the caller's list — but it must not be invisible either. The old bare
    // `catch { return 0 }` reported a connection or constraint failure as
    // "nothing to do", which is the same shape as success.
    console.error("[marketplace align] insert failed (swallowed):", err);
    return 0;
  }

  // Nothing was inserted: a concurrent align (a daemon poll racing a UI load)
  // already wrote this version. The loser must stop here. Falling through to
  // the update below would stamp team_skills with *this* call's snapshot on
  // top of whatever the winning row actually holds, and advance
  // `latest_version` to a version this call did not write.
  if (!inserted) return 0;

  await (db.update(teamSkills) as any)
    .set({
      latestVersion: sql`greatest(${teamSkills.latestVersion}, ${nextVersion})`,
      summary: mVer.summary,
      whenToUse: mVer.whenToUse,
      whenNotToUse: mVer.whenNotToUse,
      requires: mVer.requires,
      category: m.category,
      updatedAt: new Date(),
    })
    .where(eq(teamSkills.id, skill.id));

  return 1;
}
