import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { assertWritableKeyId, readEnvelope } from "../src/lib/validation/team-env-secrets.js";

// Route-level coverage for team env secrets.
// Design: docs/architecture/team-mcp-and-env-cloud.md
//
// The defining property of this endpoint is what it does NOT do: it never sees
// a plaintext value and holds no key. Several tests below exist to keep that
// true by construction rather than by convention.

const ENVELOPE = { v: 1, nonce: "bm9uY2UxMjM0NTY=", ciphertext: "Y2lwaGVydGV4dA==" };

function fakeRepo(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string, result: unknown = null) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  return {
    calls,
    listTeamEnvSecrets: record("listTeamEnvSecrets", []),
    putTeamEnvSecret: record("putTeamEnvSecret", { keyId: "team_api_base", envelope: ENVELOPE }),
    deleteTeamEnvSecret: record("deleteTeamEnvSecret"),
    ...overrides,
  };
}

function request(overrides: Record<string, unknown>, repo: unknown) {
  return handleBusinessApiRequest(
    {
      headers: { Authorization: "Bearer caller-token" },
      ...overrides,
    } as never,
    { createRepository: () => repo } as never,
  );
}

test("GET /v1/teams/:id/env-secrets returns ciphertext only", async () => {
  const repo = fakeRepo({
    listTeamEnvSecrets: async () => [
      { keyId: "team_api_base", envelope: ENVELOPE, createdBy: "actor-1", updatedBy: "actor-1" },
    ],
  });
  const res = await request(
    { httpMethod: "GET", path: "/v1/teams/team-1/env-secrets" },
    repo,
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.items.length, 1);
  // No `value`, and no description/category either — that metadata is encrypted
  // inside the envelope. If any of those ever appear here, something upstream
  // has started decrypting server-side.
  assert.equal(body.items[0].value, undefined);
  assert.equal(body.items[0].description, undefined);
  assert.equal(body.items[0].category, undefined);
  assert.deepEqual(Object.keys(body.items[0].envelope).sort(), ["ciphertext", "nonce", "v"]);
});

test("PUT stores an envelope under the path keyId", async () => {
  const repo = fakeRepo();
  const res = await request(
    {
      httpMethod: "PUT",
      path: "/v1/teams/team-1/env-secrets/team_api_base",
      body: JSON.stringify({ envelope: ENVELOPE }),
    },
    repo,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(repo.calls[0], {
    method: "putTeamEnvSecret",
    args: ["team-1", "team_api_base", { envelope: ENVELOPE }],
  });
});

test("DELETE is routed with the keyId", async () => {
  const repo = fakeRepo();
  const res = await request(
    { httpMethod: "DELETE", path: "/v1/teams/team-1/env-secrets/team_api_base" },
    repo,
  );
  assert.equal(res.statusCode, 204);
  assert.deepEqual(repo.calls[0], {
    method: "deleteTeamEnvSecret",
    args: ["team-1", "team_api_base"],
  });
});

test("a repository rejection surfaces as its status, not a 500", async () => {
  const { ApiError } = await import("../src/lib/http-utils.js");
  const repo = fakeRepo({
    putTeamEnvSecret: async () => {
      throw new ApiError(422, "reserved_key", "tc_api_key is reserved");
    },
  });
  const res = await request(
    {
      httpMethod: "PUT",
      path: "/v1/teams/team-1/env-secrets/tc_api_key",
      body: JSON.stringify({ envelope: ENVELOPE }),
    },
    repo,
  );
  assert.equal(res.statusCode, 422);
  assert.equal(JSON.parse(res.body).error?.code ?? JSON.parse(res.body).code, "reserved_key");
});

// ---------------------------------------------------------------------------
// Validators, tested directly (the repo authorises before it validates, so
// these are not reachable through it without a live database).
// ---------------------------------------------------------------------------

function expectApiError(fn: () => unknown, status: number, code?: string) {
  try {
    fn();
  } catch (e: any) {
    assert.equal(e.statusCode ?? e.status, status, `expected ${status}: ${e.message}`);
    if (code) assert.equal(e.code, code);
    return e;
  }
  throw new Error("expected the call to throw");
}

test("reserved key ids can never be shared to a team", () => {
  // tc_api_key is already skipped daemon-side; _team_secret.* IS the key that
  // decrypts everything else, so uploading it would hand the server the lot.
  expectApiError(() => assertWritableKeyId("tc_api_key"), 422, "reserved_key");
  expectApiError(() => assertWritableKeyId("_team_secret"), 422, "reserved_key");
  assert.doesNotThrow(() => assertWritableKeyId("team_api_base"));
});

test("key ids follow the same rule as the desktop validate_key_id", () => {
  for (const bad of ["", "Upper", "has-dash", "has space", "a".repeat(65)]) {
    expectApiError(() => assertWritableKeyId(bad), 400);
  }
  for (const good of ["a", "team_api_base", "x9_", "a".repeat(64)]) {
    assert.doesNotThrow(() => assertWritableKeyId(good));
  }
});

test("a body that is not an envelope is rejected rather than stored", () => {
  // The failure this guards against is a client bug that posts the plaintext:
  // stored verbatim, it would become a server-readable secret with no signal.
  expectApiError(() => readEnvelope({ envelope: "plaintext-value" }), 400);
  expectApiError(() => readEnvelope({ envelope: { v: 1, nonce: "abc" } }), 400);
  expectApiError(() => readEnvelope({ envelope: { v: 0, nonce: "a", ciphertext: "b" } }), 400);
  expectApiError(() => readEnvelope({}), 400);
});

test("readEnvelope drops unknown fields instead of persisting them", () => {
  const out = readEnvelope({
    envelope: { ...ENVELOPE, value: "oops-plaintext", note: "leak" },
  });
  // An unexpected key here is far more likely to be leaked plaintext than a
  // forward-compatible extension, so it must not survive into the column.
  assert.deepEqual(Object.keys(out).sort(), ["ciphertext", "nonce", "v"]);
});
