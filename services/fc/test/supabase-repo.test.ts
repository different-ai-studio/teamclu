import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import {
  createSupabaseBusinessRepository,
  createSupabaseAuthRepository,
  publishableKeyFromEnv,
} from "../src/lib/supabase-repo.js";
import { DEFAULT_MESSAGE_LIST_LIMIT } from "../src/lib/routing-utils.js";

test("createSupabaseBusinessRepository creates caller-scoped Supabase client", async () => {
  const calls = [];
  const repo = createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    createClient(url, key, options) {
      calls.push({ url, key, options });
      return fakeSupabase();
    },
  });

  await repo.listSessions({ limit: 25, teamId: "team-1" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.supabase.co");
  assert.equal(calls[0].key, "publishable-key");
  assert.deepEqual(calls[0].options.auth, { persistSession: false, autoRefreshToken: false });
  assert.deepEqual(calls[0].options.global.headers, { Authorization: "Bearer caller-token" });
  // realtime transport is wired so supabase-js doesn't crash on Node 20 (FC runtime);
  // we don't assert on its identity, just that it's set.
  assert.ok(calls[0].options.realtime?.transport, "expected realtime transport to be set");
  // Same treatment for the URL-length guard: identity isn't the contract, being
  // wired is — an unguarded fetch is how a 48KB PostgREST URL reached kong.
  assert.equal(typeof calls[0].options.global.fetch, "function", "expected guarded fetch");
});

test("publishableKeyFromEnv prefers publishable key and falls back to anon key", () => {
  assert.equal(publishableKeyFromEnv({ SUPABASE_PUBLISHABLE_KEY: "pk", SUPABASE_ANON_KEY: "anon" }), "pk");
  assert.equal(publishableKeyFromEnv({ SUPABASE_ANON_KEY: "anon" }), "anon");
});

test("listSessions maps current actor session rpc rows", async () => {
  const rpcCalls = [];
  const repo = createRepo(fakeSupabase({
    rpcCalls,
    rpcData: {
      list_current_actor_sessions: [{
        id: "session-1",
        team_id: "team-1",
        title: "Plan",
        mode: "collab",
        idea_id: "idea-1",
        last_message_at: "2026-05-27T01:00:00Z",
        last_message_preview: "hello",
        has_unread: true,
        created_at: "2026-05-26T01:00:00Z",
        updated_at: "2026-05-27T01:00:00Z",
      }],
    },
  }));

  const rows = await repo.listSessions({
    limit: 10,
    teamId: "team-1",
    kind: "regular",
    cursor: { lastMessageAt: "2026-05-27T00:00:00Z", createdAt: "2026-05-26T00:00:00Z", id: "s0" },
  });

  // p_team_id arrived with 20260802000000_session_list_team_and_idea_scope and
  // became mandatory in 20260804020000 — it is what resolves the caller's
  // actor. p_idea_id stays optional and is passed as null when unset.
  assert.deepEqual(rpcCalls, [{
    name: "list_current_actor_sessions",
    args: {
      p_limit: 10,
      p_before_last_message_at: "2026-05-27T00:00:00Z",
      p_before_created_at: "2026-05-26T00:00:00Z",
      p_before_id: "s0",
      p_team_id: "team-1",
      p_idea_id: null,
      p_kind: "regular",
    },
  }]);
  // The row grew after this test was written: source/cronJobId came with cron
  // sessions, participantCount with the list redesign. A fixture that omits
  // them exercises the defaults, which is the contract clients rely on.
  assert.deepEqual(rows, [{
    id: "session-1",
    teamId: "team-1",
    title: "Plan",
    mode: "collab",
    ideaId: "idea-1",
    lastMessageAt: "2026-05-27T01:00:00Z",
    lastMessagePreview: "hello",
    hasUnread: true,
    source: "user",
    cronJobId: null,
    summary: null,
    primaryAgentId: null,
    createdByActorId: null,
    participantCount: 0,
    createdAt: "2026-05-26T01:00:00Z",
    updatedAt: "2026-05-27T01:00:00Z",
    createdByActorId: null,
    cronJobId: null,
    participantCount: 0,
    primaryAgentId: null,
    source: "user",
    summary: null,
  }]);
});

test("insertMessage writes a messages row and maps response", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    tableData: {
      messages: [{
        id: "message-1",
        team_id: "team-1",
        session_id: "session-1",
        turn_id: null,
        sender_actor_id: "actor-1",
        reply_to_message_id: null,
        kind: "text",
        content: "hello",
        metadata: null,
        model: null,
        created_at: "2026-05-27T01:00:00Z",
        updated_at: null,
      }],
    },
  }));

  const message = await repo.insertMessage("session-1", {
    id: "message-1",
    teamId: "team-1",
    senderActorId: "actor-1",
    content: "hello",
  });

  assert.equal(tableCalls[0].table, "messages");
  assert.equal(tableCalls[0].op, "insert");
  assert.deepEqual(tableCalls[0].row, {
    id: "message-1",
    team_id: "team-1",
    session_id: "session-1",
    sender_actor_id: "actor-1",
    kind: "text",
    content: "hello",
    metadata: {},
    model: null,
    turn_id: null,
    reply_to_message_id: null,
  });
  assert.equal(message.id, "message-1");
  assert.equal(message.teamId, "team-1");
  assert.equal(message.senderActorId, "actor-1");
});

test("insertMessage calls injected dispatchPush once with snake_case record", async () => {
  const calls: any[] = [];
  const repo = createRepo(fakeSupabase({
    tableData: {
      messages: [{
        id: "message-1",
        team_id: "team-1",
        session_id: "session-1",
        turn_id: null,
        sender_actor_id: "actor-1",
        reply_to_message_id: null,
        kind: "text",
        content: "hello",
        metadata: null,
        model: null,
        created_at: "2026-05-27T01:00:00Z",
        updated_at: null,
      }],
    },
  }), {
    dispatchPush: async (record) => { calls.push(record); },
  });

  const message = await repo.insertMessage("session-1", {
    id: "message-1",
    teamId: "team-1",
    senderActorId: "actor-1",
    content: "hello",
  });

  await new Promise((r) => setImmediate(r));

  assert.equal(calls.length, 1, "dispatchPush should be called exactly once");
  assert.equal(calls[0].id, message.id);
  assert.equal(calls[0].session_id, "session-1");
  assert.equal(calls[0].team_id, "team-1");
  assert.equal(calls[0].sender_actor_id, "actor-1");
  assert.equal(calls[0].kind, "text");
  assert.equal(calls[0].content, "hello");
});

test("insertMessage succeeds even when dispatchPush throws", async () => {
  const repo = createRepo(fakeSupabase({
    tableData: {
      messages: [{
        id: "message-2",
        team_id: "team-1",
        session_id: "session-1",
        turn_id: null,
        sender_actor_id: "actor-1",
        reply_to_message_id: null,
        kind: "text",
        content: "push throws",
        metadata: null,
        model: null,
        created_at: "2026-05-27T01:00:00Z",
        updated_at: null,
      }],
    },
  }), {
    dispatchPush: async () => { throw new Error("push failure"); },
  });

  const message = await repo.insertMessage("session-1", {
    id: "message-2",
    teamId: "team-1",
    senderActorId: "actor-1",
    content: "push throws",
  });

  await new Promise((r) => setImmediate(r));

  assert.equal(message.id, "message-2");
});

test("auth repo claimInvite calls claim_team_invite RPC anonymously", async () => {
  // The bootstrap claim flow has no caller bearer; the auth repo must use an
  // anon-key Supabase client (no Authorization header) to invoke the
  // SECURITY DEFINER RPC `claim_team_invite`.
  const createCalls = [];
  const repo = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    createClient(url, key, options) {
      createCalls.push({ url, key, options });
      return fakeSupabase({
        rpcData: {
          claim_team_invite: [{
            actor_id: "actor-1",
            team_id: "team-1",
            actor_type: "agent",
            display_name: "Daemon",
            refresh_token: "refresh-1",
          }],
        },
      });
    },
  });

  assert.deepEqual(await repo.claimInvite("invite-token"), {
    actorId: "actor-1",
    teamId: "team-1",
    actorType: "agent",
    displayName: "Daemon",
    refreshToken: "refresh-1",
  });
  // Auth repo must NOT attach a caller bearer header.
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].options.global, undefined);
});

test("auth repo claimInvite forwards the caller bearer for member claims", async () => {
  // Member claims arrive authenticated: the joining user's bearer must reach
  // PostgREST so the RPC resolves auth.uid(). The repo builds a per-token client
  // with an Authorization header instead of using the shared anon client.
  const createCalls = [];
  const repo = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    createClient(url, key, options) {
      createCalls.push({ url, key, options });
      return fakeSupabase({
        rpcData: {
          claim_team_invite: [{
            actor_id: "actor-9",
            team_id: "team-9",
            actor_type: "member",
            display_name: "Joiner",
            refresh_token: null,
          }],
        },
      });
    },
  });

  assert.deepEqual(await repo.claimInvite("invite-token", { accessToken: "member-jwt" }), {
    actorId: "actor-9",
    teamId: "team-9",
    actorType: "member",
    displayName: "Joiner",
    refreshToken: null,
  });
  // Two clients: the shared anon client at construction, then a per-token
  // authed client carrying the caller bearer.
  assert.equal(createCalls.length, 2);
  assert.equal(createCalls[1].options.global.headers.Authorization, "Bearer member-jwt");
});

test("repository throws upstream errors without hiding Supabase error codes", async () => {
  const repo = createRepo(fakeSupabase({
    rpcErrors: {
      list_current_actor_sessions: { code: "42501", message: "rls denied" },
    },
  }));

  await assert.rejects(() => repo.listSessions({ teamId: "team-1" }), (err: any) => {
    assert.equal(err.code, "42501");
    return true;
  });
});

// Released clients that predate 20260804020000 send no teamId. They must keep
// getting a list rather than an error, via the deprecated un-scoped RPC.
// The un-scoped rpc this used to assert on is dropped in
// 20260810010000_drop_unscoped_session_list.sql. Without a team the query has no
// index to walk, so it scanned every participant row the caller had and sorted:
// 4.5s at 6k sessions, statement_timeout 500 past ~13k. Reject instead of
// reaching for a query that cannot scale.
test("listSessions refuses to run without a teamId", async () => {
  const rpcCalls: any[] = [];
  const repo = createRepo(fakeSupabase({ rpcCalls, rpcData: {} }));

  await assert.rejects(
    () => repo.listSessions({ limit: 10 }),
    (err: any) => err?.statusCode === 400 && err?.code === "validation_failed",
  );
  assert.equal(rpcCalls.length, 0, "must not issue an un-scoped rpc");
});

test("createSupabaseAuthRepository refreshAccessToken calls Supabase auth endpoint", async () => {
  const fetchCalls = [];
  const repo = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "anon-key",
    async fetchImpl(url, options) {
      fetchCalls.push({ url, options });
      return new Response(JSON.stringify({
        access_token: "new-at",
        refresh_token: "new-rt",
        expires_at: 1234567890,
      }), { status: 200 });
    },
  });

  const result = await repo.refreshAccessToken({ refreshToken: "old-rt" });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://example.supabase.co/auth/v1/token?grant_type=refresh_token");
  assert.equal(fetchCalls[0].options.method, "POST");
  assert.equal(fetchCalls[0].options.headers.apikey, "anon-key");
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), { refresh_token: "old-rt" });
  assert.deepEqual(result, { accessToken: "new-at", refreshToken: "new-rt", expiresAt: 1234567890 });
});

test("createSupabaseAuthRepository refreshAccessToken throws on auth failure", async () => {
  const repo = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "anon-key",
    async fetchImpl() {
      return new Response("Invalid refresh token", { status: 401 });
    },
  });

  await assert.rejects(
    () => repo.refreshAccessToken({ refreshToken: "bad-rt" }),
    (err: any) => {
      assert.equal(err.statusCode, 401);
      assert.equal(err.code, "missing_auth");
      return true;
    },
  );
});

function createRepo(
  supabase,
  extra: { createServiceRoleClient?: () => unknown } & Record<string, unknown> = {},
) {
  const admin = extra.createServiceRoleClient?.() ?? supabase;
  return createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    createClient: () => supabase,
    createServiceRoleClient: () => admin,
    ...extra,
  });
}

const OWNER_AUTH = {
  auth: {
    async getUser() {
      return { data: { user: { id: "user-owner-1" } }, error: null };
    },
  },
};

function fakeSupabaseForOwnerRpc(rpcData, rpcCalls = []) {
  return fakeSupabase({
    rpcCalls,
    rpcData,
    tableData: {
      actors: [{ id: "actor-owner-1" }],
      team_members: [{ role: "owner" }],
    },
    auth: OWNER_AUTH.auth,
  });
}

// ── listMessages pagination ──────────────────────────────────────────────────
// The query fetches NEWEST-first so `limit` truncates the old end of a long
// history, then reverses so the page reads oldest-first. Fetching ascending and
// slicing would keep the wrong end of a 6k-message session.

function msgRow(id: string, createdAt: string) {
  return {
    id,
    team_id: "team-1",
    session_id: "session-1",
    kind: "text",
    content: id,
    created_at: createdAt,
  };
}

test("listMessages fetches the newest page descending and returns it oldest-first", async () => {
  const tableCalls: any[] = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    // What Postgres would hand back for ORDER BY created_at DESC.
    tableData: {
      messages: [
        msgRow("m3", "2026-05-27T00:00:03Z"),
        msgRow("m2", "2026-05-27T00:00:02Z"),
        msgRow("m1", "2026-05-27T00:00:01Z"),
      ],
    },
  }));

  const rows = await repo.listMessages("session-1", { limit: 3 });

  assert.deepEqual(rows.map((r: any) => r.id), ["m1", "m2", "m3"], "page reads oldest-first");
  const orders = tableCalls.filter((c) => c.op === "order");
  assert.deepEqual(
    orders.map((o) => [o.column, o.options.ascending]),
    [["created_at", false], ["id", false]],
    "must sort descending so the limit cuts the OLD end",
  );
  assert.ok(tableCalls.some((c) => c.op === "limit" && c.count === 3), "limit must reach the query");
});

