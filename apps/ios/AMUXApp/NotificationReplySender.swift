// apps/ios/AMUXApp/NotificationReplySender.swift
import Foundation
import SwiftData
import UserNotifications
import AMUXCore

/// Sends a reply typed into a message notification. The app may have been
/// launched just for this, so everything is rebuilt from disk: the bearer
/// from the Keychain, the user's actor from `NotificationReply`, the
/// sender's kind from the SwiftData cache.
@MainActor
enum NotificationReplySender {
    /// Set by the app at launch; read to tell an agent sender from a person.
    static var modelContainer: ModelContainer?

    static func send(_ text: String, to target: NotificationReply.Target) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            guard let me = NotificationReply.actorID(team: target.teamID),
                  let config = CloudAPIConfigurationStore.configuration()
            else { throw CloudAPIError.missingAccessToken }
            let storage = KeychainSessionStorage()
            // No refresh here, as for push registration: the onboarding
            // SessionStore owns it. An expired token fails over to the draft.
            let repository = CloudAPIRepositoryFactory.messagesRepository(configuration: config) {
                guard let session = try storage.load(), session.expiresAt.timeIntervalSinceNow > 0 else {
                    throw CloudAPIError.missingAccessToken
                }
                return session.accessToken
            }
            try await repository.insert(NotificationReply.insertInput(
                text: trimmed,
                target: target,
                myActorID: me,
                senderIsAgent: isAgent(target.senderActorID)
            ))
        } catch {
            NSLog("[push] notification reply failed: \(error.localizedDescription)")
            // Keep what was typed: it waits in the composer, and a local
            // notification says so (tapping it opens the session).
            SessionDraftStore.shared.setDraft(trimmed, for: target.sessionID)
            let content = UNMutableNotificationContent()
            content.title = String(localized: "Reply not sent")
            content.body = String(localized: "Saved as a draft. Open the conversation to send it.")
            content.userInfo = ["session_id": target.sessionID]
            content.threadIdentifier = target.sessionID
            try? await UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            )
        }
    }

    static func isAgent(_ actorID: String?) -> Bool {
        guard let actorID, let container = modelContainer else { return false }
        var descriptor = FetchDescriptor<CachedActor>(predicate: #Predicate { $0.actorId == actorID })
        descriptor.fetchLimit = 1
        return (try? container.mainContext.fetch(descriptor).first)?.isAgent ?? false
    }
}
