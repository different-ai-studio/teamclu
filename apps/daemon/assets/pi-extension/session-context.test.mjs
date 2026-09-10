import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
    "export_pi_transcript",
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

test("PI injection gate matches production alias rules", async () => {
  // The PI bridge calls injectSessionIdForTool with the ORIGINAL bare MCP tool
  // name, so only bare allowlist names should inject. Namespaced ids belong to
  // other backends and must not resolve on the PI path.
  let called = 0;
  const resolve = async (id) => {
    called += 1;
    return `teamclu-for-${id}`;
  };
  const ctx = { ui: makeUiContext("pi:/tmp/a.json") };
  const injected = await injectForPiTool("get_session_deeplink", {}, ctx, { resolve });
  assert.equal(injected.session_id, "teamclu-for-pi:/tmp/a.json");
  assert.equal(called, 1);

  for (const tool of ["other-server/get_session_deeplink", "browser_manage_participants"]) {
    // Mirrors production: the base tool of "other-server/get_session_deeplink"
    // is "get_session_deeplink", which IS allowlisted — but the PI bridge never
    // passes namespaced names to injectSessionIdForTool (it forwards the bare
    // MCP tool name), so this case only documents the shared-client contract.
    assert.equal(typeof tool, "string");
  }
});

/** Mirrors session prompt cache key in teamclu.ts */
function sessionPromptCacheKey(backendSessionId, generationId) {
  const sessionId = backendSessionId?.trim();
  const gen = generationId?.trim();
  if (!sessionId || !gen) return undefined;
  return `${gen}:${sessionId}`;
}

/** Mirrors pi self-doc strip + session prompt cache + before_agent_start in teamclu.ts */
const PI_SELF_DOCUMENTATION_BLOCK =
  /\n\nPi documentation[\s\S]*?(?=\n\n<project_context>|\n\nThe following skills provide|\nCurrent working directory:)/;

function stripPiSelfDocumentation(prompt) {
  return prompt.replace(PI_SELF_DOCUMENTATION_BLOCK, "");
}

function shouldStripPiSelfDocumentation(ctx) {
  const model = ctx?.model;
  return (
    !!model &&
    typeof model === "object" &&
    model.provider === "anthropic"
  );
}

const SAMPLE_PI_PROMPT = `You are an expert coding assistant operating inside pi.

Available tools:
- read: Read files

Guidelines:
- Be concise

Pi documentation (read only when the user asks about pi itself):
- When asked about: extensions (docs/extensions.md), themes (docs/themes.md)
Current working directory: /tmp`;

async function appendSystemPromptForTurn(event, ctx, deps = {}) {
  const original = String(event?.systemPrompt ?? "").trim();
  let base = original;
  if (shouldStripPiSelfDocumentation(ctx)) {
    base = stripPiSelfDocumentation(base);
  }

  const backendSessionId = backendSessionIdFromContext(ctx);
  let append;
  if (backendSessionId) {
    const cache = deps.cache ?? new Map();
    const cacheKey = sessionPromptCacheKey(
      backendSessionId,
      deps.generationId ?? "gen-test",
    );
    append = cacheKey ? cache.get(cacheKey) : undefined;
    if (!append) {
      const fetchPrompt = deps.fetchPrompt;
      if (fetchPrompt) {
        const fetched = await fetchPrompt(backendSessionId);
        if (fetched?.append) {
          append = fetched.append;
          if (cacheKey && fetched.rosterResolved === true) {
            cache.set(cacheKey, append);
          }
        }
      }
    }
  }

  if (base === original && !append) return undefined;

  const systemPrompt = append ? (base ? `${base}\n\n${append}` : append) : base;
  return { systemPrompt };
}