test("listMessages applies a default limit when the caller gives none", async () => {
  const tableCalls: any[] = [];
  const repo = createRepo(fakeSupabase({ tableCalls, tableData: { messages: [] } }));

  await repo.listMessages("session-1");

  assert.ok(
    tableCalls.some((c) => c.op === "limit" && c.count === DEFAULT_MESSAGE_LIST_LIMIT),
    "an omitted limit must not mean 'the entire history'",
  );
});

test("listMessages cursor asks for strictly older rows, tiebroken on id", async () => {
  const tableCalls: any[] = [];
  const repo = createRepo(fakeSupabase({ tableCalls, tableData: { messages: [] } }));

  await repo.listMessages("session-1", {
    limit: 2,
    cursor: { createdAt: "2026-05-27T00:00:02Z", id: "m-9" },
  });

  const or = tableCalls.find((c) => c.op === "or");
  assert.equal(
    or?.expr,
    "created_at.lt.2026-05-27T00:00:02Z,and(created_at.eq.2026-05-27T00:00:02Z,id.lt.m-9)",
    "PostgREST has no row-value comparison, so the keyset is an explicit OR",
  );
});

// ── *ForSync keyset ──────────────────────────────────────────────────────────
// All the sync readers share applySyncKeyset: forward through (updated_at, id),
// ascending, bounded. They were unbounded before.

test("sync readers order ascending on (updated_at, id) and bound the page", async () => {
  const readers: Array<[string, (repo: any) => Promise<unknown>]> = [
    ["actor_directory", (r) => r.listActorDirectoryForSync("team-1", null, { limit: 7 })],
    ["ideas", (r) => r.listIdeasForSync("team-1", null, { limit: 7 })],
    ["session_participants", (r) => r.listSessionParticipantsForSync("session-1", null, { limit: 7 })],
    ["sessions", (r) => r.listSessionsForTeamSince("team-1", null, { limit: 7 })],
    ["messages", (r) => r.listMessagesForSessionSince("session-1", null, { limit: 7 })],
  ];

  for (const [table, run] of readers) {
    const tableCalls: any[] = [];
    await run(createRepo(fakeSupabase({ tableCalls, tableData: { [table]: [] } })));

    const orders = tableCalls.filter((c) => c.op === "order");
    assert.deepEqual(
      orders.map((o) => [o.column, o.options.ascending]),
      [["updated_at", true], ["id", true]],
      `${table}: sync must walk forward, id-tiebroken`,
    );
    assert.ok(
      tableCalls.some((c) => c.op === "limit" && c.count === 7),
      `${table}: limit must reach the query`,
    );
  }
});

test("sync readers express the keyset as a PostgREST OR", async () => {
  const tableCalls: any[] = [];
  const repo = createRepo(fakeSupabase({ tableCalls, tableData: { ideas: [] } }));

  await repo.listIdeasForSync("team-1", "2026-05-01T00:00:00Z", {
    limit: 50,
    cursor: { updatedAt: "2026-05-27T00:00:02Z", id: "row-7" },
  });

  const or = tableCalls.find((c) => c.op === "or");
  assert.equal(
    or?.expr,
    "updated_at.gt.2026-05-27T00:00:02Z,and(updated_at.eq.2026-05-27T00:00:02Z,id.gt.row-7)",
  );
  // `since` and the cursor are independent filters and must both survive.
  assert.ok(
    tableCalls.some((c) => c.op === "gt" && c.column === "updated_at"),
    "the `since` watermark must not be dropped when a cursor is present",
  );
});

test("createTeam routes to create_team with the caller's JWT org as fallback", async () => {
  const rpcCalls = [];
  const prev = process.env.DEFAULT_ORG_ID;
  process.env.DEFAULT_ORG_ID = "org-default";
  try {
    const repo = createRepo(fakeSupabase({
      rpcCalls,
      auth: {
        async getUser() {
          return { data: { user: { id: "u1", app_metadata: { org_id: "org-real" } } }, error: null };
        },
      },
      rpcData: {
        create_team: [{
          team_id: "team-9",
          team_name: "香蕉攀岩",
          team_slug: "banana",
          member_id: "actor-9",
          role: "member",
        }],
      },
    }));

    const team = await repo.createTeam({ displayName: "梁江" });

    // Caller's real org wins as the fallback stamp; explicit creation never
    // silently joins an existing organization team.
    assert.deepEqual(rpcCalls, [{
      name: "create_team",
      args: {
        p_name: null,
        p_slug: null,
        p_display_name: "梁江",
        p_litellm_team_id: null,
        p_ai_gateway_endpoint: null,
        p_oid: "org-real",
      },
    }]);
    assert.equal(team.id, "team-9");
    assert.equal(team.name, "香蕉攀岩");
    assert.equal(team.slug, "banana");
  } finally {
    if (prev === undefined) delete process.env.DEFAULT_ORG_ID;
    else process.env.DEFAULT_ORG_ID = prev;
  }
});

test("createTeam mints a personal org when the caller carries none — never DEFAULT_ORG_ID", async () => {
  const rpcCalls = [];
  const prev = process.env.DEFAULT_ORG_ID;
  // Set deliberately: the shared tenant must NOT be picked up here any more.
  // It serves phone-auth only.
  process.env.DEFAULT_ORG_ID = "org-default";
  try {
    const repo = createRepo(fakeSupabase({
      rpcCalls,
      auth: {
        async getUser() {
          return { data: { user: { id: "u2", app_metadata: {} } }, error: null };
        },
      },
      rpcData: {
        ensure_personal_org: "org-mine",
        create_team: [{
          team_id: "team-solo",
          team_name: "Zesty Falcon",
          team_slug: "zesty-falcon",
          member_id: "actor-solo",
          role: "owner",
        }],
      },
    }));

    await repo.createTeam({ name: "My Team", slug: "my-team" });

    assert.equal(rpcCalls.length, 2);
    assert.equal(rpcCalls[0].name, "ensure_personal_org");
    assert.equal(rpcCalls[1].name, "create_team");
    assert.equal(rpcCalls[1].args.p_oid, "org-mine");
    assert.equal(rpcCalls[1].args.p_name, "My Team");
    assert.equal(rpcCalls[1].args.p_slug, "my-team");
  } finally {
    if (prev === undefined) delete process.env.DEFAULT_ORG_ID;
    else process.env.DEFAULT_ORG_ID = prev;
  }
});

// A partner (Betly) session is issued by a separately hosted Supabase Auth, so
// it has no auth.sessions row here and local GoTrue would reject it. 9cf5db90
// replaced the `caller` injection these tests used to pass with in-repo
// verification gated on TRUSTED_EXTERNAL_JWT_SECRET — the tests kept injecting
// `caller`, which the repo no longer reads, so they fell through to GoTrue and
// have been failing since 2026-08-01. Same contract, current mechanism.
const TRUSTED_SECRET = "trusted-external-secret";

async function trustedExternalToken(claims: Record<string, unknown> = {}) {
  return new SignJWT({ app_metadata: { org_id: "betly-org-1" }, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("betly-user-1")
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(TRUSTED_SECRET));
}

test("bootstrapTeam verifies a trusted external JWT without a local GoTrue lookup", async () => {
  const rpcCalls: any[] = [];
  const repo = createRepo(fakeSupabase({
    rpcCalls,
    auth: {
      async getUser() {
        throw new Error("TeamClu GoTrue must not be called for a trusted external JWT");
      },
    },
    rpcData: {
      bootstrap_login_team: [{ team_id: "team-bootstrap", team_name: "Betly", team_slug: "betly" }],
    },
  }), {
    accessToken: await trustedExternalToken(),
    trustedExternalJwtSecret: TRUSTED_SECRET,
  });

  const team = await repo.bootstrapTeam({ displayName: "Betly User" });

  assert.deepEqual(rpcCalls, [{
    name: "bootstrap_login_team",
    args: {
      p_allow_new_org: true,
      p_shared_org: process.env.DEFAULT_ORG_ID || null,
      p_display_name: "Betly User",
    },
  }]);
  assert.equal(team.id, "team-bootstrap");
});

test("bootstrapTeam passes the shared tenant so the partner org stays on the old path", async () => {
  const rpcCalls: any[] = [];
  const prev = process.env.DEFAULT_ORG_ID;
  process.env.DEFAULT_ORG_ID = "betly-org-1";
  try {
    const repo = createRepo(fakeSupabase({
      rpcCalls,
      rpcData: {
        bootstrap_login_team: [{ team_id: "t", team_name: "Betly", team_slug: "betly" }],
      },
    }), {
      accessToken: await trustedExternalToken(),
      trustedExternalJwtSecret: TRUSTED_SECRET,
    });

    await repo.bootstrapTeam({ displayName: "Betly User" });

    assert.equal(rpcCalls[0].args.p_shared_org, "betly-org-1");
  } finally {
    if (prev === undefined) delete process.env.DEFAULT_ORG_ID;
    else process.env.DEFAULT_ORG_ID = prev;
  }
});

test("bootstrapTeam turns the SQL registration refusal into a 403", async () => {
  const repo = createRepo(fakeSupabase({
    rpcErrors: {
      bootstrap_login_team: {
        code: "42501",
        message: "self-registration is disabled on this deployment",
      },
    },
  }), {
    accessToken: await trustedExternalToken(),
    trustedExternalJwtSecret: TRUSTED_SECRET,
  });

  await assert.rejects(
    () => repo.bootstrapTeam({ displayName: "Betly User" }),
    (err: any) => err?.statusCode === 403 && err?.code === "registration_disabled",
  );
});

test("bootstrapTeam rejects a token the trust secret does not verify", async () => {
  const rpcCalls: any[] = [];
  const repo = createRepo(fakeSupabase({
    rpcCalls,
    auth: {
      async getUser() {
        throw new Error("a forged external JWT must never fall back to local GoTrue");
      },
    },
  }), {
    accessToken: await new SignJWT({ app_metadata: { org_id: "attacker-org" } })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("attacker")
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("wrong-secret")),
    trustedExternalJwtSecret: TRUSTED_SECRET,
  });

  await assert.rejects(
    () => repo.bootstrapTeam({ displayName: "Betly User" }),
    (err: any) => err?.statusCode === 401,
    "a signature the trust secret rejects must not bootstrap a team",
  );
  assert.deepEqual(rpcCalls, [], "no RPC may run for an unverified caller");
});

test("removeTeamActor calls amux.remove_team_actor explicitly", async () => {
  // Schema-qualified on purpose: an unqualified call could resolve a stale
  // public.remove_team_actor left behind by an older migration.
  const rpcCalls: any[] = [];
  const repo = createRepo(fakeSupabase({ rpcCalls, rpcData: { remove_team_actor: null } }));

  await repo.removeTeamActor("team-12", "actor-12");

  const rpc = rpcCalls.find((c) => c.name === "remove_team_actor");
  assert.ok(rpc, "expected remove_team_actor RPC call");
  assert.equal(rpc.schema, "amux", "must call amux.remove_team_actor explicitly");
});

test("getWorkspaceConfig merges teams + team_workspace_config rows", async () => {
  const repo = createRepo(fakeSupabase({
    tableData: {
      teams: [{
        share_mode: "oss",
        git_remote_url: "https://example.com/repo.git",
        git_auth_kind: "https_token",
      }],
      team_workspace_config: [{
        sync_mode: "git",
        llm_enabled: true,
        llm_base_url: "https://gateway.example/v1",
        llm_models: [{ id: "pro", name: "Pro" }],
      }],
    },
  }));

  const result = await repo.getWorkspaceConfig("team-6");

  // `models` is the stored, authoritative per-team list.
  assert.deepEqual(result, {
    syncMode: "git",
    llm: {
      enabled: true,
      baseUrl: "https://gateway.example/v1",
      models: [{ id: "pro", name: "Pro" }],
    },
  });
});

test("getWorkspaceConfig returns nulls when both rows absent", async () => {
  const repo = createRepo(fakeSupabase({
    tableData: { teams: [], team_workspace_config: [] },
  }));
  const result = await repo.getWorkspaceConfig("team-7");
  assert.deepEqual(result, {
    syncMode: null,
    // Absent config means LLM disabled, not "unknown": the client renders the
    // off state from these defaults rather than special-casing a missing block.
    llm: {
      enabled: false,
      baseUrl: null,
      models: [],
    },
  });
});




// amuxc_blobs is the OSS-sync blob ledger, not a skills table: `authenticated`
// holds SELECT and nothing else, and every write belongs to service_role
// (20260527000002_oss_sync_schema.sql). The skills registry reuses it for
// package bookkeeping, so publishing through the caller's own token died with
// `403 permission denied for table amuxc_blobs` on self-host. Escalating beats
// granting the client INSERT/UPDATE — `verified` is the flag OSS sync trusts.
const BLOB_CALLER_AUTH = {
  auth: {
    async getUser() {
      return { data: { user: { id: "user-1" } }, error: null };
    },
  },
};

