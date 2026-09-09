import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ENV_VARS_PER_APP,
  RESERVED_ENV_KEYS,
  isReservedEnvKey,
  mergeAppEnv,
  parseEnvKey,
  parseEnvValue,
} from "../src/lib/app-env.js";
import { finalizeDeploy } from "../src/lib/provisioning/app-deploy.js";
import { open as openSecret, seal as sealSecret } from "../src/lib/provisioning/app-secrets.js";

const rejects = (fn: () => unknown, match: RegExp) =>
  assert.throws(fn, (e: any) => e.statusCode === 400 && match.test(e.message), "accepted it");

// --- names -------------------------------------------------------------------

test("an ordinary env name is accepted unchanged", () => {
  for (const key of ["STRIPE_KEY", "_private", "A1", "log_level"]) {
    assert.equal(parseEnvKey(key), key);
  }
});

test("a name the runtime could never look up is refused, not repaired", () => {
  // Trimming " KEY" would leave the operator looking at a variable that reads
  // correctly in the panel and does not exist in the process.
  rejects(() => parseEnvKey(" KEY"), /letters, digits and underscores/);
  rejects(() => parseEnvKey("KEY "), /letters, digits and underscores/);
  rejects(() => parseEnvKey("1KEY"), /letters, digits and underscores/);
  rejects(() => parseEnvKey("MY-KEY"), /letters, digits and underscores/);
  rejects(() => parseEnvKey("MY KEY"), /letters, digits and underscores/);
  rejects(() => parseEnvKey(""), /required/);
  rejects(() => parseEnvKey(42), /required/);
  rejects(() => parseEnvKey("K".repeat(129)), /longer than/);
});

test("every name the platform sets is reserved, and says so by name", () => {
  for (const key of RESERVED_ENV_KEYS) {
    assert.ok(isReservedEnvKey(key), key);
    assert.throws(
      () => parseEnvKey(key),
      (e: any) => e.statusCode === 400 && e.code === "env_key_reserved",
      key,
    );
  }
});

test("the TEAMCLU_ prefix is reserved as a whole", () => {
  // Everything the platform tells an app about itself lives under it, so the
  // list above does not have to grow with every new capability.
  assert.ok(isReservedEnvKey("TEAMCLU_STORAGE_TOKEN"));
  assert.ok(isReservedEnvKey("TEAMCLU_ANYTHING_AT_ALL"));
  assert.ok(!isReservedEnvKey("TEAMCLU"), "the bare word is not the prefix");
  assert.ok(!isReservedEnvKey("MY_TEAMCLU_KEY"), "only a prefix, not a substring");
});

// --- values ------------------------------------------------------------------

test("an empty value is legitimate; a multi-line one is not", () => {
  assert.equal(parseEnvValue(""), "");
  rejects(() => parseEnvValue("a\nb"), /newlines or NUL/);
  rejects(() => parseEnvValue("a\r\nb"), /newlines or NUL/);
  rejects(() => parseEnvValue("a\0b"), /newlines or NUL/);
  rejects(() => parseEnvValue(null), /must be a string/);
  rejects(() => parseEnvValue("x".repeat(8193)), /larger than/);
});

test("the per-app ceiling is a number the error can name", () => {
  assert.equal(typeof MAX_ENV_VARS_PER_APP, "number");
  assert.ok(MAX_ENV_VARS_PER_APP > 0);
});

// --- the merge ---------------------------------------------------------------

test("the platform's variables win over the operator's, always", () => {
  const merged = mergeAppEnv(
    { DATABASE_URL: "postgres://attacker/", MY_KEY: "mine" },
    { DATABASE_URL: "postgres://real/", PORT: "9000" },
  );
  assert.equal(merged.DATABASE_URL, "postgres://real/");
  assert.equal(merged.MY_KEY, "mine");
  assert.equal(merged.PORT, "9000");
});

// --- sealing -----------------------------------------------------------------

test("a secret cannot be replayed under another variable's name", () => {
  // The AAD binds the key name, so moving a ciphertext from a test key's row to
  // the live key's row does not decrypt.
  const env = { APP_SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };
  const sealed = sealSecret("env:STRIPE_TEST_KEY", "sk_test_123", env);
  assert.equal(openSecret("env:STRIPE_TEST_KEY", sealed, env), "sk_test_123");
  assert.throws(() => openSecret("env:STRIPE_LIVE_KEY", sealed, env));
});

// --- injection at deploy -----------------------------------------------------

/** The smallest FinalizeDeps that reaches ensureFunction. */
function finalizeHarness() {
  let seen: Record<string, string> | null = null;
  const deps: any = {
    fcOps: {
      ensureFunction: async (_name: string, args: any) => {
        seen = args.env;
      },
      ensureHttpTrigger: async () => ({ url: "https://x.fcapp.run" }),
    },
  };
  return { deps, env: () => seen! };
}

const staticInput = {
  appId: "app-1",
  slug: "demo",
  appType: "static_web", // no database, so no APPS_DB_ADMIN_URL needed
  fcFunctionName: "tc-app-1",
  ossObjectName: "apps/app-1/code.zip",
};

test("user env reaches the deployed function", async () => {
  const h = finalizeHarness();
  await finalizeDeploy(h.deps, {
    ...staticInput,
    userEnv: { STRIPE_KEY: "sk_live", LOG_LEVEL: "debug" },
  } as any);
  assert.equal(h.env().STRIPE_KEY, "sk_live");
  assert.equal(h.env().LOG_LEVEL, "debug");
});

test("a user row that reached the table anyway cannot shadow the platform", async () => {
  // parseEnvKey refuses these at write time; this is the second defence, which
  // holds for a row written by anything other than that endpoint.
  const h = finalizeHarness();
  await finalizeDeploy(h.deps, {
    ...staticInput,
    userEnv: {
      PORT: "1",
      NODE_ENV: "development",
      APP_PUBLIC_URL: "https://attacker.example.com",
      TEAMCLU_STORAGE_TOKEN: "stolen",
      MINE: "kept",
    },
    platformAuthEnv: { APP_PUBLIC_URL: "https://demo.apps.example.com" },
    storageEnv: { TEAMCLU_STORAGE_TOKEN: "real" },
  } as any);

  assert.equal(h.env().PORT, "9000");
  assert.equal(h.env().NODE_ENV, "production");
  assert.equal(h.env().APP_PUBLIC_URL, "https://demo.apps.example.com");
  assert.equal(h.env().TEAMCLU_STORAGE_TOKEN, "real");
  assert.equal(h.env().MINE, "kept", "an ordinary key is still delivered");
});

test("no user env leaves the function's environment exactly as before", async () => {
  const h = finalizeHarness();
  await finalizeDeploy(h.deps, staticInput as any);
  assert.deepEqual(h.env(), { PORT: "9000", NODE_ENV: "production" });
});
