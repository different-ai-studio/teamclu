import assert from "node:assert/strict";
import test from "node:test";

import {
  handleToolExecuteBefore,
  injectSessionIdForTool,
  isSessionScopedTool,
  normalizeSessionScopedToolName,
  resolveTeamcluSessionId,
} from "./session-context-client.mjs";

test("normalizeSessionScopedToolName handles slash and mcp__ forms", () => {
  assert.equal(normalizeSessionScopedToolName("get_session_deeplink"), "get_session_deeplink");
  assert.equal(
    normalizeSessionScopedToolName("teamclu-introspect/get_session_deeplink"),
    "get_session_deeplink",
  );
  assert.equal(
    normalizeSessionScopedToolName("mcp__teamclu-introspect__get_session_deeplink"),
    "get_session_deeplink",
  );
  assert.equal(
    normalizeSessionScopedToolName("mcp__my_server-with_underscores__archive_session"),
    "archive_session",
  );
});

test("isSessionScopedTool recognizes namespaced MCP tool ids", () => {
  assert.equal(isSessionScopedTool("mcp__teamclu-introspect__manage_participants"), true);
  assert.equal(isSessionScopedTool("browser_click"), false);
});

test("handleToolExecuteBefore injects output.args.session_id using OpenCode hook shape", async () => {
  const output = { args: {} };
  await handleToolExecuteBefore(
    { tool: "get_session_deeplink", sessionID: "backend-a", callID: "c1" },
    output,
    {
      injectSessionIdForTool: async () => ({ session_id: "teamclu-a" }),
    },
  );
  assert.equal(output.args.session_id, "teamclu-a");
});

test("concurrent A/B resolve injects distinct TeamClu sessions", async () => {
  const resolver = async (backendSessionId) => {
    if (backendSessionId === "backend-a") return "teamclu-a";
    if (backendSessionId === "backend-b") return "teamclu-b";
    throw new Error("session_context_unavailable");
  };
  const inject = (toolName, args, backendSessionId) =>
    injectSessionIdForTool(toolName, args, backendSessionId, {
      resolveTeamcluSessionId: resolver,
    });

  const results = await Promise.all([
    inject("get_session_deeplink", {}, "backend-a"),
    inject("get_session_deeplink", {}, "backend-b"),
    inject("get_session_deeplink", {}, "backend-a"),
  ]);
  assert.deepEqual(results, [
    { session_id: "teamclu-a" },
    { session_id: "teamclu-b" },
    { session_id: "teamclu-a" },
  ]);
});

test("explicit session_id skips resolver fetch", async () => {
  let called = false;
  const next = await injectSessionIdForTool(
    "get_session_deeplink",
    { session_id: "explicit-id" },
    "backend-a",
    {
      resolveTeamcluSessionId: async () => {
        called = true;
        return "ignored";
      },
    },
  );
  assert.equal(next.session_id, "explicit-id");
  assert.equal(called, false);
});

test("non allowlist tools leave args unchanged and skip fetch", async () => {
  let called = false;
  const args = { foo: 1 };
  const next = await injectSessionIdForTool("browser_click", args, "backend-a", {
    resolveTeamcluSessionId: async () => {
      called = true;
      return "ignored";
    },
  });
  assert.deepEqual(next, args);
  assert.equal(called, false);
});

test("resolver HTTP failures fail closed", async () => {
  for (const status of [401, 404, 409, 500]) {
    await assert.rejects(
      () =>
        resolveTeamcluSessionId("backend-a", {
          baseUrl: "http://127.0.0.1:1",
          token: "tok",
          generationId: "gen1",
          backendKind: "opencode",
          fetch: async () => ({ ok: false, status }),
        }),
      /session_context_unavailable/,
    );
  }
});

test("invalid JSON and empty teamclu session id fail closed", async () => {
  await assert.rejects(
    () =>
      resolveTeamcluSessionId("backend-a", {
        baseUrl: "http://127.0.0.1:1",
        token: "tok",
        generationId: "gen1",
        backendKind: "opencode",
        fetch: async () => ({
          ok: true,
          json: async () => ({ teamcluSessionId: "  " }),
        }),
      }),
    /session_context_unavailable/,
  );
});

test("missing sessionID on session-scoped tool fails closed", async () => {
  await assert.rejects(
    () => handleToolExecuteBefore({ tool: "get_session_deeplink", callID: "c1" }, { args: {} }),
    /session_context_unavailable/,
  );
});
