import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import {
  decryptWecomMessage,
  encryptWecomMessage,
  openWecomCallback,
  wecomSignature,
  xmlField,
} from "../src/lib/sso/wecom-crypto.js";
import { createWecomClient } from "../src/lib/sso/wecom-client.js";
import {
  createSsoService,
  isAllowedClientRedirect,
  sha256Base64Url,
  SsoTenantNotBoundError,
  type SsoBinding,
  type SsoFlow,
  type SsoStore,
} from "../src/lib/sso/sso-service.js";
import { readWecomSsoConfig } from "../src/lib/sso/from-env.js";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { ApiError } from "../src/lib/http-utils.js";

const AES_KEY = crypto.randomBytes(32).toString("base64").slice(0, 43);
const CB = { token: "cbtoken", encodingAesKey: AES_KEY };
const SUITE = { suiteId: "wwsuite", suiteSecret: "suitesecret" };

// ── crypto ────────────────────────────────────────────────────────────────

test("WeCom crypto round-trips and checks signature + receiveId", () => {
  const enc = encryptWecomMessage(CB, "<xml><A>1</A></xml>", "wwsuite");
  assert.deepEqual(decryptWecomMessage(CB, enc), { message: "<xml><A>1</A></xml>", receiveId: "wwsuite" });
  const signature = wecomSignature(CB.token, "123", "n", enc);
  assert.equal(openWecomCallback(CB, { signature, timestamp: "123", nonce: "n", encrypt: enc }, ["wwsuite"]), "<xml><A>1</A></xml>");
  assert.throws(() => openWecomCallback(CB, { signature: "0".repeat(40), timestamp: "123", nonce: "n", encrypt: enc }, ["wwsuite"]), /signature/);
  assert.throws(() => openWecomCallback(CB, { signature, timestamp: "123", nonce: "n", encrypt: enc }, ["other"]), /receiveId/);
});

test("signature is sha1 over the sorted parts", () => {
  const expected = crypto.createHash("sha1").update(["b", "a", "d", "c"].sort().join("")).digest("hex");
  assert.equal(wecomSignature("b", "a", "d", "c"), expected);
});

test("xmlField reads CDATA and plain values", () => {
  const xml = "<xml><SuiteId><![CDATA[wwsuite]]></SuiteId><TimeStamp>1403610513</TimeStamp></xml>";
  assert.equal(xmlField(xml, "SuiteId"), "wwsuite");
  assert.equal(xmlField(xml, "TimeStamp"), "1403610513");
  assert.equal(xmlField(xml, "Missing"), null);
});

// ── redirect allowlist ────────────────────────────────────────────────────

test("client redirect must be loopback or an app scheme", () => {
  assert.ok(isAllowedClientRedirect("http://127.0.0.1:54321/callback"));
  assert.ok(isAllowedClientRedirect("http://localhost:1/cb"));
  assert.ok(isAllowedClientRedirect("teamclu://auth-callback"));
  assert.ok(isAllowedClientRedirect("teamclu-betly://auth-callback"));
  assert.ok(isAllowedClientRedirect("copilot://x", ["copilot"]));
  assert.ok(!isAllowedClientRedirect("https://evil.example/cb"));
  assert.ok(!isAllowedClientRedirect("http://127.0.0.1.evil.example/cb"));
  assert.ok(!isAllowedClientRedirect("http://user:pw@127.0.0.1/cb"));
  assert.ok(!isAllowedClientRedirect("javascript:alert(1)"));
  assert.ok(!isAllowedClientRedirect("not a url"));
});

// ── env ───────────────────────────────────────────────────────────────────

