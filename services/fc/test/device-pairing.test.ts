import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { jwtVerify } from "jose";
import { mintDeviceMqttJwt } from "../src/lib/device-mqtt-jwt.js";
import {
  createDevicePairingCode,
  generateDeviceSecret,
  mintDeviceAccessToken,
  redeemDevicePairingCode,
  sha256Hex,
} from "../src/lib/device-pairing.js";
import { registerDevices } from "../src/lib/routes/devices.js";

const SECRET = "test-device-mqtt-jwt-secret-at-least-32b";
const TEAM = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";

function sha(s: string) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** In-memory stand-in for the service-role Supabase client. */
function makeFakeAdmin(seed: {
  codes?: Map<string, any>;
  devices?: Map<string, any>;
} = {}) {
  const codes = seed.codes ?? new Map<string, any>();
  const devices = seed.devices ?? new Map<string, any>();

  function from(table: string) {
    if (table === "device_pairing_codes") {
      return {
        insert: async (row: any) => {
          if ([...codes.values()].some((c) => c.code_hash === row.code_hash)) {
            return { error: { message: "duplicate key value violates unique constraint" } };
          }
          const id = crypto.randomUUID();
          codes.set(id, { id, redeemed_at: null, ...row });
          return { error: null };
        },
        select: (_cols: string) => ({
          eq: (_col: string, hash: string) => ({
            maybeSingle: async () => {
              const row = [...codes.values()].find((c) => c.code_hash === hash) ?? null;
              return { data: row, error: null };
            },
          }),
        }),
        update: (patch: any) => ({
          eq: (_col: string, id: string) => ({
            is: (_c: string, _v: null) => ({
              select: () => ({
                maybeSingle: async () => {
                  const row = codes.get(id);
                  if (!row || row.redeemed_at) return { data: null, error: null };
                  Object.assign(row, patch);
                  return { data: { id }, error: null };
                },
              }),
            }),
          }),
        }),
      };
    }
    if (table === "devices") {
      return {
        insert: async (row: any) => {
          if (devices.has(row.id)) {
            return { error: { message: "duplicate key value violates unique constraint devices_pkey" } };
          }
          devices.set(row.id, { ...row, revoked_at: null });
          return { error: null };
        },
        delete: () => ({
          eq: (col: string, val: string) => ({
            eq: async () => {
              if (col === "id") devices.delete(val);
              return { error: null };
            },
          }),
        }),
        select: (_cols: string) => {
          const filters: Record<string, string> = {};
          const api: any = {
            eq: (col: string, val: string) => {
              filters[col] = val;
              return api;
            },
            maybeSingle: async () => {
              const row =
                [...devices.values()].find((d) => {
                  if (filters.secret_hash && d.secret_hash !== filters.secret_hash) return false;
                  if (filters.id && d.id !== filters.id) return false;
                  return true;
                }) ?? null;
              return { data: row, error: null };
            },
          };
          return api;
        },
        update: () => ({
          eq: async () => ({ error: null }),
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  }

  return {
    client: {
      from,
      rpc: async () => ({ data: null, error: null }),
    },
    codes,
    devices,
  };
}

test("sha256Hex is stable and hex-64", () => {
  assert.equal(sha256Hex("abc"), sha("abc"));
  assert.match(sha256Hex("abc"), /^[0-9a-f]{64}$/);
});

test("mintDeviceMqttJwt fails closed without EMQX_JWT_SECRET", async () => {
  const prev = process.env.EMQX_JWT_SECRET;
  delete process.env.EMQX_JWT_SECRET;
  try {
    await assert.rejects(
      mintDeviceMqttJwt({ teamId: TEAM, actorId: ACTOR, deviceId: "c19518" }),
      /EMQX_JWT_SECRET/,
    );
  } finally {
    if (prev === undefined) delete process.env.EMQX_JWT_SECRET;
    else process.env.EMQX_JWT_SECRET = prev;
  }
});

test("mintDeviceMqttJwt signs team/actor/broker claims", async () => {
  const prev = process.env.EMQX_JWT_SECRET;
  const prevBroker = process.env.MQTT_BROKER_URL;
  process.env.EMQX_JWT_SECRET = SECRET;
  process.env.MQTT_BROKER_URL = "wss://mqtt.example/mqtt";
  try {
    const out = await mintDeviceMqttJwt({
      teamId: TEAM,
      actorId: ACTOR,
      deviceId: "c19518",
    });
    assert.ok(out.accessToken.split(".").length === 3);
    assert.equal(out.broker, "wss://mqtt.example/mqtt");
    const { payload } = await jwtVerify(
      out.accessToken,
      // Same derivation as `signingKey()`: the broker's authenticator sets
      // `secret_base64_encoded = true`, so the key is the decoded bytes.
      Buffer.from(SECRET, "base64"),
      { issuer: "teamclu-fc", audience: "teamclu-device-mqtt" },
    );
    assert.equal(payload.team, TEAM);
    assert.equal(payload.actor, ACTOR);
    assert.equal(payload.team_id, TEAM);
    assert.equal(payload.device_id, "c19518");
    assert.equal(payload.broker, "wss://mqtt.example/mqtt");
  } finally {
    if (prev === undefined) delete process.env.EMQX_JWT_SECRET;
    else process.env.EMQX_JWT_SECRET = prev;
    if (prevBroker === undefined) delete process.env.MQTT_BROKER_URL;
    else process.env.MQTT_BROKER_URL = prevBroker;
  }
});

test("create → redeem → token round trip; second redeem is 409", async () => {
  const prev = process.env.EMQX_JWT_SECRET;
  process.env.EMQX_JWT_SECRET = SECRET;
  const fake = makeFakeAdmin();
  const deps = { createServiceRoleClient: async () => fake.client };

  const code = "PAIR-CODE-1";
  const created = await createDevicePairingCode(
    { code, teamId: TEAM, actorId: ACTOR, ttlSeconds: 600 },
    deps,
  );
  assert.equal(created.code, code);
  assert.ok(Date.parse(created.expiresAt) > Date.now());

  const redeemed = await redeemDevicePairingCode(
    { code, deviceId: "c19518", model: "stopwatch", fw: "0.1.0" },
    deps,
  );
  assert.ok(redeemed.deviceSecret.length >= 32);
  assert.equal(redeemed.teamId, TEAM);
  // Cleartext never stored
  assert.ok([...fake.codes.values()].every((c) => !JSON.stringify(c).includes(code)));
  assert.ok(
    [...fake.devices.values()].every((d) => !JSON.stringify(d).includes(redeemed.deviceSecret)),
  );

  await assert.rejects(
    () => redeemDevicePairingCode({ code, deviceId: "aabbcc" }, deps),
    (e: any) => e.statusCode === 409 && e.code === "pairing_code_redeemed",
  );

  const token = await mintDeviceAccessToken(
    { deviceSecret: redeemed.deviceSecret, deviceId: "c19518" },
    deps,
  );
  assert.equal(token.teamId, TEAM);
  assert.equal(token.actorId, ACTOR);
  assert.ok(token.accessToken);

  await assert.rejects(
    () => mintDeviceAccessToken({ deviceSecret: generateDeviceSecret() }, deps),
    (e: any) => e.statusCode === 401,
  );

  if (prev === undefined) delete process.env.EMQX_JWT_SECRET;
  else process.env.EMQX_JWT_SECRET = prev;
});

test("expired pairing code is rejected", async () => {
  const fake = makeFakeAdmin();
  const deps = { createServiceRoleClient: async () => fake.client };
  const code = "EXPIRED1";
  await createDevicePairingCode(
    { code, teamId: TEAM, actorId: ACTOR, ttlSeconds: 60 },
    deps,
  );
  // Force-expire the stored row
  const row = [...fake.codes.values()][0];
  row.expires_at = new Date(Date.now() - 1000).toISOString();

  await assert.rejects(
    () => redeemDevicePairingCode({ code, deviceId: "c19518" }, deps),
    (e: any) => e.statusCode === 409 && e.code === "pairing_code_expired",
  );
});

test("device routes are registered", () => {
  const routes: Array<[string, string]> = [];
  const router = {
    get: () => {},
    put: () => {},
    patch: () => {},
    delete: () => {},
    post: (p: string, optsOrHandler: unknown, maybeHandler?: unknown) => {
      routes.push(["POST", p]);
      void optsOrHandler;
      void maybeHandler;
    },
  };
  registerDevices(router);
  assert.deepEqual(
    routes.map(([, p]) => p).sort(),
    ["/v1/devices/pairing-codes", "/v1/devices/redeem", "/v1/devices/token"].sort(),
  );
});
