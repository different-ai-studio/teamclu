import { test } from "node:test";
import assert from "node:assert/strict";
import { appFunctionName } from "../src/lib/provisioning/app-deploy.js";
import { appPublicLabel } from "../src/lib/apps-public-host.js";

const APP_ID = "5c714425-24f7-49cf-a081-66b1b7b9e504";

test("a function is named after the hostname the app is served on", () => {
  // `python-test-5c714425` in the FC console and
  // `python-test-5c714425.apps.example.com` in a browser, so the two can be
  // matched by eye instead of through a database lookup.
  assert.equal(appFunctionName(APP_ID, "python-test"), "python-test-5c714425");
  assert.equal(appFunctionName(APP_ID, "python-test"), appPublicLabel("python-test", APP_ID));
});

test("no slug keeps the original name, because deployed apps run under it", () => {
  // delete and logs fall back to computing a name when the row has none stored;
  // that fallback has to name the function the app is ACTUALLY running as.
  assert.equal(appFunctionName(APP_ID), `tc-app-${APP_ID}`);
  assert.equal(appFunctionName(APP_ID, null), `tc-app-${APP_ID}`);
  assert.equal(appFunctionName(APP_ID, ""), `tc-app-${APP_ID}`);
});

test("a slug FC would refuse falls back rather than minting an invalid name", () => {
  // DNS allows a leading digit in a label; Function Compute does not.
  assert.equal(appFunctionName(APP_ID, "2048-game"), `tc-app-${APP_ID}`);
  // A slug that cannot become a DNS label at all (too long) has no label to
  // borrow, so there is nothing to fall back from.
  assert.equal(appFunctionName(APP_ID, "x".repeat(200)), `tc-app-${APP_ID}`);
});

test("a non-ASCII slug uses the same punycode the hostname does", () => {
  // Whatever the hostname is, the function matches it — including when the
  // label is an xn-- form the operator never typed.
  const label = appPublicLabel("中文应用", APP_ID);
  assert.ok(label?.startsWith("xn--"), `expected punycode, got ${label}`);
  assert.equal(appFunctionName(APP_ID, "中文应用"), label);
});

test("the name is always a legal Function Compute name", () => {
  // 1-128 chars, letter or underscore first, then letters/digits/-/_.
  const legal = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;
  for (const slug of ["python-test", "2048-game", "中文应用", "", "x".repeat(200), "a"]) {
    const name = appFunctionName(APP_ID, slug);
    assert.match(name, legal, `illegal for slug ${JSON.stringify(slug)}: ${name}`);
  }
  assert.match(appFunctionName(APP_ID), legal);
});