test("readWecomSsoConfig: off when unset, off when half-set, on when complete", () => {
  assert.equal(readWecomSsoConfig({}), null);
  assert.equal(readWecomSsoConfig({ WECOM_SUITE_ID: "s" }), null);
  const cfg = readWecomSsoConfig({
    WECOM_SUITE_ID: "s", WECOM_SUITE_SECRET: "x", WECOM_CALLBACK_TOKEN: "t", WECOM_CALLBACK_AES_KEY: AES_KEY,
    WECOM_INSTALL_TEST_MODE: "1",
  });
  assert.equal(cfg?.suite.suiteId, "s");
  assert.equal(cfg?.loginSuite, undefined);
  assert.equal(cfg?.installTestMode, true);
});

// ── service with an in-memory store ───────────────────────────────────────

function memoryStore(opts: { managerOrg?: string | null } = {}) {
  const flows = new Map<string, SsoFlow & { codeHash?: string }>();
  const bindings = new Map<string, SsoBinding & { permanentCode: string | null }>();
  const identities = new Map<string, string>();
  const tickets = new Map<string, string>();
  const minted: string[] = [];
  const store: SsoStore = {
    async saveSuiteTicket(p, s, t) { tickets.set(`${p}:${s}`, t); },
    async loadSuiteTicket(p, s) { return tickets.get(`${p}:${s}`) ?? null; },
    async createFlow(f) { flows.set(f.state, { ...f, userId: null, consumedAt: null }); },
    async getFlow(s) { return flows.get(s) ?? null; },
    async completeLoginFlow(s, { userId, codeHash, expiresAt }) {
      const f = flows.get(s);
      if (!f || f.userId || f.consumedAt) return false;
      Object.assign(f, { userId, codeHash, expiresAt });
      return true;
    },
    async consumeLoginCode(h) {
      for (const f of flows.values()) {
        if (f.codeHash === h && !f.consumedAt) { f.consumedAt = new Date().toISOString(); return f; }
      }
      return null;
    },
    async consumeInstallFlow(s) {
      const f = flows.get(s);
      if (!f || f.kind !== "install" || f.consumedAt) return null;
      f.consumedAt = new Date().toISOString();
      return f;
    },
    async sweepExpiredFlows() {},
    async ensureIdentity({ provider, tenantId, subject }) {
      const b = bindings.get(`${provider}:${tenantId}`);
      if (!b) throw new SsoTenantNotBoundError("not bound");
      const k = `${provider}:${tenantId}:${subject}:${b.orgId}`;
      if (!identities.has(k)) identities.set(k, `user-${identities.size + 1}`);
      return identities.get(k)!;
    },
    async mintSession(userId) { minted.push(userId); return `rt-${userId}`; },
    async bindingForOrg(p, orgId) {
      for (const b of bindings.values()) if (b.provider === p && b.orgId === orgId) return b;
      return null;
    },
    async bindingForTenant(p, t) { return bindings.get(`${p}:${t}`) ?? null; },
    async saveBinding(b) {
      bindings.set(`${b.provider}:${b.tenantId}`, { ...b, createdAt: "2026-11-26T00:00:00Z" });
    },
    async deleteBinding(p, t) { bindings.delete(`${p}:${t}`); },
    async resolveOrgManager(token, _teamId) {
      if (token !== "admin-token" || opts.managerOrg === null) throw new ApiError(403, "forbidden", "no");
      return { userId: "admin-user", orgId: opts.managerOrg ?? "org-1" };
    },
  };
  return { store, flows, bindings, identities, tickets, minted };
}

function fakeWecomFetch(calls: string[] = []) {
  return async (url: any, init?: any) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.pathname.endsWith("/service/get_suite_token")) {
      const body = JSON.parse(init.body);
      assert.equal(body.suite_ticket, "TICKET");
      return json({ errcode: 0, suite_access_token: "SAT", expires_in: 7200 });
    }
    if (u.pathname.endsWith("/service/auth/getuserinfo3rd")) {
      assert.equal(u.searchParams.get("suite_access_token"), "SAT");
      const code = u.searchParams.get("code");
      if (code === "outsider") return json({ errcode: 0, openid: "o1" });
      if (code === "bad") return json({ errcode: 40029, errmsg: "invalid code" });
      return json({ errcode: 0, corpid: code === "other-corp" ? "wwOther" : "wwCorp", userid: "enc", open_userid: "open-1" });
    }
    if (u.pathname.endsWith("/service/get_pre_auth_code")) return json({ errcode: 0, pre_auth_code: "PRE", expires_in: 1200 });
    if (u.pathname.endsWith("/service/set_session_info")) return json({ errcode: 0 });
    if (u.pathname.endsWith("/service/get_permanent_code")) {
      return json({ errcode: 0, permanent_code: "PERM", auth_corp_info: { corpid: "wwCorp", corp_name: "示例公司" }, auth_user_info: { open_userid: "admin-open" } });
    }
    return new Response("{}", { status: 404 });
  };
}

