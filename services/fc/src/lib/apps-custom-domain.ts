import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import { domainToASCII } from "node:url";
import { ApiError } from "./http-utils.js";
import { appFcRouteHost, appPublicUrl, appsFcRouteDomain, appsPublicDomain } from "./apps-public-host.js";

/**
 * Binding a domain the app's owner controls
 * (`docs/specs/2026-09-08-apps-login-and-custom-domain-design.md` §5).
 *
 * The domain points at OUR proxy, not at Function Compute: an Alibaba FC
 * custom domain requires an ICP filing the owner's domain does not have, and
 * the proxy is already where Host → app routing and the login wall live, so a
 * user domain inherits both for free.
 *
 * Ownership is proven with a TXT record rather than by observing the CNAME.
 * A CNAME cannot exist on an apex domain at all, and the owner can add the TXT
 * before cutting live traffic over — verification and cutover become two
 * separate, reversible steps instead of one.
 *
 * SELF-HOST ONLY. This works because Caddy will accept a connection for ANY
 * hostname (the catch-all site block) and ask us whether to get a certificate
 * for it. The Alibaba Function Compute deployment has no such entry point: on
 * FC a hostname reaches a function only if a custom domain was created for it
 * — which is exactly what `fc-client.ts` `ensureCustomDomain` does for each
 * app's own route host. A visitor's CNAME resolves to FC's gateway, but the
 * Host it carries matches no configuration there and the request is refused
 * before any of this code runs.
 *
 * Supporting it there would mean creating a custom domain per bound name,
 * sourcing and renewing a certificate for each (FC signs nothing; it serves an
 * uploaded PEM — see `bind-apps-domain-cert.mjs`), and an ICP filing for the
 * user's domain. That last one is a hard requirement the user's domain
 * typically cannot meet, and is why this design routes through our own proxy
 * in the first place. Design §5.8.
 *
 * The login wall (§4) is NOT limited this way: `LOGIN_DOMAIN` is one fixed
 * hostname an operator binds once, not a per-app one.
 */

/** Label the TXT proof lives under, so it never collides with the owner's own records. */
const TXT_PREFIX = "_teamclu";
const TXT_VALUE_PREFIX = "teamclu-verify=";

/** DNS is slow to fail; a request must not sit on it. */
const DNS_TIMEOUT_MS = 5_000;

export type DnsRecord = { type: "CNAME" | "TXT"; name: string; value: string };

export function makeDomainToken(): string {
  return randomBytes(24).toString("base64url");
}

export function verificationTxtName(domain: string): string {
  return `${TXT_PREFIX}.${domain}`;
}

export function verificationTxtValue(token: string): string {
  return `${TXT_VALUE_PREFIX}${token}`;
}

// --- validation --------------------------------------------------------------

/**
 * Hostnames this deployment answers on, which nobody may bind.
 *
 * Without this a user could bind `api.<our domain>` and have the certificate
 * gate mint a certificate for our own API's name. Reading them from env rather
 * than hardcoding keeps the list honest on a differently-named deployment;
 * `APPS_RESERVED_DOMAINS` is the escape hatch for names this process cannot
 * otherwise see (the Studio and EMQX hostnames live only in Caddy's env).
 */
