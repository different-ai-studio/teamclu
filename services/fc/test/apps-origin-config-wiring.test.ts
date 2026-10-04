import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { readAppsOriginAuthConfig } from "../src/lib/apps-origin-auth.js";
import { ORIGIN_ENV } from "./fixtures/apps-origin-auth/config.js";

// Use the existing toolchain YAML parser; no Docker daemon or live secrets.
const { parse } = createRequire(import.meta.url)("yaml") as { parse(text: string): unknown };
const originNames = [
  "APPS_FC_ORIGIN_KEYRING",
  "APPS_FC_ORIGIN_TLS_CERT_NAME",
  "APPS_FC_ORIGIN_TLS_CERT_PEM",
  "APPS_FC_ORIGIN_TLS_KEY_PEM",
] as const;
const compose = parse(readFileSync(new URL("../../../deploy/self-host/docker-compose.yml", import.meta.url), "utf8")) as {
  services: { fc: { environment: Record<string, string> } };
};

function fcOriginEnvironment(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [...originNames, "APPS_FC_ROUTE_DOMAIN"]) {
    const expression = compose.services.fc.environment[name];
    assert.equal(typeof expression, "string", `${name} must reach the FC container`);
    // Evaluate the Compose variable/default subset used by this environment
    // boundary. Substitution is one pass so PEM newlines and '$' stay literal.
    result[name] = expression.replace(/\$\{([A-Z_0-9]+)(?::-([^}]*))?\}/g,
      (_, variable: string, fallback?: string) => host[variable] || fallback || "");
  }
  return result;
}

test("self-host FC receives the configured keyring and multiline TLS material unchanged", () => {
  const received = fcOriginEnvironment(ORIGIN_ENV);
  for (const name of originNames) assert.equal(received[name], ORIGIN_ENV[name], name);
  const config = readAppsOriginAuthConfig(received);
  assert.equal(config.activeKey.version, "v1");
  assert.equal(config.routeDomain, "origins.test");
  assert.equal(config.certificate, ORIGIN_ENV.APPS_FC_ORIGIN_TLS_CERT_PEM);
  assert.equal(config.privateKey, ORIGIN_ENV.APPS_FC_ORIGIN_TLS_KEY_PEM);
});

test("missing host origin secrets stay empty and cannot enable a protected deployment", () => {
  const received = fcOriginEnvironment({ APPS_FC_ROUTE_DOMAIN: "origins.test" });
  for (const name of originNames) assert.equal(received[name], "", name);
  assert.throws(() => readAppsOriginAuthConfig(received), /Invalid apps origin configuration/);
});

test("self-host template leaves origin secrets and certificate name unconfigured", () => {
  const sample = readFileSync(new URL("../../../deploy/self-host/.env.example", import.meta.url), "utf8");
  const entries = new Map(sample.split("\n")
    .filter(line => line && !line.startsWith("#") && line.includes("="))
    .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  for (const name of originNames) assert.equal(entries.get(name), "", `${name} is a placeholder`);
});
