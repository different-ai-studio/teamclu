import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { buildBootstrapConfig, buildPublicConfig } from "../src/lib/routes/config.js";
import { FEATURE_PROFILES } from "../src/lib/feature-profiles.js";

async function withEnv(overrides: Record<string, any>, fn: () => any) {
  const restore: Record<string, any> = {};
  for (const [key, value] of Object.entries(overrides)) {
    restore[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    // Await so env is held in place until the (possibly async) callback fully
    // resolves — otherwise the finally block restores env before an awaited
    // handler reads it.
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("buildBootstrapConfig returns mqtt block when env is set", () => {
  withEnv(
    {
      MQTT_BROKER_URL: "mqtts://mqtt.example.com:8883",
      MQTT_USERNAME: "user-1",
      MQTT_PASSWORD: "secret",
      MQTT_USE_TLS: "true",
      MQTT_PUBLIC_TCP_BROKER_URL: undefined,
      WEBSSO_LOGIN_URL: undefined,
    },
    () => {
      const cfg = buildBootstrapConfig();
      // Credentials are NEVER forwarded to clients — they authenticate to EMQX
      // with username=actor_id, password=<Supabase access_token> (JWT auth).
      assert.deepEqual(cfg, {
        mqtt: {
          url: "mqtts://mqtt.example.com:8883",
          useTls: true,
        },
      });
    },
  );
});

test("buildBootstrapConfig includes tcpUrl when MQTT_PUBLIC_TCP_BROKER_URL is set", () => {
  withEnv(
    {
      MQTT_BROKER_URL: "wss://claw.example.com/mqtt",
      MQTT_PUBLIC_TCP_BROKER_URL: "mqtt://claw.example.com:8080",
      MQTT_USE_TLS: undefined,
      WEBSSO_LOGIN_URL: undefined,
    },
    () => {
      assert.deepEqual(buildBootstrapConfig(), {
        mqtt: {
          url: "wss://claw.example.com/mqtt",
          tcpUrl: "mqtt://claw.example.com:8080",
        },
      });
    },
  );
});

test("Belayo bootstrap advertises WSS while preserving the native TCP fallback", () => {
  withEnv(
    {
      MQTT_BROKER_URL: "wss://mqtt.service.ucar.cc/mqtt",
      MQTT_PUBLIC_TCP_BROKER_URL: "mqtt://transport.service.ucar.cc:1883",
      MQTT_USE_TLS: "true",
      WEBSSO_LOGIN_URL: undefined,
    },
    () => {
      assert.deepEqual(buildBootstrapConfig(), {
        mqtt: {
          url: "wss://mqtt.service.ucar.cc/mqtt",
          tcpUrl: "mqtt://transport.service.ucar.cc:1883",
          useTls: true,
        },
      });
    },
  );
});

test("MQTT_BROKER_URL is the only broker source — the public override is gone", () => {
  // There used to be an MQTT_PUBLIC_BROKER_URL override in front of this. It is
  // deleted, deliberately: every deployment declared it with an empty default,
  // `""` is not nullish, so the documented fallback to MQTT_BROKER_URL never
  // fired and bootstrap answered 200 with no `mqtt` block at all — clients
  // reported "the server did not deliver an MQTT address" while the daemon,
  // which never reads this endpoint, stayed connected and masked it (#634, then
  // belayo). Only `undefined` had ever been tested, which is how it survived.
  //
  // A leftover value for the old name must now be inert, not authoritative:
  // stale env entries on already-deployed functions would otherwise keep
  // deciding what clients connect to.
  withEnv(
    {
      MQTT_BROKER_URL: "mqtt://mqtt.example.com:1883",
      MQTT_PUBLIC_BROKER_URL: "mqtt://stale-override.example.com:1883",
      MQTT_PUBLIC_TCP_BROKER_URL: "",
      MQTT_USE_TLS: undefined,
      WEBSSO_LOGIN_URL: undefined,
    },
    () => {
      assert.deepEqual(buildBootstrapConfig(), {
        mqtt: { url: "mqtt://mqtt.example.com:1883" },
      });
    },
  );
});

test("an empty MQTT_BROKER_URL omits mqtt — it never resurrects the old name", () => {
  withEnv(
    {
      MQTT_BROKER_URL: "",
      MQTT_PUBLIC_BROKER_URL: "mqtt://stale-override.example.com:1883",
      MQTT_PUBLIC_TCP_BROKER_URL: undefined,
      MQTT_USE_TLS: undefined,
      WEBSSO_LOGIN_URL: undefined,
    },
    () => {
      assert.deepEqual(buildBootstrapConfig(), {});
    },
  );
});

test("blank web SSO env is treated as absent", () => {
  withEnv(
    {
      MQTT_BROKER_URL: undefined,
      MQTT_PUBLIC_BROKER_URL: undefined,
      WEBSSO_LOGIN_URL: "  ",
      WEBSSO_STORAGE_KEY: "",
    },
    () => {
      assert.deepEqual(buildBootstrapConfig(), {});
    },
  );
});

test("buildBootstrapConfig omits mqtt when broker url is missing", () => {
  withEnv(
    {
      MQTT_BROKER_URL: undefined,
      MQTT_PUBLIC_BROKER_URL: undefined,
      MQTT_USERNAME: "user-1",
      MQTT_PASSWORD: "secret",
      MQTT_USE_TLS: "true",
    },
    () => {
      assert.deepEqual(buildBootstrapConfig(), {});
    },
  );
});

test("a whitespace-only broker url omits mqtt rather than emitting an empty url", () => {
  withEnv(
    {
      MQTT_BROKER_URL: "   ",
      MQTT_USE_TLS: "true",
      WEBSSO_LOGIN_URL: undefined,
    },
    () => {
      assert.deepEqual(buildBootstrapConfig(), {});
    },
  );
});

test("GET /v1/config/bootstrap requires bearer auth", async () => {
  const response = await handleBusinessApiRequest(
    { httpMethod: "GET", path: "/v1/config/bootstrap", headers: {} },
    { createRepository: () => ({}), createAuthRepository: () => ({}) },
  );
  assert.equal(response.statusCode, 401);
  const body = JSON.parse(response.body);
  assert.equal(body.error.code, "missing_auth");
});

test("GET /v1/config/bootstrap returns env-derived mqtt config to authed callers", async () => {
  await withEnv(
    {
      MQTT_BROKER_URL: "wss://mqtt.example.com:8884",
      MQTT_PUBLIC_TCP_BROKER_URL: undefined,
      MQTT_USERNAME: undefined,
      MQTT_PASSWORD: undefined,
      MQTT_USE_TLS: undefined,
      WEBSSO_LOGIN_URL: undefined,
    },
    async () => {
      const response = await handleBusinessApiRequest(
        {
          httpMethod: "GET",
          path: "/v1/config/bootstrap",
          headers: { Authorization: "Bearer caller-token" },
        },
        { createRepository: () => ({}), createAuthRepository: () => ({}) },
      );
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.deepEqual(body, {
        mqtt: { url: "wss://mqtt.example.com:8884" },
      });
    },
  );
});

test("buildBootstrapConfig returns webSso block when env is set", () => {
  withEnv(
    {
      MQTT_BROKER_URL: undefined,
      WEBSSO_LOGIN_URL: "https://admin.example.test/sign-in",
      WEBSSO_STORAGE_KEY: "sb-test-supa-auth-token",
    },
    () => {
      assert.deepEqual(buildBootstrapConfig(), {
        webSso: {
          loginUrl: "https://admin.example.test/sign-in",
          storageKey: "sb-test-supa-auth-token",
        },
      });
    },
  );
});

test("buildBootstrapConfig omits webSso when login url is missing", () => {
  withEnv(
    {
      MQTT_BROKER_URL: undefined,
      WEBSSO_LOGIN_URL: undefined,
      WEBSSO_STORAGE_KEY: "sb-test-supa-auth-token",
    },
    () => {
      assert.deepEqual(buildBootstrapConfig(), {});
    },
  );
});

test("GET /v1/config/public returns webSso WITHOUT auth (login-time config)", async () => {
  await withEnv(
    {
      MQTT_BROKER_URL: "mqtts://secret.example.com:8883",
      WEBSSO_LOGIN_URL: "https://admin.example.test/sign-in",
      WEBSSO_STORAGE_KEY: "sb-test-supa-auth-token",
    },
    async () => {
      const response = await handleBusinessApiRequest(
        { httpMethod: "GET", path: "/v1/config/public", headers: {} },
        { createRepository: () => ({}), createAuthRepository: () => ({}) },
      );
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      // webSso is present; the sensitive mqtt block is NEVER in the public config.
      assert.deepEqual(body, {
        webSso: {
          loginUrl: "https://admin.example.test/sign-in",
          storageKey: "sb-test-supa-auth-token",
        },
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

const NO_FEATURES = { APP_FEATURES_PROFILE: undefined, APP_FEATURES_JSON: undefined };

test("no profile and no override emits no features block at all", () => {
  withEnv(
    { MQTT_BROKER_URL: "wss://mqtt.example.com/mqtt", WEBSSO_LOGIN_URL: undefined, ...NO_FEATURES },
    () => {
      assert.deepEqual(buildBootstrapConfig(), { mqtt: { url: "wss://mqtt.example.com/mqtt" } });
      assert.deepEqual(buildPublicConfig(), {});
    },
  );
});

test("an unknown profile name degrades to no overrides instead of throwing", () => {
  withEnv(
    { MQTT_BROKER_URL: undefined, WEBSSO_LOGIN_URL: undefined, APP_FEATURES_PROFILE: "typo-here", APP_FEATURES_JSON: undefined },
    () => {
      // A misspelled profile is a config mistake, not an outage: the deploy
      // must still serve, just without overrides.
      assert.deepEqual(buildBootstrapConfig(), {});
      assert.deepEqual(buildPublicConfig(), {});
    },
  );
});

test("auth goes to public ONLY and channels to bootstrap ONLY — never both", () => {
  withEnv(
    {
      MQTT_BROKER_URL: undefined,
      WEBSSO_LOGIN_URL: undefined,
      APP_FEATURES_PROFILE: undefined,
      APP_FEATURES_JSON: JSON.stringify({
        auth: { google: true, phone: false },
        channels: { discord: false },
        apps: true,
      }),
    },
    () => {
      assert.deepEqual(buildPublicConfig(), { features: { auth: { google: true, phone: false } } });
      assert.deepEqual(buildBootstrapConfig(), {
        features: { channels: { discord: false }, apps: true },
      });
    },
  );
});

test("unknown keys and non-boolean values are dropped, not coerced", () => {
  withEnv(
    {
      MQTT_BROKER_URL: undefined,
      WEBSSO_LOGIN_URL: undefined,
      APP_FEATURES_PROFILE: undefined,
      // "false" as a STRING is the dangerous one: coercing it would enable the
      // feature it was written to disable.
      // teamShareBrowser is retired: the team-share sidebar ships in every
      // brand, so a stale deployment still sending it must not reach clients.
      APP_FEATURES_JSON: JSON.stringify({
        apps: "false",
        nope: true,
        teamShareBrowser: true,
        lockLlmConfig: true,
      }),
    },
    () => {
      assert.deepEqual(buildBootstrapConfig(), { features: { lockLlmConfig: true } });
    },
  );
});

test("updater is never served, even when a deployment sets it", () => {
  withEnv(
    {
      MQTT_BROKER_URL: undefined,
      WEBSSO_LOGIN_URL: undefined,
      APP_FEATURES_PROFILE: undefined,
      APP_FEATURES_JSON: JSON.stringify({ updater: false, apps: true }),
    },
    () => {
      // Remotely disabling the updater would strand the installed fleet with no
      // way to update out of the mistake. It is build-time only, by design.
      const cfg: any = buildBootstrapConfig();
      assert.equal("updater" in cfg.features, false);
      assert.deepEqual(cfg.features, { apps: true });
    },
  );
});

test("APP_FEATURES_JSON overrides the profile key-by-key, not block-by-block", () => {
  FEATURE_PROFILES["test-merge"] = {
    auth: { google: true, phone: true },
    channels: { discord: true, feishu: true },
    apps: true,
  };
  try {
    withEnv(
      {
        MQTT_BROKER_URL: undefined,
        WEBSSO_LOGIN_URL: undefined,
        APP_FEATURES_PROFILE: "test-merge",
        APP_FEATURES_JSON: JSON.stringify({ auth: { google: false } }),
      },
      () => {
        // Turning off exactly one flag in an emergency must not wipe the rest.
        assert.deepEqual(buildPublicConfig(), {
          features: { auth: { google: false, phone: true } },
        });
        assert.deepEqual(buildBootstrapConfig(), {
          features: { channels: { discord: true, feishu: true }, apps: true },
        });
      },
    );
  } finally {
    delete FEATURE_PROFILES["test-merge"];
  }
});

test("invalid APP_FEATURES_JSON is ignored and leaves the profile intact", () => {
  FEATURE_PROFILES["test-badjson"] = { apps: true };
  try {
    withEnv(
      {
        MQTT_BROKER_URL: undefined,
        WEBSSO_LOGIN_URL: undefined,
        APP_FEATURES_PROFILE: "test-badjson",
        APP_FEATURES_JSON: "{not json",
      },
      () => {
        assert.deepEqual(buildBootstrapConfig(), { features: { apps: true } });
      },
    );
  } finally {
    delete FEATURE_PROFILES["test-badjson"];
  }
});

test("GET /v1/config/public serves auth flags without a bearer, and still no mqtt", async () => {
  await withEnv(
    {
      MQTT_BROKER_URL: "mqtts://secret.example.com:8883",
      WEBSSO_LOGIN_URL: undefined,
      APP_FEATURES_PROFILE: undefined,
      APP_FEATURES_JSON: JSON.stringify({ auth: { webSSO: true }, channels: { wecom: false } }),
    },
    async () => {
      const response = await handleBusinessApiRequest(
        { httpMethod: "GET", path: "/v1/config/public", headers: {} },
        { createRepository: () => ({}), createAuthRepository: () => ({}) },
      );
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.deepEqual(body, { features: { auth: { webSSO: true } } });
    },
  );
});

test("every shipped profile survives sanitization intact — no silently dropped key", () => {
  // A typo in a profile (`teamSharebrowser`, `webSso`) is dropped by the
  // allowlist and the deployment then serves a flag nobody notices is missing.
  // Round-tripping each profile through the real resolver catches that here
  // instead of in production.
  for (const [name, profile] of Object.entries(FEATURE_PROFILES)) {
    withEnv({ APP_FEATURES_PROFILE: name, APP_FEATURES_JSON: undefined }, () => {
      const served = {
        ...(buildPublicConfig().features ?? {}),
        ...(buildBootstrapConfig().features ?? {}),
      };
      assert.deepEqual(served, profile, `profile ${name} lost keys in transit`);
    });
  }
});

test("seatalk is on only for the copilot361 profile", () => {
  assert.equal(FEATURE_PROFILES["self-host"].channels?.seatalk, false);
  assert.equal(FEATURE_PROFILES.belayo.channels?.seatalk, false);
  assert.equal(FEATURE_PROFILES.copilot361.channels?.seatalk, true);
});

test("no shipped profile tries to control the updater", () => {
  for (const [name, profile] of Object.entries(FEATURE_PROFILES)) {
    assert.equal("updater" in profile, false, `profile ${name} must not set updater`);
  }
});
