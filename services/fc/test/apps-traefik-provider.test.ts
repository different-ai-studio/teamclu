/**
 * Traefik's HTTP provider for verified custom domains (belayo). Traefik keeps
 * its last configuration when a poll fails and never retries a failed
 * certificate request on its own, so the contract pinned here is mostly about
 * what this endpoint must NOT do: answer an outage with an empty 200, publish a
 * domain whose DNS cannot pass a challenge yet, or drop a live one on a DNS blip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import {
  TRAEFIK_APPS_SERVICE,
  TRAEFIK_CERT_RESOLVER,
  TRAEFIK_HTTPS_REDIRECT,
  bearerMatches,
  buildTraefikDynamicConfig,
  makeSupabaseTraefikDomainLookup,
  makeTraefikDynamicEndpoint,
  pointsAtIngress,
  type DnsResolver,
} from "../src/lib/apps-traefik-provider.js";

const TOKEN = "t0ken-for-tests";
const ENV = { APPS_TRAEFIK_PROVIDER_TOKEN: TOKEN } as NodeJS.ProcessEnv;
const AUTH = `Bearer ${TOKEN}`;
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 16, 13, 30);

const HIRE = { domain: "hire.climban.com", vanityHost: "banana-hire2-2e80b091.apps.mx5.cn" };
const SHOP = { domain: "shop.example.org", vanityHost: "shop-12345678.apps.mx5.cn" };

/** DNS where each name maps to fixed answers; anything else fails like NXDOMAIN. */
function fakeDns(cnames: Record<string, string[]>, a: Record<string, string[]>): DnsResolver {
  const answer = (table: Record<string, string[]>) => async (name: string) => {
    if (table[name]) return table[name];
    throw Object.assign(new Error(`queryA ENOTFOUND ${name}`), { code: "ENOTFOUND" });
  };
  return { resolveCname: answer(cnames), resolve4: answer(a) };
}

type Router = { rule: string; entryPoints: string[]; service: string; middlewares?: string[]; tls?: { certResolver: string } };
const routersOf = (body: any): Record<string, Router> => body.http.routers;

// --- the configuration itself ---------------------------------------------

test("each domain gets an http redirect router and an https router with a certificate", () => {
  const routers = routersOf(buildTraefikDynamicConfig([HIRE.domain], T0));
  const entries = Object.entries(routers);
  assert.equal(entries.length, 2);
  const web = entries.find(([, r]) => r.entryPoints[0] === "web")![1];
  const secure = entries.find(([, r]) => r.entryPoints[0] === "websecure")![1];
  for (const r of [web, secure]) {
    assert.equal(r.rule, "Host(`hire.climban.com`)");
    assert.equal(r.service, TRAEFIK_APPS_SERVICE);
  }
  assert.deepEqual(web.middlewares, [TRAEFIK_HTTPS_REDIRECT]);
  assert.equal(web.tls, undefined);
  assert.deepEqual(secure.tls, { certResolver: TRAEFIK_CERT_RESOLVER });
});

test("no domains is an empty but valid configuration", () => {
  assert.deepEqual(buildTraefikDynamicConfig([], T0), { http: { routers: {} } });
});

test("router names change on the hour and only then, so a failed issuance is retried hourly", () => {
  const names = (now: number) => Object.keys(routersOf(buildTraefikDynamicConfig([HIRE.domain], now)));
  assert.deepEqual(names(T0), names(T0 + 20 * 60 * 1000), "same hour, same body — Traefik dedupes it");
  assert.notDeepEqual(names(T0), names(T0 + HOUR), "next hour, new names — Traefik re-reads the routers");
});

test("the body is stable regardless of input order, and duplicates collapse", () => {
  const a = JSON.stringify(buildTraefikDynamicConfig([SHOP.domain, HIRE.domain], T0));
  const b = JSON.stringify(buildTraefikDynamicConfig([HIRE.domain, SHOP.domain, HIRE.domain], T0));
  assert.equal(a, b);
});

