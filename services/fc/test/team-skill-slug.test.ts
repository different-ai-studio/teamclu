import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupabaseBusinessRepository } from "../src/lib/supabase-repo.js";
import { ApiError } from "../src/lib/http-utils.js";
import {
  TEAM_SKILL_SLUG_INVALID_MESSAGE,
  TEAM_SKILL_SLUG_RESERVED_MESSAGE,
  assertTeamSkillSlug,
  teamSkillDisplayName,
} from "../src/lib/team-skill-slug.js";

const TEAM = "team-1";
const ACTOR = "actor-member-1";
const HASH = "a".repeat(64);

test("assertTeamSkillSlug accepts ASCII ids and rejects Chinese, empty, short, and reserved names", () => {
  assert.doesNotThrow(() => assertTeamSkillSlug("deploy-check"));
  assert.doesNotThrow(() => assertTeamSkillSlug("a1"));
  for (const slug of ["", "a", "-ab", "整车成本智能表格", "Has Space", "Deploy-Check"]) {
    assert.throws(
      () => assertTeamSkillSlug(slug),
      (err: unknown) =>
        err instanceof ApiError &&
        err.statusCode === 400 &&
        err.message === TEAM_SKILL_SLUG_INVALID_MESSAGE,
      slug,
    );
  }
  for (const slug of ["con", "prn", "aux", "nul", "com1", "lpt9"]) {
    assert.throws(
      () => assertTeamSkillSlug(slug),
      (err: unknown) =>
        err instanceof ApiError &&
        err.statusCode === 400 &&
        err.message === TEAM_SKILL_SLUG_RESERVED_MESSAGE,
      slug,
    );
  }
});

test("teamSkillDisplayName keeps Chinese and rejects control characters and overlong titles", () => {
  assert.equal(teamSkillDisplayName(undefined, "deploy-check"), "deploy-check");
  assert.equal(teamSkillDisplayName("  ", "deploy-check"), "deploy-check");
  assert.equal(teamSkillDisplayName("整车成本智能表格", "skill-id"), "整车成本智能表格");
  assert.throws(
    () => teamSkillDisplayName("整车\n成本", "skill-id"),
    (err: unknown) => err instanceof ApiError && err.statusCode === 400,
  );
  assert.throws(
    () => teamSkillDisplayName("名".repeat(121), "skill-id"),
    (err: unknown) => err instanceof ApiError && err.statusCode === 400,
  );
});

function repoForCreate(opts: { conflict?: boolean } = {}) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const supabase = {
    auth: {
      async getUser() {
        return { data: { user: { id: "user-1" } }, error: null };
      },
    },
    from(table: string) {
      const builder: Record<string, unknown> = {
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        limit() {
          return builder;
        },
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          if (opts.conflict && table === "team_skills") {
            (builder as { conflict?: boolean }).conflict = true;
          }
          return builder;
        },
        async maybeSingle() {
          if (table === "actors") return { data: { id: ACTOR, actor_type: "member" }, error: null };
          if (table === "amuxc_blobs") return { data: { verified: true, size: 12 }, error: null };
          return { data: null, error: null };
        },
        async single() {
          if ((builder as { conflict?: boolean }).conflict) {
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          }
          const row = inserts.at(-1)?.row ?? {};
          return {
            data: {
              id: "skill-1",
              team_id: TEAM,
              slug: row.slug,
              display_name: row.display_name,
              owner_actor_id: ACTOR,
              summary: row.summary,
              category: row.category,
              when_to_use: row.when_to_use ?? "",
              when_not_to_use: row.when_not_to_use ?? "",
              requires: null,
              status: "published",
              latest_version: 1,
              created_by: ACTOR,
              origin: "local",
              created_at: null,
              updated_at: null,
            },
            error: null,
          };
        },
        then(resolve: (value: unknown) => unknown, reject: (err: unknown) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  const repo = createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    createClient: () => supabase,
    createServiceRoleClient: () => supabase,
  });
  return { repo, inserts };
}

const publishBody = {
  summary: "整车运单读写",
  category: "general",
  changelog: "v1: shared from personal skill",
  contentHash: HASH,
};

test("createTeamSkill rejects a Chinese slug before writing a row", async () => {
  const { repo, inserts } = repoForCreate();
  await assert.rejects(
    () => repo.createTeamSkill(TEAM, { ...publishBody, slug: "整车成本智能表格" }),
    (err: unknown) =>
      err instanceof ApiError &&
      err.statusCode === 400 &&
      err.message === TEAM_SKILL_SLUG_INVALID_MESSAGE,
  );
  assert.equal(inserts.length, 0);
});

test("createTeamSkill rejects an empty slug", async () => {
  const { repo, inserts } = repoForCreate();
  await assert.rejects(
    () => repo.createTeamSkill(TEAM, { ...publishBody, slug: "   " }),
    (err: unknown) => err instanceof ApiError && err.statusCode === 400,
  );
  assert.equal(inserts.length, 0);
});

test("createTeamSkill stores a lowercased ASCII slug and the Chinese display name", async () => {
  const { repo, inserts } = repoForCreate();
  const row = await repo.createTeamSkill(TEAM, {
    ...publishBody,
    slug: "Deploy-Check",
    displayName: "整车成本智能表格",
  });
  assert.equal(row.slug, "deploy-check");
  assert.equal(row.displayName, "整车成本智能表格");
  const skill = inserts.find((entry) => entry.table === "team_skills");
  assert.equal(skill?.row.slug, "deploy-check");
  assert.equal(skill?.row.display_name, "整车成本智能表格");
});

test("createTeamSkill defaults the display name to the slug", async () => {
  const { repo } = repoForCreate();
  const row = await repo.createTeamSkill(TEAM, { ...publishBody, slug: "deploy-check" });
  assert.equal(row.displayName, "deploy-check");
});

test("createTeamSkill reports a duplicate slug as a conflict", async () => {
  const { repo, inserts } = repoForCreate({ conflict: true });
  await assert.rejects(
    () =>
      repo.createTeamSkill(TEAM, {
        ...publishBody,
        slug: "zheng-che-cheng-ben-zhi-neng-biao-ge",
        displayName: "整车成本智能表格",
      }),
    (err: unknown) =>
      err instanceof ApiError &&
      err.statusCode === 409 &&
      err.message.includes("zheng-che-cheng-ben-zhi-neng-biao-ge"),
  );
  assert.equal(inserts.some((entry) => entry.table === "team_skill_versions"), false);
});

test("createTeamSkill rejects a Windows reserved slug", async () => {
  const { repo, inserts } = repoForCreate();
  await assert.rejects(
    () => repo.createTeamSkill(TEAM, { ...publishBody, slug: "con" }),
    (err: unknown) =>
      err instanceof ApiError &&
      err.statusCode === 400 &&
      err.message === TEAM_SKILL_SLUG_RESERVED_MESSAGE,
  );
  assert.equal(inserts.length, 0);
});
