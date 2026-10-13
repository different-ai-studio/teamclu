import { AgentType } from "@teamclu/app/proto/amux_pb";
import { describe, expect, it } from "vitest";

import {
  appCheckoutWorkspace,
  appSessionBlocker,
  applyAppCheckouts,
} from "../features/sessions/app-session";
import type { RuntimeStartPlan } from "../features/sessions/runtime-start";

const ws = (id: string, agentId: string | null, path: string) => ({ id, agentId, path });

describe("appCheckoutWorkspace (iOS #1602)", () => {
  it("is the app's own row when it belongs to the agent and has a path", () => {
    const rows = [ws("w0", "a1", "/home"), ws("w1", "a1", "/apps/shop")];
    expect(appCheckoutWorkspace({ workspaceId: "w1" }, "a1", rows)).toEqual({
      id: "w1",
      path: "/apps/shop",
    });
  });

  it("never uses another agent's row", () => {
    expect(appCheckoutWorkspace({ workspaceId: "w1" }, "a1", [ws("w1", "a2", "/apps/shop")])).toBeNull();
  });

  it("ignores a row without a path", () => {
    expect(appCheckoutWorkspace({ workspaceId: "w1" }, "a1", [ws("w1", "a1", "  ")])).toBeNull();
  });

  it("is null when no machine has claimed the app", () => {
    expect(appCheckoutWorkspace({ workspaceId: null }, "a1", [ws("w1", "a1", "/x")])).toBeNull();
  });
});

describe("applyAppCheckouts", () => {
  const plan: RuntimeStartPlan = {
    agentActorId: "a1",
    targetActorId: "a1",
    workspaceId: "w-default",
    worktree: "/default",
    agentType: AgentType.PI,
  };

  it("moves each plan onto its agent's checkout", () => {
    expect(applyAppCheckouts([plan], { workspaceId: "w1" }, [ws("w1", "a1", "/apps/shop")])).toEqual([
      { ...plan, workspaceId: "w1", worktree: "/apps/shop" },
    ]);
  });

  it("leaves plans alone without an app", () => {
    expect(applyAppCheckouts([plan], null, [ws("w1", "a1", "/apps/shop")])).toEqual([plan]);
  });
});

describe("appSessionBlocker", () => {
  const app = { name: "Shop", workspaceId: "w1" };
  const agents = [{ actorId: "a1", displayName: "mini" }];

  it("does not block without an app", () => {
    expect(appSessionBlocker({ app: null, agents: [], workspaces: [], isChecking: false })).toBeNull();
  });

  it("needs an agent", () => {
    expect(appSessionBlocker({ app, agents: [], workspaces: [], isChecking: false })).toEqual({
      kind: "needsAgent",
    });
  });

  it("does not block once every agent has a checkout", () => {
    expect(
      appSessionBlocker({ app, agents, workspaces: [ws("w1", "a1", "/apps/shop")], isChecking: true }),
    ).toBeNull();
  });

  it("says it is checking while the agents' workspaces load", () => {
    expect(appSessionBlocker({ app, agents, workspaces: [], isChecking: true })).toEqual({
      kind: "checking",
    });
  });

  it("names the agents without a checkout", () => {
    expect(
      appSessionBlocker({
        app,
        agents: [...agents, { actorId: "a2", displayName: "max" }],
        workspaces: [ws("w1", "a1", "/apps/shop")],
        isChecking: false,
      }),
    ).toEqual({ kind: "missingCheckout", appName: "Shop", agentNames: ["max"] });
  });
});
