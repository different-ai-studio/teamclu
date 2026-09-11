const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createPhaseTimer, formatDuration } = require("./dev-timing");

test("formatDuration uses ms under one second and s above", () => {
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(42), "42ms");
  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1000), "1.0s");
  assert.equal(formatDuration(14200), "14.2s");
});

test("createPhaseTimer marks phase delta and running total", () => {
  const lines = [];
  let clock = 1_000;
  const timer = createPhaseTimer({
    prefix: "[test]",
    log: (msg) => lines.push(msg),
    now: () => clock,
  });

  clock = 1_250;
  const a = timer.mark("introspect");
  assert.equal(a.phaseMs, 250);
  assert.equal(a.totalMs, 250);

  clock = 14_000;
  const b = timer.mark("amuxd");
  assert.equal(b.phaseMs, 12_750);
  assert.equal(b.totalMs, 13_000);

  assert.deepEqual(lines, [
    "[test] timing: introspect 250ms (total 250ms)",
    "[test] timing: amuxd 12.8s (total 13.0s)",
  ]);
});