function reservedDomains(env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>();
  const add = (value: string | undefined) => {
    const trimmed = value?.trim().toLowerCase();
    if (trimmed) out.add(trimmed.replace(/\.+$/, ""));
  };
  const addUrlHost = (value: string | undefined) => {
    if (!value?.trim()) return;
    try {
      add(new URL(value.trim()).hostname);
    } catch {
      /* not a URL; nothing to reserve */
    }
  };

  add(appsPublicDomain(env));
  add(appsFcRouteDomain(env));
  add(env.LOGIN_DOMAIN);
  addUrlHost(env.SUPABASE_PUBLIC_URL);
  addUrlHost(env.API_EXTERNAL_URL);
  addUrlHost(env.SITE_URL);
  for (const extra of (env.APPS_RESERVED_DOMAINS ?? "").split(",")) add(extra);
  return [...out];
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const NEVER_ROUTABLE = ["localhost", "local", "internal", "test", "invalid", "example"];

/**
 * Validate and canonicalise a hostname the owner wants to bind.
 *
 * Returns the ASCII (punycode) form: that is what DNS carries, what the
 * certificate will be issued for, and what an incoming `Host` header will hold,
 * so storing anything else would mean converting on every lookup.
 */
export function normalizeCustomDomain(raw: unknown, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof raw !== "string") {
    throw new ApiError(400, "validation_failed", "domain must be a string");
  }
  let domain = raw.trim().toLowerCase().replace(/\.+$/, "");
  if (!domain) throw new ApiError(400, "validation_failed", "domain is required");

  // A scheme or a path is the most common way this arrives wrong; say so
  // rather than failing the label check with something cryptic.
  if (domain.includes("/") || domain.includes(":")) {
    throw new ApiError(
      400,
      "validation_failed",
      "domain must be a hostname only, without scheme or path (e.g. app.example.com)",
    );
  }
  if (IPV4_RE.test(domain) || domain.includes("[")) {
    throw new ApiError(400, "validation_failed", "domain must be a hostname, not an IP address");
  }

  const ascii = domainToASCII(domain);
  if (!ascii) throw new ApiError(400, "validation_failed", `domain is not a valid hostname: ${raw}`);
  if (ascii.length > 253) {
    throw new ApiError(400, "validation_failed", "domain is too long");
  }

  const labels = ascii.split(".");
  if (labels.length < 2) {
    throw new ApiError(400, "validation_failed", "domain needs at least one dot (e.g. app.example.com)");
  }
  for (const label of labels) {
    if (!LABEL_RE.test(label)) {
      throw new ApiError(400, "validation_failed", `domain has an invalid label: ${label}`);
    }
  }
  if (NEVER_ROUTABLE.includes(labels[labels.length - 1])) {
    throw new ApiError(
      400,
      "validation_failed",
      `.${labels[labels.length - 1]} is not a publicly routable domain`,
    );
  }

  for (const reserved of reservedDomains(env)) {
    if (ascii === reserved || ascii.endsWith(`.${reserved}`)) {
      throw new ApiError(
        409,
        "domain_reserved",
        `${ascii} belongs to this deployment and cannot be bound to an app`,
      );
    }
  }
  return ascii;
}

// --- the records to publish --------------------------------------------------

/**
 * What the owner must add at their registrar.
 *
 * Returned on every response that touches the domain so a client never has to
 * reconstruct them — the TXT value in particular embeds a token the client
 * would otherwise have to remember across requests.
 */
export function customDomainRecords(
  app: { id: string; slug: string },
  domain: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): DnsRecord[] {
  const records: DnsRecord[] = [
    { type: "TXT", name: verificationTxtName(domain), value: verificationTxtValue(token) },
  ];
  // Point at the vanity host rather than at the box's address: an A record
  // would have to be reissued if the box ever moved, and the vanity name is
  // already the one our certificate gate and proxy recognise.
  const vanity = appPublicUrl(app.slug, app.id, env);
  if (vanity) {
    records.unshift({ type: "CNAME", name: domain, value: new URL(vanity).hostname });
  } else {
    // No apps domain configured — the FC route host is the only stable name
    // this deployment can offer to point at.
    const route = appFcRouteHost(app.slug, app.id, env);
    if (route) records.unshift({ type: "CNAME", name: domain, value: route });
  }
  return records;
}

// --- proving ownership -------------------------------------------------------

export type TxtResolver = (name: string) => Promise<string[][]>;

/**
 * Whether the TXT proof for this domain is published.
 *
 * A resolver that throws — NXDOMAIN, no records, a timeout — is "not proven",
 * not an error: the overwhelmingly common cause is that DNS has not propagated
 * yet, and the caller turns that into a retryable 409 rather than a 500 that
 * looks like our fault.
 *
 * Long TXT values arrive split into 255-byte chunks, so the strings of one
 * record are joined before comparison.
 */
export async function verifyDomainOwnership(
  domain: string,
  token: string,
  resolveTxt: TxtResolver = (name) => dns.resolveTxt(name),
  timeoutMs = DNS_TIMEOUT_MS,
): Promise<boolean> {
  if (!token) return false;
  const wanted = verificationTxtValue(token);
  let timer: NodeJS.Timeout | undefined;
  try {
    const records = await Promise.race([
      resolveTxt(verificationTxtName(domain)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("dns timeout")), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return (records ?? []).some((chunks) => chunks.join("").trim() === wanted);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
