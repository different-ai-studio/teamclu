import { parseAppPublicHost } from "./apps-public-host.js";

/**
 * Serving deployed apps on `<slug>-<id8>.<APPS_PUBLIC_DOMAIN>`.
 *
 * Two halves, both driven by the request's Host:
 *
 *   * `ask`   — Caddy asks before completing a TLS handshake for a hostname it
 *               has no certificate for. Answering 404 for unknown names is the
 *               only thing standing between on-demand issuance and an open
 *               cert-minting endpoint: anyone can point a request at this box,
 *               and Let's Encrypt's rate limit is per REGISTERED domain, shared
 *               with api/supabase/mqtt on the same name.
 *   * `proxy` — forward the request to that app's Function Compute trigger.
 *
 * The lookup deliberately does NOT go through the request-scoped repository:
 * both halves are unauthenticated by nature (a browser hitting a public page,
 * and Caddy itself), so there is no bearer token to scope RLS with. It reads
 * the control-plane database directly, like the cron and push paths do.
 */
export interface VanityApp {
  id: string;
  slug: string;
  fcEndpoint: string | null;
  fcStatus: string | null;
  /** `apps.team_id`. The org gate resolves the app's org through it. */
  teamId: string | null;
  /** `apps.auth_mode`. `platform` is the only value with a login wall. */
  authMode: string | null;
  /** `apps.auth_audience`: `any` | `org`. Only read when authMode is platform. */
  authAudience: string | null;
  /** `apps.auth_scope`: `all` | `paths`. Baseline for the path rules below. */
  authScope: string | null;
  /** `apps.auth_rules` — raw jsonb. The gate reads it leniently, on purpose. */
  authRules: unknown;
  /** `apps.custom_domain` — ASCII hostname the owner bound, or null. */
  customDomain: string | null;
  /** `apps.custom_domain_verified_at` — null means stored but NOT served. */
  customDomainVerifiedAt: string | null;
}

/**
 * Who the gateway decided is making this request.
 *
 * Passed to {@link proxyToApp} rather than assembled there: the proxy has no
 * business knowing how a visitor was authenticated, and the gate has no
 * business writing headers.
 */
export type ProxyIdentity = {
  userId: string;
  email: string;
  orgId: string | null;
};

export type LookupVanityApp = (host: string) => Promise<VanityApp | null>;

/**
 * Of the apps sharing a slug (one per team at most), the one whose id starts
 * with the prefix from the hostname.
 *
 * Two hits means two teams whose slugs AND id prefixes collide — serving either
 * would be a coin flip between different teams' apps, so serve neither.
 */
