import assert from "node:assert/strict";
import test from "node:test";
import {
  customDomainRecords,
  makeDomainToken,
  normalizeCustomDomain,
  verificationTxtName,
  verificationTxtValue,
  verifyDomainOwnership,
} from "../src/lib/apps-custom-domain.js";
import { domainToUnicode } from "node:url";
import { ApiError } from "../src/lib/http-utils.js";

const APP = { id: "11111111-2222-3333-4444-555555555555", slug: "report" };

const ENV = {
  APPS_PUBLIC_DOMAIN: "apps.example.com",
  APPS_FC_ROUTE_DOMAIN: "fc-apps.example.com",
  LOGIN_DOMAIN: "login.example.com",
  SUPABASE_PUBLIC_URL: "https://supabase.example.com",
  API_EXTERNAL_URL: "https://api.example.com",
} as NodeJS.ProcessEnv;

const rejects = (fn: () => unknown, status: number, match?: RegExp) => {
  assert.throws(fn, (e: unknown) => {
    if (!(e instanceof ApiError) || e.statusCode !== status) return false;
    return match ? match.test(String(e.message)) : true;
  });
};

// --- accepting a domain ------------------------------------------------------

test("an ordinary hostname is accepted and lower-cased", () => {
  assert.equal(normalizeCustomDomain("App.Example.COM", ENV), "app.example.com");
  assert.equal(normalizeCustomDomain("  app.example.com.  ", ENV), "app.example.com");
  assert.equal(normalizeCustomDomain("a.b.c.example.com", ENV), "a.b.c.example.com");
});

test("an internationalised name is stored in its ASCII form", () => {
  // DNS, the Host header and the certificate all carry punycode, so storing
  // the unicode spelling would mean converting on every single lookup.
  const stored = normalizeCustomDomain("应用.example.com", ENV);
  assert.match(stored, /^xn--[a-z0-9]+\.example\.com$/, stored);
  assert.equal(domainToUnicode(stored), "应用.example.com");
});

test("a URL is refused with an explanation, not a label error", () => {
  rejects(() => normalizeCustomDomain("https://app.example.com", ENV), 400, /hostname only/);
  rejects(() => normalizeCustomDomain("app.example.com/path", ENV), 400, /hostname only/);
  rejects(() => normalizeCustomDomain("app.example.com:8080", ENV), 400, /hostname only/);
});

test("addresses and unroutable names are refused", () => {
  rejects(() => normalizeCustomDomain("203.0.113.9", ENV), 400, /IP address/);
  rejects(() => normalizeCustomDomain("localhost", ENV), 400, /at least one dot/);
  rejects(() => normalizeCustomDomain("app.localhost", ENV), 400, /not a publicly routable/);
  rejects(() => normalizeCustomDomain("app.local", ENV), 400, /not a publicly routable/);
  rejects(() => normalizeCustomDomain("app.internal", ENV), 400, /not a publicly routable/);
  rejects(() => normalizeCustomDomain("example", ENV), 400, /at least one dot/);
  rejects(() => normalizeCustomDomain("", ENV), 400, /required/);
  rejects(() => normalizeCustomDomain(42, ENV), 400, /string/);
});

test("a label longer than DNS allows is refused", () => {
  rejects(() => normalizeCustomDomain(`${"a".repeat(64)}.example.com`, ENV), 400, /invalid label/);
  normalizeCustomDomain(`${"a".repeat(63)}.example.com`, ENV);
});

// --- the reservation, which is the security-relevant half --------------------

test("this deployment's own hostnames cannot be bound", () => {
  // Without this, binding api.<our domain> would have the certificate gate
  // mint a certificate for our own API's name.
  for (const domain of [
    "apps.example.com",
    "anything.apps.example.com",
    "fc-apps.example.com",
    "login.example.com",
    "supabase.example.com",
    "api.example.com",
  ]) {
    rejects(() => normalizeCustomDomain(domain, ENV), 409, /belongs to this deployment/);
  }
});