function service(mem = memoryStore(), calls: string[] = []) {
  mem.tickets.set("wecom:wwsuite", "TICKET");
  let n = 0;
  const svc = createSsoService({
    store: mem.store,
    wecom: {
      config: { suite: SUITE, callback: CB, redirectBaseUrl: "https://api.example.test", installTestMode: true },
      client: createWecomClient({ fetchImpl: fakeWecomFetch(calls) as any, loadSuiteTicket: (s) => mem.store.loadSuiteTicket("wecom", s) }),
    },
    refreshSession: async (rt) => ({ access_token: `at-for-${rt}`, refresh_token: "rt2", user: { id: "u" } }),
    randomToken: () => `tok${++n}`.padEnd(12, "x"),
  });
  return { svc, mem, calls };
}

const VERIFIER = "v".repeat(50);
const CHALLENGE = sha256Base64Url(VERIFIER);

async function startLogin(svc: ReturnType<typeof service>["svc"]) {
  const url = new URL(await svc.loginAuthorizeUrl({
    provider: "wecom", redirect: "http://127.0.0.1:5000/callback", codeChallenge: CHALLENGE, requestOrigin: null,
  }));
  return url;
}

test("authorize builds the WeCom ServiceApp QR URL and stores a login flow", async () => {
  const { svc, mem } = service();
  const url = await startLogin(svc);
  assert.equal(url.origin + url.pathname, "https://login.work.weixin.qq.com/wwlogin/sso/login");
  assert.equal(url.searchParams.get("login_type"), "ServiceApp");
  assert.equal(url.searchParams.get("appid"), "wwsuite");
  assert.equal(url.searchParams.get("redirect_uri"), "https://api.example.test/v1/auth/sso/wecom/callback");
  const state = url.searchParams.get("state")!;
  assert.equal(mem.flows.get(state)?.kind, "login");
});

test("authorize rejects a remote redirect and a non-S256 challenge", async () => {
  const { svc } = service();
  await assert.rejects(svc.loginAuthorizeUrl({ provider: "wecom", redirect: "https://evil.test/cb", codeChallenge: CHALLENGE, requestOrigin: null }), /loopback/);
  await assert.rejects(svc.loginAuthorizeUrl({ provider: "wecom", redirect: "teamclu://cb", codeChallenge: "short", requestOrigin: null }), /S256/);
  await assert.rejects(svc.loginAuthorizeUrl({ provider: "dingtalk", redirect: "teamclu://cb", codeChallenge: CHALLENGE, requestOrigin: null }), /unknown sign-in provider/);
});

test("full login: scan → code on the loopback → exchange with the verifier → session", async () => {
  const { svc, mem } = service();
  mem.bindings.set("wecom:wwCorp", { provider: "wecom", tenantId: "wwCorp", orgId: "org-1", tenantName: null, createdAt: "", permanentCode: null });
  const state = (await startLogin(svc)).searchParams.get("state")!;
  const out = await svc.handleLoginCallback({ provider: "wecom", code: "scan-code", state });
  assert.ok("redirect" in out);
  const back = new URL(out.redirect);
  assert.equal(back.origin + back.pathname, "http://127.0.0.1:5000/callback");
  const code = back.searchParams.get("code")!;
  assert.ok(code);

  await assert.rejects(svc.exchange({ code: "wrong", codeVerifier: VERIFIER }), /invalid or expired/);
  const session = await svc.exchange({ code, codeVerifier: VERIFIER });
  assert.equal(session.access_token, "at-for-rt-user-1");
  assert.deepEqual(mem.minted, ["user-1"]);
  // One-time.
  await assert.rejects(svc.exchange({ code, codeVerifier: VERIFIER }), /invalid or expired/);
  // The flow cannot be replayed with another scan either.
  const again = await svc.handleLoginCallback({ provider: "wecom", code: "scan-code", state });
  assert.ok("html" in again && again.status === 400);
});

