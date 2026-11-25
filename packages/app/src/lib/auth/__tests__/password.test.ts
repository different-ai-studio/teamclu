import { describe, expect, it } from "vitest";
import { validateNewPassword } from "@/lib/auth/password";

describe("validateNewPassword", () => {
  it("rejects an empty password", () => {
    expect(validateNewPassword("", "")).toBe("empty");
    expect(validateNewPassword("long-enough", "")).toBe("empty");
  });

  it("rejects fewer than 8 characters", () => {
    expect(validateNewPassword("short1", "short1")).toBe("too_short");
  });

  it("rejects more than 72 characters", () => {
    const password = "a".repeat(73);
    expect(validateNewPassword(password, password)).toBe("too_long");
  });

  it("rejects a confirmation that differs", () => {
    expect(validateNewPassword("correct-horse", "correct-house")).toBe("mismatch");
  });

  it("accepts a matching password within the length bounds", () => {
    expect(validateNewPassword("correct-horse", "correct-horse")).toBeNull();
    expect(validateNewPassword("a".repeat(72), "a".repeat(72))).toBeNull();
  });
});
