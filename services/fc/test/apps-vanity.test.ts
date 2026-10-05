/**
 * Deployed apps are served on `<slug>-<id8>.<APPS_PUBLIC_DOMAIN>`, which makes
 * the request's Host a routing key AND a certificate request. Both halves are
 * reachable by anyone on the internet, so the parsing below is a security
 * boundary, not a convenience: a host that parses is a host Caddy will go ask
 * Let's Encrypt about.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jwtVerify } from "jose";
import * as originAuth from "../src/lib/apps-origin-auth.js";
import { mintAppSession, APP_COOKIE } from "../src/lib/apps-auth-session.js";
import { createApp } from "../src/app.js";
import { appPublicUrl, appPublicLabel, parseAppPublicHost } from "../src/lib/apps-public-host.js";
import {
  isServable, proxyToApp, httpsRedirect, selectByIdPrefix, makeSupabaseVanityLookup, makeVanityLookup,
  invalidateAppHosts, invalidateVanityHost, __resetVanityCache,
} from "../src/lib/apps-vanity.js";

const DOMAIN = "apps.teamclu-dev.ucar.cc";
const APP_ID = "18e4ecad-6189-495b-a873-7fe09179a5f5";
const env = { APPS_PUBLIC_DOMAIN: DOMAIN } as NodeJS.ProcessEnv;

/** Awaits the callback before restoring: a sync `finally` would put the domain
 *  back while the async body is still between its first and second await. */
async function withDomain<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.APPS_PUBLIC_DOMAIN;
  process.env.APPS_PUBLIC_DOMAIN = DOMAIN;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.APPS_PUBLIC_DOMAIN;
    else process.env.APPS_PUBLIC_DOMAIN = prev;
  }
}

function deps(lookup?: any) {
  return {
    createRepository: () => ({}),
    createAuthRepository: () => ({}),
    ...(lookup ? { lookupVanityApp: lookup } : {}),
  } as any;
}

// --- hostname shape --------------------------------------------------------

test("the label carries an id suffix because slugs are only unique per team", () => {
  // apps_team_slug_uniq is (team_id, slug): two teams can both own `website`,
  // and a hostname has no team in it.
  assert.equal(appPublicLabel("website", APP_ID), "website-18e4ecad");
  assert.equal(appPublicUrl("website", APP_ID, env), `https://website-18e4ecad.${DOMAIN}`);
});

test("a non-ascii slug becomes a legal hostname instead of a failed deploy", () => {
  // `slugify` keeps CJK on purpose (it is what stops every Chinese-named app
  // in a team collapsing to `app`), so the slug routinely is not ASCII. The
  // label built from it went to Alibaba FC as a custom domain name and was
  // rejected — three of seventeen apps on the live deployment have such a
  // slug, two of them stuck in deploy_error.
  const label = appPublicLabel("teamclu-官网", APP_ID);
  assert.equal(label, "xn--teamclu--18e4ecad-nx65apz36b");
  assert.match(label!, /^[a-z0-9-]+$/, "a DNS label is ASCII letters, digits and hyphens");
  assert.equal(
    appPublicUrl("teamclu-官网", APP_ID, env),
    `https://xn--teamclu--18e4ecad-nx65apz36b.${DOMAIN}`,
  );
});

test("the id prefix survives the encoding, so the host still routes", () => {
  // The prefix ends up INSIDE the punycode, with no readable `-18e4ecad` to
  // split on. Parsing has to decode before it splits, or every app this fixes
  // would deploy to a hostname that then resolves to nothing.
  const label = appPublicLabel("teamclu-官网", APP_ID);
  assert.deepEqual(parseAppPublicHost(`${label}.${DOMAIN}`, env), {
    slug: "teamclu-官网",
    idPrefix: "18e4ecad",
  });
});

test("a label too long for DNS gets no vanity host at all", () => {
  // Fail closed: 63 bytes is the hard limit, and a hostname no certificate can
  // cover is worse than falling back to the app's FC trigger URL.
  //
  // 60 characters, not 40: punycode compresses a repeated character hard
  // (40 of them still encode to 58 bytes), and `domainToASCII` enforces no
  // length limit of its own — the check here is the only thing standing
  // between a very long name and an illegal hostname.
  const long = "验".repeat(60);
  assert.equal(appPublicLabel(long, APP_ID), null);
  assert.equal(appPublicUrl(long, APP_ID, env), null);
});

test("no apps domain means no public URL at all", () => {
  assert.equal(appPublicUrl("website", APP_ID, {} as NodeJS.ProcessEnv), null);
  assert.equal(parseAppPublicHost(`website-18e4ecad.${DOMAIN}`, {} as NodeJS.ProcessEnv), null);
});

test("parses a vanity host into slug + id prefix, port and case included", () => {
  assert.deepEqual(parseAppPublicHost(`website-18e4ecad.${DOMAIN}`, env), {
    slug: "website", idPrefix: "18e4ecad",
  });
  assert.deepEqual(parseAppPublicHost(`WebSite-18E4ECAD.${DOMAIN}:8443`, env), {
    slug: "website", idPrefix: "18e4ecad",
  });
  // Slugs may contain dashes; only the LAST one separates the id.
  assert.deepEqual(parseAppPublicHost(`my-cool-site-18e4ecad.${DOMAIN}`, env), {
    slug: "my-cool-site", idPrefix: "18e4ecad",
  });
});

test("refuses everything that is not exactly one label under the apps domain", () => {
  const bad = [
    "api.teamclu-dev.ucar.cc",             // the Cloud API's own name
    DOMAIN,                                 // the bare apps domain
    `deep.website-18e4ecad.${DOMAIN}`,      // two levels: no wildcard covers it
    `website.${DOMAIN}`,                    // no id suffix
    `website-.${DOMAIN}`,                   // empty id
    `website-zzzzzzzz.${DOMAIN}`,           // not hex — cannot be a uuid prefix
    `website-18e4eca.${DOMAIN}`,            // 7 chars
    `-18e4ecad.${DOMAIN}`,                  // empty slug
    `website-18e4ecad.evil.com`,            // someone else's domain
    "",
  ];
  for (const host of bad) {
    assert.equal(parseAppPublicHost(host, env), null, `should refuse ${host || "<empty>"}`);
  }
});

