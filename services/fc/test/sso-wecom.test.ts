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
  type SsoDirectoryApp,
  type SsoFlow,
  type SsoStore,
  type WecomSsoConfig,
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
  const directoryApps = new Map<string, SsoDirectoryApp & { authorizedBy: string | null }>();
  // Display name per user id; absent = still the placeholder.
  const names = new Map<string, string>();
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
    async consumeDirectoryFlow(s) {
      const f = flows.get(s);
      if (!f || f.kind !== "directory" || f.consumedAt) return null;
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
    async deleteBinding(p, t) {
      bindings.delete(`${p}:${t}`);
      directoryApps.delete(`${p}:${t}`); // FK cascade
    },
    async getDirectoryApp(p, t) { return directoryApps.get(`${p}:${t}`) ?? null; },
    async saveDirectoryApp({ provider, tenantId, permanentCode, authorizedBy }) {
      directoryApps.set(`${provider}:${tenantId}`, {
        provider, tenantId, permanentCode, authorizedBy,
        namesGranted: false, lastCheckedAt: null, lastError: null, createdAt: "2026-11-27T00:00:00Z",
      });
    },
    async rotateDirectoryAppSecret(p, t, code) {
      const a = directoryApps.get(`${p}:${t}`);
      if (!a) return false;
      a.permanentCode = code;
      return true;
    },
    async recordDirectoryCheck(p, t, { namesGranted, lastError }) {
      const a = directoryApps.get(`${p}:${t}`);
      if (a) Object.assign(a, { namesGranted, lastError, lastCheckedAt: "2026-11-27T01:00:00Z" });
    },
    async deleteDirectoryApp(p, t) { directoryApps.delete(`${p}:${t}`); },
    async identitiesNeedingName(p, t) {
      const out: { subject: string; userId: string }[] = [];
      for (const [k, userId] of identities) {
        const [kp, kt, subject] = k.split(":");
        if (kp === p && kt === t && !names.has(userId)) out.push({ subject, userId });
      }
      return out;
    },
    async applyDirectoryName(userId, name) {
      if (names.has(userId)) return false;
      names.set(userId, name);
      return true;
    },
    async resolveOrgManager(token, _teamId) {
      if (token !== "admin-token" || opts.managerOrg === null) throw new ApiError(403, "forbidden", "no");
      return { userId: "admin-user", orgId: opts.managerOrg ?? "org-1" };
    },
  };
  return { store, flows, bindings, identities, tickets, minted, directoryApps, names };
}

/** What the fake WeCom's directory (代开发) side answers; tests mutate it. */
const directoryWorld = {
  permissions: ["contact:sensitive:user_name"] as string[],
  permissionsError: null as null | number,
  directoryNames: { "open-1": "张三", "open-2": "李四" } as Record<string, string>,
  authUrlStates: [] as string[],
  permanentCodes: { AUTH: "DIRSECRET", RESET: "DIRSECRET2", "AUTH-OTHER": "OTHERSECRET" } as Record<string, string>,
  echoState: null as string | null,
};

