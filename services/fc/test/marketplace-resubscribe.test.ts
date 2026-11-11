import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSupabaseMarketplaceMethods } from "../src/lib/supabase-repo/marketplace.js";
import { ApiError } from "../src/lib/http-utils.js";

// Repository coverage for resubscribing a detached marketplace skill.
// Design: docs/architecture/skills-marketplace.md §7.2

type Row = Record<string, any>;

function memoryClient(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const rows = (tables[table] ??= []);
      const preds: Array<(r: Row) => boolean> = [];
      let order: { column: string; ascending: boolean } | null = null;
      let limit = Infinity;
      let patch: Row | null = null;
      let insert: Row | null = null;
      const matching = () => {
        let out = rows.filter((r) => preds.every((p) => p(r)));
        if (order) {
          const { column, ascending } = order;
          out = [...out].sort((a, b) => (a[column] - b[column]) * (ascending ? 1 : -1));
        }
        return out.slice(0, limit);
      };
      const run = () => {
        if (insert) {
          const dup = rows.some(
            (r) => r.skill_id === insert!.skill_id && r.version === insert!.version,
          );
          if (dup) return { data: null, error: { code: "23505" } };
          rows.push(insert);
          return { data: [insert], error: null };
        }
        const hit = matching();
        if (patch) for (const r of hit) Object.assign(r, patch);
        return { data: hit, error: null };
      };
      const builder: any = {
        select() { return builder; },
        eq(column: string, value: unknown) { preds.push((r) => r[column] === value); return builder; },
        gt(column: string, value: number) { preds.push((r) => r[column] > value); return builder; },
        lte(column: string, value: number) { preds.push((r) => r[column] <= value); return builder; },
        not(column: string) { preds.push((r) => r[column] != null); return builder; },
        order(column: string, opts: { ascending: boolean }) { order = { column, ...opts }; return builder; },
        limit(n: number) { limit = n; return builder; },
        update(row: Row) { patch = row; return builder; },
        insert(row: Row) { insert = { ...row }; return builder; },
        async maybeSingle() {
          const { data, error } = run();
          return { data: data?.[0] ?? null, error };
        },
        async single() {
          const { data, error } = run();
          return { data: data?.[0] ?? null, error };
        },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          return Promise.resolve(run()).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

function fixture(overrides: { skill?: Row; catalogStatus?: string } = {}) {
  const tables: Record<string, Row[]> = {
    team_skills: [
      {
        id: "skill-1",
        team_id: "team-1",
        slug: "deploy-check",
        owner_actor_id: "actor-1",
        summary: "team edit",
        latest_version: 2,
        origin: "marketplace",
        upstream_slug: "deploy-check",
        upstream_subscribed: false,
        upstream_detached_at: "2026-11-01T00:00:00Z",
        ...overrides.skill,
      },
    ],
    team_skill_versions: [
      { skill_id: "skill-1", version: 1, upstream_version: 1, content_hash: "a1" },
      { skill_id: "skill-1", version: 2, upstream_version: null, content_hash: "local" },
    ],
    marketplace_skills: [
      {
        id: "m-1",
        slug: "deploy-check",
        status: overrides.catalogStatus ?? "published",
        latest_version: 3,
        category: "devops",
      },
    ],
    marketplace_skill_versions: [
      { skill_id: "m-1", version: 1, changelog: "first", published_at: "2026-10-01" },
      {
        skill_id: "m-1",
        version: 3,
        changelog: "third",
        published_at: "2026-11-05",
        content_hash: "m3",
        size: 10,
        summary: "catalog v3",
        object_path: "marketplace/blobs/sha256/m3",
      },
    ],
  };
  const client = memoryClient(tables);
  const repo = makeSupabaseMarketplaceMethods({
    supabase: client,
    serviceRoleClient: async () => client,
    resolveCallerActorForTeam: async (teamId) => (teamId === "team-1" ? { id: "actor-1" } : null),
    mapTeamSkillRow: (r: Row) => ({
      slug: r.slug,
      latestVersion: r.latest_version,
      summary: r.summary,
      upstreamSubscribed: !!r.upstream_subscribed,
      upstreamDetachedAt: r.upstream_detached_at ?? null,
    }),
  });
  return { repo, tables };
}

test("resubscribe lands the catalog's latest on top of the team's own version", async () => {
  const { repo, tables } = fixture();
  const out = await repo.resubscribeMarketplaceSkill("team-1", "deploy-check");

  assert.equal(out.upstreamSubscribed, true);
  assert.equal(out.upstreamDetachedAt, null);
  assert.equal(out.latestVersion, 3);
  assert.equal(out.summary, "catalog v3");
  const versions = tables.team_skill_versions.map((v) => [v.version, v.content_hash]);
  assert.deepEqual(versions, [[1, "a1"], [2, "local"], [3, "m3"]]);
  assert.equal(tables.team_skill_versions[2].upstream_version, 3);
});

test("resubscribe does not cut a version when the team already holds the catalog's latest", async () => {
  const { repo, tables } = fixture();
  tables.team_skill_versions[1].upstream_version = 3;
  const out = await repo.resubscribeMarketplaceSkill("team-1", "deploy-check");

  assert.equal(out.upstreamSubscribed, true);
  assert.equal(out.latestVersion, 2);
  assert.equal(tables.team_skill_versions.length, 2);
});

test("resubscribe refuses a delisted catalog entry and leaves the skill detached", async () => {
  const { repo, tables } = fixture({ catalogStatus: "delisted" });
  await assert.rejects(
    repo.resubscribeMarketplaceSkill("team-1", "deploy-check"),
    (e: unknown) => e instanceof ApiError && e.statusCode === 409,
  );
  assert.equal(tables.team_skills[0].upstream_subscribed, false);
});

test("resubscribe rejects a skill that did not come from the marketplace", async () => {
  const { repo } = fixture({ skill: { origin: "local", upstream_slug: null } });
  await assert.rejects(
    repo.resubscribeMarketplaceSkill("team-1", "deploy-check"),
    (e: unknown) => e instanceof ApiError && e.statusCode === 400,
  );
});

test("resubscribe requires team membership", async () => {
  const { repo } = fixture();
  await assert.rejects(
    repo.resubscribeMarketplaceSkill("team-2", "deploy-check"),
    (e: unknown) => e instanceof ApiError && e.statusCode === 403,
  );
});
