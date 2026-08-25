import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { makeTeamVoiceRepo } from "../src/lib/pg-repo/team-voice.js";
import { teams, actors, members, teamMembers } from "../src/db/schema/index.js";
import type { VoiceProfile } from "../src/lib/aliyun-nls.js";

const profile: VoiceProfile = {
  accessKeyId: "LTAI_voice",
  accessKeySecret: "voice-secret",
  region: "cn-shanghai",
  appKey: "appkey-1",
  gatewayEndpoint: "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1",
  sttModel: "paraformer-realtime-v2",
  ttsVoice: "zhixiaobai",
};

async function seedMember(db: any) {
  const [t] = await db
    .insert(teams)
    .values({ name: "T", slug: `t-${Date.now()}-${Math.random()}` })
    .returning();
  const userId = crypto.randomUUID();
  const [actor] = await db
    .insert(actors)
    .values({ teamId: t.id, actorType: "member", displayName: "M", userId })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId: t.id, memberId: actor.id, role: "owner" });
  return { teamId: t.id as string, userId: userId as string };
}

const okDeps = (calls?: { minted: number }) => ({
  resolveVoiceProfile: () => ({ profile }),
  createNlsToken: async () => {
    if (calls) calls.minted++;
    return { token: "tok-1", expiresAt: "2026-08-26T00:00:00.000Z" };
  },
});

test("mintVoiceCredentials returns the gateway, appkey and a token", async () => {
  const { db } = await makeTestDb();
  const { teamId, userId } = await seedMember(db);
  const repo = makeTeamVoiceRepo(db, { userId, ...okDeps() });

  const out = await repo.mintVoiceCredentials(teamId);
  assert.deepEqual(out, {
    gatewayEndpoint: "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1",
    appKey: "appkey-1",
    token: "tok-1",
    expiresAt: "2026-08-26T00:00:00.000Z",
    sttModel: "paraformer-realtime-v2",
    ttsVoice: "zhixiaobai",
  });
});

test("the response never carries the AccessKey", async () => {
  // The entire point of minting server-side: the long-lived credential stays
  // here. A refactor that widened the return to spread the profile would leak
  // it to every device.
  const { db } = await makeTestDb();
  const { teamId, userId } = await seedMember(db);
  const repo = makeTeamVoiceRepo(db, { userId, ...okDeps() });

  const out = await repo.mintVoiceCredentials(teamId);
  const serialised = JSON.stringify(out);
  assert.ok(!serialised.includes("voice-secret"), "AccessKey secret leaked");
  assert.ok(!serialised.includes("LTAI_voice"), "AccessKey id leaked");
});

test("a non-member is refused, and no token is minted for them", async () => {
  // Membership must be checked BEFORE the upstream call: otherwise a stranger
  // can make this deployment spend NLS quota, and learn from the error whether
  // voice is configured at all.
  const { db } = await makeTestDb();
  const { teamId } = await seedMember(db);
  const calls = { minted: 0 };
  const repo = makeTeamVoiceRepo(db, {
    userId: crypto.randomUUID(), // some other user
    ...okDeps(calls),
  });

  await assert.rejects(() => repo.mintVoiceCredentials(teamId), (e: any) => {
    assert.equal(e.statusCode, 403);
    return true;
  });
  assert.equal(calls.minted, 0, "no upstream call may happen before authorisation");
});

test("an unconfigured deployment answers 503 and names the missing variable", async () => {
  const { db } = await makeTestDb();
  const { teamId, userId } = await seedMember(db);
  const repo = makeTeamVoiceRepo(db, {
    userId,
    resolveVoiceProfile: () => ({ error: "VOICE_ACCESS_KEY_ID is not set." }),
    createNlsToken: async () => {
      throw new Error("must not be called");
    },
  });

  await assert.rejects(() => repo.mintVoiceCredentials(teamId), (e: any) => {
    assert.equal(e.statusCode, 503);
    assert.equal(e.code, "voice_unavailable");
    assert.match(e.message, /VOICE_ACCESS_KEY_ID/);
    return true;
  });
});

test("a vendor failure is 502, not 503", async () => {
  // Different cause, different fix: 503 says "you have not configured this",
  // 502 says "you have, and the vendor call failed". Collapsing them sends
  // whoever is on call to the wrong place.
  const { db } = await makeTestDb();
  const { teamId, userId } = await seedMember(db);
  const repo = makeTeamVoiceRepo(db, {
    userId,
    resolveVoiceProfile: () => ({ profile }),
    createNlsToken: async () => {
      throw new Error("NLS CreateToken failed: HTTP 403");
    },
  });

  await assert.rejects(() => repo.mintVoiceCredentials(teamId), (e: any) => {
    assert.equal(e.statusCode, 502);
    assert.equal(e.code, "voice_upstream_failed");
    assert.match(e.message, /HTTP 403/);
    return true;
  });
});

test("a repo built without its dependencies answers 503 rather than crashing", async () => {
  // The composition root injects these; a wiring mistake must surface as a
  // configuration error, not a TypeError in a request handler.
  const { db } = await makeTestDb();
  const { teamId, userId } = await seedMember(db);
  const repo = makeTeamVoiceRepo(db, { userId });

  await assert.rejects(() => repo.mintVoiceCredentials(teamId), (e: any) => {
    assert.equal(e.statusCode, 503);
    assert.equal(e.code, "voice_unavailable");
    return true;
  });
});

test("each call mints a fresh credential", async () => {
  // Nothing is cached or persisted: the token has its own expiry, so a second
  // caller must not be handed a copy of the first one's.
  const { db } = await makeTestDb();
  const { teamId, userId } = await seedMember(db);
  const calls = { minted: 0 };
  const repo = makeTeamVoiceRepo(db, { userId, ...okDeps(calls) });

  await repo.mintVoiceCredentials(teamId);
  await repo.mintVoiceCredentials(teamId);
  assert.equal(calls.minted, 2);
});
