import { createHmac, createPrivateKey, X509Certificate } from 'node:crypto';
import { SignJWT } from 'jose';
import { appPublicLabel } from './apps-public-host.js';
export type OriginKey = {
  version: string;
  masterKey: Uint8Array;
};
export type OriginAuthConfig = {
  activeKey: OriginKey;
  previousKey?: OriginKey;
  routeDomain: string;
  certName: string;
  certificate: string;
  privateKey: string;
};
export type OriginTarget = {
  appId: string;
  slug: string;
};
export type OriginSecuritySummary = {
  status: 'protected' | 'legacy_unverified' | 'drift' | 'unavailable';
  internetUrlDisabled: boolean | null;
  customDomainAuth: 'jwt' | 'none' | 'unknown';
  httpsOnly: boolean | null;
  driftFields: string[];
};
function invalid(field: string): never {
  // Never attach parser/crypto errors: their messages can contain supplied secrets.
  throw new Error(`Invalid apps origin configuration: ${field}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readKey(value: unknown): OriginKey {
  if (!record(value) || Object.keys(value).some(k => k !== 'version' && k !== 'key'))
    invalid('keyring');
  if (typeof value.version !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.version))
    invalid('key version');
  if (typeof value.key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.key))
    invalid('master key');
  const masterKey = Buffer.from(value.key, 'base64url');
  if (masterKey.length < 32 || masterKey.toString('base64url') !== value.key)
    invalid('master key');
  return { version: value.version, masterKey };
}
function hostnameValid(value: string): boolean {
  return value.length <= 253 && value.split('.').length >= 2 && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim())
    invalid(name);
  return value;
}
function certificateMaterial(config: OriginAuthConfig, now: Date): X509Certificate {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(config.certificate);
    if (!certificate.checkPrivateKey(createPrivateKey(config.privateKey)))
      invalid('TLS key mismatch');
  }
  catch {
    invalid('TLS certificate/key');
  }
  const time = now.getTime();
  if (!Number.isFinite(time) || time < Date.parse(certificate.validFrom) || time >= Date.parse(certificate.validTo))
    invalid('TLS certificate validity');
  return certificate;
}
export function readAppsOriginAuthConfig(env: NodeJS.ProcessEnv): OriginAuthConfig {
  let keyring: unknown;
  try {
    keyring = JSON.parse(required(env, 'APPS_FC_ORIGIN_KEYRING'));
  }
  catch {
    invalid('keyring');
  }
  if (!record(keyring) || Object.keys(keyring).some(k => k !== 'active' && k !== 'previous'))
    invalid('keyring');
  const activeKey = readKey(keyring.active);
  const previousKey = keyring.previous === undefined ? undefined : readKey(keyring.previous);
  if (previousKey?.version === activeKey.version)
    invalid('duplicate key version');
  const routeDomain = required(env, 'APPS_FC_ROUTE_DOMAIN').trim().toLowerCase();
  if (!hostnameValid(routeDomain))
    invalid('route domain');
  const config: OriginAuthConfig = {
    activeKey, ...(previousKey ? { previousKey } : {}), routeDomain,
    certName: required(env, 'APPS_FC_ORIGIN_TLS_CERT_NAME').trim(),
    certificate: required(env, 'APPS_FC_ORIGIN_TLS_CERT_PEM'),
    privateKey: required(env, 'APPS_FC_ORIGIN_TLS_KEY_PEM'),
  };
  certificateMaterial(config, new Date());
  return config;
}
export function assertOriginCertificate(config: OriginAuthConfig, hostname: string, now = new Date()): void {
  if (!hostnameValid(hostname))
    invalid('origin hostname');
  const certificate = certificateMaterial(config, now);
  // SAN takes precedence; never allow a matching CN to override a mismatched SAN.
  if (!certificate.checkHost(hostname, { subject: 'default' }))
    invalid('TLS certificate hostname');
}
function normalizedAppId(appId: string): string {
  if (typeof appId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId))
    invalid('application UUID');
  return appId.toLowerCase();
}
function deriveKey(key: OriginKey, appId: string): Buffer {
  return createHmac('sha256', key.masterKey).update(`teamclu:fc-origin:${key.version}:${normalizedAppId(appId)}`).digest();
}
/** Symmetric JWKS is a secret; use only when configuring FC through its management API. */
export function originJwks(config: OriginAuthConfig, appId: string): {
  keys: Array<{
    kty: 'oct';
    alg: 'HS256';
    use: 'sig';
    kid: string;
    k: string;
  }>;
} {
  return {
    keys: [config.activeKey, ...(config.previousKey ? [config.previousKey] : [])].map(key => ({
      kty: 'oct', alg: 'HS256', use: 'sig', kid: key.version,
      k: deriveKey(key, appId).toString('base64url'),
    })),
  };
}
export async function signOriginToken(config: OriginAuthConfig, target: OriginTarget, hostname: string, now = new Date()): Promise<string> {
  const appId = normalizedAppId(target.appId);
  if (!hostnameValid(hostname))
    invalid('origin hostname');
  const issuedAt = Math.floor(now.getTime() / 1000);
  if (!Number.isFinite(issuedAt))
    invalid('token time');
  return new SignJWT({ version: config.activeKey.version, appId, originHost: hostname })
    .setProtectedHeader({ alg: 'HS256', kid: config.activeKey.version, typ: 'JWT' })
    .setIssuedAt(issuedAt).setExpirationTime(issuedAt + 60)
    .sign(deriveKey(config.activeKey, appId));
}

/**
 * Existing endpoints keep their unsigned forwarding path. Only the exact
 * managed HTTPS origin can receive a platform credential.
 */
export function classifyOriginEndpoint(endpoint: string, target: OriginTarget, routeDomain: string): 'protected' | 'legacy' {
  let url: URL;
  try { url = new URL(endpoint); } catch { invalid('origin endpoint'); }
  // URL normalizes backslashes, whitespace and dot segments. None may turn an
  // unusual stored endpoint into an authenticated destination.
  if (!/^https?:\/\//i.test(endpoint) || /[\s\\]/.test(endpoint) || url.username || url.password || !['http:', 'https:'].includes(url.protocol))
    invalid('origin endpoint');
  if (url.protocol === 'http:') return 'legacy';
  const domain = routeDomain.trim().toLowerCase();
  if (!domain) {
    if (url.hostname.endsWith('.fcapp.run')) return 'legacy';
    invalid('route domain');
  }
  if (!hostnameValid(domain)) invalid('route domain');
  const host = url.hostname.replace(/\.$/, '');
  if (host !== domain && !host.endsWith(`.${domain}`)) return 'legacy';
  const appId = normalizedAppId(target.appId);
  const label = appPublicLabel(target.slug, appId);
  if (!label || !hostnameValid(`${label}.${domain}`)) invalid('origin hostname');
  // Raw shape rejects paths that URL would normalize back to '/'. Default
  // HTTPS port is harmless; non-default ports, query and fragments are not.
  if (url.hostname !== `${label}.${domain}` || url.port || !/^https:\/\/[^/?#]+\/?$/i.test(endpoint))
    invalid('origin endpoint');
  return 'protected';
}
