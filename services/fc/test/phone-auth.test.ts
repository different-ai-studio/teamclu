import { test } from "node:test";
import assert from "node:assert/strict";
import { createPhoneAuthRepository } from "../src/lib/supabase-repo/phone-auth.js";

// ── Minimal in-memory fake of the Supabase query builder + auth admin ────────
// Supports exactly the chains phone-auth.ts uses.
function makeFakeSupabase(db: { auth_verify_code: any[]; users: any[]; actors?: any[] }, authStore: any) {
  let idSeq = 1;
  function builder(table: string) {
    const filters: Array<[string, string, any]> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null;
    let single = false;
    let maybe = false;

    const rowsMatching = () =>
      (db[table] ?? []).filter((r: any) =>
        filters.every(([col, kind, val]) => {
          if (kind === "eq") return r[col] === val;
          if (kind === "gt") return r[col] > val;
          if (kind === "is_null") return r[col] == null;
          if (kind === "in") return val.includes(r[col]);
          return true;
        }),
      );

    const resolve = () => {
      if (op === "insert") {
        const row = { id: `row-${idSeq++}`, used: false, created_at: new Date().toISOString(), ...payload };
        db[table].push(row);
        return { data: single ? row : [row], error: null };
      }
      if (op === "update") {
        const matched = rowsMatching();
        matched.forEach((r: any) => Object.assign(r, payload));
        return { data: matched, error: null };
      }
      if (op === "delete") {
        const keep = db[table].filter((r: any) => !rowsMatching().includes(r));
        db[table] = keep;
        return { data: null, error: null };
      }
      const rows = rowsMatching();
      if (single) return { data: rows[0] ?? null, error: null };
      if (maybe) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    };

    const api: any = {
      select() { /* returning select; never overrides a mutation op */ return api; },
      insert(p: any) { op = "insert"; payload = p; return api; },
      update(p: any) { op = "update"; payload = p; return api; },
      delete() { op = "delete"; return api; },
      eq(c: string, v: any) { filters.push([c, "eq", v]); return api; },
      gt(c: string, v: any) { filters.push([c, "gt", v]); return api; },
      is(c: string, v: any) { filters.push([c, "is_null", v]); return api; },
      in(c: string, v: any[]) { filters.push([c, "in", v]); return api; },
      order() { return api; },
      limit() { return api; },
      single() { single = true; return Promise.resolve(resolve()); },
      maybeSingle() { maybe = true; return Promise.resolve(resolve()); },
      then(onF: any, onR: any) { return Promise.resolve(resolve()).then(onF, onR); },
    };
    return api;
  }

  const client = {
    from: (t: string) => builder(t),
    // phone-auth reads amux.actors; the fake keeps every table in one namespace.
    schema: () => ({ from: (t: string) => builder(t) }),
    auth: {
      admin: {
        generateLink: async () => ({ data: { properties: { hashed_token: "ht_123" } }, error: null }),
        getUserById: async (id: string) => {
          const u = authStore.users.find((x: any) => x.id === id);
          return { data: { user: u ?? null }, error: u ? null : { message: "not found" } };
        },
        createUser: async ({ email, app_metadata }: any) => {
          const u = { id: `auth-${idSeq++}`, email, app_metadata };
          authStore.users.push(u);
          return { data: { user: u }, error: null };
        },
        updateUserById: async (id: string, patch: any) => {
          const u = authStore.users.find((x: any) => x.id === id);
          if (!u) return { data: null, error: { message: "not found" } };
          if (patch?.app_metadata) {
            u.app_metadata = { ...(u.app_metadata ?? {}), ...patch.app_metadata };
          }
          return { data: { user: u }, error: null };
        },
        deleteUser: async (id: string) => {
          authStore.users = authStore.users.filter((x: any) => x.id !== id);
          return { data: null, error: null };
        },
      },
      verifyOtp: async () => ({
        data: { session: { access_token: "at", refresh_token: "rt", expires_in: 3600, expires_at: 9999 } },
        error: null,
      }),
    },
  };
  return client;
}

function repoWith(db: any, authStore: any, extra: any = {}) {
  const client = makeFakeSupabase(db, authStore);
  return createPhoneAuthRepository({
    supabaseUrl: "http://sb",
    publishableKey: "anon",
    serviceRoleKey: "service",
    defaultOrgId: "org-default",
    phoneEmailDomain: "phone.example.test",
    encryptionKey: "k",
    sendSms: async () => {},
    createClient: () => client,
    nowMs: () => 1_000_000_000_000,
    genCode: () => "123456",
    ...extra,
  });
}

test("sendCode (debug) returns the code and persists a row", async () => {
  const db = { auth_verify_code: [] as any[], users: [] as any[] };
  const repo = repoWith(db, { users: [] }, { smsDebugMode: true });
  const r: any = await repo.sendCode({ phone: "13700000000" });
  assert.equal(r.debugCode, "123456");
  assert.equal(db.auth_verify_code.length, 1);
});

test("sendCode rejects invalid phone", async () => {
  const repo = repoWith({ auth_verify_code: [], users: [] }, { users: [] }, { smsDebugMode: true });
  await assert.rejects(() => repo.sendCode({ phone: "999" }), /有效的手机号/);
});

