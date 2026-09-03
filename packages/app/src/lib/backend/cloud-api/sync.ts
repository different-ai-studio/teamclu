import type {
  ActorDirectorySyncRow,
  IdeaSyncRow,
  SessionParticipantSyncRow,
  SyncBackend,
} from "@/lib/backend/types";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";
import { fetchAllSyncPages } from "@/lib/backend/cloud-api/sync-paging";

export function createSyncModule(client: CloudApiClient): SyncBackend {
  return {
    // Each of these pages to exhaustion — the endpoints are keyset-paginated and
    // reading only the first page would silently drop the rest of the delta.
    async listActorDirectoryForSync(teamId, updatedAfter) {
      return fetchAllSyncPages<ActorDirectorySyncRow>(client, "/v1/sync/actor-directory", {
        teamId,
        since: updatedAfter ?? null,
      });
    },
    async listIdeasForSync(teamId, updatedAfter) {
      return fetchAllSyncPages<IdeaSyncRow>(client, "/v1/sync/ideas", {
        teamId,
        since: updatedAfter ?? null,
      });
    },
    async listSessionParticipantsForSync(sessionId, updatedAfter) {
      return fetchAllSyncPages<SessionParticipantSyncRow>(client, "/v1/sync/session-participants", {
        sessionId,
        since: updatedAfter ?? null,
      });
    },
  };
}
