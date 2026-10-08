/**
 * PHONE_LOGIN_STAFF_ONLY reaches the switch / picker RPCs — and ONLY when on.
 *
 * Off, the calls must be byte-for-byte what they were: self-host keeps the
 * flag off, and a database that has not run
 * 20261008000000_staff_only_team_identities.sql has no function taking
 * `p_staff_only`, so sending it would turn every team switch into a 404.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupabaseAuthRepository, createSupabaseBusinessRepository } from "../src/lib/supabase-repo.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function switchCalls(phoneLoginStaffOnly: boolean) {
  const calls: Array<{ fn: string; args: any }> = [];
  const repo = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "anon-key",
    defaultOrgId: "org-default",
    phoneLoginStaffOnly,
    createClient: () => ({
      rpc: async (fn: string, args: any) => {
        calls.push({ fn, args });
        return { data: [{ actor_id: "a1", team_id: "t1", refresh_token: "rt" }], error: null };
      },
    }),
  });
  return { repo, calls };
}

test("switch_active_team gets only p_team_id while staff-only is off", async () => {
  const { repo, calls } = switchCalls(false);
  await repo.switchActiveTeam("t1", { accessToken: "at" });
  assert.deepEqual(calls, [{ fn: "switch_active_team", args: { p_team_id: "t1" } }]);
});

test("switch_active_team carries the shared tenant and the flag when staff-only is on", async () => {
  const { repo, calls } = switchCalls(true);
  await repo.switchActiveTeam("t1", { accessToken: "at" });
  assert.deepEqual(calls, [{
    fn: "switch_active_team",
    args: { p_team_id: "t1", p_default_org_id: "org-default", p_staff_only: true },
  }]);
});

function pickerCalls() {
  const calls: Array<{ fn: string; args: any }> = [];
  const repo = createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    createClient: () => ({
      rpc: async (fn: string, args: any) => {
        calls.push({ fn, args });
        return { data: [], error: null };
      },
    }),
  });
  return { repo, calls };
}

test("list_teams_for_picker gets its old arguments while staff-only is off", async () => {
  await withEnv({ PHONE_LOGIN_STAFF_ONLY: undefined, DEFAULT_ORG_ID: "org-default" }, async () => {
    const { repo, calls } = pickerCalls();
    await repo.listAllMyTeams();
    assert.deepEqual(calls, [{
      fn: "list_teams_for_picker",
      args: { p_default_org_id: "org-default", p_include_empty_orgs: false },
    }]);
  });
});

test("list_teams_for_picker carries the flag when staff-only is on", async () => {
  await withEnv({ PHONE_LOGIN_STAFF_ONLY: "true", DEFAULT_ORG_ID: "org-default" }, async () => {
    const { repo, calls } = pickerCalls();
    await repo.listAllMyTeams();
    assert.deepEqual(calls, [{
      fn: "list_teams_for_picker",
      args: { p_default_org_id: "org-default", p_include_empty_orgs: false, p_staff_only: true },
    }]);
  });
});
