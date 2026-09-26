import SwiftUI
import SwiftData
import AMUXCore

/// Keeps the app icon badge equal to the list's unread sessions.
///
/// Observes `Session.hasUnread` through SwiftData instead of hooking each place
/// that flips it (opening a session, another device's read, inbox pings, the
/// server's unread flags, mark-as-unread) — a new writer is covered for free.
/// Coming forward re-applies the count, because a push that arrived while the
/// app was in the background has set the badge to 1.
struct AppIconBadgeSync: ViewModifier {
    let teamID: String

    @Query(filter: #Predicate<Session> { $0.hasUnread })
    private var unreadSessions: [Session]
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        let count = AppIconBadge.unreadCount(in: unreadSessions, teamID: teamID)
        content
            .onChange(of: count, initial: true) { _, newCount in
                Task { await AppIconBadge.apply(count: newCount) }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                Task { await AppIconBadge.apply(count: count) }
            }
    }
}
