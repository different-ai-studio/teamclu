import type { SessionSummary } from "../sessions/session-types";
import { sessionIdFromNotificationData } from "./notification-routing";

/**
 * The number on the app icon: how many sessions show a red dot (iOS #1608,
 * `AppIconBadge`).
 *
 * FC's push payload sets the badge to 1 on every push and nothing on the
 * device ever lowered it, so one push left a "1" on the icon for good. While
 * the app runs it owns the number; a push only means "something new" until
 * the app next comes forward.
 *
 * Pure rules live here; `app-icon-badge-sync.ts` talks to expo-notifications.
 */

type BadgeSession = Pick<SessionSummary, "hasUnread" | "teamId" | "source"> & {
  /** Archived rows, where a caller has them; the list endpoint leaves them out. */
  archivedAt?: string | null;
};

/**
 * Unread sessions of `teamId`. Archived and cron sessions are left out (iOS
 * hides them from the default list, so their red dot could never be cleared
 * and the badge would stick again). Rows of another team — a cache from before
 * a team switch — don't count either.
 */
export function unreadBadgeCount(sessions: readonly BadgeSession[], teamId: string | null): number {
  if (!teamId) return 0;
  let count = 0;
  for (const session of sessions) {
    if (!session.hasUnread) continue;
    if (session.teamId && session.teamId !== teamId) continue;
    if (session.archivedAt) continue;
    if (session.source === "cron") continue;
    count += 1;
  }
  return count;
}

/** The slice of an expo-notifications `Notification` these rules read. */
export type PresentedNotification = {
  request: {
    identifier: string;
    content: { data?: unknown; threadIdentifier?: string | null } & Record<string, unknown>;
  };
};

/**
 * Delivered notifications belonging to one session. FC sends the session id
 * as the APNs `thread-id` (iOS) and in the payload data (both platforms).
 */
export function notificationIdsInSession(
  presented: readonly PresentedNotification[],
  sessionId: string,
): string[] {
  if (!sessionId) return [];
  const ids: string[] = [];
  for (const notification of presented) {
    const content = notification.request.content;
    const thread = typeof content.threadIdentifier === "string" ? content.threadIdentifier : null;
    if (thread === sessionId || sessionIdFromNotificationData(content.data) === sessionId) {
      ids.push(notification.request.identifier);
    }
  }
  return ids;
}

/** The expo-notifications calls the badge needs, injected so tests can fake them. */
export type BadgeNotifications = {
  setBadgeCountAsync: (count: number) => Promise<boolean>;
  dismissAllNotificationsAsync: () => Promise<void>;
  getPresentedNotificationsAsync: () => Promise<readonly PresentedNotification[]>;
  dismissNotificationAsync: (identifier: string) => Promise<void>;
};

/**
 * Set the icon badge. At zero nothing is unread, so every notification still
 * sitting in Notification Center is stale too. Never throws: a badge is not
 * worth an error surface.
 */
export async function applyAppIconBadge(
  notifications: BadgeNotifications,
  count: number,
): Promise<void> {
  const next = Math.max(0, Math.floor(count));
  try {
    await notifications.setBadgeCountAsync(next);
    if (next === 0) await notifications.dismissAllNotificationsAsync();
  } catch {
    // Permission not granted, or the platform has no badge.
  }
}

/** Opening a session reads it: drop its pushes from Notification Center. */
export async function clearSessionNotifications(
  notifications: BadgeNotifications,
  sessionId: string,
): Promise<void> {
  if (!sessionId) return;
  try {
    const presented = await notifications.getPresentedNotificationsAsync();
    const ids = notificationIdsInSession(presented, sessionId);
    await Promise.all(ids.map((id) => notifications.dismissNotificationAsync(id)));
  } catch {
    // Nothing to clear, or the platform can't list them.
  }
}