test("prepareTeamSkillBlob writes amuxc_blobs with the service-role client", async () => {
  const callerCalls: any[] = [];
  const adminCalls: any[] = [];
  const caller = fakeSupabase({
    ...BLOB_CALLER_AUTH,
    tableCalls: callerCalls,
    tableData: { actors: [{ id: "actor-1" }] },
  });
  const admin = fakeSupabase({ tableCalls: adminCalls });
  const repo = createRepo(caller, { createServiceRoleClient: () => admin });

  const hash = "a".repeat(64);
  const out = await repo.prepareTeamSkillBlob("team-1", { contentHash: hash, size: 42 });

  assert.equal(out.ossKey, `teams/team-1/blobs/sha256/aa/aa/${hash}`);
  const write = adminCalls.find((c) => c.table === "amuxc_blobs" && c.op === "upsert");
  assert.ok(write, "the placeholder row must be upserted with the service-role client");
  assert.equal(write.row.verified, false);
  assert.equal(
    callerCalls.some((c) => c.table === "amuxc_blobs"),
    false,
    "a caller-token write to amuxc_blobs is 42501 permission denied",
  );
});

test("completeTeamSkillBlob checks as the caller and flips verified as service_role", async () => {
  const callerCalls: any[] = [];
  const adminCalls: any[] = [];
  const hash = "b".repeat(64);
  const caller = fakeSupabase({
    ...BLOB_CALLER_AUTH,
    tableCalls: callerCalls,
    tableData: {
      actors: [{ id: "actor-1" }],
      amuxc_blobs: [{ oss_key: `teams/team-1/blobs/sha256/bb/bb/${hash}`, size: 42 }],
    },
  });
  const admin = fakeSupabase({ tableCalls: adminCalls });
  const repo = createRepo(caller, { createServiceRoleClient: () => admin });

  const out = await repo.completeTeamSkillBlob("team-1", { contentHash: hash });

  assert.equal(out.size, 42);
  // The existence check stays on the caller's token so RLS keeps proving the
  // blob belongs to a team they are actually in.
  assert.ok(callerCalls.some((c) => c.table === "amuxc_blobs" && c.op === "select"));
  const update = adminCalls.find((c) => c.table === "amuxc_blobs" && c.op === "update");
  assert.ok(update, "verified must be flipped with the service-role client");
  assert.equal(update.row.verified, true);
  assert.equal(
    callerCalls.some((c) => c.table === "amuxc_blobs" && c.op === "update"),
    false,
  );
});

function fakeSupabase({
  rpcCalls = [],
  tableCalls = [],
  rpcData = {},
  rpcErrors = {},
  tableData = {},
  tableErrors = {},
  auth = null,
  // Extended hooks for telemetry tests
  onRpc = null,
  onInsert = null,
  onUpsert = null,
  upsertData = null,
} = {}) {
  const client: any = {
    auth: auth ?? {
      async getUser() {
        return { data: { user: null }, error: null };
      },
    },
    async rpc(name, args, schema = null) {
      rpcCalls.push(schema ? { name, args, schema } : { name, args });
      if (onRpc) onRpc(name, args);
      return { data: rpcData[name] ?? [], error: rpcErrors[name] ?? null };
    },
    from(table) {
      return createTableQuery(table, tableCalls, tableData[table] ?? [], tableErrors[table] ?? null, {
        onInsert,
        onUpsert,
        upsertData,
      });
    },
    schema(name) {
      return {
        rpc(rpcName, args) {
          return client.rpc(rpcName, args, name);
        },
        from(table) {
          return client.from(table);
        },
      };
    },
  };
  return client;
}

function createTableQuery(table: any, calls: any, data: any, error: any, hooks: any = {}) {
  const { onInsert, onUpsert, upsertData } = hooks;
  return {
    select(columns) {
      calls.push({ table, op: "select", columns });
      return createSelectableQuery(table, calls, data, error);
    },
    insert(row) {
      calls.push({ table, op: "insert", row });
      if (onInsert) onInsert(table, row);
      return {
        select(columns) {
          calls.push({ table, op: "insert.select", columns });
          return {
            async single() {
              calls.push({ table, op: "insert.single" });
              return { data: data[0] ?? null, error };
            },
          };
        },
        // Allow bare insert() to resolve immediately
        then(resolve, reject) {
          return Promise.resolve({ data: null, error }).then(resolve, reject);
        },
      };
    },
    // Single upsert: captures options + call records (agent_runtimes tests) and
    // honors the onUpsert/upsertData hooks (telemetry tests). A prior auto-merge
    // left two same-named upsert methods; the later silently shadowed the former.
    upsert(row, options) {
      calls.push({ table, op: "upsert", row, options });
      if (onUpsert) onUpsert(table, row);
      const resolvedData = upsertData ?? data[0] ?? null;
      return {
        select(columns) {
          calls.push({ table, op: "upsert.select", columns });
          return {
            async single() {
              calls.push({ table, op: "upsert.single" });
              return { data: resolvedData, error };
            },
          };
        },
        // A bare `await client.from(t).upsert(...)` has to surface the error the
        // same way insert() does. Without this the builder resolves to itself,
        // the destructured `error` is undefined, and a failing upsert reads as
        // a success in tests.
        then(resolve, reject) {
          return Promise.resolve({ data: resolvedData, error }).then(resolve, reject);
        },
      };
    },
    update(row) {
      calls.push({ table, op: "update", row });
      return createUpdatableQuery(table, calls, data, error);
    },
  };
}

function createUpdatableQuery(table, calls, data, error) {
  let eqValue = null;
  const query = {
    eq(column, value) {
      calls.push({ table, op: "update.eq", column, value });
      eqValue = value;
      return query;
    },
    // `in` / `is` / awaiting the builder are what a filtered bulk UPDATE needs
    // (archiveSessionsForWorkspace does `.in("id", chunk).is("archived_at", null)`
    // with no `.select()`). Without them that call resolved to undefined and the
    // path was untestable — which is how it kept reading a dropped table.
    in(column, values) {
      calls.push({ table, op: "update.in", column, values });
      return query;
    },
    is(column, value) {
      calls.push({ table, op: "update.is", column, value });
      return query;
    },
    select(columns) {
      calls.push({ table, op: "update.select", columns });
      return {
        async maybeSingle() {
          calls.push({ table, op: "update.maybeSingle" });
          return { data: eqValue ? { id: eqValue } : data[0] ?? null, error };
        },
        async single() {
          calls.push({ table, op: "update.single" });
          return { data: data[0] ?? (eqValue ? { id: eqValue } : null), error };
        },
      };
    },
    then(resolve, reject) {
      return Promise.resolve({ data: null, error }).then(resolve, reject);
    },
  };
  return query;
}

function createSelectableQuery(table, calls, data, error) {
  const query = {
    order(column, options) {
      calls.push({ table, op: "order", column, options });
      return query;
    },
    // Returns the builder, not a promise: `.limit(1).maybeSingle()` is how the
    // member-actor lookup reads, and a promise has no maybeSingle. Awaiting the
    // builder still resolves `{ data, error }` via then(), so direct-await
    // callers are unaffected.
    limit(count) {
      calls.push({ table, op: "limit", count });
      return query;
    },
    eq(column, value) {
      calls.push({ table, op: "eq", column, value });
      return query;
    },
    in(column, values) {
      calls.push({ table, op: "in", column, values });
      return query;
    },
    or(expr) {
      calls.push({ table, op: "or", expr });
      return query;
    },
    gt(column, value) {
      calls.push({ table, op: "gt", column, value });
      return query;
    },
    single() {
      calls.push({ table, op: "single" });
      return Promise.resolve({ data: data[0] ?? null, error });
    },
    maybeSingle() {
      calls.push({ table, op: "maybeSingle" });
      return Promise.resolve({ data: data[0] ?? null, error });
    },
    then(resolve, reject) {
      return Promise.resolve({ data, error }).then(resolve, reject);
    },
  };
  return query;
}

test("patchWorkspace archives linked sessions via session_participants, not the dropped agent_runtimes", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    tableData: {
      workspaces: [{ id: "ws-1", team_id: "team-1", name: "Repo", path: "/repo", archived: true }],
      session_participants: [
        { session_id: "session-1" },
        { session_id: "session-2" },
        // Same agent re-attached: the id set must be deduped before the update.
        { session_id: "session-1" },
      ],
    },
  }));

  await repo.patchWorkspace("ws-1", { archived: true });

  const source = tableCalls.find((c) => c.op === "select" && c.table !== "workspaces");
  assert.equal(
    source?.table,
    "session_participants",
    "workspace_id moved to session_participants in 20260803000000; agent_runtimes was dropped by 20260803010000",
  );
  assert.ok(
    tableCalls.every((c) => c.table !== "agent_runtimes"),
    "must not touch the dropped agent_runtimes table",
  );
  assert.deepEqual(
    tableCalls.find((c) => c.table === "session_participants" && c.op === "eq"),
    { table: "session_participants", op: "eq", column: "workspace_id", value: "ws-1" },
  );

  const sessionUpdate = tableCalls.find((c) => c.table === "sessions" && c.op === "update.in");
  assert.deepEqual(sessionUpdate?.values, ["session-1", "session-2"], "deduped session ids");
  assert.ok(
    tableCalls.some((c) => c.table === "sessions" && c.op === "update.is" && c.column === "archived_at"),
    "archive must stay idempotent by skipping already-archived rows",
  );
});

test("patchWorkspace without archived:true never touches sessions", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    tableData: { workspaces: [{ id: "ws-1", team_id: "team-1", name: "Renamed", path: "/repo" }] },
  }));

  await repo.patchWorkspace("ws-1", { name: "Renamed" });

  assert.ok(
    tableCalls.every((c) => c.table !== "sessions" && c.table !== "session_participants"),
    "a rename must not cascade into session archival",
  );
});

// --- Actor directory ---

test("listTeamActors selects actor_directory columns without removed agent_kind", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    tableData: {
      actor_directory: [{
        id: "actor-1",
        team_id: "team-1",
        actor_type: "agent",
        user_id: null,
        invited_by_actor_id: null,
        display_name: "Bot",
        avatar_url: null,
        team_role: null,
        member_status: null,
        agent_status: "idle",
        agent_types: ["claude"],
        default_agent_type: "claude",
        default_workspace_id: null,
        agent_visibility: "team",
        last_active_at: null,
        created_at: "2026-05-27T01:00:00Z",
        updated_at: "2026-05-27T01:00:00Z",
      }],
    },
  }));

  const page = await repo.listTeamActors("team-1", { limit: 10 });
  const selectCall = tableCalls.find((c) => c.table === "actor_directory" && c.op === "select");
  assert.ok(selectCall, "expected actor_directory select");
  assert.ok(!selectCall.columns.includes("agent_kind"), "must not select removed agent_kind column");
  assert.ok(selectCall.columns.includes("owner_member_id"), "must select owner_member_id for delete gating");
  assert.equal(page.items[0].defaultAgentType, "claude");
  assert.equal(page.items[0].agentKind, null);
});

test("listTeamActors maps owner_member_id to agentOwnerMemberId", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    tableData: {
      actor_directory: [{
        id: "agent-1",
        team_id: "team-1",
        actor_type: "agent",
        user_id: null,
        invited_by_actor_id: null,
        display_name: "Bot",
        avatar_url: null,
        team_role: null,
        member_status: null,
        agent_status: "active",
        agent_types: ["claude"],
        default_agent_type: "claude",
        default_workspace_id: null,
        agent_visibility: "personal",
        owner_member_id: "member-1",
        last_active_at: null,
        created_at: "2026-05-27T01:00:00Z",
        updated_at: "2026-05-27T01:00:00Z",
      }],
    },
  }));

  const page = await repo.listTeamActors("team-1", { limit: 10 });
  assert.equal(page.items[0].agentOwnerMemberId, "member-1");
  assert.equal(page.items[0].visibility, "personal");
});

test("ensureAgentTypes updates the caller's own agent actor, not an arbitrary team agent", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    tableData: {
      actors: [{ id: "agent-self", user_id: "daemon-user-1", actor_type: "agent" }],
    },
    auth: {
      async getUser() {
        return { data: { user: { id: "daemon-user-1" } }, error: null };
      },
    },
  }));

  await repo.ensureAgentTypes({
    supportedTypes: ["claude", "opencode"],
    defaultAgentType: "opencode",
  });

  const actorUserEq = tableCalls.find(
    (c) => c.table === "actors" && c.op === "eq" && c.column === "user_id",
  );
  assert.equal(actorUserEq?.value, "daemon-user-1");
  assert.ok(
    !tableCalls.some((c) => c.table === "actors" && c.op === "limit"),
    "must not pick an arbitrary agent via limit(1)",
  );
  const updateEq = tableCalls.find((c) => c.table === "agents" && c.op === "update.eq");
  assert.equal(updateEq?.column, "id");
  assert.equal(updateEq?.value, "agent-self");
  const updateRow = tableCalls.find((c) => c.table === "agents" && c.op === "update");
  assert.deepEqual(updateRow?.row, {
    agent_types: ["claude", "opencode"],
    default_agent_type: "opencode",
  });
});

// --- Telemetry TDD tests ---

test("submitFeedback writes team_id, session_id, skill and no note column", async () => {
  let upsertRow = null;
  const repo = createRepo(fakeSupabase({
    onUpsert: (table, row) => { if (table === "actor_message_feedback") upsertRow = row; },
    upsertData: {
      message_id: "m1", actor_id: "a1", team_id: "t1", session_id: "s1",
      kind: "positive", star_rating: null, skill: null, created_at: "2026-05-29T00:00:00Z",
    },
  }));
  const out = await repo.submitFeedback({
    messageId: "m1", actorId: "a1", teamId: "t1", sessionId: "s1", kind: "positive", starRating: null, skill: null,
  });
  assert.equal(upsertRow.team_id, "t1");
  assert.equal(upsertRow.session_id, "s1");
  assert.equal(upsertRow.skill, null);
  assert.ok(!("note" in upsertRow), "must not write a non-existent note column");
  assert.equal(out.kind, "positive");
});

