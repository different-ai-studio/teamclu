import { describe, expect, it } from "vitest";

import {
  clipContextName,
  hasAppSessions,
  ideaIdsMissingTitle,
  mergeNames,
  sessionContext,
} from "../features/sessions/session-context-names";

const apps = new Map([["a1", "Expense Bot"]]);
const ideas = new Map([["i1", "Weekly digest"]]);

describe("sessionContext", () => {
  it("names the app first, then the idea", () => {
    expect(sessionContext({ appId: "a1", ideaId: "i1" }, apps, ideas)).toEqual({
      kind: "app",
      name: "Expense Bot",
    });
    expect(sessionContext({ appId: "", ideaId: "i1" }, apps, ideas)).toEqual({
      kind: "idea",
      name: "Weekly digest",
    });
  });

  it("falls back to the idea when the app's name isn't known", () => {
    expect(sessionContext({ appId: "a9", ideaId: "i1" }, apps, ideas)?.kind).toBe("idea");
  });

  it("is null for an ordinary session or unknown names", () => {
    expect(sessionContext({}, apps, ideas)).toBeNull();
    expect(sessionContext({ ideaId: "i9" }, apps, ideas)).toBeNull();
  });
});

describe("clipContextName", () => {
  it("clips past 16 characters, counting CJK as one each", () => {
    expect(clipContextName("short")).toBe("short");
    expect(clipContextName("a".repeat(16))).toBe("a".repeat(16));
    expect(clipContextName("a".repeat(17))).toBe(`${"a".repeat(16)}…`);
    expect(clipContextName("这是一个非常非常非常长的想法标题啊啊")).toBe("这是一个非常非常非常长的想法标题…");
  });
});

describe("fetch triggers", () => {
  it("asks for apps only when some session has one", () => {
    expect(hasAppSessions([{ appId: "" }, {}])).toBe(false);
    expect(hasAppSessions([{ appId: "a1" }])).toBe(true);
  });

  it("asks for ideas only when a title is missing", () => {
    expect([...ideaIdsMissingTitle([{ ideaId: "i1" }, { ideaId: "i2" }, {}], ideas)]).toEqual(["i2"]);
    expect(ideaIdsMissingTitle([{ ideaId: "i1" }], ideas).size).toBe(0);
  });
});

describe("mergeNames", () => {
  it("upserts, keeps names missing from the fetch, ignores blanks", () => {
    const next = mergeNames(apps, [["a2", "Slides"], ["a3", "  "]]);
    expect(next.get("a1")).toBe("Expense Bot");
    expect(next.get("a2")).toBe("Slides");
    expect(next.has("a3")).toBe(false);
  });

  it("returns the same map when nothing changed", () => {
    expect(mergeNames(apps, [["a1", "Expense Bot"]])).toBe(apps);
    expect(mergeNames(apps, [])).toBe(apps);
  });
});
