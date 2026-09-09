import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appLogTopic,
  requestLogTopic,
  filterEntries,
  inferLevel,
  makeAppLogsReader,
  normalizeRows,
  normalizeSlsRow,
  takeNewest,
  SCAN_BUDGET_ROWS,
} from "../../src/lib/provisioning/app-logs.js";

const FN = "tc-app-dcb910dc-1688-44a6-814b-943a1d848d65";
const INSTANCE = "c-6a9fbf89-173c38a5-fcb0e565fb65";

/** An app-output row, shaped exactly as SLS returns one (all values strings). */
function appRow(time: number, message: string, instance = INSTANCE) {
  return {
    __time__: String(time),
    __topic__: appLogTopic(FN),
    functionName: FN,
    instanceID: instance,
    message,
    qualifier: "LATEST",
    versionId: "",
  };
}

function requestRow(time: number, over: Record<string, string> = {}) {
  return {
    __time__: String(time),
    __topic__: requestLogTopic(FN),
    functionName: FN,
    instanceID: INSTANCE,
    requestId: "1-6a9fbf92-174ae003-aa99f23c49ae",
    method: "GET",
    requestURI: "/?status=active",
    statusCode: "200",
    durationMs: "25.69",
    isColdStart: "false",
    hasFunctionError: "false",
    qualifier: "LATEST",
    ...over,
  };
}

test("the two topics are named the way FC names them", () => {
  // The request topic carries a slash the app topic does not. Getting it wrong
  // is not an error — it is an empty result, which reads as "no logs".
  assert.equal(appLogTopic(FN), `FCLogs:${FN}`);
  assert.equal(requestLogTopic(FN), `FCRequestMetrics:/${FN}`);
});

test("instance events and metrics are not returned", () => {
  // Same logstore, three other topics. An agent asking for logs does not want
  // a CPU sample every ten seconds.
  for (const topic of [`FCInstanceMetrics:/${FN}`, `FCInstanceEvents:/${FN}`]) {
    assert.equal(normalizeSlsRow({ __time__: "1788854497", __topic__: topic }), null);
  }
});

test("an app line keeps its text and gets a level inferred from it", () => {
  const entry = normalizeSlsRow(appRow(1788854162, "TypeError: cannot read x"))!;
  assert.equal(entry.kind, "app");
  assert.equal(entry.level, "error");
  assert.equal(entry.message, "TypeError: cannot read x");
  assert.equal(entry.ts, new Date(1788854162_000).toISOString());
});

test("level inference does not fire on a word that merely contains one", () => {
  assert.equal(inferLevel("terror management"), "info");
  assert.equal(inferLevel("mirror the layout"), "info");
  // …while the words a Node app actually crashes with do count, even though
  // none of them has a word boundary before "Error".
  assert.equal(inferLevel("TypeError: x is not a function"), "error");
  assert.equal(inferLevel("PostgresError: relation does not exist"), "error");
  assert.equal(inferLevel("listening on 9000"), "info");
  assert.equal(inferLevel("WARN: slow query"), "warn");
});

test("a request row reads as one sentence, with the numbers kept", () => {
  const entry = normalizeSlsRow(requestRow(1788854162))!;
  assert.equal(entry.kind, "request");
  assert.equal(entry.statusCode, 200);
  assert.equal(entry.durationMs, 25.69);
  assert.match(entry.message, /GET \/\?status=active/);
  assert.match(entry.message, /→ 200/);
});

test("a 5xx request is an error even when FC reports no function error", () => {
  // A framework that catches its own exception and answers 500 leaves
  // hasFunctionError false. Reading only that flag hides exactly the requests
  // worth looking at.
  const entry = normalizeSlsRow(requestRow(1, { statusCode: "500", hasFunctionError: "false" }))!;
  assert.equal(entry.level, "error");
  const notFound = normalizeSlsRow(requestRow(1, { statusCode: "404", hasFunctionError: "false" }))!;
  assert.equal(notFound.level, "warn");
});

test("FC's invoke framing is dropped, but its request id is kept on the lines it brackets", () => {
  const rows = [
    appRow(100, "\nFC Invoke Start RequestId: req-A"),
    appRow(101, "loading config"),
    appRow(102, "boom"),
    appRow(103, "\nFC Invoke End RequestId: req-A"),
    appRow(110, "outside any invocation"),
  ];
  const entries = normalizeRows(rows);
  assert.deepEqual(
    entries.map((e) => [e.message, e.requestId]),
    [
      ["loading config", "req-A"],
      ["boom", "req-A"],
      ["outside any invocation", undefined],
    ],
  );
});