test("names that flatten to the same characters still get distinct routers", () => {
  const routers = routersOf(buildTraefikDynamicConfig(["a-b.example.com", "a.b.example.com"], T0));
  assert.equal(Object.keys(routers).length, 4);
});

test("a value that is not a plain hostname never reaches a Traefik rule", () => {
  const routers = routersOf(buildTraefikDynamicConfig(["evil.com`) || Host(`other.com", "UPPER.example.com"], T0));
  assert.deepEqual(routers, {});
});

// --- DNS readiness -----------------------------------------------------------

test("a CNAME straight to the vanity host counts as ready", async () => {
  const dns = fakeDns({ [HIRE.domain]: [HIRE.vanityHost + "."] }, {});
  assert.equal(await pointsAtIngress(HIRE.domain, HIRE.vanityHost, dns), true);
});

test("an A record shared with the vanity host counts as ready", async () => {
  const dns = fakeDns({}, { [SHOP.domain]: ["47.107.171.43"], [SHOP.vanityHost]: ["47.107.171.43"] });
  assert.equal(await pointsAtIngress(SHOP.domain, SHOP.vanityHost, dns), true);
});

test("DNS pointing elsewhere, or not resolving, is not ready", async () => {
  const elsewhere = fakeDns({}, { [SHOP.domain]: ["1.2.3.4"], [SHOP.vanityHost]: ["47.107.171.43"] });
  assert.equal(await pointsAtIngress(SHOP.domain, SHOP.vanityHost, elsewhere), false);
  assert.equal(await pointsAtIngress(SHOP.domain, SHOP.vanityHost, fakeDns({}, {})), false);
});

// --- the endpoint ------------------------------------------------------------

test("the endpoint does not exist where no token is configured", async () => {
  const serve = makeTraefikDynamicEndpoint({ listDomains: async () => [HIRE] });
  const res = await serve(AUTH, {} as NodeJS.ProcessEnv);
  assert.equal(res.status, 404);
});

test("a missing or wrong bearer token is refused before the database is asked", async () => {
  let asked = 0;
  const serve = makeTraefikDynamicEndpoint({ listDomains: async () => { asked++; return [HIRE]; } });
  assert.equal((await serve(undefined, ENV)).status, 401);
  assert.equal((await serve("Bearer nope", ENV)).status, 401);
  assert.equal((await serve(TOKEN, ENV)).status, 401, "the scheme is part of the header");
  assert.equal(asked, 0);
  assert.equal(bearerMatches(AUTH, TOKEN), true);
});

test("a database failure is a 503, never an empty 200 that would unpublish every domain", async () => {
  const serve = makeTraefikDynamicEndpoint({ listDomains: async () => { throw new Error("db down"); } });
  const res = await serve(AUTH, ENV);
  assert.equal(res.status, 503);
  assert.equal((res.body as any).http, undefined);
});

test("only domains whose DNS already reaches the ingress are published", async () => {
  const dns = fakeDns({ [HIRE.domain]: [HIRE.vanityHost] }, { [SHOP.vanityHost]: ["47.107.171.43"] });
  const serve = makeTraefikDynamicEndpoint({ listDomains: async () => [HIRE, SHOP], resolver: dns, now: () => T0 });
  const res = await serve(AUTH, ENV);
  assert.equal(res.status, 200);
  const rules = new Set(Object.values(routersOf(res.body)).map((r) => r.rule));
  assert.deepEqual([...rules], ["Host(`hire.climban.com`)"]);
});

test("a published domain survives a DNS blip, and leaves once it is no longer verified", async () => {
  let now = T0;
  let dnsWorks = true;
  let rows = [HIRE];
  const resolver: DnsResolver = {
    resolveCname: async (name) => {
      if (!dnsWorks) throw new Error("SERVFAIL");
      return name === HIRE.domain ? [HIRE.vanityHost] : [];
    },
    resolve4: async () => { throw new Error("SERVFAIL"); },
  };
  const serve = makeTraefikDynamicEndpoint({ listDomains: async () => rows, resolver, now: () => now, cacheMs: 1000 });
  const count = async () => Object.keys(routersOf((await serve(AUTH, ENV)).body)).length;

  assert.equal(await count(), 2, "published while DNS answers");
  dnsWorks = false;
  now += 2000;
  assert.equal(await count(), 2, "still published when a later lookup fails");
  rows = [];
  now += 2000;
  assert.equal(await count(), 0, "gone once the domain is unbound or unverified");
});

