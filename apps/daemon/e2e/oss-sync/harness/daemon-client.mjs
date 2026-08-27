import { exec, execSh, execDetached } from "./docker.mjs";
import { postJson, getJson } from "./http.mjs";

const DAEMON_TOML = "/root/.amuxd/daemon.toml";
const TOKEN_FILE = "/root/.amuxd/amuxd.http.token";
const DUMMY_BROKER = "mqtt://127.0.0.1:1883";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** v2: credentials live under teams/<id>/state/, not ~/.amuxd/backend.toml. */
export function backendTomlPath(teamId) {
  return `/root/.amuxd/teams/${teamId}/state/backend.toml`;
}

export function parseActiveTeam(daemonToml) {
  return /(?:^|\n)\s*active_team\s*=\s*"([^"]+)"/.exec(String(daemonToml))?.[1] ?? null;
}

export function parseBackendIdentity(backendToml) {
  const text = String(backendToml);
  return {
    teamId: /team_id\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? null,
    actorId: /actor_id\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? null,
  };
}

/** Fixed [http] block the e2e containers need (compose publishes 8787). */
export function httpSectionForE2e() {
  return [
    "[http]",
    'bind = "0.0.0.0:8787"',
    `token_file = "${TOKEN_FILE}"`,
    'port_file = "/root/.amuxd/amuxd.http.port"',
    "allowed_origins = []",
    'default_scopes = ["workspace:read", "workspace:write"]',
    "",
  ].join("\n");
}

/**
 * Replace any existing [http] table (init now writes one with bind 127.0.0.1:0)
 * so we never append a duplicate table header.
 */
export function rewriteHttpSection(daemonToml) {
  const stripped = String(daemonToml).replace(
    /(?:^|\n)\[http\][^\n]*(?:\n(?!\[[^\]]+\])[^\n]*)*/g,
    "\n",
  );
  return `${stripped.trimEnd()}\n\n${httpSectionForE2e()}\n`;
}

/** node 句柄：{ service, baseUrl, teamId, actorId, session } */
export function nodeHandle(service, hostPort) {
  return { service, baseUrl: `http://127.0.0.1:${hostPort}`, teamId: null, actorId: null, session: null };
}

/** amuxd init <invite>（容器内自领 invite + 写 backend.toml/daemon.toml）。返回 actorId+teamId。 */
export async function initNode(node, inviteToken) {
  const url = `teamclu://invite?token=${inviteToken}&broker=${encodeURIComponent(DUMMY_BROKER)}`;
  const { stdout, stderr } = await exec(node.service, ["amuxd", "init", url]);
  // daemon.toml points at the active team; credentials are under that team's state/.
  const { stdout: daemon } = await execSh(node.service, `cat ${DAEMON_TOML}`);
  const active = parseActiveTeam(daemon);
  if (!active) {
    throw new Error(
      `initNode(${node.service}) missing active_team in daemon.toml:\n${daemon}\n--init stdout--\n${stdout}\n--stderr--\n${stderr}`,
    );
  }
  const { stdout: backend } = await execSh(node.service, `cat ${backendTomlPath(active)}`);
  const { teamId, actorId } = parseBackendIdentity(backend);
  node.teamId = teamId;
  node.actorId = actorId;
  if (!node.teamId || !node.actorId) {
    throw new Error(`initNode(${node.service}) failed to parse backend.toml:\n${backend}\n--init stdout--\n${stdout}\n--stderr--\n${stderr}`);
  }
  return node;
}

/** Rewrite [http] for container e2e (fixed 8787 bind + workspace scopes). */
export async function injectHttp(node) {
  const { stdout: daemon } = await execSh(node.service, `cat ${DAEMON_TOML}`);
  const next = rewriteHttpSection(daemon);
  // Base64 round-trip keeps the rewrite binary-safe through docker exec/sh.
  const b64 = Buffer.from(next, "utf8").toString("base64");
  await execSh(node.service, `printf '%s' '${b64}' | base64 -d > ${DAEMON_TOML}`);
}

/** 后台启动 amuxd，并等待 root token 文件出现。 */
export async function start(node, { timeoutMs = 30000 } = {}) {
  await execDetached(node.service, "amuxd start > /root/amuxd.log 2>&1");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout } = await execSh(node.service, `test -s ${TOKEN_FILE} && echo yes || echo no`);
    if (stdout.trim() === "yes") {
      // 再等 HTTP 真正可用
      try {
        await getJson(`${node.baseUrl}/v1/healthz`, {}, null);
        return;
      } catch {
        /* keep polling until healthz answers */
      }
    }
    await sleep(500);
  }
  const { stdout: log } = await execSh(node.service, `tail -n 40 /root/amuxd.log || true`);
  throw new Error(`start(${node.service}) timed out waiting for HTTP; log:\n${log}`);
}

/** 用 root token 换 session token（workspace:read+write）。 */
export async function exchange(node) {
  const { stdout } = await execSh(node.service, `cat ${TOKEN_FILE}`);
  const root = stdout.trim();
  const out = await postJson(
    `${node.baseUrl}/v1/auth/exchange`,
    { scopes: ["workspace:read", "workspace:write"], ttl_seconds: 86400 },
    root,
  );
  if (!out.token) throw new Error(`exchange(${node.service}) no token: ${JSON.stringify(out)}`);
  node.session = out.token;
  return out.token;
}

export const setSecret = (node, ossTeamSecret) =>
  postJson(`${node.baseUrl}/v1/team/secrets`, { teamId: node.teamId, ossTeamSecret }, node.session);

export const link = (node, path = "/root/workspace") =>
  postJson(`${node.baseUrl}/v1/team/link`, { path }, node.session);

// Transient conditions the daemon surfaces in status.lastError when talking to a
// shared/rate-limited prod FC: rate limiting (429/503), and flaky network blips
// (reqwest "error sending request", connection resets/timeouts, provider errors,
// and the "deferred ... due to rate limiting" message the engine now returns).
const TRANSIENT_RE =
  /429|too many requests|503|temporarily|deferred|error sending request|provider error|connection|timed out|timeout|reset by peer|dns/i;

/**
 * Trigger a sync. The daemon returns HTTP 200 even when its FC calls hit a
 * transient error (it surfaces them in status.lastError), so retry with backoff
 * while lastError looks transient.
 */
export async function sync(node, workspacePath = "/root/workspace", { retries = 6 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const st = await postJson(`${node.baseUrl}/v1/team/sync`, { workspacePath }, node.session);
    const err = st?.lastError ?? "";
    if (err && TRANSIENT_RE.test(err) && attempt < retries) {
      await sleep(Math.min(3000 * 2 ** attempt, 24000));
      continue;
    }
    return st;
  }
}

export const status = (node) =>
  getJson(`${node.baseUrl}/v1/team/sync/status`, { teamId: node.teamId }, node.session);

export const conflicts = (node) =>
  getJson(`${node.baseUrl}/v1/team/conflicts`, { teamId: node.teamId }, node.session);

export const resolve = (node, path, choice) =>
  postJson(`${node.baseUrl}/v1/team/conflicts/resolve`, { teamId: node.teamId, path, choice }, node.session);
