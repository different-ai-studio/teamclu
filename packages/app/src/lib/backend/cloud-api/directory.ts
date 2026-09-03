import type { CurrentTeamMemberSummary, DirectoryBackend, DirectoryMemberActor } from "@/lib/backend/types";
import { CloudApiError, type CloudApiClient } from "@/lib/backend/cloud-api/http";

export function createDirectoryModule(client: CloudApiClient): DirectoryBackend {
  return {
    async resolveCurrentMemberActor(teamId: string, userId: string): Promise<DirectoryMemberActor | null> {
      try {
        const out = await client.get<DirectoryMemberActor | null>(
          `/v1/directory/current-member-actor?teamId=${encodeURIComponent(teamId)}&userId=${encodeURIComponent(userId)}`,
        );
        return out ?? null;
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async resolveFirstMemberActorForUser(userId: string): Promise<DirectoryMemberActor | null> {
      try {
        const out = await client.get<DirectoryMemberActor | null>(
          `/v1/directory/first-member-actor-for-user?userId=${encodeURIComponent(userId)}`,
        );
        return out ?? null;
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async getCurrentTeamMember(teamId: string, userId: string): Promise<CurrentTeamMemberSummary | null> {
      try {
        const out = await client.get<CurrentTeamMemberSummary | null>(
          `/v1/directory/current-team-member?teamId=${encodeURIComponent(teamId)}&userId=${encodeURIComponent(userId)}`,
        );
        return out ?? null;
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
  };
}
