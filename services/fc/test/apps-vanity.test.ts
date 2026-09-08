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
import { createApp } from "../src/app.js";
import { appPublicUrl, appPublicLabel, parseAppPublicHost } from "../src/lib/apps-public-host.js";
import {
  isServable, proxyToApp, selectByIdPrefix, makeSupabaseVanityLookup, makeVanityLookup,
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

test("ask says no for hosts that are not apps, without touching the database", async () => {
  let called = 0;
  const app = createApp(deps(async () => { called++; return null; }));
  await withDomain(async () => {
    const res = await app.request("/internal/caddy/ask?domain=evil.example.com");
    assert.equal(res.status, 404);
  });
  assert.equal(called, 0, "a non-app hostname must be rejected on shape alone");
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

test("an ambiguous id prefix serves neither app", () => {
  const rows = [
    { id: "18e4ecad-1111", slug: "website", fcEndpoint: "https://a", fcStatus: "live" },
    { id: "18e4ecad-2222", slug: "website", fcEndpoint: "https://b", fcStatus: "live" },
  ];
  assert.equal(selectByIdPrefix(rows, "18e4ecad"), null, "a coin flip between teams is not an answer");
  assert.equal(selectByIdPrefix(rows, "18e4ecad-1"), rows[0]);
  assert.equal(selectByIdPrefix(rows, "deadbeef"), null);
});

test("isServable requires a live status AND an endpoint", () => {
  assert.equal(isServable(null), false);
  assert.equal(isServable({ id: "1", slug: "s", fcStatus: "live", fcEndpoint: null }), false);
  assert.equal(isServable({ id: "1", slug: "s", fcStatus: "deploy_error", fcEndpoint: "https://x" }), false);
  assert.equal(isServable({ id: "1", slug: "s", fcStatus: "live", fcEndpoint: "https://x" }), true);
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

test("the client is not built for a non-app host", async () => {
  // Building eagerly would make every request that merely passes through pay
  // for — and potentially fail on — a client that host will never use.
  let srBuilt = 0;
  const lookup = makeVanityLookup({
    getServiceRoleClient: () => {
      srBuilt++;
      return { from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) };
    },
  });

  await withDomain(async () => {
    assert.equal(await lookup("api.teamclu-dev.ucar.cc"), null);
    assert.equal(srBuilt, 0, "a non-app host must not build any client");

    assert.equal(await lookup(`ghost-18e4ecad.${DOMAIN}`), null);
    assert.equal(srBuilt, 1, "an app host builds the service-role client");
  });
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
