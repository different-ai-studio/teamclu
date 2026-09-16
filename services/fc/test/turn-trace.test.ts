import test from "node:test";
import assert from "node:assert/strict";

import { turnTraceObjectKey } from "../src/lib/turn-trace.js";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { getTeamBlobStorage } from "../src/lib/team-blob-storage.js";

// The blob store is resolved once per process, so pick the s3 backend before
// anything asks for it.
process.env.ACCESS_KEY_ID = "k";
process.env.ACCESS_KEY_SECRET = "s";
process.env.ENDPOINT = "https://s3.example.com";
process.env.TEAM_BLOBS_BACKEND = "s3";
process.env.BUCKET = "shared";

const TEAM = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const TURN = "33333333-3333-4333-8333-333333333333";
const MESSAGE = "44444444-4444-4444-8444-444444444444";
const SHA = "a".repeat(64);
const KEY = `turns/${TEAM}/${SESSION}/${TURN}.jsonl.gz`;

function traceRepo({ current = null as any, stored = null as any, authorizeError = null as any } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async authorizeTurnTraceUpload(claim) {
      calls.push({ method: "authorizeTurnTraceUpload", claim });
      if (authorizeError) throw authorizeError;
      return current;
    },
    async recordTurnTrace(claim, trace) {
      calls.push({ method: "recordTurnTrace", claim, trace });
      if (authorizeError) throw authorizeError;
      return trace;
    },
    async getTurnTrace(target) {
      calls.push({ method: "getTurnTrace", target });
      return stored;
    },
  };
}

function call(repo, httpMethod: string, path: string, body?: unknown, query?: Record<string, string>) {
  return handleBusinessApiRequest(
    {
      httpMethod,
      path,
      headers: { Authorization: "Bearer token" },
      body: body === undefined ? undefined : JSON.stringify(body),
      queryStringParameters: query,
    },
    { createRepository: () => repo },
  );
}

function claim(extra: Record<string, unknown> = {}) {
  return { teamId: TEAM, messageId: MESSAGE, size: 1234, sha256: SHA, ...extra };
}

async function withStorage(
  overrides: Partial<ReturnType<typeof getTeamBlobStorage>>,
  fn: () => Promise<void>,
) {
  const storage = getTeamBlobStorage();
  const saved = Object.fromEntries(Object.keys(overrides).map((k) => [k, storage[k]]));
  Object.assign(storage, overrides);
  try {
    await fn();
  } finally {
    Object.assign(storage, saved);
  }
}

test("turn trace object key is built from UUIDs only", () => {
  assert.equal(turnTraceObjectKey(TEAM, SESSION, TURN), KEY);
  assert.equal(turnTraceObjectKey(TEAM.toUpperCase(), SESSION, TURN), KEY, "one key per id");
  for (const bad of ["../../../apps/evil", "turn-c", "", `${TURN}/x`, `${TURN}\u0000`]) {
    assert.throws(() => turnTraceObjectKey(TEAM, SESSION, bad), (e: any) => e.statusCode === 400);
  }
});

test("prepare rejects a traversal turnId before touching the repository or storage", async () => {
  const repo = traceRepo();
  const res = await call(
    repo,
    "POST",
    `/v1/sessions/${SESSION}/turns/..%2F..%2F..%2Fapps%2Fevil/trace/prepare`,
    claim(),
  );
  assert.equal(res.statusCode, 400);
  assert.equal(repo.calls.length, 0);
});

test("prepare validates the size and digest it will sign for", async () => {
  const path = `/v1/sessions/${SESSION}/turns/${TURN}/trace/prepare`;
  for (const bad of [
    claim({ size: 0 }),
    claim({ size: 16 * 1024 * 1024 + 1 }),
    claim({ size: 1.5 }),
    claim({ sha256: "abc" }),
    claim({ sha256: SHA.toUpperCase() }),
    claim({ messageId: "not-a-uuid" }),
  ]) {
    const repo = traceRepo();
    const res = await call(repo, "POST", path, bad);
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.equal(repo.calls.length, 0);
  }
});

test("prepare authorizes the caller as the reply's author and binds the length into the signature", async () => {
  const repo = traceRepo();
  const res = await call(repo, "POST", `/v1/sessions/${SESSION}/turns/${TURN}/trace/prepare`, claim());
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ossKey, KEY);
  assert.equal(body.expiresIn, 900);
  const signed = new URL(body.presignedPut).searchParams.get("X-Amz-SignedHeaders") ?? "";
  assert.ok(signed.split(";").includes("content-length"), `signed headers: ${signed}`);
  assert.deepEqual(repo.calls, [{
    method: "authorizeTurnTraceUpload",
    claim: { teamId: TEAM, sessionId: SESSION, turnId: TURN, messageId: MESSAGE, size: 1234, sha256: SHA },
  }]);
});

