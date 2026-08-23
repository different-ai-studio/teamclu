import assert from "node:assert/strict";
import test from "node:test";
import {
  mintAgentManagementGrant,
  verifyAgentManagementGrant,
} from "../src/lib/agent-management-grant.js";
import { registerActors } from "../src/lib/routes/actors.js";

function managementRoute(method: string, path: string) {
  const routes: Array<[string, string, Function]> = [];
  const router = {
    get: (p, h) => routes.push(["GET", p, h]),
    put: (p, h) => routes.push(["PUT", p, h]),
    post: (p, h) => routes.push(["POST", p, h]),
    patch: (p, h) => routes.push(["PATCH", p, h]),
    delete: (p, h) => routes.push(["DELETE", p, h]),
  };
  registerActors(router);
  const route = routes.find(([m, p]) => m === method && p === path);
  if (!route) throw new Error(`route not registered: ${method} ${path}`);
  return route[2];
}

const SECRET = "test-agent-management-secret-at-least-32-bytes";

test("agent management grant binds requester, target, team and scopes", async () => {
  const previous = process.env.AGENT_MANAGEMENT_GRANT_SECRET;
  process.env.AGENT_MANAGEMENT_GRANT_SECRET = SECRET;
  try {
    const { grant } = await mintAgentManagementGrant({
      teamId: "team-1",
      requesterActorId: "member-1",
      targetAgentId: "agent-1",
      scopes: ["skills:list", "skills:install"],
      nonce: "nonce-1",
    });
    assert.deepEqual(await verifyAgentManagementGrant(grant), {
      teamId: "team-1",
      requesterActorId: "member-1",
      targetAgentId: "agent-1",
      scopes: ["skills:list", "skills:install"],
      nonce: "nonce-1",
    });
    await assert.rejects(
      verifyAgentManagementGrant(`${grant.slice(0, -1)}x`),
      /invalid or expired/,
    );
  } finally {
    if (previous === undefined) delete process.env.AGENT_MANAGEMENT_GRANT_SECRET;
    else process.env.AGENT_MANAGEMENT_GRANT_SECRET = previous;
  }
});

test("agent management grants fail closed without a configured signing secret", async () => {
  const previous = process.env.AGENT_MANAGEMENT_GRANT_SECRET;
  const previousExternal = process.env.TRUSTED_EXTERNAL_JWT_SECRET;
  delete process.env.AGENT_MANAGEMENT_GRANT_SECRET;
  // The external-IdP HMAC must NOT stand in for the grant key: whoever can mint
  // trusted-external login JWTs would otherwise be able to mint management
  // grants for every Agent in every team.
  process.env.TRUSTED_EXTERNAL_JWT_SECRET = "trusted-external-secret-at-least-32-bytes";
  try {
    await assert.rejects(
      mintAgentManagementGrant({
        teamId: "team-1",
        requesterActorId: "member-1",
        targetAgentId: "agent-1",
        scopes: ["skills:list"],
        nonce: "nonce-1",
      }),
      /signing is not configured/,
    );
  } finally {
    if (previous !== undefined) process.env.AGENT_MANAGEMENT_GRANT_SECRET = previous;
    if (previousExternal === undefined) delete process.env.TRUSTED_EXTERNAL_JWT_SECRET;
    else process.env.TRUSTED_EXTERNAL_JWT_SECRET = previousExternal;
  }
});

test("management grant route authorizes the caller and binds the target", async () => {
  const previous = process.env.AGENT_MANAGEMENT_GRANT_SECRET;
  process.env.AGENT_MANAGEMENT_GRANT_SECRET = SECRET;
  try {
    const handler = managementRoute("POST", "/v1/agents/:agentActorId/management-grants");
    const response = await handler({
      params: { agentActorId: "agent%2Fone" },
      json: { teamId: "team-1", scopes: ["skills:install"] },
      repository: {
        authorizeAgentManagement: async (agentId: string, teamId: string) => {
          assert.equal(agentId, "agent/one");
          assert.equal(teamId, "team-1");
          return { teamId: "team-1", requesterActorId: "member-1" };
        },
      },
    });
    const claims = await verifyAgentManagementGrant(response.body.grant);
    assert.equal(claims.targetAgentId, "agent/one");
    assert.equal(claims.requesterActorId, "member-1");
    assert.deepEqual(claims.scopes, ["skills:install"]);
    // The nonce is handed back so the requester can use it as the RPC request
    // id — the grant is refused on any other id.
    assert.equal(response.body.nonce, claims.nonce);
  } finally {
    if (previous === undefined) delete process.env.AGENT_MANAGEMENT_GRANT_SECRET;
    else process.env.AGENT_MANAGEMENT_GRANT_SECRET = previous;
  }
});

