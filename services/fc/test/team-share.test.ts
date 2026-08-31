import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { ApiError } from "../src/lib/http-utils.js";

function makeRepo(overrides: any = {}) {
  const calls = [];
  const repo = {
    calls,
    async getWorkspaceConfig(teamId) {
      calls.push({ method: "getWorkspaceConfig", teamId });
      if (overrides.getWorkspaceConfigError) throw overrides.getWorkspaceConfigError;
      return overrides.getWorkspaceConfigResult ?? {
        syncMode: "oss",
        litellmTeamId: "lt-1",
        llm: {
          enabled: true,
          baseUrl: "https://proxy.example.com/v1",
          models: [{ id: "gpt-4o", name: "GPT-4o" }],
          aiGatewayEndpoint: "https://ai.example.com/v1",
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
    async setupLiteLlm(teamId) {
      calls.push({ method: "setupLiteLlm", teamId });
      if (overrides.setupLiteLlmError) throw overrides.setupLiteLlmError;
      return overrides.setupLiteLlmResult ?? {
        aiGatewayEndpoint: "https://gw.example.com",
        litellmKey: "sk-test",
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
    litellmTeamId: "lt-1",
    llm: {
      enabled: true,
      baseUrl: "https://proxy.example.com/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
      aiGatewayEndpoint: "https://ai.example.com/v1",
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
