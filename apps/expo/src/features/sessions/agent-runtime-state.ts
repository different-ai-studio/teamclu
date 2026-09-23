/**
 * Agent lifecycle state, ported from iOS `SessionMemberSheetLoader` and
 * `AgentChipBar.LifecycleChipState`.
 *
 * The `agent_runtimes` table these facts used to come from was dropped on
 * 2026-08-03 (`20260803010000_drop_agent_runtimes.sql`). Its columns moved to
 * two places, and this module is where the two are recombined:
 *
 *   - `workspace_id` / `model` → `session_participants` (ADR-0005), read over
 *     `GET /v1/sessions/:id/participants`.
 *   - `status` / `current_model` / `available_models` → the retained
 *     `ActorPresence` MQTT message (ADR-0004), read from the connected-agents
 *     store.
 */

export type AgentLifecycleState =
  | "spawning"
  | "ready"
  | "idle"
  | "active"
  | "stopped"
  | "error";

/**
 * `Amux_AgentStatus` on `RuntimeInfo.status` (proto/amux.proto). The daemon
 * publishes the enum; the old REST rows carried the equivalent string.
 */
export function runtimeStatusName(status: number | undefined): string | null {
  switch (status) {
    case 1:
      return "starting";
    case 2:
      return "active";
    case 3:
      return "idle";
    case 4:
      return "error";
    case 5:
      return "stopped";
    default:
      return null;
  }
}

/** Mirrors iOS `SessionMemberSheetLoader.fromRuntimeStatus`. */
export function lifecycleFromRuntimeStatus(
  status: string | null | undefined,
): AgentLifecycleState {
  switch (status) {
    case "starting":
    case "spawning":
      return "spawning";
    case "ready":
      return "ready";
    case "running":
    case "active":
      return "active";
    case "idle":
      return "idle";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

export const SPAWN_TIMEOUT_MS = 30_000;

/**
 * Mirrors iOS `SessionMemberSheetLoader.chipState`.
 *
 * Some ACP backends never emit a StatusChange:Active between spawn and the
 * first prompt, so the daemon's `starting` sticks to the row forever and the
 * dot reads "spawning" on a runtime that is fully alive. A spawning row whose
 * last sighting is older than 30s is demoted to idle.
 */
export function agentLifecycleState(args: {
  status: string | null | undefined;
  lastSeenAtMs?: number | null;
  nowMs?: number;
  spawnTimeoutMs?: number;
}): AgentLifecycleState {
  const raw = lifecycleFromRuntimeStatus(args.status);
  if (raw !== "spawning") return raw;
  if (args.lastSeenAtMs == null) return raw;
  const now = args.nowMs ?? Date.now();
  const timeout = args.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS;
  return now - args.lastSeenAtMs > timeout ? "idle" : raw;
}

/**
 * Whether tapping the row opens the model picker — iOS
 * `AgentMemberRow.isInteractive`.
 *
 * An empty model list means there is no live runtime to ask, so the menu would
 * open blank. stopped/error stay closed for the same reason: no live ACP.
 */
export function canChangeAgentModel(args: {
  availableModels: ReadonlyArray<unknown>;
  state: AgentLifecycleState;
}): boolean {
  if (args.availableModels.length === 0) return false;
  switch (args.state) {
    case "ready":
    case "idle":
    case "active":
    case "spawning":
      return true;
    case "stopped":
    case "error":
      return false;
  }
}

export type AgentTrailingLabel =
  | { kind: "model"; text: string }
  | { kind: "spinner" }
  | { kind: "default" };

/**
 * The trailing label on an agent row — iOS `AgentMemberRow.trailingLabel`.
 *
 * The daemon resolves the model before it reports anything past `starting`
 * (`manager.rs` awaits `initial_model_rx` first), so a known model always wins;
 * the dot already communicates that the runtime is still coming up. The spinner
 * is for the genuinely-empty window before that.
 */
export function agentTrailingLabel(args: {
  currentModel: string | null | undefined;
  state: AgentLifecycleState;
}): AgentTrailingLabel {
  const model = args.currentModel?.trim();
  if (model) return { kind: "model", text: model };
  if (args.state === "spawning") return { kind: "spinner" };
  return { kind: "default" };
}

/**
 * Lifecycle → `StatusDot` kind, so the member sheet, the chip bar and the
 * sessions list all read the same colours.
 *
 * Mirrors iOS `AgentChipBar.LifecycleChipState.color`: sage when healthy,
 * yellow while producing, slate for spawning/stopped, red on error. Hai ships
 * no yellow — `StatusDot` documents the amber that stands in for it.
 */
export function lifecycleDotKind(
  state: AgentLifecycleState,
): "active" | "working" | "muted" | "error" {
  switch (state) {
    case "ready":
    case "idle":
      return "active";
    case "active":
      return "working";
    case "error":
      return "error";
    case "spawning":
    case "stopped":
      return "muted";
  }
}

/**
 * Canonical backend id. The same agent is stored as `claude`, `claude_code` or
 * `claude-code` depending on which writer got there first, and iOS funnels all
 * three through `AgentType.fromStoredValue` before anything reads them.
 */
export function normalizeAgentBackend(
  backendType: string | null | undefined,
): "pi" | "claude" | "opencode" | "codex" | null {
  switch (backendType) {
    case "claude":
    case "claude_code":
    case "claude-code":
      return "claude";
    case "opencode":
      return "opencode";
    case "codex":
      return "codex";
    case "pi":
      return "pi";
    default:
      return null;
  }
}

/** Mirrors iOS `SessionMemberSheetLoader.displayName(forBackendType:)`. */
export function agentBackendDisplayName(
  backendType: string | null | undefined,
): string {
  switch (normalizeAgentBackend(backendType)) {
    case "claude":
      return "Claude";
    case "opencode":
      return "OpenCode";
    case "codex":
      return "Codex";
    case "pi":
      return "Pi";
    default:
      // Unknown backend: title-case it rather than invent a name. Without the
      // normalisation above this branch also caught `claude_code` and rendered
      // it "Claude_code".
      if (!backendType) return "";
      return backendType.charAt(0).toUpperCase() + backendType.slice(1);
  }
}
