import { describe, expect, it } from "vitest";
import {
  expandVisibleMessageCount,
  isScrollAtTop,
  LOAD_EARLIER_MESSAGE_COUNT,
} from "../message-list-load-earlier";
describe("isScrollAtTop", () => {
  it("only treats near-zero scrollTop as top", () => {
    expect(isScrollAtTop(0)).toBe(true);
    expect(isScrollAtTop(4)).toBe(true);
    expect(isScrollAtTop(5)).toBe(false);
  });
});

describe("expandVisibleMessageCount", () => {
  it("adds up to 60 messages per batch", () => {
    expect(expandVisibleMessageCount(80, 140)).toBe(80 + LOAD_EARLIER_MESSAGE_COUNT);
    expect(expandVisibleMessageCount(80, 200)).toBe(140);
  });

  it("does not expand when everything is visible", () => {
    expect(expandVisibleMessageCount(80, 80)).toBe(80);
  });

  it("loads a partial batch at the end of history", () => {
    expect(expandVisibleMessageCount(80, 95)).toBe(95);
  });
});