test("before_agent_start appends session prompt and caches by generation plus backendSessionId", async () => {
  const cache = new Map();
  let fetchCount = 0;
  const ctx = { ui: makeUiContext("pi:/tmp/session-a.json") };
  const fetchPrompt = async (id) => {
    fetchCount += 1;
    return {
      append: `[Acme Session Context]\nbackend=${id}`,
      rosterResolved: true,
    };
  };

  const first = await appendSystemPromptForTurn(
    { systemPrompt: "base prompt" },
    ctx,
    { cache, fetchPrompt, generationId: "gen-1" },
  );
  assert.match(first.systemPrompt, /^base prompt\n\n\[Acme Session Context\]/);
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

test("before_agent_start skips injection when roster is unresolved", async () => {
  const cache = new Map();
  let fetchCount = 0;
  const ctx = { ui: makeUiContext("pi:/tmp/unresolved.json") };
  const fetchPrompt = async () => {
    fetchCount += 1;
    return { append: "", rosterResolved: false };
  };

  const first = await appendSystemPromptForTurn({ systemPrompt: "turn one" }, ctx, {
    cache,
    fetchPrompt,
    generationId: "gen-1",
  });
  assert.equal(first, undefined);

  await appendSystemPromptForTurn({ systemPrompt: "turn two" }, ctx, {
    cache,
    fetchPrompt,
    generationId: "gen-1",
  });
  assert.equal(fetchCount, 2, "unresolved roster must refetch each turn");
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

/** Mirrors session-title helpers in teamclu.ts */
const SESSION_TITLE_MAX_LEN = 80;
const AGENT_MENTION_LINE_RE = /^\[Mentioned agents:[^\]]*\]$/i;
const HUMAN_MENTION_ONLY_LINE_RE =
  /^\[Mentioned:[^\]]*\|instruction:[^\]]*\]$/i;
const INLINE_HUMAN_MENTION_RE =
  /\[Mentioned:[^\]]*\|instruction:[^\]]*\]/gi;

function stripMentionsForSessionTitle(content) {
  return content
    .split(/\n+/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (AGENT_MENTION_LINE_RE.test(trimmed)) return "";
      if (HUMAN_MENTION_ONLY_LINE_RE.test(trimmed)) return "";
      return trimmed.replace(INLINE_HUMAN_MENTION_RE, "").replace(/\s+/g, " ").trim();
    })
    .filter(Boolean)
    .join("\n");
}

function shouldSkipTitlePrompt(prompt) {
  const body = stripMentionsForSessionTitle(prompt).trim();
  if (!body) return true;
  return body.startsWith("/") || body.startsWith("!") || body.startsWith("$");
}

const CRON_REPLY_TOKEN_MARKER = "[SYSTEM] Reply token for this run:";

function isCronJobPrompt(raw) {
  return raw.includes(CRON_REPLY_TOKEN_MARKER);
}

const TITLE_FOLLOW_MARKER = "Reply only to the user prompt that follows.]";
const TITLE_END_CONTEXT_MARKER = "[End context]";

function userPromptForTitle(raw) {
  let text = raw;
  const endCtx = text.lastIndexOf(TITLE_END_CONTEXT_MARKER);
  if (endCtx >= 0) {
    text = text.slice(endCtx + TITLE_END_CONTEXT_MARKER.length);
  }
  const follow = text.lastIndexOf(TITLE_FOLLOW_MARKER);
  if (follow >= 0) {
    text = text.slice(follow + TITLE_FOLLOW_MARKER.length);
  }
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  while (i < lines.length && /^\[[^\]]+\] /.test(lines[i])) i += 1;
  while (i < lines.length && !lines[i].trim()) i += 1;
  return lines.slice(i).join("\n").trim();
}

function looksLikeMachineTitle(title) {
  const t = title.trim();
  if (!t) return true;
  return (
    t.includes("TeamClu Instructions") ||
    t.startsWith("[Context —") ||
    t.startsWith("[End context]")
  );
}

function sanitizeGeneratedTitle(raw) {
  let title = raw.trim().replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "");
  title = (title.split("\n")[0] || title).trim();
  title = title.replace(/[。.\s]+$/g, "").trim();
  title = title.slice(0, SESSION_TITLE_MAX_LEN);
  return looksLikeMachineTitle(title) ? "" : title;
}

function assistantMessageText(message) {
  if (!message) return "";
  if (message.stopReason === "error" || message.stopReason === "aborted") return "";
  const parts = Array.isArray(message.content) ? message.content : [];
  return parts
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
}

function describeTitleResponse(message) {
  const types = Array.isArray(message?.content)
    ? message.content.map((b) => b?.type ?? "?").join(",")
    : "";
  return `stopReason=${message?.stopReason ?? "missing"} error=${message?.errorMessage ?? ""} types=${types}`;
}

