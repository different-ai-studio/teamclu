/**
 * One-way transport latency probe (dev-only).
 *
 * When the local daemon runs with AMUX_LATENCY_PROBE=1, each outgoing ACP
 * envelope carries `probe:<publish_ms>` in the otherwise-unused
 * `source_peer_id` field. On receipt we compute `Date.now() - publish_ms`
 * (same machine → same wall clock), which measures exactly the segment a
 * local SSE fast-path would eliminate: daemon MQTT publish → cloud broker →
 * webview receive. The daemon's 50ms drain pump (before the stamp) and the
 * frontend rAF delta buffer (after receipt) are transport-independent and
 * deliberately excluded.
 *
 * Inspect from devtools: `__amuxLatencyProbe.summary()`; a summary line is
 * also logged every 100 samples.
 */

const samples: number[] = [];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)];
}

function latencyProbeSummary() {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length
      ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
      : 0,
  };
}

/** Parse an envelope's sourcePeerId; records a sample when it is a probe marker. */
export function recordLatencyProbe(sourcePeerId: string | undefined): void {
  if (!sourcePeerId || !sourcePeerId.startsWith("probe:")) return;
  const publishedAt = Number(sourcePeerId.slice(6));
  if (!Number.isFinite(publishedAt)) return;
  const latency = Date.now() - publishedAt;
  // Clock skew / replayed history can go wildly negative or huge — drop.
  if (latency < -1000 || latency > 60_000) return;
  samples.push(latency);
  if (samples.length % 100 === 0) {
    console.info("[latency-probe]", latencyProbeSummary());
  }
}

declare global {
  interface Window {
    __amuxLatencyProbe?: { summary: typeof latencyProbeSummary };
  }
}

if (typeof window !== "undefined") {
  window.__amuxLatencyProbe = { summary: latencyProbeSummary };
}
