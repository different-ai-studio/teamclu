import { createHash, timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";

import { appPublicUrl } from "./apps-public-host.js";

/**
 * Traefik's HTTP provider for the custom domains users bind to their apps
 * (belayo; `docs/specs/2026-09-08-apps-login-and-custom-domain-design.md` §5.8).
 *
 * Self-host serves a user's domain through Caddy's on-demand TLS, which asks
 * `/internal/caddy/ask` during the handshake. Traefik has nothing like that: a
 * hostname is served only when some provider declares a router for it, and a
 * certificate is requested only for a router that names it — on belayo that
 * meant a hand-written router per domain. Traefik polls this endpoint instead,
 * so the verified-domain rows the gateway already routes on are also the one
 * list of what the ingress serves.
 *
 * Three behaviours of Traefik v3.6.7 shape this module; all were read from its
 * source rather than assumed:
 *
 * - A failed poll — transport error, non-200, undecodable body — sends nothing,
 *   and Traefik keeps the configuration it last applied. An outage here must
 *   therefore be an error status. An empty 200 would unpublish every domain.
 * - ACME acts only on a configuration it is sent, and identical bodies are
 *   deduplicated by hash, so a certificate request that fails is never retried
 *   on its own.
 * - Before requesting a certificate Traefik skips every domain that already
 *   has one (`getUncheckedDomains`).
 *
 * Hence the rules below. A domain is first published only once its DNS reaches
 * the ingress, so the first ACME attempt is one that can succeed; once
 * published it stays published while it is verified, so a DNS blip cannot take
 * a live site down. Router names carry the current hour, so a domain whose
 * issuance failed gets one more attempt an hour — inside Let's Encrypt's five
 * failed validations an hour — while domains holding a certificate are skipped
 * and cost nothing.
 */

/** Declared in teamclu-apps-ingress.yml on the Dokploy manager; `@file` because this provider is `http`. */
export const TRAEFIK_APPS_SERVICE = "teamclu-apps-cloud-api@file";
/** Dokploy's global middleware (middlewares.yml). */
export const TRAEFIK_HTTPS_REDIRECT = "redirect-to-https@file";
/** The HTTP-01 resolver in traefik.yml. */
export const TRAEFIK_CERT_RESOLVER = "letsencrypt";

const RETRY_WINDOW_MS = 60 * 60 * 1000;
/** Traefik polls every few seconds; the database and DNS need not be asked that often. */
const CACHE_MS = 30 * 1000;
const DNS_TIMEOUT_MS = 5_000;
/** What `normalizeCustomDomain` produces. Anything else is not put inside a Traefik rule. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export type TraefikCustomDomain = {
  /** Lower-case ASCII, as stored after normalisation. */
  domain: string;
  /** The app's vanity host: what the user was told to CNAME to, and what reaches the ingress. */
  vanityHost: string;
};

export type ListTraefikCustomDomains = () => Promise<TraefikCustomDomain[]>;

export type DnsResolver = {
  resolveCname: (name: string) => Promise<string[]>;
  resolve4: (name: string) => Promise<string[]>;
};

const nodeResolver: DnsResolver = {
  resolveCname: (name) => dns.resolveCname(name),
  resolve4: (name) => dns.resolve4(name),
};

export function traefikProviderToken(env: NodeJS.ProcessEnv = process.env): string {
  return env.APPS_TRAEFIK_PROVIDER_TOKEN?.trim() ?? "";
}

/** Constant-time: the token is the only thing between the internet and this list. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!token || !header) return false;
  const want = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header.trim());
  return got.length === want.length && timingSafeEqual(got, want);
}

function hourBucket(now: number): string {
  const start = new Date(Math.floor(now / RETRY_WINDOW_MS) * RETRY_WINDOW_MS);
  return start.toISOString().slice(0, 13).replace(/[-T]/g, "");
}

/**
 * Readable, and unique per domain: `a-b.com` and `a.b.com` flatten to the same
 * characters, so a short digest of the real name keeps them apart.
 */
function routerBase(domain: string): string {
  const digest = createHash("sha256").update(domain).digest("hex").slice(0, 8);
  return `teamclu-custom-${domain.replace(/[^a-z0-9]+/g, "-")}-${digest}`;
}