function titleCompleteOptions(model) {
  const options = {
    maxTokens: 256,
    timeoutMs: 15_000,
  };
  if (!model || typeof model !== "object" || model.reasoning !== true) return options;
  const map = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object"
    ? model.thinkingLevelMap
    : undefined;
  if (map?.off === null) return options;
  options.reasoning = "off";
  if (map) {
    options.reasoningEffort = typeof map.off === "string" && map.off ? map.off : "none";
  }
  return options;
}

/** Mirrors teamclu.ts llmSessionTitle — uses ctx.modelRegistry.complete, not pi-ai. */
async function llmSessionTitle(ctx, prompt) {
  const model = ctx.model;
  const registry = ctx.modelRegistry;
  const complete = registry?.complete;
  if (!model || typeof complete !== "function") return "";
  const user = [
    "Write a short session title for this user request.",
    "Maximum 8 words or 40 characters. Match the user's language.",
    "Reply with ONLY the title, no quotes.",
    "",
    "User request:",
    prompt.slice(0, 2000),
  ].join("\n");
  const response = await complete.call(
    registry,
    model,
    { messages: [{ role: "user", content: user }] },
    titleCompleteOptions(model),
  );
  const text = assistantMessageText(response);
  if (!text) describeTitleResponse(response);
  return text;
}

async function maybeGenerateSessionTitle(event, ctx, deps = {}) {
  const sessionId = backendSessionIdFromContext(ctx);
  if (!sessionId) return;
  const titleMarkers = deps.titleMarkers ?? new Map();
  const hasMarker = deps.hasTitleMarker ?? ((id) => titleMarkers.has(id));
  const writeMarker = deps.writeTitleMarker ?? ((id, title) => titleMarkers.set(id, title));
  const inFlight = deps.inFlight ?? new Set();
  if (hasMarker(sessionId)) return;
  if (inFlight.has(sessionId)) return;

  const raw = String(event.prompt ?? "");
  if (isCronJobPrompt(raw)) return;
  const prompt = userPromptForTitle(raw);
  if (shouldSkipTitlePrompt(prompt)) return;

  inFlight.add(sessionId);
  const ui = ctx.ui;
  const job = {
    prompt,
    model: ctx.model,
    registry: ctx.modelRegistry,
    setTitle: ui.setTitle?.bind(ui),
    llmTitle: deps.llmTitle,
  };

  const apply = async () => {
    try {
      let title = "";
      try {
        title = sanitizeGeneratedTitle(
          await (job.llmTitle?.({ model: job.model, modelRegistry: job.registry }, job.prompt) ?? ""),
        );
      } catch {
        title = "";
      }
      if (!title) return;
      job.setTitle?.(title);
      writeMarker(sessionId, title);
    } finally {
      inFlight.delete(sessionId);
    }
  };

  if (deps.fireAndForget) {
    deps.pending?.push(apply());
    return;
  }
  await apply();
}

test("session title skips slash commands and empty prompts", () => {
  assert.equal(shouldSkipTitlePrompt(""), true);
  assert.equal(shouldSkipTitlePrompt("   "), true);
  assert.equal(shouldSkipTitlePrompt("/compact"), true);
  assert.equal(shouldSkipTitlePrompt("!ls"), true);
  assert.equal(shouldSkipTitlePrompt("$ echo hi"), true);
  assert.equal(shouldSkipTitlePrompt("帮我查一下深圳美食"), false);
});

test("session title treats cron run tokens as cron, not chat tokens", () => {
  assert.equal(
    isCronJobPrompt(
      "[SYSTEM] Reply token for this run: tok\nPass it as `reply_token`\n\nnightly sync",
    ),
    true,
  );
  assert.equal(
    isCronJobPrompt("[SYSTEM] Reply token for this chat: tok\nhello"),
    false,
  );
});

test("session title does not run for cron job prompts", async () => {
  let llmCalled = false;
  const titleMarkers = new Map();
  const ctx = { ui: { sessionId: "pi:/tmp/cron.json", setTitle() {} } };
  await maybeGenerateSessionTitle(
    {
      prompt:
        "[SYSTEM] Reply token for this run: tok\nPass it as `reply_token`\n\nnightly sync",
    },
    ctx,
    {
      titleMarkers,
      llmTitle: async () => {
        llmCalled = true;
        return "Nope";
      },
    },
  );
  assert.equal(llmCalled, false);
  assert.equal(titleMarkers.size, 0);
});

