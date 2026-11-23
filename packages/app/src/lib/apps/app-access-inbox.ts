/** Re-read the app list when the inbox says this user's app access changed.
 *
 * The list is loaded once per team and kept, so an app someone shared with
 * this user stayed out of the sidebar until a restart, and an app taken away
 * stayed in it. FC now sends an `app.access` hint to the grantee's inbox on
 * every grant and revoke (`services/fc/src/lib/app-access-notify.ts`). The
 * re-read is the same one an agent's change triggers — current team only,
 * forced — and a burst of grants (an app created with several people on it)
 * collapses into one request.
 */
import {
  AGENT_APP_CHANGE_DEBOUNCE_MS,
  createTrailingBatcher,
  refreshAfterAgentAppChanges,
  type AgentAppChangedPayload,
} from "@/hooks/use-agent-app-changes";

type Batcher = ReturnType<typeof createTrailingBatcher<AgentAppChangedPayload>>;

// Created on first use, not at import: this module is pulled in by
// MqttLiveWiring, and a test that mocks the hooks module without
// `createTrailingBatcher` must still be able to import it.
let batcher: Batcher | null = null;

function getBatcher(): Batcher {
  batcher ??= createTrailingBatcher<AgentAppChangedPayload>(
    AGENT_APP_CHANGE_DEBOUNCE_MS,
    (batch) => {
      void refreshAfterAgentAppChanges(batch).catch((err: unknown) => {
        console.warn("[apps] Refresh after access change failed (non-critical):", err);
      });
    },
  );
  return batcher;
}

export function noteAppAccessChanged(teamId: string, appId: string | null): void {
  getBatcher().push({ teamId, appId });
}

/** Test hook — drops a pending re-read. */
export function resetAppAccessInboxForTests(): void {
  batcher?.cancel();
}
