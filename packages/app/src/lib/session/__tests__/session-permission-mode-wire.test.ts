import { describe, expect, it } from "vitest";
import { sessionPermissionModeToWire } from "@/lib/session/session-permission-mode-wire";

describe("sessionPermissionModeToWire", () => {
  it("maps desktop modes to daemon wire strings", () => {
    expect(sessionPermissionModeToWire("default")).toBe("default");
    expect(sessionPermissionModeToWire("fullAccess")).toBe("full_access");
  });
});