test("a wrong verifier burns the code", async () => {
  const { svc, mem } = service();
  mem.bindings.set("wecom:wwCorp", { provider: "wecom", tenantId: "wwCorp", orgId: "org-1", tenantName: null, createdAt: "", permanentCode: null });
  const state = (await startLogin(svc)).searchParams.get("state")!;
  const out = await svc.handleLoginCallback({ provider: "wecom", code: "scan-code", state });
  const code = new URL((out as any).redirect).searchParams.get("code")!;
  await assert.rejects(svc.exchange({ code, codeVerifier: "x".repeat(50) }), /verifier/);
  await assert.rejects(svc.exchange({ code, codeVerifier: VERIFIER }), /invalid or expired/);
  assert.deepEqual(mem.minted, []);
});

test("login callback errors go back to the client as error_description", async () => {
  const { svc } = service();
  const cases: Array<[string | null, string]> = [
    ["other-corp", "org_not_connected"],
    ["outsider", "access_denied"],
    ["bad", "server_error"],
    [null, "access_denied"],
  ];
  for (const [code, error] of cases) {
    const state = (await startLogin(svc)).searchParams.get("state")!;
    const out = await svc.handleLoginCallback({ provider: "wecom", code, state });
    assert.ok("redirect" in out, `${code} should redirect`);
    const u = new URL(out.redirect);
    assert.equal(u.searchParams.get("error"), error, `${code}`);
    assert.ok(u.searchParams.get("error_description"));
    assert.equal(u.searchParams.get("code"), null);
  }
});

test("an unknown state gets a result page, never a redirect", async () => {
  const { svc } = service();
  const out = await svc.handleLoginCallback({ provider: "wecom", code: "scan-code", state: "nope" });
  assert.ok("html" in out);
  assert.equal(out.status, 400);
});

test("install: org admin gets the WeCom install URL; callback binds the corp to the org", async () => {
  const calls: string[] = [];
  const { svc, mem } = service(memoryStore(), calls);
  await assert.rejects(svc.installUrl({ provider: "wecom", accessToken: "member-token", teamId: "t1", requestOrigin: null }), /forbidden|no/);
  const { url } = await svc.installUrl({ provider: "wecom", accessToken: "admin-token", teamId: "t1", requestOrigin: null });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://open.work.weixin.qq.com/3rdapp/install");
  assert.equal(u.searchParams.get("suite_id"), "wwsuite");
  assert.equal(u.searchParams.get("pre_auth_code"), "PRE");
  assert.equal(u.searchParams.get("redirect_uri"), "https://api.example.test/v1/auth/sso/wecom/install-callback");
  assert.ok(calls.some((c) => c.endsWith("/set_session_info")), "test mode marks the install as a test authorization");

  const state = u.searchParams.get("state")!;
  const res = await svc.handleInstallCallback({ provider: "wecom", authCode: "AUTH", state });
  assert.equal(res.status, 200);
  assert.match(res.html, /示例公司/);
  const b = mem.bindings.get("wecom:wwCorp");
  assert.equal(b?.orgId, "org-1");
  assert.equal(b?.permanentCode, "PERM");
  assert.equal((b as any)?.boundBy, "admin-user");

  // The install link is one-time.
  const replay = await svc.handleInstallCallback({ provider: "wecom", authCode: "AUTH", state });
  assert.equal(replay.status, 400);

  const status = await svc.binding({ provider: "wecom", accessToken: "admin-token", teamId: "t1" });
  assert.equal(status.binding?.tenantId, "wwCorp");
  // Already bound: a second install is refused until it is disconnected.
  await assert.rejects(svc.installUrl({ provider: "wecom", accessToken: "admin-token", teamId: "t1", requestOrigin: null }), /already connected/);
  assert.deepEqual(await svc.unbind({ provider: "wecom", accessToken: "admin-token", teamId: "t1" }), { removed: true });
  assert.equal(mem.bindings.size, 0);
});