// --- Caddy's on-demand TLS gate -------------------------------------------

test("ask says no for a host that resolves to no app", async () => {
  // This used to assert the lookup was never consulted — a hostname could be
  // refused on SHAPE alone. Custom domains ended that: an arbitrary domain can
  // only be ruled out by asking, so the gate now asks and the answer is what
  // decides. Refusing on shape would refuse every custom domain, and no
  // certificate would ever be issued for one.
  let called = 0;
  const app = createApp(deps(async () => { called++; return null; }));
  await withDomain(async () => {
    const res = await app.request("/internal/caddy/ask?domain=evil.example.com");
    assert.equal(res.status, 404, "an unknown name must still get no certificate");
  });
  assert.equal(called, 1, "the answer comes from the lookup, not from the shape");
});

test("ask says no for a well-formed host with no app behind it", async () => {
  const app = createApp(deps(async () => null));
  await withDomain(async () => {
    const res = await app.request(`/internal/caddy/ask?domain=ghost-18e4ecad.${DOMAIN}`);
    assert.equal(res.status, 404);
  });
});

test("ask says yes for a real app, even before it has ever deployed", async () => {
  // The certificate is for the hostname, not for the deployment: refusing here
  // would leave a just-created app unable to get one until its first deploy.
  const app = createApp(deps(async () => ({
    id: APP_ID, slug: "website", fcEndpoint: null, fcStatus: null,
  })));
  await withDomain(async () => {
    const res = await app.request(`/internal/caddy/ask?domain=website-18e4ecad.${DOMAIN}`);
    assert.equal(res.status, 200);
  });
});

// --- serving ---------------------------------------------------------------

test("a vanity host with nothing deployed behind it 404s instead of proxying to null", async () => {
  const app = createApp(deps(async () => ({
    id: APP_ID, slug: "website", fcEndpoint: null, fcStatus: "awaiting_build",
  })));
  await withDomain(async () => {
    const res = await app.request("/", { headers: { host: `website-18e4ecad.${DOMAIN}` } });
    assert.equal(res.status, 404);
    assert.match(await res.text(), /not deployed/);
  });
});

test("requests on the API's own host still reach the API", async () => {
  // The middleware runs on every request; only Host decides. Getting this wrong
  // would take the whole Cloud API down.
  const app = createApp(deps(async () => { throw new Error("must not be consulted"); }));
  await withDomain(async () => {
    const res = await app.request("/v1/nope-nope", {
      headers: { host: "api.teamclu-dev.ucar.cc", authorization: "Bearer abc" },
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json() as any).error.code, "not_found");
  });
});

/** Auth columns are irrelevant to routing; spelled out so the row shape is whole. */
const unauthed = {
  teamId: null, orgId: null, authMode: null, authAudience: null, authScope: null, authRules: null,
  customDomain: null, customDomainVerifiedAt: null,
};

test("an ambiguous id prefix serves neither app", () => {
  const rows = [
    { id: "18e4ecad-1111", slug: "website", fcEndpoint: "https://a", fcStatus: "live", ...unauthed },
    { id: "18e4ecad-2222", slug: "website", fcEndpoint: "https://b", fcStatus: "live", ...unauthed },
  ];
  assert.equal(selectByIdPrefix(rows, "18e4ecad"), null, "a coin flip between teams is not an answer");
  assert.equal(selectByIdPrefix(rows, "18e4ecad-1"), rows[0]);
  assert.equal(selectByIdPrefix(rows, "deadbeef"), null);
});

test("a successful endpoint remains servable through active and failed redeploys", () => {
  assert.equal(isServable(null), false);
  assert.equal(isServable({ id: "1", slug: "s", fcStatus: "live", fcEndpoint: null, ...unauthed }), false);
  for (const status of ["awaiting_build", "building", "deploying", "deploy_error"]) {
    assert.equal(isServable({ id: "1", slug: "s", fcStatus: status, fcEndpoint: "https://x", ...unauthed }), true);
  }
  assert.equal(isServable({ id: "1", slug: "s", fcStatus: "not_deployed", fcEndpoint: "https://x", ...unauthed }), false);
  assert.equal(isServable({ id: "1", slug: "s", fcStatus: "live", fcEndpoint: "https://x", ...unauthed }), true);
});

// --- both entry points ------------------------------------------------------

test("every createApp() call wires the vanity lookup", () => {
  // There are two entries: the container (server.ts) and the Alibaba FC handler
  // (index.ts). The first version of this feature wired only the handler, so
  // the self-host container — the ONLY deployment that serves vanity hosts —
  // registered neither the proxy nor `ask`, and answered a bare 404 that looked
  // exactly like a DNS or certificate problem.
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const entry of ["server.ts", "index.ts"]) {
    const src = fs.readFileSync(path.join(here, "../src", entry), "utf8");
    assert.match(
      src,
      /createApp\(\{[\s\S]*?lookupVanityApp[\s\S]*?\}\)/,
      `${entry} builds an app without lookupVanityApp`,
    );
  }
});

test("every createApp() call wires the marketplace system repository", () => {
  // Same two-entry trap as vanity: marketplace admin was wired only on the
  // Aliyun FC handler. Self-host Docker uses server.ts and returned 503
  // "marketplace admin repository not configured" for every admin publish.
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const entry of ["server.ts", "index.ts"]) {
    const src = fs.readFileSync(path.join(here, "../src", entry), "utf8");
    assert.match(
      src,
      /createApp\(\{[\s\S]*?createSystemRepository[\s\S]*?\}\)/,
      `${entry} builds an app without createSystemRepository`,
    );
  }
});

// --- which database the lookup reads --------------------------------------