test("getTeamLeaderboard calls the team_leaderboard rpc with period and maps enriched rows", async () => {
  let rpcArgs = null;
  const repo = createRepo(fakeSupabase({
    onRpc: (fn, args) => { rpcArgs = { fn, args }; },
    rpcData: {
      team_leaderboard: [{
        team_id: "t1", actor_id: "a1", display_name: "Alice", period: "week",
        tokens_used: 1000, cost_usd: 0.25, positive_feedback: 3, negative_feedback: 1,
        session_count: 5, skill_usage: { "sentry-fix": 2 }, score: 1000,
      }],
    },
  }));
  const out = await repo.getTeamLeaderboard("t1", { period: "week" });
  assert.equal(rpcArgs.fn, "team_leaderboard");
  assert.deepEqual(rpcArgs.args, { p_team_id: "t1", p_period: "week" });
  assert.equal(out.items[0].tokensUsed, 1000);
  assert.equal(out.items[0].displayName, "Alice");
  assert.deepEqual(out.items[0].skillUsage, { "sentry-fix": 2 });
});

test("submitSessionReport inserts a report row and expands skillUsage into skill rows", async () => {
  const inserts = [];
  const repo = createRepo(fakeSupabase({
    onInsert: (table, rows) => inserts.push({ table, rows }),
  }));
  await repo.submitSessionReport({
    actorId: "a1", teamId: "t1", sessionId: "s1", tokensUsed: 10, costUsd: 0.1,
    model: "m", agentKind: "code", endedAt: "2026-05-29T00:00:00Z", skillUsage: { foo: 2, bar: 1 },
  });
  const report = inserts.find((i) => i.table === "actor_session_report");
  const skills = inserts.find((i) => i.table === "actor_skill_usage");
  assert.equal(report.rows.tokens_used, 10);
  assert.equal(report.rows.agent_kind, "code");
  assert.equal(skills.rows.length, 2);
  assert.deepEqual(skills.rows.map((r) => r.skill).sort(), ["bar", "foo"]);
});

// --- Gateway session contract (daemon round-trip) ---
//
// The amuxd daemon deserializes these two endpoints into structs with
// REQUIRED, camelCase fields:
//   POST /v1/sessions/gateway/ensure  → { sessionId, gatewaySessionId, created }
//       (apps/daemon/src/backend/cloud_api/mod.rs rpc_ensure_gateway_session,
//        gatewaySessionId is a required String)
//   GET  /v1/sessions/by-acp/:acpId   → { sessionId, gatewaySessionId? }
//       (get_gateway_session_by_acp_id; sessionId is a required String)
//
// The daemon uses ensure's `gatewaySessionId` as the logical ACP session id it
// later looks up via getSessionByAcp, which queries the `acp_session_id` column
// — so gatewaySessionId MUST equal the row's acp_session_id to round-trip. A
// WeCom inbound message hits ensure first; when this field was missing the
// daemon failed with "missing field gatewaySessionId" and dropped the message.

test("ensureGatewaySession returns gatewaySessionId (daemon-required field) = acp_session_id", async () => {
  const repo = createRepo(fakeSupabase({
    rpcData: {
      ensure_gateway_session: [{
        session_id: "sess-1",
        acp_session_id: "acp-hex-1",
        created: true,
      }],
    },
  }));

  const out = await repo.ensureGatewaySession({
    teamId: "team-1",
    binding: "wecom://bot/bot/single/u1",
    title: "WeCom chat",
    primaryAgentActorId: "actor-1",
    ownerMemberActorIds: [],
    participantActorIds: [],
  });

  assert.equal(out.sessionId, "sess-1");
  // The daemon deserializes this as a required String; it must round-trip to
  // acp_session_id so a later getSessionByAcp lookup finds the row.
  assert.equal(out.gatewaySessionId, "acp-hex-1");
  assert.equal(out.created, true);
});

test("getSessionByAcp returns the {sessionId, gatewaySessionId} shape the daemon deserializes", async () => {
  const repo = createRepo(fakeSupabase({
    tableData: {
      sessions: [{
        id: "sess-1",
        team_id: "team-1",
        title: "WeCom chat",
        mode: "collab",
        idea_id: null,
        primary_agent_id: "actor-1",
        created_by_actor_id: "actor-1",
        summary: null,
        last_message_preview: null,
        last_message_at: null,
        acp_session_id: "acp-hex-1",
        binding: "wecom://bot/bot/single/u1",
        created_at: "2026-06-04T00:00:00Z",
        updated_at: "2026-06-04T00:00:00Z",
      }],
    },
  }));

  const out = await repo.getSessionByAcp("acp-hex-1");

  // Daemon requires sessionId (mapped from the row id).
  assert.equal(out.sessionId, "sess-1");
  // Daemon uses gatewaySessionId as the chat binding for the per-session MCP
  // config so `send` defaults to the originating chat.
  assert.equal(out.gatewaySessionId, "wecom://bot/bot/single/u1");
});

// --- Agent defaults (daemon reads these to route gateway sessions) ---

test("listAgentDefaults selects + maps default_workspace_id alongside default_agent_type", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    tableData: {
      agents: [{
        id: "agent-1",
        agent_types: ["claude", "opencode"],
        default_agent_type: "opencode",
        default_workspace_id: "11111111-1111-1111-1111-111111111111",
      }],
    },
  }));

  const rows = await repo.listAgentDefaults(["agent-1"]);

  const selectCall = tableCalls.find((c) => c.table === "agents" && c.op === "select");
  assert.ok(selectCall, "expected an agents select");
  assert.ok(
    selectCall.columns.includes("default_workspace_id"),
    "must select default_workspace_id so the daemon can resolve the gateway cwd",
  );
  assert.equal(rows[0].id, "agent-1");
  assert.equal(rows[0].defaultAgentType, "opencode");
  assert.equal(rows[0].defaultWorkspaceId, "11111111-1111-1111-1111-111111111111");
});

// --- Apps domain (production passthrough) -----------------------------------
//
// The shared fakeSupabase mock cannot exercise multi-insert + update-returning
// chains used by createApp, so these tests use a small purpose-built stateful
// supabase double. It records calls and serves per-table rows for select /
// insert.select.single / update.select.single|maybeSingle.

function appsAuth(userId = "user-app-1") {
  return {
    async getUser() {
      return { data: { user: { id: userId } }, error: null };
    },
  };
}

// Stateful supabase double for apps tests. `seed` provides rows keyed by table.
// `actorRow` is what the actors lookup (resolveCurrentMemberActor) returns.
// Select filters (eq / is / in) are applied so workspace upsert dedup lookups
// can find seeded rows the same way PostgREST would.
function appsSupabase({ seed = {}, actorRow = { id: "actor-app-1" }, calls = [] }: any = {}) {
  const state: any = {
    apps: [...(seed.apps ?? [])],
    workspaces: [...(seed.workspaces ?? [])],
    sessions: [...(seed.sessions ?? [])],
    app_member_access: [...(seed.app_member_access ?? [])],
    // resolveTeamOrgId reads this; unseeded it yields no row, i.e. "team has
    // no org", which is what most apps tests want.
    teams: [...(seed.teams ?? [])],
  };
  return {
    auth: appsAuth(),
    from(table: string) {
      const ctx: any = { table, op: null, filters: {}, isFilters: {}, inFilters: {}, limitCount: null };
      const matchRows = () => {
        let rows = [...(state[table] ?? [])];
        for (const [col, val] of Object.entries(ctx.filters)) {
          rows = rows.filter((r) => r[col as string] === val);
        }
        for (const [col, val] of Object.entries(ctx.isFilters)) {
          rows = rows.filter((r) => (val === null ? r[col as string] == null : r[col as string] === val));
        }
        for (const [col, vals] of Object.entries(ctx.inFilters)) {
          rows = rows.filter((r) => (vals as any[]).includes(r[col as string]));
        }
        if (typeof ctx.limitCount === "number") rows = rows.slice(0, ctx.limitCount);
        return rows;
      };
      const builder: any = {
        select(columns: string) {
          calls.push({ table, op: ctx.op ? `${ctx.op}.select` : "select", columns });
          return builder;
        },
        insert(row: any) {
          ctx.op = "insert";
          calls.push({ table, op: "insert", row });
          // mutate state so the inserted row is what subsequent .single() returns
          const inserted = { ...row, id: row.id ?? `${table}-id-1` };
          state[table] = [inserted];
          ctx.inserted = inserted;
          return builder;
        },
        update(row: any) {
          ctx.op = "update";
          calls.push({ table, op: "update", row });
          ctx.update = row;
          return builder;
        },
        upsert(row: any, options?: any) {
          ctx.op = "upsert";
          calls.push({ table, op: "upsert", row, options });
          const upserted = { ...row, id: row.id ?? `${table}-id-${(state[table]?.length ?? 0) + 1}` };
          if (!upserted.created_at) upserted.created_at = new Date().toISOString();
          if (!upserted.updated_at) upserted.updated_at = new Date().toISOString();
          if (!state[table]) state[table] = [];
          let idx = -1;
          if (table === "app_member_access" && options?.onConflict === "app_id,member_id") {
            idx = state[table].findIndex(
              (r: any) => r.app_id === upserted.app_id && r.member_id === upserted.member_id,
            );
          } else {
            idx = state[table].findIndex((r: any) => r.id === upserted.id);
          }
          if (idx >= 0) state[table][idx] = { ...state[table][idx], ...upserted };
          else state[table].push(upserted);
          ctx.inserted = state[table].find(
            (r: any) => (table === "app_member_access" && options?.onConflict === "app_id,member_id")
              ? r.app_id === upserted.app_id && r.member_id === upserted.member_id
              : r.id === upserted.id,
          );
          return builder;
        },
        delete() {
          ctx.op = "delete";
          calls.push({ table, op: "delete" });
          return builder;
        },
        eq(column: string, value: any) {
          ctx.filters[column] = value;
          calls.push({ table, op: `${ctx.op ?? "select"}.eq`, column, value });
          return builder;
        },
        is(column: string, value: any) {
          ctx.isFilters[column] = value;
          calls.push({ table, op: `${ctx.op ?? "select"}.is`, column, value });
          return builder;
        },
        in(column: string, values: any[]) {
          ctx.inFilters[column] = values;
          calls.push({ table, op: `${ctx.op ?? "select"}.in`, column, values });
          return builder;
        },
        order() { return builder; },
        // Chainable like supabase-js: limit() returns the (thenable) builder so
        // a trailing .maybeSingle()/.single() still works; awaiting it yields the
        // table rows (used by listApps / workspace dedup lookups).
        limit(count: number) {
          ctx.limitCount = count;
          return builder;
        },
        single() {
          if (ctx.op === "insert" || ctx.op === "upsert") return Promise.resolve({ data: ctx.inserted, error: null });
          if (ctx.op === "update") {
            const matched = matchRows();
            const base = matched[0] ?? state[table]?.[0] ?? {};
            const merged = { ...base, ...ctx.update };
            if (base?.id) {
              const idx = state[table].findIndex((r: any) => r.id === base.id);
              if (idx >= 0) state[table][idx] = merged;
              else state[table] = [merged];
            } else {
              state[table] = [merged];
            }
            return Promise.resolve({ data: merged, error: null });
          }
          // plain select: actors lookup returns the actor row
          if (table === "actors") return Promise.resolve({ data: actorRow, error: null });
          return Promise.resolve({ data: matchRows()[0] ?? null, error: null });
        },
        maybeSingle() {
          if (table === "actors") return Promise.resolve({ data: actorRow, error: null });
          if (ctx.op === "delete") {
            const matched = matchRows();
            state[table] = (state[table] ?? []).filter((r: any) => !matched.includes(r));
            return Promise.resolve({ data: null, error: null });
          }
          if (ctx.op === "update") {
            const matched = matchRows();
            const base = matched[0];
            if (!base) return Promise.resolve({ data: null, error: null });
            const merged = { ...base, ...ctx.update };
            const idx = state[table].findIndex((r: any) => r.id === base.id);
            if (idx >= 0) state[table][idx] = merged;
            return Promise.resolve({ data: merged, error: null });
          }
          return Promise.resolve({ data: matchRows()[0] ?? null, error: null });
        },
        then(resolve: any, reject: any) {
          return Promise.resolve({ data: matchRows(), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    async rpc() { return { data: [], error: null }; },
  };
}

function fakeGitea(over: Record<string, unknown> = {}) {
  return {
    createAppRepo: async (appId: string) => ({
      cloneUrl: `https://gitea.example/teamclaw-apps/tc-app-${appId}.git`,
      sshUrl: `git@gitea.example:teamclaw-apps/tc-app-${appId}.git`,
    }),
    createDeployKey: async () => ({ id: 1 }),
    listDeployKeys: async () => [],
    deleteDeployKey: async () => {},
    archiveAndRenameAppRepo: async (appId: string) => ({
      sshUrl: `git@gitea.example:teamclaw-apps/deleted-tc-app-${appId}.git`,
    }),
    getRepoHead: async () => ({ sha: "abc123" }),
    ...over,
  };
}

function appsRepo(supabase: any, extra: any = {}) {
  return createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    createClient: () => supabase,
    gitea: fakeGitea(),
    ...extra,
  });
}

const APP_ROW = {
  id: "app-1",
  team_id: "team-1",
  created_by_actor_id: "actor-app-1",
  name: "My App",
  slug: "my-app",
  type: "fullstack_tanstack_postgres",
  visibility: "team",
  workspace_id: "ws-1",
  git_remote_url: null,
  git_commit_sha: null,
  runtime: "node",
  auth_mode: "none",
  oauth_client_id: null,
  provision_status: "pending",
  fc_status: null,
  created_at: "2026-06-13T00:00:00Z",
  updated_at: "2026-06-13T00:00:00Z",
};

const GITEA_MANAGED_APP = {
  ...APP_ROW,
  created_by_actor_id: "actor-app-1",
  provision_status: "ready",
  git_remote_url: "git@gitea.example:teamclaw-apps/tc-app-app-1.git",
  git_auth_kind: "gitea_deploy_key",
};

test("apps: mapApp exposes exactly the canonical keys", async () => {
  const repo = appsRepo(appsSupabase({ seed: { apps: [APP_ROW] } }));
  const items = await repo.listApps({ teamId: "team-1", limit: 100 });
  assert.equal(items.length, 1);
  assert.deepEqual(Object.keys(items[0]).sort(), [
    "authMode", "authModePendingRedeploy", "createdAt", "fcStatus", "fcEndpoint",
    "fcFunctionName", "fcRegion",
    "gitAuthKind", "gitCommitSha", "gitRemoteUrl", "id", "name", "oauthClientId",
    "provisionStatus", "publicUrl",
    "runtime", "slug", "teamId", "type", "updatedAt", "visibility", "workspaceId",
  ].sort());
  assert.equal(items[0].authMode, "none");
  assert.equal(items[0].runtime, "node");
  assert.equal(items[0].gitCommitSha, null);
  assert.equal(items[0].oauthClientId, null);
  // Null unless the deployment sets an apps domain — this suite sets none.
  assert.equal(items[0].publicUrl, null);
  assert.equal(items[0].teamId, "team-1");
  assert.equal(items[0].workspaceId, "ws-1");
  assert.equal(items[0].provisionStatus, "pending");
});

test("apps: authModePendingRedeploy is derived from the deployed mode", async () => {
  // Changing authMode does nothing to the running function until the next
  // deploy (the OAuth env is injected at finalize), so the row has to say so —
  // design §7.4 treats a silent one as a security expectation failure.
  const live = { ...APP_ROW, fc_status: "live", auth_mode: "platform" };

  const pending = appsRepo(appsSupabase({ seed: { apps: [{ ...live, deployed_auth_mode: "none" }] } }));
  assert.equal((await pending.listApps({ teamId: "team-1" }))[0].authModePendingRedeploy, true);

  const settled = appsRepo(appsSupabase({ seed: { apps: [{ ...live, deployed_auth_mode: "platform" }] } }));
  assert.equal((await settled.listApps({ teamId: "team-1" }))[0].authModePendingRedeploy, false);

  // Never deployed → nothing is live to be out of date with.
  const notLive = appsRepo(appsSupabase({ seed: { apps: [{ ...APP_ROW, auth_mode: "platform" }] } }));
  assert.equal((await notLive.listApps({ teamId: "team-1" }))[0].authModePendingRedeploy, false);

  // A live row from before the column exists must not light the warning up.
  const legacy = appsRepo(appsSupabase({ seed: { apps: [{ ...live, deployed_auth_mode: null }] } }));
  assert.equal((await legacy.listApps({ teamId: "team-1" }))[0].authModePendingRedeploy, false);
});

test("apps: listApps filters by team_id, orders created_at desc, limits", async () => {
  const calls: any[] = [];
  const repo = appsRepo(appsSupabase({ seed: { apps: [APP_ROW] }, calls }));
  await repo.listApps({ teamId: "team-7", limit: 25 });
  const teamEq = calls.find((c) => c.table === "apps" && c.column === "team_id");
  assert.equal(teamEq?.value, "team-7");
});

test("apps: getApp returns null when RLS hides the row", async () => {
  const repo = appsRepo(appsSupabase({ seed: { apps: [] } }));
  assert.equal(await repo.getApp("missing"), null);
});

test("apps: getAppMembership returns member true for team member", async () => {
  const admin = appsSupabase({ seed: { apps: [APP_ROW] } });
  const repo = appsRepo(appsSupabase({ seed: { apps: [] } }), {
    createServiceRoleClient: () => admin,
  });
  assert.deepEqual(await repo.getAppMembership("app-1"), { member: true });
});

test("apps: getAppMembership returns member false for authenticated outsider", async () => {
  const admin = appsSupabase({ seed: { apps: [APP_ROW] } });
  const repo = appsRepo(appsSupabase({ seed: { apps: [] }, actorRow: null }), {
    createServiceRoleClient: () => admin,
  });
  assert.deepEqual(await repo.getAppMembership("app-1"), { member: false });
});

test("apps: getAppMembership returns null when app is missing", async () => {
  const admin = appsSupabase({ seed: { apps: [] } });
  const repo = appsRepo(appsSupabase({ seed: { apps: [] } }), {
    createServiceRoleClient: () => admin,
  });
  assert.equal(await repo.getAppMembership("missing"), null);
});

test("apps: listAppAccess returns rows for creator", async () => {
  const accessRows = [{
    app_id: "app-1",
    member_id: "member-2",
    permission_level: "prompt",
    granted_by_member_id: "actor-app-1",
    created_at: "2026-08-27T00:00:00.000Z",
  }];
  const admin = appsSupabase({ seed: { apps: [APP_ROW], app_member_access: accessRows } });
  const repo = appsRepo(appsSupabase({ seed: { apps: [APP_ROW] } }), {
    createServiceRoleClient: () => admin,
  });
  const items = await repo.listAppAccess("app-1");
  assert.deepEqual(items, [{
    memberId: "member-2",
    permissionLevel: "prompt",
    grantedByMemberId: "actor-app-1",
    createdAt: "2026-08-27T00:00:00.000Z",
  }]);
});

test("apps: listAppAccess returns null for non-creator without admin", async () => {
  const otherActor = { id: "actor-other" };
  const admin = appsSupabase({ seed: { apps: [APP_ROW] } });
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [APP_ROW] }, actorRow: otherActor }),
    { createServiceRoleClient: () => admin },
  );
  assert.equal(await repo.listAppAccess("app-1"), null);
});

