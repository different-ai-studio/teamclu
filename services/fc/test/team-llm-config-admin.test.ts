import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupabaseBusinessRepository } from "../src/lib/supabase-repo.js";
import { ApiError } from "../src/lib/http-utils.js";

// PUT /v1/teams/:id/llm-config sets the URL every agent in the team sends its
// prompts to, so only an owner or admin may change it.

const TEAM = "team-1";
const INPUT = { enabled: true, baseUrl: "https://gw.example/v1", models: [] };

function repoFor(role: "member" | "admin" | "owner" | null, { member = true } = {}) {
  const upserts: unknown[] = [];
  const supabase = {
    auth: {
      async getUser() {
        return { data: { user: { id: "user-1" } }, error: null };
      },
    },
    async rpc(fn: string, args: { target_team_id?: string }) {
      if (fn === "current_team_role" && args.target_team_id === TEAM) {
        return { data: role, error: null };
      }
      return { data: null, error: null };
    },
    from(table: string) {
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        limit() { return builder; },
        async maybeSingle() {
          if (table === "actors") return { data: member ? { id: "actor-1" } : null, error: null };
          return { data: null, error: null };
        },
        upsert(row: unknown) {
          upserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
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
  return { repo, upserts };
}

for (const role of ["owner", "admin"] as const) {
  test(`${role} can set the team llm config`, async () => {
    const { repo, upserts } = repoFor(role);
    const out = await repo.setLlmConfig(TEAM, INPUT);
    assert.deepEqual(out, INPUT);
    assert.equal(upserts.length, 1);
  });
}

test("a plain member cannot set the team llm config", async () => {
  const { repo, upserts } = repoFor("member");
  await assert.rejects(
    () => repo.setLlmConfig(TEAM, INPUT),
    (err: unknown) => err instanceof ApiError && err.statusCode === 403,
  );
  assert.equal(upserts.length, 0, "nothing is written");
});

test("a non-member cannot set the team llm config", async () => {
  const { repo, upserts } = repoFor(null, { member: false });
  await assert.rejects(
    () => repo.setLlmConfig(TEAM, INPUT),
    (err: unknown) => err instanceof ApiError && err.statusCode === 403,
  );
  assert.equal(upserts.length, 0);
});