export function selectByIdPrefix(rows: VanityApp[], idPrefix: string): VanityApp | null {
  const hits = rows.filter((r) => typeof r.id === "string" && r.id.startsWith(idPrefix));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Reads via PostgREST with the service-role key, which is how every other
 * tokenless path here reads the database.
 *
 * Filters on slug alone and matches the id prefix in memory rather than asking
 * PostgREST for `id like '…%'`: `id` is a uuid column, and Postgres has no
 * `uuid ~~ text` operator — that filter fails as a query error, not as an empty
 * result. At most one row per team shares a slug, so the list is tiny.
 */
const LOOKUP_COLUMNS =
  "id, slug, fc_endpoint, fc_status, team_id, auth_mode, auth_audience, auth_scope, auth_rules, custom_domain, custom_domain_verified_at";

function mapVanityRow(r: any): VanityApp {
  return {
    id: r.id,
    slug: r.slug,
    fcEndpoint: r.fc_endpoint ?? null,
    fcStatus: r.fc_status ?? null,
    teamId: r.team_id ?? null,
    authMode: r.auth_mode ?? null,
    authAudience: r.auth_audience ?? null,
    authScope: r.auth_scope ?? null,
    authRules: r.auth_rules ?? null,
    customDomain: r.custom_domain ?? null,
    customDomainVerifiedAt: r.custom_domain_verified_at ?? null,
  };
}

export function makeSupabaseVanityLookup(getClient: () => any): LookupVanityApp {
  return async (host: string) => {
    const name = host.split(":")[0].trim().toLowerCase();
    const parsed = parseAppPublicHost(host);
    if (parsed) {
      const { data, error } = await getClient()
        .from("apps")
        .select(LOOKUP_COLUMNS)
        .eq("slug", parsed.slug)
        .limit(50);
      if (error) throw new Error(`vanity app lookup failed: ${error.message}`);
      return selectByIdPrefix((data ?? []).map(mapVanityRow), parsed.idPrefix);
    }

    // A domain the app's owner bound. `custom_domain` is stored lowercase and
    // in its ASCII form, which is exactly what a Host header carries, so this
    // is an equality match rather than anything pattern-shaped.
    //
    // `custom_domain_verified_at is not null` is not an optimisation: an
    // unverified domain must resolve to nothing, or the certificate gate would
    // mint a certificate for a name whose ownership was never proven.
    const { data, error } = await getClient()
      .from("apps")
      .select(LOOKUP_COLUMNS)
      .eq("custom_domain", name)
      .not("custom_domain_verified_at", "is", null)
      .limit(2);
    if (error) throw new Error(`custom domain lookup failed: ${error.message}`);
    const rows = (data ?? []).map(mapVanityRow);
    // The unique index makes two rows impossible; serving either would be a
    // coin flip between owners, so serve neither if it ever happens.
    return rows.length === 1 ? rows[0] : null;
  };
}

// A hostname's app, remembered briefly.
//
// The cache exists because custom domains removed the cheap way to say "this
// is not an app host". Vanity names could be rejected by parsing alone, but an
// arbitrary domain can only be ruled out by asking the database — which would
// otherwise put one query in front of EVERY Cloud API request, since those
// arrive on a hostname that parses as nothing.
//
// Misses are cached too, and are the common case (the API's own hostname). The
// TTL is short because a newly verified domain must start working promptly;
// `invalidateVanityHost` makes that immediate on the instance that verified it,
// and the TTL covers the others on a multi-instance deployment.
const HIT_TTL_MS = 30_000;
const MISS_TTL_MS = 10_000;
const CACHE_MAX = 2_000;
const hostCache = new Map<string, { app: VanityApp | null; expiresAt: number }>();

const cacheKey = (host: string) => host.split(":")[0].trim().toLowerCase();

/** Drop a hostname's cached answer after its binding changed. */
export function invalidateVanityHost(host: string | null | undefined): void {
  if (host) hostCache.delete(cacheKey(host));
}

/** Test seam — the cache is process-local and would leak between tests. */
export function __resetVanityCache(): void {
  hostCache.clear();
}

/**
 * The lookup, with the client built per call rather than at wiring time so a
 * deployment that never serves a vanity host never constructs one.
 */
export function makeVanityLookup(deps: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getServiceRoleClient: () => any;
}): LookupVanityApp {
  const lookup = makeSupabaseVanityLookup(deps.getServiceRoleClient);
  return async (host: string) => {
    const key = cacheKey(host);
    if (!key) return null;
    const now = Date.now();
    const hit = hostCache.get(key);
    if (hit && hit.expiresAt > now) return hit.app;

    const app = await lookup(host);
    if (hostCache.size >= CACHE_MAX) {
      for (const [k, v] of hostCache) if (v.expiresAt <= now) hostCache.delete(k);
      if (hostCache.size >= CACHE_MAX) hostCache.clear();
    }
    hostCache.set(key, { app, expiresAt: now + (app ? HIT_TTL_MS : MISS_TTL_MS) });
    return app;
  };
}

/** A deployed app is servable only once it has a live endpoint to serve from. */
export function isServable(app: VanityApp | null): app is VanityApp & { fcEndpoint: string } {
  return !!app && app.fcStatus === "live" && !!app.fcEndpoint;
}

// Hop-by-hop headers are connection-scoped: forwarding them corrupts the next
// hop's framing (RFC 9110 §7.6.1). `host` is dropped separately because fetch
// derives it from the upstream URL — and FC routes on it, so passing the
// client's Host through would reach the wrong function or none at all.
const HOP_BY_HOP = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
];