test("apps: listAppAccess returns null when app is not visible", async () => {
  const admin = appsSupabase({ seed: { apps: [] } });
  const repo = appsRepo(appsSupabase({ seed: { apps: [] } }), {
    createServiceRoleClient: () => admin,
  });
  assert.equal(await repo.listAppAccess("missing"), null);
});

test("apps: setAppAccess upserts for creator", async () => {
  const calls: any[] = [];
  const admin = appsSupabase({ seed: { apps: [APP_ROW] }, calls });
  const repo = appsRepo(appsSupabase({ seed: { apps: [APP_ROW] }, calls }), {
    createServiceRoleClient: () => admin,
  });
  const row = await repo.setAppAccess("app-1", "member-2", "admin");
  assert.equal(row?.memberId, "member-2");
  assert.equal(row?.permissionLevel, "admin");
  assert.equal(row?.grantedByMemberId, "actor-app-1");
  const upsert = calls.find((c) => c.table === "app_member_access" && c.op === "upsert");
  assert.equal(upsert?.row.app_id, "app-1");
  assert.equal(upsert?.row.member_id, "member-2");
  assert.equal(upsert?.row.permission_level, "admin");
  assert.equal(upsert?.row.granted_by_member_id, "actor-app-1");
});

test("apps: setAppAccess returns null for non-creator without admin", async () => {
  const admin = appsSupabase({ seed: { apps: [APP_ROW] } });
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [APP_ROW] }, actorRow: { id: "actor-other" } }),
    { createServiceRoleClient: () => admin },
  );
  assert.equal(await repo.setAppAccess("app-1", "member-2", "prompt"), null);
});

test("apps: setAppAccess allows admin member who is not creator", async () => {
  const adminMember = { id: "admin-member" };
  const accessRows = [{
    app_id: "app-1",
    member_id: "admin-member",
    permission_level: "admin",
    granted_by_member_id: "actor-app-1",
    created_at: "2026-08-27T00:00:00.000Z",
  }];
  const admin = appsSupabase({ seed: { apps: [APP_ROW], app_member_access: accessRows } });
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [APP_ROW], app_member_access: accessRows }, actorRow: adminMember }),
    { createServiceRoleClient: () => admin },
  );
  const row = await repo.setAppAccess("app-1", "member-2", "view");
  assert.equal(row?.permissionLevel, "view");
  assert.equal(row?.grantedByMemberId, "admin-member");
});

test("apps: setAppAccess rejects invalid permissionLevel", async () => {
  const admin = appsSupabase({ seed: { apps: [APP_ROW] } });
  const repo = appsRepo(appsSupabase({ seed: { apps: [APP_ROW] } }), {
    createServiceRoleClient: () => admin,
  });
  await assert.rejects(
    () => repo.setAppAccess("app-1", "member-2", "superuser"),
    (e: any) => e?.statusCode === 400,
  );
});

test("apps: removeAppAccess deletes row for creator", async () => {
  const accessRows = [{
    id: "access-1",
    app_id: "app-1",
    member_id: "member-2",
    permission_level: "prompt",
    granted_by_member_id: "actor-app-1",
    created_at: "2026-08-27T00:00:00.000Z",
  }];
  const calls: any[] = [];
  const admin = appsSupabase({ seed: { apps: [APP_ROW], app_member_access: [...accessRows] }, calls });
  const repo = appsRepo(appsSupabase({ seed: { apps: [APP_ROW] } }), {
    createServiceRoleClient: () => admin,
  });
  assert.equal(await repo.removeAppAccess("app-1", "member-2"), true);
  const del = calls.find((c) => c.table === "app_member_access" && c.op === "delete");
  assert.ok(del);
});

test("apps: removeAppAccess returns null for non-creator without admin", async () => {
  const admin = appsSupabase({ seed: { apps: [APP_ROW] } });
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [APP_ROW] }, actorRow: { id: "actor-other" } }),
    { createServiceRoleClient: () => admin },
  );
  assert.equal(await repo.removeAppAccess("app-1", "member-2"), null);
});

test("apps: removeAppAccess revokes Gitea deploy keys for the member", async () => {
  const now = 1_700_000_000_000;
  const memberId = "member-2";
  const accessRows = [{
    id: "access-1",
    app_id: "app-1",
    member_id: memberId,
    permission_level: "prompt",
    granted_by_member_id: "actor-app-1",
    created_at: "2026-08-27T00:00:00.000Z",
  }];
  const deleted: number[] = [];
  const gitea = fakeGitea({
    listDeployKeys: async () => [
      { id: 10, title: `jit-${memberId}-${now}-aaaa` },
      { id: 11, title: `jit-other-${now}-bbbb` },
    ],
    deleteDeployKey: async (_appId: string, id: number) => { deleted.push(id); },
  });
  const admin = appsSupabase({ seed: { apps: [GITEA_MANAGED_APP], app_member_access: [...accessRows] } });
  const repo = appsRepo(appsSupabase({ seed: { apps: [GITEA_MANAGED_APP] } }), {
    createServiceRoleClient: () => admin,
    gitea,
  });
  assert.equal(await repo.removeAppAccess("app-1", memberId), true);
  assert.deepEqual(deleted, [10]);
});

test("apps: setAppAccess downgrade to view revokes Gitea deploy keys", async () => {
  const now = 1_700_000_000_000;
  const memberId = "member-2";
  const accessRows = [{
    app_id: "app-1",
    member_id: memberId,
    permission_level: "prompt",
    granted_by_member_id: "actor-app-1",
    created_at: "2026-08-27T00:00:00.000Z",
  }];
  const deleted: number[] = [];
  const gitea = fakeGitea({
    listDeployKeys: async () => [
      { id: 20, title: `jit-${memberId}-${now}-aaaa` },
      { id: 21, title: `jit-${memberId}-${now + 1}-bbbb` },
    ],
    deleteDeployKey: async (_appId: string, id: number) => { deleted.push(id); },
  });
  const admin = appsSupabase({ seed: { apps: [GITEA_MANAGED_APP], app_member_access: accessRows } });
  const repo = appsRepo(appsSupabase({ seed: { apps: [GITEA_MANAGED_APP] } }), {
    createServiceRoleClient: () => admin,
    gitea,
  });
  const row = await repo.setAppAccess("app-1", memberId, "view");
  assert.equal(row?.permissionLevel, "view");
  assert.deepEqual(deleted.sort(), [20, 21]);
});

test("apps: setAppAccess prompt to admin does not revoke deploy keys", async () => {
  const memberId = "member-2";
  const accessRows = [{
    app_id: "app-1",
    member_id: memberId,
    permission_level: "prompt",
    granted_by_member_id: "actor-app-1",
    created_at: "2026-08-27T00:00:00.000Z",
  }];
  let listCalled = false;
  const gitea = fakeGitea({
    listDeployKeys: async () => { listCalled = true; return []; },
  });
  const admin = appsSupabase({ seed: { apps: [GITEA_MANAGED_APP], app_member_access: accessRows } });
  const repo = appsRepo(appsSupabase({ seed: { apps: [GITEA_MANAGED_APP] } }), {
    createServiceRoleClient: () => admin,
    gitea,
  });
  await repo.setAppAccess("app-1", memberId, "admin");
  assert.equal(listCalled, false);
});

test("apps: deauth skips deploy key revoke for non-Gitea apps", async () => {
  const memberId = "member-2";
  const imported = {
    ...APP_ROW,
    git_remote_url: "https://github.com/owner/repo.git",
    git_auth_kind: null,
  };
  let listCalled = false;
  const gitea = fakeGitea({
    listDeployKeys: async () => { listCalled = true; return []; },
  });
  const admin = appsSupabase({ seed: { apps: [imported] } });
  const repo = appsRepo(appsSupabase({ seed: { apps: [imported] } }), {
    createServiceRoleClient: () => admin,
    gitea,
  });
  await repo.removeAppAccess("app-1", memberId);
  assert.equal(listCalled, false);
});