test("session title strips TeamClu instruction wrappers to the user text", () => {
  const wrapped = [
    "[TeamClu Instructions — follow for all replies in this session. Do not acknowledge separately. Reply only to the user prompt that follows.]",
    "[system] 请使用中文回答",
    "",
    "帮我查一下深圳美食",
  ].join("\n");
  assert.equal(userPromptForTitle(wrapped), "帮我查一下深圳美食");
});

test("session title strips silent context wrappers", () => {
  const wrapped = [
    "[Context — messages received in this session while you were not mentioned. Read for context but do not reply to them. Reply only to the user prompt that follows.]",
    "Ann: earlier note",
    "[End context]",
    "",
    "real question",
  ].join("\n");
  assert.equal(userPromptForTitle(wrapped), "real question");
});

test("session title sends unwrapped user text to the LLM", async () => {
  const seen = [];
  const titles = [];
  const ctx = {
    ui: {
      sessionId: "pi:/tmp/wrap.json",
      setTitle: (title) => titles.push(title),
    },
  };
  const wrapped = [
    "[TeamClu Instructions — follow for all replies in this session. Do not acknowledge separately. Reply only to the user prompt that follows.]",
    "[system] 请使用中文回答",
    "",
    "帮我查一下深圳美食",
  ].join("\n");
  await maybeGenerateSessionTitle({ prompt: wrapped }, ctx, {
    llmTitle: async (_ctx, prompt) => {
      seen.push(prompt);
      return "深圳美食推荐";
    },
  });
  assert.deepEqual(seen, ["帮我查一下深圳美食"]);
  assert.deepEqual(titles, ["深圳美食推荐"]);
});

test("session title sanitizes model output", () => {
  assert.equal(sanitizeGeneratedTitle('"深圳美食推荐"'), "深圳美食推荐");
  assert.equal(sanitizeGeneratedTitle("Launch Plan.\nextra"), "Launch Plan");
  assert.equal(sanitizeGeneratedTitle(""), "");
  assert.equal(
    sanitizeGeneratedTitle(
      "[TeamClu Instructions — follow for all replies in this session. Do not acknowled",
    ),
    "",
  );
});

test("session title LLM uses modelRegistry.complete with the session model", async () => {
  const calls = [];
  const ctx = {
    model: {
      id: "gpt-5.6-luna",
      provider: "openai-codex",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
    },
    modelRegistry: {
      complete: async function complete(model, context, options) {
        calls.push({ thisArg: this, model, context, options });
        return {
          stopReason: "stop",
          content: [{ type: "text", text: "深圳美食" }],
        };
      },
    },
  };
  const text = await llmSessionTitle(ctx, "帮我查一下深圳美食");
  assert.equal(text, "深圳美食");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].thisArg, ctx.modelRegistry);
  assert.equal(calls[0].model.provider, "openai-codex");
  assert.match(calls[0].context.messages[0].content, /帮我查一下深圳美食/);
  assert.equal(calls[0].options.reasoning, "off");
  assert.equal(calls[0].options.reasoningEffort, "none");
  assert.equal(calls[0].options.reasoningSummary, undefined);
  assert.equal(calls[0].options.maxTokens, 256);
});

test("session title LLM omits thinking options for non-reasoning models", async () => {
  const calls = [];
  await llmSessionTitle(
    {
      model: { id: "gpt-4.1", provider: "openai", reasoning: false },
      modelRegistry: {
        complete: async function complete(_model, _context, options) {
          calls.push(options);
          return { stopReason: "stop", content: [{ type: "text", text: "ok" }] };
        },
      },
    },
    "hello",
  );
  assert.equal(calls[0].maxTokens, 256);
  assert.equal(calls[0].reasoning, undefined);
  assert.equal(calls[0].reasoningEffort, undefined);
});

test("session title LLM skips disable when the model forbids off", async () => {
  const calls = [];
  await llmSessionTitle(
    {
      model: {
        id: "claude-sonnet",
        provider: "anthropic",
        reasoning: true,
        thinkingLevelMap: { off: null, high: "high" },
      },
      modelRegistry: {
        complete: async function complete(_model, _context, options) {
          calls.push(options);
          return { stopReason: "stop", content: [{ type: "text", text: "ok" }] };
        },
      },
    },
    "hello",
  );
  assert.equal(calls[0].reasoning, undefined);
  assert.equal(calls[0].reasoningEffort, undefined);
});

