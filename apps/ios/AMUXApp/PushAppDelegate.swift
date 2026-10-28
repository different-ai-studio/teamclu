// apps/ios/AMUXApp/PushAppDelegate.swift
import UIKit
import UserNotifications
import SwiftData
import AMUXCore

public extension Notification.Name {
    static let amuxOpenSession    = Notification.Name("amuxOpenSession")
    static let amuxApnsTokenReady = Notification.Name("amuxApnsTokenReady")
}

final class PushAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions:
                       [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories([Self.messageCategory])
        return true
    }

    /// Message pushes carry this category (FC `buildApnsPayload`): a text
    /// field to answer without opening the app. Unlocking is not required —
    /// the same as answering a message from the lock screen elsewhere.
    private static let messageCategory = UNNotificationCategory(
        identifier: NotificationReply.categoryID,
        actions: [
            UNTextInputNotificationAction(
                identifier: NotificationReply.replyActionID,
                title: String(localized: "Reply"),
                options: [],
                textInputButtonTitle: String(localized: "Send"),
                textInputPlaceholder: String(localized: "Message")
            ),
        ],
        intentIdentifiers: [],
        options: []
    )

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        NotificationCenter.default.post(
            name: .amuxApnsTokenReady, object: nil, userInfo: ["token": hex]
        )
    }

    /// Message pushes carry `content-available`, so an agent's reply wakes
    /// the app in the background long enough to close that session's Live
    /// Activity with the answer — the session view that would normally do
    /// it is not running.
    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        guard let sessionID = userInfo["session_id"] as? String,
              NotificationReplySender.isAgent(userInfo["sender_actor_id"] as? String)
        else { return .noData }
        let preview = (userInfo["preview"] as? String)
            ?? ((userInfo["aps"] as? [String: Any])?["alert"] as? [String: Any])?["body"] as? String
        AgentTurnActivityController.shared.finish(
            sessionID: sessionID,
            finalLine: TurnActivityCenter.summary(of: preview)
        )
        return .newData
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("[push] APNs registration failed: \(error.localizedDescription)")
    }

    // Foreground: suppress banner if user is already on that session.
    // nonisolated: UNUserNotificationCenterDelegate calls these off the main
    // actor with non-Sendable parameters; the class is otherwise MainActor-
    // inferred via UIApplicationDelegate. CurrentSessionFocus.sessionID is
    // nonisolated(unsafe), so no actor hop is needed to read it.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                 willPresent notification: UNNotification) async
                                 -> UNNotificationPresentationOptions {
        let info = notification.request.content.userInfo
        let sid = info["session_id"] as? String
        if sid != nil && sid == CurrentSessionFocus.sessionID {
            return []
        }
        return [.banner, .sound, .badge]
    }

    // Tap: post deep-link event for ContentView to handle.
    // Completion-handler form, not `async`: the async form's bridge calls the
    // system completion handler on whatever thread the task ends on, and the
    // state-restoration snapshot UIKit takes inside it throws off the main
    // thread — tapping a notification crashed the app (TestFlight 1.2 (37)).
    // The payload is parsed here because it can't cross to the main actor.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                 didReceive response: UNNotificationResponse,
                                 withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let replyText = (response.actionIdentifier == NotificationReply.replyActionID)
            ? (response as? UNTextInputNotificationResponse)?.userText
            : nil
        let replyTarget = replyText == nil ? nil : NotificationReply.target(from: info)
        let sid = info["session_id"] as? String
        let mid = info["message_id"] as? String
        // Only ever called on the main actor below, which is what UIKit needs.
        nonisolated(unsafe) let done = completionHandler
        Task { @MainActor in
            defer { done() }
            if let replyText {
                if let replyTarget {
                    await NotificationReplySender.send(replyText, to: replyTarget)
                }
                return
            }
            guard let sid else { return }
            var payload: [String: Any] = ["session_id": sid]
            if let mid { payload["message_id"] = mid }
            NotificationCenter.default.post(
                name: .amuxOpenSession, object: nil, userInfo: payload)
        }
    }
}
