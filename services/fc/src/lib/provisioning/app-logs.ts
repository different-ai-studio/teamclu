/**
 * Turn raw SLS rows into the log entries `GET /v1/apps/:appId/logs` returns.
 *
 * Function Compute delivers four different things into one logstore, told apart
 * by `__topic__`:
 *
 * - `FCLogs:<functionName>`          — what the app itself printed (`message`)
 * - `FCRequestMetrics:/<fn>`         — one row per HTTP request: status, duration
 * - `FCInstanceEvents:/<fn>`         — instance created / destroyed
 * - `FCInstanceMetrics:/<fn>`        — CPU / memory samples
 *
 * Only the first two are worth an agent's context window, and only the first
 * two are returned.
 *
 * ## Why the filtering happens here and not in the SLS query
 *
 * `contains` and `requestId` are applied to normalized entries rather than
 * pushed into the query string. Three reasons, all learned the hard way:
 * SLS tokenizes on punctuation, so a term with an underscore (a table name, a
 * env var) simply does not match; interpolating caller text into a query
 * language that has `or` is an injection surface on a filter whose whole job is
 * to keep one app inside its own logs; and an app's own output carries no
 * `requestId` field at all — the id only appears in FC's framing lines, so
 * correlating it is something only this module can do.
 *
 * The cost is that both filters search the fetched window, not all of history.
 * That is stated in the API description rather than hidden.
 */

import type { SlsRow } from "./sls-client.js";

/** Which of the two useful topics a caller wants. */
export type AppLogKind = "app" | "request" | "all";

export interface AppLogEntry {
  /** ISO-8601, UTC. SLS stores whole seconds. */
  ts: string;
  kind: "app" | "request";
  level: "info" | "warn" | "error";
  message: string;
  /** FC request id, when it is known — see {@link attachRequestIds}. */
  requestId?: string;
  instanceId?: string;
  statusCode?: number;
  durationMs?: number;
  method?: string;
  path?: string;
  coldStart?: boolean;
}

/** `FCLogs:<fn>` is what the app printed; `FCRequestMetrics:/<fn>` is FC's own
 *  per-request row. The slash is FC's, not a typo — the two topics are shaped
 *  differently and a reader that assumes one shape finds nothing. */
export function appLogTopic(functionName: string): string {
  return `FCLogs:${functionName}`;
}

export function requestLogTopic(functionName: string): string {
  return `FCRequestMetrics:/${functionName}`;
}

/**
 * FC's own framing around each invocation. Dropped from the output — it is two
 * lines of noise per request — but read first: these lines are the only place
 * an app log line's request id appears.
 */
const FC_FRAMING = /^\s*FC Invoke (Start|End) RequestId:\s*(\S+)\s*$/;

const ERROR_WORDS = /\b(error|err|exception|fatal|unhandled|rejection|traceback|panic)\b/i;
/**
 * `TypeError`, `ReferenceError`, `PostgresError` — the words that actually
 * appear when a Node app falls over, and none of which the rule above catches:
 * there is no word boundary inside `TypeError`.
 *
 * Case-SENSITIVE on purpose. Case-insensitively this also matches `terror`,
 * `mirror` and every other word that happens to end in those five letters.
 */
const ERROR_CLASS = /[A-Za-z_]\w*Error\b/;
const WARN_WORDS = /\b(warn|warning|deprecated)\b/i;

function topicKind(topic: string): "app" | "request" | null {
  if (topic.startsWith("FCLogs:")) return "app";
  if (topic.startsWith("FCRequestMetrics:")) return "request";
  return null;
}