test("the supabase lookup filters by slug and matches the id prefix in memory", async () => {
  // NOT `id like '18e4ecad%'`: `id` is a uuid column and Postgres has no
  // `uuid ~~ text` operator, so that filter comes back as a query ERROR rather
  // than an empty result — a failure mode that only shows up against a real
  // database, never against a mock that accepts any filter.
  const calls: any[] = [];
  const client = {
    from(table: string) {
      const q: any = {
        select(cols: string) { calls.push(["select", table, cols]); return q; },
        eq(col: string, val: string) { calls.push(["eq", col, val]); return q; },
        like() { throw new Error("must not filter a uuid column with LIKE"); },
        limit() {
          return Promise.resolve({
            data: [
              { id: "18e4ecad-6189-495b-a873-7fe09179a5f5", slug: "website", fc_endpoint: "https://up", fc_status: "live" },
              { id: "99999999-0000-0000-0000-000000000000", slug: "website", fc_endpoint: "https://other", fc_status: "live" },
            ],
            error: null,
          });
        },
      };
      return q;
    },
  };
  const lookup = makeSupabaseVanityLookup(() => client);
  const found = await withDomain(() => lookup(`website-18e4ecad.${DOMAIN}`));
  assert.equal(found?.fcEndpoint, "https://up", "the OTHER team's app must not be served");
  assert.deepEqual(calls.find((c) => c[0] === "eq"), ["eq", "slug", "website"]);
});

test("the supabase lookup surfaces a query error instead of reporting 'no such app'", async () => {
  // Answering null on an error would tell Caddy the app does not exist, and a
  // transient database blip would look exactly like a deleted app.
  const client = { from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: "boom" } }) }) }) }) };
  const lookup = makeSupabaseVanityLookup(() => client);
  await assert.rejects(
    () => withDomain(() => lookup(`website-18e4ecad.${DOMAIN}`)),
    /vanity app lookup failed: boom/,
  );
});

test("a non-app host is asked about once, then remembered", async () => {
  // The old contract — "a non-app host builds no client at all" — could not
  // survive custom domains: an arbitrary hostname is indistinguishable from
  // the API's own without a query. The cache is what keeps that from putting
  // a database round trip in front of EVERY Cloud API request; misses are
  // cached precisely because they are the common case.
  let srBuilt = 0;
  const lookup = makeVanityLookup({
    getServiceRoleClient: () => {
      srBuilt++;
      return {
        from: () => ({
          select: () => ({
            eq: () => ({
              limit: async () => ({ data: [], error: null }),
              not: () => ({ limit: async () => ({ data: [], error: null }) }),
            }),
          }),
        }),
      };
    },
  });

  await withDomain(async () => {
    __resetVanityCache();
    assert.equal(await lookup("api.teamclu-dev.ucar.cc"), null);
    assert.equal(srBuilt, 1, "an unknown host has to be asked about once");

    assert.equal(await lookup("api.teamclu-dev.ucar.cc"), null);
    assert.equal(srBuilt, 1, "and not again while the miss is cached");

    assert.equal(await lookup(`ghost-18e4ecad.${DOMAIN}`), null);
    assert.equal(srBuilt, 2, "a different host is its own question");
  });
});

test("a binding change drops the cached answer immediately", async () => {
  // Without this a newly verified domain would 404 until the miss expired,
  // which reads as "verification did not work".
  let calls = 0;
  const lookup = makeVanityLookup({
    getServiceRoleClient: () => {
      calls++;
      return {
        from: () => ({
          select: () => ({
            eq: () => ({
              limit: async () => ({ data: [], error: null }),
              not: () => ({ limit: async () => ({ data: [], error: null }) }),
            }),
          }),
        }),
      };
    },
  });
  await withDomain(async () => {
    __resetVanityCache();
    await lookup("shop.example.com");
    await lookup("shop.example.com");
    assert.equal(calls, 1);
    invalidateVanityHost("shop.example.com");
    await lookup("shop.example.com");
    assert.equal(calls, 2, "the next request must re-ask");
  });
});

test("an app write drops both of the app's hostnames", async () => {
  // Auth rules, endpoint and existence are all read off the cached row, on the
  // vanity host and on a bound custom domain alike.
  let calls = 0;
  const lookup = makeVanityLookup({
    getServiceRoleClient: () => {
      calls++;
      return {
        from: () => ({
          select: () => ({
            eq: () => ({
              limit: async () => ({ data: [], error: null }),
              not: () => ({ limit: async () => ({ data: [], error: null }) }),
            }),
          }),
        }),
      };
    },
  });
  await withDomain(async () => {
    __resetVanityCache();
    const vanity = `${appPublicLabel("shop", APP_ID)}.${DOMAIN}`;
    await lookup(vanity);
    await lookup("shop.example.com");
    await lookup(vanity);
    await lookup("shop.example.com");
    assert.equal(calls, 2);

    invalidateAppHosts({ id: APP_ID, slug: "shop", customDomain: "shop.example.com" });
    await lookup(vanity);
    await lookup("shop.example.com");
    assert.equal(calls, 4, "both hosts must re-ask");
  });
});

test("dropping an app's hostnames never throws, whatever the slug or domain", async () => {
  await withDomain(async () => {
    assert.doesNotThrow(() => invalidateAppHosts({ id: APP_ID, slug: "x".repeat(80), customDomain: null }));
    assert.doesNotThrow(() => invalidateAppHosts({ id: APP_ID, slug: null }));
  });
  assert.doesNotThrow(() =>
    invalidateAppHosts({ id: APP_ID, slug: "shop" }, { APPS_PUBLIC_DOMAIN: "not a domain:99999" } as NodeJS.ProcessEnv),
  );
});

// --- the proxy itself ------------------------------------------------------

