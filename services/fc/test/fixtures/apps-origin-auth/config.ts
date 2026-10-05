import type { OriginAuthConfig } from "../../../src/lib/apps-origin-auth.js";
export const ORIGIN_CONFIG: OriginAuthConfig = {
  activeKey: { version: "v1", masterKey: Buffer.alloc(32, 42) },
  routeDomain: "origins.test",
};
export const ORIGIN_ENV = {
  APPS_FC_ORIGIN_KEYRING: JSON.stringify({ active: { version: "v1", key: Buffer.from(ORIGIN_CONFIG.activeKey.masterKey).toString("base64url") } }),
  APPS_FC_ROUTE_DOMAIN: ORIGIN_CONFIG.routeDomain,
};
export function installOriginEnv(env: NodeJS.ProcessEnv = process.env) {
  const before = Object.fromEntries(Object.keys(ORIGIN_ENV).map(key => [key, env[key]]));
  Object.assign(env, ORIGIN_ENV);
  return () => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete env[key]; else env[key] = value; } };
}