test("apps: createApp inserts workspace + app and resolves caller actor", async () => {
  const calls: any[] = [];
  const repo = appsRepo(appsSupabase({ calls, actorRow: { id: "actor-app-1" } }));
  const app = await repo.createApp({
    teamId: "team-1",
    name: "My App",
    type: "fullstack_tanstack_postgres",
    visibility: "team",
  });
  // workspace insert carries the resolved actor as created_by_member_id
  const wsInsert = calls.find((c) => c.table === "workspaces" && c.op === "insert");
  assert.equal(wsInsert?.row.created_by_member_id, "actor-app-1");
  assert.equal(wsInsert?.row.team_id, "team-1");
  // app insert carries created_by_actor_id = resolved actor + provision pending
  const appInsert = calls.find((c) => c.table === "apps" && c.op === "insert");
  assert.equal(appInsert?.row.created_by_actor_id, "actor-app-1");
  assert.equal(appInsert?.row.provision_status, "pending");
  assert.equal(appInsert?.row.slug, "my-app");
  assert.equal(appInsert?.row.visibility, "team");
  // Gitea provisioning updates the row after insert
  assert.equal(app.provisionStatus, "repo_created");
  assert.match(app.gitRemoteUrl ?? "", /tc-app-/);
  assert.equal(app.teamId, "team-1");
  const appUpdate = calls.find((c) => c.table === "apps" && c.op === "update");
  assert.equal(appUpdate?.row.git_auth_kind, "gitea_deploy_key");
  assert.equal(appUpdate?.row.provision_status, "repo_created");
});

test("apps: createApp without Gitea configured throws gitea_unavailable before insert", async () => {
  const calls: any[] = [];
  const repo = appsRepo(appsSupabase({ calls }), {
    gitea: undefined,
    giteaUnavailableReason: "GITEA_URL is empty",
  });
  await assert.rejects(
    () => repo.createApp({ teamId: "team-1", name: "NoGitea", type: "static_web" }),
    (err: any) => err?.code === "gitea_unavailable" && err?.statusCode === 503,
  );
  const appInsert = calls.find((c) => c.table === "apps" && c.op === "insert");
  assert.equal(appInsert, undefined, "no orphan app row when Gitea is unavailable");
});

test("apps: createApp marks the row error when Gitea provisioning fails", async () => {
  const calls: any[] = [];
  const repo = appsRepo(appsSupabase({ calls }), {
    gitea: fakeGitea({
      createAppRepo: async () => {
        throw new Error("gitea down");
      },
    }),
  });
  await assert.rejects(
    () => repo.createApp({ teamId: "team-1", name: "Fail", type: "static_web" }),
    (err: any) => err?.code === "gitea_provision_failed" && err?.statusCode === 502,
  );
  const errUpdate = calls.find(
    (c) => c.table === "apps" && c.op === "update" && c.row.provision_status === "error",
  );
  assert.ok(errUpdate, "expected error update");
  assert.match(errUpdate.row.provision_error, /gitea down/);
});

test("apps: a non-creator's authMode change destroys nothing before the 404", async () => {
  // apps_select_if_visible lets any teammate READ a team-visible app, while
  // apps_update_if_creator gates the write. Running applyAuthModeChange first
  // meant a teammate's PATCH deleted the live app's GoTrue client (a hard
  // DELETE) and its sealed secret with a service-role client, and only then
  // matched zero rows and answered 404.
  const disabled: string[] = [];
  const admin = appsSupabase({ seed: { apps: [] } });
  const repo = appsRepo(
    appsSupabase({
      seed: {
        apps: [
          {
            ...APP_ROW,
            auth_mode: "platform",
            oauth_client_id: "cid",
            created_by_actor_id: "someone-else",
          },
        ],
      },
      // The caller has an actor in the team — just not the app's creator.
      actorRow: { id: "actor-app-1" },
    }),
    {
      createServiceRoleClient: () => admin,
      gotrue: {
        createOAuthClient: async () => { throw new Error("must not be called"); },
        updateOAuthClient: async () => { throw new Error("must not be called"); },
        disableOAuthClient: async (id: string) => { disabled.push(id); },
      },
    },
  );

  assert.equal(await repo.updateApp("app-1", { authMode: "none" }), null);
  assert.deepEqual(disabled, [], "the OAuth client must survive a 404'd PATCH");
});

test("apps: deleteApp tears down resources, archives workspace, and removes the row", async () => {
  const deletedKeys: number[] = [];
  const fcDeleted: string[] = [];
  const ossDeleted: string[] = [];
  const oauthDisabled: string[] = [];
  let archivedRepo = false;
  const calls: any[] = [];
  const admin = appsSupabase({
    calls,
    seed: {
      apps: [{
        ...GITEA_MANAGED_APP,
        workspace_id: "ws-1",
        fc_function_name: "tc-app-app-1",
        fc_status: "live",
        auth_mode: "platform",
        oauth_client_id: "oauth-cid",
      }],
      workspaces: [{ id: "ws-1", team_id: "team-1", name: "app-ws", path: null, archived: false }],
    },
  });
  const repo = appsRepo(admin, {
    createServiceRoleClient: () => admin,
    gitea: fakeGitea({
      listDeployKeys: async () => [{ id: 9, title: "jit-x" }],
      deleteDeployKey: async (_appId: string, id: number) => { deletedKeys.push(id); },
      archiveAndRenameAppRepo: async () => {
        archivedRepo = true;
        return { sshUrl: "git@gitea.example:teamclaw-apps/deleted-tc-app-app-1.git" };
      },
    }),
    gotrue: {
      disableOAuthClient: async (id: string) => { oauthDisabled.push(id); },
    },
    teardownDeps: {
      fcOps: {
        deleteHttpTrigger: async (name: string) => { fcDeleted.push(`trigger:${name}`); },
        deleteFunction: async (name: string) => { fcDeleted.push(`fn:${name}`); },
      },
      deleteOssObject: async (key: string) => { ossDeleted.push(key); },
    },
  });
  assert.equal(await repo.deleteApp("app-1"), true);
  assert.deepEqual(deletedKeys, [9]);
  assert.ok(archivedRepo);
  assert.deepEqual(oauthDisabled, ["oauth-cid"]);
  assert.ok(fcDeleted.includes("fn:tc-app-app-1"));
  assert.deepEqual(ossDeleted, ["apps/app-1/code.zip"]);
  const wsUpdate = calls.find((c) => c.table === "workspaces" && c.op === "update");
  assert.equal(wsUpdate?.row.archived, true);
  assert.equal(wsUpdate?.row.path, "git@gitea.example:teamclaw-apps/deleted-tc-app-app-1.git");
  const appDelete = calls.find((c) => c.table === "apps" && c.op === "delete");
  assert.ok(appDelete);
});

test("apps: deleteApp returns false for view permission", async () => {
  const repo = appAccessRepo("view");
  assert.equal(await repo.deleteApp("app-1"), false);
});

test("apps: git-credential and git-head are null for an imported app", async () => {
  // An imported app has no tc-app-<id> repo on Gitea; asking for one 404s, and
  // routing deploy through Gitea unconditionally made these apps undeployable.
  const gitea = fakeGitea({
    createDeployKey: async () => { throw new Error("must not be called"); },
    getRepoHead: async () => { throw new Error("must not be called"); },
  });
  const imported = {
    ...APP_ROW,
    created_by_actor_id: "actor-app-1",
    git_remote_url: "https://github.com/owner/repo.git",
    git_auth_kind: null,
  };
  const repo = appsRepo(appsSupabase({ seed: { apps: [imported] } }), { gitea });
  assert.equal(await repo.getAppGitCredential("app-1"), null);
  assert.equal(await repo.getAppGitHead("app-1"), null);
});

test("apps: a Gitea-managed app gets an OpenSSH credential and its repo head", async () => {
  const managed = {
    ...APP_ROW,
    created_by_actor_id: "actor-app-1",
    git_remote_url: "git@gitea.example:teamclaw-apps/tc-app-app-1.git",
    git_auth_kind: "gitea_deploy_key",
  };
  const repo = appsRepo(appsSupabase({ seed: { apps: [managed] } }));
  const cred = await repo.getAppGitCredential("app-1");
  assert.equal(cred?.remoteUrl, managed.git_remote_url);
  assert.match(cred!.privateKeyPem, /BEGIN OPENSSH PRIVATE KEY/);
  assert.deepEqual(await repo.getAppGitHead("app-1"), { sha: "abc123" });
});

function appAccessRepo(permissionLevel: string, actorId = "member-other", extra: Record<string, unknown> = {}) {
  const accessRows = [{
    app_id: "app-1",
    member_id: actorId,
    permission_level: permissionLevel,
    granted_by_member_id: "actor-app-1",
    created_at: "2026-08-27T00:00:00.000Z",
  }];
  return appsRepo(
    appsSupabase({ seed: { apps: [GITEA_MANAGED_APP], app_member_access: accessRows }, actorRow: { id: actorId } }),
    extra,
  );
}

test("apps: getAppGitCredential returns null for view permission", async () => {
  const gitea = fakeGitea({
    createDeployKey: async () => { throw new Error("must not be called"); },
  });
  const repo = appAccessRepo("view");
  assert.equal(await repo.getAppGitCredential("app-1"), null);
});

test("apps: getAppGitCredential mints a write deploy key for prompt permission", async () => {
  let deployKeyCalled = false;
  const gitea = fakeGitea({
    createDeployKey: async () => { deployKeyCalled = true; return { id: 1 }; },
  });
  const accessRows = [{
    app_id: "app-1",
    member_id: "member-other",
    permission_level: "prompt",
    granted_by_member_id: "actor-app-1",
    created_at: "2026-08-27T00:00:00.000Z",
  }];
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [GITEA_MANAGED_APP], app_member_access: accessRows }, actorRow: { id: "member-other" } }),
    { gitea },
  );
  const cred = await repo.getAppGitCredential("app-1");
  assert.ok(deployKeyCalled, "prompt grant must register a write deploy key");
  assert.equal(cred?.remoteUrl, GITEA_MANAGED_APP.git_remote_url);
  assert.match(cred!.privateKeyPem, /BEGIN OPENSSH PRIVATE KEY/);
});

test("apps: getAppGitCredential mints a deploy key for admin permission", async () => {
  let deployKeyCalled = false;
  const gitea = fakeGitea({
    createDeployKey: async () => { deployKeyCalled = true; return { id: 2 }; },
  });
  const repo = appAccessRepo("admin", "member-other", { gitea });
  const cred = await repo.getAppGitCredential("app-1");
  assert.ok(deployKeyCalled, "admin grant must register a deploy key");
  assert.equal(cred?.remoteUrl, GITEA_MANAGED_APP.git_remote_url);
  assert.match(cred!.privateKeyPem, /BEGIN OPENSSH PRIVATE KEY/);
});

test("apps: createApp inserts a pending app when importing an external repo", async () => {
  // External import skips Gitea — the desktop seeds from the supplied remote.
  const repo = appsRepo(appsSupabase({}));
  const app = await repo.createApp({
    teamId: "team-1",
    name: "My App",
    type: "slides",
    visibility: "personal",
    gitRemoteUrl: "https://github.com/owner/repo.git",
  });
  assert.equal(app.provisionStatus, "pending");
});

test("apps: updateApp returns null when no row updated (RLS non-creator)", async () => {
  const repo = appsRepo(appsSupabase({ seed: { apps: [] } }));
  const result = await repo.updateApp("app-1", { name: "New" });
  assert.equal(result, null);
});

test("apps: updateApp maps the updated row", async () => {
  const repo = appsRepo(appsSupabase({ seed: { apps: [APP_ROW] } }));
  const result = await repo.updateApp("app-1", { name: "Renamed", visibility: "personal" });
  assert.equal(result?.name, "Renamed");
  assert.equal(result?.visibility, "personal");
});

test("apps: updateApp advances provisionStatus through a legal transition", async () => {
  const repo = appsRepo(appsSupabase({
    seed: { apps: [{ ...APP_ROW, provision_status: "repo_created" }] },
  }));
  const result = await repo.updateApp("app-1", { provisionStatus: "seeding" });
  assert.equal(result?.provisionStatus, "seeding");
});

test("apps: updateApp rejects an illegal provisionStatus jump", async () => {
  const repo = appsRepo(appsSupabase({
    seed: { apps: [{ ...APP_ROW, provision_status: "pending" }] },
  }));
  // pending -> ready is the normal seed writeback; putting a row BACK into a
  // provisioning state is what clients may never do.
  await assert.rejects(
    () => repo.updateApp("app-1", { provisionStatus: "repo_created" }),
    (err: any) => err?.code === "invalid_status_transition" && err?.statusCode === 400,
  );
});

const APP_SHA = "abc1234";
const APP_DEPLOY = { gitCommitSha: APP_SHA };

test("apps: deployApp method is present", async () => {
  const repo = appsRepo(appsSupabase({}));
  assert.equal(typeof repo.deployApp, "function");
});

test("apps: deployApp returns null when RLS hides the app", async () => {
  const repo = appsRepo(appsSupabase({ seed: { apps: [] } }), {
    startDeploy: async () => { throw new Error("should not be called"); },
  });
  assert.equal(await repo.deployApp("app-1", APP_DEPLOY), null);
});

test("apps: deployApp rejects 409 when app not ready", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, provision_status: "seeding" }] } }),
    { startDeploy: async () => { throw new Error("should not be called"); } },
  );
  await assert.rejects(
    () => repo.deployApp("app-1", APP_DEPLOY),
    (err: any) => err?.code === "app_not_ready" && err?.statusCode === 409,
  );
});

test("apps: deployApp rejects 503 when startDeploy dep missing", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, provision_status: "ready" }] } }),
  );
  await assert.rejects(
    () => repo.deployApp("app-1", APP_DEPLOY),
    (err: any) => err?.code === "deploy_unavailable" && err?.statusCode === 503,
  );
});

