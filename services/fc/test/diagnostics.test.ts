import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createHonoRouterAdapter } from "../src/lib/hono-adapter.js";
import { registerDiagnostics } from "../src/lib/routes/diagnostics.js";
import { uploadDiagnostic, downloadDiagnostic, MAX_DIAGNOSTIC_BYTES, DIAGNOSTIC_RETENTION_MS, type DiagnosticStorage } from "../src/lib/diagnostic-storage.js";
import { ApiError } from "../src/lib/http-utils.js";

const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(26), Buffer.from([0x50, 0x4b, 5, 6]), Buffer.alloc(18)]);
function fixture() {
  const objects = new Map<string, { bytes: Buffer; metadata: Record<string, string> }>();
  const signed: { key: string; seconds: number }[] = [];
  const storage: DiagnosticStorage = {
    async put(key, bytes, metadata) { objects.set(key, { bytes, metadata }); },
    async head(key) { return objects.get(key)?.metadata ?? null; },
    async signDownload(key, seconds) { signed.push({ key, seconds }); return "https://private.example/signed"; },
  };
  return { storage, objects, signed };
}
function appFor(storage: DiagnosticStorage, userId = "owner", operator = false) {
  const app = new Hono();
  registerDiagnostics(createHonoRouterAdapter(app, {
    createRepository: ({ accessToken }) => ({
      async getAdminWhoami() {
        if (accessToken !== "valid") throw new ApiError(401, "missing_auth", "Invalid session");
        return { userId, operator };
      },
    }),
    createAuthRepository: () => ({}),
  }), () => storage);
  return app;
}
const headers = { Authorization: "Bearer valid", "Content-Type": "application/zip" };

test("authenticated upload stores exact bytes, private metadata, and copyable receipt", async () => {
  const f = fixture();
  const res = await appFor(f.storage).request("/v1/diagnostics", { method: "POST", headers, body: zip });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const receipt = await res.json() as any;
  assert.match(receipt.receiptId, /^[0-9a-f-]{36}$/);
  assert.equal(f.objects.size, 1);
  const object = f.objects.get(`diagnostics/${receipt.receiptId}.zip`)!;
  assert.deepEqual(object.bytes, zip);
  assert.equal(object.metadata["owner-id"], "owner");
  assert.equal(object.metadata["expires-at"], receipt.expiresAt);
  assert.match(object.metadata.sha256, /^[0-9a-f]{64}$/);
  assert.equal(f.signed.length, 0, "upload does not disclose a bearer download URL");
});

