import { afterEach, describe, expect, it, vi } from "vitest";

import {
  endChatMetric,
  markChatMetric,
  measureChatMetric,
  resetChatMetrics,
  setChatMetricsClock,
  setChatMetricsSink,
  startChatMetric,
} from "../lib/telemetry/chat-metrics";

afterEach(() => {
  resetChatMetrics();
  setChatMetricsSink(null);
  setChatMetricsClock(null);
});

describe("chat metrics", () => {
  it("reports phases and measurements when the interval ends", () => {
    let t = 1000;
    setChatMetricsClock(() => t);
    const sink = vi.fn();
    setChatMetricsSink(sink);

    startChatMetric("chat.send", "m1");
    t = 1040;
    markChatMetric("chat.send", "m1", "persisted");
    markChatMetric("chat.send", "m1", "persisted");
    measureChatMetric("chat.send", "m1", "attempts", 1);
    t = 1100;
    endChatMetric("chat.send", "m1");

    expect(sink).toHaveBeenCalledWith({
      name: "chat.send",
      key: "m1",
      start: 1000,
      end: 1100,
      outcome: "ok",
      phases: [{ name: "persisted", at: 1040 }],
      measurements: { attempts: 1 },
      tags: {},
    });
  });

  it("ends by itself once every awaited phase is marked", () => {
    const sink = vi.fn();
    setChatMetricsSink(sink);
    startChatMetric("chat.open_session", "s1", { endWhenMarked: ["first_frame", "seeded"] });
    markChatMetric("chat.open_session", "s1", "seeded");
    expect(sink).not.toHaveBeenCalled();
    markChatMetric("chat.open_session", "s1", "first_frame");
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("drops a cancelled interval and ignores marks on unknown keys", () => {
    const sink = vi.fn();
    setChatMetricsSink(sink);
    markChatMetric("chat.send", "nope", "persisted");
    startChatMetric("chat.open_session", "s1");
    endChatMetric("chat.open_session", "s1", "cancelled");
    endChatMetric("chat.open_session", "s1");
    expect(sink).not.toHaveBeenCalled();
  });
});
