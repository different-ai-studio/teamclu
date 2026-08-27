/**
 * Resolve TeamClu cloud session id for a backend tool call via amuxd's
 * internal loopback API. Used by backend adapters before calling session-scoped
 * MCP tools without an explicit session_id argument.
 */

const SESSION_SCOPED_TOOLS = new Set([
  "get_session_deeplink",
  "manage_participants",
  "archive_session",
]);

export function isSessionScopedTool(name) {
  const base = String(name ?? "")
    .split("/")
    .pop()
    .trim();
  return SESSION_SCOPED_TOOLS.has(base);
}

function runtimeContextUrl() {
  const fromEnv = process.env.TEAMCLU_RUNTIME_CONTEXT_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return null;
}

export async function resolveTeamcluSessionId(backendSessionId) {
  const baseUrl = runtimeContextUrl();
  const token = process.env.TEAMCLU_RUNTIME_CONTEXT_TOKEN?.trim();
  const generationId = process.env.TEAMCLU_HOST_GENERATION_ID?.trim();
  const backendKind = process.env.TEAMCLU_AGENT_BACKEND?.trim();
  const sessionId = String(backendSessionId ?? "").trim();
  if (!baseUrl || !token || !generationId || !backendKind || !sessionId) {
    throw new Error("session_context_unavailable");
  }
  const resp = await fetch(`${baseUrl}/internal/runtime-context/resolve`, {
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

export async function injectSessionIdForTool(toolName, args, backendSessionId) {
  if (!isSessionScopedTool(toolName)) {
    return args ?? {};
  }
  const next = { ...(args ?? {}) };
  const explicit = String(next.session_id ?? next.sessionId ?? "").trim();
  if (explicit) {
    return next;
  }
  next.session_id = await resolveTeamcluSessionId(backendSessionId);
  return next;
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
