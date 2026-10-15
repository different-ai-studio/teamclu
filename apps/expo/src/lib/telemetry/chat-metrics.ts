/**
 * Chat performance intervals (iOS `ChatMetrics`, #1709 M1–M5), so the two
 * mobile apps report the same metric names to Sentry Performance and can be
 * compared release by release.
 *
 * An interval is started by name + key, marked with phases as it goes (any
 * module can mark it by the same key), and ended once. On end it is handed to
 * the sink — Sentry when it started, nothing otherwise. Timestamps are
 * epoch ms.
 *
 * - `chat.open_session`  route push → cache_ready → first_frame → seeded
 * - `chat.send`          send tapped → persisted → enqueued → published
 * - `app.cold_start`     JS start → route_ready → mqtt_connected → list_rows
 * - `app.foreground_resume` back in foreground → MQTT usable again
 */
export type ChatMetricName =
  | "chat.open_session"
  | "chat.send"
  | "app.cold_start"
  | "app.foreground_resume";

export type ChatMetricOutcome = "ok" | "failed" | "cancelled";

export type ChatMetricReport = {
  name: ChatMetricName;
  key: string;
  start: number;
  end: number;
  outcome: ChatMetricOutcome;
  phases: ReadonlyArray<{ name: string; at: number }>;
  measurements: Readonly<Record<string, number>>;
  tags: Readonly<Record<string, string>>;
};

export type ChatMetricsSink = (report: ChatMetricReport) => void;

type OpenInterval = {
  start: number;
  phases: Array<{ name: string; at: number }>;
  measurements: Record<string, number>;
  tags: Record<string, string>;
  /** End as soon as every one of these phases has been marked. */
  endWhen: ReadonlySet<string> | null;
};

let sink: ChatMetricsSink | null = null;
let now: () => number = () => Date.now();
const open = new Map<string, OpenInterval>();

const id = (name: ChatMetricName, key: string) => `${name}\u0000${key}`;

export function setChatMetricsSink(next: ChatMetricsSink | null): void {
  sink = next;
}

/** Test seam. */
export function setChatMetricsClock(clock: (() => number) | null): void {
  now = clock ?? (() => Date.now());
}

export function resetChatMetrics(): void {
  open.clear();
}

/**
 * Start an interval. A second start for an interval still open replaces it
 * (the earlier one is dropped, not reported): a screen re-entered before its
 * first load finished is a new sample.
 */
export function startChatMetric(
  name: ChatMetricName,
  key = "",
  options: { startedAt?: number; endWhenMarked?: readonly string[] } = {},
): void {
  // Intervals that never end (a send whose retries ran out) must not pile up.
  if (open.size >= 64) {
    const oldest = open.keys().next().value;
    if (oldest !== undefined) open.delete(oldest);
  }
  open.set(id(name, key), {
    start: options.startedAt ?? now(),
    phases: [],
    measurements: {},
    tags: {},
    endWhen: options.endWhenMarked ? new Set(options.endWhenMarked) : null,
  });
}

export function isChatMetricOpen(name: ChatMetricName, key = ""): boolean {
  return open.has(id(name, key));
}

/** Mark a phase once; later marks of the same phase are ignored. */
export function markChatMetric(name: ChatMetricName, key: string, phase: string): void {
  const interval = open.get(id(name, key));
  if (!interval || interval.phases.some((p) => p.name === phase)) return;
  interval.phases.push({ name: phase, at: now() });
  if (interval.endWhen && [...interval.endWhen].every((p) => interval.phases.some((x) => x.name === p))) {
    endChatMetric(name, key, "ok");
  }
}

export function measureChatMetric(
  name: ChatMetricName,
  key: string,
  measurement: string,
  value: number,
): void {
  const interval = open.get(id(name, key));
  if (interval) interval.measurements[measurement] = value;
}

export function tagChatMetric(name: ChatMetricName, key: string, tag: string, value: string): void {
  const interval = open.get(id(name, key));
  if (interval) interval.tags[tag] = value;
}

export function endChatMetric(
  name: ChatMetricName,
  key = "",
  outcome: ChatMetricOutcome = "ok",
): void {
  const interval = open.get(id(name, key));
  if (!interval) return;
  open.delete(id(name, key));
  // A screen left mid-load is not a sample of the load.
  if (outcome === "cancelled") return;
  sink?.({
    name,
    key,
    start: interval.start,
    end: now(),
    outcome,
    phases: interval.phases,
    measurements: interval.measurements,
    tags: interval.tags,
  });
}