function fakeWecomFetch(calls: string[] = []) {
  return async (url: any, init?: any) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.pathname.endsWith("/service/get_provider_token")) {
      const body = JSON.parse(init.body);
      assert.deepEqual(body, { corpid: "wwprovider", provider_secret: "provsecret" });
      return json({ errcode: 0, provider_access_token: "PAT", expires_in: 7200 });
    }
    if (u.pathname.endsWith("/service/get_customized_auth_url")) {
      assert.equal(u.searchParams.get("provider_access_token"), "PAT");
      const body = JSON.parse(init.body);
      assert.deepEqual(body.templateid_list, ["dktemplate"]);
      assert.match(body.state, /^[A-Za-z0-9]{1,32}$/);
      directoryWorld.authUrlStates.push(body.state);
      return json({ errcode: 0, qrcode_url: "https://open.work.weixin.qq.com/qr/abc", expires_in: 864000 });
    }
    if (u.pathname.endsWith("/service/v2/get_permanent_code")) {
      const body = JSON.parse(init.body);
      const code = directoryWorld.permanentCodes[body.auth_code];
      if (!code) return json({ errcode: 40078, errmsg: "invalid auth code" });
      return json({
        errcode: 0,
        permanent_code: code,
        auth_corp_info: { corpid: body.auth_code === "AUTH-OTHER" ? "wwOther" : "wwCorp", corp_name: "示例公司" },
        ...(directoryWorld.echoState ? { state: directoryWorld.echoState } : {}),
      });
    }
    if (u.pathname.endsWith("/cgi-bin/gettoken")) {
      const secret = u.searchParams.get("corpsecret");
      if (!secret?.startsWith("DIRSECRET")) return json({ errcode: 40001, errmsg: "invalid credential" });
      return json({ errcode: 0, access_token: `CAT-${secret}`, expires_in: 7200 });
    }
    if (u.pathname.endsWith("/agent/get_permissions")) {
      if (directoryWorld.permissionsError) return json({ errcode: directoryWorld.permissionsError, errmsg: "app not online" });
      return json({ errcode: 0, app_permissions: directoryWorld.permissions });
    }
    if (u.pathname.endsWith("/cgi-bin/user/get")) {
      const userid = u.searchParams.get("userid")!;
      const granted = directoryWorld.permissions.includes("contact:sensitive:user_name");
      return json({ errcode: 0, userid, name: granted ? directoryWorld.directoryNames[userid] ?? userid : userid });
    }
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

function service(mem = memoryStore(), calls: string[] = [], extra: Partial<WecomSsoConfig> = {}, pending: Promise<unknown>[] = []) {
  mem.tickets.set("wecom:wwsuite", "TICKET");
  mem.tickets.set("wecom:dktemplate", "TICKET");
  let n = 0;
  const svc = createSsoService({
    background: (_label, task) => { pending.push(task()); },
    store: mem.store,
    wecom: {
      config: { suite: SUITE, callback: CB, redirectBaseUrl: "https://api.example.test", installTestMode: true, ...extra },
      client: createWecomClient({ fetchImpl: fakeWecomFetch(calls) as any, loadSuiteTicket: (s) => mem.store.loadSuiteTicket("wecom", s) }),
    },
    refreshSession: async (rt) => ({ access_token: `at-for-${rt}`, refresh_token: "rt2", user: { id: "u" } }),
    randomToken: () => `tok${++n}`.padEnd(12, "x"),
  });
  return { svc, mem, calls, pending };
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

test("suite callback: accepts the 登录授权 page's own key pair when configured", async () => {
  const LOGIN_CB = { token: "login-token", encodingAesKey: "b".repeat(43) };
  const echostr = encryptWecomMessage(LOGIN_CB, "67890", "wwloginsuite");
  const q = new URLSearchParams({ timestamp: "1", nonce: "n", echostr, msg_signature: wecomSignature(LOGIN_CB.token, "1", "n", echostr) });
  // Without the second pair the login page's verification is refused...
  assert.equal((await service().svc.handleSuiteCallback({ method: "GET", query: q, body: "" })).status, 403);
  // ...with it, answered; the app's own pair keeps working alongside.
  const { svc } = service(undefined, [], { loginCallback: LOGIN_CB });
  assert.deepEqual(await svc.handleSuiteCallback({ method: "GET", query: q, body: "" }), { status: 200, text: "67890" });
  const appEcho = encryptWecomMessage(CB, "12345", "wwsuite");
  const q2 = new URLSearchParams({ timestamp: "1", nonce: "n", echostr: appEcho, msg_signature: wecomSignature(CB.token, "1", "n", appEcho) });
  assert.deepEqual(await svc.handleSuiteCallback({ method: "GET", query: q2, body: "" }), { status: 200, text: "12345" });
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

  // The 登录授权 suite signs with its own SuiteID (unknown until the console
  // saves the URL); a well-signed ticket for it is stored too.
  const login = signedCallback("<xml><SuiteId>wwloginsuite</SuiteId><InfoType>suite_ticket</InfoType><SuiteTicket>LT</SuiteTicket></xml>", "wwloginsuite");
  await svc.handleSuiteCallback({ method: "POST", query: login.query, body: login.body });
  assert.equal(mem.tickets.get("wecom:wwloginsuite"), "LT");
  // ...but not one signed with another Token.
  const forged = signedCallback("<xml><SuiteId>wwforged</SuiteId><InfoType>suite_ticket</InfoType><SuiteTicket>F</SuiteTicket></xml>");
  forged.query.set("msg_signature", wecomSignature("someone-elses-token", "1", "n", forged.encrypt));
  assert.equal((await svc.handleSuiteCallback({ method: "POST", query: forged.query, body: forged.body })).status, 403);
  assert.equal(mem.tickets.has("wecom:wwforged"), false);
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
  assert.deepEqual(JSON.parse(res.body), { configured: true, binding: null, directoryConfigured: false, directory: null });

  const missing = await handleBusinessApiRequest({ httpMethod: "GET", path: "/v1/teams/t1/sso/wecom", headers: {}, body: null }, routeDeps(svc));
  assert.equal(missing.statusCode, 401);

  const off = await handleBusinessApiRequest({
    httpMethod: "GET", path: "/v1/auth/sso/wecom/authorize",
    queryParameters: { redirect: "http://127.0.0.1:1/cb", code_challenge: CHALLENGE }, headers: {}, body: null,
  }, routeDeps(null));
  assert.equal(off.statusCode, 501);
});

test("data callback: verifies any customer corpid as receiveId, rejects bad signatures", async () => {
  const { svc } = service();
  const echostr = encryptWecomMessage(CB, "777", "wwSomeCustomer");
  const q = new URLSearchParams({ timestamp: "1", nonce: "n", echostr, msg_signature: wecomSignature(CB.token, "1", "n", echostr) });
  assert.deepEqual(await svc.handleDataCallback({ method: "GET", query: q, body: "" }), { status: 200, text: "777" });
  const ev = signedCallback("<xml><Event>change_contact</Event></xml>", "wwSomeCustomer");
  assert.deepEqual(await svc.handleDataCallback({ method: "POST", query: ev.query, body: ev.body }), { status: 200, text: "success" });
  ev.query.set("msg_signature", "0".repeat(40));
  assert.equal((await svc.handleDataCallback({ method: "POST", query: ev.query, body: ev.body })).status, 403);
});

test("routes: data callback GET answers the echostr as text", async () => {
  const { svc } = service();
  const echostr = encryptWecomMessage(CB, "4242", "wwSomeCustomer");
  const res = await handleBusinessApiRequest({
    httpMethod: "GET", path: "/v1/auth/sso/wecom/data-callback",
    queryParameters: { timestamp: "1", nonce: "n", echostr, msg_signature: wecomSignature(CB.token, "1", "n", echostr) },
    headers: {}, body: null,
  }, routeDeps(svc));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "4242");
});

