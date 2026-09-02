import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { ApiError } from "../src/lib/http-utils.js";
import { requestOrigin } from "../src/lib/team-llm-defaults.js";

function makeRepo(overrides: any = {}) {
  const calls = [];
  const repo = {
    calls,
    async getWorkspaceConfig(teamId) {
      calls.push({ method: "getWorkspaceConfig", teamId });
      if (overrides.getWorkspaceConfigError) throw overrides.getWorkspaceConfigError;
      return overrides.getWorkspaceConfigResult ?? {
        syncMode: "oss",
        llm: {
          enabled: true,
          baseUrl: "https://proxy.example.com/v1",
          models: [{ id: "gpt-4o", name: "GPT-4o" }],
        },
      };
    },
    async setLlmConfig(teamId, input) {
      calls.push({ method: "setLlmConfig", teamId, input });
      if (overrides.setLlmConfigError) throw overrides.setLlmConfigError;
      return overrides.setLlmConfigResult ?? {
        enabled: input.enabled,
        baseUrl: input.baseUrl,
        models: input.models,
      };
    },
  };
  return repo;
}

function bearerHeaders() {
  return { Authorization: "Bearer test-token", "X-Request-Id": "req_share_test1" };
}

test("GET /v1/teams/:id/workspace-config → 200 with merged shape", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/workspace-config",
    headers: bearerHeaders(),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, {
    syncMode: "oss",
    llm: {
      enabled: true,
      baseUrl: "https://proxy.example.com/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    },
  });
});

test("PUT /v1/teams/:id/llm-config → 200 persists config", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/teams/team-1/llm-config",
    headers: bearerHeaders(),
    body: JSON.stringify({
      enabled: true,
      baseUrl: "https://proxy.example.com/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, {
    enabled: true,
    baseUrl: "https://proxy.example.com/v1",
    models: [{ id: "gpt-4o", name: "GPT-4o" }],
  });
  assert.deepEqual(repo.calls[0], {
    method: "setLlmConfig",
    teamId: "team-1",
    input: { enabled: true, baseUrl: "https://proxy.example.com/v1", models: [{ id: "gpt-4o", name: "GPT-4o" }] },
  });
});

test("PUT /v1/teams/:id/llm-config null baseUrl + empty models → 200", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/teams/team-1/llm-config",
    headers: bearerHeaders(),
    body: JSON.stringify({ enabled: false, baseUrl: null, models: [] }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.enabled, false);
  assert.equal(body.baseUrl, null);
  assert.deepEqual(body.models, []);
});

test("PUT /v1/teams/:id/llm-config non-boolean enabled → 400", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/teams/team-1/llm-config",
    headers: bearerHeaders(),
    body: JSON.stringify({ enabled: "yes", baseUrl: null, models: [] }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, "validation_failed");
  assert.equal(repo.calls.length, 0);
});

test("PUT /v1/teams/:id/llm-config models not array → 400", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/teams/team-1/llm-config",
    headers: bearerHeaders(),
    body: JSON.stringify({ enabled: true, baseUrl: null, models: "gpt" }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, "validation_failed");
  assert.equal(repo.calls.length, 0);
});

test("PUT /v1/teams/:id/llm-config malformed model entry → 400", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/teams/team-1/llm-config",
    headers: bearerHeaders(),
    body: JSON.stringify({ enabled: true, baseUrl: null, models: [{ id: "gpt-4o" }] }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, "validation_failed");
  assert.equal(repo.calls.length, 0);
});

// ── Default gateway for unconfigured teams (team-llm-defaults.ts) ──────────

const GATEWAY_ENV_KEYS = ["AI_GATEWAY_INTERNAL_URL", "AI_GATEWAY_SERVICE_TOKEN"] as const;