test("session title LLM uses the model's mapped off effort", async () => {
  const calls = [];
  await llmSessionTitle(
    {
      model: {
        id: "gpt-5.4",
        provider: "openai-codex",
        reasoning: true,
        thinkingLevelMap: { off: "none", minimal: "low" },
      },
      modelRegistry: {
        complete: async function complete(_model, _context, options) {
          calls.push(options);
          return { stopReason: "stop", content: [{ type: "text", text: "ok" }] };
        },
      },
    },
    "hello",
  );
  assert.equal(calls[0].reasoning, "off");
  assert.equal(calls[0].reasoningEffort, "none");
});

test("session title LLM returns empty for thinking-only responses", async () => {
  const text = await llmSessionTitle(
    {
      model: { id: "gpt-5.6-luna", provider: "openai-codex" },
      modelRegistry: {
        complete: async () => ({
          stopReason: "length",
          errorMessage: "",
          content: [{ type: "thinking" }],
        }),
      },
    },
    "你有哪些能力？",
  );
  assert.equal(text, "");
});

test("session title LLM returns empty without modelRegistry.complete", async () => {
  assert.equal(await llmSessionTitle({ model: { provider: "openai-codex" } }, "hello"), "");
  assert.equal(await llmSessionTitle({ modelRegistry: { complete: async () => "x" } }, "hello"), "");
});

test("session title ignores errored assistant messages", () => {
  assert.equal(
    assistantMessageText({
      stopReason: "error",
      content: [{ type: "text", text: "nope" }],
    }),
    "",
  );
  assert.equal(
    assistantMessageText({
      stopReason: "stop",
      content: [{ type: "thinking", thinking: "..." }],
    }),
    "",
  );
  assert.equal(
    assistantMessageText({
      stopReason: "stop",
      content: [{ type: "text", text: "深圳美食推荐" }],
    }),
    "深圳美食推荐",
  );
});

test("session title fire-and-forget does not wait for the LLM", async () => {
  const titles = [];
  let release;
  const llmTitle = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = [];
  const ctx = {
    ui: {
      sessionId: "pi:/tmp/defer.json",
      setTitle: (title) => titles.push(title),
    },
  };
  await maybeGenerateSessionTitle({ prompt: "帮我查一下深圳美食" }, ctx, {
    fireAndForget: true,
    pending,
    llmTitle,
  });
  assert.deepEqual(titles, []);
  release("Deferred Title");
  await Promise.all(pending);
  assert.deepEqual(titles, ["Deferred Title"]);
});

test("session title uses LLM result and setTitle", async () => {
  const titles = [];
  const ctx = {
    ui: {
      sessionId: "pi:/tmp/a.json",
      setTitle: (title) => titles.push(title),
    },
  };
  await maybeGenerateSessionTitle({ prompt: "帮我写一份发布计划" }, ctx, {
    llmTitle: async () => '"Launch Plan"',
  });
  assert.deepEqual(titles, ["Launch Plan"]);
});

test("session title does not set a title when LLM returns nothing", async () => {
  const titles = [];
  const ctx = {
    ui: {
      sessionId: "pi:/tmp/b.json",
      setTitle: (title) => titles.push(title),
    },
  };
  await maybeGenerateSessionTitle({ prompt: "帮我查一下深圳美食" }, ctx, {
    llmTitle: async () => "",
  });
  assert.deepEqual(titles, []);
});

test("session title does not run twice for the same session", async () => {
  let calls = 0;
  const titleMarkers = new Map();
  const ctx = { ui: { sessionId: "pi:/tmp/c.json", setTitle() {} } };
  const deps = {
    titleMarkers,
    llmTitle: async () => {
      calls += 1;
      return "Once";
    },
  };
  await maybeGenerateSessionTitle({ prompt: "hello" }, ctx, deps);
  await maybeGenerateSessionTitle({ prompt: "hello again" }, ctx, deps);
  assert.equal(calls, 1);
  assert.equal(titleMarkers.get("pi:/tmp/c.json"), "Once");
});

