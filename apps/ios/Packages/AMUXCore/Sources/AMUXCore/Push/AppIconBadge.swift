import Foundation
import UserNotifications

/// The number on the app icon: how many sessions the list shows a red dot for.
///
/// FC's APNs payload sets the badge to 1 on every push (it has no cheap
/// per-user unread count), and nothing on the device ever lowered it, so a
/// single push left a "1" on the icon for good. While the app runs it owns the
/// number; a push only means "something new" until the app next comes forward.
public enum AppIconBadge {
    /// Unread sessions of `teamID` that the default list shows. Archived and
    /// cron sessions are left out: the list hides them, so their red dot could
    /// never be cleared and the badge would stick again.
    public static func unreadCount(in sessions: [Session], teamID: String) -> Int {
        guard !teamID.isEmpty else { return 0 }
        return sessions.count {
            $0.hasUnread && $0.teamId == teamID && !$0.isArchived && $0.source != "cron"
        }
    }

    /// Delivered notifications belonging to one session. FC sends the session
    /// id as the APNs `thread-id`.
    static func notificationIDs(_ delivered: [(id: String, threadID: String)],
                                inSession sessionID: String) -> [String] {
        guard !sessionID.isEmpty else { return [] }
        return delivered.filter { $0.threadID == sessionID }.map(\.id)
    }

    /// Set the icon badge. At zero nothing is unread, so every notification
    /// still sitting in Notification Center is stale too.
    @MainActor
    public static func apply(count: Int) async {
        let center = UNUserNotificationCenter.current()
        try? await center.setBadgeCount(count)
        if count == 0 {
            center.removeAllDeliveredNotifications()
        }
    }

    /// Opening a session reads it: drop its pushes from Notification Center.
    public static func clearDeliveredNotifications(forSession sessionID: String) async {
        let center = UNUserNotificationCenter.current()
        let delivered = await center.deliveredNotifications().map {
            (id: $0.request.identifier, threadID: $0.request.content.threadIdentifier)
        }
        let ids = notificationIDs(delivered, inSession: sessionID)
        if !ids.isEmpty {
            center.removeDeliveredNotifications(withIdentifiers: ids)
        }
    }
}