test("sendCode normalizes an E.164 +86 number to the bare form", async () => {
  const db = { auth_verify_code: [] as any[], users: [] as any[] };
  const repo = repoWith(db, { users: [] }, { smsDebugMode: true });
  // Clients send the E.164 form; it must not be rejected and must persist bare.
  const r: any = await repo.sendCode({ phone: "+8613700000000" });
  assert.equal(r.debugCode, "123456");
  assert.equal(db.auth_verify_code.length, 1);
  assert.equal(db.auth_verify_code[0].phone, "13700000000");
});

test("sendCode requires captcha when not in debug mode", async () => {
  const repo = repoWith({ auth_verify_code: [], users: [] }, { users: [] });
  await assert.rejects(() => repo.sendCode({ phone: "13700000000" }), /验证码验证失败/);
});

test("sendCode 429 when a code was sent within 60s", async () => {
  const db = { auth_verify_code: [], users: [] };
  const repo = repoWith(db, { users: [] });
  // First send (with captcha) seeds a recent row.
  await repo.sendCode({ phone: "13700000000", captchaVerify: "ok" });
  await assert.rejects(() => repo.sendCode({ phone: "13700000000", captchaVerify: "ok" }), /过于频繁/);
});

test("login reuses an existing public.users row (no new user)", async () => {
  const authStore = { users: [{ id: "auth-existing", email: "13700000000@phone.example.test" }] };
  const db = {
    auth_verify_code: [
      { id: "c1", phone: "13700000000", code: "123456", used: false, expires_at: new Date(2_000_000_000_000).toISOString(), created_at: "x" },
    ],
    users: [{ id: "u1", org_id: "org-default", mobile: "13700000000", auth_user_id: "auth-existing", deleted_at: null }],
  };
  const repo = repoWith(db, authStore);
  const r: any = await repo.login({ phone: "13700000000", code: "123456" });
  assert.equal(r.created, undefined);
  assert.equal(r.user.id, "u1");
  assert.equal(r.session.access_token, "at");
  assert.equal(db.auth_verify_code[0].used, true);
  assert.equal(authStore.users.length, 1); // no new auth user
});

test("login creates a new user when none exists in the default org", async () => {
  const authStore = { users: [] as any[] };
  const db = {
    auth_verify_code: [
      { id: "c1", phone: "13700000001", code: "123456", used: false, expires_at: new Date(2_000_000_000_000).toISOString(), created_at: "x" },
    ],
    users: [] as any[],
  };
  const repo = repoWith(db, authStore);
  const r: any = await repo.login({ phone: "13700000001", code: "123456" });
  assert.equal(r.created, true);
  assert.equal(r.user.org_id, "org-default");
  assert.equal(r.user.mobile, "13700000001");
  assert.equal(authStore.users.length, 1);
  assert.equal(db.users.length, 1);
});

test("login returns MULTI_USER when the phone maps to >1 user", async () => {
  const db = {
    auth_verify_code: [
      { id: "c1", phone: "13700000002", code: "123456", used: false, expires_at: new Date(2_000_000_000_000).toISOString(), created_at: "x" },
    ],
    users: [
      { id: "u1", org_id: "org-default", mobile: "13700000002", auth_user_id: "a1", deleted_at: null },
      { id: "u2", org_id: "org-default", mobile: "13700000002", auth_user_id: "a2", deleted_at: null },
    ],
  };
  const repo = repoWith(db, { users: [] });
  const r: any = await repo.login({ phone: "13700000002", code: "123456" });
  assert.equal(r.multiUser, true);
  assert.equal(r.users.length, 2);
  assert.equal(db.auth_verify_code[0].used, false); // code not consumed
});

test("login resolves a user whose org is NOT the default org", async () => {
  // The org filter used to pin a phone identity to DEFAULT_ORG forever: once
  // switch_active_team rewrote public.users.org_id to the team's oid, the next
  // login missed and registered the person again as brand new.
  const authStore = {
    users: [
      {
        id: "auth-moved",
        email: "13700000010@phone.example.test",
        app_metadata: { org_id: "org-default" },
      },
    ],
  };
  const db = {
    auth_verify_code: [
      { id: "c1", phone: "13700000010", code: "123456", used: false, expires_at: new Date(2_000_000_000_000).toISOString(), created_at: "x" },
    ],
    users: [
      { id: "u9", org_id: "org-own", mobile: "13700000010", auth_user_id: "auth-moved", deleted_at: null },
    ],
  };
  const repo = repoWith(db, authStore);
  const r: any = await repo.login({ phone: "13700000010", code: "123456" });
  assert.equal(r.created, undefined, "must reuse, not re-register");
  assert.equal(r.user.id, "u9");
  assert.equal(authStore.users.length, 1);
  // amux.current_org_id() reads the JWT claim before public.users.org_id, so a
  // stale claim would keep the session pinned to the old org.
  assert.equal(authStore.users[0].app_metadata.org_id, "org-own");
});

