import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Mirrors of the pure functions in teamclu.ts. The extension is TypeScript
// embedded into amuxd, so these tests keep a copy of the logic and a guard
// that the copy still matches the source (see the last test).

const REDACTED_CLOUD_TOKEN = "[teamclu:cloud-access-token redacted]";
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

function unknownJwtIn(text, known) {
  for (const m of text.match(JWT_LIKE) ?? []) {
    if (!known.has(m)) return true;
  }
  return false;
}

function redactKnownCloudTokens(text, tokens) {
  let out = text;
  for (const token of tokens) {
    if (token && out.includes(token)) out = out.split(token).join(REDACTED_CLOUD_TOKEN);
  }
  return out;
}

function redactToolResult(content, structuredContent, tokens) {
  let changed = false;
  const nextContent = content.map((part) => {
    if (!part || part.type !== "text" || typeof part.text !== "string") return part;
    const text = redactKnownCloudTokens(part.text, tokens);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  let nextStructured = structuredContent;
  if (structuredContent !== undefined) {
    const raw = JSON.stringify(structuredContent);
    const scrubbed = typeof raw === "string" ? redactKnownCloudTokens(raw, tokens) : raw;
    if (scrubbed !== raw) {
      changed = true;
      nextStructured = JSON.parse(scrubbed);
    }
  }
  if (!changed) return undefined;
  return { content: nextContent, structuredContent: nextStructured };
}

/** Mirror of `cloudTokenRoute` in teamclu.ts: which way this host asks amuxd
 *  for the cloud token. The socket, when amuxd set one, is the only route on
 *  unix; the bearer route is what Windows keeps. */
function cloudTokenRoute(env) {
  const socketPath = env.TEAMCLU_RUNTIME_CONTEXT_SOCK?.trim();
  if (socketPath) return { kind: "unix-socket", socketPath };
  const baseUrl = env.TEAMCLU_RUNTIME_CONTEXT_URL?.trim()?.replace(/\/$/, "");
  const token = env.TEAMCLU_RUNTIME_CONTEXT_TOKEN?.trim();
  const generationId = env.TEAMCLU_HOST_GENERATION_ID?.trim();
  const backendKind = env.TEAMCLU_AGENT_BACKEND?.trim();
  if (!baseUrl || !token || !generationId || !backendKind) return undefined;
  return { kind: "tcp-bearer", baseUrl, token, generationId, backendKind };
}

const JWT_A = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkYWVtb24tYSIsImV4cCI6MX0.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const JWT_B = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkYWVtb24tYiIsImV4cCI6Mn0.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const RTCTX = "rtctx_0123456789abcdef0123456789abcdef";

test("every known token is replaced wherever it appears, others are left alone", () => {
  const text = `Authorization: Bearer ${JWT_A}\n{"token":"${JWT_A}"}\nother ${JWT_B} ${RTCTX}`;
  const out = redactKnownCloudTokens(text, [JWT_A, RTCTX]);
  assert.ok(!out.includes(JWT_A));
  assert.ok(!out.includes(RTCTX));
  assert.ok(out.includes(JWT_B), "a token the daemon never issued is not ours to hide");
  assert.equal(out.split(REDACTED_CLOUD_TOKEN).length - 1, 3);
});

test("an empty or unknown token set changes nothing", () => {
  assert.equal(redactKnownCloudTokens(`x ${JWT_A} y`, []), `x ${JWT_A} y`);
  assert.equal(redactKnownCloudTokens(`x ${JWT_A} y`, ["", undefined, JWT_B]), `x ${JWT_A} y`);
});

test("a JWT the daemon has not been asked about yet is what triggers a refresh", () => {
  assert.ok(unknownJwtIn(`token=${JWT_A}`, new Set()));
  assert.ok(!unknownJwtIn(`token=${JWT_A}`, new Set([JWT_A])));
  assert.ok(unknownJwtIn(`${JWT_A} and ${JWT_B}`, new Set([JWT_A])), "a new one next to a known one");
  assert.ok(!unknownJwtIn("eyJ short.x.y", new Set()));
  assert.ok(!unknownJwtIn("no tokens here", new Set()));
  // The host's own runtime-context token is not a JWT; it is redacted by
  // membership in the known set, never by shape.
  assert.ok(!unknownJwtIn(RTCTX, new Set()));
  // Calling twice on the same input must not be order-dependent (global
  // regex state): `match` resets lastIndex, `test`/`exec` would not.
  assert.ok(unknownJwtIn(`token=${JWT_A}`, new Set()));
});

test("tool result: text parts and structuredContent are redacted together, images untouched", () => {
  const content = [
    { type: "text", text: `got ${JWT_A}` },
    { type: "image", data: "AAAA", mimeType: "image/png" },
    { type: "text", text: "clean" },
  ];
  const structured = { accessToken: JWT_A, nested: [JWT_A, "x"] };
  const out = redactToolResult(content, structured, [JWT_A]);
  assert.ok(out);
  assert.equal(out.content[0].text, `got ${REDACTED_CLOUD_TOKEN}`);
  assert.equal(out.content[1], content[1]);
  assert.equal(out.content[2], content[2]);
  assert.deepEqual(out.structuredContent, {
    accessToken: REDACTED_CLOUD_TOKEN,
    nested: [REDACTED_CLOUD_TOKEN, "x"],
  });
});

test("tool result without any known token returns undefined so pi keeps the original", () => {
  const content = [{ type: "text", text: `other ${JWT_B}` }];
  assert.equal(redactToolResult(content, undefined, [JWT_A]), undefined);
  assert.equal(redactToolResult(content, { k: JWT_B }, [JWT_A]), undefined);
});

test("the socket amuxd names is the route, with the bearer route only in its absence", () => {
  const tcp = {
    TEAMCLU_RUNTIME_CONTEXT_URL: "http://127.0.0.1:49953/",
    TEAMCLU_RUNTIME_CONTEXT_TOKEN: RTCTX,
    TEAMCLU_HOST_GENERATION_ID: "pi-gen-1",
    TEAMCLU_AGENT_BACKEND: "pi",
  };
  assert.deepEqual(cloudTokenRoute({ ...tcp, TEAMCLU_RUNTIME_CONTEXT_SOCK: " /run/runtime-context.sock " }), {
    kind: "unix-socket",
    socketPath: "/run/runtime-context.sock",
  });
  assert.deepEqual(cloudTokenRoute(tcp), {
    kind: "tcp-bearer",
    baseUrl: "http://127.0.0.1:49953",
    token: RTCTX,
    generationId: "pi-gen-1",
    backendKind: "pi",
  });
  // Not an amuxd-spawned host: nothing to ask, nothing to seed.
  assert.equal(cloudTokenRoute({}), undefined);
  assert.equal(cloudTokenRoute({ ...tcp, TEAMCLU_RUNTIME_CONTEXT_TOKEN: "" }), undefined);
});

test("mirrored logic matches teamclu.ts", () => {
  const src = fs.readFileSync(
    fileURLToPath(new URL("./teamclu.ts", import.meta.url)),
    "utf8",
  );
  // The constants and the replacement are what decide behaviour; a drift in
  // either must fail here rather than silently diverge.
  assert.ok(src.includes(`const REDACTED_CLOUD_TOKEN = "${REDACTED_CLOUD_TOKEN}";`));
  assert.ok(src.includes(`const JWT_LIKE = ${JWT_LIKE.toString()};`));
  assert.ok(src.includes("out = out.split(token).join(REDACTED_CLOUD_TOKEN);"));
  assert.ok(src.includes('pi.on("tool_result"'));
  assert.ok(src.includes("/internal/runtime-context/cloud-token"));
  // The socket route, and that it is preferred: both halves of the mirror above.
  assert.ok(src.includes('const socketPath = env.TEAMCLU_RUNTIME_CONTEXT_SOCK?.trim();'));
  assert.ok(src.includes('if (socketPath) return { kind: "unix-socket", socketPath };'));
  assert.ok(src.includes("http.request("));
});