test("proxy keeps path and query, and sends the UPSTREAM host", async () => {
  // Function Compute routes on Host. Forwarding the client's Host reaches no
  // function at all, which is the failure this asserts against.
  let seen: any = null;
  const fake = (async (url: any, init: any) => {
    seen = { url: String(url), headers: new Headers(init.headers) };
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const req = new Request(`https://website-18e4ecad.${DOMAIN}/blog/post?id=7`, {
    headers: { host: `website-18e4ecad.${DOMAIN}`, "x-test": "1", connection: "keep-alive" },
  });
  await proxyToApp(req, "https://tc-app-x-abc123.cn-shenzhen.fcapp.run", fake);

  assert.equal(seen.url, "https://tc-app-x-abc123.cn-shenzhen.fcapp.run/blog/post?id=7");
  assert.equal(seen.headers.get("host"), null, "client Host must not be forwarded");
  assert.equal(seen.headers.get("connection"), null, "hop-by-hop headers must be dropped");
  assert.equal(seen.headers.get("x-test"), "1", "everything else passes through");
  assert.equal(seen.headers.get("x-forwarded-host"), `website-18e4ecad.${DOMAIN}`);
});

test("proxy passes the app's own status and headers back untouched", async () => {
  const fake = (async () => new Response("<!doctype html>", {
    status: 201,
    headers: { "content-type": "text/html", "access-control-allow-origin": "*", "transfer-encoding": "chunked" },
  })) as unknown as typeof fetch;

  const res = await proxyToApp(new Request(`https://website-18e4ecad.${DOMAIN}/`), "https://up.example", fake);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("content-type"), "text/html");
  // The app owns its CORS; rewriting it here would break the app it serves.
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("transfer-encoding"), null, "hop-by-hop must not survive");
  assert.equal(await res.text(), "<!doctype html>");
});

test("proxy drops the forced-download header FC stamps on its default domain", async () => {
  // Verified against the live trigger URL: `content-disposition: attachment`
  // (bare, no filename) rides on the UPSTREAM response, so passing it through
  // turned every deployed page into a download prompt in the browser.
  const fake = (async () => new Response("<!doctype html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "content-disposition": "attachment" },
  })) as unknown as typeof fetch;
  const res = await proxyToApp(new Request("https://website-18e4ecad.example/"), "https://up.example", fake);
  assert.equal(res.headers.get("content-disposition"), null);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
});

test("proxy keeps a download the app actually asked for", async () => {
  // A real download names its file. Dropping that would break every export
  // button in every deployed app.
  const fake = (async () => new Response("a,b\n1,2", {
    status: 200,
    headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="report.csv"' },
  })) as unknown as typeof fetch;
  const res = await proxyToApp(new Request("https://website-18e4ecad.example/export"), "https://up.example", fake);
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="report.csv"');
});

test("proxy does not follow the app's redirects on its behalf", async () => {
  let init: any = null;
  const fake = (async (_u: any, i: any) => { init = i; return new Response(null, { status: 302, headers: { location: "/login" } }); }) as unknown as typeof fetch;
  const res = await proxyToApp(new Request(`https://website-18e4ecad.${DOMAIN}/`), "https://up.example", fake);
  assert.equal(init.redirect, "manual");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/login");
});

// --- Sec-Fetch-Site, the header the browser withholds over plain HTTP -------

/** Proxies one request and returns the headers the upstream would have seen. */
async function forwardedHeaders(req: Request, endpoint = "http://website-18e4ecad.fc-apps.example"): Promise<Headers> {
  let seen = new Headers();
  const fake = (async (_u: any, init: any) => {
    seen = new Headers(init.headers);
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  await proxyToApp(req, endpoint, fake);
  return seen;
}

test("a same-origin request is marked as one, because the app cannot tell", async () => {
  // The whole reason this exists: the app derives its own origin from the Host
  // it receives, which is the upstream FC name — never the vanity name in
  // Origin. TanStack Start's CSRF guard compares the two and answers a bare
  // `403 Forbidden`, which is what the first app on a vanity host hit on every
  // server function it has.
  const headers = await forwardedHeaders(new Request(`https://website-18e4ecad.${DOMAIN}/_serverFn/abc`, {
    method: "POST",
    headers: { origin: `https://website-18e4ecad.${DOMAIN}` },
    body: "{}",
  }));
  assert.equal(headers.get("sec-fetch-site"), "same-origin");
  assert.equal(headers.get("origin"), `https://website-18e4ecad.${DOMAIN}`, "Origin passes through untouched");
});

test("a same-origin GET is recognised from its Referer alone", async () => {
  // A same-origin GET carries no Origin at all, so Referer is the only thing
  // naming the page it came from. Reading only Origin would leave every GET
  // server function refused.
  const headers = await forwardedHeaders(new Request(`https://website-18e4ecad.${DOMAIN}/_serverFn/abc`, {
    headers: { referer: `https://website-18e4ecad.${DOMAIN}/todos?filter=open` },
  }));
  assert.equal(headers.get("sec-fetch-site"), "same-origin");
});

test("the scheme does not decide it, because TLS terminates before this hop", async () => {
  // The client spoke HTTPS; this proxy sees HTTP. Comparing full origins would
  // call the app's own page cross-site the moment apps get a certificate.
  const headers = await forwardedHeaders(new Request(`http://website-18e4ecad.${DOMAIN}/_serverFn/abc`, {
    method: "POST",
    headers: { origin: `https://website-18e4ecad.${DOMAIN}` },
    body: "{}",
  }));
  assert.equal(headers.get("sec-fetch-site"), "same-origin");
});

test("a request from another site is marked cross-site, so the app still refuses it", async () => {
  // The CSRF guarantee has to survive this: filling the header in must not
  // become a way to hand any origin a same-origin label.
  const headers = await forwardedHeaders(new Request(`https://website-18e4ecad.${DOMAIN}/_serverFn/abc`, {
    method: "POST",
    headers: { origin: "https://evil.example" },
    body: "{}",
  }));
  assert.equal(headers.get("sec-fetch-site"), "cross-site");
});

test("another app on the same apps domain is cross-site too", async () => {
  // Sibling vanity hosts share a registered domain, so a `same-site` answer
  // would be defensible and wrong: each host is a different team's app.
  const headers = await forwardedHeaders(new Request(`https://website-18e4ecad.${DOMAIN}/_serverFn/abc`, {
    method: "POST",
    headers: { origin: `https://other-99999999.${DOMAIN}` },
    body: "{}",
  }));
  assert.equal(headers.get("sec-fetch-site"), "cross-site");
});

test("a browser that sent its own Sec-Fetch-Site keeps it", async () => {
  // Over HTTPS the browser answers for itself, and it can tell same-site from
  // cross-site. Overwriting that would replace a precise answer with a coarser
  // one — and would let a request relabel itself if it ever could set the header.
  const headers = await forwardedHeaders(new Request(`https://website-18e4ecad.${DOMAIN}/_serverFn/abc`, {
    method: "POST",
    headers: { "sec-fetch-site": "same-site", origin: `https://website-18e4ecad.${DOMAIN}` },
    body: "{}",
  }));
  assert.equal(headers.get("sec-fetch-site"), "same-site");
});

test("a request naming no page at all is left alone", async () => {
  // curl, a health check, a webhook. Nothing here says where it came from, and
  // inventing `same-origin` for it would disable the app's CSRF check outright.
  const headers = await forwardedHeaders(new Request(`https://website-18e4ecad.${DOMAIN}/_serverFn/abc`, {
    method: "POST",
    body: "{}",
  }));
  assert.equal(headers.get("sec-fetch-site"), null);
});

test("an opaque origin is not treated as same-origin", async () => {
  // A sandboxed iframe posts `Origin: null`. It parses as no host, and a
  // header that names no site cannot be answered with `same-origin`.
  const headers = await forwardedHeaders(new Request(`https://website-18e4ecad.${DOMAIN}/_serverFn/abc`, {
    method: "POST",
    headers: { origin: "null" },
    body: "{}",
  }));
  assert.equal(headers.get("sec-fetch-site"), null);
});

// --- sending old http:// links to https ------------------------------------

const HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/** A page load as a browser sends it over plain HTTP: no Sec-Fetch metadata. */
function pageLoad(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers: { accept: HTML, ...headers } });
}

