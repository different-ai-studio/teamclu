import test from "node:test";
import assert from "node:assert/strict";

import { turnTraceObjectKey } from "../src/lib/turn-trace.js";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";

test("turn trace object key follows turns/<team>/<session>/<turn>.jsonl.gz", () => {
  assert.equal(
    turnTraceObjectKey("team-a", "sess-b", "turn-c"),
    "turns/team-a/sess-b/turn-c.jsonl.gz",
  );
});

test("POST trace/prepare checks session membership before presigning", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const repo = {
    async getSession(sessionId: string, { teamId }: { teamId: string }) {
      calls.push({ method: "getSession", sessionId, teamId });
      if (sessionId === "sess-1" && teamId === "team-1") {
        return { id: sessionId, teamId };
      }
      return null;
    },
  };

  const original = process.env.ACCESS_KEY_ID;
  process.env.ACCESS_KEY_ID = "k";
  process.env.ACCESS_KEY_SECRET = "s";
  process.env.ENDPOINT = "https://s3.example.com";
  process.env.TEAM_BLOBS_BACKEND = "s3";
  process.env.BUCKET = "shared";

  try {
    const missing = await handleBusinessApiRequest(
      {
        httpMethod: "POST",
        path: "/v1/sessions/sess-1/turns/turn-9/trace/prepare",
        headers: { Authorization: "Bearer token" },
        body: JSON.stringify({ teamId: "team-1" }),
      },
      { createRepository: () => repo },
    );
    assert.equal(missing.statusCode, 200);
    const body = JSON.parse(missing.body);
    assert.equal(body.ossKey, "turns/team-1/sess-1/turn-9.jsonl.gz");
    assert.match(body.presignedPut, /^https:\/\//);
    assert.equal(body.expiresIn, 900);

    const denied = await handleBusinessApiRequest(
      {
        httpMethod: "POST",
        path: "/v1/sessions/sess-ghost/turns/turn-9/trace/prepare",
        headers: { Authorization: "Bearer token" },
        body: JSON.stringify({ teamId: "team-1" }),
      },
      { createRepository: () => repo },
    );
    assert.equal(denied.statusCode, 404);
  } finally {
    if (original === undefined) delete process.env.ACCESS_KEY_ID;
    else process.env.ACCESS_KEY_ID = original;
    delete process.env.ACCESS_KEY_SECRET;
    delete process.env.ENDPOINT;
    delete process.env.TEAM_BLOBS_BACKEND;
    delete process.env.BUCKET;
  }

  assert.equal(calls.length, 2);
});
