import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_AUTH_CALLBACK_PATH,
  SSO_COOKIE,
  __resetSpentCodes,
  consumeAuthCode,
  mintSsoSession,
} from "../src/lib/apps-auth-session.js";
import {
  handleLoginRequest,
  isLoginHost,
  type LoginApp,
  type LoginServiceDeps,
} from "../src/lib/apps-login-service.js";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const APP: LoginApp = { id: APP_ID, slug: "report", authMode: "platform" };
const ORIGIN = "https://report-11111111.apps.example.com";

const BASE_ENV = {
  APPS_AUTH_SESSION_SECRET: "apps-login-test-secret-at-least-32-characters",
  APPS_PUBLIC_DOMAIN: "apps.example.com",
  LOGIN_DOMAIN: "login.example.com",
  SUPABASE_URL: "http://kong:8000",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_PUBLISHABLE_KEY: undefined,
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

type GotrueCall = { url: string; body: any };

function deps(
  overrides: Partial<LoginServiceDeps> & { gotrue?: (call: GotrueCall) => Response } = {},
): LoginServiceDeps & { calls: GotrueCall[] } {
  const calls: GotrueCall[] = [];
  const gotrue = overrides.gotrue ?? (() => new Response(JSON.stringify({ user: { id: "u-1", email: "a@example.com" } }), { status: 200 }));
  return {
    calls,
    lookupApp: overrides.lookupApp ?? (async (id) => (id === APP_ID ? APP : null)),
    rateLimited: overrides.rateLimited ?? (() => false),
    secureCookies: overrides.secureCookies ?? true,
    fetchImpl: (async (url: any, init: any) => {
      const call = { url: String(url), body: init?.body ? JSON.parse(init.body) : null };
      calls.push(call);
      return gotrue(call);
    }) as unknown as typeof fetch,
  };
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://login.example.com${path}`, { method: "GET", headers });

const post = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`https://login.example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });

const flow = { app: APP_ID, r: ORIGIN, next: "/report" };

// --- host routing -----------------------------------------------------------

test("only the configured login hostname is claimed", () => {
  const env = { LOGIN_DOMAIN: "login.example.com" } as NodeJS.ProcessEnv;
  assert.equal(isLoginHost("login.example.com", env), true);
  assert.equal(isLoginHost("LOGIN.EXAMPLE.COM", env), true);
  assert.equal(isLoginHost("login.example.com:443", env), true);
  assert.equal(isLoginHost("api.example.com", env), false);
  assert.equal(isLoginHost("report-1.apps.example.com", env), false);
  assert.equal(isLoginHost(undefined, env), false);
  // Unset LOGIN_DOMAIN must claim nothing at all, or a deployment without a
  // login service would swallow every hostname.
  assert.equal(isLoginHost("login.example.com", {} as NodeJS.ProcessEnv), false);
});

test("unknown paths fall through so /healthz still answers here", async () => {
  await withEnv({}, async () => {
    assert.equal(await handleLoginRequest(get("/healthz"), deps()), null);
    assert.equal(await handleLoginRequest(get("/v1/teams"), deps()), null);
  });
});

// --- the page ---------------------------------------------------------------

test("the bare login domain says where you are", async () => {
  await withEnv({}, async () => {
    const res = await handleLoginRequest(get("/"), deps());
    assert.equal(res?.status, 200);
    assert.match(await res!.text(), /请从你要访问的应用地址进入/);
  });
});

test("the bare login domain names the signed-in account", async () => {
  await withEnv({}, async () => {
    const { token } = await mintSsoSession({ sub: "u-1", email: "who@example.com" });
    const res = await handleLoginRequest(get("/", { cookie: `${SSO_COOKIE}=${token}` }), deps());
    const html = await res!.text();
    assert.match(html, /已登录/);
    assert.match(html, /who@example\.com/);
  });
});

test("an unauthenticated visitor gets the email form", async () => {
  await withEnv({}, async () => {
    const res = await handleLoginRequest(
      get(`/?app=${APP_ID}&next=%2Freport`),
      deps(),
    );
    assert.equal(res?.status, 200);
    const html = await res!.text();
    assert.match(html, /发送验证码/);
    assert.match(html, /action="\/otp"/);
    // The flow parameters survive into the form or the second post loses them.
    assert.match(html, new RegExp(`name="app" value="${APP_ID}"`));
    assert.match(html, /name="next" value="\/report"/);
    assert.equal(res!.headers.get("cache-control"), "no-store");
  });
});

// --- SSO --------------------------------------------------------------------

test("an existing SSO session skips the form and bounces with a code", async () => {
  await withEnv({}, async () => {
    const { token } = await mintSsoSession({ sub: "u-7", email: "sso@example.com" });
    const res = await handleLoginRequest(
      get(`/?app=${APP_ID}&next=%2Fdash`, { cookie: `${SSO_COOKIE}=${token}` }),
      deps(),
    );
    assert.equal(res?.status, 302);
    const location = new URL(res!.headers.get("location")!);
    assert.equal(location.origin, ORIGIN);
    assert.equal(location.pathname, APP_AUTH_CALLBACK_PATH);
    assert.equal(location.searchParams.get("next"), "/dash");

    const claims = await consumeAuthCode(location.searchParams.get("code")!, {
      appId: APP_ID,
      redirect: ORIGIN,
    });
    assert.equal(claims?.sub, "u-7");
    assert.equal(claims?.email, "sso@example.com");
  });
});

// --- app resolution ---------------------------------------------------------

test("a missing app and a login-less app answer identically", async () => {
  await withEnv({}, async () => {
    const missing = await handleLoginRequest(
      get("/?app=99999999-2222-3333-4444-555555555555"),
      deps(),
    );
    const noLogin = await handleLoginRequest(
      get(`/?app=${APP_ID}`),
      deps({ lookupApp: async () => ({ ...APP, authMode: "none" }) }),
    );
    assert.equal(missing?.status, 404);
    assert.equal(noLogin?.status, 404);
    // Identical bodies: differing ones would make this an app-existence oracle.
    assert.equal(await missing!.text(), await noLogin!.text());
  });
});

test("a deployment with no apps domain cannot log anyone in", async () => {
  await withEnv({ APPS_PUBLIC_DOMAIN: undefined }, async () => {
    const res = await handleLoginRequest(get(`/?app=${APP_ID}`), deps());
    assert.equal(res?.status, 400);
    assert.match(await res!.text(), /没有配置应用域名/);
  });
});

// --- open redirect (R9) -----------------------------------------------------

test("a return address that is not this app's is refused, not rewritten", async () => {
  await withEnv({}, async () => {
    for (const r of [
      "https://evil.example.com",
      "https://report-11111111.apps.example.com.evil.com",
      "http://report-11111111.apps.example.com",
      "//evil.example.com",
    ]) {
      const res = await handleLoginRequest(
        get(`/?app=${APP_ID}&r=${encodeURIComponent(r)}`),
        deps(),
      );
      assert.equal(res?.status, 400, `must refuse r=${r}`);
      assert.match(await res!.text(), /返回地址与该应用不符/);
    }
  });
});

test("the app's own origin is accepted, with or without a trailing slash", async () => {
  await withEnv({}, async () => {
    for (const r of [ORIGIN, `${ORIGIN}/`]) {
      const res = await handleLoginRequest(
        get(`/?app=${APP_ID}&r=${encodeURIComponent(r)}`),
        deps(),
      );
      assert.equal(res?.status, 200);
    }
  });
});

test("next cannot leave the app", async () => {
  await withEnv({}, async () => {
    const { token } = await mintSsoSession({ sub: "u", email: "e@example.com" });
    for (const [next, expected] of [
      ["//evil.example.com", "/"],
      ["https://evil.example.com", "/"],
      ["/a\\b", "/"],
      ["not-a-path", "/"],
      ["/ok/path?q=1", "/ok/path?q=1"],
    ]) {
      const res = await handleLoginRequest(
        get(`/?app=${APP_ID}&next=${encodeURIComponent(next)}`, {
          cookie: `${SSO_COOKIE}=${token}`,
        }),
        deps(),
      );
      const location = new URL(res!.headers.get("location")!);
      assert.equal(location.searchParams.get("next"), expected, `next=${next}`);
    }
  });
});

// --- sending the code -------------------------------------------------------

test("posting an email asks GoTrue to create the user if new", async () => {
  await withEnv({}, async () => {
    const d = deps();
    const res = await handleLoginRequest(post("/otp", { ...flow, email: "New@Example.com " }), d);
    assert.equal(res?.status, 200);
    assert.match(await res!.text(), /输入验证码/);

    assert.equal(d.calls.length, 1);
    assert.equal(d.calls[0].url, "http://kong:8000/auth/v1/otp");
    // Registering the visitor into our Supabase is the whole point of the
    // feature, so create_user must be explicit rather than left to a default.
    assert.deepEqual(d.calls[0].body, { email: "new@example.com", create_user: true });
  });
});

test("a malformed email never reaches GoTrue", async () => {
  await withEnv({}, async () => {
    const d = deps();
    const res = await handleLoginRequest(post("/otp", { ...flow, email: "nope" }), d);
    assert.equal(res?.status, 400);
    assert.equal(d.calls.length, 0);
  });
});

test("the send endpoint is rate limited per address", async () => {
  await withEnv({}, async () => {
    const seen: string[] = [];
    const d = deps({
      rateLimited: (key, max) => {
        seen.push(`${key}|${max}`);
        return true;
      },
    });
    const res = await handleLoginRequest(
      post("/otp", { ...flow, email: "a@example.com" }, { "x-forwarded-for": "203.0.113.9" }),
      d,
    );
    assert.equal(res?.status, 429);
    assert.equal(d.calls.length, 0, "a limited request must not send mail");
    // Keyed on IP AND address: either alone lets one of the two abuse shapes
    // through (one victim from many hosts, or many victims from one host).
    assert.match(seen[0], /203\.0\.113\.9/);
    assert.match(seen[0], /a@example\.com/);
  });
});

test("GoTrue's own wording never reaches the visitor", async () => {
  await withEnv({}, async () => {
    const d = deps({
      gotrue: () =>
        new Response(JSON.stringify({ msg: "signups not allowed for otp on host kong:8000" }), {
          status: 422,
        }),
    });
    const res = await handleLoginRequest(post("/otp", { ...flow, email: "a@example.com" }), d);
    assert.equal(res?.status, 400);
    const html = await res!.text();
    assert.doesNotMatch(html, /kong/);
    assert.doesNotMatch(html, /signups not allowed/);
    assert.match(html, /无法接收验证码/);
  });
});

test("an unreachable GoTrue is a 503, not a login page that pretends", async () => {
  await withEnv({}, async () => {
    const d = deps({
      gotrue: () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const res = await handleLoginRequest(post("/otp", { ...flow, email: "a@example.com" }), d);
    assert.equal(res?.status, 503);
    assert.match(await res!.text(), /暂时不可用/);
  });
});

// --- verifying the code -----------------------------------------------------

test("a correct code sets the SSO cookie and bounces with a code", async () => {
  await withEnv({}, async () => {
    const d = deps({
      gotrue: () =>
        new Response(JSON.stringify({ user: { id: "u-42", email: "real@example.com" } }), {
          status: 200,
        }),
    });
    const res = await handleLoginRequest(
      post("/verify", { ...flow, email: "typed@example.com", code: "123456" }),
      d,
    );
    assert.equal(res?.status, 302);
    assert.deepEqual(d.calls[0].body, {
      type: "email",
      email: "typed@example.com",
      token: "123456",
    });

    const cookie = res!.headers.get("set-cookie")!;
    assert.match(cookie, new RegExp(`^${SSO_COOKIE}=`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);

    const location = new URL(res!.headers.get("location")!);
    const claims = await consumeAuthCode(location.searchParams.get("code")!, {
      appId: APP_ID,
      redirect: ORIGIN,
    });
    // The identity comes from GoTrue's answer, not from what was typed in.
    assert.equal(claims?.sub, "u-42");
    assert.equal(claims?.email, "real@example.com");
  });
});

test("a wrong code does not set a cookie", async () => {
  await withEnv({}, async () => {
    const d = deps({
      gotrue: () => new Response(JSON.stringify({ msg: "Token has expired" }), { status: 403 }),
    });
    const res = await handleLoginRequest(
      post("/verify", { ...flow, email: "a@example.com", code: "000000" }),
      d,
    );
    assert.equal(res?.status, 400);
    assert.equal(res!.headers.get("set-cookie"), null);
    const html = await res!.text();
    assert.match(html, /验证码不正确或已过期/);
    // Still on the code step, with the address kept, so the visitor can retype
    // the code instead of starting over.
    assert.match(html, /action="\/verify"/);
    assert.match(html, /name="email" value="a@example\.com"/);
  });
});

test("a 200 with no user is treated as unavailable, not as a login", async () => {
  await withEnv({}, async () => {
    const d = deps({ gotrue: () => new Response(JSON.stringify({}), { status: 200 }) });
    const res = await handleLoginRequest(
      post("/verify", { ...flow, email: "a@example.com", code: "123456" }),
      d,
    );
    assert.equal(res?.status, 503);
    assert.equal(res!.headers.get("set-cookie"), null);
  });
});

test("verify refuses a foreign return address before calling GoTrue", async () => {
  await withEnv({}, async () => {
    const d = deps();
    const res = await handleLoginRequest(
      post("/verify", {
        app: APP_ID,
        r: "https://evil.example.com",
        next: "/",
        email: "a@example.com",
        code: "123456",
      }),
      d,
    );
    assert.equal(res?.status, 400);
    assert.equal(d.calls.length, 0);
  });
});

// --- logout -----------------------------------------------------------------

test("logout expires the SSO cookie", async () => {
  await withEnv({}, async () => {
    const res = await handleLoginRequest(post("/logout", {}), deps());
    assert.equal(res?.status, 302);
    const cookie = res!.headers.get("set-cookie")!;
    assert.match(cookie, new RegExp(`^${SSO_COOKIE}=;`));
    assert.match(cookie, /Max-Age=0/);
  });
});

test("a plain-http box gets cookies without Secure", async () => {
  await withEnv({}, async () => {
    const res = await handleLoginRequest(post("/logout", {}), deps({ secureCookies: false }));
    assert.doesNotMatch(res!.headers.get("set-cookie")!, /Secure/);
  });
});

test("GET on a POST-only path restarts the flow instead of erroring", async () => {
  await withEnv({}, async () => {
    const res = await handleLoginRequest(get("/verify"), deps());
    assert.equal(res?.status, 302);
    assert.equal(res!.headers.get("location"), "/");
  });
});

// --- escaping ---------------------------------------------------------------

test("an address containing markup cannot break out of the page", async () => {
  await withEnv({}, async () => {
    const nasty = `"><script>alert(1)</script>@example.com`;
    const res = await handleLoginRequest(post("/otp", { ...flow, email: nasty }), deps());
    const html = await res!.text();
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });
});