test("target Agent is the only caller allowed to verify a management grant", async () => {
  const previous = process.env.AGENT_MANAGEMENT_GRANT_SECRET;
  process.env.AGENT_MANAGEMENT_GRANT_SECRET = SECRET;
  try {
    const grant = await mintAgentManagementGrant({
      teamId: "team-1",
      requesterActorId: "member-1",
      targetAgentId: "agent-1",
      scopes: ["skills:uninstall"],
      nonce: "nonce-route",
    });
    const handler = managementRoute("POST", "/v1/agents/:agentActorId/management-grants/verify");
    await assert.rejects(
      handler({
        params: { agentActorId: "agent-1" },
        json: {
          grant: grant.grant,
          scope: "skills:uninstall",
          requesterActorId: "member-1",
          requestId: "nonce-route",
        },
        repository: { resolveCallerActorForTeam: async () => ({ id: "other-agent" }) },
      }),
      /only the target agent/i,
    );
  } finally {
    if (previous === undefined) delete process.env.AGENT_MANAGEMENT_GRANT_SECRET;
    else process.env.AGENT_MANAGEMENT_GRANT_SECRET = previous;
  }
});

test("a management grant is refused on any request id but the one it was minted for", async () => {
  const previous = process.env.AGENT_MANAGEMENT_GRANT_SECRET;
  process.env.AGENT_MANAGEMENT_GRANT_SECRET = SECRET;
  try {
    const grant = await mintAgentManagementGrant({
      teamId: "team-1",
      requesterActorId: "member-1",
      targetAgentId: "agent-1",
      scopes: ["skills:install"],
      nonce: "request-a",
    });
    const handler = managementRoute("POST", "/v1/agents/:agentActorId/management-grants/verify");
    const repository = { resolveCallerActorForTeam: async () => ({ id: "agent-1" }) };

    // Spent on the id it was minted for: fine.
    const ok = await handler({
      params: { agentActorId: "agent-1" },
      json: {
        grant: grant.grant,
        scope: "skills:install",
        requesterActorId: "member-1",
        requestId: "request-a",
      },
      repository,
    });
    assert.equal(ok.body.valid, true);

    // Replayed onto a fresh request id — a second install off one captured
    // grant — is exactly what this rejects.
    await assert.rejects(
      handler({
        params: { agentActorId: "agent-1" },
        json: {
          grant: grant.grant,
          scope: "skills:install",
          requesterActorId: "member-1",
          requestId: "request-b",
        },
        repository,
      }),
      /does not match this request/,
    );
  } finally {
    if (previous === undefined) delete process.env.AGENT_MANAGEMENT_GRANT_SECRET;
    else process.env.AGENT_MANAGEMENT_GRANT_SECRET = previous;
  }
});

test("minting a grant requires a team so explicit-access admins resolve", async () => {
  const previous = process.env.AGENT_MANAGEMENT_GRANT_SECRET;
  process.env.AGENT_MANAGEMENT_GRANT_SECRET = SECRET;
  try {
    const handler = managementRoute("POST", "/v1/agents/:agentActorId/management-grants");
    await assert.rejects(
      handler({
        params: { agentActorId: "agent-1" },
        json: { scopes: ["skills:list"] },
        repository: {
          authorizeAgentManagement: async () => {
            throw new Error("authorization must not run without a team");
          },
        },
      }),
      /teamId is required/,
    );
  } finally {
    if (previous === undefined) delete process.env.AGENT_MANAGEMENT_GRANT_SECRET;
    else process.env.AGENT_MANAGEMENT_GRANT_SECRET = previous;
  }
});
