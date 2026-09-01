/**
 * Resolve TeamClu cloud session id for a backend tool call via amuxd's
 * internal loopback API. Used by backend adapters before calling session-scoped
 * MCP tools without an explicit session_id argument.
 */

const SESSION_SCOPED_TOOL_LIST = [
  "get_session_deeplink",
  "manage_participants",
  "archive_session",
];

const SESSION_SCOPED_TOOLS = new Set(SESSION_SCOPED_TOOL_LIST);

/** Managed introspect MCP servers whose OpenCode tool IDs we recognize. */
const MANAGED_INTROSPECT_SERVERS = ["teamclu-introspect", "teamclaw-introspect"];

/** Extract the bare tool name from OpenCode / MCP namespaced identifiers. */
export function normalizeSessionScopedToolName(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return "";

  for (const tool of SESSION_SCOPED_TOOL_LIST) {
    if (raw === tool) return tool;

    for (const server of MANAGED_INTROSPECT_SERVERS) {
      if (raw === `${server}/${tool}`) return tool;
      if (raw === `mcp__${server}__${tool}`) return tool;
      if (raw === `${server}_${tool}`) return tool;
    }
  }

  return raw;
}

export function isSessionScopedTool(name) {
  return SESSION_SCOPED_TOOLS.has(normalizeSessionScopedToolName(name));
}

function runtimeContextUrl() {
  const fromEnv = process.env.TEAMCLU_RUNTIME_CONTEXT_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return null;
}

export async function resolveTeamcluSessionId(backendSessionId, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const baseUrl = deps.baseUrl ?? runtimeContextUrl();
  const token = deps.token ?? process.env.TEAMCLU_RUNTIME_CONTEXT_TOKEN?.trim();
  const generationId = deps.generationId ?? process.env.TEAMCLU_HOST_GENERATION_ID?.trim();
  const backendKind = deps.backendKind ?? process.env.TEAMCLU_AGENT_BACKEND?.trim();
  const sessionId = String(backendSessionId ?? "").trim();
  if (!baseUrl || !token || !generationId || !backendKind || !sessionId) {
    throw new Error("session_context_unavailable");
  }
  const resp = await fetchFn(`${baseUrl}/internal/runtime-context/resolve`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      backendSessionId: sessionId,
      hostGenerationId: generationId,
      backendKind,
    }),
  });
  if (!resp.ok) {
    throw new Error("session_context_unavailable");
  }
  const body = await resp.json();
  const teamcluSessionId = String(body?.teamcluSessionId ?? "").trim();
  if (!teamcluSessionId) {
    throw new Error("session_context_unavailable");
  }
  return teamcluSessionId;
}

export async function injectSessionIdForTool(toolName, args, backendSessionId, deps = {}) {
  if (!isSessionScopedTool(toolName)) {
    return args ?? {};
  }
  const next = { ...(args ?? {}) };
  const explicit = String(next.session_id ?? next.sessionId ?? "").trim();
  if (explicit) {
    return next;
  }
  const resolve = deps.resolveTeamcluSessionId ?? resolveTeamcluSessionId;
  next.session_id = await resolve(backendSessionId, deps);
  return next;
}

/**
 * OpenCode 1.18.x `tool.execute.before` hook handler.
 *
 * Contract: input.tool (string), input.sessionID (string), output.args (mutable).
 */
export async function handleToolExecuteBefore(input, output, deps = {}) {
  if (!input || typeof input !== "object" || !output || typeof output !== "object") {
    throw new Error("session_context_unavailable");
  }
  const toolName = input.tool;
  if (!isSessionScopedTool(toolName)) {
    return;
  }
  const backendSessionId = input.sessionID;
  if (!backendSessionId || !String(backendSessionId).trim()) {
    throw new Error("session_context_unavailable");
  }
  const inject = deps.injectSessionIdForTool ?? injectSessionIdForTool;
  output.args = await inject(toolName, output.args ?? {}, String(backendSessionId).trim(), deps);
}

export function sessionContextUnavailableResult() {
  return {
    content: [
      {
        type: "text",
        text: "session_context_unavailable: Unable to determine the TeamClu session for this tool call.",
      },
    ],
    isError: true,
  };
}
