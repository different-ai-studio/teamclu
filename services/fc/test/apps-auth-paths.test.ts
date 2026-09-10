import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRulePath,
  parseAuthRules,
  parseAuthScope,
  resolvePathPolicy,
  validateAuthPathConfig,
} from "../src/lib/apps-auth-paths.js";
import { ApiError } from "../src/lib/http-utils.js";

const rejects = (fn: () => unknown, match?: RegExp) => {
  assert.throws(fn, (e: unknown) => {
    if (!(e instanceof ApiError) || e.statusCode !== 400) return false;
    return match ? match.test(String(e.message)) : true;
  });
};

// --- writing: normalising a rule path ---------------------------------------

test("a trailing /* is honoured, not taken literally", () => {
  // The whole point: prefix matching already covers sub-paths, but `/admin/*`
  // is what people type, and matching it literally would protect nothing at
  // all while looking configured.
  assert.equal(normalizeRulePath("/admin/*"), "/admin");
  assert.equal(normalizeRulePath("/admin*"), "/admin");
  assert.equal(normalizeRulePath("/*"), "/");
});

test("a star anywhere else is refused rather than silently literal", () => {
  rejects(() => normalizeRulePath("/api/*/private"), /prefix/);
  rejects(() => normalizeRulePath("/*.json"), /prefix/);
});

test("paths are anchored and trailing slashes collapse", () => {
  assert.equal(normalizeRulePath("/admin/"), "/admin");
  assert.equal(normalizeRulePath("/admin///"), "/admin");
  assert.equal(normalizeRulePath("  /admin  "), "/admin");
  assert.equal(normalizeRulePath("/"), "/");
  rejects(() => normalizeRulePath("admin"), /start with/);
  rejects(() => normalizeRulePath(""), /start with/);
  rejects(() => normalizeRulePath(42), /string/);
});

// --- writing: the rule list --------------------------------------------------

test("a well-formed rule list round-trips", () => {
  assert.deepEqual(
    parseAuthRules([
      { path: "/api/", auth: "required" },
      { path: "/api/webhook/*", auth: "public" },
    ]),
    [
      { path: "/api", auth: "required" },
      { path: "/api/webhook", auth: "public" },
    ],
  );
  assert.deepEqual(parseAuthRules([]), []);
  assert.deepEqual(parseAuthRules(null), []);
});

test("a duplicate path is refused rather than resolved by position", () => {
  // Two verdicts for one path have no defensible winner, and picking one
  // quietly is how a rule set stops meaning what it reads like.
  rejects(
    () =>
      parseAuthRules([
        { path: "/api", auth: "required" },
        { path: "/API/", auth: "public" },
      ]),
    /duplicate/,
  );
});

test("malformed entries are refused", () => {
  rejects(() => parseAuthRules("nope"), /array/);
  rejects(() => parseAuthRules([{ path: "/a" }]), /required.*public|auth/);
  rejects(() => parseAuthRules([{ path: "/a", auth: "maybe" }]), /required.*public|auth/);
  rejects(() => parseAuthRules([null]), /object/);
  rejects(() => parseAuthRules(Array.from({ length: 51 }, (_, i) => ({ path: `/p${i}`, auth: "public" }))), /50/);
});

test("scope is one of two values", () => {
  assert.equal(parseAuthScope("all"), "all");
  assert.equal(parseAuthScope(" paths "), "paths");
  assert.equal(parseAuthScope(undefined), undefined);
  rejects(() => parseAuthScope("some"), /authScope/);
});

test("paths scope with nothing protected is refused", () => {
  // Otherwise the panel says "requires login" while every URL is public.
  rejects(
    () => validateAuthPathConfig("paths", [{ path: "/health", auth: "public" }]),
    /at least one/,
  );
  validateAuthPathConfig("paths", [{ path: "/admin", auth: "required" }]);
  validateAuthPathConfig("all", []);
});

// --- reading: the baseline ---------------------------------------------------

test("the all baseline protects everything", () => {
  assert.equal(resolvePathPolicy("/", "all", []).requiresLogin, true);
  assert.equal(resolvePathPolicy("/anything/deep", "all", []).requiresLogin, true);
});

