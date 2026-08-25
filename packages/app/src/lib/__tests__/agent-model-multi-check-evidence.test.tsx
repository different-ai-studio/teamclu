/**
 * Evidence test: reproduces AgentSelectorDock dropdown checkmark logic
 * using production functions only (no mocks).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentSelectorDock } from "@/components/chat/AgentSelectorDock";
import { useAgentModelPickStore } from "@/stores/agent-model-pick-store";
import { AgentType } from "@/lib/proto/amux_pb";
import type { RuntimeStateEntry } from "@/stores/runtime-state-store";
import {
  agentModelDisplayLabel,
  agentModelIdsMatch,
  isAgentModelRowSelected,
  selectAgentModel,
  shortAgentModelId,
} from "@/lib/runtime-state-resolve";
import { resolveAgentAvailableModels } from "@/lib/agent-available-models";

/** Same as AgentSelectorDock CommandItem checkmark branch (post-fix). */
function dropdownCheckedRows(
  available: Array<{ id: string; displayName: string }>,
  effectiveModelId: string,
): string[] {
  return available
    .filter((m) => isAgentModelRowSelected(m.id, effectiveModelId))
    .map((m) => m.id);
}

function entry(
  agentId: string,
  runtimeId: string,
  models: Array<{ id: string; displayName: string }>,
  currentModel: string,
): RuntimeStateEntry {
  return {
    daemonActorId: agentId,
    lastUpdated: Date.now(),
    info: {
      runtimeId,
      agentType: AgentType.OPENCODE,
      availableModels: models,
      currentModel,
    } as RuntimeStateEntry["info"],
  };
}