test("prepare refuses once the trace is uploaded, and passes authorization errors through", async () => {
  const path = `/v1/sessions/${SESSION}/turns/${TURN}/trace/prepare`;
  const uploaded = await call(traceRepo({ current: { status: "uploaded" } }), "POST", path, claim());
  assert.equal(uploaded.statusCode, 409);
  assert.equal(JSON.parse(uploaded.body).error.code, "conflict");

  const retry = await call(traceRepo({ current: { status: "failed" } }), "POST", path, claim());
  assert.equal(retry.statusCode, 200, "a failed trace can be retried");

  const { ApiError } = await import("../src/lib/http-utils.js");
  const denied = await call(
    traceRepo({ authorizeError: new ApiError(403, "forbidden", "not the author") }),
    "POST",
    path,
    claim(),
  );
  assert.equal(denied.statusCode, 403);
});

test("complete records an uploaded trace once storage holds the claimed size", async () => {
  const repo = traceRepo();
  await withStorage({ stat: async (p) => (p === KEY ? { size: 1234 } : null) }, async () => {
    const res = await call(
      repo,
      "POST",
      `/v1/sessions/${SESSION}/turns/${TURN}/trace/complete`,
      claim({ status: "uploaded" }),
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).trace, { key: KEY, size: 1234, sha256: SHA, status: "uploaded" });
  });
  assert.deepEqual(repo.calls.map((c) => c.method), ["recordTurnTrace"]);
});

test("complete deletes a blob whose size does not match the claim and records the failure", async () => {
  const repo = traceRepo();
  const removed: string[] = [];
  await withStorage(
    {
      stat: async () => ({ size: 999_999 }),
      remove: async (p) => {
        removed.push(p);
      },
    },
    async () => {
      const res = await call(
        repo,
        "POST",
        `/v1/sessions/${SESSION}/turns/${TURN}/trace/complete`,
        claim({ status: "uploaded" }),
      );
      assert.equal(res.statusCode, 422);
      assert.equal(JSON.parse(res.body).error.code, "size_mismatch");
    },
  );
  assert.deepEqual(removed, [KEY]);
  assert.equal((repo.calls[0].trace as any).status, "failed");
});

test("complete does not act on storage for a caller who is not the author", async () => {
  const { ApiError } = await import("../src/lib/http-utils.js");
  const repo = traceRepo({ authorizeError: new ApiError(403, "forbidden", "not the author") });
  const removed: string[] = [];
  await withStorage(
    {
      stat: async () => ({ size: 1 }),
      remove: async (p) => {
        removed.push(p);
      },
    },
    async () => {
      const res = await call(
        repo,
        "POST",
        `/v1/sessions/${SESSION}/turns/${TURN}/trace/complete`,
        claim({ status: "uploaded" }),
      );
      assert.equal(res.statusCode, 403);
    },
  );
  assert.deepEqual(removed, [], "a non-author must not be able to delete the object");
});

test("complete with a missing blob answers 422 only after authorizing", async () => {
  const repo = traceRepo();
  await withStorage({ stat: async () => null }, async () => {
    const res = await call(
      repo,
      "POST",
      `/v1/sessions/${SESSION}/turns/${TURN}/trace/complete`,
      claim({ status: "uploaded" }),
    );
    assert.equal(res.statusCode, 422);
  });
  assert.deepEqual(repo.calls.map((c) => c.method), ["authorizeTurnTraceUpload"]);
});

test("complete records a failure without asking storage, and rejects unknown statuses", async () => {
  const repo = traceRepo();
  await withStorage(
    {
      stat: async () => {
        throw new Error("storage must not be consulted for a failure report");
      },
    },
    async () => {
      const path = `/v1/sessions/${SESSION}/turns/${TURN}/trace/complete`;
      const res = await call(repo, "POST", path, claim({ status: "failed" }));
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).trace.status, "failed");

      const bad = await call(traceRepo(), "POST", path, claim({ status: "done" }));
      assert.equal(bad.statusCode, 400);
    },
  );
});

test("GET trace serves an uploaded pointer with its digest, and 404s otherwise", async () => {
  await withStorage(
    { createDownloadUrl: async (p) => `https://s3.example.com/get?key=${encodeURIComponent(p)}` },
    async () => {
      const path = `/v1/sessions/${SESSION}/turns/${TURN}/trace`;
      const repo = traceRepo({ stored: { key: KEY, size: 18234, sha256: SHA, status: "uploaded" } });
      const ok = await call(repo, "GET", path, undefined, { teamId: TEAM });
      assert.equal(ok.statusCode, 200);
      const body = JSON.parse(ok.body);
      assert.equal(body.ossKey, KEY);
      assert.equal(body.size, 18234);
      assert.equal(body.sha256, SHA);
      assert.equal(body.expiresIn, 900);
      assert.deepEqual(repo.calls, [{ method: "getTurnTrace", target: { teamId: TEAM, sessionId: SESSION, turnId: TURN } }]);

      for (const stored of [null, { key: KEY, size: 1, sha256: SHA, status: "failed" }]) {
        const res = await call(traceRepo({ stored }), "GET", path, undefined, { teamId: TEAM });
        assert.equal(res.statusCode, 404);
      }

      const badTeam = await call(traceRepo(), "GET", path, undefined, { teamId: "team-1" });
      assert.equal(badTeam.statusCode, 400);
    },
  );
});
