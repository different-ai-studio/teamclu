import { describe, expect, it } from "vitest";

import { propsEqualIgnoringFunctions } from "../lib/memo-props";

describe("propsEqualIgnoringFunctions", () => {
  it("treats different callbacks as equal, but not a callback appearing or going away", () => {
    expect(propsEqualIgnoringFunctions({ onPress: () => 1 }, { onPress: () => 2 })).toBe(true);
    expect(propsEqualIgnoringFunctions({ onPress: () => 1 }, { onPress: undefined })).toBe(false);
  });

  it("compares rebuilt data by value", () => {
    const message = { messageId: "m1", content: "hi" };
    const prev = { turn: { agentId: "a", runtimeEvents: [message], stream: { text: "ab" } } };
    const same = { turn: { agentId: "a", runtimeEvents: [message], stream: { text: "ab" } } };
    const grown = { turn: { agentId: "a", runtimeEvents: [message], stream: { text: "abc" } } };
    expect(propsEqualIgnoringFunctions(prev, same)).toBe(true);
    expect(propsEqualIgnoringFunctions(prev, grown)).toBe(false);
  });

  it("counts anything past the depth limit as changed unless it is the same reference", () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    expect(propsEqualIgnoringFunctions(deep, deep)).toBe(true);
    expect(propsEqualIgnoringFunctions(deep, { a: { b: { c: { d: { e: 1 } } } } })).toBe(false);
  });

  it("does not look inside class instances", () => {
    expect(propsEqualIgnoringFunctions({ at: new Date(0) }, { at: new Date(0) })).toBe(false);
  });
});
