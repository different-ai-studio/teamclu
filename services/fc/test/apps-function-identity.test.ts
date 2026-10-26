import { test } from "node:test";
import assert from "node:assert/strict";
import { appManagedOriginHost, readFunctionNamingMode, resolveAppFunctionName } from "../src/lib/apps-function-identity.js";
import { ApiError } from "../src/lib/http-utils.js";
const appId = "00000000-0000-4000-8000-000000000001";
const code = "a-p35cg2kk6bh3";
const target = { appId, slug: "demo", appCode: code, functionNamingMode: "app_code" as const };
const env = { APPS_FC_ROUTE_DOMAIN: " origins.test " };
const invalid = (e: unknown) => e instanceof ApiError && e.statusCode === 409 && e.code === "invalid_app_function_identity" && !e.message.includes("secret");
test("code identity ignores slug, public-domain mode and historical fallback", () => {
  for (const slug of ["demo", "中文名称", "renamed", "", null]) for (const usesAppCodeDomain of [true, false]) {
    const app = { ...target, slug, usesAppCodeDomain };
    assert.equal(resolveAppFunctionName(app), code);
    assert.equal(resolveAppFunctionName({ ...app, fcFunctionName: code, legacyFallback: "uuid" }), code);
    assert.equal(appManagedOriginHost(app, env), "a-p35cg2kk6bh3.origins.test");
  }
  assert.equal(appManagedOriginHost(target, {}), null);
});
test("malformed code identities fail closed even without configured domain", () => {
  for (const appCode of [undefined, null, "", "p35cg2kk6bh3", "A-P35CG2KK6BH3", "a-secretinvalid", " a-p35cg2kk6bh3"]) {
    const app = { ...target, appCode };
    assert.throws(() => resolveAppFunctionName(app), invalid);
    assert.throws(() => appManagedOriginHost(app, {}), invalid);
  }
  assert.throws(() => resolveAppFunctionName({ ...target, fcFunctionName: "secret-other" }), invalid);
});
test("absent mode is legacy but explicit invalid modes fail closed", () => {
  assert.equal(readFunctionNamingMode(undefined), "legacy");
  assert.equal(readFunctionNamingMode("legacy"), "legacy");
  assert.equal(readFunctionNamingMode("app_code"), "app_code");
  for (const mode of [null, "", "secret-mode", true, 1, {}]) {
    assert.throws(() => readFunctionNamingMode(mode), invalid);
    const app = { ...target, functionNamingMode: mode } as unknown as typeof target;
    assert.throws(() => resolveAppFunctionName(app), invalid);
    assert.throws(() => appManagedOriginHost(app, {}), invalid);
  }
});
test("legacy identity preserves resources and allocation versus historical fallbacks", () => {
  for (const functionNamingMode of [undefined, "legacy"] as const) {
    const app = { appId, slug: "demo", appCode: code, functionNamingMode };
    assert.equal(resolveAppFunctionName({ ...app, fcFunctionName: "existing" }), "existing");
    assert.equal(resolveAppFunctionName(app), "demo-00000000");
    assert.equal(resolveAppFunctionName({ ...app, fcFunctionName: "" }), "demo-00000000");
    assert.equal(resolveAppFunctionName({ ...app, legacyFallback: "uuid" }), `tc-app-${appId}`);
    assert.equal(appManagedOriginHost(app, env), "demo-00000000.origins.test");
    assert.equal(appManagedOriginHost(app, {}), null);
  }
  for (const slug of [null, "", "2048-game", "x".repeat(200)]) assert.equal(resolveAppFunctionName({ appId, slug }), `tc-app-${appId}`);
  assert.equal(appManagedOriginHost({ appId, slug: null }, env), null);
  assert.equal(appManagedOriginHost({ appId, slug: "x".repeat(200) }, env), null);
});
