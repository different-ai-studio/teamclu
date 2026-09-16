import { describe, expect, it } from "vitest";
import {
  getVirtualMessageKey,
  VIRTUAL_MSG_THRESHOLD,
} from "../MessageList";
import type { Message } from "@/stores/session-types";

const INITIAL_VISIBLE = 80;

function makeMessage(id: string, sessionId = "sess-a"): Message {
  return {
    id,
    sessionId,
    role: "user",
    content: `body-${id}`,
    parts: [],
    toolCalls: [],
    isStreaming: false,
    timestamp: new Date(),
  };
}

function sliceLastWindow(
  messages: Message[],
  windowSize = INITIAL_VISIBLE,
): Message[] {
  return messages.slice(Math.max(0, messages.length - windowSize));
}

/**
 * Simulates TanStack Virtual index-keyed size cache after a window slide (append).
 * Returns Y starts for the short message at the penultimate slot when cache is wrong vs stable keys.
 */
function simulateIndexKeyedOverlap(): {
  wrongGapPx: number;
  stableGapPx: number;
} {
  const gap = 4;
  const tall = 600;
  const short = 40;
  const newMsg = 60;
  const prefix = 76;
  const prefixHeight = 80;

  const wrongHeights = [
    ...Array.from({ length: prefix }, () => prefixHeight),
    tall,
    short,
  ];
  let y = 0;
  const wrongStarts: number[] = [];
  for (const h of wrongHeights) {
    wrongStarts.push(y);
    y += h + gap;
  }
  const wrongPenultimateStart = wrongStarts[wrongStarts.length - 2]!;
  const wrongPenultimateEnd = wrongPenultimateStart + tall;

  const stableHeights = [
    ...Array.from({ length: prefix }, () => prefixHeight),
    short,
    newMsg,
  ];
  y = 0;
  const stableStarts: number[] = [];
  for (const h of stableHeights) {
    stableStarts.push(y);
    y += h + gap;
  }
  const stablePenultimateStart = stableStarts[stableStarts.length - 2]!;
  const stablePenultimateEnd = stablePenultimateStart + short;

  return {
    wrongGapPx: wrongPenultimateEnd - stablePenultimateStart,
    stableGapPx: stablePenultimateEnd - stablePenultimateStart,
  };
}

describe("MessageList virtualization gate", () => {
  it("enables virtualization above 80 messages", () => {
    expect(VIRTUAL_MSG_THRESHOLD).toBe(80);
  });
});

describe("getVirtualMessageKey", () => {
  it("keeps the same key when a message moves index after append (92 → 93)", () => {
    const msgs92 = Array.from({ length: 92 }, (_, i) =>
      makeMessage(`msg-${String(i + 1).padStart(3, "0")}`),
    );
    const before = sliceLastWindow(msgs92);
    expect(before[78]!.id).toBe("msg-091");
    expect(before[79]!.id).toBe("msg-092");
    const keyMsg92Before = getVirtualMessageKey(before, 79);

    const msgs93 = [
      ...msgs92,
      makeMessage("msg-093"),
    ];
    const after = sliceLastWindow(msgs93);
    expect(after[78]!.id).toBe("msg-092");
    expect(after[79]!.id).toBe("msg-093");
    expect(getVirtualMessageKey(after, 78)).toBe(keyMsg92Before);
    expect(getVirtualMessageKey(after, 79)).toBe("sess-a:msg-093");
  });

  it("does not reuse keys across sessions for the same message id", () => {
    const a = makeMessage("shared-id", "sess-a");
    const b = makeMessage("shared-id", "sess-b");
    expect(getVirtualMessageKey([a], 0)).not.toBe(
      getVirtualMessageKey([b], 0),
    );
  });

  it("falls back to index for out-of-range without throwing", () => {
    expect(getVirtualMessageKey([], 3)).toBe(3);
  });

  it("uses message id when sessionId is missing", () => {
    const message = makeMessage("orphan");
    delete (message as { sessionId?: string }).sessionId;
    expect(getVirtualMessageKey([message], 0)).toBe("orphan");
  });
});

describe("index-keyed virtual cache simulation", () => {
  it("shows large layout error when heights stick to index after window slide", () => {
    const { wrongGapPx, stableGapPx } = simulateIndexKeyedOverlap();
    expect(wrongGapPx).toBeGreaterThan(500);
    expect(stableGapPx).toBeLessThan(100);
  });
});
