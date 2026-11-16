const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { applyE2eCsp } = require("./e2e-csp");

const silent = { log: () => {} };
function conf(security) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-csp-"));
  const p = path.join(dir, "tauri.conf.json");
  fs.writeFileSync(p, JSON.stringify({ app: { security } }));
  return p;
}

test("an E2E build gets the dev CSP, before any --config of the caller", () => {
  const p = conf({ csp: "script-src 'self'", devCsp: "script-src 'self' 'unsafe-eval'" });
  const argv = applyE2eCsp(["build", "--debug", "--config", "{}"], { VITE_TEAMCLU_E2E: "true" }, p, silent);
  assert.equal(argv[0], "build");
  assert.equal(argv[1], "--config");
  assert.deepEqual(JSON.parse(argv[2]), { app: { security: { csp: "script-src 'self' 'unsafe-eval'" } } });
  assert.deepEqual(argv.slice(3), ["--debug", "--config", "{}"]);
});

test("ordinary builds and dev runs keep the production CSP", () => {
  const p = conf({ csp: "x", devCsp: "y" });
  assert.deepEqual(applyE2eCsp(["build"], {}, p, silent), ["build"]);
  assert.deepEqual(applyE2eCsp(["build"], { VITE_TEAMCLU_E2E: "false" }, p, silent), ["build"]);
  assert.deepEqual(applyE2eCsp(["dev"], { VITE_TEAMCLU_E2E: "true" }, p, silent), ["dev"]);
});

test("without a devCsp nothing changes", () => {
  const p = conf({ csp: "x" });
  assert.deepEqual(applyE2eCsp(["build"], { VITE_TEAMCLU_E2E: "true" }, p, silent), ["build"]);
});