function isoFromSeconds(raw: string | undefined): string {
  const seconds = Number(raw ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date(0).toISOString();
  return new Date(seconds * 1000).toISOString();
}

function num(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Level for a line the app printed. FC adds no level of its own. */
export function inferLevel(message: string): "info" | "warn" | "error" {
  if (ERROR_WORDS.test(message) || ERROR_CLASS.test(message)) return "error";
  if (WARN_WORDS.test(message)) return "warn";
  return "info";
}

/**
 * One SLS row → one entry, or null for a row that is framing, noise, or from a
 * topic this endpoint does not serve.
 */
export function normalizeSlsRow(row: SlsRow): AppLogEntry | null {
  const kind = topicKind(row.__topic__ ?? "");
  if (!kind) return null;
  const ts = isoFromSeconds(row.__time__);
  const instanceId = row.instanceID || undefined;

  if (kind === "app") {
    const message = (row.message ?? "").replace(/\s+$/, "");
    if (!message.trim()) return null;
    if (FC_FRAMING.test(message)) return null;
    return { ts, kind, level: inferLevel(message), message, instanceId };
  }

  const statusCode = num(row.statusCode);
  const durationMs = num(row.durationMs);
  const method = row.method || undefined;
  const path = row.requestURI || undefined;
  const failed = row.hasFunctionError === "true" || (statusCode ?? 0) >= 500;
  const parts = [method, path].filter(Boolean).join(" ");
  const tail = [
    statusCode === undefined ? null : `→ ${statusCode}`,
    durationMs === undefined ? null : `in ${durationMs}ms`,
    row.isColdStart === "true" ? "(cold start)" : null,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    ts,
    kind,
    level: failed ? "error" : (statusCode ?? 0) >= 400 ? "warn" : "info",
    message: [parts, tail].filter(Boolean).join(" ") || "request",
    requestId: row.requestId || undefined,
    instanceId,
    statusCode,
    durationMs,
    method,
    path,
    coldStart: row.isColdStart === "true" ? true : undefined,
  };
}

/**
 * Give each app log line the request id of the invocation it was printed in.
 *
 * FC brackets every invocation with `FC Invoke Start/End RequestId: <id>` on the
 * same instance, and those framing lines are the only carrier of the id — the
 * app's own lines have no `requestId` field. Walking one instance's stream in
 * time order is what turns "these 40 lines" into "the 6 lines from the request
 * that 500'd", which is the question worth asking.
 *
 * Takes the raw rows (framing included, which {@link normalizeSlsRow} drops) and
 * returns entries in the order given.
 */
export function normalizeRows(rows: SlsRow[]): AppLogEntry[] {
  // Oldest first so a Start line is seen before the lines it brackets.
  const chronological = [...rows].sort(
    (a, b) => Number(a.__time__ ?? 0) - Number(b.__time__ ?? 0),
  );
  const openByInstance = new Map<string, string>();
  const out: AppLogEntry[] = [];

  for (const row of chronological) {
    const instance = row.instanceID ?? "";
    const framing = topicKind(row.__topic__ ?? "") === "app" && FC_FRAMING.exec(row.message ?? "");
    if (framing) {
      const [, which, requestId] = framing;
      if (which === "Start") openByInstance.set(instance, requestId);
      else openByInstance.delete(instance);
      continue;
    }
    const entry = normalizeSlsRow(row);
    if (!entry) continue;
    if (entry.kind === "app" && !entry.requestId) {
      const open = openByInstance.get(instance);
      if (open) entry.requestId = open;
    }
    out.push(entry);
  }
  return out;
}

export interface AppLogFilter {
  contains?: string | null;
  requestId?: string | null;
  kind?: AppLogKind;
}

/** Case-insensitive substring on the message; exact match on the request id. */
export function filterEntries(entries: AppLogEntry[], filter: AppLogFilter): AppLogEntry[] {
  const contains = filter.contains?.trim().toLowerCase() || null;
  const requestId = filter.requestId?.trim() || null;
  const kind = filter.kind ?? "app";
  return entries.filter((e) => {
    if (kind !== "all" && e.kind !== kind) return false;
    if (requestId && e.requestId !== requestId) return false;
    if (contains && !e.message.toLowerCase().includes(contains)) return false;
    return true;
  });
}

/**
 * Newest first, capped.
 *
 * Newest first because the question is nearly always "what just happened"; the
 * cap because a tool result large enough to blow the caller's context is worse
 * than a short one that says it was cut off.
 */
export function takeNewest(entries: AppLogEntry[], limit: number): {
  items: AppLogEntry[];
  truncated: boolean;
} {
  const sorted = [...entries].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return { items: sorted.slice(0, limit), truncated: sorted.length > limit };
}

// ─── Reader ──────────────────────────────────────────────────────────────────

export interface ReadAppLogsInput {
  /** `tc-app-<appId>` — what FC named the topic after. */
  functionName: string;
  sinceMinutes: number;
  limit: number;
  kind: AppLogKind;
  contains?: string | null;
  requestId?: string | null;
  /** Injectable clock, for tests. */
  now?: number;
}

export interface AppLogsResult {
  items: AppLogEntry[];
  /** More matched than `limit`, or the scan budget cut the window short. */
  truncated: boolean;
  /** The window actually read, as ISO strings — an empty answer is ambiguous
   *  without it ("no errors" vs "wrong five minutes"). */
  from: string;
  to: string;
}

/**
 * How many raw rows a single call may pull before giving up on finding more
 * matches. Ten pages: enough that a `contains` over a quiet app reaches back
 * through the whole window, bounded enough that a chatty one cannot turn one
 * tool call into a minute of paging.
 */
export const SCAN_BUDGET_ROWS = 1000;

export function makeAppLogsReader(ops: {
  fetchWindow: (args: {
    topic: string;
    from: number;
    to: number;
    maxRows: number;
  }) => Promise<SlsRow[]>;
}) {
  return async function readAppLogs(input: ReadAppLogsInput): Promise<AppLogsResult> {
    const nowMs = input.now ?? Date.now();
    const to = Math.floor(nowMs / 1000);
    const from = to - input.sinceMinutes * 60;

    const topics: string[] = [];
    if (input.kind === "app" || input.kind === "all") topics.push(appLogTopic(input.functionName));
    if (input.kind === "request" || input.kind === "all") {
      topics.push(requestLogTopic(input.functionName));
    }

    const budget = Math.min(SCAN_BUDGET_ROWS, Math.max(input.limit * 10, 200));
    const rows: SlsRow[] = [];
    let hitBudget = false;
    for (const topic of topics) {
      const page = await ops.fetchWindow({ topic, from, to, maxRows: budget });
      if (page.length >= budget) hitBudget = true;
      rows.push(...page);
    }

    const entries = filterEntries(normalizeRows(rows), {
      contains: input.contains,
      requestId: input.requestId,
      kind: input.kind,
    });
    const { items, truncated } = takeNewest(entries, input.limit);
    return {
      items,
      truncated: truncated || hitBudget,
      from: new Date(from * 1000).toISOString(),
      to: new Date(to * 1000).toISOString(),
    };
  };
}

export type AppLogsReader = ReturnType<typeof makeAppLogsReader>;