test("install refuses to move a corp that another org already holds", async () => {
  const mem = memoryStore({ managerOrg: "org-2" });
  mem.bindings.set("wecom:wwCorp", { provider: "wecom", tenantId: "wwCorp", orgId: "org-1", tenantName: "示例公司", createdAt: "", permanentCode: null });
  const { svc } = service(mem);
  const { url } = await svc.installUrl({ provider: "wecom", accessToken: "admin-token", teamId: "t2", requestOrigin: null });
  const res = await svc.handleInstallCallback({ provider: "wecom", authCode: "AUTH", state: new URL(url).searchParams.get("state")! });
  assert.equal(res.status, 409);
  assert.equal(mem.bindings.get("wecom:wwCorp")?.orgId, "org-1");
});

function signedCallback(xml: string, receiveId = "wwsuite") {
  const encrypt = encryptWecomMessage(CB, xml, receiveId);
  const q = new URLSearchParams({ timestamp: "1", nonce: "n", msg_signature: wecomSignature(CB.token, "1", "n", encrypt) });
  return { query: q, body: `<xml><ToUserName><![CDATA[wwsuite]]></ToUserName><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`, encrypt };
}

test("suite callback: URL verification echoes the decrypted echostr", async () => {
  const { svc } = service();
  const echostr = encryptWecomMessage(CB, "12345", "wwsuite");
  const q = new URLSearchParams({ timestamp: "1", nonce: "n", echostr, msg_signature: wecomSignature(CB.token, "1", "n", echostr) });
  assert.deepEqual(await svc.handleSuiteCallback({ method: "GET", query: q, body: "" }), { status: 200, text: "12345" });
  q.set("msg_signature", "f".repeat(40));
  assert.equal((await svc.handleSuiteCallback({ method: "GET", query: q, body: "" })).status, 403);
});

test("suite callback: suite_ticket is stored, cancel_auth unbinds", async () => {
  const { svc, mem } = service();
  const t = signedCallback("<xml><SuiteId><![CDATA[wwsuite]]></SuiteId><InfoType><![CDATA[suite_ticket]]></InfoType><SuiteTicket><![CDATA[NEWTICKET]]></SuiteTicket></xml>");
  assert.deepEqual(await svc.handleSuiteCallback({ method: "POST", query: t.query, body: t.body }), { status: 200, text: "success" });
  assert.equal(mem.tickets.get("wecom:wwsuite"), "NEWTICKET");

  mem.bindings.set("wecom:wwCorp", { provider: "wecom", tenantId: "wwCorp", orgId: "org-1", tenantName: null, createdAt: "", permanentCode: null });
  const c = signedCallback("<xml><SuiteId>wwsuite</SuiteId><InfoType>cancel_auth</InfoType><AuthCorpId>wwCorp</AuthCorpId></xml>");
  await svc.handleSuiteCallback({ method: "POST", query: c.query, body: c.body });
  assert.equal(mem.bindings.size, 0);

  // A ticket for a suite we do not run is ignored even when well signed.
  const foreign = signedCallback("<xml><SuiteId>wwother</SuiteId><InfoType>suite_ticket</InfoType><SuiteTicket>X</SuiteTicket></xml>");
  await svc.handleSuiteCallback({ method: "POST", query: foreign.query, body: foreign.body });
  assert.equal(mem.tickets.has("wecom:wwother"), false);
});

