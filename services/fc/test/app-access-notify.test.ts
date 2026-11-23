import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appAccessRecipientUserId,
  publishAppAccessChanged,
} from "../src/lib/app-access-notify.js";
import { appsSupabase, appsRepo } from "./fixtures/apps-repository.js";

const APP_ROW = {
  id: "app-1",
  team_id: "team-1",
  created_by_actor_id: "actor-app-1",
  name: "App",
  slug: "app",
};
const MEMBER_2 = { id: "member-2", team_id: "team-1", actor_type: "member", user_id: "user-2" };
const AGENT_2 = { id: "agent-2", team_id: "team-1", actor_type: "agent", user_id: "daemon-user-2" };

/** The hint is fire-and-forget; let the microtask that publishes it run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("appAccessRecipientUserId tells a human and skips agents and unclaimed actors", () => {
  assert.equal(appAccessRecipientUserId(MEMBER_2), "user-2");
  assert.equal(appAccessRecipientUserId(AGENT_2), null);
  assert.equal(appAccessRecipientUserId({ actor_type: "member", user_id: null }), null);
  assert.equal(appAccessRecipientUserId(null), null);
});

test("publishAppAccessChanged sends one app.access hint to the user's inbox", async () => {
  const sent: { topic: string; body: string }[] = [];
  await publishAppAccessChanged({
    teamId: "team-1",
    appId: "app-1",
    userId: "user-2",
    now: () => 42,
    publish: async (topic, body) => { sent.push({ topic, body }); },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].topic, "inbox/user-2");
  assert.deepEqual(JSON.parse(sent[0].body), {
    v: 2,
    type: "app.access",
    team_id: "team-1",
    app_id: "app-1",
    ts: 42,
  });
});

function repoWith(seed: Record<string, unknown[]>, publish: (topic: string, body: string) => Promise<void>) {
  const admin = appsSupabase({ seed: { apps: [APP_ROW], ...seed } });
  return appsRepo(appsSupabase({ seed: { apps: [APP_ROW] } }), {
    createServiceRoleClient: () => admin,
    publishSessionParticipantInbox: publish,
  });
}

test("setAppAccess tells the human grantee to re-read their apps", async () => {
  const sent: { topic: string; body: string }[] = [];
  const repo = repoWith({ actors: [MEMBER_2] }, async (topic, body) => { sent.push({ topic, body }); });
  await repo.setAppAccess("app-1", "member-2", "write");
  await settle();
  assert.deepEqual(sent.map((s) => s.topic), ["inbox/user-2"]);
  const payload = JSON.parse(sent[0].body);
  assert.equal(payload.type, "app.access");
  assert.equal(payload.team_id, "team-1");
  assert.equal(payload.app_id, "app-1");
});

test("setAppAccess sends nothing for an agent grantee", async () => {
  const sent: string[] = [];
  const repo = repoWith({ actors: [AGENT_2] }, async (topic) => { sent.push(topic); });
  await repo.setAppAccess("app-1", "agent-2", "write");
  await settle();
  assert.deepEqual(sent, []);
});

test("a failed hint does not fail the grant", async () => {
  const repo = repoWith({ actors: [MEMBER_2] }, async () => { throw new Error("broker down"); });
  const row = await repo.setAppAccess("app-1", "member-2", "write");
  await settle();
  assert.equal(row?.memberId, "member-2");
});

test("removeAppAccess tells the removed human too", async () => {
  const sent: string[] = [];
  const repo = repoWith(
    {
      actors: [MEMBER_2],
      app_member_access: [{
        app_id: "app-1",
        member_id: "member-2",
        permission_level: "write",
        granted_by_member_id: "actor-app-1",
        created_at: "2026-08-27T00:00:00.000Z",
      }],
    },
    async (topic) => { sent.push(topic); },
  );
  assert.equal(await repo.removeAppAccess("app-1", "member-2"), true);
  await settle();
  assert.deepEqual(sent, ["inbox/user-2"]);
});