test("both routes reject missing and invalid auth without reading/writing storage", async () => {
  const f = fixture();
  for (const authorization of [undefined, "Bearer invalid"]) {
    for (const path of ["/v1/diagnostics", "/v1/diagnostics/00000000-0000-4000-8000-000000000000"]) {
      const res = await appFor(f.storage).request(path, {
        method: path.endsWith("diagnostics") ? "POST" : "GET",
        headers: authorization ? { Authorization: authorization } : {},
      });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  }
  assert.equal(f.objects.size, 0);
  assert.equal(f.signed.length, 0);
});

test("owner or platform operator can resolve receipt; other users and missing objects cannot", async () => {
  const f = fixture();
  const receipt = await uploadDiagnostic("owner", zip, "application/zip", f.storage);
  for (const [userId, operator, expected] of [["owner", false, 200], ["other", false, 404], ["support", true, 200]] as const) {
    const res = await appFor(f.storage, userId, operator).request(`/v1/diagnostics/${receipt.receiptId}`, { headers });
    assert.equal(res.status, expected);
    if (expected === 200) assert.equal((await res.json() as any).downloadUrl, "https://private.example/signed");
  }
  assert.equal(f.signed.length, 2);
  assert.equal(f.signed[0].seconds <= 900, true);
  await assert.rejects(downloadDiagnostic("00000000-0000-4000-8000-000000000000", { userId: "owner", operator: false }, f.storage), { statusCode: 404 });
});

test("expiry denies signing and limits URL lifetime to remaining retention", async () => {
  const f = fixture();
  const now = Date.now();
  const receipt = await uploadDiagnostic("owner", zip, "application/zip", f.storage, now);
  const caller = { userId: "owner", operator: true };
  await downloadDiagnostic(receipt.receiptId, caller, f.storage, now + DIAGNOSTIC_RETENTION_MS - 20_000);
  assert.equal(f.signed[0].seconds, 20);
  await assert.rejects(downloadDiagnostic(receipt.receiptId, caller, f.storage, now + DIAGNOSTIC_RETENTION_MS), { statusCode: 410 });
  assert.equal(f.signed.length, 1);
});

test("invalid content, size, receipt traversal are rejected", async () => {
  const f = fixture();
  await assert.rejects(uploadDiagnostic("u", zip, "text/plain", f.storage), { statusCode: 415 });
  await assert.rejects(uploadDiagnostic("u", Buffer.alloc(0), "application/zip", f.storage), { statusCode: 413 });
  await assert.rejects(uploadDiagnostic("u", Buffer.alloc(MAX_DIAGNOSTIC_BYTES + 1), "application/zip", f.storage), { statusCode: 413 });
  await assert.rejects(uploadDiagnostic("u", Buffer.from("this is not a valid archive"), "application/zip", f.storage), { statusCode: 422 });
  await assert.rejects(downloadDiagnostic("../other", { userId: "u", operator: true }, f.storage), { statusCode: 400 });
  assert.equal(f.objects.size, 0);
});

test("adapter caps declared and chunked uploads before the handler", async () => {
  const f = fixture();
  const app = appFor(f.storage, "size-owner");
  const declared = await app.request("/v1/diagnostics", { method: "POST", headers: { ...headers, "Content-Length": String(MAX_DIAGNOSTIC_BYTES + 1) }, body: zip });
  assert.equal(declared.status, 413);
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(MAX_DIAGNOSTIC_BYTES));
    controller.enqueue(new Uint8Array(1));
    controller.close();
  } });
  const chunked = await app.request("/v1/diagnostics", { method: "POST", headers, body: stream, duplex: "half" } as any);
  assert.equal(chunked.status, 413);
  const dishonest = await app.request("/v1/diagnostics", {
    method: "POST", headers: { ...headers, "Content-Length": "1" },
    body: Buffer.alloc(MAX_DIAGNOSTIC_BYTES + 1),
  });
  assert.equal(dishonest.status, 413);
  assert.equal(f.objects.size, 0);
});

test("readable storage failures do not leak storage internals; missing config is 503", async () => {
  const f = fixture();
  f.storage.put = async () => { throw new Error("private bucket signature secret"); };
  const res = await appFor(f.storage, "failure-owner").request("/v1/diagnostics", { method: "POST", headers, body: zip });
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /signature secret/);
  const app = new Hono();
  registerDiagnostics(createHonoRouterAdapter(app, { createRepository: () => ({ getAdminWhoami: async () => ({ userId: "config-owner" }) }), createAuthRepository: () => ({}) }), () => { throw new ApiError(503, "diagnostics_unavailable", "Not configured"); });
  const unavailable = await app.request("/v1/diagnostics", { method: "POST", headers, body: zip });
  assert.equal(unavailable.status, 503);
});

test("per-user rate limit prevents unlimited repeated uploads", async () => {
  const f = fixture();
  const app = appFor(f.storage, "rate-owner");
  for (let i = 0; i < 3; i++) {
    assert.equal((await app.request("/v1/diagnostics", { method: "POST", headers, body: zip })).status, 201);
  }
  assert.equal((await app.request("/v1/diagnostics", { method: "POST", headers, body: zip })).status, 429);
});


test("real route registration is authenticated and fails closed without storage config", async () => {
  const { createApp } = await import("../src/app.js");
  const app = createApp({
    createRepository: () => ({ getAdminWhoami: async () => ({ userId: "real-route-owner", operator: false }) }),
    createAuthRepository: () => ({}),
  });
  const previous = process.env.DIAGNOSTICS_STORAGE_BUCKET;
  delete process.env.DIAGNOSTICS_STORAGE_BUCKET;
  try {
    const res = await app.request("/v1/diagnostics", { method: "POST", headers, body: zip });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("cache-control"), "no-store");
  } finally {
    if (previous === undefined) delete process.env.DIAGNOSTICS_STORAGE_BUCKET;
    else process.env.DIAGNOSTICS_STORAGE_BUCKET = previous;
  }
});
