import { describe, expect, it } from "vitest";
import {
  AGENT_TYPE_ORDER,
  canConfirmSelection,
  initialWorkspaceId,
} from "../features/sessions/components/agent-config-helpers";

describe("AgentConfigSheet helpers", () => {
  it("initialWorkspaceId returns the first workspace's id", () => {
    expect(initialWorkspaceId([{ id: "w1" }, { id: "w2" }])).toBe("w1");
  });
  it("initialWorkspaceId returns empty string for empty list", () => {
    expect(initialWorkspaceId([])).toBe("");
  });
  it("canConfirmSelection requires a non-empty workspace id", () => {
    expect(canConfirmSelection("w1")).toBe(true);
    expect(canConfirmSelection("")).toBe(false);
  });
  it("AGENT_TYPE_ORDER lists pi first, then the legacy backends", () => {
    expect(AGENT_TYPE_ORDER).toEqual(["pi", "claude", "opencode", "codex"]);
  });
});