/** The dynamic configuration Traefik receives. Sorted so equal inputs hash equal. */
export function buildTraefikDynamicConfig(domains: string[], now: number = Date.now()) {
  const bucket = hourBucket(now);
  const routers: Record<string, unknown> = {};
  for (const domain of [...new Set(domains)].filter((d) => HOSTNAME.test(d)).sort()) {
    const name = `${routerBase(domain)}-${bucket}`;
    const rule = `Host(\`${domain}\`)`;
    routers[name] = {
      rule,
      entryPoints: ["web"],
      middlewares: [TRAEFIK_HTTPS_REDIRECT],
      service: TRAEFIK_APPS_SERVICE,
    };
    routers[`${name}-websecure`] = {
      rule,
      entryPoints: ["websecure"],
      service: TRAEFIK_APPS_SERVICE,
      tls: { certResolver: TRAEFIK_CERT_RESOLVER },
    };
  }
  return { http: { routers } };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("dns timeout")), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const bareHost = (host: string) => host.replace(/\.$/, "").toLowerCase();

/**
 * Whether the domain's DNS already reaches the ingress: a CNAME straight to
 * the app's vanity host, as the UI instructs, or an A record shared with it,
 * which also covers a CNAME chain. Any lookup failure reads as "not yet".
 */
export async function pointsAtIngress(
  domain: string,
  vanityHost: string,
  resolver: DnsResolver = nodeResolver,
  timeoutMs = DNS_TIMEOUT_MS,
): Promise<boolean> {
  const cnames = await withTimeout(resolver.resolveCname(domain), timeoutMs).catch(() => [] as string[]);
  if (cnames.map(bareHost).includes(bareHost(vanityHost))) return true;
  const [theirs, ours] = await Promise.all([
    withTimeout(resolver.resolve4(domain), timeoutMs).catch(() => [] as string[]),
    withTimeout(resolver.resolve4(vanityHost), timeoutMs).catch(() => [] as string[]),
  ]);
  return theirs.some((ip) => ours.includes(ip));
}

/**
 * Verified custom domains, read with a service-role client — Traefik is the
 * caller, so there is no user token. The client factory is injected for the
 * same reason as `makeSupabaseVanityLookup`: the query can be tested without a
 * database.
 *
 * Errors throw. The endpoint turns that into a 503, which Traefik treats as
 * "keep what you have"; swallowing it into an empty list would unpublish every
 * custom domain.
 */
export function makeSupabaseTraefikDomainLookup(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getClient: () => any,
  env: NodeJS.ProcessEnv = process.env,
): ListTraefikCustomDomains {
  return async () => {
    const { data, error } = await getClient()
      .from("apps")
      .select("id, slug, custom_domain, custom_domain_verified_at")
      .not("custom_domain", "is", null)
      .not("custom_domain_verified_at", "is", null);
    if (error) throw new Error(`traefik custom domain lookup failed: ${error.message}`);
    const out: TraefikCustomDomain[] = [];
    for (const row of data ?? []) {
      const domain = String(row.custom_domain ?? "").trim().toLowerCase();
      const url = appPublicUrl(row.slug, row.id, env);
      if (!domain || !url || !row.custom_domain_verified_at) continue;
      out.push({ domain, vanityHost: new URL(url).hostname });
    }
    return out;
  };
}

export type TraefikEndpointResult = { status: 200 | 401 | 404 | 503; body: unknown };

export function makeTraefikDynamicEndpoint(deps: {
  listDomains: ListTraefikCustomDomains;
  resolver?: DnsResolver;
  now?: () => number;
  cacheMs?: number;
}) {
  let cached: { domains: string[]; until: number } | null = null;
  // Domains already handed to Traefik. They stay published while verified,
  // whatever one DNS lookup says: the first-publication gate exists to avoid a
  // doomed certificate request, not to take down a site that is already live.
  let published = new Set<string>();

  return async (
    authorization: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<TraefikEndpointResult> => {
    const token = traefikProviderToken(env);
    // Unset means this deployment does not publish custom domains through
    // Traefik (self-host uses Caddy). Answer as if the path did not exist.
    if (!token) return { status: 404, body: { error: "not_found" } };
    if (!bearerMatches(authorization, token)) return { status: 401, body: { error: "unauthorized" } };

    const now = (deps.now ?? Date.now)();
    if (!cached || cached.until <= now) {
      let rows: TraefikCustomDomain[];
      try {
        rows = await deps.listDomains();
      } catch (err) {
        console.error("[traefik] custom domain lookup failed", err);
        return { status: 503, body: { error: "unavailable" } };
      }
      const resolver = deps.resolver ?? nodeResolver;
      const ready = await Promise.all(
        rows
          .filter((row) => HOSTNAME.test(row.domain))
          .map(async (row) =>
            published.has(row.domain) || (await pointsAtIngress(row.domain, row.vanityHost, resolver))
              ? row.domain
              : null,
          ),
      );
      const domains = ready.filter((d): d is string => d !== null);
      published = new Set(domains);
      cached = { domains, until: now + (deps.cacheMs ?? CACHE_MS) };
    }
    return { status: 200, body: buildTraefikDynamicConfig(cached.domains, now) };
  };
}
