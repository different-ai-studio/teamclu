"use strict";

/**
 * Lightweight wall-clock phase timer for tauri:dev prelude scripts.
 * Prints one line per mark: phase delta + running total since create.
 */

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * @param {{ prefix?: string, log?: (msg: string) => void, now?: () => number }} [opts]
 */
function createPhaseTimer(opts = {}) {
  const prefix = opts.prefix ?? "[timing]";
  const log = opts.log ?? console.log;
  const now = opts.now ?? Date.now;
  const t0 = now();
  let last = t0;

  return {
    /** @param {string} name */
    mark(name) {
      const t = now();
      const phaseMs = t - last;
      const totalMs = t - t0;
      last = t;
      log(
        `${prefix} timing: ${name} ${formatDuration(phaseMs)} (total ${formatDuration(totalMs)})`,
      );
      return { phaseMs, totalMs };
    },
    elapsedMs() {
      return now() - t0;
    },
  };
}

module.exports = { createPhaseTimer, formatDuration };