test("WeCom domain-verify file: only allowlisted codes are served", async () => {
  const { wecomDomainVerifyBody } = await import("../src/lib/sso/domain-verify.js");
  const env = { WECOM_DOMAIN_VERIFY_CODES: " Mj5k9Hcs4qZf7DjD ,other123" };
  assert.equal(wecomDomainVerifyBody("WW_verify_Mj5k9Hcs4qZf7DjD.txt", env), "Mj5k9Hcs4qZf7DjD");
  assert.equal(wecomDomainVerifyBody("WW_verify_attacker1.txt", env), null);
  assert.equal(wecomDomainVerifyBody("WW_verify_Mj5k9Hcs4qZf7DjD.txt", {}), null);
  assert.equal(wecomDomainVerifyBody("../WW_verify_Mj5k9Hcs4qZf7DjD.txt", env), null);

  const prev = process.env.WECOM_DOMAIN_VERIFY_CODES;
  process.env.WECOM_DOMAIN_VERIFY_CODES = "Mj5k9Hcs4qZf7DjD";
  try {
    const ok = await handleBusinessApiRequest({ httpMethod: "GET", path: "/WW_verify_Mj5k9Hcs4qZf7DjD.txt", headers: {}, body: null }, routeDeps(null));
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body, "Mj5k9Hcs4qZf7DjD");
    const no = await handleBusinessApiRequest({ httpMethod: "GET", path: "/WW_verify_someoneElse1.txt", headers: {}, body: null }, routeDeps(null));
    assert.equal(no.statusCode, 404);
  } finally {
    if (prev === undefined) delete process.env.WECOM_DOMAIN_VERIFY_CODES;
    else process.env.WECOM_DOMAIN_VERIFY_CODES = prev;
  }
});