function strip(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const h of HOP_BY_HOP) out.delete(h);
  return out;
}

/** The host of a URL-shaped header value, or undefined when it is not one. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    // `Origin: null` (a sandboxed iframe's opaque origin) lands here, as does
    // any malformed Referer. Neither identifies a site, so neither can be
    // called same-origin.
    return undefined;
  }
}

/**
 * Answer the `Sec-Fetch-Site` question the browser declined to answer.
 *
 * A framework guards its server functions by asking whether the request came
 * from its own pages. `Sec-Fetch-Site` is the header that says so directly, and
 * every other answer is a guess built from names: the guard falls back to
 * comparing `Origin` against the origin it derives from its own `request.url` —
 * which is the UPSTREAM FC hostname, because FC routes on Host and `fetch`
 * cannot override it, so the vanity name the browser used never reaches the app.
 * Every same-origin request from the app's own pages then looks foreign.
 *
 * That is not hypothetical: TanStack Start answers a bare `403 Forbidden`, and
 * the first app deployed on a vanity host had every one of its server functions
 * refused. Browsers attach `Sec-` metadata only to trustworthy origins and apps
 * are served over plain HTTP today, so the header that would have settled it is
 * absent exactly where it is needed.
 *
 * This proxy is the one hop that knows both names, so it fills the header in.
 * Comparing hosts and not full origins is deliberate: whether the client spoke
 * HTTP or HTTPS is not knowable here once TLS terminates upstream, and the
 * scheme is not what the question is about.
 *
 * `Origin` and `Referer` are passed through untouched — an app's own logs should
 * keep showing the hostname its visitor actually typed.
 *
 * Only filled in when ABSENT. Over HTTPS the browser sends its own value, which
 * also distinguishes `same-site` from `cross-site` as this cannot. Forging it is
 * not a way in: `Sec-`-prefixed names are forbidden header names, so page script
 * cannot set one, and a client speaking HTTP directly is not what a CSRF check
 * defends against — it can already send whatever it likes.
 */
function fillFetchMetadata(headers: Headers, incoming: URL): void {
  if (headers.has("sec-fetch-site")) return;
  // Origin first: a same-origin GET carries only a Referer, and a POST carries
  // both. Either one names the page the request came from.
  const initiator = headers.get("origin") ?? headers.get("referer");
  if (!initiator) return;
  const host = hostOf(initiator);
  if (host === undefined) return;
  headers.set("sec-fetch-site", host === incoming.host ? "same-origin" : "cross-site");
}

/**
 * Function Compute stamps a bare `Content-Disposition: attachment` on every
 * response served through its default `*.fcapp.run` hostname, so that nobody
 * uses that hostname as a website: the browser downloads the page instead of
 * rendering it. It arrives on the upstream response, not from the app — this
 * was verified against the trigger URL directly, which carries it too.
 *
 * We are serving the app on its own hostname through our own proxy, so the
 * measure no longer applies and passing it through would make every deployed
 * page a download prompt.
 *
 * Only the BARE value is dropped. An app's own download (`attachment;
 * filename="report.csv"`) carries parameters, is deliberate, and is left alone.
 */
function stripForcedDownload(headers: Headers): Headers {
  if (headers.get("content-disposition")?.trim().toLowerCase() === "attachment") {
    headers.delete("content-disposition");
  }
  return headers;
}

/**
 * Marks a browser as having been sent to HTTPS already, so a wrong guess costs
 * one redirect instead of an endless loop. Deliberately short-lived and not
 * `Secure`: it has to be readable on the HTTP request that follows.
 */
const REDIRECT_ONCE_COOKIE = "_tc_https";

/** Sec-Fetch metadata, which browsers send to trustworthy origins only. */
function hasFetchMetadata(headers: Headers): boolean {
  for (const name of headers.keys()) {
    if (name.startsWith("sec-fetch-")) return true;
  }
  return false;
}

