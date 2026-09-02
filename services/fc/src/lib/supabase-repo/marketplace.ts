/**
 * Marketplace methods for the Supabase business repository.
 * Design: docs/architecture/skills-marketplace.md
 *
 * Admin writes use the service-role client (bypasses RLS). Reads/adopt use the
 * caller's JWT client so team membership RLS still applies.
 */

import { ApiError } from "../http-utils.js";
import { marketplaceObjectPath } from "../validation/marketplace-paths.js";
import { statSkillObject, verifySkillPackageObject } from "../skills-storage.js";

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
];

const iso = (d: any) => (d ? new Date(d).toISOString() : null);

function mapCatalog(r: any, extra: Record<string, unknown> = {}) {
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    publisher: r.publisher,
    summary: r.summary,
    category: r.category,
    whenToUse: r.when_to_use ?? "",
    whenNotToUse: r.when_not_to_use ?? "",
    requires: r.requires ?? null,
    tags: r.tags ?? [],
    status: r.status,
    latestVersion: r.latest_version ?? 0,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    ...extra,
  };
}

function mapCatalogVersion(r: any) {
  return {
    version: r.version,
    contentHash: r.content_hash,
    size: r.size ?? 0,
    objectPath: r.object_path,
    changelog: r.changelog,
    summary: r.summary,
    whenToUse: r.when_to_use ?? "",
    whenNotToUse: r.when_not_to_use ?? "",
    requires: r.requires ?? null,
    publishedAt: iso(r.published_at),
    createdBy: r.created_by ?? null,
    createdAt: iso(r.created_at),
  };
}

/** Mirrors the market_status DB CHECK. */
const MARKET_STATUSES: readonly string[] = ["draft", "published", "delisted"];

function requireFields(body: any) {
  const summary = String(body.summary ?? "").trim();
  if (!summary) throw new ApiError(400, "validation_failed", "summary is required");
  if (summary.length > 200) {
    throw new ApiError(400, "validation_failed", "summary must be 200 characters or fewer");
  }
  const category = String(body.category ?? "").trim();
  if (!CATEGORIES.includes(category)) {
    throw new ApiError(400, "validation_failed", `category must be one of: ${CATEGORIES.join(", ")}`);
  }
  return {
    summary,
    category,
    when_to_use: typeof body.whenToUse === "string" ? body.whenToUse.trim() : "",
    when_not_to_use: typeof body.whenNotToUse === "string" ? body.whenNotToUse.trim() : "",
    requires: body.requires !== undefined ? body.requires ?? null : null,
  };
}

