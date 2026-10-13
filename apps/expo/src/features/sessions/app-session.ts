import type { TeamApp } from "../apps/team-app-types";
import type { RuntimeStartPlan, RuntimeStartWorkspace } from "./runtime-start";

/**
 * App sessions (应用会话) — the New Session sheet's app picker, ported from iOS
 * #1602 (`SessionCreationInput.appCheckoutWorkspace` + `NewSessionSheet`).
 *
 * `app_id` alone never moves an agent into the app's code, so an app session
 * seats every agent on that agent's checkout of the app, and refuses to start
 * when an agent has none rather than quietly running it in its default folder.
 */

export type AppCheckoutWorkspace = { id: string; path: string };

/**
 * The workspace that is `agentId`'s checkout of `app`, or null when that
 * agent's machine has none this client can see.
 *
 * Only the app's own row (`apps.workspace_id`) is trusted, and only when it
 * belongs to this agent and has a path. A second machine's checkout is a
 * separate row with nothing linking it to the app (the daemon's workdir is
 * user-movable, so its path proves nothing either); guessing would seat the
 * agent on a directory that is not on its machine.
 */
export function appCheckoutWorkspace(
  app: Pick<TeamApp, "workspaceId">,
  agentId: string,
  workspaces: ReadonlyArray<RuntimeStartWorkspace>,
): AppCheckoutWorkspace | null {
  const workspaceId = app.workspaceId?.trim();
  if (!workspaceId) return null;
  const row = workspaces.find(
    (workspace) =>
      workspace.id === workspaceId &&
      workspace.agentId === agentId &&
      (workspace.path ?? "").trim().length > 0,
  );
  return row ? { id: row.id, path: row.path ?? "" } : null;
}

/**
 * Points every plan at its agent's checkout. A plan whose agent has none is
 * left as is; `appSessionBlocker` has already refused the send in that case.
 */
export function applyAppCheckouts(
  plans: ReadonlyArray<RuntimeStartPlan>,
  app: Pick<TeamApp, "workspaceId"> | null,
  workspaces: ReadonlyArray<RuntimeStartWorkspace>,
): RuntimeStartPlan[] {
  if (!app) return [...plans];
  return plans.map((plan) => {
    const checkout = appCheckoutWorkspace(app, plan.agentActorId, workspaces);
    return checkout ? { ...plan, workspaceId: checkout.id, worktree: checkout.path } : plan;
  });
}

export type AppSessionBlocker =
  /** An app session needs an agent to work in the app's code. */
  | { kind: "needsAgent" }
  /** The selected agents' workspaces are still being fetched. */
  | { kind: "checking" }
  /** These agents' machines have no checkout of the app. */
  | { kind: "missingCheckout"; appName: string; agentNames: string[] };

/**
 * Why the selected app blocks sending, if it does — iOS `appBlocker`. Only a
 * desktop can put an app's code on an agent's machine, so the sheet refuses
 * rather than seating the agent somewhere else.
 */
export function appSessionBlocker(args: {
  app: Pick<TeamApp, "name" | "workspaceId"> | null;
  agents: ReadonlyArray<{ actorId: string; displayName: string }>;
  workspaces: ReadonlyArray<RuntimeStartWorkspace>;
  isChecking: boolean;
}): AppSessionBlocker | null {
  const { app } = args;
  if (!app) return null;
  if (args.agents.length === 0) return { kind: "needsAgent" };
  const missing = args.agents.filter(
    (agent) => !appCheckoutWorkspace(app, agent.actorId, args.workspaces),
  );
  if (missing.length === 0) return null;
  if (args.isChecking) return { kind: "checking" };
  return {
    kind: "missingCheckout",
    appName: app.name,
    agentNames: missing.map((agent) => agent.displayName),
  };
}
