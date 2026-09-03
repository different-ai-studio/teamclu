import { describe, expect, it } from "vitest";
import { AgentStatus } from "@/lib/proto/amux_pb";
import {
  findStaleLiveStreams,
  STREAM_SILENCE_RECOVERY_MS,
} from "@/lib/stream/stale-stream-recovery";
import {
  attachmentKey,
  type RuntimeStateEntry,
} from "@/stores/runtime-state-store";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";

const NOW = 1_800_000_000_000;
const AGENT = "b2d7df56-6cc8-4646-9352-f0f119a44f11";

const stream = (
  overrides: Partial<AgentStreamEntry> = {},
): AgentStreamEntry => ({
  sessionId: "s1",
  actorId: AGENT,
  outputText: "hello",
  thinkingText: "",
  parts: [],
  toolCalls: [],
  planEntries: [],
  pendingPermissionsByRequestId: {},
  errorMessage: null,
  errorDetails: null,
  active: true,
  lastUpdate: NOW - 1_000,
  streamId: `s1::${AGENT}::1`,
  ...overrides,
});

const runtime = (
  status: AgentStatus,
  lastUpdated: number,
  sessionId = "s1",
): Record<string, RuntimeStateEntry> => ({
  [attachmentKey(AGENT, sessionId)]: {
    daemonActorId: AGENT,
    lastUpdated,
    info: {
      runtimeId: sessionId,
      agentType: 0,
      status,
      availableModels: [],
      currentModel: "",
    } as RuntimeStateEntry["info"],
  },
});

const find = (
  byKey: Record<string, AgentStreamEntry>,
  byRuntimeId: Record<string, RuntimeStateEntry> = {},
) => findStaleLiveStreams({ byKey, byRuntimeId, now: NOW });

describe("findStaleLiveStreams — runtime retain reconciliation", () => {
  it("flags a live dock whose runtime retain went terminal after the last event", () => {
    expect(
      find({ k: stream() }, runtime(AgentStatus.IDLE, NOW - 500)),
    ).toEqual([{ sessionId: "s1", actorId: AGENT, reason: "runtime-terminal" }]);
  });

  it("ignores a terminal retain older than the last stream event", () => {
    // Previous turn's retain re-flushed on reconnect while a new turn streams.
    expect(find({ k: stream() }, runtime(AgentStatus.IDLE, NOW - 5_000))).toEqual(
      [],
    );
  });

  it("recovers even with a tool call still marked in flight", () => {
    const entry = stream({
      toolCalls: [{ id: "t1", status: "calling" }] as never,
    });
    expect(
      find({ k: entry }, runtime(AgentStatus.IDLE, NOW - 500)),
    ).toHaveLength(1);
  });

  it("leaves an inactive stream alone", () => {
    expect(
      find({ k: stream({ active: false }) }, runtime(AgentStatus.IDLE, NOW)),
    ).toEqual([]);
  });

  it("ignores a newer terminal retain from another session", () => {
    expect(
      find(
        { k: stream() },
        {
          ...runtime(AgentStatus.ACTIVE, NOW - 500, "s1"),
          ...runtime(AgentStatus.IDLE, NOW - 100, "s2"),
        },
      ),
    ).toEqual([]);
  });

  it("uses the current session terminal retain when another session is newer", () => {
    expect(
      find(
        { k: stream() },
        {
          ...runtime(AgentStatus.IDLE, NOW - 500, "s1"),
          ...runtime(AgentStatus.ACTIVE, NOW - 100, "s2"),
        },
      ),
    ).toEqual([
      { sessionId: "s1", actorId: AGENT, reason: "runtime-terminal" },
    ]);
  });
});

describe("findStaleLiveStreams — silence fallback", () => {
  const silent = () =>
    stream({ lastUpdate: NOW - STREAM_SILENCE_RECOVERY_MS - 1 });

  it("flags a stream silent past the threshold with no retain available", () => {
    expect(find({ k: silent() })).toEqual([
      { sessionId: "s1", actorId: AGENT, reason: "silent" },
    ]);
  });

  it("keeps waiting while the runtime still reports ACTIVE", () => {
    expect(find({ k: silent() }, runtime(AgentStatus.ACTIVE, NOW))).toEqual([]);
  });

  it("keeps waiting while a tool call is in flight", () => {
    for (const status of ["calling", "waiting"]) {
      const entry = stream({
        lastUpdate: NOW - STREAM_SILENCE_RECOVERY_MS - 1,
        toolCalls: [{ id: "t1", status }] as never,
      });
      expect(find({ k: entry })).toEqual([]);
    }
  });

  it("does not flag a stream that is merely quiet", () => {
    expect(
      find({ k: stream({ lastUpdate: NOW - STREAM_SILENCE_RECOVERY_MS + 1 }) }),
    ).toEqual([]);
  });
});
