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
});

test("normalizeSessionScopedToolName accepts every managed introspect alias and format", () => {
  const tools = ["get_session_deeplink", "manage_participants", "archive_session"];
  const servers = ["teamclu-introspect", "teamclaw-introspect"];
  for (const tool of tools) {
    for (const server of servers) {
      assert.equal(normalizeSessionScopedToolName(tool), tool);
      assert.equal(normalizeSessionScopedToolName(`${server}/${tool}`), tool);
      assert.equal(normalizeSessionScopedToolName(`mcp__${server}__${tool}`), tool);
      assert.equal(normalizeSessionScopedToolName(`${server}_${tool}`), tool);
    }
  }
});

test("normalizeSessionScopedToolName rejects namespaced forms from unmanaged servers", () => {
  for (const name of [
    "other-server/get_session_deeplink",
    "other-server/manage_participants",
    "other-server/archive_session",
    "mcp__other-server__get_session_deeplink",
    "mcp__other-server__manage_participants",
    "mcp__other-server__archive_session",
    "mcp__my_server-with_underscores__archive_session",
    "browser/get_session_deeplink",
    "mcp__teamclu-introspect__get_session_deeplink_extra",
    "teamclu-introspect/get_session_deeplink_extra",
    "teamclu-introspect-extra/get_session_deeplink",
    "teamclu-introspect-extra_get_session_deeplink",
  ]) {
    assert.equal(normalizeSessionScopedToolName(name), name);
    assert.equal(isSessionScopedTool(name), false);
  }
});

test("normalizeSessionScopedToolName handles OpenCode server_tool ids", () => {
  assert.equal(
    normalizeSessionScopedToolName("teamclu-introspect_get_session_deeplink"),
    "get_session_deeplink",
  );
  assert.equal(
    normalizeSessionScopedToolName("teamclu-introspect_manage_participants"),
    "manage_participants",
  );
  assert.equal(
    normalizeSessionScopedToolName("teamclu-introspect_archive_session"),
    "archive_session",
  );
  assert.equal(
    normalizeSessionScopedToolName("teamclaw-introspect_get_session_deeplink"),
    "get_session_deeplink",
  );
});

test("normalizeSessionScopedToolName rejects similar but non-managed OpenCode ids", () => {
  for (const name of [
    "other-server_get_session_deeplink",
    "teamclu-introspect_get_session_deeplink_extra",
    "browser_manage_participants",
  ]) {
    assert.equal(normalizeSessionScopedToolName(name), name);
    assert.equal(isSessionScopedTool(name), false);
  }
});

test("isSessionScopedTool recognizes namespaced MCP tool ids", () => {
  assert.equal(isSessionScopedTool("mcp__teamclu-introspect__manage_participants"), true);
  assert.equal(isSessionScopedTool("teamclu-introspect_get_session_deeplink"), true);
  assert.equal(isSessionScopedTool("browser_click"), false);
});

test("injectSessionIdForTool does not resolve for namespaced ids from unmanaged servers", async () => {
  let called = false;
  const deps = {
    resolveTeamcluSessionId: async () => {
      called = true;
      return "teamclu-leaked";
    },
  };
  for (const tool of [
    "other-server/get_session_deeplink",
    "mcp__other-server__archive_session",
    "browser_manage_participants",
  ]) {
    const args = { scheme: "copilot361" };
    const next = await injectSessionIdForTool(tool, args, "backend-a", deps);
    assert.deepEqual(next, args);
  }
  assert.equal(called, false, "resolver must never run for unmanaged server tools");
});

test("handleToolExecuteBefore ignores namespaced ids from unmanaged servers", async () => {
  let called = false;
  for (const tool of [
    "other-server/get_session_deeplink",
    "mcp__other-server__archive_session",
  ]) {
    const output = { args: { scheme: "copilot361" } };
    await handleToolExecuteBefore(
      { tool, sessionID: "backend-a", callID: "c1" },
      output,
      {
        injectSessionIdForTool: async () => {
          called = true;
          return { session_id: "teamclu-leaked" };
        },
      },
    );
    assert.deepEqual(output.args, { scheme: "copilot361" });
  }
  assert.equal(called, false);
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

test("handleToolExecuteBefore injects for real OpenCode production tool id", async () => {
  const output = { args: { scheme: "copilot361" } };
  await handleToolExecuteBefore(
    {
      tool: "teamclu-introspect_get_session_deeplink",
      sessionID: "backend-a",
      callID: "call-a",
    },
    output,
    {
      injectSessionIdForTool: async () => ({
        scheme: "copilot361",
        session_id: "teamclu-a",
      }),
    },
  );
  assert.equal(output.args.session_id, "teamclu-a");
});

test("handleToolExecuteBefore mutates the original args object OpenCode keeps", async () => {
  // OpenCode 1.18.x MCP path: trigger(..., { args: b }) then execute(b).
  // Replacing output.args leaves b unchanged; introspect then sees no session_id.
  const originalArgs = { scheme: "copilot361" };
  const output = { args: originalArgs };
  await handleToolExecuteBefore(
    {
      tool: "teamclu-introspect_get_session_deeplink",
      sessionID: "backend-a",
      callID: "call-a",
    },
    output,
    {
      injectSessionIdForTool: async (_tool, args) => ({
        ...args,
        session_id: "teamclu-a",
      }),
    },
  );
  assert.equal(originalArgs.session_id, "teamclu-a");
  assert.equal(output.args, originalArgs);
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
    inject("teamclu-introspect_get_session_deeplink", {}, "backend-a"),
    inject("teamclu-introspect_get_session_deeplink", {}, "backend-b"),
    inject("teamclu-introspect_get_session_deeplink", {}, "backend-a"),
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
