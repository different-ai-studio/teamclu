#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const requireFromFc = createRequire(new URL("../../../services/fc/package.json", import.meta.url));
const mqtt = requireFromFc("mqtt");

const apiBase = required("CLOUD_API_BASE_URL").replace(/\/$/, "");
const authBase = required("SUPABASE_PUBLIC_URL").replace(/\/$/, "");
const serviceRole = required("SUPABASE_SERVICE_ROLE_KEY");
const cronSecret = required("APP_CRON_SECRET");
const stamp = Date.now();
const users = [];
const orgs = [];
const apps = [];
let ownerToken = "";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function pathKey(path) {
  return Buffer.from(path, "utf8").toString("base64url");
}

async function request(base, path, { token, admin = false, ...init } = {}) {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof Uint8Array) && init.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (admin) {
    headers.set("apikey", serviceRole);
    headers.set("authorization", `Bearer ${serviceRole}`);
  } else if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

async function expectStatus(call, statuses, label) {
  const result = await call;
  assert.ok(statuses.includes(result.response.status), `${label}: HTTP ${result.response.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

async function createIdentity(suffix) {
  const email = `belayo-e2e-${stamp}-${suffix}@example.test`;
  const password = `Belayo-${stamp}-${suffix}-Aa1!`;
  const user = await expectStatus(request(authBase, "/auth/v1/admin/users", {
    method: "POST", admin: true,
    body: JSON.stringify({ email, password, email_confirm: true }),
  }), [200], `create ${suffix} user`);
  users.push(user.id);
  // Belayo shares saas-mono's public.users/public.orgs tenancy tables. The
  // normal Web SSO registration path creates these rows before TeamClu's login
  // bootstrap; GoTrue's admin test-user endpoint deliberately does not.
  const orgRows = await expectStatus(request(authBase, "/rest/v1/orgs", {
    method: "POST", admin: true,
    headers: { prefer: "return=representation" },
    body: JSON.stringify({ name: `Belayo E2E ${stamp} ${suffix}` }),
  }), [201], `create ${suffix} org`);
  const orgId = orgRows[0].id;
  orgs.push(orgId);
  await expectStatus(request(authBase, "/rest/v1/users", {
    method: "POST", admin: true,
    body: JSON.stringify({ id: user.id, auth_user_id: user.id, org_id: orgId, email, mobile: "", nickname: suffix }),
  }), [201], `create ${suffix} tenant user`);
  const session = await expectStatus(request(authBase, "/auth/v1/token?grant_type=password", {
    method: "POST", admin: true,
    body: JSON.stringify({ email, password }),
  }), [200], `login ${suffix} user`);
  return { userId: user.id, accessToken: session.access_token, refreshToken: session.refresh_token };
}

async function mqttRoundTrip(url, username, password, teamId) {
  const topic = `amux/${teamId}/smoke/${crypto.randomUUID()}`;
  const payload = `belayo-${stamp}`;
  await new Promise((resolve, reject) => {
    const client = mqtt.connect(url, {
      username,
      password,
      clientId: `belayo-e2e-${crypto.randomUUID()}`,
      reconnectPeriod: 0,
      connectTimeout: 15_000,
      rejectUnauthorized: true,
    });
    const timer = setTimeout(() => finish(new Error("MQTT roundtrip timeout")), 20_000);
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end(true, {}, () => error ? reject(error) : resolve());
    }
    client.on("error", finish);
    client.on("connect", () => client.subscribe(topic, { qos: 1 }, (error) => {
      if (error) return finish(error);
      client.publish(topic, payload, { qos: 1 }, (publishError) => publishError && finish(publishError));
    }));
    client.on("message", (seenTopic, bytes) => {
      if (seenTopic === topic && bytes.toString() === payload) finish();
    });
  });
}

async function buildArtifact() {
  const dir = mkdtempSync(join(tmpdir(), "belayo-app-e2e-"));
  const source = `const http=require("http");const port=Number(process.env.PORT||9000);http.createServer((q,s)=>{s.setHeader("content-type","application/json");s.end(JSON.stringify({ok:true,path:q.url}))}).listen(port,"0.0.0.0");`;
  writeFileSync(join(dir, "index.js"), source);
  execFileSync("zip", ["-q", "code.zip", "index.js"], { cwd: dir });
  return { dir, bytes: readFileSync(join(dir, "code.zip")) };
}

try {
  const publicConfig = await expectStatus(request(apiBase, "/v1/config/public"), [200], "public config");
  assert.ok(publicConfig.features, "public config has no features");

  const owner = await createIdentity("owner");
  const outsider = await createIdentity("outsider");

  const refreshed = await expectStatus(request(apiBase, "/v1/auth/refresh", {
    method: "POST", body: JSON.stringify({ refreshToken: owner.refreshToken }),
  }), [200], "refresh");
  ownerToken = refreshed.accessToken;

  const team = await expectStatus(request(apiBase, "/v1/teams/bootstrap", {
    method: "POST", token: ownerToken, body: JSON.stringify({ displayName: "Belayo E2E" }),
  }), [200], "owner bootstrap");
  const outsiderTeam = await expectStatus(request(apiBase, "/v1/teams/bootstrap", {
    method: "POST", token: outsider.accessToken, body: JSON.stringify({ displayName: "Belayo Outsider" }),
  }), [200], "outsider bootstrap");
  assert.notEqual(team.id, outsiderTeam.id, "RLS test users unexpectedly share one team");

  const actor = await expectStatus(request(apiBase,
    `/v1/directory/current-member-actor?teamId=${encodeURIComponent(team.id)}&userId=${encodeURIComponent(owner.userId)}`,
    { token: ownerToken }), [200], "resolve actor");
  assert.ok(actor?.id, "owner actor was not resolved");

  const session = await expectStatus(request(apiBase, "/v1/sessions", {
    method: "POST", token: ownerToken,
    body: JSON.stringify({ teamId: team.id, title: `belayo-e2e-${stamp}`, mode: "solo" }),
  }), [201], "create session");
  const messageId = crypto.randomUUID();
  await expectStatus(request(apiBase, `/v1/sessions/${session.id}/messages`, {
    method: "POST", token: ownerToken,
    headers: { "idempotency-key": messageId },
    body: JSON.stringify({ id: messageId, teamId: team.id, senderActorId: actor.id, content: "belayo production smoke" }),
  }), [200], "insert message");
  const messages = await expectStatus(request(apiBase, `/v1/sessions/${session.id}/messages`, {
    token: ownerToken,
  }), [200], "list messages");
  assert.ok(messages.items.some((item) => item.id === messageId), "inserted message missing");

  const hidden = await request(apiBase, `/v1/sessions/${session.id}?teamId=${encodeURIComponent(team.id)}`, {
    token: outsider.accessToken,
  });
  assert.ok([403, 404].includes(hidden.response.status), `RLS leak: outsider received HTTP ${hidden.response.status}`);

  const bootstrap = await expectStatus(request(apiBase, "/v1/config/bootstrap", { token: ownerToken }), [200], "bootstrap config");
  assert.equal(bootstrap.mqtt?.url, "wss://mqtt.service.ucar.cc/mqtt");
  assert.equal(bootstrap.mqtt?.tcpUrl, "mqtt://transport.service.ucar.cc:1883");
  await mqttRoundTrip(bootstrap.mqtt.url, actor.id, ownerToken, team.id);

  const repoApp = await expectStatus(request(apiBase, "/v1/apps", {
    method: "POST", token: ownerToken,
    body: JSON.stringify({ teamId: team.id, name: `belayo-gitea-${stamp}`, type: "static_web", visibility: "personal" }),
  }), [201], "Gitea app provisioning");
  apps.push(repoApp.id);
  assert.equal(repoApp.provisionStatus, "repo_created");
  assert.equal(repoApp.gitAuthKind, "gitea_deploy_key");

  const liveApp = await expectStatus(request(apiBase, "/v1/apps", {
    method: "POST", token: ownerToken,
    body: JSON.stringify({ teamId: team.id, name: `belayo-live-${stamp}`, type: "static_web", visibility: "personal", localOnly: true }),
  }), [201], "local app creation");
  apps.push(liveApp.id);
  assert.equal(liveApp.provisionStatus, "ready");

  // Keep this one segment: the API route intentionally takes one encoded path
  // parameter, and some edge proxies normalize encoded slashes before Hono can
  // decode them. Folder behavior has separate repository tests.
  const objectPath = `smoke-${stamp}.txt`;
  const signedUpload = await expectStatus(request(apiBase, `/v1/apps/${liveApp.id}/storage/sign-upload`, {
    method: "POST", token: ownerToken,
    body: JSON.stringify({ path: objectPath, contentType: "text/plain" }),
  }), [200], "OSS sign upload");
  const objectBytes = new TextEncoder().encode(`belayo-oss-${stamp}`);
  const put = await fetch(signedUpload.url, { method: "PUT", headers: { "content-type": "text/plain" }, body: objectBytes });
  assert.ok(put.ok, `OSS PUT failed: HTTP ${put.status}`);
  const listedAfterPut = await expectStatus(request(apiBase, `/v1/apps/${liveApp.id}/storage/objects`, {
    token: ownerToken,
  }), [200], "OSS list after upload");
  if (!listedAfterPut.items.some((item) => item.path === objectPath || item.key === objectPath)) {
    console.error(JSON.stringify({
      diagnostic: "oss-object-not-visible-after-put",
      uploadOrigin: new URL(signedUpload.url).origin,
      putStatus: put.status,
      putRedirected: put.redirected,
      listedPaths: listedAfterPut.items.map((item) => item.path ?? item.key).filter(Boolean),
    }));
  }
  let signedDownloadResult;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    signedDownloadResult = await request(apiBase,
      `/v1/apps/${liveApp.id}/storage/objects/${pathKey(objectPath)}/url`,
      { token: ownerToken });
    if (signedDownloadResult.response.status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const signedDownload = await expectStatus(Promise.resolve(signedDownloadResult), [200], "OSS sign download");
  const downloaded = await fetch(signedDownload.url);
  assert.ok(downloaded.ok, `OSS GET failed: HTTP ${downloaded.status}`);
  assert.equal(await downloaded.text(), new TextDecoder().decode(objectBytes));
  await expectStatus(request(apiBase, `/v1/apps/${liveApp.id}/storage/objects/${pathKey(objectPath)}`, {
    method: "DELETE", token: ownerToken,
  }), [200], "OSS delete");

  const deploy = await expectStatus(request(apiBase, `/v1/apps/${liveApp.id}/deploy`, {
    method: "POST", token: ownerToken, body: JSON.stringify({ runtime: "node" }),
  }), [202], "start app deploy");
  assert.ok(deploy.presignedPut && deploy.deployToken, "deploy did not return upload credentials");
  const artifact = await buildArtifact();
  try {
    const upload = await fetch(deploy.presignedPut, { method: "PUT", body: artifact.bytes });
    assert.ok(upload.ok, `artifact upload failed: HTTP ${upload.status}`);
  } finally {
    rmSync(artifact.dir, { recursive: true, force: true });
  }
  const finalized = await expectStatus(request(apiBase, `/v1/apps/${liveApp.id}/deploy/finalize`, {
    method: "POST", token: ownerToken,
    body: JSON.stringify({
      deployToken: deploy.deployToken,
      declaration: {
        build: { kind: "node", output: "." },
        start: { fcRuntime: "custom.debian12", command: ["/opt/nodejs20/bin/node"], args: ["index.js"], port: 9000, healthCheckPath: "/healthz" },
      },
    }),
  }), [200], "finalize app deploy");
  assert.equal(finalized.fcStatus, "live");
  assert.ok(finalized.fcEndpoint, "live app has no endpoint");
  const appHealth = await fetch(`${finalized.fcEndpoint.replace(/\/$/, "")}/healthz`);
  assert.ok(appHealth.ok, `deployed app health failed: HTTP ${appHealth.status}`);

  const job = await expectStatus(request(apiBase, `/v1/apps/${liveApp.id}/cron-jobs`, {
    method: "POST", token: ownerToken,
    body: JSON.stringify({ name: "belayo-e2e", enabled: true, schedule: "* * * * *", timezone: "UTC", method: "GET", path: "/healthz", timeoutMs: 10_000 }),
  }), [201], "create cron job");
  let runs = [];
  const deadline = Date.now() + 100_000;
  while (Date.now() < deadline && runs.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const history = await expectStatus(request(apiBase, `/v1/apps/${liveApp.id}/cron-jobs/${job.id}/runs`, {
      token: ownerToken,
    }), [200], "list cron runs");
    runs = history.items;
  }
  assert.equal(runs.length, 1, `expected exactly one scheduled cron run, got ${runs.length}`);
  await expectStatus(request(apiBase, `/v1/apps/${liveApp.id}/cron-jobs/${job.id}`, {
    method: "PATCH", token: ownerToken, body: JSON.stringify({ enabled: false }),
  }), [200], "disable cron job");

  const noDueTick = await expectStatus(request(apiBase, "/v1/internal/app-cron/tick", {
    method: "POST", headers: { authorization: `Bearer ${cronSecret}` }, body: "{}",
  }), [200], "cron tick contract");
  assert.equal(typeof noDueTick.ran, "number");

  console.log(JSON.stringify({
    ok: true,
    checks: ["public-config", "login-refresh", "team-bootstrap", "session-message", "rls", "mqtt-wss", "gitea-provision", "oss-roundtrip", "app-fc-deploy", "cron-single-run", "cron-tick"],
  }));
} finally {
  for (const appId of apps.reverse()) {
    if (!ownerToken) break;
    await request(apiBase, `/v1/apps/${appId}`, { method: "DELETE", token: ownerToken }).catch(() => {});
  }
  for (const userId of users.reverse()) {
    await request(authBase, `/rest/v1/users?id=eq.${encodeURIComponent(userId)}`, { method: "DELETE", admin: true }).catch(() => {});
    await request(authBase, `/auth/v1/admin/users/${userId}`, { method: "DELETE", admin: true }).catch(() => {});
  }
  for (const orgId of orgs.reverse()) {
    await request(authBase, `/rest/v1/orgs?id=eq.${encodeURIComponent(orgId)}`, { method: "DELETE", admin: true }).catch(() => {});
  }
}