// ── member names through the 代开发 template ──────────────────────────────

const DIRECTORY: Partial<WecomSsoConfig> = {
  providerCorpId: "wwprovider",
  directory: { template: { suiteId: "dktemplate", suiteSecret: "dksecret" }, providerSecret: "provsecret" },
};

function resetDirectoryWorld() {
  directoryWorld.permissions = ["contact:sensitive:user_name"];
  directoryWorld.permissionsError = null;
  directoryWorld.authUrlStates = [];
  directoryWorld.echoState = null;
}

function boundStore(orgId = "org-1") {
  const mem = memoryStore();
  mem.bindings.set("wecom:wwCorp", { provider: "wecom", tenantId: "wwCorp", orgId, tenantName: "示例公司", createdAt: "", permanentCode: null });
  return mem;
}

function templateEvent(xml: string) {
  return signedCallback(`<xml><SuiteId><![CDATA[dktemplate]]></SuiteId>${xml}</xml>`, "dktemplate");
}

async function authorizeDirectory(svc: ReturnType<typeof service>["svc"], pending: Promise<unknown>[], authCode = "AUTH") {
  const { qrcodeUrl } = await svc.directoryAuthUrl({ provider: "wecom", accessToken: "admin-token", teamId: "t1" });
  assert.equal(qrcodeUrl, "https://open.work.weixin.qq.com/qr/abc");
  const state = directoryWorld.authUrlStates.at(-1)!;
  const ev = templateEvent(`<InfoType>create_auth</InfoType><AuthCode>${authCode}</AuthCode><State>${state}</State>`);
  const res = await svc.handleSuiteCallback({ method: "POST", query: ev.query, body: ev.body });
  assert.deepEqual(res, { status: 200, text: "success" }, "answered before the WeCom calls run");
  await Promise.all(pending.splice(0));
  return state;
}

test("readWecomSsoConfig: member names need the template, its secret, the provider secret and corpid", () => {
  const base = { WECOM_SUITE_ID: "s", WECOM_SUITE_SECRET: "x", WECOM_CALLBACK_TOKEN: "t", WECOM_CALLBACK_AES_KEY: AES_KEY };
  assert.equal(readWecomSsoConfig(base)?.directory, undefined);
  assert.equal(readWecomSsoConfig({ ...base, WECOM_CUSTOMIZED_SUITE_ID: "dk", WECOM_CUSTOMIZED_SUITE_SECRET: "y", WECOM_PROVIDER_SECRET: "p" })?.directory, undefined,
    "no provider corpid → off");
  const cfg = readWecomSsoConfig({
    ...base, WECOM_CUSTOMIZED_SUITE_ID: "dk", WECOM_CUSTOMIZED_SUITE_SECRET: "y", WECOM_PROVIDER_SECRET: "p", WECOM_PROVIDER_CORPID: "wwp",
  });
  assert.deepEqual(cfg?.directory, { template: { suiteId: "dk", suiteSecret: "y" }, providerSecret: "p" });
});

test("directory: the QR link needs the feature, a manager, and a bound company", async () => {
  resetDirectoryWorld();
  await assert.rejects(service(boundStore()).svc.directoryAuthUrl({ provider: "wecom", accessToken: "admin-token", teamId: "t1" }), /not configured/);
  await assert.rejects(service(memoryStore(), [], DIRECTORY).svc.directoryAuthUrl({ provider: "wecom", accessToken: "admin-token", teamId: "t1" }), /connect the organization/);
  await assert.rejects(service(boundStore(), [], DIRECTORY).svc.directoryAuthUrl({ provider: "wecom", accessToken: "nope", teamId: "t1" }), /no/);

  const mem = boundStore();
  const { svc } = service(mem, [], DIRECTORY);
  const out = await svc.directoryAuthUrl({ provider: "wecom", accessToken: "admin-token", teamId: "t1" });
  const state = directoryWorld.authUrlStates.at(-1)!;
  const flow = mem.flows.get(state)!;
  assert.equal(flow.kind, "directory");
  assert.equal(flow.orgId, "org-1");
  assert.equal(flow.requestedBy, "admin-user");
  assert.equal(out.expiresAt, flow.expiresAt);
});

