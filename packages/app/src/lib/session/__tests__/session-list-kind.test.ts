import { describe, expect, it } from "vitest";
import { deriveSessionListKind, sessionMatchesListKind } from "../session-list-kind";

describe("deriveSessionListKind", () => {
  it("prefers cron over app_id", () => {
    expect(deriveSessionListKind({ source: "cron", app_id: "app-1" })).toBe("cron");
  });

  it("marks gateway before app_id", () => {
    expect(deriveSessionListKind({ source: "gateway", app_id: "app-1" })).toBe("gateway");
  });

  it("marks app sessions with source=user", () => {
    expect(deriveSessionListKind({ source: "user", app_id: "app-1" })).toBe("app");
  });

  it("falls back to user", () => {
    expect(deriveSessionListKind({ source: "user" })).toBe("user");
  });

  it("trusts a stored list_kind", () => {
    expect(deriveSessionListKind({ source: "user", list_kind: "gateway" })).toBe("gateway");
  });
});

describe("sessionMatchesListKind", () => {
  it("treats optimistic cronSessionIds as cron", () => {
    expect(
      sessionMatchesListKind({ id: "s1", source: "user" }, "cron", new Set(["s1"])),
    ).toBe(true);
  });
});
