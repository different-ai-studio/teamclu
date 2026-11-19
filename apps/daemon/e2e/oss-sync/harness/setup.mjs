import { randomUUID } from "node:crypto";
import * as fc from "./fc-client.mjs";
import * as dc from "./daemon-client.mjs";
import { composeUp, composeDown, lsContentRoot, publishedPort } from "./docker.mjs";
import { genTeamSecret } from "./secret.mjs";

function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing env ${name} (see .env.local.example)`);
  }
  return v;
}

/**
 * The owner that creates each scenario's team.
 *
 * With OSS_E2E_OWNER_EMAIL + OSS_E2E_OWNER_PASSWORD set (CI), sign in as that
 * pre-provisioned account; every scenario still gets its own fresh team.
 * Otherwise sign up a throwaway account, which only yields a session when the
 * target's GoTrue auto-confirms email (ENABLE_EMAIL_AUTOCONFIRM=true, as on a
 * local stack from deploy/self-host/.env.local.example).
 */
async function ownerTokenFor(base, stamp) {
  const email = process.env.OSS_E2E_OWNER_EMAIL;
  const password = process.env.OSS_E2E_OWNER_PASSWORD;
  if (email && password) return fc.signin(base, email, password);
  return fc.signup(base, `oss-e2e-owner-${stamp}@example.com`, `OssE2e!${stamp}aA`);
}

/**
 * Spin up 2 (or 3) amuxd nodes on one throwaway cloud team.
 *
 * Knowledge sync is plaintext now (ADR-0008): a team secret is NOT required.
 * Pass `{ withSecret: true }` only when a scenario explicitly needs one.
 */
export async function provisionTwoNodeTeam({ threeNode = false, withSecret = false } = {}) {
  const base = env("CLOUD_API_URL", "https://api.teamclu-dev.ucar.cc");
  const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const ownerToken = await ownerTokenFor(base, stamp);

  const teamName = `e2e-oss-${stamp}`;
  const teamId = await fc.createTeam(base, ownerToken, teamName);

  const services = threeNode ? ["node-a", "node-b", "node-c"] : ["node-a", "node-b"];

  await composeUp(threeNode ? ["three-node"] : []);

  const secret = withSecret ? genTeamSecret() : null;
  const nodes = {};
  for (const svc of services) {
    const invite = await fc.createAgentInvite(base, ownerToken, teamId, svc);
    // Discover the ephemeral host port compose assigned this container's 8787.
    const hostPort = await publishedPort(svc);
    const node = dc.nodeHandle(svc, hostPort);
    await dc.initNode(node, invite);
    if (node.teamId !== teamId) {
      throw new Error(`node ${svc} joined ${node.teamId}, expected ${teamId}`);
    }
    await dc.injectHttp(node);
    await dc.start(node);
    await dc.exchange(node);
    if (secret) await dc.setSecret(node, secret);
    await dc.link(node);
    // Deterministic sync timeline for conflict scenarios (see disableAutoSync).
    await dc.disableAutoSync(node);
    nodes[svc.replace("node-", "")] = node; // a / b / c
  }

  async function teardown() {
    for (const svc of services) {
      const n = nodes[svc.replace("node-", "")];
      if (n?.actorId) await fc.removeActor(base, ownerToken, teamId, n.actorId);
    }
    await composeDown();
  }

  return { base, ownerToken, teamId, secret, nodes, teardown, lsContentRoot };
}