test("the paths baseline leaves everything else public", () => {
  const rules = [{ path: "/admin", auth: "required" }];
  assert.equal(resolvePathPolicy("/", "paths", rules).requiresLogin, false);
  assert.equal(resolvePathPolicy("/pricing", "paths", rules).requiresLogin, false);
  assert.equal(resolvePathPolicy("/admin", "paths", rules).requiresLogin, true);
});

test("an unrecognised scope behaves as all", () => {
  assert.equal(resolvePathPolicy("/x", "PATHS", []).requiresLogin, true);
  assert.equal(resolvePathPolicy("/x", "", []).requiresLogin, true);
  assert.equal(resolvePathPolicy("/x", null, []).requiresLogin, true);
});

// --- reading: prefix semantics -----------------------------------------------

test("a prefix covers the path itself and everything under it", () => {
  const rules = [{ path: "/admin", auth: "required" }];
  for (const p of ["/admin", "/admin/", "/admin/users", "/admin/a/b/c"]) {
    assert.equal(resolvePathPolicy(p, "paths", rules).requiresLogin, true, p);
  }
});

test("a prefix stops at a path boundary", () => {
  // The classic off-by-one: /admin must not swallow /administrator.
  const rules = [{ path: "/admin", auth: "required" }];
  for (const p of ["/administrator", "/admins", "/admin-tools"]) {
    assert.equal(resolvePathPolicy(p, "paths", rules).requiresLogin, false, p);
  }
});

test("matching ignores case", () => {
  // A static file server on macOS or Windows answers /Admin with the same
  // bytes as /admin, so a case-sensitive match would leave that spelling open
  // on exactly the deployments where it resolves.
  const rules = [{ path: "/admin", auth: "required" }];
  assert.equal(resolvePathPolicy("/Admin/Users", "paths", rules).requiresLogin, true);
  assert.equal(resolvePathPolicy("/ADMIN", "paths", rules).requiresLogin, true);
});

// --- reading: longest prefix wins --------------------------------------------

test("the longest matching prefix wins, regardless of order", () => {
  const forward = [
    { path: "/api", auth: "required" },
    { path: "/api/webhook", auth: "public" },
  ];
  const reversed = [...forward].reverse();
  for (const rules of [forward, reversed]) {
    assert.equal(resolvePathPolicy("/api/users", "paths", rules).requiresLogin, true);
    assert.equal(resolvePathPolicy("/api/webhook", "paths", rules).requiresLogin, false);
    assert.equal(resolvePathPolicy("/api/webhook/stripe", "paths", rules).requiresLogin, false);
  }
});

test("a deeper exception can re-protect below a public one", () => {
  const rules = [
    { path: "/docs", auth: "public" },
    { path: "/docs/internal", auth: "required" },
  ];
  assert.equal(resolvePathPolicy("/docs/getting-started", "all", rules).requiresLogin, false);
  assert.equal(resolvePathPolicy("/docs/internal/runbook", "all", rules).requiresLogin, true);
});

test("a root rule is the least specific match, not the longest", () => {
  // "/" is one character but covers everything; scoring it by length would let
  // it beat a real prefix.
  const rules = [
    { path: "/", auth: "public" },
    { path: "/admin", auth: "required" },
  ];
  assert.equal(resolvePathPolicy("/", "all", rules).requiresLogin, false);
  assert.equal(resolvePathPolicy("/admin/x", "all", rules).requiresLogin, true);
});

// --- reading: fail closed ----------------------------------------------------

test("a path we cannot reason about is protected", () => {
  const rules = [{ path: "/admin", auth: "required" }];
  // URL.pathname resolves . and .. but does NOT decode %2F, so an app that
  // decodes it itself would serve something the prefix check never saw.
  for (const p of [
    "/public%2f..%2fadmin",
    "/public%2F..%2Fadmin",
    "/public%5cadmin",
    "/public%2e%2e/admin",
    "/public/../admin",
    "/public/./x",
    "/public\\admin",
  ]) {
    assert.equal(resolvePathPolicy(p, "paths", rules).requiresLogin, true, p);
  }
});

