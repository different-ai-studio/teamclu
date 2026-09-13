import { describe, expect, it, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAnyStreamActive } from "@/lib/stream/any-stream-active";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";

const AGENT = "b2d7df56-6cc8-4646-9352-f0f119a44f11";

const stream = (overrides: Partial<AgentStreamEntry> = {}): AgentStreamEntry => ({
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
  lastUpdate: Date.now(),
  streamId: `s1::${AGENT}::1`,
  ...overrides,
});

describe("useAnyStreamActive", () => {
  beforeEach(() => {
    useV2StreamingStore.setState({ byKey: {} });
    useRuntimeStateStore.setState({ byRuntimeId: {}, defaultCatalogByActorId: {} });
  });

  it("is false with no active entries", () => {
    expect(renderHook(() => useAnyStreamActive()).result.current).toBe(false);
  });

  it("is true for a freshly-active entry", () => {
    useV2StreamingStore.setState({
      byKey: { [`s1::${AGENT}`]: stream() },
    });
    expect(renderHook(() => useAnyStreamActive()).result.current).toBe(true);
  });

  it("ignores an entry stale beyond the silence-recovery window — a dropped MQTT delta must not block a restart forever", () => {
    useV2StreamingStore.setState({
      byKey: {
        [`s1::${AGENT}`]: stream({ lastUpdate: Date.now() - 130_000 }),
      },
    });
    expect(renderHook(() => useAnyStreamActive()).result.current).toBe(false);
  });

  it("ignores a finalized (active: false) entry", () => {
    useV2StreamingStore.setState({
      byKey: { [`s1::${AGENT}`]: stream({ active: false }) },
    });
    expect(renderHook(() => useAnyStreamActive()).result.current).toBe(false);
  });
});
