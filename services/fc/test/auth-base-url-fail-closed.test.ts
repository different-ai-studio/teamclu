import { test } from "node:test";
import assert from "node:assert/strict";
import { authBaseURL } from "../src/auth/base-url.js";

// Regression guard. AUTH_BASE_URL used to default to a hosted host that has
// since been deleted, in three separate places. A blank value therefore minted
// JWTs with a bogus issuer and fetched JWKS from a dead domain — surfacing as a
// confusing token-verification failure rather than a config error. Pin the
// fail-closed behaviour so no default creeps back in.

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.AUTH_BASE_URL;
  if (value === undefined) delete process.env.AUTH_BASE_URL;
  else process.env.AUTH_BASE_URL = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.AUTH_BASE_URL;
    else process.env.AUTH_BASE_URL = prev;
  }
}

test("authBaseURL: unset throws instead of returning a hosted default", () => {
  withEnv(undefined, () => {
    assert.throws(() => authBaseURL(), /AUTH_BASE_URL is not set/);
  });
});

test("authBaseURL: blank and whitespace-only are treated as unset", () => {
  for (const blank of ["", "   "]) {
    withEnv(blank, () => {
      assert.throws(() => authBaseURL(), /AUTH_BASE_URL is not set/);
    });
  }
});

test("authBaseURL: env value is returned trimmed", () => {
  withEnv("  https://api.teamclu-dev.ucar.cc  ", () => {
    assert.equal(authBaseURL(), "https://api.teamclu-dev.ucar.cc");
  });
});

test("authBaseURL: an explicit argument wins over the env var", () => {
  // buildPlatformOAuthEnv passes an already-resolved value; it must take
  // precedence over the ambient env.
  withEnv("https://from-env.example", () => {
    assert.equal(authBaseURL("https://explicit.example"), "https://explicit.example");
  });
});

test("authBaseURL: a blank explicit argument falls back to the env var", () => {
  // opts.baseURL is optional at every call site, so undefined must defer to the
  // env rather than throw.
  withEnv("https://from-env.example", () => {
    assert.equal(authBaseURL(undefined), "https://from-env.example");
  });
});