test("an unusable rule set protects everything", () => {
  // Writes are validated strictly, so reaching this means something wrote to
  // the column directly. A broken rule must never be the reason a protected
  // path became reachable.
  assert.equal(resolvePathPolicy("/x", "paths", "not-an-array").requiresLogin, true);
  assert.equal(resolvePathPolicy("/x", "paths", [{ path: "/x" }]).requiresLogin, true);
  assert.equal(resolvePathPolicy("/x", "paths", [{ path: "x", auth: "public" }]).requiresLogin, true);
  assert.equal(resolvePathPolicy("/x", "paths", [{ path: "/x", auth: "sometimes" }]).requiresLogin, true);
  assert.equal(resolvePathPolicy("/x", "paths", [null]).requiresLogin, true);
  // ...even when a good rule would have said public.
  assert.equal(
    resolvePathPolicy("/x", "paths", [{ path: "/x", auth: "public" }, 42]).requiresLogin,
    true,
  );
});

test("a missing rule column falls back to the baseline", () => {
  assert.equal(resolvePathPolicy("/x", "paths", null).requiresLogin, false);
  assert.equal(resolvePathPolicy("/x", "all", undefined).requiresLogin, true);
});

// --- per-path audience ------------------------------------------------------

test("a rule may name its own audience, and only on a protected path", () => {
  assert.deepEqual(
    parseAuthRules([
      { path: "/admin", auth: "required", audience: "org" },
      { path: "/", auth: "required", audience: "any" },
      // Public admits everyone by definition; an audience here would be a
      // setting the panel shows and the gateway ignores.
      { path: "/health", auth: "public", audience: "org" },
    ]),
    [
      { path: "/admin", auth: "required", audience: "org" },
      { path: "/", auth: "required", audience: "any" },
      { path: "/health", auth: "public" },
    ],
  );
});

test("an audience that is not one of the two is refused", () => {
  rejects(() => parseAuthRules([{ path: "/x", auth: "required", audience: "employees" }]), /audience/);
  rejects(() => parseAuthRules([{ path: "/x", auth: "required", audience: 1 }]), /audience/);
});

test("a rule with no audience stays without one, so the app's own value applies", () => {
  // The whole point: every rule stored before this key existed reads as
  // "inherit", never as a default that could tighten a live wall.
  assert.deepEqual(parseAuthRules([{ path: "/x", auth: "required" }]), [
    { path: "/x", auth: "required" },
  ]);
  assert.equal(resolvePathPolicy("/x", "all", [{ path: "/x", auth: "required" }]).audience, null);
});

test("the winning rule decides both the login and the audience", () => {
  const rules = [
    { path: "/", auth: "required", audience: "any" },
    { path: "/admin", auth: "required", audience: "org" },
  ];
  assert.deepEqual(resolvePathPolicy("/", "all", rules), { requiresLogin: true, audience: "any" });
  assert.deepEqual(resolvePathPolicy("/admin/users", "all", rules), {
    requiresLogin: true,
    audience: "org",
  });
});

test("a public path resolves no audience at all", () => {
  const policy = resolvePathPolicy("/health", "all", [{ path: "/health", auth: "public" }]);
  assert.deepEqual(policy, { requiresLogin: false, audience: null });
});

test("an unreadable audience invalidates the set, like an unreadable verdict", () => {
  const policy = resolvePathPolicy("/anything", "paths", [
    { path: "/x", auth: "required", audience: "everyone" },
  ]);
  assert.deepEqual(policy, { requiresLogin: true, audience: null });
});

test("the login verdict is exactly what it used to be", () => {
  // The point is that adding per-path audiences moved no verdict: the wall's
  // behaviour must not change with a feature that only adds a second answer.
  const rules = [{ path: "/health", auth: "public" }, { path: "/admin", auth: "required" }];
  assert.equal(resolvePathPolicy("/health", "all", rules).requiresLogin, false);
  assert.equal(resolvePathPolicy("/admin", "paths", rules).requiresLogin, true);
  assert.equal(resolvePathPolicy("/other", "paths", rules).requiresLogin, false);
  assert.equal(resolvePathPolicy("/other", "all", rules).requiresLogin, true);
});