test("request ids do not leak across instances", () => {
  // Two instances serve two requests at the same time; attributing one's lines
  // to the other's id would send someone reading the wrong request.
  const other = "c-other-instance";
  const entries = normalizeRows([
    appRow(100, "\nFC Invoke Start RequestId: req-A"),
    { ...appRow(101, "\nFC Invoke Start RequestId: req-B", other), instanceID: other },
    appRow(102, "from A"),
    { ...appRow(103, "from B", other), instanceID: other },
  ]);
  const byMessage = Object.fromEntries(entries.map((e) => [e.message, e.requestId]));
  assert.equal(byMessage["from A"], "req-A");
  assert.equal(byMessage["from B"], "req-B");
});

test("rows arriving newest-first still get their framing applied", () => {
  // SLS is asked for `reverse: true`, so the End line arrives before the Start
  // one. A walk that trusted arrival order would attach nothing.
  const entries = normalizeRows([
    appRow(103, "\nFC Invoke End RequestId: req-A"),
    appRow(102, "boom"),
    appRow(100, "\nFC Invoke Start RequestId: req-A"),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].requestId, "req-A");
});

test("filters are substring and exact, and kind selects the stream", () => {
  const entries = normalizeRows([
    appRow(100, "\nFC Invoke Start RequestId: req-A"),
    appRow(101, "Table user_sessions is empty"),
    appRow(102, "unrelated"),
    requestRow(103, { requestId: "req-A" }),
  ]);
  // Underscores survive: this is a substring match, not a tokenized query.
  const hit = filterEntries(entries, { contains: "user_sessions" });
  assert.deepEqual(hit.map((e) => e.message), ["Table user_sessions is empty"]);

  const byRequest = filterEntries(entries, { requestId: "req-A", kind: "all" });
  assert.equal(byRequest.length, 3);

  const requestsOnly = filterEntries(entries, { kind: "request" });
  assert.equal(requestsOnly.length, 1);
});

test("takeNewest returns newest first and reports the cut", () => {
  const entries = normalizeRows([appRow(100, "old"), appRow(300, "new"), appRow(200, "mid")]);
  const { items, truncated } = takeNewest(entries, 2);
  assert.deepEqual(items.map((e) => e.message), ["new", "mid"]);
  assert.equal(truncated, true);
  assert.equal(takeNewest(entries, 5).truncated, false);
});

// --- the reader -------------------------------------------------------------

function fakeOps(byTopic: Record<string, any[]>) {
  const calls: any[] = [];
  return {
    calls,
    fetchWindow: async (args: any) => {
      calls.push(args);
      return byTopic[args.topic] ?? [];
    },
  };
}

test("kind=app reads only the app topic; kind=all reads both", async () => {
  const ops = fakeOps({});
  const read = makeAppLogsReader(ops);
  await read({ functionName: FN, sinceMinutes: 30, limit: 10, kind: "app" });
  assert.deepEqual(ops.calls.map((c) => c.topic), [appLogTopic(FN)]);

  ops.calls.length = 0;
  await read({ functionName: FN, sinceMinutes: 30, limit: 10, kind: "all" });
  assert.deepEqual(ops.calls.map((c) => c.topic), [appLogTopic(FN), requestLogTopic(FN)]);
});

test("the window is the one that was asked for, and is reported back", async () => {
  // An empty answer is ambiguous without it: "no errors" and "wrong five
  // minutes" look identical.
  const now = 1788854162_000;
  const read = makeAppLogsReader(fakeOps({}));
  const out = await read({ functionName: FN, sinceMinutes: 15, limit: 10, kind: "app", now });
  assert.equal(out.to, new Date(now).toISOString());
  assert.equal(out.from, new Date(now - 15 * 60_000).toISOString());
});

test("a scan that fills its budget comes back truncated", async () => {
  // The caller must be able to tell "nothing matched in the last hour" from
  // "we stopped looking after a thousand rows".
  const flood = Array.from({ length: SCAN_BUDGET_ROWS }, (_, i) => appRow(1000 + i, `line ${i}`));
  const read = makeAppLogsReader(fakeOps({ [appLogTopic(FN)]: flood }));
  const out = await read({ functionName: FN, sinceMinutes: 60, limit: 200, kind: "app" });
  assert.equal(out.truncated, true);
  assert.equal(out.items.length, 200);
});

test("filtering happens after the framing is read, so request_id works on app output", async () => {
  const rows = [
    appRow(100, "\nFC Invoke Start RequestId: req-A"),
    appRow(101, "handling"),
    appRow(102, "\nFC Invoke End RequestId: req-A"),
    appRow(200, "\nFC Invoke Start RequestId: req-B"),
    appRow(201, "other work"),
  ];
  const read = makeAppLogsReader(fakeOps({ [appLogTopic(FN)]: rows }));
  const out = await read({
    functionName: FN,
    sinceMinutes: 60,
    limit: 50,
    kind: "app",
    requestId: "req-A",
  });
  assert.deepEqual(out.items.map((e) => e.message), ["handling"]);
});