test("directory: authorizing fills every placeholder name, and later sign-ins get theirs", async () => {
  resetDirectoryWorld();
  const mem = boundStore();
  const pending: Promise<unknown>[] = [];
  const { svc } = service(mem, [], DIRECTORY, pending);
  // Two people signed in before names were available.
  const alice = await mem.store.ensureIdentity({ provider: "wecom", tenantId: "wwCorp", subject: "open-1" });
  const chose = await mem.store.ensureIdentity({ provider: "wecom", tenantId: "wwCorp", subject: "open-2" });
  mem.names.set(chose, "自己起的名");

  await authorizeDirectory(svc, pending);
  const app = mem.directoryApps.get("wecom:wwCorp")!;
  assert.equal(app.permanentCode, "DIRSECRET");
  assert.equal(app.authorizedBy, "admin-user");
  assert.equal(app.namesGranted, true);
  assert.equal(mem.names.get(alice), "张三", "the placeholder is replaced");
  assert.equal(mem.names.get(chose), "自己起的名", "a chosen name is kept");

  // A new member's first scan picks up their name in the background.
  const url = await startLogin(svc);
  directoryWorld.directoryNames["open-1"] = "张三";
  mem.identities.clear();
  mem.names.clear();
  const res = await svc.handleLoginCallback({ provider: "wecom", code: "c1", state: url.searchParams.get("state") });
  assert.ok("redirect" in res);
  await Promise.all(pending.splice(0));
  const newUser = [...mem.identities.values()][0];
  assert.equal(mem.names.get(newUser), "张三");

  const status = await svc.binding({ provider: "wecom", accessToken: "admin-token", teamId: "t1" });
  assert.equal(status.directoryConfigured, true);
  assert.equal(status.directory?.namesGranted, true);
});

test("directory: an authorization without a live link, or from another org's company, is ignored", async () => {
  resetDirectoryWorld();
  const mem = boundStore();
  mem.bindings.set("wecom:wwOther", { provider: "wecom", tenantId: "wwOther", orgId: "org-2", tenantName: null, createdAt: "", permanentCode: null });
  const pending: Promise<unknown>[] = [];
  const { svc } = service(mem, [], DIRECTORY, pending);

  const stray = templateEvent("<InfoType>create_auth</InfoType><AuthCode>AUTH</AuthCode><State>unknownstate</State>");
  assert.equal((await svc.handleSuiteCallback({ method: "POST", query: stray.query, body: stray.body })).text, "success");
  await Promise.all(pending.splice(0));
  assert.equal(mem.directoryApps.size, 0, "no live link → nothing stored");

  await authorizeDirectory(svc, pending, "AUTH-OTHER");
  assert.equal(mem.directoryApps.size, 0, "org-1's link cannot attach org-2's company");
});

test("directory: without the 「姓名」 grant nothing is filled; change_auth after the grant fills", async () => {
  resetDirectoryWorld();
  directoryWorld.permissions = [];
  const mem = boundStore();
  const pending: Promise<unknown>[] = [];
  const { svc } = service(mem, [], DIRECTORY, pending);
  const alice = await mem.store.ensureIdentity({ provider: "wecom", tenantId: "wwCorp", subject: "open-1" });

  await authorizeDirectory(svc, pending);
  const app = mem.directoryApps.get("wecom:wwCorp")!;
  assert.equal(app.namesGranted, false);
  assert.match(app.lastError ?? "", /姓名/);
  assert.equal(mem.names.has(alice), false);

  directoryWorld.permissions = ["contact:sensitive:user_name"];
  const change = templateEvent("<InfoType>change_auth</InfoType><AuthCorpId>wwCorp</AuthCorpId>");
  await svc.handleSuiteCallback({ method: "POST", query: change.query, body: change.body });
  await Promise.all(pending.splice(0));
  assert.equal(mem.directoryApps.get("wecom:wwCorp")!.namesGranted, true);
  assert.equal(mem.names.get(alice), "张三");
});