test("apps: the 503 names the missing configuration when one is given", async () => {
  // Without this the user's toast — and apps.provision_error — read only
  // "deploy provisioning not configured", which named none of the five
  // variables that can cause it and took an SSH session to decode.
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, provision_status: "ready" }] } }),
    { deployUnavailableReason: "APPS_ACCESS_KEY_ID is set but APPS_OSS_BUCKET is empty" },
  );
  await assert.rejects(
    () => repo.deployApp("app-1", APP_DEPLOY),
    (err: any) =>
      err?.code === "deploy_unavailable" &&
      err?.statusCode === 503 &&
      /APPS_OSS_BUCKET/.test(err?.message ?? ""),
  );
});

test("apps: deployApp returns null for prompt member", async () => {
  const repo = appAccessRepo("prompt", "prompt-member");
  assert.equal(await repo.deployApp("app-1", APP_DEPLOY), null);
});

test("apps: deployApp succeeds for admin member who is not creator", async () => {
  const repo = appAccessRepo("admin", "admin-member", {
    startDeploy: async ({ appId }: any) => {
      assert.equal(appId, "app-1");
      return {
        fcFunctionName: "app-my-app",
        fcRegion: "cn-hangzhou",
        ossObjectName: "apps/app-1/build.zip",
        presignedPut: "https://oss/put?sig=x",
      };
    },
  });
  const result = await repo.deployApp("app-1", APP_DEPLOY);
  assert.equal(result?.fcStatus, "awaiting_build");
  assert.equal(result?.ossObjectName, "apps/app-1/build.zip");
});

test("apps: deployApp on ready app returns awaiting_build + ossObjectName", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, provision_status: "ready" }] } }),
    {
      // startDeploy only mints the upload handle now — the schema (and hence
      // the slug) is provisioned at finalize, once the code object exists.
      startDeploy: async ({ appId }: any) => {
        assert.equal(appId, "app-1");
        return {
          fcFunctionName: "app-my-app",
          fcRegion: "cn-hangzhou",
          ossObjectName: "apps/app-1/build.zip",
          presignedPut: "https://oss/put?sig=x",
        };
      },
    },
  );
  const result = await repo.deployApp("app-1", APP_DEPLOY);
  assert.equal(result.fcStatus, "awaiting_build");
  assert.equal(result.fcFunctionName, "app-my-app");
  assert.equal(result.fcRegion, "cn-hangzhou");
  assert.equal(result.ossObjectName, "apps/app-1/build.zip");
  assert.equal(result.presignedPut, "https://oss/put?sig=x");
  assert.equal(result.gitCommitSha, APP_SHA);
  assert.match(result.deployToken, /^[0-9a-f-]{36}$/i);
});

test("apps: deployApp wraps startDeploy failure as 502", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, provision_status: "ready" }] } }),
    { startDeploy: async () => { throw new Error("fc boom"); } },
  );
  await assert.rejects(
    () => repo.deployApp("app-1", APP_DEPLOY),
    (err: any) => err?.code === "deploy_failed" && err?.statusCode === 502,
  );
});

test("apps: second deploy while awaiting_build returns 409", async () => {
  const sb = appsSupabase({ seed: { apps: [{ ...APP_ROW, provision_status: "ready" }] } });
  const repo = appsRepo(sb, {
    startDeploy: async () => ({
      fcFunctionName: "tc-app-1", fcRegion: "cn-hangzhou",
      ossObjectName: "apps/app-1/code.zip", presignedPut: "https://oss/put?sig=x",
    }),
  });
  await repo.deployApp("app-1", APP_DEPLOY);
  await assert.rejects(
    () => repo.deployApp("app-1", APP_DEPLOY),
    (err: any) => err?.code === "deploy_in_progress" && err?.statusCode === 409,
  );
});

test("apps: finalizeDeploy method is present", async () => {
  const repo = appsRepo(appsSupabase({}));
  assert.equal(typeof repo.finalizeDeploy, "function");
});

test("apps: finalizeDeploy returns null when RLS hides the app", async () => {
  const repo = appsRepo(appsSupabase({ seed: { apps: [] } }), {
    finalizeDeploy: async () => { throw new Error("should not be called"); },
  });
  assert.equal(await repo.finalizeDeploy("app-1", { gitCommitSha: APP_SHA, deployToken: "tok" }), null);
});

test("apps: finalizeDeploy rejects 409 when app has no function", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, fc_function_name: null, fc_status: null, deploy_token: "tok" }] } }),
    { finalizeDeploy: async () => { throw new Error("should not be called"); } },
  );
  await assert.rejects(
    () => repo.finalizeDeploy("app-1", { gitCommitSha: APP_SHA, deployToken: "tok" }),
    (err: any) => err?.code === "not_deploying" && err?.statusCode === 409,
  );
});

test("apps: finalizeDeploy rejects 409 on illegal fc_status transition", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, fc_function_name: "tc-app-1", fc_status: "live", deploy_token: "tok" }] } }),
    { finalizeDeploy: async () => { throw new Error("should not be called"); } },
  );
  await assert.rejects(
    () => repo.finalizeDeploy("app-1", { gitCommitSha: APP_SHA, deployToken: "tok" }),
    (err: any) => err?.code === "invalid_deploy_state" && err?.statusCode === 409,
  );
});

test("apps: finalizeDeploy rejects 409 when deployToken mismatches", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, fc_function_name: "tc-app-1", fc_status: "awaiting_build", deploy_token: "good" }] } }),
    { finalizeDeploy: async () => { throw new Error("should not be called"); } },
  );
  await assert.rejects(
    () => repo.finalizeDeploy("app-1", { gitCommitSha: APP_SHA, deployToken: "bad" }),
    (err: any) => err?.code === "deploy_token_mismatch" && err?.statusCode === 409,
  );
});

test("apps: finalizeDeploy rejects 503 when finalizeDeploy dep missing", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, fc_function_name: "tc-app-1", fc_status: "awaiting_build", deploy_token: "tok" }] } }),
  );
  await assert.rejects(
    () => repo.finalizeDeploy("app-1", { gitCommitSha: APP_SHA, deployToken: "tok" }),
    (err: any) => err?.code === "deploy_unavailable" && err?.statusCode === 503,
  );
});

test("apps: finalizeDeploy on awaiting_build app returns live + fcEndpoint", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, provision_status: "ready" }] } }),
    {
      startDeploy: async () => ({
        fcFunctionName: "tc-app-1", fcRegion: "cn-hangzhou",
        ossObjectName: "apps/app-1/code.zip", presignedPut: "https://oss/put?sig=x",
      }),
      finalizeDeploy: async ({ fcFunctionName, ossObjectName }: any) => {
        assert.equal(fcFunctionName, "tc-app-1");
        assert.equal(ossObjectName, "apps/app-1/code.zip");
        return { fcEndpoint: "https://x.fcapp.run" };
      },
    },
  );
  const started = await repo.deployApp("app-1", APP_DEPLOY);
  const result = await repo.finalizeDeploy("app-1", { gitCommitSha: APP_SHA, deployToken: started.deployToken });
  assert.equal(result.fcStatus, "live");
  assert.equal(result.fcEndpoint, "https://x.fcapp.run");
  assert.equal(result.gitCommitSha, APP_SHA);
});

test("apps: finalizeDeploy pins apps.org_id on the first success", async () => {
  const calls: any[] = [];
  const seen: any[] = [];
  const repo = appsRepo(
    appsSupabase({
      seed: { apps: [{ ...APP_ROW, provision_status: "ready" }], teams: [{ id: "team-1", oid: "org-old" }] },
      calls,
    }),
    {
      startDeploy: async () => ({
        fcFunctionName: "tc-app-1", fcRegion: "cn-hangzhou",
        ossObjectName: "apps/app-1/code.zip", presignedPut: "https://oss/put?sig=x",
      }),
      finalizeDeploy: async (input: any) => {
        seen.push(input);
        return { fcEndpoint: "https://x.fcapp.run" };
      },
    },
  );
  const started = await repo.deployApp("app-1", APP_DEPLOY);
  await repo.finalizeDeploy("app-1", { gitCommitSha: APP_SHA, deployToken: started.deployToken });

  assert.equal(seen[0].orgId, "org-old", "first finalize derives the org from the team");
  const upd = calls.filter((c) => c.table === "apps" && c.op === "update" && c.row?.fc_status === "live");
  assert.equal(upd.length, 1);
  assert.equal(upd[0].row.org_id, "org-old", "the derived org is written back to the row");
});

test("apps: finalizeDeploy deploys to the stored org even after teams.oid changes", async () => {
  // The whole point of the column. Re-deriving here would provision a fresh
  // empty schema in tc_org_<new> and take the app live with no data, while the
  // real data sits untouched in tc_org_<old>.
  const seen: any[] = [];
  const repo = appsRepo(
    appsSupabase({
      seed: {
        apps: [{ ...APP_ROW, provision_status: "ready", org_id: "org-old" }],
        teams: [{ id: "team-1", oid: "org-new" }],
      },
    }),
    {
      startDeploy: async () => ({
        fcFunctionName: "tc-app-1", fcRegion: "cn-hangzhou",
        ossObjectName: "apps/app-1/code.zip", presignedPut: "https://oss/put?sig=x",
      }),
      finalizeDeploy: async (input: any) => {
        seen.push(input);
        return { fcEndpoint: "https://x.fcapp.run" };
      },
    },
  );
  const started = await repo.deployApp("app-1", APP_DEPLOY);
  await repo.finalizeDeploy("app-1", { gitCommitSha: APP_SHA, deployToken: started.deployToken });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].orgId, "org-old", "provision must target the database the data is already in");
});

test("apps: finalizeDeploy leaves org_id null for a static app", async () => {
  // static_web has no schema in any database, so claiming one would be a lie
  // the data browser would later act on.
  const calls: any[] = [];
  const repo = appsRepo(
    appsSupabase({
      seed: {
        apps: [{ ...APP_ROW, type: "static_web", provision_status: "ready" }],
        teams: [{ id: "team-1", oid: "org-old" }],
      },
      calls,
    }),
    {
      startDeploy: async () => ({
        fcFunctionName: "tc-app-1", fcRegion: "cn-hangzhou",
        ossObjectName: "apps/app-1/code.zip", presignedPut: "https://oss/put?sig=x",
      }),
      finalizeDeploy: async () => ({ fcEndpoint: "https://x.fcapp.run" }),
    },
  );
  const started = await repo.deployApp("app-1", APP_DEPLOY);
  await repo.finalizeDeploy("app-1", { gitCommitSha: APP_SHA, deployToken: started.deployToken });

  const upd = calls.filter((c) => c.table === "apps" && c.op === "update" && c.row?.fc_status === "live");
  assert.equal(upd.length, 1);
  assert.equal("org_id" in upd[0].row, false);
});

test("apps: finalizeDeploy wraps finalize failure as 502", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, provision_status: "ready" }] } }),
    {
      startDeploy: async () => ({
        fcFunctionName: "tc-app-1", fcRegion: "cn-hangzhou",
        ossObjectName: "apps/app-1/code.zip", presignedPut: "https://oss/put?sig=x",
      }),
      finalizeDeploy: async () => { throw new Error("fc boom"); },
    },
  );
  const started = await repo.deployApp("app-1", APP_DEPLOY);
  await assert.rejects(
    () => repo.finalizeDeploy("app-1", { gitCommitSha: APP_SHA, deployToken: started.deployToken }),
    (err: any) => err?.code === "finalize_failed" && err?.statusCode === 502,
  );
});

test("apps: listAppSessions returns the session-summary shape", async () => {
  const repo = appsRepo(appsSupabase({
    seed: {
      sessions: [{
        id: "sess-1", team_id: "team-1", app_id: "app-1", title: "Chat", mode: "collab",
        last_message_at: "2026-06-13T01:00:00Z",
        created_at: "2026-06-13T00:00:00Z", updated_at: "2026-06-13T00:30:00Z",
      }],
    },
  }));
  const rows = await repo.listAppSessions("app-1");
  assert.deepEqual(rows, [{
    id: "sess-1",
    teamId: "team-1",
    title: "Chat",
    mode: "collab",
    lastMessageAt: "2026-06-13T01:00:00.000Z",
    createdAt: "2026-06-13T00:00:00.000Z",
    updatedAt: "2026-06-13T00:30:00.000Z",
  }]);
});

test("apps: createSession forwards app_id when input has appId", async () => {
  const calls: any[] = [];
  const supabase = appsSupabase({
    seed: {
      sessions: [{
        id: "sess-app-1", team_id: "team-1", title: "App chat", mode: "collab",
        idea_id: null, primary_agent_id: null, created_by_actor_id: "actor-app-1",
        summary: null, last_message_preview: null, last_message_at: null,
        acp_session_id: null, binding: null,
        created_at: "2026-06-13T00:00:00Z", updated_at: "2026-06-13T00:00:00Z",
      }],
    },
    calls,
  });
  const repo = appsRepo(supabase);
  await repo.createSession({
    id: "sess-app-1",
    teamId: "team-1",
    title: "App chat",
    createdByActorId: "actor-app-1",
    appId: "app-1",
  });
  const insert = calls.find((c) => c.table === "sessions" && c.op === "insert");
  assert.equal(insert?.row.app_id, "app-1");
});

