/**
 * Self-host deployment verification tests.
 *
 * Prerequisites:
 *   docker compose up -d   (in deploy/self-host/)
 *
 * Run:
 *   cd services/fc
 *   FC_E2E=1 node --import tsx --test test/self-host-e2e.test.ts
 *
 * Optional env vars:
 *   FC_E2E_BASE_URL   — default: auto-discovered from docker inspect
 *   FC_E2E_KONG_URL   — default: auto-discovered from docker inspect
 *   FC_E2E_ENV_FILE   — path to self-host .env (default: ../../deploy/self-host/.env)
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const E2E = process.env.FC_E2E === "1";

// ── Container IP discovery ─────────────────────────────────────────────────

function containerIp(name: string): string {
  try {
    return execSync(
      `docker inspect ${name} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`,
      { stdio: ["pipe", "pipe", "pipe"] }
    ).toString().trim();
  } catch {
    return "";
  }
}

const FC_BASE = (
  process.env.FC_E2E_BASE_URL ?? `http://${containerIp("teamclaw-self-host-fc-1")}:9000`
).replace(/\/$/, "");

const KONG_BASE = (
  process.env.FC_E2E_KONG_URL ?? `http://${containerIp("supabase-kong")}:8000`
).replace(/\/$/, "");

// ── .env parser ────────────────────────────────────────────────────────────

function parseEnvFile(filePath: string): Record<string, string> {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const result: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      result[key] = val;
    }
    return result;
  } catch {
    return {};
  }
}

const ENV_FILE =
  process.env.FC_E2E_ENV_FILE ??
  resolve(__dirname, "../../../deploy/self-host/.env");
const env = parseEnvFile(ENV_FILE);
const SERVICE_ROLE_KEY = env.SERVICE_ROLE_KEY ?? process.env.SERVICE_ROLE_KEY ?? "";

// ── Shared state (populated in before() hooks) ─────────────────────────────

const state = {
  accessToken: "",
  refreshToken: "",
  userId: "",
  teamId: "",
  teamName: "",
  sessionId: "",
};

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function fcFetch(
  path: string,
  opts: RequestInit & { token?: string } = {}
) {
  const { token, headers: extraHeaders, ...rest } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extraHeaders as Record<string, string> ?? {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${FC_BASE}${path}`, { ...rest, headers });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

async function goFetch(
  path: string,
  opts: RequestInit & { serviceRole?: boolean; token?: string } = {}
) {
  const { serviceRole, token, headers: extraHeaders, ...rest } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extraHeaders as Record<string, string> ?? {}),
  };
  if (serviceRole) {
    headers["apikey"] = SERVICE_ROLE_KEY;
    headers["Authorization"] = `Bearer ${SERVICE_ROLE_KEY}`;
  } else if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`${KONG_BASE}${path}`, { ...rest, headers });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

function isDaemonRunning(): boolean {
  try {
    const out = execSync(
      'docker inspect teamclaw-self-host-amuxd-1 --format "{{.State.Running}}"',
      { stdio: ["pipe", "pipe", "pipe"] }
    )
      .toString()
      .trim();
    return out === "true";
  } catch {
    return false;
  }
}

// ── Global setup / teardown ────────────────────────────────────────────────

const TEST_EMAIL = `e2e-${Date.now()}@selfhost.test`;
const TEST_PASSWORD = `E2ePass-${Date.now()}`;

before(async () => {
  if (!E2E) return;
  assert.ok(SERVICE_ROLE_KEY, "SERVICE_ROLE_KEY must be set (check FC_E2E_ENV_FILE)");
  assert.ok(FC_BASE.includes("://"), `FC_BASE looks invalid: ${FC_BASE}`);
  assert.ok(KONG_BASE.includes("://"), `KONG_BASE looks invalid: ${KONG_BASE}`);

  // Create confirmed test user via GoTrue admin API
  const create = await goFetch("/auth/v1/admin/users", {
    method: "POST",
    serviceRole: true,
    body: JSON.stringify({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    }),
  });
  assert.equal(
    create.status,
    200,
    `Failed to create test user: ${JSON.stringify(create.body)}`
  );
  state.userId = create.body.id;

  // Sign in with email+password to get a session
  const signin = await goFetch("/auth/v1/token?grant_type=password", {
    method: "POST",
    serviceRole: true, // apikey header required by GoTrue
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  assert.equal(
    signin.status,
    200,
    `Failed to sign in: ${JSON.stringify(signin.body)}`
  );
  state.accessToken = signin.body.access_token;
  state.refreshToken = signin.body.refresh_token;
});

after(async () => {
  if (!E2E || !state.userId) return;
  // Delete test user (best-effort)
  await goFetch(`/auth/v1/admin/users/${state.userId}`, {
    method: "DELETE",
    serviceRole: true,
  }).catch(() => {});
});

// ── Suite 1: Auth ──────────────────────────────────────────────────────────

describe("Auth", { skip: !E2E }, () => {
  test("POST /v1/auth/refresh returns new accessToken", async () => {
    const { status, body } = await fcFetch("/v1/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: state.refreshToken }),
    });
    assert.equal(status, 200, `refresh failed: ${JSON.stringify(body)}`);
    assert.equal(typeof body.accessToken, "string", "accessToken must be a string");
    assert.ok(body.accessToken.length > 0, "accessToken must be non-empty");
    assert.equal(typeof body.refreshToken, "string", "refreshToken must be a string");
    // Update state so subsequent suites use the fresh token
    state.accessToken = body.accessToken;
    state.refreshToken = body.refreshToken;
  });
});

// ── Suite 1b: Runtime config ───────────────────────────────────────────────
//
// The deploy gate for issue #634. `/v1/config/bootstrap` omits the whole `mqtt`
// block when MQTT_BROKER_URL is unset or blank, and still answers 200 — so a
// deploy that loses that env var looks completely healthy while every client
// silently ends up with no broker. Fail the deploy instead.
//
// This is now the only automated check between a mis-set MQTT_BROKER_URL and
// clients with no real-time sync: compose derives the value from MQTT_DOMAIN
// rather than refusing to start, so nothing earlier in the pipeline objects.

describe("Runtime config", { skip: !E2E }, () => {
  test("GET /v1/config/bootstrap delivers an MQTT broker", async () => {
    const { status, body } = await fcFetch("/v1/config/bootstrap", {
      token: state.accessToken,
    });
    assert.equal(status, 200, `bootstrap failed: ${JSON.stringify(body)}`);
    assert.ok(
      body.mqtt,
      "bootstrap returned no `mqtt` block — check MQTT_BROKER_URL in the fc " +
        "service's compose `environment:` map"
    );
    assert.equal(typeof body.mqtt.url, "string", "mqtt.url must be a string");
    assert.ok(body.mqtt.url.length > 0, "mqtt.url must be non-empty");
    // Non-empty is not enough. Compose derives the default as
    // `mqtt://${MQTT_DOMAIN}:1883`, so a .env missing MQTT_DOMAIN yields the
    // hostless `mqtt://:1883` — a string that passes every check above and
    // resolves nowhere. Parse it and require a real host.
    let parsed: URL | undefined;
    try {
      parsed = new URL(body.mqtt.url);
    } catch {
      assert.fail(`mqtt.url is not a URL: ${body.mqtt.url}`);
    }
    assert.ok(
      parsed.hostname.length > 0,
      `mqtt.url has no host (${body.mqtt.url}) — MQTT_DOMAIN is probably unset ` +
        "in the box's .env, so compose derived mqtt://:1883"
    );
  });
});

// ── Suite 2: Team lifecycle ────────────────────────────────────────────────

describe("Team lifecycle", { skip: !E2E }, () => {
  state.teamName = `e2e-team-${Date.now()}`;

  test("POST /v1/teams creates a team", async () => {
    const { status, body } = await fcFetch("/v1/teams", {
      method: "POST",
      token: state.accessToken,
      body: JSON.stringify({ name: state.teamName }),
    });
    // teams.ts returns no explicit statusCode so Hono defaults to 200
    assert.ok(
      status === 200 || status === 201,
      `createTeam failed (${status}): ${JSON.stringify(body)}`
    );
    assert.equal(typeof body.id, "string", "team.id must be a string");
    assert.ok(body.id.length > 0, "team.id must be non-empty");
    state.teamId = body.id;
  });

  test("GET /v1/teams?scope=all lists the new team", async () => {
    // scope=all, not the bare listing. The bare one is `list_my_teams_current_org`
    // — teams in the caller's CURRENT org — while createTeam stamps a new team
    // with the caller's JWT org, else DEFAULT_ORG_ID. A fresh signup carries no
    // org claim, so on a deployment with DEFAULT_ORG_ID configured the team
    // lands in the shared org while the caller's own org is elsewhere, and the
    // current-org listing legitimately omits it. scope=all is what real clients
    // use for exactly this reason.
    const { status, body } = await fcFetch("/v1/teams?scope=all", {
      token: state.accessToken,
    });
    assert.equal(status, 200, `listTeams failed: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.items), "items must be an array");
    const found = body.items.some((t: any) => t.id === state.teamId);
    assert.ok(found, `team ${state.teamId} not found in list`);
  });

  test("GET /v1/teams/:id returns correct team", async () => {
    const { status, body } = await fcFetch(`/v1/teams/${state.teamId}`, {
      token: state.accessToken,
    });
    assert.equal(status, 200, `getTeam failed: ${JSON.stringify(body)}`);
    assert.equal(body.id, state.teamId);
    assert.equal(body.name, state.teamName);
  });

  test("POST /v1/teams/:id/invites: token, or upgrade_required in the shared org", async () => {
    const { status, body } = await fcFetch(`/v1/teams/${state.teamId}/invites`, {
      method: "POST",
      token: state.accessToken,
      body: JSON.stringify({ kind: "member", displayName: "E2E Invitee", teamRole: "member" }),
    });

    // A team sitting in DEFAULT_ORG is solo-only by design: you upgrade your
    // account (which moves the team into your own org) before you can invite
    // anyone. Whether this e2e's team lands there depends on the deployment's
    // DEFAULT_ORG_ID — which this process cannot read, because the suite runs
    // outside the fc container that has it. So branch on what the server
    // actually answered, and hold each branch to its full contract.
    if (status === 403) {
      assert.equal(
        body?.error?.code,
        "upgrade_required",
        `the only allowed 403 here is upgrade_required (a DEFAULT_ORG team is ` +
          `solo-only until the account is upgraded): ${JSON.stringify(body)}`,
      );
      return;
    }

    assert.equal(status, 201, `createInvite failed: ${JSON.stringify(body)}`);
    // invite token may be in body.token or body.inviteToken
    const token = body.token ?? body.inviteToken ?? body.invite_token;
    assert.equal(typeof token, "string", `invite token must be a string, got: ${JSON.stringify(body)}`);
    assert.ok(token.length > 0, "invite token must be non-empty");
  });
});

// ── Suite 3: Session + Messages ────────────────────────────────────────────

describe("Session + Messages", { skip: !E2E }, () => {
  const sessionTitle = `e2e-session-${Date.now()}`;

  test("POST /v1/sessions creates a session", async () => {
    const { status, body } = await fcFetch("/v1/sessions", {
      method: "POST",
      token: state.accessToken,
      body: JSON.stringify({
        teamId: state.teamId,
        title: sessionTitle,
        mode: "solo",
      }),
    });
    assert.equal(status, 201, `createSession failed: ${JSON.stringify(body)}`);
    assert.equal(typeof body.id, "string", "session.id must be a string");
    assert.ok(body.id.length > 0);
    state.sessionId = body.id;
  });

  test("GET /v1/sessions/:id returns the session", async () => {
    // teamId is required on session reads: it resolves the caller's actor (one
    // actor row per user per team) and scopes the row server-side.
    const { status, body } = await fcFetch(
      `/v1/sessions/${state.sessionId}?teamId=${encodeURIComponent(state.teamId)}`,
      { token: state.accessToken },
    );
    assert.equal(status, 200, `getSession failed: ${JSON.stringify(body)}`);
    assert.equal(body.id, state.sessionId);
    assert.equal(body.title, sessionTitle);
  });

  test("GET /v1/sessions/:id/messages returns array", async () => {
    const { status, body } = await fcFetch(
      `/v1/sessions/${state.sessionId}/messages`,
      { token: state.accessToken }
    );
    assert.equal(status, 200, `listMessages failed: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.items), "items must be an array");
  });

  test("GET /v1/sync/actor-directory answers for this team (daemon-gated)", async (t) => {
    if (!isDaemonRunning()) {
      t.skip("amuxd container not running — skipping actor directory check");
      return;
    }
    const { status, body } = await fcFetch(
      `/v1/sync/actor-directory?teamId=${encodeURIComponent(state.teamId)}`,
      { token: state.accessToken }
    );
    assert.equal(status, 200, `actorDirectory failed: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.items), "items must be an array");

    // Deliberately NOT asserting a daemon actor is present. This suite creates
    // a brand-new team every run; the box's amuxd is onboarded to its own team
    // and never joins this one, so "is amuxd joined to this team?" could only
    // ever be answered no. The gate checked that the container was running,
    // which is a different question — so the assertion started failing the day
    // amuxd began running on the box (2026-08-06) and blocked every deploy
    // since. What this endpoint owes us here is a well-formed answer for a team
    // the caller belongs to, and that is what is checked.
  });
});

// ── Suite 3b: Linking a session to an app (#1885) ──────────────────────────

describe("Session ↔ app link", { skip: !E2E }, () => {
  // Local-only apps: no Gitea repo is provisioned, so this suite does not
  // depend on the forge. Both are deleted at the end.
  const appIds: string[] = [];

  async function createLocalApp(name: string): Promise<string | null> {
    const { status, body } = await fcFetch("/v1/apps", {
      method: "POST",
      token: state.accessToken,
      body: JSON.stringify({ teamId: state.teamId, name, type: "imported", localOnly: true }),
    });
    // A team created outside an org cannot hold apps; that is createApp's own
    // contract, not this link's.
    if (status === 409 && body?.error?.code === "team_has_no_org") return null;
    assert.equal(status, 201, `createApp failed (${status}): ${JSON.stringify(body)}`);
    appIds.push(body.id);
    return body.id;
  }

  test("POST /v1/sessions/:id/app links the session; the app lists it; relinking is a no-op; another app is 409", async (t) => {
    assert.ok(state.sessionId, "the session suite must have created a session");
    const appId = await createLocalApp(`e2e-link-${Date.now()}`);
    if (!appId) {
      t.skip("team has no org — apps cannot be created here");
      return;
    }

    const link = (id: string) =>
      fcFetch(`/v1/sessions/${state.sessionId}/app`, {
        method: "POST",
        token: state.accessToken,
        body: JSON.stringify({ appId: id }),
      });

    const first = await link(appId);
    assert.equal(first.status, 204, `link failed (${first.status}): ${JSON.stringify(first.body)}`);

    const listed = await fcFetch(`/v1/apps/${appId}/sessions`, { token: state.accessToken });
    assert.equal(listed.status, 200, `listAppSessions failed: ${JSON.stringify(listed.body)}`);
    assert.ok(
      listed.body.items.some((s: any) => s.id === state.sessionId),
      `session ${state.sessionId} not in the app's sessions: ${JSON.stringify(listed.body)}`,
    );

    const again = await link(appId);
    assert.equal(again.status, 204, `relink to the same app must be a no-op: ${JSON.stringify(again.body)}`);

    const otherId = await createLocalApp(`e2e-link-other-${Date.now()}`);
    assert.ok(otherId);
    const moved = await link(otherId!);
    assert.equal(moved.status, 409, `linking to a second app must be refused: ${JSON.stringify(moved.body)}`);
    assert.equal(moved.body?.error?.code, "session_already_linked");
  });

  test("POST /v1/sessions/:id/app is 404 for an app that does not exist", async () => {
    const { status } = await fcFetch(`/v1/sessions/${state.sessionId}/app`, {
      method: "POST",
      token: state.accessToken,
      body: JSON.stringify({ appId: "00000000-0000-4000-8000-000000000000" }),
    });
    // The session already has an app from the test above, which is answered
    // first; on a run where that test skipped, the unknown app is a 404.
    assert.ok(status === 404 || status === 409, `expected 404/409, got ${status}`);
  });

  test("cleanup: delete the apps", async () => {
    for (const id of appIds) {
      const { status } = await fcFetch(`/v1/apps/${id}`, { method: "DELETE", token: state.accessToken });
      assert.ok(status === 200 || status === 204, `deleteApp ${id} answered ${status}`);
    }
  });
});

// ── Suite 4: Storage ───────────────────────────────────────────────────────

describe("Storage", { skip: !E2E }, () => {
  test("image-upload.sh round-trips a PNG byte-for-byte", () => {
    const smokeScript = resolve(
      __dirname,
      "../../../deploy/self-host/smoke/image-upload.sh"
    );
    let stdout = "";
    try {
      stdout = execSync(`sh "${smokeScript}"`, {
        cwd: resolve(__dirname, "../../../deploy/self-host"),
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      }).toString();
    } catch (err: any) {
      const out = err.stdout?.toString() ?? "";
      const errOut = err.stderr?.toString() ?? "";
      assert.fail(`image-upload.sh failed:\nstdout: ${out}\nstderr: ${errOut}`);
    }
    assert.match(stdout, /PASS/, `image-upload.sh did not print PASS:\n${stdout}`);
  });
});
