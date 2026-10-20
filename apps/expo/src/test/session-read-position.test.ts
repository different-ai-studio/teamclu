import { describe, expect, it } from "vitest";

import {
  formatNewMessageCount,
  positionOnLeave,
  unreadSince,
  type ReadPositionRow,
} from "../features/sessions/session-read-position";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 14, 10, minute)).toISOString();
const row = (key: string, minute: number, isOwn = false): ReadPositionRow => ({
  key,
  createdAt: at(minute),
  isOwn,
});

describe("unreadSince", () => {
  it("counts only other people's rows after readAt and returns the first", () => {
    const rows = [row("a", 1), row("b", 2), row("mine", 3, true), row("c", 4), row("d", 5)];
    expect(unreadSince(rows, at(2))).toEqual({ count: 2, firstKey: "c" });
  });

  it("is empty for a session never opened on this device", () => {
    expect(unreadSince([row("a", 1)], null)).toEqual({ count: 0, firstKey: null });
  });
});

describe("positionOnLeave", () => {
  const rows = [row("a", 1), row("b", 2), row("c", 3), row("d", 4)];

  it("at the bottom: read up to the newest row, no anchor", () => {
    expect(
      positionOnLeave({ previous: null, rows, visibleKeys: ["c", "d"], isAtBottom: true }),
    ).toEqual({ readAt: at(4), anchorKey: null });
  });

  it("in the middle: anchors on the top visible row, read up to the newest visible", () => {
    expect(
      positionOnLeave({ previous: null, rows, visibleKeys: ["b", "c"], isAtBottom: false }),
    ).toEqual({ readAt: at(3), anchorKey: "b" });
  });

  it("never moves readAt backwards when scrolled up to reread", () => {
    expect(
      positionOnLeave({
        previous: { readAt: at(4), anchorKey: null },
        rows,
        visibleKeys: ["a"],
        isAtBottom: false,
      }),
    ).toEqual({ readAt: at(4), anchorKey: "a" });
  });

  it("keeps the previous position when the feed is empty", () => {
    const previous = { readAt: at(1), anchorKey: null };
    expect(positionOnLeave({ previous, rows: [], visibleKeys: [], isAtBottom: true })).toBe(previous);
  });
});

describe("formatNewMessageCount", () => {
  it("truncates past 99", () => {
    expect(formatNewMessageCount(7)).toBe("7");
    expect(formatNewMessageCount(100)).toBe("99+");
  });
});
