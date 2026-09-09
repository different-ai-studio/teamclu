import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_AUTH_CALLBACK_PATH,
  APP_AUTH_LOGOUT_PATH,
  APP_COOKIE,
  APP_RENEW_WINDOW_SECONDS,
  APP_TTL_SECONDS,
  __resetSpentCodes,
  mintAppSession,
  mintAuthCode,
} from "../src/lib/apps-auth-session.js";
import { applyAuthGate, type GateApp, type GateDeps } from "../src/lib/apps-auth-gate.js";
import { proxyToApp } from "../src/lib/apps-vanity.js";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const TEAM_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ORG_A = "org-a";
const ORG_B = "org-b";
const ORIGIN = "https://report-11111111.apps.example.com";

const BASE_ENV = {
  APPS_AUTH_SESSION_SECRET: "apps-gate-test-secret-at-least-32-characters",
  APPS_PUBLIC_DOMAIN: "apps.example.com",
  LOGIN_DOMAIN: "login.example.com",
};

async function withEnv(
  extra: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  const merged = { ...BASE_ENV, ...extra };
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(merged)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetSpentCodes();
  try {
    await body();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const app = (over: Partial<GateApp> = {}): GateApp => ({
  id: APP_ID,
  slug: "report",
  teamId: TEAM_ID,
  authMode: "platform",
  authAudience: "any",
  authScope: "all",
  authRules: [],
  ...over,
});

const deps = (over: Partial<GateDeps> = {}): GateDeps => ({
  resolveOrgs: async () => ({ visitorOrgId: ORG_A, appOrgId: ORG_A }),
  secureCookies: true,
  ...over,
});

const req = (path = "/", headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { headers });

async function sessionCookie(appId = APP_ID, ttl = APP_TTL_SECONDS): Promise<string> {
  const { token } = await mintAppSession(
    { sub: "user-1", email: "a@example.com", appId },
    ttl,
  );
  return `${APP_COOKIE}=${token}`;
}

// --- no wall ----------------------------------------------------------------

test("an app without platform auth is proxied untouched", async () => {
  await withEnv({}, async () => {
    const out = await applyAuthGate(req("/x"), app({ authMode: "none" }), deps());
    assert.equal(out.response, null);
    assert.equal(out.identity, null);
    assert.equal(out.setCookie, null);
  });
});

test("the gateway's own paths are claimed even on an app with no wall", async () => {
  // Otherwise a user's route at /__teamclu/auth/callback could impersonate the
  // callback and mint itself a session cookie.
  await withEnv({}, async () => {
    const cb = await applyAuthGate(req(APP_AUTH_CALLBACK_PATH), app({ authMode: "none" }), deps());
    assert.equal(cb.response?.status, 302);
    const out = await applyAuthGate(req(APP_AUTH_LOGOUT_PATH), app({ authMode: "none" }), deps());
    assert.equal(out.response?.status, 302);
  });
});

// --- the redirect to login --------------------------------------------------

test("an unauthenticated visitor is sent to the login service with the flow intact", async () => {
  await withEnv({}, async () => {
    const out = await applyAuthGate(req("/reports?q=1"), app(), deps());
    assert.equal(out.response?.status, 302);
    const location = new URL(out.response!.headers.get("location")!);
    assert.equal(location.host, "login.example.com");
    assert.equal(location.searchParams.get("app"), APP_ID);
    // Must equal what the login service computes, or it refuses the return.
    assert.equal(location.searchParams.get("r"), ORIGIN);
    assert.equal(location.searchParams.get("next"), "/reports?q=1");
  });
});

test("a session for a different app does not open this one", async () => {
  await withEnv({}, async () => {
    const cookie = await sessionCookie("99999999-2222-3333-4444-555555555555");
    const out = await applyAuthGate(req("/", { cookie }), app(), deps());
    assert.equal(out.response?.status, 302, "must fall back to login, not proceed");
    assert.equal(out.identity, null);
  });
});

// --- fail closed on misconfiguration ---------------------------------------

test("an app that cannot run the login flow is refused, never served", async () => {
  // Serving it anyway is precisely the failure this feature exists to remove:
  // an app marked "requires login", public, with the panel calling it protected.
  await withEnv({ LOGIN_DOMAIN: undefined }, async () => {
    const out = await applyAuthGate(req("/"), app(), deps());
    assert.equal(out.response?.status, 503);
    assert.equal(out.identity, null);
  });
  await withEnv({ APPS_PUBLIC_DOMAIN: undefined }, async () => {
    const out = await applyAuthGate(req("/"), app(), deps());
    assert.equal(out.response?.status, 503);
  });
});

// --- audiences --------------------------------------------------------------

test("the any audience admits any signed-in visitor", async () => {
  await withEnv({}, async () => {
    const cookie = await sessionCookie();
    const out = await applyAuthGate(
      req("/", { cookie }),
      app({ authAudience: "any" }),
      // Would reject if consulted; the any audience must not consult it.
      deps({ resolveOrgs: async () => ({ visitorOrgId: ORG_A, appOrgId: ORG_B }) }),
    );
    assert.equal(out.response, null);
    assert.equal(out.identity?.userId, "user-1");
    assert.equal(out.identity?.orgId, null, "no org was looked up, so none is forwarded");
  });
});

test("the org audience admits a colleague and forwards their org", async () => {
  await withEnv({}, async () => {
    const cookie = await sessionCookie();
    const out = await applyAuthGate(
      req("/", { cookie }),
      app({ authAudience: "org" }),
      deps({ resolveOrgs: async () => ({ visitorOrgId: ORG_A, appOrgId: ORG_A }) }),
    );
    assert.equal(out.response, null);
    assert.equal(out.identity?.orgId, ORG_A);
  });
});

test("the org audience turns away an outsider with a 403, not a redirect", async () => {
  await withEnv({}, async () => {
    const cookie = await sessionCookie();
    const out = await applyAuthGate(
      req("/", { cookie }),
      app({ authAudience: "org" }),
      deps({ resolveOrgs: async () => ({ visitorOrgId: ORG_B, appOrgId: ORG_A }) }),
    );
    // They ARE logged in; bouncing them to the login page would loop forever.
    assert.equal(out.response?.status, 403);
    assert.equal(out.identity, null);
    assert.match(await out.response!.text(), /不属于这个应用所在的组织/);
  });
});

test("a visitor with no org of their own is an outsider", async () => {
  // Someone who signed up through an app's login page has no public.users row,
  // which is exactly what makes "staff only" mean something.
  await withEnv({}, async () => {
    const cookie = await sessionCookie();
    const out = await applyAuthGate(
      req("/", { cookie }),
      app({ authAudience: "org" }),
      deps({ resolveOrgs: async () => ({ visitorOrgId: null, appOrgId: ORG_A }) }),
    );
    assert.equal(out.response?.status, 403);
  });
});

test("a team with no org is an operator fault, not a rejected visitor", async () => {
  await withEnv({}, async () => {
    const cookie = await sessionCookie();
    const out = await applyAuthGate(
      req("/", { cookie }),
      app({ authAudience: "org" }),
      deps({ resolveOrgs: async () => ({ visitorOrgId: ORG_A, appOrgId: null }) }),
    );
    // 503 with a reason, so nobody hunts for a permissions bug that isn't there.
    assert.equal(out.response?.status, 503);
    assert.match(await out.response!.text(), /未关联组织/);
  });
});

test("an unset audience is read as org, not as open", async () => {
  await withEnv({}, async () => {
    const cookie = await sessionCookie();
    const out = await applyAuthGate(
      req("/", { cookie }),
      app({ authAudience: null }),
      deps({ resolveOrgs: async () => ({ visitorOrgId: ORG_B, appOrgId: ORG_A }) }),
    );
    assert.equal(out.response?.status, 403, "a missing column must not widen access");
  });
});

// --- per-path audience ------------------------------------------------------

test("a path rule's audience narrows an app that admits anyone", async () => {
  // The app is open to any signed-in user; /admin says employees only. An
  // outsider gets / and is refused /admin, in one request each.
  await withEnv({}, async () => {
    const cookie = await sessionCookie();
    const outsider = deps({ resolveOrgs: async () => ({ visitorOrgId: ORG_B, appOrgId: ORG_A }) });
    const walled = app({
      authAudience: "any",
      authScope: "all",
      authRules: [{ path: "/admin", auth: "required", audience: "org" }],
    });

    const home = await applyAuthGate(req("/", { cookie }), walled, outsider);
    assert.equal(home.response, null, "the app-level audience still admits them here");

    const admin = await applyAuthGate(req("/admin", { cookie }), walled, outsider);
    assert.equal(admin.response?.status, 403);
    assert.equal(admin.identity, null);
  });
});

test("a path rule's audience widens an employees-only app", async () => {
  await withEnv({}, async () => {
    const cookie = await sessionCookie();
    const outsider = deps({ resolveOrgs: async () => ({ visitorOrgId: ORG_B, appOrgId: ORG_A }) });
    const walled = app({
      authAudience: "org",
      authScope: "all",
      authRules: [{ path: "/portal", auth: "required", audience: "any" }],
    });

    const portal = await applyAuthGate(req("/portal/orders", { cookie }), walled, outsider);
    assert.equal(portal.response, null, "the rule's audience wins on this path");

    const root = await applyAuthGate(req("/", { cookie }), walled, outsider);
    assert.equal(root.response?.status, 403, "and nowhere else");
  });
});

test("a rule that says nothing about audience leaves the app's own value alone", async () => {
  // The compatibility case: every rule written before this feature existed.
  // Reading the absent key as `org` would lock out the visitors an app set to
  // "any signed-in user" is admitting today.
  await withEnv({}, async () => {
    const cookie = await sessionCookie();
    const out = await applyAuthGate(
      req("/reports", { cookie }),
      app({
        authAudience: "any",
        authScope: "all",
        authRules: [{ path: "/reports", auth: "required" }],
      }),
      deps({ resolveOrgs: async () => ({ visitorOrgId: ORG_B, appOrgId: ORG_A }) }),
    );
    assert.equal(out.response, null);
  });
});

test("a public path with a narrower neighbour still serves anonymously", async () => {
  await withEnv({}, async () => {
    const out = await applyAuthGate(
      req("/health"),
      app({
        authAudience: "any",
        authScope: "all",
        authRules: [
          { path: "/health", auth: "public" },
          { path: "/admin", auth: "required", audience: "org" },
        ],
      }),
      deps(),
    );
    assert.equal(out.response, null);
    assert.equal(out.identity, null);
  });
});

// --- the callback -----------------------------------------------------------

test("a valid code becomes a cookie on this hostname", async () => {
  await withEnv({}, async () => {
    const { token } = await mintAuthCode({
      sub: "user-9",
      email: "nine@example.com",
      appId: APP_ID,
      redirect: ORIGIN,
    });
    const url = `${APP_AUTH_CALLBACK_PATH}?code=${encodeURIComponent(token)}&next=%2Fdash`;
    const out = await applyAuthGate(req(url), app(), deps());
    assert.equal(out.response?.status, 302);
    assert.equal(out.response!.headers.get("location"), `${ORIGIN}/dash`);
    const cookie = out.response!.headers.get("set-cookie")!;
    assert.match(cookie, new RegExp(`^${APP_COOKIE}=`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);

    // And that cookie really opens the app.
    const token2 = cookie.split(";")[0].split("=")[1];
    const second = await applyAuthGate(
      req("/", { cookie: `${APP_COOKIE}=${token2}` }),
      app(),
      deps(),
    );
    assert.equal(second.response, null);
    assert.equal(second.identity?.email, "nine@example.com");
  });
});

test("a code minted for another origin is refused here", async () => {
  await withEnv({}, async () => {
    const { token } = await mintAuthCode({
      sub: "u",
      email: "e@example.com",
      appId: APP_ID,
      redirect: "https://evil.example.com",
    });
    const out = await applyAuthGate(
      req(`${APP_AUTH_CALLBACK_PATH}?code=${encodeURIComponent(token)}`),
      app(),
      deps(),
    );
    assert.equal(out.response?.status, 400);
    assert.equal(out.response!.headers.get("set-cookie"), null);
  });
});

test("a spent code offers a link rather than bouncing in a loop", async () => {
  await withEnv({}, async () => {
    const out = await applyAuthGate(
      req(`${APP_AUTH_CALLBACK_PATH}?code=nonsense`),
      app(),
      deps(),
    );
    assert.equal(out.response?.status, 400);
    const html = await out.response!.text();
    assert.match(html, /登录已失效/);
    // A link, not a redirect: an automatic bounce could loop forever if the two
    // sides ever disagreed about the signing key.
    assert.match(html, /login\.example\.com/);
  });
});

test("refreshing the callback with a live session just moves on", async () => {
  await withEnv({}, async () => {
    const cookie = await sessionCookie();
    const out = await applyAuthGate(
      req(`${APP_AUTH_CALLBACK_PATH}?code=already-used&next=%2Fhome`, { cookie }),
      app(),
      deps(),
    );
    assert.equal(out.response?.status, 302);
    assert.equal(out.response!.headers.get("location"), `${ORIGIN}/home`);
  });
});

test("the callback cannot be used to leave the app", async () => {
  await withEnv({}, async () => {
    const { token } = await mintAuthCode({
      sub: "u",
      email: "e@example.com",
      appId: APP_ID,
      redirect: ORIGIN,
    });
    const out = await applyAuthGate(
      req(`${APP_AUTH_CALLBACK_PATH}?code=${encodeURIComponent(token)}&next=%2F%2Fevil.example.com`),
      app(),
      deps(),
    );
    assert.equal(out.response!.headers.get("location"), `${ORIGIN}/`);
  });
});

// --- logout -----------------------------------------------------------------

test("logout clears this app and hands off to the central logout", async () => {
  await withEnv({}, async () => {
    const out = await applyAuthGate(req(APP_AUTH_LOGOUT_PATH), app(), deps());
    assert.equal(out.response?.status, 302);
    // Both halves matter: dropping only this cookie would leave the SSO cookie
    // alive and the next request would be signed straight back in.
    assert.equal(out.response!.headers.get("location"), "https://login.example.com/logout");
    assert.match(out.response!.headers.get("set-cookie")!, /Max-Age=0/);
  });
});

// --- sliding renewal --------------------------------------------------------

test("a session near expiry is renewed on the way through", async () => {
  await withEnv({}, async () => {
    const nearly = await sessionCookie(APP_ID, APP_RENEW_WINDOW_SECONDS - 60);
    const out = await applyAuthGate(req("/", { cookie: nearly }), app(), deps());
    assert.equal(out.response, null);
    assert.ok(out.setCookie, "an active visitor must not be bounced mid-visit");
    assert.match(out.setCookie!, new RegExp(`^${APP_COOKIE}=`));
  });
});

test("a fresh session is not reissued on every request", async () => {
  await withEnv({}, async () => {
    const fresh = await sessionCookie();
    const out = await applyAuthGate(req("/", { cookie: fresh }), app(), deps());
    assert.equal(out.setCookie, null);
  });
});

// --- identity forwarding (R2) -----------------------------------------------

test("proxyToApp strips client-supplied identity headers", async () => {
  let seen: Headers | null = null;
  const fake = (async (_u: any, init: any) => {
    seen = init.headers as Headers;
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  await proxyToApp(
    new Request(`${ORIGIN}/`, {
      headers: {
        "x-teamclu-user-id": "forged",
        "X-Teamclu-User-Email": "forged@example.com",
        "x-teamclu-org-id": "forged-org",
      },
    }),
    "https://up.example",
    fake,
    null,
  );
  // Null identity means the app must see NOTHING, not the caller's own values.
  assert.equal(seen!.get("x-teamclu-user-id"), null);
  assert.equal(seen!.get("x-teamclu-user-email"), null);
  assert.equal(seen!.get("x-teamclu-org-id"), null);
});

test("proxyToApp forwards the gateway's identity, overriding any forgery", async () => {
  let seen: Headers | null = null;
  const fake = (async (_u: any, init: any) => {
    seen = init.headers as Headers;
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  await proxyToApp(
    new Request(`${ORIGIN}/`, { headers: { "x-teamclu-user-id": "forged" } }),
    "https://up.example",
    fake,
    { userId: "real-user", email: "real@example.com", orgId: ORG_A },
  );
  assert.equal(seen!.get("x-teamclu-user-id"), "real-user");
  assert.equal(seen!.get("x-teamclu-user-email"), "real@example.com");
  assert.equal(seen!.get("x-teamclu-org-id"), ORG_A);
});

// --- path-level scope (批次 3.5) ---------------------------------------------

const scoped = (rules: unknown, scope = "paths") =>
  app({ authScope: scope, authRules: rules });

test("a public path is served to an anonymous visitor", async () => {
  await withEnv({}, async () => {
    const a = scoped([{ path: "/admin", auth: "required" }]);
    const out = await applyAuthGate(req("/pricing"), a, deps());
    assert.equal(out.response, null, "no redirect for a public page");
    assert.equal(out.identity, null);
  });
});

test("a protected path under the paths scope still demands a login", async () => {
  await withEnv({}, async () => {
    const a = scoped([{ path: "/admin", auth: "required" }]);
    const out = await applyAuthGate(req("/admin/users"), a, deps());
    assert.equal(out.response?.status, 302);
    assert.match(out.response!.headers.get("location")!, /login\.example\.com/);
  });
});

test("an exception can open one path under a fully walled app", async () => {
  await withEnv({}, async () => {
    const a = scoped([{ path: "/health", auth: "public" }], "all");
    assert.equal((await applyAuthGate(req("/health"), a, deps())).response, null);
    assert.equal((await applyAuthGate(req("/"), a, deps())).response?.status, 302);
  });
});

test("a signed-in visitor is named to the app on public paths too", async () => {
  // Otherwise a landing page cannot say "welcome back" and the visitor thinks
  // their login was lost.
  await withEnv({}, async () => {
    const cookie = await sessionCookie();
    const a = scoped([{ path: "/admin", auth: "required" }]);
    const out = await applyAuthGate(req("/", { cookie }), a, deps());
    assert.equal(out.response, null);
    assert.equal(out.identity?.email, "a@example.com");
  });
});

test("a public path names nobody when the visitor would be refused entry", async () => {
  // X-Teamclu-User-Id must carry exactly one meaning wherever it appears:
  // this person satisfies every condition for entering this app. Forwarding an
  // outsider's identity on a public page would quietly break that.
  await withEnv({}, async () => {
    const cookie = await sessionCookie();
    const a = app({
      authScope: "paths",
      authRules: [{ path: "/admin", auth: "required" }],
      authAudience: "org",
    });
    const out = await applyAuthGate(
      req("/", { cookie }),
      a,
      deps({ resolveOrgs: async () => ({ visitorOrgId: ORG_B, appOrgId: ORG_A }) }),
    );
    assert.equal(out.response, null, "the page itself is public, so it is served");
    assert.equal(out.identity, null, "but the app is not told who they are");
  });
});

test("a misconfigured org does not take the public pages down with it", async () => {
  await withEnv({}, async () => {
    const cookie = await sessionCookie();
    const a = app({
      authScope: "paths",
      authRules: [{ path: "/admin", auth: "required" }],
      authAudience: "org",
    });
    const d = deps({ resolveOrgs: async () => ({ visitorOrgId: ORG_A, appOrgId: null }) });
    assert.equal((await applyAuthGate(req("/", { cookie }), a, d)).response, null);
    // The protected path still reports the fault rather than admitting anyone.
    assert.equal((await applyAuthGate(req("/admin", { cookie }), a, d)).response?.status, 503);
  });
});

test("path rules cannot expose the gateway's own endpoints", async () => {
  await withEnv({}, async () => {
    const a = scoped([{ path: "/__teamclu", auth: "public" }]);
    const out = await applyAuthGate(req(APP_AUTH_CALLBACK_PATH + "?code=x"), a, deps());
    // Handled by the gateway, never proxied — a rule must not turn the callback
    // into a route the app can answer.
    assert.ok(out.response, "the gateway still owns this path");
    assert.equal(out.identity, null);
  });
});

test("an encoded traversal cannot reach a protected path through a public prefix", async () => {
  await withEnv({}, async () => {
    const a = scoped([{ path: "/admin", auth: "required" }]);
    const out = await applyAuthGate(req("/pricing%2f..%2fadmin"), a, deps());
    assert.equal(out.response?.status, 302, "unreasonable paths are protected");
  });
});

// --- custom domains (批次 4) -------------------------------------------------

const CUSTOM_ORIGIN = "https://shop.example.com";

const onCustom = (path = "/", headers: Record<string, string> = {}) =>
  new Request(`${CUSTOM_ORIGIN}${path}`, { headers });

const boundApp = (verified = "2026-09-08T00:00:00Z") =>
  ({
    ...app(),
    customDomain: "shop.example.com",
    customDomainVerifiedAt: verified,
  }) as any;

test("a visitor on the custom domain is returned to the custom domain", async () => {
  // Sending them back to the vanity name would land the session cookie on a
  // hostname they are not using, and they would be asked to log in again.
  await withEnv({}, async () => {
    const out = await applyAuthGate(onCustom("/reports"), boundApp(), deps());
    const location = new URL(out.response!.headers.get("location")!);
    assert.equal(location.searchParams.get("r"), CUSTOM_ORIGIN);
    assert.equal(location.searchParams.get("next"), "/reports");
  });
});

test("the vanity host still returns to the vanity host", async () => {
  await withEnv({}, async () => {
    const out = await applyAuthGate(req("/reports"), boundApp(), deps());
    const location = new URL(out.response!.headers.get("location")!);
    assert.equal(location.searchParams.get("r"), ORIGIN);
  });
});

test("an unverified domain is not an origin the gate will return to", async () => {
  // It is not served either, so a request arriving on it should not be able to
  // steer the login flow at it.
  await withEnv({}, async () => {
    const out = await applyAuthGate(onCustom("/"), boundApp(null as any), deps());
    const location = new URL(out.response!.headers.get("location")!);
    assert.equal(location.searchParams.get("r"), ORIGIN, "falls back to the vanity origin");
  });
});

test("the callback on a custom domain redeems a code minted for it", async () => {
  await withEnv({}, async () => {
    const { token } = await mintAuthCode({
      sub: "u-5",
      email: "five@example.com",
      appId: APP_ID,
      redirect: CUSTOM_ORIGIN,
    });
    const out = await applyAuthGate(
      onCustom(`${APP_AUTH_CALLBACK_PATH}?code=${encodeURIComponent(token)}&next=%2Fx`),
      boundApp(),
      deps(),
    );
    assert.equal(out.response?.status, 302);
    assert.equal(out.response!.headers.get("location"), `${CUSTOM_ORIGIN}/x`);
    assert.match(out.response!.headers.get("set-cookie")!, new RegExp(`^${APP_COOKIE}=`));
  });
});
