"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDaemonSession, encodeWorkspaceId } = require("./daemon-session");

test("encodeWorkspaceId matches the daemon base64url workspace id", () => {
  assert.equal(encodeWorkspaceId("/tmp/wiki"), Buffer.from("/tmp/wiki").toString("base64url"));
});

test("createDaemonSession sets the chosen model and sends image attachments", async () => {
  const calls = [];
  const session = await createDaemonSession(
    {
      workspacePath: "/tmp/wiki",
      compilerModel: "opencode-go/deepseek-v4-flash-vision-exp",
    },
    {
      discover: async () => ({ baseUrl: "http://127.0.0.1:9", rootToken: "root" }),
      fetch: async (url, init) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, method: init?.method || "GET" });
        if (url.endsWith("/v1/auth/exchange")) {
          return json({ token: "scoped" });
        }
        if (url.endsWith("/v1/sessions") && init?.method === "POST") {
          return json({ session_id: "sess-1" });
        }
        if (url.endsWith("/model")) return json({}, 202);
        if (url.endsWith("/prompt")) return json({ prompt_id: "p1", turn_id: "t1" }, 202);
        if (url.includes("/events")) {
          return json({
            events: [
              { seq: 1, kind: "message_completed", data: { content: "明天放假" } },
              { seq: 2, kind: "turn_finished", data: {} },
            ],
          });
        }
        return json({}, 404);
      },
    },
  );
  await session.prompt("读出图片里的字", {
    images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
  });
  assert.equal(calls[0].url, "http://127.0.0.1:9/v1/auth/exchange");
  assert.deepEqual(calls[0].body.scopes.sort(), [
    "events:read",
    "sessions:read",
    "sessions:write",
    "workspace:read",
  ]);
  const created = calls.find((call) => call.url.endsWith("/v1/sessions") && call.method === "POST");
  assert.equal(created.body.workspace_id, encodeWorkspaceId("/tmp/wiki"));
  assert.equal(created.body.model, "opencode-go/deepseek-v4-flash-vision-exp");
  const model = calls.find((call) => call.url.endsWith("/model"));
  assert.equal(model.body.model_id, "opencode-go/deepseek-v4-flash-vision-exp");
  const prompt = calls.find((call) => call.url.endsWith("/prompt"));
  assert.equal(prompt.body.text, "读出图片里的字");
  assert.deepEqual(prompt.body.attachments, ["data:image/png;base64,QUJD"]);
  assert.equal(session.messages.at(-1).content[0].text, "明天放假");
  assert.equal(session.messages.at(-1).stopReason, "stop");
});

test("createDaemonSession uses the Agent default workspace when none is given", async () => {
  const calls = [];
  await createDaemonSession(
    { compilerModel: "opencode-go/deepseek-v4-flash-vision-exp" },
    {
      discover: async () => ({ baseUrl: "http://127.0.0.1:9", rootToken: "root" }),
      fetch: async (url, init) => {
        calls.push({
          url,
          method: init?.method || "GET",
          body: init?.body ? JSON.parse(init.body) : null,
        });
        if (url.endsWith("/v1/auth/exchange")) return json({ token: "scoped" });
        if (url.endsWith("/v1/agent/default-workspace")) return json({ path: "/tmp/project" });
        if (url.endsWith("/v1/sessions") && init?.method === "POST") {
          return json({ session_id: "sess-1" });
        }
        if (url.endsWith("/model")) return json({}, 202);
        return json({ events: [{ seq: 1, kind: "turn_finished", data: {} }] });
      },
    },
  );
  const created = calls.find((call) => call.url.endsWith("/v1/sessions") && call.method === "POST");
  assert.equal(created.body.workspace_id, encodeWorkspaceId("/tmp/project"));
  assert.equal(
    calls.some((call) => String(call.url).includes("/Users/") || String(call.body || "").includes("/Users/")),
    false,
  );
});

test("createDaemonSession stops when the Agent has no workspace", async () => {
  await assert.rejects(
    () =>
      createDaemonSession(
        { compilerModel: "opencode-go/vision" },
        {
          discover: async () => ({ baseUrl: "http://127.0.0.1:9", rootToken: "root" }),
          fetch: async (url) => {
            if (url.endsWith("/v1/auth/exchange")) return json({ token: "scoped" });
            if (url.endsWith("/v1/agent/default-workspace")) return json({ path: null });
            return json({}, 404);
          },
        },
      ),
    /no workspace/,
  );
});

test("createDaemonSession records a daemon model error on the assistant message", async () => {
  const session = await createDaemonSession(
    { workspacePath: "/tmp/wiki", compilerModel: "opencode-go/vision" },
    {
      discover: async () => ({ baseUrl: "http://127.0.0.1:9", rootToken: "root" }),
      fetch: async (url, init) => {
        if (url.endsWith("/v1/auth/exchange")) return json({ token: "scoped" });
        if (url.endsWith("/v1/sessions") && init?.method === "POST") return json({ session_id: "sess-1" });
        if (url.endsWith("/model")) return json({}, 202);
        if (url.endsWith("/prompt")) return json({}, 202);
        return json({
          events: [
            { seq: 1, kind: "session_error", data: { message: "model does not support image input" } },
            { seq: 2, kind: "turn_finished", data: {} },
          ],
        });
      },
    },
  );
  await session.prompt("看图", { images: [{ type: "image", data: "QUJD", mimeType: "image/png" }] });
  assert.equal(session.messages.at(-1).stopReason, "error");
  assert.match(session.messages.at(-1).errorMessage, /does not support image input/);
});

test("createDaemonSession closes the daemon session once, even when the turn times out", async () => {
  const deletes = [];
  const session = await createDaemonSession(
    { workspacePath: "/tmp/wiki" },
    {
      discover: async () => ({ baseUrl: "http://127.0.0.1:9", rootToken: "root" }),
      timeoutMs: 20,
      intervalMs: 1,
      fetch: async (url, init) => {
        if (url.endsWith("/v1/auth/exchange")) return json({ token: "scoped" });
        if (url.endsWith("/v1/sessions") && init?.method === "POST") return json({ session_id: "sess-1" });
        if (init?.method === "DELETE") {
          deletes.push(url);
          return json({}, 204);
        }
        if (url.endsWith("/prompt")) return json({}, 202);
        return json({ events: [{ seq: 1, kind: "token_delta", data: { text: "半截" } }] });
      },
    },
  );
  await assert.rejects(session.prompt("编译"), /timed out waiting for the Agent/);
  await session.dispose();
  assert.deepEqual(deletes, ["http://127.0.0.1:9/v1/sessions/sess-1"]);
});

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}
