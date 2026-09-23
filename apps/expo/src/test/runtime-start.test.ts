import { AgentType } from "@teamclu/app/proto/amux_pb";
import { describe, expect, it } from "vitest";

import {
  resolveAgentRuntimeRestartPlan,
  resolveAgentRuntimeStartPlans,
  resolveExpoAgentType,
} from "../features/sessions/runtime-start";

describe("runtime start planning", () => {
  it("uses the agent default workspace and backend type when available", () => {
    const plans = resolveAgentRuntimeStartPlans({
      agents: [
        {
          actorId: "agent-1",
          displayName: "Claude",
          agentTypes: ["claude", "opencode"],
          defaultAgentType: "opencode",
          defaultWorkspaceId: "workspace-default",
        },
      ],
      connectedAgents: [{ agentId: "agent-1" }],
      workspaces: [
        { id: "workspace-other", path: "/tmp/other", agentId: "agent-1" },
        { id: "workspace-default", path: "/tmp/default", agentId: null },
      ],
    });

    expect(plans).toEqual([
      {
        agentActorId: "agent-1",
        targetActorId: "agent-1",
        workspaceId: "workspace-default",
        worktree: "/tmp/default",
        agentType: AgentType.OPENCODE,
      },
    ]);
  });

  it("throws when the agent has no default or owned workspace", () => {
    expect(() =>
      resolveAgentRuntimeStartPlans({
        agents: [
          {
            actorId: "agent-1",
            displayName: "Claude",
            agentTypes: ["claude"],
            defaultAgentType: null,
            defaultWorkspaceId: null,
          },
        ],
        connectedAgents: [{ agentId: "agent-1" }],
        workspaces: [{ id: "workspace-team", path: "/tmp/teammate", agentId: null }],
      }),
    ).toThrow(/No workspace bound to Claude/i);
  });

  it("falls back to an agent-owned workspace when default is unset", () => {
    const plans = resolveAgentRuntimeStartPlans({
      agents: [
        {
          actorId: "agent-1",
          displayName: "Claude",
          agentTypes: ["claude"],
          defaultAgentType: null,
          defaultWorkspaceId: null,
        },
      ],
      connectedAgents: [{ agentId: "agent-1" }],
      workspaces: [
        { id: "workspace-team", path: "/tmp/team", agentId: null },
        { id: "workspace-owned", path: "/tmp/owned", agentId: "agent-1" },
      ],
    });

    expect(plans[0]?.workspaceId).toBe("workspace-owned");
    expect(plans[0]?.worktree).toBe("/tmp/owned");
  });

  it("lets an explicit sheet selection override defaults", () => {
    const plans = resolveAgentRuntimeStartPlans({
      agents: [
        {
          actorId: "agent-1",
          displayName: "Claude",
          agentTypes: ["claude"],
          defaultAgentType: "claude",
          defaultWorkspaceId: "workspace-default",
        },
      ],
      connectedAgents: [{ agentId: "agent-1" }],
      selectionByAgentId: {
        "agent-1": { workspaceId: "workspace-picked", agentType: "codex" },
      },
      workspaces: [
        { id: "workspace-default", path: "/tmp/default", agentId: null },
        { id: "workspace-picked", path: "/tmp/picked", agentId: null },
      ],
    });

    expect(plans[0]).toMatchObject({
      workspaceId: "workspace-picked",
      worktree: "/tmp/picked",
      agentType: AgentType.CODEX,
    });
  });

  it("throws when an agent's daemon is not connected", () => {
    expect(() =>
      resolveAgentRuntimeStartPlans({
        agents: [
          {
            actorId: "agent-1",
            displayName: "Claude",
            agentTypes: ["claude"],
            defaultAgentType: null,
            defaultWorkspaceId: null,
          },
        ],
        connectedAgents: [],
        workspaces: [{ id: "workspace-1", path: "/tmp/repo", agentId: null }],
      }),
    ).toThrow(/daemon is offline/i);
  });

  it("maps Expo agent type names to AMUX enum values", () => {
    expect(resolveExpoAgentType("claude")).toBe(AgentType.CLAUDE_CODE);
    expect(resolveExpoAgentType("opencode")).toBe(AgentType.OPENCODE);
    expect(resolveExpoAgentType("codex")).toBe(AgentType.CODEX);
    expect(resolveExpoAgentType("pi")).toBe(AgentType.PI);
    // Unknown means "whatever the daemon runs", which is pi (ADR-0014) —
    // defaulting to Claude Code sent a runtime_start every daemon refuses.
    expect(resolveExpoAgentType("unknown")).toBe(AgentType.PI);
  });

  it("plans pi for a pi agent, and ignores a stale default the agent no longer lists", () => {
    const [piPlan] = resolveAgentRuntimeStartPlans({
      agents: [{ actorId: "a1", displayName: "Pi", agentTypes: ["pi"], defaultAgentType: "claude" }],
      connectedAgents: [{ agentId: "a1" }],
      workspaces: [{ id: "w1", path: "/srv", agentId: "a1" }],
    });
    expect(piPlan.agentType).toBe(AgentType.PI);
  });

  it("builds a restart plan from the existing runtime workspace and backend", () => {
    const plan = resolveAgentRuntimeRestartPlan({
      agent: {
        actorId: "agent-1",
        displayName: "Codex",
        agentTypes: ["claude", "codex"],
        defaultAgentType: "claude",
        defaultWorkspaceId: "workspace-default",
      },
      runtime: {
        agentId: "agent-1",
        runtimeId: "rt-old",
        workspaceId: "workspace-current",
        backendType: "codex",
      },
      connectedAgents: [{ agentId: "agent-1" }],
      workspaces: [
        { id: "workspace-default", path: "/tmp/default", agentId: null },
        { id: "workspace-current", path: "/tmp/current", agentId: "agent-1" },
      ],
    });

    expect(plan).toEqual({
      agentActorId: "agent-1",
      targetActorId: "agent-1",
      runtimeIdToStop: "rt-old",
      workspaceId: "workspace-current",
      worktree: "/tmp/current",
      agentType: AgentType.CODEX,
    });
  });
});