test("an http page load is sent to the https address, path and query kept", async () => {
  // Apps were HTTP-only until their domain got a certificate, so every link
  // handed out until then — bookmarks, QR codes, links pasted into chats — is
  // an http:// one.
  const res = httpsRedirect(pageLoad(`http://website-18e4ecad.${DOMAIN}/todos?filter=open`), `website-18e4ecad.${DOMAIN}`);
  assert.equal(res?.status, 302);
  assert.equal(res?.headers.get("location"), `https://website-18e4ecad.${DOMAIN}/todos?filter=open`);
  assert.equal(res?.headers.get("cache-control"), "no-store", "the target depends on request headers");
});

test("a request already carrying Sec-Fetch metadata is served, not redirected", async () => {
  // This is what makes a loop impossible on a current browser: over HTTPS the
  // browser attaches these itself, so the request that arrives after the
  // redirect is recognised as already-secure without trusting any proxy header.
  assert.equal(
    httpsRedirect(pageLoad(`http://website-18e4ecad.${DOMAIN}/`, { "sec-fetch-mode": "navigate" }), `website-18e4ecad.${DOMAIN}`),
    null,
  );
});

test("x-forwarded-proto: https settles it directly when the gateway sends one", async () => {
  assert.equal(
    httpsRedirect(pageLoad(`http://website-18e4ecad.${DOMAIN}/`, { "x-forwarded-proto": "https" }), `website-18e4ecad.${DOMAIN}`),
    null,
  );
  // Some proxies append rather than replace.
  assert.equal(
    httpsRedirect(pageLoad(`http://website-18e4ecad.${DOMAIN}/`, { "x-forwarded-proto": "https, http" }), `website-18e4ecad.${DOMAIN}`),
    null,
  );
});

test("the one-shot cookie stops a browser too old for Sec-Fetch looping forever", async () => {
  // Safari before 16.4 sends no Sec-Fetch headers even over HTTPS. Without
  // this it would be redirected to a page that redirects it again. It gets one
  // redirect, lands on HTTPS, and is served from there.
  const first = httpsRedirect(pageLoad(`http://website-18e4ecad.${DOMAIN}/`), `website-18e4ecad.${DOMAIN}`);
  assert.equal(first?.status, 302);
  const cookie = first!.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^_tc_https=1;/);
  assert.doesNotMatch(cookie, /Secure/, "it has to be readable on the http request that follows");

  const second = httpsRedirect(
    pageLoad(`http://website-18e4ecad.${DOMAIN}/`, { cookie: "_tc_https=1" }),
    `website-18e4ecad.${DOMAIN}`,
  );
  assert.equal(second, null, "a second redirect would be a loop");
});

test("a server function call is left alone", async () => {
  // Redirecting a POST mid-flight would change a request the app is in the
  // middle of, and it works over either scheme anyway.
  const post = new Request(`http://website-18e4ecad.${DOMAIN}/_serverFn/abc`, {
    method: "POST", headers: { accept: HTML }, body: "{}",
  });
  assert.equal(httpsRedirect(post, `website-18e4ecad.${DOMAIN}`), null);
});

test("an API GET that is not a page load is left alone", async () => {
  // `Accept` is all that separates a data fetch from a navigation once the
  // Sec-Fetch headers are gone.
  const res = httpsRedirect(
    new Request(`http://website-18e4ecad.${DOMAIN}/api/todos`, { headers: { accept: "application/json" } }),
    `website-18e4ecad.${DOMAIN}`,
  );
  assert.equal(res, null);
});

test("a hostname that is not an app still 404s instead of redirecting", async () => {
  // Otherwise a mistyped link would answer 302 and send the visitor to an
  // https 404, hiding which of the two things went wrong.
  await withDomain(async () => {
    const app = createApp(deps(async (host: string) => (host.startsWith("known-18e4ecad.") ? {
      id: APP_ID, slug: "known", fcEndpoint: "http://up.example", fcStatus: "live",
    } : null)));
    const res = await app.request(`http://missing-18e4ecad.${DOMAIN}/`, { headers: { accept: HTML } });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("location"), null);
  });
});

