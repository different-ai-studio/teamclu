import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import {
  createMemorySupportSessions,
  supportDisplayName,
  type SupportSessionStore,
} from "../src/lib/support-session.js";

function deps(repo: SupportSessionStore) {
  return {
    createRepository: () => {
      throw new Error("user repository is not used for support sessions");
    },
    createAuthRepository: () => {
      throw new Error("auth repository is not used for support sessions");
    },
    createSystemRepository: () => repo,
  };
}

async function call(
  repo: SupportSessionStore,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await handleBusinessApiRequest(
    {
      httpMethod: method,
      path,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    deps(repo),
  );
  const parsed = res.body ? JSON.parse(res.body) : null;
  return { status: res.statusCode, body: parsed };
}

function errorCode(body: any): string {
  return body?.error?.code;
}

test("support display name prefers nickname, then email, then a fixed label", () => {
  assert.equal(supportDisplayName(" 小王 ", "a@b.c"), "小王");
  assert.equal(supportDisplayName("  ", "ada@x.com"), "ada@x.com");
  assert.equal(supportDisplayName("", ""), "支持人员");
});

test("support session: code, redeem, allow, one bundle, conclusion", async () => {
  const repo = createMemorySupportSessions();
  repo.bindBearer("ada", { id: "user-ada", nickname: "Ada", email: "ada@x.com" });
  repo.bindBearer("bob", { id: "user-bob", nickname: "", email: "bob@x.com" });

  const created = await call(repo, "POST", "/v1/support-sessions", { phase: "install" });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, undefined);
  assert.match(created.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const { sessionId, code } = created.body;

  const waiting = await call(repo, "GET", `/v1/support-sessions/${sessionId}?code=${code}`);
  assert.equal(waiting.status, 200);
  assert.equal(waiting.body.status, "waiting");
  assert.equal(waiting.body.supportDisplayName, null);

  const tooSoon = await call(repo, "POST", `/v1/support-sessions/${sessionId}/allow?code=${code}`);
  assert.equal(tooSoon.status, 409);
  assert.equal(errorCode(tooSoon.body), "not_redeemed");

  const redeemed = await call(
    repo,
    "POST",
    "/v1/support-sessions/redeem",
    { code: code.toLowerCase().replace("-", "") },
    { authorization: "Bearer ada" },
  );
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.body.status, "redeemed");
  assert.equal(redeemed.body.phase, "install");
  assert.equal(redeemed.body.sessionId, sessionId);

  const named = await call(repo, "GET", `/v1/support-sessions/${sessionId}?code=${code}`);
  assert.equal(named.body.supportDisplayName, "Ada");
  assert.equal(named.body.conclusion, null);

  const stolen = await call(
    repo,
    "POST",
    "/v1/support-sessions/redeem",
    { code },
    { authorization: "Bearer bob" },
  );
  assert.equal(stolen.status, 409);
  assert.equal(errorCode(stolen.body), "already_redeemed");

  const beforeAllow = await call(repo, "POST", `/v1/support-sessions/${sessionId}/bundle?code=${code}`, {
    snapshot: {},
    journal: [],
    logs: [],
  });
  assert.equal(beforeAllow.status, 409);
  assert.equal(errorCode(beforeAllow.body), "not_allowed");

  const allowed = await call(repo, "POST", `/v1/support-sessions/${sessionId}/allow?code=${code}`);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.status, "allowed");

  const bundle = { snapshot: { webview2: { present: false, version: null } }, journal: [], logs: [] };
  const uploaded = await call(repo, "POST", `/v1/support-sessions/${sessionId}/bundle?code=${code}`, bundle);
  assert.equal(uploaded.status, 200);

  const again = await call(repo, "POST", `/v1/support-sessions/${sessionId}/bundle?code=${code}`, bundle);
  assert.equal(again.status, 409);
  assert.equal(errorCode(again.body), "already_uploaded");

  const stranger = await call(
    repo,
    "GET",
    `/v1/support-sessions/${sessionId}`,
    undefined,
    { authorization: "Bearer bob" },
  );
  assert.equal(stranger.status, 404);

  const mine = await call(
    repo,
    "GET",
    `/v1/support-sessions/${sessionId}`,
    undefined,
    { authorization: "Bearer ada" },
  );
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.bundle, bundle);

  const concluded = await call(
    repo,
    "POST",
    `/v1/support-sessions/${sessionId}/conclusion`,
    { text: "没有 WebView2。请安装后再打开 TeamClu。" },
    { authorization: "Bearer ada" },
  );
  assert.equal(concluded.status, 200);
  assert.equal(concluded.body.status, "concluded");

  const seen = await call(repo, "GET", `/v1/support-sessions/${sessionId}?code=${code}`);
  assert.equal(seen.body.status, "concluded");
  assert.equal(seen.body.conclusion, "没有 WebView2。请安装后再打开 TeamClu。");
});

test("support session: reject stops a later upload, and expiry is visible to the helper", async () => {
  const repo = createMemorySupportSessions();
  repo.bindBearer("ada", { id: "user-ada", nickname: "", email: "" });
  const created = await call(repo, "POST", "/v1/support-sessions", { phase: "webview" });
  const { sessionId, code, expiresAt } = created.body;

  await call(repo, "POST", "/v1/support-sessions/redeem", { code }, { authorization: "Bearer ada" });
  const named = await call(repo, "GET", `/v1/support-sessions/${sessionId}?code=${code}`);
  assert.equal(named.body.supportDisplayName, "支持人员");

  const rejected = await call(repo, "POST", `/v1/support-sessions/${sessionId}/close?code=${code}`, {
    reason: "user_rejected",
  });
  assert.equal(rejected.body.status, "rejected");
  const upload = await call(repo, "POST", `/v1/support-sessions/${sessionId}/bundle?code=${code}`, { logs: [] });
  assert.equal(upload.status, 409);
  assert.equal(errorCode(upload.body), "not_allowed");

  const second = await call(repo, "POST", "/v1/support-sessions", { phase: "manual" });
  repo.setNow(() => new Date(new Date(second.body.expiresAt).getTime() + 1000));
  const redeem = await call(
    repo,
    "POST",
    "/v1/support-sessions/redeem",
    { code: second.body.code },
    { authorization: "Bearer ada" },
  );
  assert.equal(redeem.status, 410);
  assert.equal(errorCode(redeem.body), "expired");
  const allow = await call(
    repo,
    "POST",
    `/v1/support-sessions/${second.body.sessionId}/allow?code=${second.body.code}`,
  );
  assert.equal(errorCode(allow.body), "expired");
  const lateUpload = await call(
    repo,
    "POST",
    `/v1/support-sessions/${second.body.sessionId}/bundle?code=${second.body.code}`,
    { logs: [] },
  );
  assert.equal(errorCode(lateUpload.body), "expired");
  const poll = await call(
    repo,
    "GET",
    `/v1/support-sessions/${second.body.sessionId}?code=${second.body.code}`,
  );
  assert.equal(poll.status, 200);
  assert.equal(poll.body.status, "expired");
  assert.ok(expiresAt);
});