test("the reserved list can be extended for names this process cannot see", () => {
  // Studio and EMQX hostnames live only in Caddy's environment.
  const env = { ...ENV, APPS_RESERVED_DOMAINS: "studio.example.com, emqx.example.com" };
  rejects(() => normalizeCustomDomain("studio.example.com", env), 409);
  rejects(() => normalizeCustomDomain("sub.emqx.example.com", env), 409);
  // ...and does not accidentally reserve a lookalike.
  assert.equal(normalizeCustomDomain("emqx.example.org", env), "emqx.example.org");
});

test("a name that merely resembles a reserved one is fine", () => {
  assert.equal(normalizeCustomDomain("notapps.example.com", ENV), "notapps.example.com");
  assert.equal(normalizeCustomDomain("apps.example.com.evil.net", ENV), "apps.example.com.evil.net");
});

// --- the records to publish --------------------------------------------------

test("the records point the domain at the vanity host and carry the proof", () => {
  const records = customDomainRecords(APP, "app.example.com", "tok-123", ENV);
  assert.deepEqual(records, [
    // A CNAME, not an A record: the box's address can change, the vanity name
    // is already what the gate and the proxy recognise.
    { type: "CNAME", name: "app.example.com", value: "report-11111111.apps.example.com" },
    { type: "TXT", name: "_teamclu.app.example.com", value: "teamclu-verify=tok-123" },
  ]);
});

test("with no apps domain the records fall back to the FC route host", () => {
  const env = { ...ENV, APPS_PUBLIC_DOMAIN: "" };
  const records = customDomainRecords(APP, "app.example.com", "t", env);
  assert.equal(records[0].value, "report-11111111.fc-apps.example.com");
});

test("tokens are long and distinct", () => {
  const a = makeDomainToken();
  const b = makeDomainToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32, a);
  assert.doesNotMatch(a, /[^A-Za-z0-9_-]/, "must be safe in a TXT record");
});

// --- proving ownership -------------------------------------------------------

const resolverFor = (records: string[][]) => async () => records;

test("a matching TXT record proves ownership", async () => {
  const value = verificationTxtValue("tok-123");
  assert.equal(await verifyDomainOwnership("app.example.com", "tok-123", resolverFor([[value]])), true);
});

test("a TXT value split into chunks is joined before comparison", async () => {
  // Anything over 255 bytes arrives split, and DNS providers may split
  // shorter values too.
  const value = verificationTxtValue("tok-123");
  const chunks = [value.slice(0, 5), value.slice(5)];
  assert.equal(await verifyDomainOwnership("app.example.com", "tok-123", resolverFor([chunks])), true);
});

test("the proof is looked up under the _teamclu label", async () => {
  let asked = "";
  await verifyDomainOwnership("app.example.com", "t", async (name) => {
    asked = name;
    return [];
  });
  assert.equal(asked, "_teamclu.app.example.com");
  assert.equal(verificationTxtName("app.example.com"), "_teamclu.app.example.com");
});

test("a different or absent token does not prove anything", async () => {
  assert.equal(
    await verifyDomainOwnership("app.example.com", "tok-123", resolverFor([["teamclu-verify=other"]])),
    false,
  );
  assert.equal(await verifyDomainOwnership("app.example.com", "tok-123", resolverFor([])), false);
  assert.equal(await verifyDomainOwnership("app.example.com", "", resolverFor([["x"]])), false);
});

test("a resolver that throws is 'not proven', not an error", async () => {
  // NXDOMAIN before propagation is the common case; turning it into a 500
  // would blame us for the owner's DNS not having caught up.
  const boom = async () => {
    throw Object.assign(new Error("queryTxt ENOTFOUND"), { code: "ENOTFOUND" });
  };
  assert.equal(await verifyDomainOwnership("app.example.com", "t", boom), false);
});

test("a hanging resolver does not hang the request", async () => {
  const never = () => new Promise<string[][]>(() => {});
  const started = Date.now();
  assert.equal(await verifyDomainOwnership("app.example.com", "t", never, 30), false);
  assert.ok(Date.now() - started < 2000, "must give up on its own");
});
