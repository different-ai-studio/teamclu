import { readFileSync } from "node:fs";
import type { OriginAuthConfig } from "../../../src/lib/apps-origin-auth.js";
export const ORIGIN_CONFIG: OriginAuthConfig = {
  activeKey: { version: "v1", masterKey: Buffer.alloc(32, 42) },
  routeDomain: "origins.test", certName: "origin-test",
  certificate: readFileSync(new URL("cert.pem", import.meta.url), "utf8"),
  privateKey: readFileSync(new URL("key.pem", import.meta.url), "utf8"),
};
export const ORIGIN_ENV = {
  APPS_FC_ORIGIN_KEYRING: JSON.stringify({ active: { version: "v1", key: Buffer.from(ORIGIN_CONFIG.activeKey.masterKey).toString("base64url") } }),
  APPS_FC_ROUTE_DOMAIN: ORIGIN_CONFIG.routeDomain,
  APPS_FC_ORIGIN_TLS_CERT_NAME: ORIGIN_CONFIG.certName,
  APPS_FC_ORIGIN_TLS_CERT_PEM: ORIGIN_CONFIG.certificate,
  APPS_FC_ORIGIN_TLS_KEY_PEM: ORIGIN_CONFIG.privateKey,
};
export function installOriginEnv(env: NodeJS.ProcessEnv = process.env) {
  const before = Object.fromEntries(Object.keys(ORIGIN_ENV).map(key => [key, env[key]]));
  Object.assign(env, ORIGIN_ENV);
  return () => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete env[key]; else env[key] = value; } };
}