async function withGatewayEnv(configured: boolean, fn: () => Promise<void>) {
  const saved = GATEWAY_ENV_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of GATEWAY_ENV_KEYS) delete process.env[k];
  if (configured) {
    process.env.AI_GATEWAY_INTERNAL_URL = "http://ai-gateway:4001";
    process.env.AI_GATEWAY_SERVICE_TOKEN = "svc-token";
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const FRESH_LLM = { enabled: false, baseUrl: null, models: [] };

function forwardedHeaders(extra: Record<string, string> = {}) {
  return {
    ...bearerHeaders(),
    "X-Forwarded-Host": "api.example.com",
    "X-Forwarded-Proto": "https",
    ...extra,
  };
}

test("GET workspace-config: a team with no gateway config is served this deployment's own", async () => {
  await withGatewayEnv(true, async () => {
    const repo = makeRepo({
      getWorkspaceConfigResult: { syncMode: null, litellmTeamId: null, llm: FRESH_LLM },
    });
    const res = await handleBusinessApiRequest({
      httpMethod: "GET",
      path: "/v1/teams/team-1/workspace-config",
      headers: forwardedHeaders(),
    }, { createRepository: () => repo });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      syncMode: null,
      litellmTeamId: null,
      llm: {
        enabled: true,
        baseUrl: "https://api.example.com/ai/v1/teams/team-1",
        models: [
          { id: "default", name: "标准" },
          { id: "pro", name: "高级" },
          { id: "max", name: "旗舰" },
        ],
      },
    });
  });
});

test("GET workspace-config: enabled-without-baseUrl is unusable, so it is defaulted too", async () => {
  await withGatewayEnv(true, async () => {
    const repo = makeRepo({
      getWorkspaceConfigResult: {
        syncMode: "oss",
        llm: { enabled: true, baseUrl: null, models: [{ id: "stale", name: "Stale" }] },
      },
    });
    const res = await handleBusinessApiRequest({
      httpMethod: "GET",
      path: "/v1/teams/team%2Fodd/workspace-config",
      headers: forwardedHeaders(),
    }, { createRepository: () => repo });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.llm.enabled, true);
    // The team id is encoded into the path, never spliced raw.
    assert.equal(body.llm.baseUrl, "https://api.example.com/ai/v1/teams/team%2Fodd");
    assert.deepEqual(body.llm.models.map((m) => m.id), ["default", "pro", "max"]);
  });
});

test("GET workspace-config: a stored baseUrl stands, even with the team switched off", async () => {
  await withGatewayEnv(true, async () => {
    const stored = { enabled: false, baseUrl: "https://proxy.example.com/v1", models: [] };
    const repo = makeRepo({ getWorkspaceConfigResult: { syncMode: null, llm: stored } });
    const res = await handleBusinessApiRequest({
      httpMethod: "GET",
      path: "/v1/teams/team-1/workspace-config",
      headers: forwardedHeaders(),
    }, { createRepository: () => repo });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).llm, stored);
  });
});

test("GET workspace-config: no default when this deployment runs no gateway", async () => {
  await withGatewayEnv(false, async () => {
    const repo = makeRepo({ getWorkspaceConfigResult: { syncMode: null, llm: FRESH_LLM } });
    const res = await handleBusinessApiRequest({
      httpMethod: "GET",
      path: "/v1/teams/team-1/workspace-config",
      headers: forwardedHeaders(),
    }, { createRepository: () => repo });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).llm, FRESH_LLM);
  });
});

test("GET workspace-config: no default without a usable request host", async () => {
  await withGatewayEnv(true, async () => {
    const repo = makeRepo({ getWorkspaceConfigResult: { syncMode: null, llm: FRESH_LLM } });
    const res = await handleBusinessApiRequest({
      httpMethod: "GET",
      path: "/v1/teams/team-1/workspace-config",
      headers: forwardedHeaders({ "X-Forwarded-Host": "not a host" }),
    }, { createRepository: () => repo });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).llm, FRESH_LLM);
  });
});

test("requestOrigin: first forwarded hop wins, Host is the fallback, junk is refused", () => {
  const h = (m: Record<string, string>) => (name: string) => m[name.toLowerCase()];
  assert.equal(
    requestOrigin(h({ "x-forwarded-host": "api.example.com, edge.internal", "x-forwarded-proto": "https, http" })),
    "https://api.example.com",
  );
  assert.equal(requestOrigin(h({ host: "fc.local:9000" })), "https://fc.local:9000");
  assert.equal(requestOrigin(h({ host: "fc.local", "x-forwarded-proto": "http" })), "http://fc.local");
  assert.equal(requestOrigin(h({})), null);
  assert.equal(requestOrigin(h({ host: "[::1]:9000" })), null);
  assert.equal(requestOrigin(h({ host: "api.example.com/evil" })), null);
  assert.equal(requestOrigin(h({ host: "api.example.com", "x-forwarded-proto": "ftp" })), null);
});
