import { describe, expect, it } from "vitest";
import {
  aggregateAttentionByKind,
  emptyAttentionByKind,
  isSessionListKindValue,
  totalAttention,
} from "@/lib/session/session-list-attention";

describe("session-list-attention", () => {
  it("aggregates unread and mention per kind", () => {
    const counts = aggregateAttentionByKind({
      a: { kind: "channel", mention: true },
      b: { kind: "channel", mention: false },
      c: { kind: "cron", mention: false },
    });
    expect(counts.channel).toEqual({ unread: 2, mention: 1 });
    expect(counts.cron).toEqual({ unread: 1, mention: 0 });
    expect(counts.regular).toEqual({ unread: 0, mention: 0 });
    expect(totalAttention(counts)).toEqual({ unread: 3, mention: 1 });
  });

  it("starts empty", () => {
    expect(emptyAttentionByKind().app).toEqual({ unread: 0, mention: 0 });
  });

  it("narrows kind strings", () => {
    expect(isSessionListKindValue("channel")).toBe(true);
    expect(isSessionListKindValue("gateway")).toBe(false);
  });
});
