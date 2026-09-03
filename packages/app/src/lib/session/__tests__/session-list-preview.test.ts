import { describe, expect, it } from "vitest";
import {
  SESSION_LIST_PREVIEW_MAX_LEN,
  truncateSessionListPreview,
} from "@/lib/session/session-list-preview";

describe("truncateSessionListPreview", () => {
  it("trims and caps at 140 characters", () => {
    const long = "a".repeat(200);
    expect(truncateSessionListPreview(long)).toHaveLength(SESSION_LIST_PREVIEW_MAX_LEN);
    expect(truncateSessionListPreview("  hello  ")).toBe("hello");
    expect(truncateSessionListPreview("   ")).toBe("");
  });
});
