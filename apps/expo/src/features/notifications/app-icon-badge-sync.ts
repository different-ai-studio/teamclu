import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { AppState } from "react-native";

import {
  getUnreadSessionCount,
  hasUnreadSessionCountReport,
  subscribeUnreadSessionCountReports,
} from "../sessions/unread-store";
import {
  applyAppIconBadge,
  clearSessionNotifications,
  type BadgeNotifications,
} from "./app-icon-badge";

const notifications: BadgeNotifications = {
  setBadgeCountAsync: (count) => Notifications.setBadgeCountAsync(count),
  dismissAllNotificationsAsync: () => Notifications.dismissAllNotificationsAsync(),
  getPresentedNotificationsAsync: () =>
    Notifications.getPresentedNotificationsAsync() as unknown as ReturnType<
      BadgeNotifications["getPresentedNotificationsAsync"]
    >,
  dismissNotificationAsync: (id) => Notifications.dismissNotificationAsync(id),
};

/**
 * Keeps the app icon badge equal to the list's unread sessions (iOS #1608
 * `AppIconBadgeSync`). Follows the unread store, which every list load and
 * refresh writes, rather than hooking each place that flips a red dot. Coming
 * forward re-applies the count, because a push that arrived while the app was
 * in the background has set the badge to 1. Signed out → 0.
 */
export function useAppIconBadgeSync(signedOut: boolean): void {
  useEffect(() => {
    if (signedOut) {
      void applyAppIconBadge(notifications, 0);
      return;
    }
    // Only a reported count is acted on: before the list has answered, 0
    // means "not known yet" and applying it would wipe Notification Center.
    let applied: number | null = null;
    const apply = (count: number) => {
      if (count === applied) return;
      applied = count;
      void applyAppIconBadge(notifications, count);
    };
    if (hasUnreadSessionCountReport()) apply(getUnreadSessionCount());
    const unsubscribe = subscribeUnreadSessionCountReports(apply);
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active" || !hasUnreadSessionCountReport()) return;
      // A push in the background has set the badge to 1: re-apply.
      applied = null;
      apply(getUnreadSessionCount());
    });
    return () => {
      unsubscribe();
      subscription.remove();
    };
  }, [signedOut]);
}

/** Opening a session reads it: its pushes in Notification Center are stale. */
export function clearDeliveredSessionNotifications(sessionId: string): void {
  void clearSessionNotifications(notifications, sessionId);
}
