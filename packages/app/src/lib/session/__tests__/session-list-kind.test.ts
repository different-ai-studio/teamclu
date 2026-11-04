import { describe, expect, it } from "vitest";
import {
  classifySessionListKind,
  isSessionListKind,
} from "../session-list-kind";

describe("session-list-kind", () => {
  it("partitions kinds mutually exclusively", () => {
    expect(classifySessionListKind({ source: "user", app_id: null })).toBe("regular");
    expect(classifySessionListKind({ source: null, app_id: null })).toBe("regular");
    expect(classifySessionListKind({ source: "gateway", app_id: "app-1" })).toBe("channel");
    expect(classifySessionListKind({ source: "user", app_id: "app-1" })).toBe("app");
    expect(classifySessionListKind({ source: "cron", app_id: null })).toBe("cron");
  });

  it("matches isSessionListKind to classify", () => {
    const row = { source: "gateway" as const, app_id: "x" };
    expect(isSessionListKind(row, "channel")).toBe(true);
    expect(isSessionListKind(row, "app")).toBe(false);
  });
});