export function makeSupabaseMarketplaceMethods({
  supabase,
  serviceRoleClient,
  resolveCallerActorForTeam,
  mapTeamSkillRow,
}: {
  supabase: any;
  serviceRoleClient: (what: string) => Promise<any>;
  resolveCallerActorForTeam: (teamId: string) => Promise<{ id: string } | null>;
  mapTeamSkillRow: (r: any, install?: any) => any;
}) {
  async function admin() {
    return serviceRoleClient("marketplace admin");
  }

  async function alignOne(adminClient: any, skill: any) {
    if (!skill.upstream_subscribed || skill.origin !== "marketplace" || !skill.upstream_slug) {
      return 0;
    }
    const { data: m } = await adminClient
      .from("marketplace_skills")
      .select("*")
      .eq("slug", skill.upstream_slug)
      .maybeSingle();
    if (!m) return 0;
    if (m.status === "delisted") {
      await adminClient
        .from("team_skills")
        .update({
          upstream_subscribed: false,
          upstream_detached_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", skill.id);
      return 0;
    }
    if (m.status !== "published" || !m.latest_version) return 0;

    const { data: latestRows } = await adminClient
      .from("team_skill_versions")
      .select("*")
      .eq("skill_id", skill.id)
      .order("version", { ascending: false })
      .limit(1);
    const latestTeamVer = latestRows?.[0];
    const currentUpstream = latestTeamVer?.upstream_version ?? 0;
    if (currentUpstream >= m.latest_version) return 0;

    const { data: mVer } = await adminClient
      .from("marketplace_skill_versions")
      .select("*")
      .eq("skill_id", m.id)
      .eq("version", m.latest_version)
      .maybeSingle();
    if (!mVer?.published_at) return 0;

    const { data: skipped } = await adminClient
      .from("marketplace_skill_versions")
      .select("version, changelog")
      .eq("skill_id", m.id)
      .gt("version", currentUpstream)
      .lte("version", m.latest_version)
      .not("published_at", "is", null)
      .order("version", { ascending: true });
    const changelog =
      (skipped ?? []).map((s: any) => `v${s.version}: ${s.changelog}`).join("\n") || mVer.changelog;

    const nextVersion = (skill.latest_version ?? 0) + 1;
    const { error: iErr } = await adminClient.from("team_skill_versions").insert({
      skill_id: skill.id,
      version: nextVersion,
      content_hash: mVer.content_hash,
      size: mVer.size,
      changelog,
      summary: mVer.summary,
      when_to_use: mVer.when_to_use,
      when_not_to_use: mVer.when_not_to_use,
      requires: mVer.requires,
      upstream_version: m.latest_version,
      blob_scope: "marketplace",
      object_path: mVer.object_path,
      created_by: skill.owner_actor_id,
    });
    if (iErr && iErr.code !== "23505") throw iErr;
    // 23505 means a concurrent align (a daemon poll racing a UI load) already
    // wrote this version. The loser must stop here: falling through would
    // stamp team_skills with *this* call's snapshot over whatever the winning
    // row holds, and advance latest_version to a version it did not write.
    if (iErr) return 0;

    await adminClient
      .from("team_skills")
      .update({
        latest_version: Math.max(skill.latest_version ?? 0, nextVersion),
        summary: mVer.summary,
        when_to_use: mVer.when_to_use,
        when_not_to_use: mVer.when_not_to_use,
        requires: mVer.requires,
        category: m.category,
        updated_at: new Date().toISOString(),
      })
      .eq("id", skill.id);
    return 1;
  }

  return {
    async listMarketplaceSkills(opts: any = {}) {
      let query = supabase.from("marketplace_skills").select("*").eq("status", "published");
      if (opts.category) query = query.eq("category", opts.category);
      if (opts.q) {
        const q = `%${String(opts.q).trim()}%`;
        query = query.or(`slug.ilike.${q},display_name.ilike.${q},summary.ilike.${q}`);
      }
      const { data, error } = await query
        .order("slug")
        .limit(Math.min(Number(opts.limit ?? 100) || 100, 200));
      if (error) throw error;
      const rows = data ?? [];

      let adopted = new Map<string, any>();
      if (opts.teamId) {
        const actor = await resolveCallerActorForTeam(opts.teamId);
        if (!actor) throw new ApiError(403, "forbidden", "not a member of this team");
        const { data: aRows, error: aErr } = await supabase
          .from("team_skills")
          .select("*")
          .eq("team_id", opts.teamId)
          .eq("origin", "marketplace");
        if (aErr) throw aErr;
        for (const r of aRows ?? []) {
          if (r.upstream_slug) adopted.set(r.upstream_slug, r);
        }
      }

      return rows.map((r: any) => {
        const a = adopted.get(r.slug);
        return mapCatalog(r, {
          adoptedByTeam: a
            ? {
                slug: a.slug,
                latestVersion: a.latest_version,
                upstreamSubscribed: a.upstream_subscribed,
              }
            : null,
        });
      });
    },

    async getMarketplaceSkill(slug: string, opts: any = {}) {
      // Read the catalog row with the service-role client, not the caller's.
      // The RLS policy on marketplace_skills only exposes status='published',
      // so the delisted branch two lines down was unreachable on this backend:
      // a team following a delisted skill got 404 instead of the "已下架"
      // notice the UI is written to render. Visibility is enforced right here
      // instead — draft stays hidden, delisted resolves.
      const a = await admin();
      const { data, error } = await a
        .from("marketplace_skills")
        .select("*")
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw error;
      if (!data || (data.status !== "published" && data.status !== "delisted")) {
        throw new ApiError(404, "not_found", `marketplace skill not found: ${slug}`);
      }
      const { data: versions, error: vErr } = await a
        .from("marketplace_skill_versions")
        .select("*")
        .eq("skill_id", data.id)
        // Never-promoted drafts stay invisible regardless of client.
        .not("published_at", "is", null)
        .order("version", { ascending: false });
      if (vErr) throw vErr;

      // Also service-role: team_skills RLS limits SELECT to the caller's own
      // teams, so counting with the caller's client answered 0 or 1 for a
      // skill adopted by forty teams — and disagreed with the pg backend on
      // the same field. Only the aggregate crosses the boundary; no team is
      // named.
      const { count } = await a
        .from("team_skills")
        .select("id", { count: "exact", head: true })
        .eq("origin", "marketplace")
        .eq("upstream_slug", slug);

      let adoptedByTeam = null;
      if (opts.teamId) {
        const actor = await resolveCallerActorForTeam(opts.teamId);
        if (!actor) throw new ApiError(403, "forbidden", "not a member of this team");
        const { data: a } = await supabase
          .from("team_skills")
          .select("*")
          .eq("team_id", opts.teamId)
          .eq("origin", "marketplace")
          .eq("upstream_slug", slug)
          .maybeSingle();
        if (a) {
          adoptedByTeam = {
            slug: a.slug,
            latestVersion: a.latest_version,
            upstreamSubscribed: a.upstream_subscribed,
          };
        }
      }

      return {
        ...mapCatalog(data, { adoptCount: count ?? 0, adoptedByTeam }),
        versions: (versions ?? []).map(mapCatalogVersion),
      };
    },

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
      await verifySkillPackageObject(objectPath, { contentHash, size });
      return { contentHash, size, objectPath, verified: true };
    },

    async createMarketplaceSkill(body: any = {}) {
      const a = await admin();
      const slug = String(body.slug ?? "").trim();
      if (!SLUG_RE.test(slug)) {
        throw new ApiError(400, "validation_failed", "slug must be 2-64 chars of [a-z0-9-]");
      }
      const displayName = String(body.displayName ?? "").trim();
      const publisher = String(body.publisher ?? "").trim();
      if (!displayName || !publisher) {
        throw new ApiError(400, "validation_failed", "displayName and publisher are required");
      }
      const fields = requireFields(body);
      const tags = Array.isArray(body.tags)
        ? body.tags.map((t: unknown) => String(t).trim()).filter(Boolean)
        : [];
      const { data, error } = await a
        .from("marketplace_skills")
        .insert({
          slug,
          display_name: displayName,
          publisher,
          ...fields,
          tags,
          status: "draft",
          latest_version: 0,
        })
        .select("*")
        .single();
      if (error) {
        if (error.code === "23505") {
          throw new ApiError(409, "conflict", `marketplace skill ${slug} already exists`);
        }
        throw error;
      }
      return mapCatalog(data);
    },

    async createMarketplaceSkillVersion(slug: string, body: any = {}) {
      const a = await admin();
      const { data: skill, error } = await a
        .from("marketplace_skills")
        .select("*")
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw error;
      if (!skill) throw new ApiError(404, "not_found", `marketplace skill not found: ${slug}`);

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
      const fields = requireFields({
        summary: body.summary ?? skill.summary,
        category: body.category ?? skill.category,
        whenToUse: body.whenToUse ?? skill.when_to_use,
        whenNotToUse: body.whenNotToUse ?? skill.when_not_to_use,
        requires: body.requires !== undefined ? body.requires : skill.requires,
      });
      const objectPath = marketplaceObjectPath(contentHash);
      const stat = await statSkillObject(objectPath);
      if (!stat || stat.size !== size) {
        throw new ApiError(422, "blob_missing", "package blob must be uploaded first");
      }

      const { data: maxRows } = await a
        .from("marketplace_skill_versions")
        .select("version")
        .eq("skill_id", skill.id)
        .order("version", { ascending: false })
        .limit(1);
      const version = Math.max((skill.latest_version ?? 0) + 1, (maxRows?.[0]?.version ?? 0) + 1);

      const { data, error: iErr } = await a
        .from("marketplace_skill_versions")
        .insert({
          skill_id: skill.id,
          version,
          content_hash: contentHash,
          size,
          object_path: objectPath,
          changelog,
          summary: fields.summary,
          when_to_use: fields.when_to_use,
          when_not_to_use: fields.when_not_to_use,
          requires: fields.requires,
          published_at: null,
          created_by: "marketplace-admin",
        })
        .select("*")
        .single();
      if (iErr) throw iErr;
      return mapCatalogVersion(data);
    },

    async promoteMarketplaceSkillVersion(slug: string, version: number) {
      const a = await admin();
      const { data: skill } = await a.from("marketplace_skills").select("*").eq("slug", slug).maybeSingle();
      if (!skill) throw new ApiError(404, "not_found", `marketplace skill not found: ${slug}`);
      const { data: row } = await a
        .from("marketplace_skill_versions")
        .select("*")
        .eq("skill_id", skill.id)
        .eq("version", version)
        .maybeSingle();
      if (!row) throw new ApiError(404, "not_found", `version ${version} not found`);
      // Idempotent promote of the already-live version.
      if (row.published_at && skill.latest_version === version) return mapCatalogVersion(row);

      // Promoting backwards looks like a rollback and is not one: teams that
      // already aligned carry upstream_version above the new latest, so align
      // short-circuits and they keep running the bad version while the
      // operator believes it was pulled. Rolling back is `revert` (§5.2).
      if (version < (skill.latest_version ?? 0)) {
        throw new ApiError(
          409,
          "conflict",
          `v${version} is older than the current latest v${skill.latest_version} — use revert to roll back`,
        );
      }

      const { data: updated, error } = await a
        .from("marketplace_skill_versions")
        // published_at records when this version first shipped; a re-promote of
        // the current latest already returned above, so never re-stamp it.
        .update(row.published_at ? {} : { published_at: new Date().toISOString() })
        .eq("id", row.id)
        .select("*")
        .single();
      if (error) throw error;

      await a
        .from("marketplace_skills")
        .update({
          latest_version: version,
          status: skill.status === "draft" ? "published" : skill.status,
          summary: row.summary,
          when_to_use: row.when_to_use,
          when_not_to_use: row.when_not_to_use,
          requires: row.requires,
          updated_at: new Date().toISOString(),
        })
        .eq("id", skill.id);

      return mapCatalogVersion(updated);
    },

    async revertMarketplaceSkillVersion(slug: string, version: number) {
      const a = await admin();
      const { data: skill } = await a.from("marketplace_skills").select("*").eq("slug", slug).maybeSingle();
      if (!skill) throw new ApiError(404, "not_found", `marketplace skill not found: ${slug}`);
      const { data: source } = await a
        .from("marketplace_skill_versions")
        .select("*")
        .eq("skill_id", skill.id)
        .eq("version", version)
        .maybeSingle();
      if (!source) throw new ApiError(404, "not_found", `version ${version} not found`);
      // Publishing is `promote`; revert only restores something that shipped.
      // Without this, reverting to a never-promoted draft published it.
      if (!source.published_at) {
        throw new ApiError(
          409,
          "conflict",
          `v${version} was never promoted — there is nothing to revert to`,
        );
      }

      const { data: maxRows } = await a
        .from("marketplace_skill_versions")
        .select("version")
        .eq("skill_id", skill.id)
        .order("version", { ascending: false })
        .limit(1);
      const next = (maxRows?.[0]?.version ?? 0) + 1;

      const { data: created, error } = await a
        .from("marketplace_skill_versions")
        .insert({
          skill_id: skill.id,
          version: next,
          content_hash: source.content_hash,
          size: source.size,
          object_path: source.object_path,
          changelog: `撤回至 v${version}`,
          summary: source.summary,
          when_to_use: source.when_to_use,
          when_not_to_use: source.when_not_to_use,
          requires: source.requires,
          published_at: new Date().toISOString(),
          created_by: "marketplace-admin",
        })
        .select("*")
        .single();
      if (error) throw error;

      await a
        .from("marketplace_skills")
        // Status untouched: forcing `published` un-delisted a skill without
        // re-subscribing the teams delisting detached (§7.3), and there is no
        // re-subscribe endpoint — they were frozen while the catalog claimed
        // to be live. Un-delisting is an explicit PATCH; detached teams
        // re-adopt.
        .update({
          latest_version: next,
          summary: source.summary,
          when_to_use: source.when_to_use,
          when_not_to_use: source.when_not_to_use,
          requires: source.requires,
          updated_at: new Date().toISOString(),
        })
        .eq("id", skill.id);

      return mapCatalogVersion(created);
    },

    async updateMarketplaceSkill(slug: string, body: any = {}) {
      const a = await admin();
      const { data: skill } = await a.from("marketplace_skills").select("*").eq("slug", slug).maybeSingle();
      if (!skill) throw new ApiError(404, "not_found", `marketplace skill not found: ${slug}`);

      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (body.displayName !== undefined) update.display_name = String(body.displayName).trim();
      if (body.publisher !== undefined) update.publisher = String(body.publisher).trim();
      if (
        body.summary !== undefined ||
        body.category !== undefined ||
        body.whenToUse !== undefined ||
        body.whenNotToUse !== undefined ||
        body.requires !== undefined
      ) {
        Object.assign(
          update,
          requireFields({
            summary: body.summary ?? skill.summary,
            category: body.category ?? skill.category,
            whenToUse: body.whenToUse ?? skill.when_to_use,
            whenNotToUse: body.whenNotToUse ?? skill.when_not_to_use,
            requires: body.requires !== undefined ? body.requires : skill.requires,
          }),
        );
      }
      if (body.tags !== undefined) {
        update.tags = Array.isArray(body.tags)
          ? body.tags.map((t: unknown) => String(t).trim()).filter(Boolean)
          : [];
      }
      if (body.status !== undefined) {
        // Unvalidated, this reached the marketplace_skills_status_valid CHECK
        // and surfaced as an opaque 500 instead of a 400 naming the field.
        if (!MARKET_STATUSES.includes(body.status)) {
          throw new ApiError(400, "validation_failed", `unknown status: ${body.status}`);
        }
        update.status = body.status;
        if (body.status === "delisted") {
          await a
            .from("team_skills")
            .update({
              upstream_subscribed: false,
              upstream_detached_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("origin", "marketplace")
            .eq("upstream_slug", slug)
            .eq("upstream_subscribed", true);
        }
      }

      const { data, error } = await a
        .from("marketplace_skills")
        .update(update)
        .eq("id", skill.id)
        .select("*")
        .single();
      if (error) throw error;
      return mapCatalog(data);
    },

    async alignAllMarketplaceSubscriptions() {
      const a = await admin();
      const { data: rows, error } = await a
        .from("team_skills")
        .select("*")
        .eq("origin", "marketplace")
        .eq("upstream_subscribed", true);
      if (error) throw error;
      let aligned = 0;
      for (const row of rows ?? []) aligned += await alignOne(a, row);
      return { aligned };
    },

    async adoptMarketplaceSkill(teamId: string, body: any = {}) {
      const marketplaceSlug = String(body.marketplaceSlug ?? "").trim();
      if (!marketplaceSlug) {
        throw new ApiError(400, "validation_failed", "marketplaceSlug is required");
      }
      const caller = await resolveCallerActorForTeam(teamId);
      if (!caller) throw new ApiError(403, "forbidden", "not a member of this team");

      const { data: m, error } = await supabase
        .from("marketplace_skills")
        .select("*")
        .eq("slug", marketplaceSlug)
        .eq("status", "published")
        .maybeSingle();
      if (error) throw error;
      if (!m?.latest_version) {
        throw new ApiError(404, "not_found", `marketplace skill not found: ${marketplaceSlug}`);
      }

      const teamSlug = String(body.slug ?? marketplaceSlug).trim();
      if (!SLUG_RE.test(teamSlug)) {
        throw new ApiError(400, "validation_failed", "slug must be 2-64 chars of [a-z0-9-]");
      }

      const wantVersion = body.version != null ? Number(body.version) : m.latest_version;
      const { data: mVer } = await supabase
        .from("marketplace_skill_versions")
        .select("*")
        .eq("skill_id", m.id)
        .eq("version", wantVersion)
        .not("published_at", "is", null)
        .maybeSingle();
      if (!mVer) throw new ApiError(404, "not_found", `marketplace version ${wantVersion} not found`);

      const { data: siblings } = await supabase
        .from("team_skills")
        .select("slug, summary, when_to_use")
        .eq("team_id", teamId)
        .eq("status", "published");
      const needle = (m.when_to_use || m.summary || "").toLowerCase();
      const similar = (siblings ?? [])
        .filter((s: any) => {
          const hay = `${s.when_to_use || ""} ${s.summary || ""}`.toLowerCase();
          if (!needle || !hay) return false;
          const words = needle.split(/\s+/).filter((w: string) => w.length > 2);
          return words.filter((w: string) => hay.includes(w)).length >= 2;
        })
        .slice(0, 3)
        .map((s: any) => ({ slug: s.slug, summary: s.summary }));

      const { data: skill, error: sErr } = await supabase
        .from("team_skills")
        .insert({
          team_id: teamId,
          slug: teamSlug,
          owner_actor_id: caller.id,
          summary: m.summary,
          category: m.category,
          when_to_use: m.when_to_use,
          when_not_to_use: m.when_not_to_use,
          requires: m.requires,
          status: "published",
          latest_version: 1,
          created_by: caller.id,
          origin: "marketplace",
          upstream_slug: marketplaceSlug,
          upstream_subscribed: true,
        })
        .select("*")
        .single();
      if (sErr) {
        if (sErr.code === "23505") {
          throw new ApiError(409, "conflict", `a skill named ${teamSlug} already exists`);
        }
        throw sErr;
      }

      const { error: vErr } = await supabase.from("team_skill_versions").insert({
        skill_id: skill.id,
        version: 1,
        content_hash: mVer.content_hash,
        size: mVer.size,
        changelog: `引自市场 ${marketplaceSlug} v${wantVersion}`,
        summary: mVer.summary,
        when_to_use: mVer.when_to_use,
        when_not_to_use: mVer.when_not_to_use,
        requires: mVer.requires,
        created_by: caller.id,
        upstream_version: wantVersion,
        blob_scope: "marketplace",
        object_path: mVer.object_path,
      });
      if (vErr) {
        // No transactions over PostgREST, so the skill row committed a moment
        // ago has to be taken back by hand. Leaving it behind is worse than
        // this compensating delete: the skill reads as "v1" with no v1 to
        // download, and the slug is now taken so the user cannot even retry.
        // Scoped to the id we just created, so a concurrent adopt is untouched.
        const { error: cleanupErr } = await supabase
          .from("team_skills")
          .delete()
          .eq("id", skill.id);
        if (cleanupErr) {
          console.error(
            "[adoptMarketplaceSkill] orphan team_skills row left behind:",
            skill.id,
            cleanupErr,
          );
        }
        throw vErr;
      }

      return { ...mapTeamSkillRow(skill), similarSkills: similar };
    },

    async detachMarketplaceSkill(teamId: string, slug: string) {
      const caller = await resolveCallerActorForTeam(teamId);
      if (!caller) throw new ApiError(403, "forbidden", "not a member of this team");
      const { data: skill, error } = await supabase
        .from("team_skills")
        .select("*")
        .eq("team_id", teamId)
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw error;
      if (!skill) throw new ApiError(404, "not_found", `skill not found: ${slug}`);
      if (skill.origin !== "marketplace") {
        throw new ApiError(400, "validation_failed", "skill is not from the marketplace");
      }
      const { data, error: uErr } = await supabase
        .from("team_skills")
        .update({
          upstream_subscribed: false,
          upstream_detached_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", skill.id)
        .select("*")
        .single();
      if (uErr) throw uErr;
      return mapTeamSkillRow(data);
    },

    /** Exported for listTeamSkills lazy align on the supabase path. */
    async _alignMarketplaceSkillRow(skill: any) {
      const a = await admin();
      return alignOne(a, skill);
    },
  };
}
