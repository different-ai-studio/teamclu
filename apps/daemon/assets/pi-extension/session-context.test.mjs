import assert from "node:assert/strict";
import test from "node:test";

/** Mirrors `backendSessionIdFromContext` in teamclu.ts */
function backendSessionIdFromContext(ctx) {
  return ctx?.ui?.sessionId?.trim() || undefined;
}

/** Mirrors PI MCP proxy injection gate in teamclu.ts */
async function injectForPiTool(toolName, params, ctx, deps = {}) {
  const SESSION_SCOPED = new Set([
    "get_session_deeplink",
    "manage_participants",
    "archive_session",
  ]);
  const base = toolName.split("/").pop()?.trim() ?? toolName;
  if (!SESSION_SCOPED.has(base)) {
    return params;
  }
  const explicit = String(params?.session_id ?? params?.sessionId ?? "").trim();
  if (explicit) return params;
  const backendSessionId = backendSessionIdFromContext(ctx);
  if (!backendSessionId) {
    throw new Error("session_context_unavailable");
  }
  const resolve = deps.resolve ?? (async (id) => `teamclu-for-${id}`);
  return { ...params, session_id: await resolve(backendSessionId) };
}

function makeUiContext(sessionId) {
  return { sessionId, confirm: async () => true, select: async () => undefined };
}

test("PI ctx.ui.sessionId drives injection for session-scoped tools", async () => {
  const ctxA = { ui: makeUiContext("pi:/tmp/a.json") };
  const ctxB = { ui: makeUiContext("pi:/tmp/b.json") };
  const a = await injectForPiTool("get_session_deeplink", {}, ctxA);
  const b = await injectForPiTool("get_session_deeplink", {}, ctxB);
  assert.equal(a.session_id, "teamclu-for-pi:/tmp/a.json");
  assert.equal(b.session_id, "teamclu-for-pi:/tmp/b.json");
});

test("missing ctx.ui.sessionId fails closed without resolver call", async () => {
  let called = false;
  await assert.rejects(
    () =>
      injectForPiTool(
        "get_session_deeplink",
        {},
        { ui: makeUiContext("") },
        { resolve: async () => {
          called = true;
          return "x";
        } },
      ),
    /session_context_unavailable/,
  );
  assert.equal(called, false);
});

test("explicit session_id skips resolver on PI path", async () => {
  let called = false;
  const next = await injectForPiTool(
    "archive_session",
    { session_id: "explicit" },
    { ui: makeUiContext("pi:/tmp/a.json") },
    {
      resolve: async () => {
        called = true;
        return "ignored";
      },
    },
  );
  assert.equal(next.session_id, "explicit");
  assert.equal(called, false);
});

test("non allowlist PI tools ignore session identity", async () => {
  let called = false;
  const params = { path: "/tmp/x" };
  const next = await injectForPiTool(
    "read",
    params,
    { ui: makeUiContext("pi:/tmp/a.json") },
    {
      resolve: async () => {
        called = true;
        return "ignored";
      },
    },
  );
  assert.deepEqual(next, params);
  assert.equal(called, false);
});