test("polls inside the cache window do not hit the database again", async () => {
  let asked = 0;
  let now = T0;
  const dns = fakeDns({ [HIRE.domain]: [HIRE.vanityHost] }, {});
  const serve = makeTraefikDynamicEndpoint({
    listDomains: async () => { asked++; return [HIRE]; },
    resolver: dns, now: () => now, cacheMs: 30_000,
  });
  await serve(AUTH, ENV);
  now += 10_000;
  await serve(AUTH, ENV);
  assert.equal(asked, 1);
  now += 30_000;
  await serve(AUTH, ENV);
  assert.equal(asked, 2);
});

// --- the database lookup -------------------------------------------------------

test("the lookup reads verified custom domains and derives each app's vanity host", async () => {
  const calls: any[] = [];
  const rows = [
    { id: "2e80b091-13e8-465f-8d44-1e5171c9169b", slug: "banana-hire2", custom_domain: "Hire.Climban.com", custom_domain_verified_at: "2026-09-10T10:43:48Z" },
    { id: "12345678-0000-0000-0000-000000000000", slug: "shop", custom_domain: "shop.example.org", custom_domain_verified_at: null },
  ];
  const q: any = {
    select(cols: string) { calls.push(["select", cols]); return q; },
    not(col: string, op: string, val: unknown) { calls.push(["not", col, op, val]); return q; },
    then(resolve: (v: unknown) => unknown) { return Promise.resolve({ data: rows, error: null }).then(resolve); },
  };
  const client = { from(table: string) { calls.push(["from", table]); return q; } };
  const lookup = makeSupabaseTraefikDomainLookup(() => client, { APPS_PUBLIC_DOMAIN: "apps.mx5.cn" } as NodeJS.ProcessEnv);
  assert.deepEqual(await lookup(), [{ domain: "hire.climban.com", vanityHost: "banana-hire2-2e80b091.apps.mx5.cn" }]);
  assert.deepEqual(calls.find((c) => c[0] === "from"), ["from", "apps"]);
  assert.ok(calls.some((c) => c[0] === "not" && c[1] === "custom_domain_verified_at" && c[2] === "is" && c[3] === null));
});

test("a lookup error propagates instead of reading as no domains", async () => {
  const q: any = {
    select() { return q; },
    not() { return q; },
    then(resolve: (v: unknown) => unknown) { return Promise.resolve({ data: null, error: { message: "boom" } }).then(resolve); },
  };
  const lookup = makeSupabaseTraefikDomainLookup(() => ({ from: () => q }), { APPS_PUBLIC_DOMAIN: "apps.mx5.cn" } as NodeJS.ProcessEnv);
  await assert.rejects(() => lookup(), /traefik custom domain lookup failed: boom/);
});

// --- wired into the app --------------------------------------------------------

test("the app serves the endpoint only when the lookup is wired, and honours the token", async () => {
  const base = { createRepository: () => ({}), createAuthRepository: () => ({}) } as any;
  const prev = process.env.APPS_TRAEFIK_PROVIDER_TOKEN;
  process.env.APPS_TRAEFIK_PROVIDER_TOKEN = TOKEN;
  try {
    const bare = createApp(base);
    assert.equal((await bare.request("/internal/traefik/dynamic", { headers: { authorization: AUTH } })).status, 404);

    const app = createApp({ ...base, listTraefikCustomDomains: async () => [] });
    assert.equal((await app.request("/internal/traefik/dynamic")).status, 401);
    const ok = await app.request("/internal/traefik/dynamic", { headers: { authorization: AUTH } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { http: { routers: {} } });
  } finally {
    if (prev === undefined) delete process.env.APPS_TRAEFIK_PROVIDER_TOKEN;
    else process.env.APPS_TRAEFIK_PROVIDER_TOKEN = prev;
  }
});