// --- custom domains (批次 4) -------------------------------------------------

/**
 * Records the filters a query applied, so a test can assert that the
 * verification filter was actually part of the query rather than assumed.
 */
function customDomainClient(rows: any[]) {
  const filters: string[] = [];
  return {
    filters,
    client: {
      from: () => ({
        select: () => ({
          eq: (col: string, val: string) => {
            filters.push(`eq:${col}=${val}`);
            return {
              limit: async () => ({ data: rows, error: null }),
              not: (col2: string, op: string, val2: any) => {
                filters.push(`not:${col2} ${op} ${val2}`);
                return { limit: async () => ({ data: rows, error: null }) };
              },
            };
          },
        }),
      }),
    },
  };
}

const CUSTOM_ROW = {
  id: "18e4ecad-1111-2222-3333-444444444444",
  slug: "shop",
  fc_endpoint: "https://up.example",
  fc_status: "live",
  team_id: "team-1",
  auth_mode: "platform",
  auth_audience: "any",
  auth_scope: "all",
  auth_rules: [],
  custom_domain: "shop.example.com",
  custom_domain_verified_at: "2026-09-08T00:00:00Z",
};

test("a verified custom domain resolves to its app", async () => {
  const { client, filters } = customDomainClient([CUSTOM_ROW]);
  const lookup = makeSupabaseVanityLookup(() => client);
  const found = await withDomain(() => lookup("shop.example.com"));
  assert.equal(found?.id, CUSTOM_ROW.id);
  assert.equal(found?.customDomain, "shop.example.com");
  assert.ok(filters.includes("eq:custom_domain=shop.example.com"));
});

test("the query refuses to consider an unverified domain", async () => {
  // Not an optimisation. Without this filter the certificate gate would answer
  // 200 for a name whose ownership was never proven, and Caddy would go and
  // get a certificate for it — an open minting endpoint for anything pointed
  // at this box, burning a rate limit shared with api/supabase/mqtt.
  const { client, filters } = customDomainClient([CUSTOM_ROW]);
  const lookup = makeSupabaseVanityLookup(() => client);
  await withDomain(() => lookup("shop.example.com"));
  assert.ok(
    filters.some((f) => f.startsWith("not:custom_domain_verified_at")),
    `verification filter missing; applied: ${filters.join(", ")}`,
  );
});

test("a host carrying a port still matches the stored domain", async () => {
  const { client, filters } = customDomainClient([CUSTOM_ROW]);
  const lookup = makeSupabaseVanityLookup(() => client);
  await withDomain(() => lookup("SHOP.example.com:443"));
  assert.ok(filters.includes("eq:custom_domain=shop.example.com"));
});

test("two apps claiming one domain serve neither", async () => {
  // The unique index makes this impossible; serving either would be a coin
  // flip between owners, so it fails closed if it ever happens.
  const { client } = customDomainClient([CUSTOM_ROW, { ...CUSTOM_ROW, id: "other" }]);
  const lookup = makeSupabaseVanityLookup(() => client);
  assert.equal(await withDomain(() => lookup("shop.example.com")), null);
});


