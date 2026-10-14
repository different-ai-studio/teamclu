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
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                 didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        if response.actionIdentifier == NotificationReply.replyActionID,
           let reply = response as? UNTextInputNotificationResponse {
            // Parsed here: the payload dictionary can't cross to the main actor.
            if let target = NotificationReply.target(from: info) {
                await NotificationReplySender.send(reply.userText, to: target)
            }
            return
        }
        guard let sid = info["session_id"] as? String else { return }
        var payload: [String: Any] = ["session_id": sid]
        if let mid = info["message_id"] as? String { payload["message_id"] = mid }
        await MainActor.run {
            NotificationCenter.default.post(
                name: .amuxOpenSession, object: nil, userInfo: payload)
        }
    }
}
