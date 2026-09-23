import Foundation
import SwiftData
import os

private let outboxLogger = Logger(subsystem: "com.teamclu.mobile", category: "Outbox")

private actor OutboxAttemptLeases {
    static let shared = OutboxAttemptLeases()

    private var activeMessageIDs = Set<String>()

    func acquire(_ messageID: String) -> Bool {
        guard !activeMessageIDs.contains(messageID) else { return false }
        activeMessageIDs.insert(messageID)
        return true
    }

    func release(_ messageID: String) {
        activeMessageIDs.remove(messageID)
    }
}

/// Background sender that drains `OutboxMessage` rows from SwiftData,
/// attempting MQTT publish + Supabase persist via `TeamcluService.sendMessage`
/// and bumping `attemptCount` + `nextAttemptAt` on each failure.
///
/// Lifecycle: scoped to a chat detail view today. `start()` spawns a
/// loop task; `stop()` cancels it. The loop wakes once per second when
/// idle and drains all due rows in a single pass.
///
/// Concurrency model: this is an `actor` so all SwiftData mutations
/// (insert, save, fetch) happen on a single isolation domain. Each
/// pass uses a fresh `ModelContext` because `ModelContext` is not
/// `Sendable` and we don't want to share with the main-actor view's
/// context.
public actor OutboxSender {
    /// Backoff schedule cap: 0.5s, 1s, 2s, 4s, 8s, 16s, then 30s for
    /// every subsequent attempt up to `maxAttempts`. Picked so the
    /// first few retries cover transient drops (broker rotation,
    /// momentary radio loss) without hammering, and steady-state
    /// retries pace out at 30s — frequent enough that the user sees
    /// the dot fade to delivered shortly after airplane mode flips off.
    public static let maxAttempts = 20

    private weak var teamclu: TeamcluService?
    private let modelContainer: ModelContainer
    private var task: Task<Void, Never>?
    private var onDelivered: (@Sendable (String) async -> Void)?

    public init(teamclu: TeamcluService, modelContainer: ModelContainer) {
        self.teamclu = teamclu
        self.modelContainer = modelContainer
    }

    /// Called with the message id each time a row reaches `.delivered`.
    ///
    /// The chat view model uses it to hold the agent's placeholder card back
    /// until the message is actually out: the send button only enqueues, and
    /// an attachment upload plus the FC round trip sit between the tap and
    /// the broker. Raising the card on tap put "agent working" on screen
    /// above a message whose own status dot still read "sending".
    ///
    /// Fires for every session this sender drains, so a handler must check
    /// the id is one of its own.
    public func setOnDelivered(_ handler: (@Sendable (String) async -> Void)?) {
        onDelivered = handler
    }

    public func start() {
        guard task == nil else { return }
        task = Task { [weak self] in await self?.loop() }
    }

    public func stop() {
        task?.cancel()
        task = nil
    }

    /// Insert a fresh `OutboxMessage` row. The next loop tick (at most
    /// 1 second later) picks it up. Idempotent on `messageID` — if a
    /// row with the same id already exists this is a no-op so callers
    /// can safely re-enqueue without double-sending.
    public func enqueue(messageID: String, sessionID: String, senderActorID: String,
                        content: String, mentionActorIDs: [String], modelID: String?,
                        attachmentURLs: [URL] = []) async {
        let ctx = ModelContext(modelContainer)
        if let existing = fetchRow(messageID: messageID, in: ctx) {
            outboxLogger.notice("outbox enqueue skipped (already exists) msgId=\(String(messageID.prefix(8)), privacy: .public) state=\(existing.stateRaw, privacy: .public)")
            return
        }
        let row = OutboxMessage(messageID: messageID, sessionID: sessionID,
                                senderActorID: senderActorID, content: content,
                                mentionActorIDs: mentionActorIDs, modelID: modelID,
                                attachmentURLs: attachmentURLs)
        ctx.insert(row)
        do {
            try ctx.save()
            outboxLogger.notice("outbox enqueued msgId=\(String(messageID.prefix(8)), privacy: .public) sid=\(String(sessionID.prefix(8)), privacy: .public)")
        } catch {
            outboxLogger.error("outbox enqueue save FAILED msgId=\(String(messageID.prefix(8)), privacy: .public) err=\(String(describing: error), privacy: .public)")
        }
    }

    /// Bring a `failed` row back into rotation. Resets attemptCount /
    /// nextAttemptAt so the next loop tick picks it up immediately.
    /// No-op when the row is missing or already pending/inFlight/delivered.
    public func retry(messageID: String) async {
        let ctx = ModelContext(modelContainer)
        guard let row = fetchRow(messageID: messageID, in: ctx) else {
            outboxLogger.warning("outbox retry: msgId=\(String(messageID.prefix(8)), privacy: .public) not found")
            return
        }
        guard row.state == .failed else {
            outboxLogger.notice("outbox retry: msgId=\(String(messageID.prefix(8)), privacy: .public) already in state=\(row.stateRaw, privacy: .public), no-op")
            return
        }
        row.state = .pending
        row.attemptCount = 0
        row.nextAttemptAt = nil
        row.lastError = nil
        try? ctx.save()
        outboxLogger.notice("outbox retry: msgId=\(String(messageID.prefix(8)), privacy: .public) re-armed")
    }

    // MARK: - Loop

    private func loop() async {
        outboxLogger.notice("outbox loop started")
        defer { outboxLogger.notice("outbox loop stopped") }
        while !Task.isCancelled {
            let due = fetchDue()
            for row in due {
                if Task.isCancelled { return }
                await attempt(rowID: row.persistentModelID, messageID: row.messageID)
            }
            if due.isEmpty {
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    /// Returns rows that should be attempted on this tick: pending state,
    /// nextAttemptAt either nil or in the past. Ordered by createdAt so
    /// the user sees their messages flush out FIFO under normal conditions.
    /// We do this in two phases — fetch with a coarse predicate, then
    /// filter in memory — because SwiftData's predicate compiler chokes
    /// on the `nextAttemptAt == nil || nextAttemptAt <= now` disjunction
    /// when the column is optional.
    private func fetchDue() -> [OutboxMessage] {
        let ctx = ModelContext(modelContainer)
        let pendingRaw = OutboxState.pending.rawValue
        let descriptor = FetchDescriptor<OutboxMessage>(
            predicate: #Predicate { $0.stateRaw == pendingRaw },
            sortBy: [SortDescriptor(\.createdAt, order: .forward)]
        )
        let now = Date()
        let rows = (try? ctx.fetch(descriptor)) ?? []
        return rows.filter { row in
            guard let next = row.nextAttemptAt else { return true }
            return next <= now
        }
    }

    private func fetchRow(messageID: String, in ctx: ModelContext) -> OutboxMessage? {
        let descriptor = FetchDescriptor<OutboxMessage>(
            predicate: #Predicate { $0.messageID == messageID }
        )
        return try? ctx.fetch(descriptor).first
    }

    /// Wait for all attachments to complete or timeout.
    /// Returns true if all attachments completed, false if any failed or timeout.
    private func waitForAttachments(
        messageID: String,
        maxAttempts: Int = 60  // 30 seconds at 500ms poll
    ) async -> Bool {
        var attempts = 0
        while attempts < maxAttempts {
            let ctx = ModelContext(modelContainer)
            let descriptor: FetchDescriptor<AttachmentUpload> = FetchDescriptor(
                predicate: #Predicate<AttachmentUpload> { $0.messageID == messageID }
            )
            let attachments = (try? ctx.fetch(descriptor)) ?? []

            // Check if any failed
            if attachments.contains(where: { $0.uploadState == UploadState.failed }) {
                return false
            }

            // Check if all completed
            if attachments.isEmpty || attachments.allSatisfy({ $0.uploadState == UploadState.completed }) {
                return true
            }

            // Still uploading, wait and retry
            try? await Task.sleep(for: .milliseconds(500))
            attempts += 1
        }

        // Timeout
        return false
    }

    /// Structured records for this row's uploaded files, so the message row
    /// carries them and not just a URL buried in its text.
    ///
    /// Matched by storage URL rather than by `messageID`: the composer hands
    /// the outbox completed URLs, and `AttachmentUpload.messageID` is a
    /// throwaway id minted per upload, not the message's own. An upload with
    /// no matching record still contributes an entry built from its URL — a
    /// sizeless entry beats dropping the file from the row.
    private func attachmentRefs(for row: OutboxMessage, in ctx: ModelContext) -> [MessageAttachment] {
        let urls = row.attachmentURLs
        guard !urls.isEmpty else { return [] }
        let uploads = (try? ctx.fetch(FetchDescriptor<AttachmentUpload>())) ?? []
        let byURL = Dictionary(
            uploads.compactMap { upload -> (String, AttachmentUpload)? in
                guard let storageURL = upload.storageURL else { return nil }
                return (storageURL, upload)
            },
            uniquingKeysWith: { first, _ in first }
        )
        return urls.map { url in
            let upload = byURL[url.absoluteString]
            let name = upload?.fileName
                ?? url.lastPathComponent.removingPercentEncoding
                ?? url.lastPathComponent
            return MessageAttachment(
                filename: name,
                mime: AttachmentUploadManager.mimeType(forFileName: name),
                size: Int(upload?.fileSize ?? 0),
                bucketPath: Self.bucketPath(fromStorageURL: url)
            )
        }
    }

    /// The object's path inside the attachments bucket, recovered from the
    /// public URL storage handed back at upload time.
    ///
    /// Rebuilding it from the upload record instead would need the team id,
    /// which `AttachmentUpload` doesn't keep; the URL already encodes the
    /// exact path the server stored. Everything after the bucket segment is
    /// the path. Nil when there's no recognisable bucket segment, which
    /// leaves the entry readable by name but not fetchable.
    static func bucketPath(fromStorageURL url: URL) -> String? {
        let components = url.pathComponents
        guard let bucketIndex = components.lastIndex(of: "attachments"),
              bucketIndex + 1 < components.count
        else { return nil }
        let path = components[(bucketIndex + 1)...].joined(separator: "/")
        return path.removingPercentEncoding ?? path
    }

    private func attempt(rowID: PersistentIdentifier, messageID: String) async {
        guard await OutboxAttemptLeases.shared.acquire(messageID) else {
            outboxLogger.notice("outbox attempt skipped msgId=\(String(messageID.prefix(8)), privacy: .public) already leased")
            return
        }
        defer {
            Task { await OutboxAttemptLeases.shared.release(messageID) }
        }

        guard let teamclu else { return }
        let ctx = ModelContext(modelContainer)
        guard let row = ctx.model(for: rowID) as? OutboxMessage else { return }
        let msgPrefix = String(messageID.prefix(8))
        guard row.state == .pending else {
            outboxLogger.notice("outbox attempt skipped msgId=\(msgPrefix, privacy: .public) state=\(row.stateRaw, privacy: .public)")
            return
        }
        if let next = row.nextAttemptAt, next > Date() {
            return
        }

        // 1. Mark inFlight so a UI bound to state shows the spinner
        //    while the publish round-trip is in flight. We re-fetch
        //    via the persistent id so the row is bound to this ctx.
        row.state = .inFlight
        row.lastAttemptAt = .now
        try? ctx.save()

        // 1.5. Wait for attachments to complete before sending
        if row.attachmentIDs.count > 0 {
            let attachmentsReady = await waitForAttachments(messageID: row.messageID)
            if !attachmentsReady {
                // Attachments failed or timed out; mark message failed and return
                row.state = .failed
                row.lastError = "Attachment upload failed or timed out"
                try? ctx.save()
                outboxLogger.error("outbox FAILED (attachments) msgId=\(msgPrefix, privacy: .public) err=Attachment upload failed or timed out")
                return
            }
        }

        // 2. Attempt the durable send. `persistFirst: true` keeps
        //    Supabase's record in lockstep with the live publish so
        //    the daemon's catchup path can find the message even if
        //    the live publish was racy. Pass through `messageID` so
        //    every retry lands on the same broker-side id (slice B
        //    will dedup on this).
        do {
            _ = try await teamclu.sendMessage(
                sessionId: row.sessionID,
                content: row.content,
                modelId: row.modelID,
                mentionActorIDs: row.mentionActorIDs,
                attachmentURLs: row.attachmentURLs,
                attachments: attachmentRefs(for: row, in: ctx),
                persistFirst: true,
                messageID: row.messageID
            )
            row.state = .delivered
            row.lastError = nil
            try? ctx.save()
            outboxLogger.notice("outbox delivered msgId=\(msgPrefix, privacy: .public) attempts=\(row.attemptCount + 1, privacy: .public)")
            await onDelivered?(row.messageID)
        } catch {
            // 409 Conflict: the server already persisted this message (idempotent
            // duplicate from a retry or MQTT re-delivery). Treat as delivered.
            if Self.isConflictError(error) {
                row.state = .delivered
                row.lastError = nil
                try? ctx.save()
                outboxLogger.notice("outbox delivered (409 conflict, idempotent) msgId=\(msgPrefix, privacy: .public)")
                await onDelivered?(row.messageID)
                return
            }
            row.attemptCount += 1
            row.lastError = String(describing: error)
            if row.attemptCount >= Self.maxAttempts {
                row.state = .failed
                row.nextAttemptAt = nil
                outboxLogger.error("outbox FAILED (budget exhausted) msgId=\(msgPrefix, privacy: .public) attempts=\(row.attemptCount, privacy: .public) err=\(row.lastError ?? "", privacy: .public)")
            } else {
                let delay = Self.backoff(forAttempt: row.attemptCount)
                row.state = .pending
                row.nextAttemptAt = Date().addingTimeInterval(delay)
                outboxLogger.notice("outbox retry scheduled msgId=\(msgPrefix, privacy: .public) attempts=\(row.attemptCount, privacy: .public) backoff=\(delay, privacy: .public)s err=\(row.lastError ?? "", privacy: .public)")
            }
            try? ctx.save()
        }
    }

    /// Returns true when `error` is a 409 Conflict, meaning the server
    /// already processed the message (idempotent duplicate). The correct
    /// action is to mark the row delivered and stop retrying.
    static func isConflictError(_ error: Error) -> Bool {
        guard case let .requestFailed(status, _, _) = error as? CloudAPIError else { return false }
        return status == 409
    }

    /// Schedule: 0.5, 1, 2, 4, 8, 16, then 30 capped.
    /// `attempt` is the post-bump counter (so the first failure passes
    /// `1`, returning 0.5 — wait half a second before retrying once).
    static func backoff(forAttempt attempt: Int) -> TimeInterval {
        let exp = max(0, attempt - 1)
        let base = pow(2.0, Double(min(exp, 6))) * 0.5
        return min(base, 30)
    }
}