describe("per-agent selection", () => {
  it("does not apply one agent's picked workspace to another", async () => {
    // A single shared selection started the second agent in the first one's
    // worktree — the very thing the fallback path refuses to do.
    const { resolveAgentRuntimeStartPlans } = await import(
      "../features/sessions/runtime-start"
    );
    const plans = resolveAgentRuntimeStartPlans({
      agents: [
        {
          actorId: "agent-1",
          displayName: "Claude",
          agentTypes: ["claude"],
          defaultAgentType: "claude",
          defaultWorkspaceId: "ws-1",
        },
        {
          actorId: "agent-2",
          displayName: "OpenCode",
          agentTypes: ["opencode"],
          defaultAgentType: "opencode",
          defaultWorkspaceId: "ws-2",
        },
      ],
      connectedAgents: [{ agentId: "agent-1" }, { agentId: "agent-2" }],
      selectionByAgentId: {
        "agent-1": { workspaceId: "ws-picked", agentType: "codex" },
      },
      workspaces: [
        { id: "ws-1", path: "/tmp/one", agentId: "agent-1" },
        { id: "ws-2", path: "/tmp/two", agentId: "agent-2" },
        { id: "ws-picked", path: "/tmp/picked", agentId: null },
      ],
    });

    expect(plans[0]).toMatchObject({ agentActorId: "agent-1", workspaceId: "ws-picked" });
    // agent-2 keeps its own default, and its own type.
    expect(plans[1]).toMatchObject({ agentActorId: "agent-2", workspaceId: "ws-2" });
    expect(plans[1]?.agentType).not.toBe(plans[0]?.agentType);
  });

  it("falls every agent back to its own default when nothing is selected", async () => {
    const { resolveAgentRuntimeStartPlans } = await import(
      "../features/sessions/runtime-start"
    );
    const plans = resolveAgentRuntimeStartPlans({
      agents: [
        {
          actorId: "agent-1",
          displayName: "A",
          agentTypes: ["claude"],
          defaultAgentType: "claude",
          defaultWorkspaceId: "ws-1",
        },
        {
          actorId: "agent-2",
          displayName: "B",
          agentTypes: ["opencode"],
          defaultAgentType: "opencode",
          defaultWorkspaceId: "ws-2",
        },
      ],
      connectedAgents: [{ agentId: "agent-1" }, { agentId: "agent-2" }],
      workspaces: [
        { id: "ws-1", path: "/tmp/one", agentId: "agent-1" },
        { id: "ws-2", path: "/tmp/two", agentId: "agent-2" },
      ],
    });
    expect(plans.map((p) => p.workspaceId)).toEqual(["ws-1", "ws-2"]);
  });
});
