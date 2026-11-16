"use strict";

// An E2E desktop build (VITE_TEAMCLU_E2E=true) is driven over tauri-plugin-mcp,
// whose execute_js evaluates strings in the webview. The production CSP in
// tauri.conf.json (`app.security.csp`) forbids 'unsafe-eval', so a build made
// with plain `tauri build` answered every harness call with an EvalError —
// the documented recipe produced a binary nothing could drive. `tauri dev`
// already serves `devCsp`; an E2E build gets the same policy, and nothing else.

const fs = require("node:fs");
const path = require("node:path");

/**
 * Argv for `tauri <sub> ...` with the dev CSP merged in when this is an E2E
 * build. Placed right after the subcommand, so any --config the caller passes
 * later still wins (tauri merges --config values in order).
 */
function applyE2eCsp(args, env, confPath, log = console) {
  if (args[0] !== "build" || env.VITE_TEAMCLU_E2E !== "true") return args;
  let devCsp;
  try {
    devCsp = JSON.parse(fs.readFileSync(confPath, "utf8"))?.app?.security?.devCsp;
  } catch {
    devCsp = undefined;
  }
  if (typeof devCsp !== "string" || devCsp.length === 0) {
    log.log("[tauri-cli] E2E build: no app.security.devCsp to apply; keeping the production CSP");
    return args;
  }
  log.log("[tauri-cli] E2E build: using devCsp so the MCP harness can evaluate scripts");
  const overlay = JSON.stringify({ app: { security: { csp: devCsp } } });
  return [args[0], "--config", overlay, ...args.slice(1)];
}

module.exports = {
  applyE2eCsp,
  defaultConfPath: () => path.resolve(__dirname, "..", "..", "apps", "desktop", "tauri.conf.json"),
};
