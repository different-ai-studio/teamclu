import { describe, expect, it } from "vitest";

import {
  AGENT_TYPE_ORDER,
  normalizeStoredAgentType,
  resolveInitialAgentType,
  supportedAgentTypes,
} from "../features/sessions/components/agent-config-helpers";

describe("normalizeStoredAgentType", () => {
  it("folds the three spellings of Claude together", () => {
    // Which one is stored depends on which writer got there first.
    for (const stored of ["claude", "claude_code", "claude-code"]) {
      expect(normalizeStoredAgentType(stored)).toBe("claude");
    }
  });

  it("passes the other two through", () => {
    expect(normalizeStoredAgentType("opencode")).toBe("opencode");
    expect(normalizeStoredAgentType("codex")).toBe("codex");
  });

  it("returns null for anything it does not recognise", () => {
    expect(normalizeStoredAgentType("cursor")).toBeNull();
    expect(normalizeStoredAgentType("")).toBeNull();
    expect(normalizeStoredAgentType(null)).toBeNull();
    expect(normalizeStoredAgentType(undefined)).toBeNull();
  });
});

describe("supportedAgentTypes", () => {
  it("offers only what the agent reports", () => {
    // Offering more is not cosmetic: picking a backend the agent cannot run
    // sends a runtime_start the daemon cannot honour.
    expect(supportedAgentTypes(["opencode"])).toEqual(["opencode"]);
    expect(supportedAgentTypes(["codex", "opencode"])).toEqual(["opencode", "codex"]);
  });

  it("keeps the canonical display order, not the stored order", () => {
    expect(supportedAgentTypes(["codex", "claude", "opencode"])).toEqual([
      "claude",
      "opencode",
      "codex",
    ]);
  });

  it("dedupes the Claude spellings", () => {
    expect(supportedAgentTypes(["claude", "claude_code"])).toEqual(["claude"]);
  });

  it("falls back to pi when the list is empty or unusable", () => {
    // The daemon runs pi only (ADR-0014); offering the legacy backends would
    // invite a runtime_start it refuses.
    expect(supportedAgentTypes([])).toEqual(["pi"]);
    expect(supportedAgentTypes(null)).toEqual(["pi"]);
    expect(supportedAgentTypes(undefined)).toEqual(["pi"]);
    expect(supportedAgentTypes(["cursor", "mystery"])).toEqual(["pi"]);
  });

  it("recognises pi and ignores unrecognised entries", () => {
    expect(supportedAgentTypes(["pi"])).toEqual(["pi"]);
    expect(supportedAgentTypes(["cursor", "codex"])).toEqual(["codex"]);
    expect(AGENT_TYPE_ORDER[0]).toBe("pi");
  });
});

describe("resolveInitialAgentType", () => {
  it("keeps the preferred type when it is on offer", () => {
    expect(resolveInitialAgentType("codex", ["claude", "codex"])).toBe("codex");
  });

  it("clamps to the first offer when it is not", () => {
    // Otherwise no segment looks selected and confirming still sends the
    // unsupported type.
    expect(resolveInitialAgentType("codex", ["claude", "opencode"])).toBe("claude");
  });

  it("leaves the preference alone when nothing is on offer", () => {
    expect(resolveInitialAgentType("codex", [])).toBe("codex");
  });
});
