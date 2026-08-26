/**
 * Live smoke test: FC GET routes must receive query-string params end-to-end.
 *
 * Run against production after deploy:
 *   FC_LIVE_TEST=1 node --import tsx --test test/live-sync-query.test.ts
 *
 * Optional:
 *   FC_LIVE_BASE_URL=https://cloud.ucar.cc
 *   FC_LIVE_TEAM_ID=<uuid>
 *
 * Skipped in CI / default `npm test` (no network, no prod side effects).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const LIVE = process.env.FC_LIVE_TEST === "1";
const BASE = (process.env.FC_LIVE_BASE_URL ?? "https://cloud.ucar.cc").replace(/\/+$/, "");
const TEAM_ID = process.env.FC_LIVE_TEAM_ID ?? "2c5973bc-96c4-4c6d-b6f6-d3c9728298de";
const DUMMY_BEARER = "fc-live-smoke-invalid-token";

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${DUMMY_BEARER}` },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

function errorMessage(body: any): string {
  return body?.error?.message ?? body?.error ?? "";
}

test(
  "GET /v1/sync/actor-directory: teamId query param reaches handler (live)",
  { skip: !LIVE },
  async () => {
    const missing = await get("/v1/sync/actor-directory");
    assert.equal(missing.status, 400);
    assert.equal(errorMessage(missing.body), "teamId is required");

    const withTeam = await get(`/v1/sync/actor-directory?teamId=${encodeURIComponent(TEAM_ID)}`);
    assert.notEqual(
      errorMessage(withTeam.body),
      "teamId is required",
      "teamId in query string was dropped before the route handler",
    );
  },
);

test(
  "GET /v1/sync/sessions: teamId query param reaches handler (live)",
  { skip: !LIVE },
  async () => {
    const missing = await get("/v1/sync/sessions");
    assert.equal(missing.status, 400);
    assert.equal(errorMessage(missing.body), "teamId is required");

    const withTeam = await get(`/v1/sync/sessions?teamId=${encodeURIComponent(TEAM_ID)}`);
    assert.notEqual(errorMessage(withTeam.body), "teamId is required");
  },
);

test(
  "GET /v1/sync/versions: teamId+path query params reach legacy handler (live)",
  { skip: !LIVE },
  async () => {
    const missing = await get("/v1/sync/versions");
    assert.equal(missing.status, 400);
    assert.match(errorMessage(missing.body), /teamId is required/i);

    const withParams = await get(
      `/v1/sync/versions?teamId=${encodeURIComponent(TEAM_ID)}&path=${encodeURIComponent("smoke.md")}`,
    );
    assert.ok(
      !/teamId is required/i.test(errorMessage(withParams.body)),
      "teamId/path query params were dropped before the legacy handler",
    );
  },
);
