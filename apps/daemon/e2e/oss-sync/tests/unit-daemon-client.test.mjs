import test from "node:test";
import assert from "node:assert/strict";
import {
  backendTomlPath,
  parseActiveTeam,
  parseBackendIdentity,
  rewriteHttpSection,
} from "../harness/daemon-client.mjs";

test("backendTomlPath maps to per-team state/backend.toml (v2 layout)", () => {
  assert.equal(
    backendTomlPath("6f548068-540e-447e-a01b-cc80a216fa09"),
    "/root/.amuxd/teams/6f548068-540e-447e-a01b-cc80a216fa09/state/backend.toml",
  );
});

test("parseActiveTeam reads active_team from daemon.toml", () => {
  const toml = `# comment\nactive_team = "team-abc"\n[http]\nbind = "0.0.0.0:8787"\n`;
  assert.equal(parseActiveTeam(toml), "team-abc");
});

test("parseActiveTeam returns null when missing", () => {
  assert.equal(parseActiveTeam("[http]\nbind = \"0.0.0.0:8787\"\n"), null);
});

test("parseBackendIdentity reads team_id and actor_id", () => {
  const toml = `
kind = "cloud_api"
team_id = "team-1"
[cloud_api]
actor_id = "actor-9"
refresh_token = "rt"
`;
  assert.deepEqual(parseBackendIdentity(toml), {
    teamId: "team-1",
    actorId: "actor-9",
  });
});

test("rewriteHttpSection replaces an existing [http] table (no duplicate)", () => {
  const before = `active_team = "t1"

[http]
bind = "127.0.0.1:0"
allowed_origins = ["http://localhost:1420"]
default_scopes = ["workspace:read"]

[mqtt]
broker_url = "mqtt://127.0.0.1:1883"
`;
  const out = rewriteHttpSection(before);
  assert.equal((out.match(/\[http\]/g) || []).length, 1, "exactly one [http]");
  assert.match(out, /bind = "0\.0\.0\.0:8787"/);
  assert.match(out, /token_file = "\/root\/\.amuxd\/amuxd\.http\.token"/);
  assert.match(out, /workspace:write/);
  assert.match(out, /\[mqtt\]/);
  assert.match(out, /active_team = "t1"/);
});

test("rewriteHttpSection inserts [http] when missing", () => {
  const before = `active_team = "t1"\n\n[mqtt]\nbroker_url = "x"\n`;
  const out = rewriteHttpSection(before);
  assert.equal((out.match(/\[http\]/g) || []).length, 1);
  assert.match(out, /bind = "0\.0\.0\.0:8787"/);
});
