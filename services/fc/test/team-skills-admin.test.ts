import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupabaseBusinessRepository } from "../src/lib/supabase-repo.js";
import { ApiError } from "../src/lib/http-utils.js";

const TEAM = "team-1";
const ACTOR = "actor-member-1";
const SKILL_ROW = {
  id: "skill-1",
  team_id: TEAM,
  slug: "deploy-check",
  owner_actor_id: ACTOR,
  summary: "preflight",
  category: "devops",
  when_to_use: "before ship",
  when_not_to_use: "not local",
  requires: null,
  status: "published",
  superseded_by: null,
  latest_version: 3,
  created_by: ACTOR,
  origin: "local",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

function repoFor(role: "member" | "admin" | "owner" | null) {
  const deleted: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const updates: unknown[] = [];
  let lastUpdate: Record<string, unknown> | null = null;
  const supabase = {
    auth: {
      async getUser() {
        return { data: { user: { id: "user-1" } }, error: null };
      },
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: any = {
        select() { return builder; },
        eq(column: string, value: unknown) { filters[column] = value; return builder; },
        limit() { return builder; },
        async maybeSingle() {
          if (table === "actors") return { data: { id: ACTOR }, error: null };
          if (table === "team_members") {
            return { data: role ? { role } : null, error: null };
          }
          if (table === "team_skills") {
            if (lastUpdate) {
              return {
                data: { ...SKILL_ROW, ...lastUpdate, superseded_by: lastUpdate.superseded_by ?? null },
                error: null,
              };
            }
            return { data: { ...SKILL_ROW }, error: null };
          }
          return { data: null, error: null };
        },
        update(row: unknown) {
          updates.push(row);
          lastUpdate = row as Record<string, unknown>;
          return builder;
        },
        delete() {
          deleted.push({ table, filters });
          return builder;
        },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
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
  return { repo, deleted, updates };
}

test("member cannot delete a team skill", async () => {
  const { repo, deleted } = repoFor("member");
  await assert.rejects(
    () => repo.deleteTeamSkill(TEAM, "deploy-check"),
    (err: unknown) =>
      err instanceof ApiError &&
      err.statusCode === 403 &&
      err.code === "forbidden" &&
      err.message === "team owner or admin access required",
  );
  assert.equal(deleted.length, 0);
});

test("member cannot deprecate a team skill", async () => {
  const { repo, updates } = repoFor("member");
  await assert.rejects(
    () => repo.updateTeamSkill(TEAM, "deploy-check", { status: "deprecated" }),
    (err: unknown) => err instanceof ApiError && err.statusCode === 403,
  );
  assert.equal(updates.length, 0);
});

test("member can still patch summary", async () => {
  const { repo, updates } = repoFor("member");
  await repo.updateTeamSkill(TEAM, "deploy-check", { summary: "new summary" });
  assert.deepEqual(updates[0], { summary: "new summary" });
});

test("admin can delete a team skill", async () => {
  const { repo, deleted } = repoFor("admin");
  await repo.deleteTeamSkill(TEAM, "deploy-check");
  assert.equal(deleted[0]?.table, "team_skills");
});

test("owner can deprecate with supersededBy", async () => {
  const { repo, updates } = repoFor("owner");
  const row = await repo.updateTeamSkill(TEAM, "deploy-check", {
    status: "deprecated",
    supersededBy: "hotfix-deploy",
  });
  assert.equal(row.status, "deprecated");
  assert.deepEqual(updates[0], {
    status: "deprecated",
    superseded_by: "hotfix-deploy",
  });
});
