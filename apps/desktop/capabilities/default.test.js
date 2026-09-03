"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const caps = JSON.parse(
  fs.readFileSync(path.join(__dirname, "default.json"), "utf8"),
);
const tauriConf = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "tauri.conf.json"), "utf8"),
);

// Cold-start session deeplinks on macOS land in the deep-link plugin's
// `current` slot before the webview mounts. The frontend recovers them via
// `getCurrent()`, which requires this ACL permission. Without it the invoke
// is denied, the catch in App.tsx swallows the error, and the first open only
// launches the app.
test("default capabilities allow deep-link getCurrent for cold-start URLs", () => {
  assert.ok(
    Array.isArray(caps.permissions) && caps.permissions.includes("deep-link:default"),
    'expected "deep-link:default" in apps/desktop/capabilities/default.json permissions',
  );
});

// The permissions in this capability include every IPC command plus fs
// read/write/remove/rename over `/**`. `remote.urls` is the switch that lets a
// non-app origin use them, so an in-app browser tab pointed at any URL would
// inherit the lot.
test("default capabilities grant nothing to remote origins", () => {
  assert.equal(
    caps.remote,
    undefined,
    "apps/desktop/capabilities/default.json must not declare `remote` — it would expose every IPC command to arbitrary web pages loaded in wv-* webviews",
  );
});

// `wv-*` webviews are built from a caller-supplied URL as WebviewUrl::External
// (commands/webview.rs, webview_create). They must not appear in a capability
// that carries IPC or fs permissions.
test("default capabilities cover app-origin webviews only", () => {
  const allowed = ["main", "ws-*", "local-agent-panel"];
  assert.deepEqual(
    caps.webviews,
    allowed,
    `apps/desktop/capabilities/default.json webviews must stay ${JSON.stringify(allowed)} — every entry loads TeamClu's own frontend. Third-party content (wv-*, websso-login) must not be listed.`,
  );
  for (const label of caps.webviews.concat(caps.windows ?? [])) {
    assert.ok(
      !label.startsWith("wv-") && label !== "*",
      `"${label}" matches externally-navigated webviews; it must not hold these permissions`,
    );
  }
});

// A single XSS in the frontend would otherwise inherit the full IPC surface.
test("production CSP blocks inline and remote script execution", () => {
  const csp = tauriConf.app?.security?.csp;
  assert.equal(typeof csp, "string", "app.security.csp must be set, not null");

  const scriptSrc = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src"));
  assert.ok(scriptSrc, "CSP must define script-src");

  for (const unsafe of ["'unsafe-inline'", "'unsafe-eval'", "*", "https:", "http:"]) {
    assert.ok(
      !scriptSrc.split(/\s+/).includes(unsafe),
      `script-src must not allow ${unsafe} — found in: ${scriptSrc}`,
    );
  }
  assert.ok(
    csp.includes("object-src 'none'"),
    "CSP must set object-src 'none'",
  );
  assert.ok(
    csp.includes("base-uri 'self'"),
    "CSP must set base-uri 'self'",
  );
});

// Tauri nonces the inline <style> in index.html, and a nonce in style-src makes
// the browser ignore 'unsafe-inline' — which would drop every `style="..."`
// attribute, including Shiki's per-token colors rendered through
// dangerouslySetInnerHTML. style-src is not the XSS execution vector; script-src
// is, and that one stays strict.
test("style-src keeps unsafe-inline effective", () => {
  const csp = tauriConf.app?.security?.csp ?? "";
  assert.ok(
    csp.includes("style-src") && csp.includes("'unsafe-inline'"),
    "style-src must keep 'unsafe-inline'",
  );
  assert.deepEqual(
    tauriConf.app?.security?.dangerousDisableAssetCspModification,
    ["style-src"],
    "Tauri must be told not to inject a style nonce, or 'unsafe-inline' above is silently ignored",
  );
});

// SEC-2 / ADR-0009. The asset protocol was enabled with a whole-disk scope
// (`$HOME/**` + `/**`), which let anything rendered in the app origin fetch any
// file on the machine through `asset:`. Nothing used it: there is not one
// `convertFileSrc` call or `asset:` URL in the client. Binary reads go through
// the `read_workspace_binary_file` command instead, which validates the path in
// Rust and returns base64.
//
// Unlike the fs scope, `assetProtocol.scope` is compile-time static — it cannot
// be extended at runtime — so re-enabling it for one feature means granting a
// fixed set of roots to every surface in the origin. Keep it off; route new
// binary reads through a command.
test("the asset protocol stays disabled", () => {
  const assetProtocol = tauriConf.app?.security?.assetProtocol ?? {};
  assert.equal(
    assetProtocol.enable,
    false,
    "assetProtocol.enable must stay false — see ADR-0009",
  );
  assert.deepEqual(
    assetProtocol.scope ?? [],
    [],
    "assetProtocol.scope must stay empty while the protocol is disabled",
  );
});

test("no CSP directive still admits asset:", () => {
  for (const key of ["csp", "devCsp"]) {
    const csp = tauriConf.app?.security?.[key] ?? "";
    assert.ok(
      !csp.includes("asset:") && !csp.includes("asset.localhost"),
      `${key} must not mention asset: or asset.localhost — the protocol is disabled`,
    );
  }
});
