/** Re-read apps an AI agent changed from inside a session.
 *
 * An agent reaches the Apps surface through the introspect MCP tools, which
 * call the Cloud API from the desktop process — not through this window's
 * store. The app list is loaded once per team and the control panel's counts
 * once per app, so an agent that renamed an app, switched its type or added a
 * cron job left both describing the app as it was until the user happened to
 * reselect something. The desktop emits one event per change; this hook turns
 * a burst of them into one re-read.
 */
import { useEffect } from "react";
import { isTauri } from "@/lib/utils";
import { useAppsStore } from "@/stores/apps-store";
import { useCurrentTeamStore } from "@/stores/current-team";

/** Must match `AGENT_APP_CHANGED_EVENT` in
 *  `apps/desktop/src/commands/introspect_api/apps.rs`. */
export const AGENT_APP_CHANGED_EVENT = "apps:changed-by-agent";

/**
 * Quiet period before re-reading.
 *
 * An agent setting an app up makes several calls in a row (type, env, a cron
 * job, a deploy); re-listing the team's apps after each one is several
 * identical requests whose answers are overwritten before anyone sees them.
 */
export const AGENT_APP_CHANGE_DEBOUNCE_MS = 300;

export interface AgentAppChangedPayload {
  teamId: string | null;
  appId: string | null;
}

/**
 * Which team's app list to re-read after a batch of agent changes, or null for
 * none.
 *
 * The store holds ONE team's list. Re-reading a team other than the one on
 * screen would swap that team's apps into the sidebar under the current team's
 * name, so a change to another team is left to that team's own load when the
 * user switches to it. An event that names no team is taken to mean the team
 * on screen. With nothing on screen yet, the latest change that names a team
 * decides.
 */
export function teamToReloadAfterAgentChanges(
  changedTeamIds: ReadonlyArray<string | null | undefined>,
  shownTeamId: string | null | undefined,
): string | null {
  if (shownTeamId) {
    const touchesShown = changedTeamIds.some((id) => !id || id === shownTeamId);
    return touchesShown ? shownTeamId : null;
  }
  for (let i = changedTeamIds.length - 1; i >= 0; i -= 1) {
    const id = changedTeamIds[i];
    if (id) return id;
  }
  return null;
}

/**
 * Collect items and hand them over together once `delayMs` passes with no new
 * one (trailing debounce). `cancel` drops whatever is waiting.
 */
export function createTrailingBatcher<T>(
  delayMs: number,
  flush: (batch: T[]) => void,
): { push: (item: T) => void; cancel: () => void } {
  let pending: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    push(item) {
      pending.push(item);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const batch = pending;
        pending = [];
        flush(batch);
      }, delayMs);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = [];
    },
  };
}

/** Tolerate a payload from a desktop build that sends less than the contract. */
function toPayload(raw: unknown): AgentAppChangedPayload {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    teamId: typeof obj.teamId === "string" && obj.teamId ? obj.teamId : null,
    appId: typeof obj.appId === "string" && obj.appId ? obj.appId : null,
  };
}

/** One re-read for a batch of agent changes. */
export async function refreshAfterAgentAppChanges(
  batch: ReadonlyArray<AgentAppChangedPayload>,
): Promise<void> {
  const apps = useAppsStore.getState();
  // The current team first: during a team switch the store still names the
  // team being left, and re-reading that one would race the new team's load.
  const shownTeamId = useCurrentTeamStore.getState().team?.id ?? apps.teamId ?? null;
  const teamId = teamToReloadAfterAgentChanges(
    batch.map((p) => p.teamId),
    shownTeamId,
  );
  if (teamId) {
    // Forced: the cached list is exactly what just went stale. Settled, not
    // all: a daemon that does not answer must not stop the list re-reading.
    await Promise.allSettled([
      apps.load(teamId, { force: true }),
      apps.refreshLocalApps(teamId),
    ]);
  }
  // Unconditionally. The panel's counts belong to whichever app is selected,
  // and the reload above does not re-run them — the row keeps its id.
  useAppsStore.getState().invalidateAppSummary();
}

export function useAgentAppChanges(): void {
  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const batcher = createTrailingBatcher<AgentAppChangedPayload>(
      AGENT_APP_CHANGE_DEBOUNCE_MS,
      (batch) => {
        void refreshAfterAgentAppChanges(batch).catch((err: unknown) => {
          console.warn("[apps] Refresh after agent change failed (non-critical):", err);
        });
      },
    );

    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        const off = await listen(AGENT_APP_CHANGED_EVENT, (event) => {
          batcher.push(toPayload(event.payload));
        });
        // Unmounted while `listen` was resolving: the cleanup already ran and
        // has nothing to call, so release the listener here.
        if (cancelled) off();
        else unlisten = off;
      } catch (err: unknown) {
        console.warn("[apps] Could not listen for agent app changes (non-critical):", err);
      }
    })();

    return () => {
      cancelled = true;
      batcher.cancel();
      unlisten?.();
    };
  }, []);
}