test("apps: createSession omits app_id when no appId given", async () => {
  const calls: any[] = [];
  const supabase = appsSupabase({
    seed: {
      sessions: [{
        id: "sess-plain", team_id: "team-1", title: "Plain", mode: "collab",
        idea_id: null, primary_agent_id: null, created_by_actor_id: "actor-app-1",
        summary: null, last_message_preview: null, last_message_at: null,
        acp_session_id: null, binding: null,
        created_at: "2026-06-13T00:00:00Z", updated_at: "2026-06-13T00:00:00Z",
      }],
    },
    calls,
  });
  const repo = appsRepo(supabase);
  await repo.createSession({
    id: "sess-plain",
    teamId: "team-1",
    title: "Plain",
    createdByActorId: "actor-app-1",
  });
  const insert = calls.find((c) => c.table === "sessions" && c.op === "insert");
  assert.ok(!("app_id" in (insert?.row ?? {})), "app_id must be absent for plain sessions");
});

test("upsertWorkspace resolves createdByMemberId server-side (ignores client spoof)", async () => {
  // Same multi-team bug as createSession: client may send another team's member
  // id; workspaces INSERT RLS requires the team-scoped actor.
  const calls: any[] = [];
  const repo = appsRepo(appsSupabase({ actorRow: { id: "actor-team-b" }, calls }));
  const out = await repo.upsertWorkspace({
    teamId: "team-b",
    name: "Alpha",
    path: "/tmp/alpha",
    agentId: "agent-1",
    createdByMemberId: "actor-SPOOFED-team-a",
  });
  const upsert = calls.find((c) => c.table === "workspaces" && c.op === "upsert");
  assert.equal(
    upsert?.row.created_by_member_id,
    "actor-team-b",
    "created_by must be the server-resolved team actor, not the client value",
  );
  assert.equal(upsert?.row.team_id, "team-b");
  assert.equal(out.teamId, "team-b");
  assert.equal(out.name, "Alpha");
});

test("upsertWorkspace returns 403 when the caller is not a member of the team", async () => {
  const repo = appsRepo(appsSupabase({ actorRow: null }));
  await assert.rejects(
    () => repo.upsertWorkspace({ teamId: "team-b", name: "Nope", path: "/tmp/x" }),
    (err: any) => err?.statusCode === 403,
  );
});

test("upsertWorkspace without id reuses existing row by (teamId, path)", async () => {
  // Regression: re-adding an already-synced workspace used to hit
  // workspaces_team_id_agent_id_name_key because upsert only deduped on id.
  const calls: any[] = [];
  const repo = appsRepo(appsSupabase({
    calls,
    seed: {
      workspaces: [{
        id: "ws-existing",
        team_id: "team-b",
        name: "Alpha",
        path: "/tmp/alpha",
        agent_id: "agent-1",
        archived: false,
      }],
    },
  }));

  const out = await repo.upsertWorkspace({
    teamId: "team-b",
    name: "Alpha Renamed",
    path: "/tmp/alpha/",
    agentId: "agent-1",
  });

  const upsert = calls.find((c) => c.table === "workspaces" && c.op === "upsert");
  assert.equal(upsert?.row.id, "ws-existing");
  assert.equal(upsert?.row.path, "/tmp/alpha", "trailing slash is normalized");
  assert.equal(upsert?.row.name, "Alpha Renamed");
  assert.equal(out.id, "ws-existing");
});

test("upsertWorkspace reuses archived row with the same name instead of inserting", async () => {
  const calls: any[] = [];
  const repo = appsRepo(appsSupabase({
    calls,
    seed: {
      workspaces: [{
        id: "ws-archived",
        team_id: "team-b",
        name: "legacy",
        path: "/tmp/legacy",
        agent_id: "agent-1",
        archived: true,
      }],
    },
  }));

  const out = await repo.upsertWorkspace({
    teamId: "team-b",
    name: "legacy",
    path: "/tmp/legacy-new",
    agentId: "agent-1",
    archived: false,
  });

  const upsert = calls.find((c) => c.table === "workspaces" && c.op === "upsert");
  assert.equal(upsert?.row.id, "ws-archived");
  assert.equal(upsert?.row.archived, false);
  assert.equal(upsert?.row.path, "/tmp/legacy-new");
  assert.equal(out.id, "ws-archived");
});

test("upsertWorkspace disambiguates name when same agent already has that name at another path", async () => {
  const calls: any[] = [];
  const repo = appsRepo(appsSupabase({
    calls,
    seed: {
      workspaces: [{
        id: "ws-active",
        team_id: "team-b",
        name: "teamclu",
        path: "/Users/me/code/teamclu",
        agent_id: "agent-1",
        archived: false,
      }],
    },
  }));

  const out = await repo.upsertWorkspace({
    teamId: "team-b",
    name: "teamclu",
    path: "/Users/me/other/teamclu",
    agentId: "agent-1",
  });

  const upsert = calls.find((c) => c.table === "workspaces" && c.op === "upsert");
  assert.equal(upsert?.row.name, "teamclu (2)");
  assert.notEqual(upsert?.row.id, "ws-active");
  assert.equal(out.name, "teamclu (2)");
});

test("createSession is server-authoritative for created_by (ignores client createdByActorId)", async () => {
  const calls: any[] = [];
  // The authenticated caller resolves to actor-app-1 for this team; the client
  // sends a DIFFERENT (stale/other-team) actor id, which must be ignored.
  const supabase = appsSupabase({ actorRow: { id: "actor-app-1" }, calls });
  const repo = appsRepo(supabase);
  await repo.createSession({
    id: "sess-auth-1",
    teamId: "team-1",
    title: "Authoritative",
    createdByActorId: "actor-SPOOFED-other-team",
  });
  const insert = calls.find((c) => c.table === "sessions" && c.op === "insert");
  assert.equal(
    insert?.row.created_by_actor_id,
    "actor-app-1",
    "created_by must be the server-resolved team actor, not the client value",
  );
});

test("createSession returns 403 when the caller is not a member of the team", async () => {
  const supabase = appsSupabase({ actorRow: null });
  const repo = appsRepo(supabase);
  await assert.rejects(
    () => repo.createSession({ id: "sess-x", teamId: "team-1", title: "Nope" }),
    (err: any) => err?.statusCode === 403,
  );
});

// --- App data browser -------------------------------------------------------

const DEPLOYED_DATA_APP = {
  ...APP_ROW,
  provision_status: "ready",
  fc_status: "live",
  fc_endpoint: "https://x.fcapp.run",
  org_id: "org-1",
};

function fakeAppData(over: Record<string, unknown> = {}) {
  return {
    listTables: async () => [{ name: "items", columns: [], primaryKey: ["id"], editable: true }],
    readRows: async () => ({ table: "items", columns: [], primaryKey: ["id"], editable: true, rows: [], nextCursor: null }),
    updateRow: async () => ({ id: 1, title: "stored" }),
    deleteRow: async () => {},
    ...over,
  };
}

function dataRepo(appRow: any, { level, actorId = "actor-app-1", appData = fakeAppData() }: any = {}) {
  const access = level && actorId !== "actor-app-1"
    ? [{ app_id: "app-1", member_id: actorId, permission_level: level, granted_by_member_id: "actor-app-1" }]
    : [];
  return appsRepo(
    appsSupabase({
      seed: { apps: [appRow], app_member_access: access, teams: [{ id: "team-1", oid: "org-derived" }] },
      actorRow: { id: actorId },
    }),
    { appData },
  );
}

test("app data: the creator (admin) can read and write", async () => {
  const repo = dataRepo(DEPLOYED_DATA_APP);
  assert.deepEqual(((await repo.listAppDataTables("app-1")) as any).items[0].name, "items");
  assert.deepEqual(await repo.readAppDataRows("app-1", "items", {}), {
    table: "items", columns: [], primaryKey: ["id"], editable: true, rows: [], nextCursor: null,
  });
  assert.deepEqual(await repo.updateAppDataRow("app-1", "items", "WzFd", { patch: { title: "x" } }), {
    row: { id: 1, title: "stored" },
  });
  assert.deepEqual(await repo.deleteAppDataRow("app-1", "items", "WzFd"), { ok: true });
});

test("app data: prompt reads, but PATCH and DELETE are 403", async () => {
  // §6: a member who can direct an agent at the code but cannot see the data
  // debugs by adding a console.log to production. Read-only is the safer answer.
  const repo = dataRepo(DEPLOYED_DATA_APP, { level: "prompt", actorId: "member-other" });
  assert.equal(((await repo.listAppDataTables("app-1")) as any).items.length, 1);
  await assert.rejects(
    () => repo.updateAppDataRow("app-1", "items", "WzFd", { patch: { title: "x" } }),
    (e: any) => e?.statusCode === 403,
  );
  await assert.rejects(
    () => repo.deleteAppDataRow("app-1", "items", "WzFd"),
    (e: any) => e?.statusCode === 403,
  );
});

test("app data: view tier cannot see the feature at all", async () => {
  const repo = dataRepo(DEPLOYED_DATA_APP, { level: "view", actorId: "member-other" });
  assert.equal(await repo.listAppDataTables("app-1"), null);
  assert.equal(await repo.readAppDataRows("app-1", "items", {}), null);
  assert.equal(await repo.updateAppDataRow("app-1", "items", "WzFd", { patch: { t: 1 } }), null);
});

test("app data: a non-member gets nothing", async () => {
  const repo = dataRepo(DEPLOYED_DATA_APP, { actorId: "member-other" });
  assert.equal(await repo.listAppDataTables("app-1"), null);
});

test("app data: static and undeployed apps give distinguishable 409s", async () => {
  // The control panel shows a different sentence for each; a shared 404 would
  // make both read as "something is broken".
  const staticApp = dataRepo({ ...DEPLOYED_DATA_APP, type: "static_web" });
  await assert.rejects(
    () => staticApp.listAppDataTables("app-1"),
    (e: any) => e?.statusCode === 409 && e?.code === "app_has_no_database",
  );

  const undeployed = dataRepo({ ...DEPLOYED_DATA_APP, fc_status: null, fc_endpoint: null });
  await assert.rejects(
    () => undeployed.listAppDataTables("app-1"),
    (e: any) => e?.statusCode === 409 && e?.code === "app_not_deployed",
  );
});

test("app data: targets apps.org_id, not the team's current org", async () => {
  // Same fact as the finalize test, from the read side: teams.oid has moved on,
  // and following it would report "no tables" for an app whose data is fine.
  let seen: any;
  const repo = dataRepo(DEPLOYED_DATA_APP, {
    appData: fakeAppData({ listTables: async (t: any) => { seen = t; return []; } }),
  });
  await repo.listAppDataTables("app-1");
  assert.deepEqual(seen, { orgId: "org-1", appId: "app-1", slug: "my-app" });
});

test("app data: a row from before apps.org_id falls back to deriving it", async () => {
  let seen: any;
  const repo = dataRepo({ ...DEPLOYED_DATA_APP, org_id: null }, {
    appData: fakeAppData({ listTables: async (t: any) => { seen = t; return []; } }),
  });
  await repo.listAppDataTables("app-1");
  assert.equal(seen.orgId, "org-derived");
});

test("app data: an app with no org at all is a 409, not a wrong database", async () => {
  const repo = appsRepo(
    appsSupabase({
      seed: { apps: [{ ...DEPLOYED_DATA_APP, org_id: null }], teams: [] },
      actorRow: { id: "actor-app-1" },
    }),
    { appData: fakeAppData() },
  );
  await assert.rejects(
    () => repo.listAppDataTables("app-1"),
    (e: any) => e?.statusCode === 409 && e?.code === "app_org_unknown",
  );
});

test("app data: 503 names the missing variable when FC has no admin URL", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [DEPLOYED_DATA_APP] } }),
    { appDataUnavailableReason: "APPS_DB_ADMIN_URL is not set" },
  );
  await assert.rejects(
    () => repo.listAppDataTables("app-1"),
    (e: any) => e?.statusCode === 503 && /APPS_DB_ADMIN_URL/.test(e?.message ?? ""),
  );
});

test("app data: a driver error never carries the SQL or the row values out", async () => {
  const repo = dataRepo(DEPLOYED_DATA_APP, {
    appData: fakeAppData({
      readRows: async () => {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: "23505",
          query: "select * from app_x.customers where email = $1",
          parameters: ["ceo@example.com"],
          detail: "Key (email)=(ceo@example.com) already exists.",
        });
      },
    }),
  });
  await assert.rejects(
    () => repo.readAppDataRows("app-1", "items", {}),
    (e: any) =>
      e?.statusCode === 502 &&
      !/customers|ceo@example\.com|select \*/.test(`${e?.message} ${JSON.stringify(e?.details ?? {})}`),
  );
});

test("app data: a cancelled statement is a 504, not a generic failure", async () => {
  const repo = dataRepo(DEPLOYED_DATA_APP, {
    appData: fakeAppData({
      readRows: async () => { throw Object.assign(new Error("canceling statement"), { code: "57014" }); },
    }),
  });
  await assert.rejects(
    () => repo.readAppDataRows("app-1", "items", {}),
    (e: any) => e?.statusCode === 504 && e?.code === "query_timeout",
  );
});

test("app data: the filter is validated before it reaches the database", async () => {
  const repo = dataRepo(DEPLOYED_DATA_APP, {
    appData: fakeAppData({ readRows: async () => { throw new Error("must not be called"); } }),
  });
  await assert.rejects(
    () => repo.readAppDataRows("app-1", "items", { filterColumn: "note", filterOp: "; drop table items" }),
    (e: any) => e?.statusCode === 400,
  );
});

test("app data: PATCH requires a patch object", async () => {
  const repo = dataRepo(DEPLOYED_DATA_APP, {
    appData: fakeAppData({ updateRow: async () => { throw new Error("must not be called"); } }),
  });
  for (const body of [{}, { patch: "title=x" }, { patch: ["title"] }]) {
    await assert.rejects(
      () => repo.updateAppDataRow("app-1", "items", "WzFd", body),
      (e: any) => e?.statusCode === 400,
    );
  }
});