describe("agent model multi-check evidence", () => {
  it("only uses daemon ACP available_models — empty retain yields no options", () => {
    const runtimeModels = [
      { id: "opencode/mimo-v2.5-free", displayName: "OpenCode Zen/MiMo V2.5 Free" },
    ];
    const fromRuntime = resolveAgentAvailableModels({
      availableModels: runtimeModels,
    } as RuntimeStateEntry["info"]);
    const fromEmpty = resolveAgentAvailableModels({
      availableModels: [],
    } as RuntimeStateEntry["info"]);

    expect(fromRuntime).toEqual(runtimeModels);
    expect(fromEmpty).toEqual([]);
  });

  it("regression: mixed short+prefixed ids => only canonical row checked", () => {
    const available = [
      { id: "big-pickle", displayName: "Big Pickle" },
      { id: "opencode/big-pickle", displayName: "OpenCode Zen/Big Pickle" },
      { id: "opencode/nemotron-3-super-free", displayName: "OpenCode Zen/Nemotron 3 Super Free" },
      { id: "nemotron-3-super-free", displayName: "Nemotron (short id row)" },
    ];
    const byRuntimeId = {
      "agent-1": entry("agent-1", "rt-1", available, "big-pickle"),
    };
    const { modelId: effectiveModelId, source } = selectAgentModel({
      sessionId: "sess-1",
      agentId: "agent-1",
      available,
      byRuntimeId,
    });
    expect(source).toBe("retain");
    expect(effectiveModelId).toBe("big-pickle");

    const checked = dropdownCheckedRows(available, effectiveModelId);
    expect(checked).toEqual(["big-pickle"]);
  });

  it("regression: same short suffix different full ids => single check", () => {
    const available = [
      { id: "vendor-a/nemotron-3-super-free", displayName: "OpenCode Zen/Nemotron A" },
      { id: "vendor-b/nemotron-3-super-free", displayName: "OpenCode Zen/Nemotron B" },
      { id: "nemotron-3-super-free", displayName: "OpenCode Zen/Nemotron C" },
    ];
    const effectiveModelId = "nemotron-3-super-free";
    const checked = dropdownCheckedRows(available, effectiveModelId);

    expect(checked).toEqual(["nemotron-3-super-free"]);
  });

  it("negative control: nemotron and mimo (medium) do NOT share one retain id", () => {
    const available = [
      { id: "opencode/nemotron-3-super-free", displayName: "OpenCode Zen/Nemotron 3 Super Free" },
      { id: "opencode/mimo-v2.5-free (medium)", displayName: "OpenCode Zen/MiMo V2.5 Free (medium)" },
      { id: "opencode/mimo-v2.5-free", displayName: "OpenCode Zen/MiMo V2.5 Free" },
    ];
    expect(
      dropdownCheckedRows(available, "opencode/mimo-v2.5-free (medium)"),
    ).toEqual(["opencode/mimo-v2.5-free (medium)"]);
    expect(
      agentModelIdsMatch(
        "opencode/nemotron-3-super-free",
        "opencode/mimo-v2.5-free (medium)",
        available,
      ),
    ).toBe(false);
  });

  it("brute-force: screenshot-like OpenCode Zen list — when can nemotron + mimo medium both check?", () => {
    const available = [
      { id: "opencode/big-pickle", displayName: "OpenCode Zen/Big Pickle" },
      { id: "opencode/nemotron-3-super-free", displayName: "OpenCode Zen/Nemotron 3 Super Free" },
      { id: "vendor-b/nemotron-3-super-free", displayName: "OpenCode Zen/Nemotron 3 Super Free" },
      { id: "opencode/mimo-v2.5-free", displayName: "OpenCode Zen/MiMo V2.5 Free" },
      { id: "opencode/mimo-v2.5-free (low)", displayName: "OpenCode Zen/MiMo V2.5 Free (low)" },
      { id: "opencode/mimo-v2.5-free (medium)", displayName: "OpenCode Zen/MiMo V2.5 Free (medium)" },
      { id: "opencode/mimo-v2.5-free (high)", displayName: "OpenCode Zen/MiMo V2.5 Free (high)" },
      { id: "opencode/deepseek-v4-flash-free", displayName: "OpenCode Zen/DeepSeek V4 Flash Free" },
    ];
    const candidates = new Set([
      ...available.map((m) => m.id),
      ...available.map((m) => shortAgentModelId(m.id)),
    ]);
    const dualFamily: Array<{ effective: string; checked: string[] }> = [];
    for (const effective of candidates) {
      const rows = dropdownCheckedRows(available, effective);
      const hasNem = rows.some((r) => r.includes("nemotron"));
      const hasMimoMed = rows.some((r) => r.includes("medium"));
      if (hasNem && hasMimoMed) {
        dualFamily.push({ effective, checked: rows });
      }
    }
    expect(dualFamily).toEqual([]);
  });

  it("dedupe: resolveAgentAvailableModels drops duplicate runtime ids", () => {
    const models = resolveAgentAvailableModels({
      availableModels: [
        { id: "opencode/nemotron-3-super-free", displayName: "A" },
        { id: "opencode/nemotron-3-super-free", displayName: "B" },
      ],
    } as RuntimeStateEntry["info"]);
    expect(models).toHaveLength(1);
  });

  it("regression: slash-heavy ids — only exact row checked", () => {
    const available = [
      {
        id: "OpenCode Zen/Nemotron 3 Super Free",
        displayName: "OpenCode Zen/Nemotron 3 Super Free",
      },
      {
        id: "OtherPrefix/Nemotron 3 Super Free",
        displayName: "OpenCode Zen/Nemotron 3 Super Free (dup label)",
      },
    ];
    const effectiveModelId = "OpenCode Zen/Nemotron 3 Super Free";
    const checked = dropdownCheckedRows(available, effectiveModelId);
    expect(checked).toEqual([effectiveModelId]);
  });

  it("pill label must use the same row as the checkmark (exact id first)", () => {
    const available = [
      {
        id: "alibaba-cn/qwen3-coder-plus",
        displayName: "Alibaba (China)/QwQ Plus",
      },
      {
        id: "opencode/mimo-v2.5-free (medium)",
        displayName: "OpenCode Zen/MiMo V2.5 Free (medium)",
      },
    ];
    const effectiveModelId = "opencode/mimo-v2.5-free (medium)";
    const checked = dropdownCheckedRows(available, effectiveModelId);
    expect(checked).toEqual([effectiveModelId]);

    const pillLabel = agentModelDisplayLabel(effectiveModelId, available);
    expect(pillLabel).toBe("OpenCode Zen/MiMo V2.5 Free (medium)");
    expect(pillLabel).not.toContain("Alibaba");
  });

  it("legacy agentModelIdsMatch still aliases short ids (used for RPC canonicalize)", () => {
    expect(
      agentModelIdsMatch("opencode/big-pickle", "big-pickle", [
        { id: "big-pickle" },
      ]),
    ).toBe(true);
  });

  it("reports which match rule fired for each row (diagnostic table)", () => {
    const available = [
      { id: "big-pickle", displayName: "Big Pickle" },
      { id: "opencode/big-pickle", displayName: "OpenCode Zen/Big Pickle" },
    ];
    const effectiveModelId = "big-pickle";
    expect(
      available.map((m) => isAgentModelRowSelected(m.id, effectiveModelId)),
    ).toEqual([true, false]);
  });
});

