import { describe, expect, it } from "vitest";
import {
  estimateVirtualMessageSize,
  getVirtualMessageKey,
  VIRTUAL_MSG_OVERSCAN,
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

  it("keeps a wider overscan band to reduce scroll remount churn", () => {
    expect(VIRTUAL_MSG_OVERSCAN).toBeGreaterThanOrEqual(10);
  });
});

describe("estimateVirtualMessageSize", () => {
  it("estimates short user rows smaller than long agent markdown", () => {
    const user = makeMessage("u1");
    user.role = "user";
    user.content = "ok";

    const agent = makeMessage("a1");
    agent.role = "assistant";
    agent.content = "x".repeat(4000);

    expect(estimateVirtualMessageSize(user)).toBeLessThan(
      estimateVirtualMessageSize(agent),
    );
    expect(estimateVirtualMessageSize(agent)).toBeGreaterThan(500);
  });

  it("keeps growing with content instead of clamping tall rows", () => {
    // Message bodies are never truncated in the UI, so one very long agent
    // reply really is many screens tall. A clamped estimate puts every row
    // after it off by the difference the clamp threw away, which is a blank
    // viewport on fast scroll and an anchor restore that cannot land.
    const long = makeMessage("long");
    long.role = "assistant";
    long.content = "x".repeat(40_000);

    const longer = makeMessage("longer");
    longer.role = "assistant";
    longer.content = "x".repeat(80_000);

    expect(estimateVirtualMessageSize(long)).toBeGreaterThan(10_000);
    expect(estimateVirtualMessageSize(longer)).toBeGreaterThan(
      estimateVirtualMessageSize(long) * 1.5,
    );
  });

  it("keeps growing with content for a pasted user wall of text", () => {
    const pasted = makeMessage("pasted");
    pasted.role = "user";
    pasted.content = "字".repeat(20_000);

    expect(estimateVirtualMessageSize(pasted)).toBeGreaterThan(5_000);
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
