import test from "node:test";
import assert from "node:assert/strict";
import {
  contentRootPath,
  syncStatePath,
  parsePublishedPort,
  composeProject,
} from "../harness/docker.mjs";

test("contentRootPath maps to the v2 shared sync root", () => {
  // knowledge/ lives directly under shared/ (not shared/teamclu-team/).
  assert.equal(contentRootPath("team-x"), "/root/.amuxd/teams/team-x/shared");
});
test("syncStatePath maps to per-team state", () => {
  assert.equal(syncStatePath("team-x"), "/root/.amuxd/teams/team-x/sync/state.json");
});

test("parsePublishedPort reads the host port from `docker compose port` output", () => {
  assert.equal(parsePublishedPort("127.0.0.1:32769\n"), 32769);
  assert.equal(parsePublishedPort("0.0.0.0:18081"), 18081);
  // IPv6-style and multi-line (compose may print one line per published mapping):
  assert.equal(parsePublishedPort("[::]:49160\n0.0.0.0:49160\n"), 49160);
});

test("parsePublishedPort rejects empty / malformed output", () => {
  assert.throws(() => parsePublishedPort(""), /no published port/);
  assert.throws(() => parsePublishedPort("\n  \n"), /no published port/);
  assert.throws(() => parsePublishedPort("not-a-port"), /bad published port/);
});

test("composeProject is a stable, non-empty per-process project name", () => {
  const p = composeProject();
  assert.ok(p && typeof p === "string", "project name should be a non-empty string");
  assert.equal(p, composeProject(), "project name must be stable within a process");
  assert.match(p, /^amuxd-oss-e2e/, "project name should be namespaced");
});