// --- protected origins ------------------------------------------------------
const ROUTE_DOMAIN = "origins.test";
const ORIGIN_HOST = "website-18e4ecad.origins.test";
const originTarget = { appId: APP_ID, slug: "website" };
const originEnv = {
  APPS_FC_ROUTE_DOMAIN: ROUTE_DOMAIN,
  APPS_FC_ORIGIN_KEYRING: JSON.stringify({ active: { version: "v1", key: Buffer.alloc(32, 42).toString("base64url") } }),

};
const originConfig = () => originAuth.readAppsOriginAuthConfig(originEnv);
const originOptions = () => ({ target: originTarget, config: originConfig() });
async function verifyOriginHeader(headers: Headers, host = ORIGIN_HOST) {
  const credential = headers.get("x-teamclu-origin-authorization");
  assert.match(credential ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  const key = Buffer.from(originAuth.originJwks(originConfig(), APP_ID).keys[0].k, "base64url");
  const { payload } = await jwtVerify(credential!.slice(7), key, { algorithms: ["HS256"] });
  assert.equal(payload.version, "v1");
  assert.equal(payload.appId, APP_ID);
  assert.equal(payload.originHost, host);
  assert.ok(payload.exp! - payload.iat! <= 60);
  return credential!;
}
for (const identity of [null, { userId: "trusted-user", email: "trusted@example.com", orgId: "trusted-org" }]) {
  test(`protected proxy signs ${identity ? "trusted login" : "anonymous public"} requests and replaces forgeries`, async () => {
    let seen = new Headers();
    const response = await proxyToApp(new Request("https://public.example/", { headers: {
      "X-TeaMClu-Origin-Authorization": "Bearer client-forgery", "X-Teamclu-User-Id": "fake-user",
      "X-Teamclu-User-Email": "fake@example.com", "X-Teamclu-Org-Id": "fake-org",
      "X-TeaMClu-Origin-Version": "client-forgery",
      authorization: "Bearer business-token", cookie: "business-cookie=value",
    } }), `http://${ORIGIN_HOST}`, (async (_u: any, init: any) => { seen = new Headers(init.headers); return new Response("page"); }) as typeof fetch, identity, originOptions());
    await verifyOriginHeader(seen);
    assert.equal(seen.get("x-teamclu-origin-version"), null);
    assert.equal(seen.get("x-teamclu-user-id"), identity?.userId ?? null);
    assert.equal(seen.get("x-teamclu-user-email"), identity?.email ?? null);
    assert.equal(seen.get("x-teamclu-org-id"), identity?.orgId ?? null);
    assert.equal(seen.get("authorization"), "Bearer business-token");
    assert.equal(seen.get("cookie"), "business-cookie=value");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-teamclu-origin-authorization"), null);
  });
}
for (const [slug, host] of [["website", ORIGIN_HOST], ["teamclu-官网", "xn--teamclu--18e4ecad-nx65apz36b.origins.test"]]) {
  test(`classifier protects the canonical ASCII host for raw slug ${slug}`, () => {
    const classify = originAuth.classifyOriginEndpoint;
    assert.equal(classify(`http://${host}`, { appId: APP_ID, slug }, ROUTE_DOMAIN), "protected");
    assert.equal(classify(`http://${host}:80/`, { appId: APP_ID, slug }, ROUTE_DOMAIN), "protected");
    assert.equal(classify(`https://${host}`, { appId: APP_ID, slug }, ROUTE_DOMAIN), "protected");
  });
  test(`protected proxy signs the canonical host for raw slug ${slug}`, async () => {
    let seen = new Headers();
    await proxyToApp(new Request("https://public.example/"), `http://${host}`, (async (_u: any, i: any) => { seen = new Headers(i.headers); return new Response("ok"); }) as typeof fetch, null, { target: { appId: APP_ID, slug }, config: originConfig() });
    await verifyOriginHeader(seen, host);
  });
}
for (const endpoint of [
  `http://other-18e4ecad.${ROUTE_DOMAIN}`, `http://website.${ROUTE_DOMAIN}`, `http://${ORIGIN_HOST}:8443`,
  `http://user:password@${ORIGIN_HOST}`, `http://${ORIGIN_HOST}/extra`, `http://${ORIGIN_HOST}/../`,
  `http://${ORIGIN_HOST}?extra=1`, `http://${ORIGIN_HOST}#fragment`, `http://${ORIGIN_HOST}.`,
  `ftp://${ORIGIN_HOST}`, `not-a-url`,
]) {
  test(`invalid protected target does not fetch: ${endpoint}`, async () => {
    let calls = 0;
    const response = await proxyToApp(new Request("https://public.example/"), endpoint, (async () => { calls++; return new Response("unsafe"); }) as typeof fetch, null, originOptions());
    assert.equal(calls, 0); assert.ok(response.status >= 500);
    assert.doesNotMatch(await response.text(), /password|Bearer|eyJ/);
  });
}
for (const endpoint of ["http://existing.example", "https://tc-app-x-abc123.cn-shenzhen.fcapp.run", "https://existing.example/base?old=1"]) {
  test(`legacy endpoint stays unsigned and removes a supplied credential: ${endpoint}`, async () => {
    let seen = new Headers();
    const response = await proxyToApp(new Request("https://public.example/path?x=1", { headers: { "X-Teamclu-Origin-Authorization": "Bearer client-forgery", "X-Teamclu-Origin-Version": "forgery" } }), endpoint, (async (_u: any, init: any) => { seen = new Headers(init.headers); return new Response("legacy", { status: 202 }); }) as typeof fetch, null, originOptions());
    assert.equal(seen.get("x-teamclu-origin-authorization"), null);
    assert.equal(seen.get("x-teamclu-origin-version"), null);
    assert.equal(response.status, 202); assert.equal(await response.text(), "legacy");
  });
}
test("four-argument legacy callers also remove origin credential forgeries", async () => {
  const headers = await forwardedHeaders(new Request("https://public.example/", { headers: { "X-TEAMCLU-Origin-Authorization": "forgery" } }));
  assert.equal(headers.get("x-teamclu-origin-authorization"), null);
});
for (const method of ["HEAD", "OPTIONS", "POST"]) {
  test(`protected ${method} preserves streamed body, path and query`, async () => {
    const request = new Request("https://public.example/upload?x=1", { method, ...(method === "POST" ? { body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("streamed upload")); c.close(); } }), duplex: "half" } : {}) } as RequestInit);
    let seen: any;
    const response = await proxyToApp(request, `http://${ORIGIN_HOST}`, (async (url: any, init: any) => { seen = { url: String(url), ...init }; return new Response(null, { status: 204 }); }) as typeof fetch, null, originOptions());
    await verifyOriginHeader(new Headers(seen.headers));
    assert.equal(seen.url, `http://${ORIGIN_HOST}/upload?x=1`); assert.equal(seen.method, method);
    assert.equal(seen.body, method === "HEAD" ? undefined : request.body);
    if (method !== "HEAD") assert.equal(seen.duplex, "half");
    assert.equal(response.status, 204);
  });
}
test("protected multipart upload retains content type and bytes", async () => {
  const form = new FormData(); form.append("file", new Blob(["image-data"]), "photo.png");
  const request = new Request("https://public.example/upload", { method: "POST", body: form });
  const expectedBody = await request.clone().text();
  await proxyToApp(request, `http://${ORIGIN_HOST}`, (async (_u: any, init: any) => {
    await verifyOriginHeader(new Headers(init.headers));
    assert.equal(new Headers(init.headers).get("content-type"), request.headers.get("content-type"));
    assert.equal(await new Response(init.body).text(), expectedBody); return new Response("uploaded");
  }) as typeof fetch, null, originOptions());
});
test("protected external redirect remains manual and cannot return its credential header", async () => {
  let calls = 0;
  const response = await proxyToApp(new Request("https://public.example/"), `http://${ORIGIN_HOST}`, (async (_u: any, init: any) => {
    calls++; assert.equal(init.redirect, "manual");
    const token = await verifyOriginHeader(new Headers(init.headers));
    return new Response(null, { status: 302, headers: { location: "https://external.example/login", "X-Teamclu-Origin-Authorization": token, "X-Teamclu-Origin-Version": "v1" } });
  }) as typeof fetch, null, originOptions());
  assert.equal(calls, 1); assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://external.example/login");
  assert.equal(response.headers.get("x-teamclu-origin-authorization"), null);
  assert.equal(response.headers.get("x-teamclu-origin-version"), null);
});
test("protected SSE passes through without consuming its stream", async () => {
  let finished = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: first\n\n")); }, cancel() { finished = true; } });
  const response = await proxyToApp(new Request("https://public.example/events"), `http://${ORIGIN_HOST}`, (async (_u: any, init: any) => { await verifyOriginHeader(new Headers(init.headers)); return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } }); }) as typeof fetch, null, originOptions());
  assert.equal(response.headers.get("content-type"), "text/event-stream"); assert.equal(response.headers.get("cache-control"), "no-cache");
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: first\n\n");
  assert.equal(finished, false); await reader.cancel();
});
test("protected fetch errors cannot expose credentials in platform responses", async () => {
  const response = await proxyToApp(new Request("https://public.example/"), `http://${ORIGIN_HOST}`, (async (_u: any, init: any) => { const credential = await verifyOriginHeader(new Headers(init.headers)); throw new Error(`transport error contains ${credential}`); }) as typeof fetch, null, originOptions());
  assert.ok(response.status >= 500); assert.doesNotMatch(await response.text(), /Bearer|eyJ|transport error/);
});
async function withOriginEnv(body: () => Promise<void>, extra: Record<string, string | undefined> = {}) {
  const values = { ...originEnv, APPS_PUBLIC_DOMAIN: DOMAIN, LOGIN_DOMAIN: "login.example.com", APPS_AUTH_SESSION_SECRET: "gateway-test-session-secret-at-least-32-characters", ...extra };
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { await body(); } finally { for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
function deployedTarget(over: Record<string, unknown> = {}) {
  return { id: APP_ID, slug: "website", fcEndpoint: `http://${ORIGIN_HOST}`, fcStatus: "live", ...unauthed, ...over };
}
for (const loggedIn of [false, true]) {
  test(`app.ts signs ${loggedIn ? "logged-in" : "public anonymous"} protected traffic using DB target`, async () => withOriginEnv(async () => {
    const oldFetch = globalThis.fetch; let seen = new Headers();
    globalThis.fetch = (async (_u: any, init: any) => { seen = new Headers(init.headers); return new Response("app-page"); }) as typeof fetch;
    try {
      const application = createApp(deps(async () => deployedTarget(loggedIn ? { authMode: "platform", authAudience: "any", authScope: "all" } : {})));
      const cookie = loggedIn ? `${APP_COOKIE}=${(await mintAppSession({ sub: "signed-in", email: "real@example.com", appId: APP_ID })).token}` : "business-cookie=value";
      const response = await application.request(`https://website-18e4ecad.${DOMAIN}/`, { headers: { cookie } });
      assert.equal(response.status, 200); await verifyOriginHeader(seen);
      assert.equal(seen.get("x-teamclu-user-id"), loggedIn ? "signed-in" : null);
    } finally { globalThis.fetch = oldFetch; }
  }));
}
test("app.ts denies role access before loading missing origin config or fetching", async () => withOriginEnv(async () => {
  const oldFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("unsafe"); }) as typeof fetch;
  try {
    const cookie = `${APP_COOKIE}=${(await mintAppSession({ sub: "outsider", email: "outsider@example.com", appId: APP_ID })).token}`;
    const application = createApp({ ...deps(async () => deployedTarget({ authMode: "platform", authAudience: "org", orgId: "org-a", authScope: "all" })), resolveRoleIdentities: async () => [], resolveVisitorRoles: async () => [] });
    const response = await application.request(`https://website-18e4ecad.${DOMAIN}/`, { headers: { cookie } });
    assert.equal(response.status, 403); assert.equal(calls, 0);
  } finally { globalThis.fetch = oldFetch; }
}, { APPS_FC_ORIGIN_KEYRING: undefined }));
test("app.ts protected target without credentials is unavailable while legacy and API still work", async () => withOriginEnv(async () => {
  const oldFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async (_u: any, init: any) => { calls++; assert.equal(new Headers(init.headers).get("x-teamclu-origin-authorization"), null); return new Response("legacy"); }) as typeof fetch;
  try {
    let target: any = deployedTarget();
    const application = createApp(deps(async (host: string) => host.includes("website-18e4ecad") ? target : null));
    const blocked = await application.request(`https://website-18e4ecad.${DOMAIN}/`);
    assert.equal(blocked.status, 503); assert.equal(calls, 0); assert.doesNotMatch(await blocked.text(), /Bearer|eyJ|PRIVATE KEY/);
    target = deployedTarget({ fcEndpoint: "http://existing.example" });
    const legacy = await application.request(`https://website-18e4ecad.${DOMAIN}/`, { headers: { "X-Teamclu-Origin-Authorization": "forged" } });
    assert.equal(legacy.status, 200); assert.equal(await legacy.text(), "legacy"); assert.equal(calls, 1);
    assert.equal((await application.request("https://api.example/healthz")).status, 200);
  } finally { globalThis.fetch = oldFetch; }
}, { APPS_FC_ORIGIN_KEYRING: undefined }));


for (const [endpoint, status] of [
  [`http://${ORIGIN_HOST}`, 503],
  ["https://tc-app-x-abc123.cn-shenzhen.fcapp.run", 200],
  [`https://${ORIGIN_HOST}`, 503],
] as const) {
  test(`missing route domain handles ${endpoint} without guessing protected traffic`, async () => withOriginEnv(async () => {
    const oldFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (_u: any, init: any) => {
      calls++;
      assert.equal(new Headers(init.headers).get("x-teamclu-origin-authorization"), null);
      return new Response("legacy");
    }) as typeof fetch;
    try {
      const application = createApp(deps(async () => deployedTarget({ fcEndpoint: endpoint })));
      const response = await application.request(`https://website-18e4ecad.${DOMAIN}/`, {
        headers: { "X-Teamclu-Origin-Authorization": "client-forgery" },
      });
      assert.equal(response.status, status);
      assert.equal(calls, status === 200 ? 1 : 0);
      if (status === 503) assert.doesNotMatch(await response.text(), /Bearer|eyJ|PRIVATE KEY/);
    } finally { globalThis.fetch = oldFetch; }
  }, { APPS_FC_ROUTE_DOMAIN: undefined, APPS_FC_ORIGIN_KEYRING: undefined }));
}