test("no suite_ticket yet → 503 naming the callback", async () => {
  const mem = memoryStore();
  const svc = createSsoService({
    store: mem.store,
    wecom: { config: { suite: SUITE, callback: CB }, client: createWecomClient({ fetchImpl: fakeWecomFetch() as any, loadSuiteTicket: async () => null }) },
    refreshSession: async () => ({}),
  });
  await assert.rejects(
    svc.installUrl({ provider: "wecom", accessToken: "admin-token", teamId: "t", requestOrigin: "https://api.example.test" }),
    (e: any) => e.statusCode === 503 || e.status === 503 || /suite_ticket/.test(e.message),
  );
});

// ── HTTP routes ───────────────────────────────────────────────────────────

function routeDeps(ssoService: unknown) {
  return {
    createRepository: () => { throw new Error("business repo not expected"); },
    createAuthRepository: () => ({ ssoService: () => ssoService }),
  };
}

test("routes: authorize 302s to WeCom; exchange returns the session", async () => {
  const { svc, mem } = service();
  mem.bindings.set("wecom:wwCorp", { provider: "wecom", tenantId: "wwCorp", orgId: "org-1", tenantName: null, createdAt: "", permanentCode: null });
  const deps = routeDeps(svc);
  const res = await handleBusinessApiRequest({
    httpMethod: "GET", path: "/v1/auth/sso/wecom/authorize",
    queryParameters: { redirect: "http://127.0.0.1:5000/callback", code_challenge: CHALLENGE, code_challenge_method: "S256" },
    headers: {}, body: null,
  }, deps);
  assert.equal(res.statusCode, 302);
  const state = new URL((res.headers as any).Location).searchParams.get("state")!;

  const cb = await handleBusinessApiRequest({
    httpMethod: "GET", path: "/v1/auth/sso/wecom/callback",
    queryParameters: { code: "scan-code", state }, headers: {}, body: null,
  }, deps);
  assert.equal(cb.statusCode, 302);
  const code = new URL((cb.headers as any).Location).searchParams.get("code")!;

  const ex = await handleBusinessApiRequest({
    httpMethod: "POST", path: "/v1/auth/sso/exchange", headers: {},
    body: JSON.stringify({ code, codeVerifier: VERIFIER }),
  }, deps);
  assert.equal(ex.statusCode, 200);
  assert.equal(JSON.parse(ex.body).access_token, "at-for-rt-user-1");
});

test("routes: suite callback POST answers plain-text success", async () => {
  const { svc, mem } = service();
  const t = signedCallback("<xml><SuiteId>wwsuite</SuiteId><InfoType>suite_ticket</InfoType><SuiteTicket>T2</SuiteTicket></xml>");
  const res = await handleBusinessApiRequest({
    httpMethod: "POST", path: "/v1/auth/sso/wecom/suite-callback",
    queryParameters: Object.fromEntries(t.query), headers: { "content-type": "text/xml" }, body: t.body,
  }, routeDeps(svc));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "success");
  assert.equal(mem.tickets.get("wecom:wwsuite"), "T2");
});

test("routes: binding status needs a bearer; unconfigured deployment is 501", async () => {
  const { svc } = service();
  const res = await handleBusinessApiRequest({
    httpMethod: "GET", path: "/v1/teams/t1/sso/wecom",
    headers: { authorization: "Bearer admin-token" }, body: null,
  }, routeDeps(svc));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { configured: true, binding: null });

  const missing = await handleBusinessApiRequest({ httpMethod: "GET", path: "/v1/teams/t1/sso/wecom", headers: {}, body: null }, routeDeps(svc));
  assert.equal(missing.statusCode, 401);

  const off = await handleBusinessApiRequest({
    httpMethod: "GET", path: "/v1/auth/sso/wecom/authorize",
    queryParameters: { redirect: "http://127.0.0.1:1/cb", code_challenge: CHALLENGE }, headers: {}, body: null,
  }, routeDeps(null));
  assert.equal(off.statusCode, 501);
});
