"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCOPES = ["sessions:read", "sessions:write", "events:read", "workspace:read"];

function encodeWorkspaceId(workspacePath) {
  return Buffer.from(workspacePath, "utf8").toString("base64url");
}

function discoverDaemon() {
  const home = process.env.AMUXD_HOME || path.join(os.homedir(), ".amuxd");
  const run = path.join(home, "run");
  const portFile = path.join(run, "amuxd.http.port");
  const tokenFile = path.join(run, "amuxd.http.token");
  if (!fs.existsSync(portFile) || !fs.existsSync(tokenFile)) {
    throw new Error(
      "The local Agent is not running. Start it, then compile again.",
    );
  }
  const port = fs.readFileSync(portFile, "utf8").trim();
  const rootToken = fs.readFileSync(tokenFile, "utf8").trim();
  if (!port || !rootToken) {
    throw new Error(
      "The local Agent is not running. Start it, then compile again.",
    );
  }
  return { baseUrl: `http://127.0.0.1:${port}`, rootToken };
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function createDaemonSession(ctx, deps = {}) {
  const discover = deps.discover || discoverDaemon;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 10 * 60 * 1000;
  const intervalMs = Number.isFinite(deps.intervalMs) ? deps.intervalMs : 250;
  const endpoint = await discover();
  const exchange = await fetchImpl(`${endpoint.baseUrl}/v1/auth/exchange`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${endpoint.rootToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      scopes: SCOPES,
      ttl_seconds: 3600,
      label: "wiki-maintainer",
    }),
  });
  const exchangeBody = await readBody(exchange);
  if (!exchange.ok || !exchangeBody.token) {
    throw new Error(
      `The local Agent rejected Wiki maintenance: ${exchange.status} ${exchangeBody.message || ""}`.trim(),
    );
  }
  const token = exchangeBody.token;
  const workspacePath = ctx.workspacePath || (await defaultWorkspacePath());
  async function request(method, pathname, body) {
    const response = await fetchImpl(`${endpoint.baseUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await readBody(response);
    if (!response.ok) {
      const detail = payload.message || payload.error || JSON.stringify(payload);
      throw new Error(`Compiler model failed: ${detail}`);
    }
    return payload;
  }
  async function defaultWorkspacePath() {
    const payload = await request("GET", "/v1/agent/default-workspace");
    const workspace = String(payload.path || "").trim();
    if (!workspace) {
      throw new Error(
        "The local Agent has no workspace. Open a project, then compile again.",
      );
    }
    return workspace;
  }
  const created = await request("POST", "/v1/sessions", {
    agent_type: "pi",
    workspace_id: encodeWorkspaceId(workspacePath),
    model: ctx.compilerModel || "",
  });
  const sessionId = created.session_id;
  if (ctx.compilerModel) {
    await request("POST", `/v1/sessions/${sessionId}/model`, {
      model_id: ctx.compilerModel,
    });
  }
  const session = {
    sessionId,
    messages: [],
    since: 0,
    async prompt(text, options = {}) {
      const attachments = (options.images || []).map(
        (image) => `data:${image.mimeType};base64,${image.data}`,
      );
      await request("POST", `/v1/sessions/${sessionId}/prompt`, {
        text,
        attachments,
      });
      const started = Date.now();
      let completed = "";
      let sawCompleted = false;
      let deltas = "";
      let errorMessage = "";
      let finished = false;
      while (Date.now() - started < timeoutMs) {
        const page = await request(
          "GET",
          `/v1/sessions/${sessionId}/events?since=${session.since}&limit=200`,
        );
        for (const event of page.events || []) {
          session.since = Math.max(session.since, Number(event.seq) || 0);
          if (event.kind === "message_completed") {
            sawCompleted = true;
            completed = String(event.data?.content || "");
          } else if (event.kind === "token_delta") {
            deltas += String(event.data?.text || "");
          } else if (event.kind === "session_error") {
            errorMessage = String(event.data?.message || "model error");
          } else if (event.kind === "turn_finished") {
            finished = true;
          }
        }
        if (finished) break;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      if (!finished) {
        throw new Error("Compiler model failed: timed out waiting for the Agent");
      }
      session.messages.push({
        role: "assistant",
        stopReason: errorMessage ? "error" : "stop",
        errorMessage,
        content: [{ type: "text", text: sawCompleted ? completed : deltas }],
      });
    },
    async waitForIdle() {},
    async dispose() {
      await request("DELETE", `/v1/sessions/${sessionId}`).catch(() => {});
    },
  };
  return session;
}

module.exports = { createDaemonSession, encodeWorkspaceId, discoverDaemon };