/**
 * Send a plain-HTTP page load to the HTTPS address of the same app, or null to
 * serve the request as it came.
 *
 * Apps were reachable over HTTP alone until their domain got a certificate, so
 * every link handed out until then — bookmarks, QR codes, links pasted into
 * chats — is an `http://` one. This turns those into the HTTPS page, which
 * matters beyond tidiness: over HTTPS the browser sends `Sec-Fetch-Site` itself
 * and the app's own CSRF check works without anything filled in for it.
 *
 * Deciding whether the client spoke HTTPS is the hard part, because TLS
 * terminates at the FC gateway and nothing inside the container can observe it
 * directly. Rather than trusting one header, this refuses to redirect whenever
 * ANY of these says otherwise:
 *
 *   * `x-forwarded-proto: https` — the direct answer, when the gateway gives one.
 *   * any `Sec-Fetch-*` header — browsers attach these to trustworthy origins
 *     only, so their presence means the page was already loaded over HTTPS.
 *     This is what makes a loop impossible for a current browser even if the
 *     forwarded header is missing or wrong: after the redirect the request
 *     carries them, and this returns null.
 *   * the one-shot cookie — a browser too old for Sec-Fetch metadata (Safari
 *     before 16.4) would otherwise be sent round forever. It gets exactly one
 *     redirect, lands on HTTPS, and is served normally from there.
 *
 * Only document navigations are touched. A server function POST or an API call
 * is left alone: redirecting those would change a request the app is in the
 * middle of, and they work over either scheme anyway.
 *
 * 302, not 301: a permanent redirect is cached by the browser and would be
 * painful to walk back if a deployment ever serves apps over HTTP on purpose.
 */
export function httpsRedirect(request: Request, host: string): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const headers = request.headers;
  if (headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https") return null;
  if (hasFetchMetadata(headers)) return null;
  if (headers.get("cookie")?.includes(`${REDIRECT_ONCE_COOKIE}=`)) return null;

  // A page load, not a fetch for data: `Accept` is the only thing that
  // separates them once the Sec-Fetch headers are gone.
  if (!headers.get("accept")?.includes("text/html")) return null;

  const incoming = new URL(request.url);
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://${host}${incoming.pathname}${incoming.search}`,
      "set-cookie": `${REDIRECT_ONCE_COOKIE}=1; Path=/; Max-Age=60; SameSite=Lax`,
      // The address depends on request headers, so a shared cache must not
      // hand this redirect to the next visitor.
      "cache-control": "no-store",
    },
  });
}

/**
 * Proxy one request to the app's FC trigger, streaming both ways.
 *
 * Response headers pass through untouched apart from hop-by-hop ones: the app
 * owns its own content-type, caching and CORS, and second-guessing them here
 * is how a proxy starts breaking the very apps it serves.
 */
export async function proxyToApp(
  request: Request,
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
  identity: ProxyIdentity | null = null,
): Promise<Response> {
  const incoming = new URL(request.url);
  const upstream = new URL(endpoint);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;

  const headers = strip(request.headers);
  headers.delete("host");
  // Drop any client-supplied identity BEFORE writing our own, and drop it
  // unconditionally — including on apps with no login wall, where `identity`
  // is null and nothing is written back. Skipping the delete in that branch
  // would let anyone hand an app a forged X-Teamclu-User-Id simply by setting
  // the header themselves.
  headers.delete("x-teamclu-user-id");
  headers.delete("x-teamclu-user-email");
  headers.delete("x-teamclu-org-id");
  if (identity) {
    headers.set("x-teamclu-user-id", identity.userId);
    headers.set("x-teamclu-user-email", identity.email);
    if (identity.orgId) headers.set("x-teamclu-org-id", identity.orgId);
  }
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));
  fillFetchMetadata(headers, incoming);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const res = await fetchImpl(upstream, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    // Node's fetch refuses a streamed body without it, and buffering instead
    // would hold whole uploads in the API's memory.
    ...(hasBody ? { duplex: "half" } : {}),
    // A 302 belongs to the app; following it here would silently rewrite the
    // app's own navigation into a response from a different URL.
    redirect: "manual",
  } as RequestInit);

  return new Response(res.body, { status: res.status, headers: stripForcedDownload(strip(res.headers)) });
}
