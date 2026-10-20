import Foundation
import SwiftData

/// Lifecycle of a message queued in the outbox.
///
/// `pending` rows are visible to `OutboxSender.loop` once `nextAttemptAt`
/// has elapsed (or is nil). The sender flips them to `inFlight` while the
/// MQTT publish + Supabase persist round-trip is in progress, then to
/// `delivered` (success) or back to `pending` with backoff (transient
/// failure). After `OutboxSender.maxAttempts` failures the row settles
/// in `failed` and waits for an explicit user-initiated retry.
public enum OutboxState: String, Sendable, Codable {
    case pending      // newly enqueued or scheduled retry
    case inFlight     // sender is currently attempting it
    case delivered    // MQTT publish + Supabase persist both succeeded
    case failed       // exceeded retry budget; awaiting user-initiated retry
}

/// SwiftData-backed durable record for a message that the user has tapped
/// "send" on. The chat bubble is bound to this row's state via
/// `AgentEvent.outboxMessageID`, so the dot accessory always reflects
/// reality even if the app is killed mid-send and re-launched: the row
/// survives the relaunch and the sender resumes from where it left off.
@Model
public final class OutboxMessage {
    /// Canonical message id shared with the `Teamclu_Message` proto and
    /// the `messages.id` Supabase row. `OutboxSender` passes this id into
    /// `TeamcluService.sendMessage` so the daemon's dedup (slice B) sees
    /// retries land on the same id.
    @Attribute(.unique) public var messageID: String
    public var sessionID: String
    public var senderActorID: String
    public var content: String
    /// SwiftData rejects raw `[String]` properties on @Model classes —
    /// store the JSON-encoded form and decode lazily through the
    /// `mentionActorIDs` computed property.
    public var mentionActorIDsJSON: String
    public var modelID: String?
    public var createdAt: Date
    public var stateRaw: String
    public var attemptCount: Int
    public var lastAttemptAt: Date?
    public var lastError: String?
    /// Wall-clock time the sender is allowed to attempt this row again.
    /// nil = "due immediately" (fresh enqueue or user-initiated retry).
    public var nextAttemptAt: Date?
    /// JSON-encoded list of AttachmentUpload.attachmentID.
    /// Stored as JSON because SwiftData doesn't support [String] arrays on @Model.
    public var attachmentIDsJSON: String = "[]"
    /// JSON-encoded list of completed Supabase Storage URLs for this message's
    /// attachments. Populated from AttachmentUpload.storageURL after uploads
    /// finish; sent in Teamclu_Message.attachment_urls instead of appended to content.
    public var attachmentUrlsJSON: String = "[]"
    /// The persisted message this one quotes. Additive (schema 1.22.0).
    public var replyToMessageID: String?

    public init(messageID: String, sessionID: String, senderActorID: String,
                content: String, mentionActorIDs: [String], modelID: String?,
                attachmentURLs: [URL] = [], replyToMessageID: String? = nil) {
        self.messageID = messageID
        self.sessionID = sessionID
        self.senderActorID = senderActorID
        self.content = content
        self.mentionActorIDsJSON = (try? String(data: JSONEncoder().encode(mentionActorIDs), encoding: .utf8)) ?? "[]"
        self.modelID = modelID
        self.attachmentIDsJSON = "[]"
        self.attachmentUrlsJSON = (try? String(data: JSONEncoder().encode(attachmentURLs.map(\.absoluteString)), encoding: .utf8)) ?? "[]"
        self.createdAt = .now
        self.stateRaw = OutboxState.pending.rawValue
        self.attemptCount = 0
        self.replyToMessageID = replyToMessageID
    }

    public var state: OutboxState {
        get { OutboxState(rawValue: stateRaw) ?? .pending }
        set { stateRaw = newValue.rawValue }
    }

    /// Decoded attachment IDs from JSON.
    public var attachmentIDs: [String] {
        guard let data = attachmentIDsJSON.data(using: .utf8),
              let arr = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return arr
    }

    /// True if any attachment is pending or uploading.
    /// OutboxSender checks this before attempting to send.
    public var waitingForAttachments: Bool {
        !attachmentIDs.isEmpty
    }

    public var mentionActorIDs: [String] {
        guard let data = mentionActorIDsJSON.data(using: .utf8),
              let arr = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return arr
    }

    public var attachmentURLs: [URL] {
        guard let data = attachmentUrlsJSON.data(using: .utf8),
              let arr = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return arr.compactMap { URL(string: $0) }
    }
}