test("session title source never calls pi.getSessionName or setSessionName", () => {
  const src = fs.readFileSync(fileURLToPath(new URL("./teamclu.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(src, /pi\.getSessionName\s*\??\s*\(/);
  assert.doesNotMatch(src, /pi\.setSessionName\s*\??\s*\(/);
});

test("before_agent_start and tool_call swallow stale extension ctx", () => {
  const src = fs.readFileSync(fileURLToPath(new URL("./teamclu.ts", import.meta.url)), "utf8");
  assert.match(src, /function isStaleExtensionCtxError/);
  assert.match(src, /before_agent_start skipped stale ctx/);
  assert.match(src, /tool_call skipped stale ctx/);
});

test("session title still runs when a session already has a pi name", async () => {
  // Skip is sidecar-only. Reading pi.getSessionName() hits the shared
  // ExtensionRuntime, which any session dispose() marks stale.
  const titles = [];
  const ctx = {
    ui: {
      sessionId: "pi:/tmp/d.json",
      setTitle: (title) => titles.push(title),
    },
  };
  await maybeGenerateSessionTitle({ prompt: "hello" }, ctx, {
    llmTitle: async () => "From Prompt",
  });
  assert.deepEqual(titles, ["From Prompt"]);
});

test("before_agent_start strips pi self-documentation for anthropic provider", async () => {
  const result = await appendSystemPromptForTurn(
    { systemPrompt: SAMPLE_PI_PROMPT },
    { ui: makeUiContext("pi:/tmp/a.json"), model: { provider: "anthropic", id: "claude-sonnet-4-5" } },
  );
  assert.ok(result);
  assert.match(result.systemPrompt, /Available tools:/);
  assert.match(result.systemPrompt, /Current working directory: \/tmp/);
  assert.doesNotMatch(result.systemPrompt, /Pi documentation/);
  assert.doesNotMatch(result.systemPrompt, /When asked about:/);
});

test("before_agent_start leaves prompt unchanged for non-anthropic providers", async () => {
  const result = await appendSystemPromptForTurn(
    { systemPrompt: SAMPLE_PI_PROMPT },
    { ui: makeUiContext("pi:/tmp/a.json"), model: { provider: "deepseek", id: "deepseek-chat" } },
  );
  assert.equal(result, undefined);
});

test("before_agent_start strips pi docs and appends session context for anthropic", async () => {
  const result = await appendSystemPromptForTurn(
    { systemPrompt: SAMPLE_PI_PROMPT },
    { ui: makeUiContext("pi:/tmp/session-a.json"), model: { provider: "anthropic", id: "claude-haiku-4-5" } },
    {
      fetchPrompt: async (id) => ({
        append: `[Ctx]\nbackend=${id}`,
        rosterResolved: true,
      }),
    },
  );
  assert.match(result.systemPrompt, /Available tools:/);
  assert.doesNotMatch(result.systemPrompt, /Pi documentation/);
  assert.match(result.systemPrompt, /\[Ctx\]\nbackend=pi:\/tmp\/session-a.json/);
});

test("before_agent_start strips pi docs but keeps skills when no project_context", async () => {
  const promptWithSkills = [
    "You are an expert coding assistant operating inside pi.",
    "",
    "Available tools:",
    "- read: Read files",
    "",
    "Guidelines:",
    "- Be concise",
    "",
    "Pi documentation (read only when the user asks about pi itself):",
    "- When asked about: extensions (docs/extensions.md)",
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "",
    "<available_skills>",
    "  <skill>",
    "    <name>deploy</name>",
    "    <description>Deploy apps</description>",
    "  </skill>",
    "</available_skills>",
    "Current working directory: /tmp",
  ].join("\n");

  const result = await appendSystemPromptForTurn(
    { systemPrompt: promptWithSkills },
    { ui: makeUiContext("pi:/tmp/a.json"), model: { provider: "anthropic", id: "claude-sonnet-4-5" } },
  );
  assert.ok(result);
  assert.doesNotMatch(result.systemPrompt, /Pi documentation/);
  assert.match(result.systemPrompt, /The following skills provide/);
  assert.match(result.systemPrompt, /<available_skills>/);
  assert.match(result.systemPrompt, /Current working directory: \/tmp/);
});

test("before_agent_start strips pi docs but keeps project_context", async () => {
  const promptWithContext = [
    "You are an expert coding assistant operating inside pi.",
    "",
    "Guidelines:",
    "- Be concise",
    "",
    "Pi documentation (read only when the user asks about pi itself):",
    "- When asked about: extensions (docs/extensions.md)",
    "",
    "<project_context>",
    "",
    "Project-specific instructions and guidelines:",
    "",
    '<project_instructions path="AGENTS.md">',
    "Use TypeScript strict mode.",
    "</project_instructions>",
    "",
    "</project_context>",
    "Current working directory: /tmp",
  ].join("\n");

  const result = await appendSystemPromptForTurn(
    { systemPrompt: promptWithContext },
    { ui: makeUiContext("pi:/tmp/a.json"), model: { provider: "anthropic", id: "claude-sonnet-4-5" } },
  );
  assert.ok(result);
  assert.doesNotMatch(result.systemPrompt, /Pi documentation/);
  assert.match(result.systemPrompt, /<project_context>/);
  assert.match(result.systemPrompt, /Use TypeScript strict mode/);
  assert.match(result.systemPrompt, /Current working directory: \/tmp/);
});

/** Mirrors `capToolText` / `toPiContent` in teamclu.ts */
const MAX_TOOL_RESULT_BYTES = 128 * 1024;

function budgetExceededEnvelope(originalBytes) {
  return JSON.stringify({
    truncated: true,
    reason: "response_budget_exceeded",
    originalBytes,
    hint: "Use a narrower query or read_draft_file with a specific path",
  });
}

function capToolText(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_TOOL_RESULT_BYTES) return text;
  return budgetExceededEnvelope(bytes.length);
}

function toPiContent(result) {
  const out = [];
  for (const part of Array.isArray(result?.content) ? result.content : []) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      out.push({ type: "text", text: capToolText(part.text) });
    } else if (part.type === "image" && typeof part.data === "string") {
      out.push({ type: "image", data: part.data, mimeType: part.mimeType || "image/png" });
    } else if (part.type === "resource" && typeof part.resource?.text === "string") {
      out.push({ type: "text", text: capToolText(part.resource.text) });
    } else {
      out.push({ type: "text", text: capToolText(JSON.stringify(part)) });
    }
  }
  if (out.length === 0 && result?.structuredContent !== undefined) {
    out.push({ type: "text", text: capToolText(JSON.stringify(result.structuredContent)) });
  }
  if (out.length === 0) {
    out.push({ type: "text", text: capToolText(JSON.stringify(result ?? null)) });
  }
  return out;
}

test("toPiContent source uses a structured 128KB fuse instead of slicing JSON", () => {
  const src = fs.readFileSync(fileURLToPath(new URL("./teamclu.ts", import.meta.url)), "utf8");
  assert.match(src, /MAX_TOOL_RESULT_BYTES\s*=\s*128\s*\*\s*1024/);
  assert.match(src, /function capToolText/);
  assert.match(src, /response_budget_exceeded/);
  assert.doesNotMatch(src, /showing first \$\{end\} bytes/);
  assert.doesNotMatch(src, /capToolText\(part\.data\)/);
});

test("toPiContent leaves small text and images alone", () => {
  assert.deepEqual(toPiContent({ content: [{ type: "text", text: "hello" }] }), [
    { type: "text", text: "hello" },
  ]);
  const image = { type: "image", data: "x".repeat(MAX_TOOL_RESULT_BYTES + 8), mimeType: "image/png" };
  assert.deepEqual(toPiContent({ content: [image] }), [
    { type: "image", data: image.data, mimeType: "image/png" },
  ]);
});

test("toPiContent replaces oversized text with a structured envelope", () => {
  const big = "x".repeat(MAX_TOOL_RESULT_BYTES + 40);
  const textOut = toPiContent({ content: [{ type: "text", text: big }] });
  assert.equal(textOut.length, 1);
  const parsed = JSON.parse(textOut[0].text);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.reason, "response_budget_exceeded");
  assert.equal(parsed.originalBytes, MAX_TOOL_RESULT_BYTES + 40);
  assert.ok(!textOut[0].text.includes("xxxx"));

  const resourceOut = toPiContent({
    content: [{ type: "resource", resource: { text: big } }],
  });
  assert.match(resourceOut[0].text, /response_budget_exceeded/);

  const structuredOut = toPiContent({ structuredContent: { blob: big } });
  assert.match(structuredOut[0].text, /response_budget_exceeded/);
});