test("directory: an app WeCom still refuses (开发中) is recorded as not granted", async () => {
  resetDirectoryWorld();
  directoryWorld.permissionsError = 60011;
  const mem = boundStore();
  const pending: Promise<unknown>[] = [];
  const { svc } = service(mem, [], DIRECTORY, pending);
  await authorizeDirectory(svc, pending);
  const app = mem.directoryApps.get("wecom:wwCorp")!;
  assert.equal(app.namesGranted, false);
  assert.match(app.lastError ?? "", /60011/);
});

test("directory: reset_permanent_code rotates the secret; the template's cancel_auth keeps sign-in", async () => {
  resetDirectoryWorld();
  const mem = boundStore();
  const pending: Promise<unknown>[] = [];
  const { svc } = service(mem, [], DIRECTORY, pending);
  await authorizeDirectory(svc, pending);

  const reset = templateEvent("<InfoType>reset_permanent_code</InfoType><AuthCode>RESET</AuthCode>");
  await svc.handleSuiteCallback({ method: "POST", query: reset.query, body: reset.body });
  await Promise.all(pending.splice(0));
  assert.equal(mem.directoryApps.get("wecom:wwCorp")!.permanentCode, "DIRSECRET2");

  const cancel = templateEvent("<InfoType>cancel_auth</InfoType><AuthCorpId>wwCorp</AuthCorpId>");
  await svc.handleSuiteCallback({ method: "POST", query: cancel.query, body: cancel.body });
  await Promise.all(pending.splice(0));
  assert.equal(mem.directoryApps.size, 0, "the names app is gone");
  assert.ok(mem.bindings.has("wecom:wwCorp"), "the company still signs in");

  // The template's suite_ticket is stored like any other.
  const ticket = templateEvent("<InfoType>suite_ticket</InfoType><SuiteTicket>DKT</SuiteTicket>");
  await svc.handleSuiteCallback({ method: "POST", query: ticket.query, body: ticket.body });
  assert.equal(mem.tickets.get("wecom:dktemplate"), "DKT");
});

test("directory: sync re-checks and fills on demand", async () => {
  resetDirectoryWorld();
  const mem = boundStore();
  const pending: Promise<unknown>[] = [];
  const { svc } = service(mem, [], DIRECTORY, pending);
  await assert.rejects(svc.syncDirectory({ provider: "wecom", accessToken: "admin-token", teamId: "t1" }), /not authorized member names/);

  directoryWorld.permissions = [];
  await authorizeDirectory(svc, pending);
  const a = await mem.store.ensureIdentity({ provider: "wecom", tenantId: "wwCorp", subject: "open-1" });
  const b = await mem.store.ensureIdentity({ provider: "wecom", tenantId: "wwCorp", subject: "open-2" });
  directoryWorld.permissions = ["contact:sensitive:user_name"];
  const out = await svc.syncDirectory({ provider: "wecom", accessToken: "admin-token", teamId: "t1" });
  assert.equal(out.updated, 2);
  assert.equal(out.directory?.namesGranted, true);
  assert.deepEqual([mem.names.get(a), mem.names.get(b)], ["张三", "李四"]);
});

test("routes: directory link and sync are served for org managers", async () => {
  resetDirectoryWorld();
  const mem = boundStore();
  const { svc } = service(mem, [], DIRECTORY);
  const res = await handleBusinessApiRequest({
    httpMethod: "POST", path: "/v1/teams/t1/sso/wecom/directory",
    headers: { authorization: "Bearer admin-token" }, body: "{}",
  }, routeDeps(svc));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).qrcodeUrl, "https://open.work.weixin.qq.com/qr/abc");

  const sync = await handleBusinessApiRequest({
    httpMethod: "POST", path: "/v1/teams/t1/sso/wecom/directory/sync",
    headers: { authorization: "Bearer admin-token" }, body: "{}",
  }, routeDeps(svc));
  assert.equal(sync.statusCode, 409, "nothing authorized yet");
});
