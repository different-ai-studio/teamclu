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


test("PI reopen/resume uses the new ctx.ui.sessionId backend identity", async () => {
  const beforeReopen = { ui: makeUiContext("pi:/tmp/workspace/session-a.json") };
  const afterReopen = { ui: makeUiContext("pi:/tmp/workspace/session-b.json") };
  const before = await injectForPiTool("get_session_deeplink", {}, beforeReopen);
  const after = await injectForPiTool("get_session_deeplink", {}, afterReopen);
  assert.equal(before.session_id, "teamclu-for-pi:/tmp/workspace/session-a.json");
  assert.equal(after.session_id, "teamclu-for-pi:/tmp/workspace/session-b.json");
  assert.notEqual(before.session_id, after.session_id);
});

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

/** Mirrors session prompt cache key in teamclu.ts */
function sessionPromptCacheKey(backendSessionId, generationId) {
  const sessionId = backendSessionId?.trim();
  const gen = generationId?.trim();
  if (!sessionId || !gen) return undefined;
  return `${gen}:${sessionId}`;
}

/** Mirrors session prompt cache + before_agent_start append in teamclu.ts */
async function appendSystemPromptForTurn(event, ctx, deps = {}) {
  const cache = deps.cache ?? new Map();
  const backendSessionId = backendSessionIdFromContext(ctx);
  if (!backendSessionId) return undefined;

  const cacheKey = sessionPromptCacheKey(
    backendSessionId,
    deps.generationId ?? "gen-test",
  );
  let append = cacheKey ? cache.get(cacheKey) : undefined;
  if (!append) {
    const fetchPrompt = deps.fetchPrompt;
    if (!fetchPrompt) return undefined;
    const fetched = await fetchPrompt(backendSessionId);
    if (!fetched?.append) return undefined;
    append = fetched.append;
    if (cacheKey && fetched.rosterResolved === true) {
      cache.set(cacheKey, append);
    }
  }

  const base = String(event?.systemPrompt ?? "").trim();
  const systemPrompt = base ? `${base}\n\n${append}` : append;
  return { systemPrompt };
}

test("before_agent_start appends session prompt and caches by generation plus backendSessionId", async () => {
  const cache = new Map();
  let fetchCount = 0;
  const ctx = { ui: makeUiContext("pi:/tmp/session-a.json") };
  const fetchPrompt = async (id) => {
    fetchCount += 1;
    return { append: `[TeamClu]\nbackend=${id}`, rosterResolved: true };
  };

  const first = await appendSystemPromptForTurn(
    { systemPrompt: "base prompt" },
    ctx,
    { cache, fetchPrompt, generationId: "gen-1" },
  );
  assert.match(first.systemPrompt, /^base prompt\n\n\[TeamClu\]/);
  assert.equal(fetchCount, 1);

  await appendSystemPromptForTurn({ systemPrompt: "turn two" }, ctx, {
    cache,
    fetchPrompt,
    generationId: "gen-1",
  });
  assert.equal(fetchCount, 1, "same generation should hit cache");

  await appendSystemPromptForTurn({ systemPrompt: "turn three" }, ctx, {
    cache,
    fetchPrompt,
    generationId: "gen-2",
  });
  assert.equal(fetchCount, 2, "new pi host generation should refetch");
});

test("before_agent_start cache key includes host generation id", () => {
  const keyA = sessionPromptCacheKey("pi:/tmp/a.json", "gen-1");
  const keyB = sessionPromptCacheKey("pi:/tmp/a.json", "gen-2");
  assert.notEqual(keyA, keyB);
});

test("before_agent_start fail-open when fetch returns nothing", async () => {
  const result = await appendSystemPromptForTurn(
    { systemPrompt: "keep me" },
    { ui: makeUiContext("pi:/tmp/a.json") },
    {
      fetchPrompt: async () => undefined,
    },
  );
  assert.equal(result, undefined);
});

test("before_agent_start does not cache degraded roster prompts", async () => {
  const cache = new Map();
  let fetchCount = 0;
  const ctx = { ui: makeUiContext("pi:/tmp/degraded.json") };
  const fetchPrompt = async () => {
    fetchCount += 1;
    return {
      append: "[TeamClu Session Context]\n\nParticipants: no roster available.",
      rosterResolved: false,
    };
  };

  await appendSystemPromptForTurn({ systemPrompt: "turn one" }, ctx, {
    cache,
    fetchPrompt,
    generationId: "gen-1",
  });
  await appendSystemPromptForTurn({ systemPrompt: "turn two" }, ctx, {
    cache,
    fetchPrompt,
    generationId: "gen-1",
  });
  assert.equal(fetchCount, 2, "degraded prompt must refetch each turn");
  assert.equal(cache.size, 0);
});

test("before_agent_start skips when ctx.ui.sessionId is missing", async () => {
  let called = false;
  const result = await appendSystemPromptForTurn(
    { systemPrompt: "base" },
    { ui: makeUiContext("") },
    {
      fetchPrompt: async () => {
        called = true;
        return "x";
      },
    },
  );
  assert.equal(result, undefined);
  assert.equal(called, false);
});