const uiMocks = vi.hoisted(() => ({
  agentRuntimeRows: [] as Array<{
    agent_id: string;
    runtime_id: string;
    backend_type: string | null;
    session_id?: string | null;
  }>,
  runtimeStates: {} as Record<string, unknown>,
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    runtime: {
      listLatestAgentRuntimeHints: () => Promise.resolve(uiMocks.agentRuntimeRows),
    },
  }),
}));

vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: (selector: (s: unknown) => unknown) =>
    selector({ team: { id: "team-1" } }),
}));

vi.mock("@/stores/session-list-store", () => ({
  useSessionListStore: (selector: (s: unknown) => unknown) =>
    selector({ rows: [{ id: "session-1", team_id: "team-1" }] }),
}));

vi.mock("@/stores/runtime-state-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/runtime-state-store")>();
  return {
    ...actual,
    useRuntimeStateStore: (selector: (s: unknown) => unknown) =>
      selector({ byRuntimeId: uiMocks.runtimeStates, defaultCatalogByActorId: {} }),
  };
});

vi.mock("@/lib/teamclu-rpc", () => ({
  setModel: vi.fn(),
}));

vi.mock("@/lib/teamclu/ensure-agent-runtime", () => ({
  ensureRuntimeThenSetModel: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_k: string, fb?: string) => fb ?? _k,
  }),
}));

describe("agent model multi-check UI evidence", () => {
  beforeEach(() => {
    useAgentModelPickStore.setState({ bySessionAgent: {} });
    uiMocks.agentRuntimeRows = [
      {
        agent_id: "agent-mac",
        runtime_id: "rt-1",
        backend_type: "opencode",
        session_id: "session-1",
      },
    ];
    uiMocks.runtimeStates = {
      "agent-mac::session-1": {
        daemonActorId: "agent-mac",
        lastUpdated: Date.now(),
        info: {
          agentType: 2,
          availableModels: [
            { id: "big-pickle", displayName: "Big Pickle" },
            { id: "opencode/big-pickle", displayName: "OpenCode Zen/Big Pickle" },
          ],
          currentModel: "big-pickle",
        },
      },
    };
  });

  it("DOM: one Check icon when retain uses short id and list has prefixed alias row", async () => {
    render(
      <AgentSelectorDock
        activeSessionId="session-1"
        engagedAgents={[{ id: "agent-mac", displayName: "MACPRO" }]}
        engagedUiEntries={[
          { agent: { id: "agent-mac", displayName: "MACPRO" }, uiState: "ready", syncHint: null },
        ]}
        agentToRuntimeId={new Map([["agent-mac", "rt-1"]])}
        agentToBackendType={new Map([["agent-mac", "opencode"]])}
        onRemoveAgent={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /MACPRO/i }));

    const checks = document.querySelectorAll(
      '[data-slot="command-item"] svg.opacity-100',
    );
    expect(checks.length).toBe(1);
  });
});
