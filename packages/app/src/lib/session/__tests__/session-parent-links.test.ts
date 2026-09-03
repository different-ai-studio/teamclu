import { describe, expect, it } from "vitest";
import {
  selectSessionParentLinks,
  sessionParentLinksEqual,
} from "@/lib/session/session-parent-links";

describe("sessionParentLinks", () => {
  it("projects id and parentID only", () => {
    expect(
      selectSessionParentLinks([
        { id: "a", parentID: undefined },
        { id: "b", parentID: "a" },
      ]),
    ).toEqual([
      { id: "a", parentID: undefined },
      { id: "b", parentID: "a" },
    ]);
  });

  it("treats equal parent graphs as equal", () => {
    const a = selectSessionParentLinks([
      { id: "a", parentID: undefined },
      { id: "b", parentID: "a" },
    ]);
    const b = selectSessionParentLinks([
      { id: "a", parentID: undefined },
      { id: "b", parentID: "a" },
    ]);
    expect(sessionParentLinksEqual(a, b)).toBe(true);
  });

  it("detects parent-link changes", () => {
    const a = [{ id: "b", parentID: "a" as string | undefined }];
    const b = [{ id: "b", parentID: undefined }];
    expect(sessionParentLinksEqual(a, b)).toBe(false);
  });
});
