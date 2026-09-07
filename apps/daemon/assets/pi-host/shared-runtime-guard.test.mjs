import assert from "node:assert/strict";
import test from "node:test";

import {
  isStaleExtensionCtxError,
  shieldSharedRuntimeFromSessionDispose,
} from "./shared-runtime-guard.mjs";

const STALE =
  "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

function makeSharedRuntime() {
  return {
    invalidated: false,
    invalidate() {
      this.invalidated = true;
    },
  };
}

function makeRunner(runtime) {
  return {
    staleMessage: undefined,
    runtime,
    invalidate(message) {
      if (!this.staleMessage) {
        this.staleMessage = message;
        this.runtime.invalidate(message);
      }
    },
  };
}

test("isStaleExtensionCtxError matches pi's dispose/reload message", () => {
  assert.equal(isStaleExtensionCtxError(new Error(STALE)), true);
  assert.equal(isStaleExtensionCtxError("pi extension error: " + STALE), true);
  assert.equal(isStaleExtensionCtxError(new Error("session_context_unavailable")), false);
});

test("disposing one session does not poison the shared runtime while siblings are live", () => {
  const runtime = makeSharedRuntime();
  const runnerA = makeRunner(runtime);
  let liveSiblings = 1;
  shieldSharedRuntimeFromSessionDispose(runnerA, () => liveSiblings);

  runnerA.invalidate(STALE);

  assert.equal(runnerA.staleMessage, STALE, "the closed session's own runner must still go stale");
  assert.equal(
    runtime.invalidated,
    false,
    "sibling sessions share this runtime; disposing A must not invalidate it",
  );
});

test("disposing the last session still invalidates the shared runtime", () => {
  const runtime = makeSharedRuntime();
  const runnerA = makeRunner(runtime);
  shieldSharedRuntimeFromSessionDispose(runnerA, () => 0);

  runnerA.invalidate(STALE);

  assert.equal(runnerA.staleMessage, STALE);
  assert.equal(runtime.invalidated, true);
});

test("a live sibling runner can still registerTool after another session is disposed", () => {
  const runtime = makeSharedRuntime();
  const runnerA = makeRunner(runtime);
  const runnerB = makeRunner(runtime);
  shieldSharedRuntimeFromSessionDispose(runnerA, () => 1);
  runnerA.invalidate(STALE);

  // Mimic pi's ExtensionAPI.registerTool: it calls runtime.assertActive().
  const assertActive = () => {
    if (runtime.invalidated) throw new Error(STALE);
  };
  assert.doesNotThrow(assertActive);
  assert.equal(runnerB.staleMessage, undefined);
});
