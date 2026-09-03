import type { NotificationPrefs, NotificationsBackend } from "@/lib/backend/types";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

export function createNotificationsModule(client: CloudApiClient): NotificationsBackend {
  return {
    async loadPreferences(userId) {
      try {
        return await client.get<NotificationPrefs>(`/v1/notifications/prefs?userId=${encodeURIComponent(userId)}`);
      } catch {
        return null;
      }
    },
    async savePreferences(input) {
      await client.post<void>("/v1/notifications/prefs", input);
    },
    async setSessionMuted(input) {
      if (input.muted) {
        await client.post<void>(`/v1/sessions/${encodeURIComponent(input.sessionId)}/mute`, { userId: input.userId });
      } else {
        await client.delete<void>(`/v1/sessions/${encodeURIComponent(input.sessionId)}/mute?userId=${encodeURIComponent(input.userId)}`);
      }
    },
    async listMutedSessionIds(userId) {
      const out = await client.get<{ items: string[] }>(`/v1/notifications/muted-sessions?userId=${encodeURIComponent(userId)}`);
      return out.items;
    },
  };
}
