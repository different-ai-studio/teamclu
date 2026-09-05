import { useActorDirectoryStore } from "@/stores/actor-directory-store";
import type { RuntimeStateEntry } from "@/stores/runtime-state-store";
import {
  backendTypeFromRuntimeEntry,
  resolveRuntimeStateEntryForAgent,
} from "@/lib/agent/runtime-state-resolve";

/**
 * Which backend runs this agent, answered before its runtime exists.
 *
 * The runtime state store is the precise source — it reports what the agent is
 * running on right now — but it is empty until a runtime attaches, and a
 * runtime only attaches once a session starts. So on a cold start, every read
 * before the first send comes back `undefined`.
 *
 * That mattered more than "the label is blank for a second". The client model
 * MRU is keyed `(backend, team)`, and an unknown backend cannot form a key —
 * `clientMruModels` answered "no history", which is indistinguishable from
 * "this device never picked a model", so the first send after every launch was
 * refused and asked the user to pick a model they had already picked.
 *
 * The team's actor directory carries the agent's configured type and is loaded
 * (and cached) well before then, so it answers when the runtime cannot. It is
 * the *configured* backend rather than the *running* one, which is exactly the
 * right answer for a runtime that has not started yet.
 */
export function resolveAgentBackendType(args: {
  agentId: string | null | undefined;
  teamId: string | null | undefined;
  byRuntimeId: Record<string, RuntimeStateEntry>;
}): string | undefined {
  const agentId = args.agentId?.trim() ?? "";
  if (!agentId) return undefined;

  const live = backendTypeFromRuntimeEntry(
    resolveRuntimeStateEntryForAgent(agentId, args.byRuntimeId),
  );
  if (live) return live;

  const teamId = args.teamId?.trim() ?? "";
  if (!teamId) return undefined;
  // Never throw: this only ever improves an answer that is otherwise
  // `undefined`, and a directory that has not loaded is not an error.
  try {
    const row = useActorDirectoryStore
      .getState()
      .byTeam[teamId]?.actors?.find((a) => a.id === agentId);
    if (!row) return undefined;
    return "pi";
  } catch {
    return undefined;
  }
}
