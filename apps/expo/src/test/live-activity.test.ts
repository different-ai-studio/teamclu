import { create, toBinary } from "@bufbuild/protobuf";
import {
  AcpEventSchema,
  AcpOutputSchema,
  AcpPermissionRequestSchema,
  AcpRawJsonSchema,
  AcpStatusChangeSchema,
  AgentStatus,
  EnvelopeSchema,
} from "@teamclu/app/proto/amux_pb";
import { LiveEventEnvelopeSchema } from "@teamclu/app/proto/teamclu_pb";
import { describe, expect, it } from "vitest";

import {
  activityOf,
  applySignal,
  decodeLiveSignal,
  expireStaleRun,
  initialActivityState,
  isHot,
} from "../features/sessions/live-activity";
import { createLiveActivityStore, sessionLiveTopic } from "../features/sessions/live-activity-store";

function live(acp: Parameters<typeof create<typeof AcpEventSchema>>[1], eventType = "acp.event") {
  return toBinary(
    LiveEventEnvelopeSchema,
    create(LiveEventEnvelopeSchema, {
      eventType,
      body: toBinary(
        EnvelopeSchema,
        create(EnvelopeSchema, { payload: { case: "acpEvent", value: create(AcpEventSchema, acp) } }),
      ),
    }),
  );
}
const status = (s: AgentStatus) =>
  live({ event: { case: "statusChange", value: create(AcpStatusChangeSchema, { newStatus: s }) } });
const permission = (id: string) =>
  live({ event: { case: "permissionRequest", value: create(AcpPermissionRequestSchema, { requestId: id }) } });
const output = () => live({ event: { case: "output", value: create(AcpOutputSchema, {}) } });
const question = (method: string, json: object) =>
  live({
    event: {
      case: "raw",
      value: create(AcpRawJsonSchema, { method, jsonPayload: new TextEncoder().encode(JSON.stringify(json)) }),
    },
  });

describe("decodeLiveSignal", () => {
  it("maps status, progress, permission and question events", () => {
    expect(decodeLiveSignal(status(AgentStatus.ACTIVE))).toEqual({ kind: "turnStarted" });
    expect(decodeLiveSignal(status(AgentStatus.IDLE))).toEqual({ kind: "turnEnded" });
    expect(decodeLiveSignal(status(AgentStatus.STARTING))).toEqual({ kind: "idleChatter" });
    expect(decodeLiveSignal(output())).toEqual({ kind: "progress" });
    expect(decodeLiveSignal(permission("p1"))).toEqual({ kind: "attentionRequested", id: "p1" });
    expect(decodeLiveSignal(question("question_asked", { id: "q1" }))).toEqual({ kind: "attentionRequested", id: "q1" });
    expect(decodeLiveSignal(question("question_replied", { requestID: "q1" }))).toEqual({ kind: "attentionResolved", id: "q1" });
  });

  it("treats non-ACP traffic as chatter and garbage as undecodable", () => {
    expect(decodeLiveSignal(output().slice(0))).not.toBeNull();
    expect(
      decodeLiveSignal(toBinary(LiveEventEnvelopeSchema, create(LiveEventEnvelopeSchema, { eventType: "message.created" }))),
    ).toEqual({ kind: "idleChatter" });
    expect(decodeLiveSignal(new Uint8Array([0xff, 0xff]))).toBeNull();
  });
});

describe("activity reducer", () => {
  it("runs on progress, waits on a request, and resumes running once it's answered", () => {
    let s = initialActivityState();
    s = applySignal(s, { kind: "progress" }, 1);
    expect(activityOf(s)).toBe("running");
    s = applySignal(s, { kind: "attentionRequested", id: "a" }, 2);
    s = applySignal(s, { kind: "attentionRequested", id: "b" }, 3);
    expect(activityOf(s)).toBe("needsAttention");
    s = applySignal(s, { kind: "attentionResolved", id: "a" }, 4);
    expect(activityOf(s)).toBe("needsAttention");
    s = applySignal(s, { kind: "attentionResolved", id: "b" }, 5);
    expect(activityOf(s)).toBe("running");
    s = applySignal(s, { kind: "turnEnded" }, 6);
    expect(activityOf(s)).toBe("quiet");
  });

  it("expires a silent run but never a pending request", () => {
    const running = applySignal(initialActivityState(), { kind: "progress" }, 0);
    expect(expireStaleRun(running, 50, 90)).toBeNull();
    expect(expireStaleRun(running, 100, 90)?.isRunning).toBe(false);
    const waiting = applySignal(running, { kind: "attentionRequested", id: "x" }, 0);
    expect(expireStaleRun(waiting, 1_000, 90)).toBeNull();
    expect(isHot(waiting, 1_000_000, 10)).toBe(true);
  });
});

describe("live activity store", () => {
  function setup(max = 32) {
    let clock = 0;
    const handlers = new Map<string, (p: Uint8Array, t: string) => void>();
    const mqtt = {
      subscribe(topic: string, handler: (p: Uint8Array, t: string) => void) {
        handlers.set(topic, handler);
        return () => handlers.delete(topic);
      },
    };
    const store = createLiveActivityStore({ mqtt, teamId: "t1", now: () => clock, maxSubscriptions: max });
    const fire = (sid: string, payload: Uint8Array) => handlers.get(sessionLiveTopic("t1", sid))?.(payload, "");
    return { store, handlers, fire, tick: (ms: number) => { clock += ms; } };
  }

  it("lights a dot from the session's live stream and notifies only on colour changes", () => {
    const { store, fire } = setup();
    let notified = 0;
    store.subscribe(() => notified++);
    store.noteActivity("s1");
    fire("s1", output());
    fire("s1", output());
    expect(store.activity("s1")).toBe("running");
    expect(notified).toBe(1);
    fire("s1", permission("p"));
    expect(store.activity("s1")).toBe("needsAttention");
    expect([...store.litSessions().keys()]).toEqual(["s1"]);
  });

  it("releases a quiet session after the grace period but keeps a waiting one", () => {
    const { store, handlers, fire, tick } = setup();
    store.seed(["quiet", "waiting"]);
    fire("waiting", permission("p"));
    tick(121_000);
    store.sweep();
    expect(handlers.has(sessionLiveTopic("t1", "quiet"))).toBe(false);
    expect(handlers.has(sessionLiveTopic("t1", "waiting"))).toBe(true);
  });

  it("evicts the coldest idle session at the cap, never a busy one", () => {
    const { store, handlers, fire, tick } = setup(2);
    store.noteActivity("busy");
    fire("busy", output());
    tick(10);
    store.noteActivity("idle");
    tick(10);
    store.noteActivity("new");
    expect(handlers.has(sessionLiveTopic("t1", "busy"))).toBe(true);
    expect(handlers.has(sessionLiveTopic("t1", "idle"))).toBe(false);
    expect(handlers.has(sessionLiveTopic("t1", "new"))).toBe(true);
  });
});
