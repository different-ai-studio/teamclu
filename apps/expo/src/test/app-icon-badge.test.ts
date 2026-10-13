import { describe, expect, it, vi } from "vitest";

import {
  applyAppIconBadge,
  clearSessionNotifications,
  notificationIdsInSession,
  unreadBadgeCount,
  type BadgeNotifications,
  type PresentedNotification,
} from "../features/notifications/app-icon-badge";

const row = (over: Partial<{ hasUnread: boolean; teamId: string; source: string; archivedAt: string | null }> = {}) => ({
  hasUnread: true,
  teamId: "t1",
  source: "user",
  archivedAt: null,
  ...over,
});

describe("unreadBadgeCount", () => {
  it("counts unread sessions of the team", () => {
    expect(unreadBadgeCount([row(), row(), row({ hasUnread: false })], "t1")).toBe(2);
  });

  it("is zero when nothing is unread or there is no team", () => {
    expect(unreadBadgeCount([row({ hasUnread: false })], "t1")).toBe(0);
    expect(unreadBadgeCount([], "t1")).toBe(0);
    expect(unreadBadgeCount([row()], null)).toBe(0);
    expect(unreadBadgeCount([row()], "")).toBe(0);
  });

  it("skips archived and cron sessions", () => {
    expect(
      unreadBadgeCount([row({ archivedAt: "2026-01-01" }), row({ source: "cron" }), row()], "t1"),
    ).toBe(1);
  });

  it("skips rows of another team", () => {
    expect(unreadBadgeCount([row({ teamId: "t2" }), row()], "t1")).toBe(1);
  });
});

const presented = (id: string, threadIdentifier: string | null, data: unknown = {}): PresentedNotification => ({
  request: { identifier: id, content: { threadIdentifier, data } },
});

describe("notificationIdsInSession", () => {
  it("matches by APNs thread or by the payload's session id", () => {
    const list = [
      presented("n1", "s1"),
      presented("n2", "s2"),
      presented("n3", null, { sessionId: "s1" }),
      presented("n4", null, { session_id: "s3" }),
    ];
    expect(notificationIdsInSession(list, "s1")).toEqual(["n1", "n3"]);
    expect(notificationIdsInSession(list, "s9")).toEqual([]);
    expect(notificationIdsInSession(list, "")).toEqual([]);
  });
});

function fakeNotifications(list: PresentedNotification[] = []): BadgeNotifications & {
  [K in keyof BadgeNotifications]: ReturnType<typeof vi.fn>;
} {
  return {
    setBadgeCountAsync: vi.fn().mockResolvedValue(true),
    dismissAllNotificationsAsync: vi.fn().mockResolvedValue(undefined),
    getPresentedNotificationsAsync: vi.fn().mockResolvedValue(list),
    dismissNotificationAsync: vi.fn().mockResolvedValue(undefined),
  } as never;
}

describe("applyAppIconBadge", () => {
  it("sets the count and leaves Notification Center alone while something is unread", async () => {
    const n = fakeNotifications();
    await applyAppIconBadge(n, 3);
    expect(n.setBadgeCountAsync).toHaveBeenCalledWith(3);
    expect(n.dismissAllNotificationsAsync).not.toHaveBeenCalled();
  });

  it("at zero also clears delivered notifications", async () => {
    const n = fakeNotifications();
    await applyAppIconBadge(n, 0);
    expect(n.setBadgeCountAsync).toHaveBeenCalledWith(0);
    expect(n.dismissAllNotificationsAsync).toHaveBeenCalled();
  });

  it("never throws", async () => {
    const n = fakeNotifications();
    n.setBadgeCountAsync.mockRejectedValue(new Error("no permission"));
    await expect(applyAppIconBadge(n, 1)).resolves.toBeUndefined();
  });
});

describe("clearSessionNotifications", () => {
  it("dismisses only the opened session's pushes", async () => {
    const n = fakeNotifications([presented("n1", "s1"), presented("n2", "s2")]);
    await clearSessionNotifications(n, "s1");
    expect(n.dismissNotificationAsync).toHaveBeenCalledTimes(1);
    expect(n.dismissNotificationAsync).toHaveBeenCalledWith("n1");
  });
});
