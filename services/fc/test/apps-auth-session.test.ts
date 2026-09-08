import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_COOKIE,
  APP_RENEW_WINDOW_SECONDS,
  SSO_COOKIE,
  __resetSpentCodes,
  clearSessionCookie,
  consumeAuthCode,
  mintAppSession,
  mintAuthCode,
  mintSsoSession,
  readCookie,
  serializeSessionCookie,
  shouldRenew,
  verifyAppSession,
  verifySsoSession,
} from "../src/lib/apps-auth-session.js";
import { ApiError } from "../src/lib/http-utils.js";

const SECRET = "apps-auth-test-secret-at-least-32-characters-long";
const OTHER_SECRET = "apps-auth-other-secret-at-least-32-characters-long";

/**
 * `node --test` isolates each test FILE in its own process, so mutating
 * process.env here cannot reach another suite — but tests inside this file run
 * in order and share it, hence the save/restore.
 */
async function withEnv(
  env: Record<string, string | undefined>,
  body: () => Promise<void> | void,
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
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

const signed = (secret = SECRET) => ({
  APPS_AUTH_SESSION_SECRET: secret,
  SUPABASE_SERVICE_ROLE_KEY: undefined,
});

/**
 * Swap in another token's signature.
 *
 * Deliberately NOT "flip the last character": base64url's final character
 * encodes fewer than 6 significant bits, so some flips decode to the same
 * bytes and the tampered token still verifies. That exact mistake made
 * `agent-management-grant` flaky at ~5%.
 */
function withForeignSignature(token: string, donor: string): string {
  const [h, p] = token.split(".");
  const donorSig = donor.split(".")[2];
  return `${h}.${p}.${donorSig}`;
}

// --- round trips ------------------------------------------------------------

test("sso session round-trips", async () => {
  await withEnv(signed(), async () => {
    const { token } = await mintSsoSession({ sub: "user-1", email: "a@example.com" });
    assert.deepEqual(await verifySsoSession(token), {
      sub: "user-1",
      email: "a@example.com",
    });
  });
});

test("app session round-trips and carries the app id", async () => {
  await withEnv(signed(), async () => {
    const { token } = await mintAppSession({
      sub: "user-1",
      email: "a@example.com",
      appId: "app-1",
    });
    assert.deepEqual(await verifyAppSession(token, "app-1"), {
      sub: "user-1",
      email: "a@example.com",
      appId: "app-1",
    });
  });
});

test("auth code round-trips through a single redemption", async () => {
  await withEnv(signed(), async () => {
    const { token } = await mintAuthCode({
      sub: "user-1",
      email: "a@example.com",
      appId: "app-1",
      redirect: "https://app.example.com",
    });
    const claims = await consumeAuthCode(token, {
      appId: "app-1",
      redirect: "https://app.example.com",
    });
    assert.equal(claims?.sub, "user-1");
    assert.equal(claims?.appId, "app-1");
    assert.equal(typeof claims?.jti, "string");
  });
});

// --- expiry -----------------------------------------------------------------

test("an expired ticket does not verify", async () => {
  await withEnv(signed(), async () => {
    const sso = await mintSsoSession({ sub: "u", email: "e@example.com" }, -60);
    assert.equal(await verifySsoSession(sso.token), null);

    const app = await mintAppSession({ sub: "u", email: "e@example.com", appId: "app-1" }, -60);
    assert.equal(await verifyAppSession(app.token, "app-1"), null);

    const code = await mintAuthCode(
      { sub: "u", email: "e@example.com", appId: "app-1", redirect: "https://a.example.com" },
      -60,
    );
    assert.equal(
      await consumeAuthCode(code.token, { appId: "app-1", redirect: "https://a.example.com" }),
      null,
    );
  });
});

// --- replay -----------------------------------------------------------------

test("an auth code cannot be redeemed twice", async () => {
  await withEnv(signed(), async () => {
    const { token } = await mintAuthCode({
      sub: "user-1",
      email: "a@example.com",
      appId: "app-1",
      redirect: "https://app.example.com",
    });
    const expected = { appId: "app-1", redirect: "https://app.example.com" };
    assert.ok(await consumeAuthCode(token, expected));
    assert.equal(await consumeAuthCode(token, expected), null);
  });
});

test("two codes minted from identical claims are independently redeemable", async () => {
  // Guards the `jti` being generated per-mint: a caller-supplied or derived id
  // would make the second login of the same user into a replay.
  await withEnv(signed(), async () => {
    const claims = {
      sub: "user-1",
      email: "a@example.com",
      appId: "app-1",
      redirect: "https://app.example.com",
    };
    const first = await mintAuthCode(claims);
    const second = await mintAuthCode(claims);
    const expected = { appId: "app-1", redirect: "https://app.example.com" };
    assert.ok(await consumeAuthCode(first.token, expected));
    assert.ok(await consumeAuthCode(second.token, expected));
  });
});

// --- binding: app id and redirect origin ------------------------------------

test("an app session minted for one app is rejected on another", async () => {
  await withEnv(signed(), async () => {
    const { token } = await mintAppSession({
      sub: "user-1",
      email: "a@example.com",
      appId: "app-1",
    });
    assert.equal(await verifyAppSession(token, "app-2"), null);
    assert.equal(await verifyAppSession(token, ""), null);
  });
});

test("a code is rejected on the wrong app or the wrong origin", async () => {
  await withEnv(signed(), async () => {
    const mk = () =>
      mintAuthCode({
        sub: "user-1",
        email: "a@example.com",
        appId: "app-1",
        redirect: "https://app.example.com",
      });

    const wrongApp = await mk();
    assert.equal(
      await consumeAuthCode(wrongApp.token, {
        appId: "app-2",
        redirect: "https://app.example.com",
      }),
      null,
    );

    const wrongOrigin = await mk();
    assert.equal(
      await consumeAuthCode(wrongOrigin.token, {
        appId: "app-1",
        redirect: "https://evil.example.com",
      }),
      null,
    );
  });
});

test("a failed redemption does not burn the code", async () => {
  // Order matters in consumeAuthCode: burning the jti before checking the app
  // and origin would let anyone holding a code kill a legitimate login by
  // redeeming it against the wrong origin.
  await withEnv(signed(), async () => {
    const { token } = await mintAuthCode({
      sub: "user-1",
      email: "a@example.com",
      appId: "app-1",
      redirect: "https://app.example.com",
    });
    assert.equal(
      await consumeAuthCode(token, { appId: "app-1", redirect: "https://evil.example.com" }),
      null,
    );
    assert.ok(
      await consumeAuthCode(token, { appId: "app-1", redirect: "https://app.example.com" }),
      "the real redirect must still work after a tampered attempt",
    );
  });
});

// --- audience separation ----------------------------------------------------

test("ticket kinds are not interchangeable", async () => {
  await withEnv(signed(), async () => {
    const sso = await mintSsoSession({ sub: "u", email: "e@example.com" });
    const app = await mintAppSession({ sub: "u", email: "e@example.com", appId: "app-1" });
    const code = await mintAuthCode({
      sub: "u",
      email: "e@example.com",
      appId: "app-1",
      redirect: "https://app.example.com",
    });
    const expected = { appId: "app-1", redirect: "https://app.example.com" };

    // An SSO cookie lifted off the central domain must not open an app.
    assert.equal(await verifyAppSession(sso.token, "app-1"), null);
    assert.equal(await consumeAuthCode(sso.token, expected), null);
    // Nor the other way round.
    assert.equal(await verifySsoSession(app.token), null);
    assert.equal(await verifySsoSession(code.token), null);
    assert.equal(await verifyAppSession(code.token, "app-1"), null);
  });
});

// --- tampering and key changes ----------------------------------------------

test("a tampered signature does not verify", async () => {
  await withEnv(signed(), async () => {
    const real = await mintAppSession({ sub: "u", email: "e@example.com", appId: "app-1" });
    const donor = await mintAppSession({ sub: "other", email: "o@example.com", appId: "app-1" });
    const forged = withForeignSignature(real.token, donor.token);
    assert.notEqual(forged, real.token);
    assert.equal(await verifyAppSession(forged, "app-1"), null);
  });
});

test("a ticket signed with another secret does not verify", async () => {
  let token = "";
  await withEnv(signed(SECRET), async () => {
    token = (await mintAppSession({ sub: "u", email: "e@example.com", appId: "app-1" })).token;
  });
  await withEnv(signed(OTHER_SECRET), async () => {
    assert.equal(await verifyAppSession(token, "app-1"), null);
  });
});

test("empty and malformed tokens are simply not logged in", async () => {
  await withEnv(signed(), async () => {
    assert.equal(await verifySsoSession(""), null);
    assert.equal(await verifyAppSession("", "app-1"), null);
    assert.equal(await verifyAppSession("not-a-jwt", "app-1"), null);
    assert.equal(
      await consumeAuthCode("a.b.c", { appId: "app-1", redirect: "https://app.example.com" }),
      null,
    );
  });
});

// --- key derivation ---------------------------------------------------------

test("the key is derived from the service role key when no explicit secret is set", async () => {
  await withEnv(
    { APPS_AUTH_SESSION_SECRET: undefined, SUPABASE_SERVICE_ROLE_KEY: "service-role-key-value" },
    async () => {
      const { token } = await mintSsoSession({ sub: "u", email: "e@example.com" });
      assert.deepEqual(await verifySsoSession(token), { sub: "u", email: "e@example.com" });
    },
  );
});

test("derivation and an explicit secret produce different keys", async () => {
  let derived = "";
  await withEnv(
    { APPS_AUTH_SESSION_SECRET: undefined, SUPABASE_SERVICE_ROLE_KEY: SECRET },
    async () => {
      derived = (await mintSsoSession({ sub: "u", email: "e@example.com" })).token;
    },
  );
  // Same input string, but HKDF means the signing key is not the raw value.
  await withEnv(signed(SECRET), async () => {
    assert.equal(await verifySsoSession(derived), null);
  });
});

test("no secret at all is a 503, not an anonymous visitor", async () => {
  await withEnv(
    { APPS_AUTH_SESSION_SECRET: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined },
    async () => {
      await assert.rejects(
        () => mintSsoSession({ sub: "u", email: "e@example.com" }),
        (e: unknown) => e instanceof ApiError && e.statusCode === 503,
      );
      // Verification must throw too — answering "not logged in" on a
      // misconfigured box would bounce every visitor into a redirect loop.
      await assert.rejects(
        () => verifyAppSession("whatever", "app-1"),
        (e: unknown) => e instanceof ApiError && e.statusCode === 503,
      );
    },
  );
});

test("a too-short explicit secret is refused", async () => {
  await withEnv({ APPS_AUTH_SESSION_SECRET: "short", SUPABASE_SERVICE_ROLE_KEY: undefined }, async () => {
    await assert.rejects(
      () => mintSsoSession({ sub: "u", email: "e@example.com" }),
      (e: unknown) => e instanceof ApiError && e.statusCode === 503,
    );
  });
});

// --- cookies ----------------------------------------------------------------

test("session cookies are host-scoped and not readable from script", () => {
  const cookie = serializeSessionCookie(APP_COOKIE, "token-value", 3600);
  assert.match(cookie, /^__teamclu_app_session=token-value; /);
  assert.ok(cookie.includes("HttpOnly"));
  assert.ok(cookie.includes("Secure"));
  assert.ok(cookie.includes("SameSite=Lax"));
  assert.ok(cookie.includes("Max-Age=3600"));
  // No Domain: the cookie belongs to exactly the host that set it, which is
  // what keeps one app's session off every other app under *.apps.<domain>.
  assert.ok(!/Domain=/i.test(cookie));
});

test("a plain-http box can opt out of Secure", () => {
  const cookie = serializeSessionCookie(SSO_COOKIE, "v", 60, false);
  assert.ok(!cookie.includes("Secure"));
  assert.ok(cookie.includes("HttpOnly"));
});

test("clearing a cookie keeps the attributes that identify it", () => {
  const cleared = clearSessionCookie(APP_COOKIE);
  assert.ok(cleared.startsWith(`${APP_COOKIE}=;`));
  assert.ok(cleared.includes("Max-Age=0"));
  assert.ok(cleared.includes("Path=/"));
});

test("readCookie picks the named cookie out of a header", () => {
  const header = `other=1; ${APP_COOKIE}=abc.def.ghi; trailing=2`;
  assert.equal(readCookie(header, APP_COOKIE), "abc.def.ghi");
  assert.equal(readCookie(header, "other"), "1");
  assert.equal(readCookie(header, "absent"), null);
  assert.equal(readCookie(undefined, APP_COOKIE), null);
  assert.equal(readCookie("", APP_COOKIE), null);
});

test("readCookie keeps a value containing '='", () => {
  assert.equal(readCookie("k=a=b=c", "k"), "a=b=c");
});

test("readCookie does not match on a prefix of the name", () => {
  assert.equal(readCookie(`${APP_COOKIE}_other=nope`, APP_COOKIE), null);
});

// --- sliding renewal --------------------------------------------------------

test("shouldRenew fires only inside the renewal window", () => {
  const now = 1_000_000;
  assert.equal(shouldRenew(now + APP_RENEW_WINDOW_SECONDS + 60, now), false);
  assert.equal(shouldRenew(now + APP_RENEW_WINDOW_SECONDS - 60, now), true);
  // Already expired counts as "renew" — the caller re-mints rather than
  // leaving the visitor with a dead cookie.
  assert.equal(shouldRenew(now - 1, now), true);
});