test("login leaves the org claim alone when it already matches", async () => {
  const authStore = {
    users: [
      { id: "auth-same", email: "13700000011@phone.example.test", app_metadata: { org_id: "org-own" } },
    ],
  };
  const db = {
    auth_verify_code: [
      { id: "c1", phone: "13700000011", code: "123456", used: false, expires_at: new Date(2_000_000_000_000).toISOString(), created_at: "x" },
    ],
    users: [
      { id: "u10", org_id: "org-own", mobile: "13700000011", auth_user_id: "auth-same", deleted_at: null },
    ],
  };
  const repo = repoWith(db, authStore);
  const r: any = await repo.login({ phone: "13700000011", code: "123456" });
  assert.equal(r.user.id, "u10");
  assert.equal(authStore.users[0].app_metadata.org_id, "org-own");
});

test("login offers the picker across DIFFERENT orgs, not just within one", async () => {
  const db = {
    auth_verify_code: [
      { id: "c1", phone: "13700000012", code: "123456", used: false, expires_at: new Date(2_000_000_000_000).toISOString(), created_at: "x" },
    ],
    users: [
      { id: "u11", org_id: "org-default", mobile: "13700000012", auth_user_id: "a1", deleted_at: null },
      { id: "u12", org_id: "org-acme", mobile: "13700000012", auth_user_id: "a2", deleted_at: null },
    ],
  };
  const repo = repoWith(db, { users: [] });
  const r: any = await repo.login({ phone: "13700000012", code: "123456" });
  assert.equal(r.multiUser, true);
  assert.deepEqual(r.users.map((u: any) => u.org_id).sort(), ["org-acme", "org-default"]);
  assert.equal(db.auth_verify_code[0].used, false);
});

test("login drops gym-membership rows from the account picker", async () => {
  // belayo's public.users is the partner's membership table: one admin_type=1
  // row per gym card. Only employee records and identities that own an actor
  // are accounts.
  const db = {
    auth_verify_code: [
      { id: "c1", phone: "13700000020", code: "123456", used: false, expires_at: new Date(2_000_000_000_000).toISOString(), created_at: "x" },
    ],
    users: [
      { id: "emp", org_id: "org-a", admin_type: 3, mobile: "13700000020", auth_user_id: "a1", deleted_at: null },
      { id: "shadow", org_id: "org-default", admin_type: 1, mobile: "13700000020", auth_user_id: "a2", deleted_at: null },
      { id: "card-1", org_id: "org-gym1", admin_type: 1, mobile: "13700000020", deleted_at: null },
      { id: "card-2", org_id: "org-gym2", admin_type: 1, mobile: "13700000020", deleted_at: null },
    ],
    actors: [{ id: "act1", user_id: "shadow", team_id: "t1" }],
  };
  const repo = repoWith(db, { users: [] });
  const r: any = await repo.login({ phone: "13700000020", code: "123456" });
  assert.equal(r.multiUser, true);
  assert.deepEqual(r.users.map((u: any) => u.id).sort(), ["emp", "shadow"]);
});

test("login signs straight in when membership rows leave a single account", async () => {
  const authStore = { users: [{ id: "a1", email: "boss@acme.test", app_metadata: { org_id: "org-a" } }] };
  const db = {
    auth_verify_code: [
      { id: "c1", phone: "13700000021", code: "123456", used: false, expires_at: new Date(2_000_000_000_000).toISOString(), created_at: "x" },
    ],
    users: [
      { id: "emp", org_id: "org-a", admin_type: 2, mobile: "13700000021", auth_user_id: "a1", deleted_at: null },
      { id: "card-1", org_id: "org-gym1", admin_type: 1, mobile: "13700000021", deleted_at: null },
    ],
  };
  const repo = repoWith(db, authStore);
  const r: any = await repo.login({ phone: "13700000021", code: "123456" });
  assert.equal(r.multiUser, undefined);
  assert.equal(r.user.id, "emp");
  assert.equal(db.auth_verify_code[0].used, true);
});

test("login still honours an explicit pick of a row the picker would hide", async () => {
  // A client holding yesterday's list must not be bounced back to the picker.
  const authStore = { users: [{ id: "card-1", email: "13700000022@phone.example.test" }] };
  const db = {
    auth_verify_code: [
      { id: "c1", phone: "13700000022", code: "123456", used: false, expires_at: new Date(2_000_000_000_000).toISOString(), created_at: "x" },
    ],
    users: [
      { id: "emp", org_id: "org-a", admin_type: 2, mobile: "13700000022", auth_user_id: "a1", deleted_at: null },
      { id: "card-1", org_id: "org-gym1", admin_type: 1, mobile: "13700000022", deleted_at: null },
    ],
  };
  const repo = repoWith(db, authStore);
  const r: any = await repo.login({ phone: "13700000022", code: "123456", userId: "card-1" });
  assert.equal(r.user.id, "card-1");
});

test("login rejects a wrong/expired code", async () => {
  const db = { auth_verify_code: [] as any[], users: [] as any[] };
  const repo = repoWith(db, { users: [] });
  await assert.rejects(() => repo.login({ phone: "13700000003", code: "000000" }), /验证码错误或已过期/);
});
