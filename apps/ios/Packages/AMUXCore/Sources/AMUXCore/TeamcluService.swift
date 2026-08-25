import Foundation
import Observation
import SwiftProtobuf
import SwiftData
import os

private let teamcluLogger = Logger(subsystem: "com.teamclu.mobile", category: "TeamcluService")

@Observable
@MainActor
public final class TeamcluService {
    public var sessions: [Session] = []
    public var isConnected = false

    private var mqtt: MQTTService?
    public var mqttRef: MQTTService? { mqtt }
    private var hub: MQTTMessageHub?
    public var hubRef: MQTTMessageHub? { hub }
    /// Centralised RPC awaiter — wraps the publish + filtered-stream +
    /// timeout + requestID-match dance that used to be open-coded at
    /// every call site. Built alongside mqtt/hub in `configureRuntime`.
    private var rpcClient: TeamcluRPCClient?
    private var teamId: String = ""
    private var peerId: String = ""
    private var connectedAgentsStore: ConnectedAgentsStore?
    private var messagesRepository: (any MessagesRepository)?
    /// Connected-agent actor-ids whose `notify` topics are currently
    /// subscribed. Kept in sync with `connectedAgentsStore.agents` via the
    /// observer task that `start()` launches. An agent's routing actor IS its
    /// actor id (== `ConnectedAgent.id`).
    private var subscribedActorIDs: Set<String> = []
    /// Whether our own actor's `rpc/res` topic is subscribed. The daemon
    /// replies to every RPC on `amux/{team}/{requesterActorId}/rpc/res`
    /// (apps/daemon/src/teamclu/rpc.rs:48-53), so we subscribe to our own
    /// actor's response topic once rather than per-target.
    private var ownRpcResSubscribed = false
    private var agentObserverTask: Task<Void, Never>?
    /// Member id of the local actor, resolved from the retained device peer
    /// list by matching our own peer_id. Populated once
    /// PeerList arrives; used as `sender_actor_id` on outgoing RPCs so the
    /// daemon records the creator as a member rather than a device.
    public private(set) var localMemberId: String = ""
    public private(set) var localDisplayName: String = ""
    private var foregroundSessionIDsSet: Set<String> = []
    private var listenerTask: Task<Void, Never>?
    private var modelContainer: ModelContainer?
    private var isTestingForegroundLifecycle = false
    internal private(set) var fetchRecentMessagesCalls: [String] = []
    internal private(set) var fetchSessionInfoCalls: [String] = []
    internal private(set) var refreshedSessionIDs: [String] = []

    internal var foregroundSessionIDs: [String] {
        foregroundSessionIDsSet.sorted()
    }

    public var currentHumanActorId: String? {
        localMemberId.isEmpty ? nil : localMemberId
    }

    /// The signed-in user's actor id, used to stamp `requesterActorID` on every
    /// outgoing RPC. The daemon replies on `amux/{team}/{requesterActorId}/rpc/res`
    /// (apps/daemon/src/teamclu/rpc.rs:48-53), so this MUST be set or the
    /// response never routes back to us.
    private var requesterActorID: String { localMemberId }

    public init() {}

    // MARK: - Lifecycle

    public func start(
        mqtt: MQTTService,
        hub: MQTTMessageHub,
        teamId: String,
        peerId: String,
        modelContext: ModelContext,
        connectedAgentsStore: ConnectedAgentsStore?,
        currentActorID: String? = nil,
        messagesRepository: (any MessagesRepository)? = nil
    ) {
        listenerTask?.cancel()
        agentObserverTask?.cancel()
        let container = modelContext.container
        configureRuntime(
            mqtt: mqtt,
            hub: hub,
            teamId: teamId,
            peerId: peerId,
            modelContainer: container,
            connectedAgentsStore: connectedAgentsStore,
            messagesRepository: messagesRepository
        )
        // Seed the human actor_id from Supabase auth (passed in by
        // ContentView via onboarding.currentContext.memberActorID).
        // FetchPeers is a fallback that hydrates display_name + peer
        // metadata; the actor_id itself is authoritative from auth and
        // doesn't need a daemon round-trip.
        if let currentActorID, !currentActorID.isEmpty {
            localMemberId = currentActorID
        }
        let ctx = ModelContext(container)

        // Load cached sessions immediately
        sessions = (try? ctx.fetch(FetchDescriptor<Session>(
            sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
        ))) ?? []

        listenerTask = Task { [weak self] in
            guard let self else { return }
            // Wait for MQTT connection (up to 15s)
            var waited = 0
            while mqtt.connectionState != .connected {
                try? await Task.sleep(for: .milliseconds(200))
                if Task.isCancelled { return }
                waited += 200
                if waited >= 15_000 {
                    print("[TeamcluService] timed out waiting for MQTT connection")
                    return
                }
            }

            // Main listener wants both actor/notify and session/live topics
            // (parseActorNotifyTopic + the session/{id}/live shape check).
            // Hub fan-out delivers only matching messages; RPC awaiters
            // attach their own per-response-topic filtered streams below.
            let stream = await hub.messages(matching: { msg in
                let t = msg.topic
                return t.hasSuffix("/notify")
                    || (t.contains("/session/") && t.hasSuffix("/live"))
            })

            // Per-daemon notify+rpcRes subscriptions. Re-synced on agents-store
            // mutations so newly-resolved daemons start receiving notify and
            // RPC responses without a manual reconnect.
            await self.rehydrateForegroundSessionSubscriptions(on: mqtt)
            await self.resyncDaemonSubscriptions()

            self.agentObserverTask = Task { [weak self] in
                guard let self else { return }
                while !Task.isCancelled {
                    await self.waitForAgentsMutation()
                    if Task.isCancelled { return }
                    await self.resyncDaemonSubscriptions()
                }
            }

            // Phase 2b: peers come from FetchPeers RPC instead of retained
            // devicePeers subscription. One-shot fetch after subscribe; notify
            // handler does follow-ups on peers.changed / members.changed.
            Task { [weak self] in
                guard let self else { return }
                let peers = await self.fetchPeersAcrossDaemons()
                self.syncPeers(peers)
            }

            self.isConnected = true
            print("[TeamcluService] subscribed to teamclu topics for team: \(teamId)")

            for await incoming in stream {
                if Task.isCancelled { break }
                await self.handleIncoming(incoming, modelContext: ctx)
            }

            self.isConnected = false
        }
    }

    public func stop() {
        listenerTask?.cancel()
        listenerTask = nil
        agentObserverTask?.cancel()
        agentObserverTask = nil
        isConnected = false
        for sessionId in foregroundSessionIDsSet {
            let topic = MQTTTopics.sessionLive(teamID: teamId, sessionID: sessionId)
            mqtt?.unsubscribeForLifecycleStop(topic)
        }
        foregroundSessionIDsSet.removeAll()
        subscribedActorIDs.removeAll()
        ownRpcResSubscribed = false
    }

    /// Subscribes our own actor's rpc/res topic exactly once. The daemon replies
    /// to every RPC on the requester's own actor response topic (rpc.rs:48-53),
    /// independent of which agent we target, so this standing subscription must
    /// stay up for the lifetime of the service. Idempotent: a no-op after the
    /// first successful subscribe. Callers issuing an RPC should invoke this
    /// before `rpcClient.invoke` so the very first call (before any resync has
    /// run) still has the response topic subscribed — but must NEVER pair it
    /// with a per-call unsubscribe, which would clobber the shared sub.
    private func ensureOwnRpcResSubscribed() async {
        guard let mqtt, !ownRpcResSubscribed, !localMemberId.isEmpty else { return }
        try? await mqtt.subscribe(MQTTTopics.actorRpcResponse(teamID: teamId, actorID: localMemberId))
        ownRpcResSubscribed = true
    }

    private func resyncDaemonSubscriptions() async {
        guard let mqtt else { return }
        // The daemon replies to RPCs on our own actor's response topic
        // (rpc.rs:48-53), so subscribe to it once, independent of which agent
        // we target.
        await ensureOwnRpcResSubscribed()
        let desired: Set<String> = {
            guard let store = connectedAgentsStore else { return [] }
            // An agent's routing actor IS its actor id (== ConnectedAgent.id).
            return Set(store.agents.map(\.id).filter { !$0.isEmpty })
        }()
        let toAdd = desired.subtracting(subscribedActorIDs)
        let toRemove = subscribedActorIDs.subtracting(desired)
        for id in toAdd {
            try? await mqtt.subscribe(MQTTTopics.actorNotify(teamID: teamId, actorID: id))
        }
        for id in toRemove {
            try? await mqtt.unsubscribe(MQTTTopics.actorNotify(teamID: teamId, actorID: id))
        }
        subscribedActorIDs = desired

        // FetchPeers needs at least one subscribed daemon to be able to issue
        // the RPC. The one-shot fetch in `start()` runs before
        // `connectedAgentsStore` populates, so it normally returns no peers
        // and `localMemberId` never resolves. Re-fetch whenever new daemons
        // come online so subsequent `sendMessage` calls can pass their actor
        // guard.
        if !toAdd.isEmpty {
            let peers = await fetchPeersAcrossDaemons()
            syncPeers(peers)
        }
    }

    private func waitForAgentsMutation() async {
        guard let store = connectedAgentsStore else {
            try? await Task.sleep(for: .seconds(60))
            return
        }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            withObservationTracking {
                _ = store.agents
            } onChange: {
                cont.resume()
            }
        }
    }

    /// Fans FetchPeers RPCs across every known daemon and concatenates the
    /// results. Pre-multi-daemon code only queried a single daemon; we mirror
    /// the same intent (resolve our peer record for `localMemberId`) but no
    /// longer require a single privileged daemon. Returns an empty array if no
    /// daemons are subscribed yet.
    private func fetchPeersAcrossDaemons() async -> [Amux_PeerInfo] {
        var combined: [Amux_PeerInfo] = []
        for id in subscribedActorIDs.sorted() {
            combined.append(contentsOf: await fetchPeers(targetActorID: id))
        }
        return combined
    }

    // MARK: - Message Dispatch

    private func handleIncoming(_ incoming: MQTTIncoming, modelContext: ModelContext) async {
        let topic = incoming.topic

        if let notifyActorID = parseActorNotifyTopic(topic) {
            guard let notify = try? Teamclu_Notify(serializedBytes: incoming.payload) else {
                print("[TeamcluService] failed to decode actor/notify payload as Notify")
                return
            }

            switch notify.eventType {
            case "membership.refresh", "members.changed":
                if !notify.refreshHint.isEmpty {
                    await refreshSessionState(for: notify.refreshHint, modelContext: modelContext)
                }
            case "peers.changed":
                // Refresh peers from the daemon that emitted the notify, since
                // its peer set is the authority for joins/leaves in its scope.
                let peers = await fetchPeers(targetActorID: notifyActorID)
                syncPeers(peers)
            case "workspaces.changed":
                // Upsert the daemon's current workspace set into the local
                // cache so pickers show the change without a relaunch.
                // Upsert-only: other daemons' workspaces ride their own
                // notifies, so nothing is deleted here.
                let workspaces = await fetchWorkspaces(targetActorID: notifyActorID)
                syncWorkspaces(workspaces, modelContext: modelContext)
            default:
                break
            }
            return
        }

        if topic.contains("/session/") && topic.hasSuffix("/live") {
            guard let envelope = try? Teamclu_LiveEventEnvelope(serializedBytes: incoming.payload) else {
                print("[TeamcluService] failed to decode LiveEventEnvelope from topic: \(topic)")
                return
            }
            handleLiveEvent(envelope, modelContext: modelContext)
            return
        }

    }

    // MARK: - Sync Handlers

    /// Updates `localMemberId` and `localDisplayName` from a peer list returned
    /// by the FetchPeers RPC. Replaces the former retained devicePeers handler.
    private func syncPeers(_ peers: [Amux_PeerInfo]) {
        guard let mine = peers.first(where: { $0.peerID == peerId }) else { return }
        if !mine.memberID.isEmpty, mine.memberID != localMemberId {
            localMemberId = mine.memberID
        }
        if !mine.displayName.isEmpty {
            localDisplayName = mine.displayName
        }
    }

    /// Upserts a daemon's `FetchWorkspaces` result into the SwiftData
    /// `Workspace` cache. Upsert-only by design: each daemon's notify only
    /// speaks for its own workspace set, so rows are never deleted here —
    /// mirrors `SessionListViewModel.syncWorkspaceRecords`.
    private func syncWorkspaces(_ workspaces: [Amux_WorkspaceInfo], modelContext: ModelContext) {
        guard !workspaces.isEmpty else { return }
        for info in workspaces {
            let id = info.workspaceID
            guard !id.isEmpty else { continue }
            let descriptor = FetchDescriptor<Workspace>(predicate: #Predicate { $0.workspaceId == id })
            if let existing = try? modelContext.fetch(descriptor).first {
                if !info.displayName.isEmpty { existing.displayName = info.displayName }
                if !info.path.isEmpty { existing.path = info.path }
            } else {
                modelContext.insert(Workspace(
                    workspaceId: id,
                    path: info.path,
                    displayName: info.displayName
                ))
            }
        }
        try? modelContext.save()
    }

    private func syncSessionMeta(_ proto: Teamclu_SessionInfo, modelContext: ModelContext) {
        let sessionId = proto.sessionID
        guard !sessionId.isEmpty else { return }

        let descriptor = FetchDescriptor<Session>(
            predicate: #Predicate { $0.sessionId == sessionId }
        )
        let existing = (try? modelContext.fetch(descriptor))?.first ?? {
            let created = Session(
                sessionId: sessionId,
                teamId: proto.teamID,
                title: proto.title,
                createdBy: proto.createdBy,
                createdAt: proto.createdAt > 0
                    ? Date(timeIntervalSince1970: TimeInterval(proto.createdAt))
                    : .now,
                summary: proto.summary,
                participantCount: proto.participants.count,
                lastMessagePreview: proto.lastMessagePreview,
                lastMessageAt: proto.lastMessageAt > 0
                    ? Date(timeIntervalSince1970: TimeInterval(proto.lastMessageAt))
                    : nil,
                ideaId: proto.ideaID
            )
            created.primaryAgentId = proto.primaryAgentID.isEmpty ? nil : proto.primaryAgentID
            modelContext.insert(created)
            return created
        }()

        existing.primaryAgentId = proto.primaryAgentID.isEmpty ? nil : proto.primaryAgentID
        existing.teamId = proto.teamID
        existing.createdBy = proto.createdBy
        existing.createdAt = proto.createdAt > 0
            ? Date(timeIntervalSince1970: TimeInterval(proto.createdAt))
            : existing.createdAt
        existing.participantCount = proto.participants.count
        // Fill-only, never overwrite: the Cloud API owns the title now
        // (rename PATCHes it), while the daemon serves whatever its local
        // sessions.toml last saw — overwriting here made renames visibly
        // snap back on the next membership.refresh notify.
        if !proto.title.isEmpty && existing.title.isEmpty { existing.title = proto.title }
        if !proto.summary.isEmpty { existing.summary = proto.summary }
        if !proto.ideaID.isEmpty { existing.ideaId = proto.ideaID }
        if !proto.lastMessagePreview.isEmpty { existing.lastMessagePreview = proto.lastMessagePreview }
        if proto.lastMessageAt > 0 {
            existing.lastMessageAt = Date(timeIntervalSince1970: TimeInterval(proto.lastMessageAt))
        }
        try? modelContext.save()
    }

    private func syncMessage(_ message: Teamclu_Message, modelContext: ModelContext) {
        let msgId = message.messageID
        let descriptor = FetchDescriptor<SessionMessage>(
            predicate: #Predicate { $0.messageId == msgId }
        )
        guard (try? modelContext.fetch(descriptor))?.first == nil else {
            // Already exists, skip
            return
        }

        let kindStr: String
        switch message.kind {
        case .text: kindStr = "text"
        case .system: kindStr = "system"
        case .workEvent: kindStr = "work_event"
        default: kindStr = "text"
        }

        let sessionMessage = SessionMessage(
            messageId: message.messageID,
            sessionId: message.sessionID,
            senderActorId: message.senderActorID,
            kind: kindStr,
            content: message.content,
            createdAt: message.createdAt > 0
                ? Date(timeIntervalSince1970: TimeInterval(message.createdAt))
                : .now,
            replyToMessageId: message.replyToMessageID,
            mentions: message.mentions.joined(separator: ",")
        )
        sessionMessage.model = message.model.isEmpty ? nil : message.model
        modelContext.insert(sessionMessage)

        let messageSessionId = message.sessionID
        let sessionDescriptor = FetchDescriptor<Session>(
            predicate: #Predicate { $0.sessionId == messageSessionId }
        )
        if let session = (try? modelContext.fetch(sessionDescriptor))?.first {
            session.lastMessagePreview = String(message.content.prefix(140))
            session.lastMessageAt = message.createdAt > 0
                ? Date(timeIntervalSince1970: TimeInterval(message.createdAt))
                : .now
        }
        try? modelContext.save()
    }

    private func handleLiveEvent(_ envelope: Teamclu_LiveEventEnvelope, modelContext: ModelContext) {
        if envelope.eventType.hasPrefix("message.") {
            guard let messageEnvelope = try? Teamclu_SessionMessageEnvelope(serializedBytes: envelope.body) else {
                print("[TeamcluService] failed to decode SessionMessageEnvelope from live event: \(envelope.eventType)")
                return
            }
            if messageEnvelope.hasMessage {
                syncMessage(messageEnvelope.message, modelContext: modelContext)
            }
            return
        }

        if envelope.eventType.hasPrefix("idea.") {
            guard let ideaEvent = try? Teamclu_IdeaEvent(serializedBytes: envelope.body) else {
                print("[TeamcluService] failed to decode IdeaEvent from live event: \(envelope.eventType)")
                return
            }
            syncIdeaEvent(ideaEvent, modelContext: modelContext)
        }
    }

    private func syncIdeaEvent(_ event: Teamclu_IdeaEvent, modelContext: ModelContext) {
        let idea: Teamclu_Idea
        switch event.event {
        case .created(let item):
            idea = item
        case .updated(let item):
            idea = item
        case .claimed(let claim):
            let claimItemId = claim.ideaID
            let claimDesc = FetchDescriptor<SessionIdea>(
                predicate: #Predicate { $0.ideaId == claimItemId }
            )
            if let existing = (try? modelContext.fetch(claimDesc))?.first {
                if existing.status == "open" {
                    existing.status = "in_progress"
                    try? modelContext.save()
                }
            }
            return
        case .submitted(let sub):
            let subItemId = sub.ideaID
            let subDesc = FetchDescriptor<SessionIdea>(
                predicate: #Predicate { $0.ideaId == subItemId }
            )
            if let existing = (try? modelContext.fetch(subDesc))?.first {
                existing.status = "done"
                try? modelContext.save()
            }
            return
        case .none:
            return
        }

        let itemId = idea.ideaID
        let descriptor = FetchDescriptor<SessionIdea>(
            predicate: #Predicate { $0.ideaId == itemId }
        )

        let statusStr: String
        switch idea.status {
        case .open: statusStr = "open"
        case .inProgress: statusStr = "in_progress"
        case .done: statusStr = "done"
        default: statusStr = "open"
        }

        if let existing = (try? modelContext.fetch(descriptor))?.first {
            existing.title = idea.title
            existing.ideaDescription = idea.description_p
            existing.status = statusStr
            existing.parentIdeaId = idea.parentID
            existing.archived = idea.archived
            existing.workspaceId = idea.workspaceID
        } else {
            let item = SessionIdea(
                ideaId: idea.ideaID,
                sessionId: idea.sessionID,
                workspaceId: idea.workspaceID,
                title: idea.title,
                ideaDescription: idea.description_p,
                status: statusStr,
                parentIdeaId: idea.parentID,
                createdBy: idea.createdBy,
                createdAt: idea.createdAt > 0
                    ? Date(timeIntervalSince1970: TimeInterval(idea.createdAt))
                    : .now,
                archived: idea.archived
            )
            modelContext.insert(item)
        }
        try? modelContext.save()
    }

    // MARK: - Outbound

    /// Send a text message to a shared session.
    ///
    /// - Parameter modelId: Optional model identifier the user picked in the composer.
    ///   Forwarded via ``Teamclu_Message/model`` and proxied to the agent's session by
    ///   the daemon's collab→agent dispatch path, which calls `send_set_model` before
    ///   `send_prompt` when the model differs from the agent's current model.
    public enum SendMessageError: LocalizedError, Sendable {
        case mqttUnavailable
        case actorNotResolved
        case encodingFailed
        case publishFailed(String)
        case mqttNotConnected(String)
        case persistFailed(String)

        public var errorDescription: String? {
            switch self {
            case .mqttUnavailable:
                return "MQTT client not initialised."
            case .actorNotResolved:
                return "Local member id not resolved yet — sign-in may still be in flight."
            case .encodingFailed:
                return "Failed to serialise message envelope."
            case .publishFailed(let detail):
                return "MQTT publish failed: \(detail)"
            case .mqttNotConnected(let state):
                return "MQTT not connected (state=\(state))."
            case .persistFailed(let detail):
                return "Supabase persist failed: \(detail)"
            }
        }
    }

    /// Publishes a `message.created` LiveEventEnvelope to
    /// `amux/{team}/session/{sid}/live`. Throws on guard failures and
    /// publish errors so the caller can surface them in the UI — silent
    /// drops were the source of the recurring "second message no
    /// response" mystery.
    @discardableResult
    public func sendMessage(
        sessionId: String,
        content: String,
        modelId: String? = nil,
        mentionActorIDs: [String] = [],
        attachmentURLs: [URL] = [],
        persistFirst: Bool = false,
        messageID: String? = nil
    ) async throws -> String {
        let sidPrefix = String(sessionId.prefix(8))
        guard let mqtt else {
            teamcluLogger.warning("sendMessage[\(sidPrefix, privacy: .public)] aborted: mqtt nil")
            throw SendMessageError.mqttUnavailable
        }
        guard let actorId = currentHumanActorId else {
            teamcluLogger.warning("sendMessage[\(sidPrefix, privacy: .public)] refusing: localMemberId not resolved")
            throw SendMessageError.actorNotResolved
        }
        var message = Teamclu_Message()
        // Honor caller-provided id (outbox flow) so retries and the
        // daemon's slice-B dedup land on a stable key. Falls back to a
        // fresh UUID when the caller doesn't care (legacy callers).
        message.messageID = messageID ?? UUID().uuidString
        message.sessionID = sessionId
        message.senderActorID = actorId
        message.kind = .text
        message.content = content
        message.createdAt = Int64(Date().timeIntervalSince1970)
        if let modelId, !modelId.isEmpty {
            message.model = modelId
        }
        if !attachmentURLs.isEmpty {
            message.attachmentUrls = attachmentURLs.map(\.absoluteString)
        }

        var messageEnvelope = Teamclu_SessionMessageEnvelope()
        messageEnvelope.message = message
        // Attach the chip-bar mention set so the daemon can route selectively.
        if !mentionActorIDs.isEmpty {
            messageEnvelope.mentionActorIds = mentionActorIDs
        }

        let body: Data
        do {
            body = try messageEnvelope.serializedData()
        } catch {
            teamcluLogger.error("sendMessage[\(sidPrefix, privacy: .public)] failed to serialize SessionMessageEnvelope")
            throw SendMessageError.encodingFailed
        }

        var live = Teamclu_LiveEventEnvelope()
        live.eventID = UUID().uuidString
        live.eventType = "message.created"
        live.sessionID = sessionId
        live.actorID = actorId
        live.sentAt = Int64(Date().timeIntervalSince1970)
        live.body = body

        let data: Data
        do {
            data = try live.serializedData()
        } catch {
            teamcluLogger.error("sendMessage[\(sidPrefix, privacy: .public)] failed to serialize LiveEventEnvelope")
            throw SendMessageError.encodingFailed
        }

        let connState = mqtt.connectionState
        if connState != .connected {
            teamcluLogger.warning("sendMessage[\(sidPrefix, privacy: .public)] mqtt not connected (state=\(connState.rawValue, privacy: .public))")
            throw SendMessageError.mqttNotConnected(connState.rawValue)
        }

        let topic = MQTTTopics.sessionLive(teamID: teamId, sessionID: sessionId)
        let msgIdPrefix = String(message.messageID.prefix(8))
        let actorPrefix = String(actorId.prefix(8))
        let bytes = data.count
        teamcluLogger.notice("sendMessage[\(sidPrefix, privacy: .public)] msgId=\(msgIdPrefix, privacy: .public) actor=\(actorPrefix, privacy: .public) bytes=\(bytes, privacy: .public) topic=\(topic, privacy: .public) mqtt=\(connState.rawValue, privacy: .public)")

        // Optionally persist BEFORE publish. Used by NewSession path so the
        // daemon's post-spawn catchup is guaranteed to find this message
        // even if iOS's live publish raced ahead of the daemon's
        // session/{sid}/live subscription. Off by default — established
        // sessions already have a subscribed daemon, so the standard
        // publish-first-persist-after pattern keeps perceived latency
        // minimal.
        if persistFirst {
            // persistFirst is the durable path used by the outbox: callers
            // depend on a real success signal so the outbox can mark a row
            // delivered with confidence. Propagate Supabase failure as a
            // throw so the sender retries instead of falsely transitioning
            // to .delivered when auth has expired and the row isn't in the
            // messages table.
            try await persistMessageToSupabaseThrowing(
                messageID: message.messageID,
                teamID: teamId,
                sessionID: sessionId,
                senderActorID: actorId,
                content: content,
                mentionActorIDs: mentionActorIDs,
                sidPrefix: sidPrefix,
                msgIdPrefix: msgIdPrefix
            )
        }

        do {
            try await mqtt.publish(topic: topic, payload: data, retain: false)
        } catch {
            teamcluLogger.error("sendMessage[\(sidPrefix, privacy: .public)] msgId=\(msgIdPrefix, privacy: .public) publish FAILED: \(String(describing: error), privacy: .public)")
            throw SendMessageError.publishFailed(String(describing: error))
        }
        teamcluLogger.notice("sendMessage[\(sidPrefix, privacy: .public)] msgId=\(msgIdPrefix, privacy: .public) publish OK")

        // Standard flow: persist after the MQTT publish has succeeded so
        // perceived latency stays minimal. Fire-and-forget; failures are
        // logged but don't bubble up because the live publish has already
        // reached every currently-subscribed collaborator.
        if !persistFirst {
            Task { [teamId] in
                await persistMessageToSupabase(
                    messageID: message.messageID,
                    teamID: teamId,
                    sessionID: sessionId,
                    senderActorID: actorId,
                    content: content,
                    mentionActorIDs: mentionActorIDs,
                    sidPrefix: sidPrefix,
                    msgIdPrefix: msgIdPrefix
                )
            }
        }

        return message.messageID
    }

    /// Throwing version used by the outbox / persistFirst path. Same
    /// behavior as `persistMessageToSupabase` except errors propagate
    /// instead of being logged-and-swallowed.
    private func persistMessageToSupabaseThrowing(
        messageID: String,
        teamID: String,
        sessionID: String,
        senderActorID: String,
        content: String,
        mentionActorIDs: [String] = [],
        sidPrefix: String,
        msgIdPrefix: String
    ) async throws {
        guard let repo = resolveMessagesRepository() else {
            teamcluLogger.warning("sendMessage[\(sidPrefix, privacy: .public)] msgId=\(msgIdPrefix, privacy: .public) supabase persist skipped: repo init failed")
            throw SendMessageError.persistFailed("repo init failed")
        }
        do {
            // `kind: "text"` is what the messages_kind_check constraint
            // accepts (text/system/idea_event/agent_reply). Rehydration in
            // SessionDetailViewModel.seedFromSupabaseMessages maps "text"
            // to user_prompt, alongside "user_message" / "user_prompt"
            // for legacy rows.
            try await repo.insert(MessageInsertInput(
                id: messageID,
                teamID: teamID,
                sessionID: sessionID,
                senderActorID: senderActorID,
                kind: "text",
                content: content,
                mentionActorIDs: mentionActorIDs
            ))
            teamcluLogger.notice("sendMessage[\(sidPrefix, privacy: .public)] msgId=\(msgIdPrefix, privacy: .public) supabase persist OK")
        } catch {
            if isDuplicateMessageKeyError(error) {
                teamcluLogger.notice("sendMessage[\(sidPrefix, privacy: .public)] msgId=\(msgIdPrefix, privacy: .public) supabase persist duplicate; treating as OK")
                return
            }
            teamcluLogger.error("sendMessage[\(sidPrefix, privacy: .public)] msgId=\(msgIdPrefix, privacy: .public) supabase persist FAILED: \(String(describing: error), privacy: .public)")
            throw SendMessageError.persistFailed(String(describing: error))
        }
    }

    private func persistMessageToSupabase(
        messageID: String,
        teamID: String,
        sessionID: String,
        senderActorID: String,
        content: String,
        mentionActorIDs: [String] = [],
        sidPrefix: String,
        msgIdPrefix: String
    ) async {
        guard let repo = resolveMessagesRepository() else {
            teamcluLogger.warning("sendMessage[\(sidPrefix, privacy: .public)] msgId=\(msgIdPrefix, privacy: .public) supabase persist skipped: repo init failed")
            return
        }
        do {
            // `kind: "text"` is what messages_kind_check accepts
            // (text/system/idea_event/agent_reply). seedFromSupabaseMessages
            // maps "text" → user_prompt and also accepts the legacy
            // "user_message" / "user_prompt" spellings for older rows.
            try await repo.insert(MessageInsertInput(
                id: messageID,
                teamID: teamID,
                sessionID: sessionID,
                senderActorID: senderActorID,
                kind: "text",
                content: content,
                mentionActorIDs: mentionActorIDs
            ))
            teamcluLogger.notice("sendMessage[\(sidPrefix, privacy: .public)] msgId=\(msgIdPrefix, privacy: .public) supabase persist OK")
        } catch {
            if isDuplicateMessageKeyError(error) {
                teamcluLogger.notice("sendMessage[\(sidPrefix, privacy: .public)] msgId=\(msgIdPrefix, privacy: .public) supabase persist duplicate; treating as OK")
                return
            }
            teamcluLogger.warning("sendMessage[\(sidPrefix, privacy: .public)] msgId=\(msgIdPrefix, privacy: .public) supabase persist FAILED: \(String(describing: error), privacy: .public)")
        }
    }

    private func isDuplicateMessageKeyError(_ error: Error) -> Bool {
        let description = String(describing: error)
        return description.contains("23505") && description.contains("messages_pkey")
    }

    private func resolveMessagesRepository() -> (any MessagesRepository)? {
        messagesRepository
    }

    public func makeCreateSessionRequest(
        teamId: String,
        title: String,
        summary: String,
        inviteActorIds: [String] = [],
        ideaId: String = ""
    ) -> Teamclu_CreateSessionRequest {
        var createReq = Teamclu_CreateSessionRequest()
        createReq.teamID = teamId
        createReq.title = title
        createReq.summary = summary
        createReq.inviteActorIds = inviteActorIds
        if !ideaId.isEmpty {
            createReq.ideaID = ideaId
        }
        if let actorId = currentHumanActorId {
            createReq.senderActorID = actorId
        }
        return createReq
    }

    public func createIdea(targetActorID: String, description: String, workspaceId: String = "") async -> Bool {
        guard let rpcClient else { return false }
        guard !targetActorID.isEmpty else { return false }

        let title: String
        if description.count <= 50 {
            title = description
        } else {
            let prefix = description.prefix(50)
            if let lastSpace = prefix.lastIndex(of: " ") {
                title = String(prefix[prefix.startIndex..<lastSpace]) + "…"
            } else {
                title = String(prefix) + "…"
            }
        }

        var createReq = Teamclu_CreateIdeaRequest()
        createReq.sessionID = ""
        createReq.title = title
        createReq.description_p = description
        if !workspaceId.isEmpty {
            createReq.workspaceID = workspaceId
        }
        if let actorId = currentHumanActorId {
            createReq.senderActorID = actorId
        }

        var rpcReq = Teamclu_RpcRequest()
        rpcReq.requestID = String(UUID().uuidString.prefix(8)).lowercased()
        rpcReq.requesterActorID = requesterActorID
        rpcReq.method = .createIdea(createReq)

        let response = await rpcClient.invoke(request: rpcReq, teamID: teamId, targetActorID: targetActorID)
        return response?.success ?? false
    }

    /// Toggles the archived flag on an idea. Sends an `UpdateIdea` RPC
    /// with only `archived` set (other fields left empty / sentinel).
    /// Does not wait for the RPC response — the authoritative state arrives
    /// via the `IdeaEvent.updated` broadcast and flows through
    /// `syncIdeaEvent`. The call site typically flips `archived` on the
    /// SwiftData model first for optimistic UI; if the RPC fails, the next
    /// broadcast will reinstate the prior value.
    public func archiveIdea(targetActorID: String, ideaId: String, sessionId: String, archived: Bool) async {
        guard let mqtt else { return }
        guard !targetActorID.isEmpty else { return }

        var update = Teamclu_UpdateIdeaRequest()
        update.sessionID = sessionId
        update.ideaID = ideaId
        update.archived = archived   // SwiftProtobuf: setting also flips hasArchived=true

        var rpcReq = Teamclu_RpcRequest()
        rpcReq.requestID = String(UUID().uuidString.prefix(8)).lowercased()
        rpcReq.requesterActorID = requesterActorID
        rpcReq.method = .updateIdea(update)

        let topic = MQTTTopics.actorRpcRequest(teamID: teamId, actorID: targetActorID)
        guard let data = try? rpcReq.serializedData() else { return }
        try? await mqtt.publish(topic: topic, payload: data, retain: false)
    }

    /// Updates an idea's status via `UpdateIdea` RPC. Mirrors
    /// `archiveIdea` — fire-and-forget; authoritative state arrives
    /// via `IdeaEvent.updated` broadcast and flows through
    /// `syncIdeaEvent`. The call site typically flips `status` on the
    /// SwiftData model first for optimistic UI; if the RPC fails, the next
    /// broadcast will reinstate the prior value.
    ///
    /// - Parameter status: one of `"open"`, `"in_progress"`, `"done"`.
    ///   Any other value is sent as `.unknown` (which SwiftProtobuf skips,
    ///   producing a no-op update on the daemon side).
    public func updateIdeaStatus(targetActorID: String, ideaId: String, sessionId: String, status: String) async {
        guard let mqtt else { return }
        guard !targetActorID.isEmpty else { return }

        var update = Teamclu_UpdateIdeaRequest()
        update.sessionID = sessionId
        update.ideaID = ideaId
        update.status = protoStatus(from: status)

        var rpcReq = Teamclu_RpcRequest()
        rpcReq.requestID = String(UUID().uuidString.prefix(8)).lowercased()
        rpcReq.requesterActorID = requesterActorID
        rpcReq.method = .updateIdea(update)

        let topic = MQTTTopics.actorRpcRequest(teamID: teamId, actorID: targetActorID)
        guard let data = try? rpcReq.serializedData() else { return }
        try? await mqtt.publish(topic: topic, payload: data, retain: false)
    }

    /// Patches any combination of title, description, and status on an idea.
    /// Title / description are sent as empty strings when `nil` is
    /// passed (SwiftProtobuf treats empty strings as "unset" on the
    /// daemon side). Status omitted when `nil`. Fire-and-forget.
    public func updateIdea(
        targetActorID: String,
        ideaId: String,
        sessionId: String,
        title: String? = nil,
        description: String? = nil,
        status: String? = nil
    ) async {
        guard let mqtt else { return }
        guard !targetActorID.isEmpty else { return }

        var update = Teamclu_UpdateIdeaRequest()
        update.sessionID = sessionId
        update.ideaID = ideaId
        if let title { update.title = title }
        if let description { update.description_p = description }
        if let status { update.status = protoStatus(from: status) }

        var rpcReq = Teamclu_RpcRequest()
        rpcReq.requestID = String(UUID().uuidString.prefix(8)).lowercased()
        rpcReq.requesterActorID = requesterActorID
        rpcReq.method = .updateIdea(update)

        let topic = MQTTTopics.actorRpcRequest(teamID: teamId, actorID: targetActorID)
        guard let data = try? rpcReq.serializedData() else { return }
        try? await mqtt.publish(topic: topic, payload: data, retain: false)
    }

    /// Maps the SwiftData `Idea.status` string domain to the protobuf
    /// `IdeaStatus` enum. Unknown inputs map to `.unknown` — defensive
    /// against future status values landing in the model before this mapper
    /// is updated.
    private func protoStatus(from status: String) -> Teamclu_IdeaStatus {
        switch status {
        case "open": return .open
        case "in_progress": return .inProgress
        case "done": return .done
        default: return .unknown
        }
    }

    public func subscribeToSession(_ sessionId: String) {
        Task {
            try? await beginForegroundSession(sessionId)
        }
    }

    public func beginForegroundSession(_ sessionId: String) async throws {
        guard !sessionId.isEmpty else { return }
        guard let mqtt else { return }
        guard !foregroundSessionIDsSet.contains(sessionId) else { return }

        let topic = MQTTTopics.sessionLive(teamID: teamId, sessionID: sessionId)
        try await mqtt.subscribe(topic)
        foregroundSessionIDsSet.insert(sessionId)
        await fetchRecentMessagesForForegroundSession(sessionId)
    }

    public func endForegroundSession(_ sessionId: String) async throws {
        guard foregroundSessionIDsSet.contains(sessionId) else { return }
        guard let mqtt else { return }

        let topic = MQTTTopics.sessionLive(teamID: teamId, sessionID: sessionId)
        try await mqtt.unsubscribe(topic)
        foregroundSessionIDsSet.remove(sessionId)
    }

    private func refreshSessionState(for sessionId: String, modelContext: ModelContext) async {
        refreshedSessionIDs.append(sessionId)
        await fetchSessionInfo(sessionId: sessionId, modelContext: modelContext)
        if foregroundSessionIDsSet.contains(sessionId) {
            await fetchRecentMessagesForForegroundSession(sessionId)
        }
    }

    private func fetchSessionInfo(sessionId: String, modelContext: ModelContext) async {
        if isTestingForegroundLifecycle {
            fetchSessionInfoCalls.append(sessionId)
            return
        }

        guard let rpcClient else { return }

        let descriptor = FetchDescriptor<Session>(
            predicate: #Predicate { $0.sessionId == sessionId }
        )
        guard let session = (try? modelContext.fetch(descriptor))?.first else {
            return
        }
        let resolvedActorID: String?
        if let cached = resolveActorID(forPrimaryAgentID: session.primaryAgentId) {
            resolvedActorID = cached
        } else {
            resolvedActorID = await rpcTargetActorID(for: session.primaryAgentId)
        }
        guard let targetActorID = resolvedActorID else {
            return
        }

        var req = Teamclu_FetchSessionRequest()
        req.sessionID = sessionId

        var rpcReq = Teamclu_RpcRequest()
        rpcReq.requestID = String(UUID().uuidString.prefix(8)).lowercased()
        rpcReq.requesterActorID = requesterActorID
        rpcReq.method = .fetchSession(req)

        guard let response = await rpcClient.invoke(request: rpcReq, teamID: teamId, targetActorID: targetActorID),
              response.success,
              case .sessionInfo(let info) = response.result else {
            return
        }
        syncSessionMeta(info, modelContext: modelContext)
    }

    public func fetchRecentMessages(sessionId: String, beforeCreatedAt: Int64 = 0, pageSize: UInt32 = 100) async {
        guard let rpcClient,
              let modelContainer else { return }

        let ctx = ModelContext(modelContainer)
        let descriptor = FetchDescriptor<Session>(
            predicate: #Predicate { $0.sessionId == sessionId }
        )
        guard let session = (try? ctx.fetch(descriptor))?.first else { return }
        let resolvedActorID: String?
        if let cached = resolveActorID(forPrimaryAgentID: session.primaryAgentId) {
            resolvedActorID = cached
        } else {
            resolvedActorID = await rpcTargetActorID(for: session.primaryAgentId)
        }
        guard let targetActorID = resolvedActorID else {
            return
        }

        var req = Teamclu_FetchSessionMessagesRequest()
        req.sessionID = sessionId
        req.beforeCreatedAt = beforeCreatedAt
        req.pageSize = pageSize

        var rpcReq = Teamclu_RpcRequest()
        rpcReq.requestID = String(UUID().uuidString.prefix(8)).lowercased()
        rpcReq.requesterActorID = requesterActorID
        rpcReq.method = .fetchSessionMessages(req)

        guard let response = await rpcClient.invoke(request: rpcReq, teamID: teamId, targetActorID: targetActorID),
              response.success,
              case .sessionMessagePage(let page) = response.result else {
            return
        }
        for message in page.messages {
            syncMessage(message, modelContext: ctx)
        }
    }

    /// Fetches a single daemon's current in-memory peer set via FetchPeers
    /// RPC. Phase 2b replacement for the retained devicePeers topic subscription.
    /// Returns empty array on timeout or decode error — the retained topic
    /// semantics degraded the same way, and callers are idempotent.
    public func fetchPeers(targetActorID: String) async -> [Amux_PeerInfo] {
        guard let rpcClient else { return [] }
        guard !targetActorID.isEmpty else { return [] }

        let fetch = Teamclu_FetchPeersRequest()  // empty request

        var rpcReq = Teamclu_RpcRequest()
        rpcReq.requestID = String(UUID().uuidString.prefix(8)).lowercased()
        rpcReq.requesterActorID = requesterActorID
        rpcReq.method = .fetchPeers(fetch)

        guard let response = await rpcClient.invoke(request: rpcReq, teamID: teamId, targetActorID: targetActorID) else {
            return []
        }
        if case let .fetchPeersResult(result)? = response.result {
            return result.peers
        }
        return []
    }

    /// Fetches a single daemon's workspace set via FetchWorkspaces RPC.
    /// Phase 2b replacement for the retained deviceWorkspaces topic subscription.
    public func fetchWorkspaces(targetActorID: String) async -> [Amux_WorkspaceInfo] {
        guard let rpcClient else { return [] }
        guard !targetActorID.isEmpty else { return [] }

        let fetch = Teamclu_FetchWorkspacesRequest()  // empty request

        var rpcReq = Teamclu_RpcRequest()
        rpcReq.requestID = String(UUID().uuidString.prefix(8)).lowercased()
        rpcReq.requesterActorID = requesterActorID
        rpcReq.method = .fetchWorkspaces(fetch)

        guard let response = await rpcClient.invoke(request: rpcReq, teamID: teamId, targetActorID: targetActorID) else {
            return []
        }
        if case let .fetchWorkspacesResult(result)? = response.result {
            return result.workspaces
        }
        return []
    }

    /// Convenience: fans `fetchWorkspaces` across every subscribed daemon and
    /// concatenates the results. Used by SessionListVM startup, which doesn't
    /// know which daemon owns which workspace yet.
    public func fetchWorkspaces() async -> [Amux_WorkspaceInfo] {
        var combined: [Amux_WorkspaceInfo] = []
        for id in subscribedActorIDs.sorted() {
            combined.append(contentsOf: await fetchWorkspaces(targetActorID: id))
        }
        return combined
    }

    // `addWorkspaceRpc` is gone: `add_workspace` is deprecated in the proto —
    // workspaces are created via Cloud API `POST /v1/workspaces`
    // (WorkspaceStore.add) and the daemon resolves UUID→path from the cloud.

    /// Removes a participant from a session on the target daemon. The daemon
    /// only mutates its in-memory cache + sessions.toml + notify fanout —
    /// Supabase is the source of truth and must be updated separately by the
    /// caller. Returns `(success, error)`. 10s timeout.
    ///
    /// The RPC response lands on our own actor's persistently-subscribed
    /// rpc/res topic, so no per-target subscription is needed.
    public func removeParticipantRpc(targetActorID: String,
                                     sessionID: String,
                                     actorID: String) async -> (Bool, String) {
        guard let rpcClient else { return (false, "mqtt not configured") }
        guard !targetActorID.isEmpty else { return (false, "no target actor id") }

        var remove = Teamclu_RemoveParticipantRequest()
        remove.sessionID = sessionID
        remove.actorID = actorID

        var rpcReq = Teamclu_RpcRequest()
        rpcReq.requestID = String(UUID().uuidString.prefix(8)).lowercased()
        rpcReq.requesterActorID = requesterActorID
        rpcReq.method = .removeParticipant(remove)

        // The RPC response arrives on our own actor's rpc/res topic, which is
        // persistently subscribed by `resyncDaemonSubscriptions()`. Ensure that
        // standing subscription exists (no-op after the first time) instead of
        // a per-call subscribe/unsubscribe of the response topic — unsubscribing
        // it would tear down the shared standing sub for every other RPC.
        await ensureOwnRpcResSubscribed()

        guard let response = await rpcClient.invoke(request: rpcReq, teamID: teamId, targetActorID: targetActorID) else {
            return (false, "timeout")
        }
        return (response.success, response.error)
    }

    /// Stops a runtime on the target daemon. Termination shows up on the
    /// retained `{actor}/state` snapshot (the session leaves
    /// `live_sessions`); that's the canonical "it terminated" signal. This
    /// RPC's `(success, error)` is the synchronous accept gate. The response
    /// lands on our own actor's persistently-subscribed rpc/res topic.
    public func runtimeStopRpc(targetActorID: String,
                               runtimeID: String,
                               purgeBinding: Bool = false,
                               workspaceID: String = "") async -> (Bool, String) {
        guard let rpcClient else { return (false, "mqtt not configured") }
        guard !targetActorID.isEmpty else { return (false, "no target actor id") }

        var stop = Teamclu_RuntimeStopRequest()
        stop.runtimeID = runtimeID
        stop.purgeBinding = purgeBinding
        stop.workspaceID = workspaceID

        var rpcReq = Teamclu_RpcRequest()
        rpcReq.requestID = String(UUID().uuidString.prefix(8)).lowercased()
        rpcReq.requesterActorID = requesterActorID
        rpcReq.method = .runtimeStop(stop)

        // Response arrives on our own actor's rpc/res (persistently subscribed);
        // ensure that standing sub without a harmful per-call unsubscribe.
        await ensureOwnRpcResSubscribed()

        guard let response = await rpcClient.invoke(request: rpcReq, teamID: teamId, targetActorID: targetActorID) else {
            return (false, "timeout")
        }
        return (response.success, response.error)
    }

    /// Sets the runtime's ACP session model. The daemon mirrors the choice
    /// into its `current_model_per_agent` map and re-publishes the retained
    /// `{actor}/state` snapshot, so subscribers see the model flip without
    /// a separate roundtrip. `(success, error)` is the synchronous accept gate.
    /// The response lands on our own actor's persistently-subscribed rpc/res topic.
    public func setModelRpc(targetActorID: String,
                            runtimeID: String,
                            modelID: String) async -> (Bool, String) {
        guard let rpcClient else { return (false, "mqtt not configured") }
        guard !targetActorID.isEmpty else { return (false, "no target actor id") }

        var setModel = Teamclu_SetModelRequest()
        setModel.runtimeID = runtimeID
        setModel.modelID = modelID

        var rpcReq = Teamclu_RpcRequest()
        rpcReq.requestID = String(UUID().uuidString.prefix(8)).lowercased()
        rpcReq.requesterActorID = requesterActorID
        rpcReq.method = .setModel(setModel)

        // Response arrives on our own actor's rpc/res (persistently subscribed);
        // ensure that standing sub without a harmful per-call unsubscribe.
        await ensureOwnRpcResSubscribed()

        guard let response = await rpcClient.invoke(request: rpcReq, teamID: teamId, targetActorID: targetActorID) else {
            return (false, "timeout")
        }
        return (response.success, response.error)
    }

    /// Sends an ACP command addressed by `(actor, session)` over the RPC
    /// channel (ADR-0003). Replaces publishing on the retired
    /// `runtime/{rid}/commands` topic, which had no reply path — a command
    /// aimed at a spawn the daemon no longer knew was dropped with only a
    /// log line (docs/debug/interrupt-agent-stale-runtime.md). Riding on
    /// `RpcRequest` means every command gets an `RpcResponse`.
    ///
    /// Returns `(dispatched, error)`. `dispatched == false` with a nil error
    /// is a real answer, not a failure: the daemon holds no attachment for
    /// `sessionID` — the session is cold — and the caller must not report
    /// the command as delivered.
    public func runtimeCommandRpc(
        targetActorID: String,
        sessionID: String,
        address: String,
        command: Amux_AcpCommand
    ) async -> (dispatched: Bool, error: String?) {
        guard let rpcClient else { return (false, "mqtt not configured") }
        guard !targetActorID.isEmpty else { return (false, "no target actor id") }
        guard !sessionID.isEmpty else { return (false, "no session id") }
        // Instant, accurate feedback on a dead socket — without this the
        // command waits out the full RPC timeout and then reports a
        // misleading "timeout" for a request the broker never saw.
        if let mqtt, mqtt.connectionState != .connected {
            return (false, "Not connected — check your network and try again.")
        }

        var envelope = Amux_RuntimeCommandEnvelope()
        // Kept for daemon-side logging only; the daemon resolves the target
        // attachment by (actor, session), never by this value.
        envelope.runtimeID = address
        envelope.actorID = targetActorID
        envelope.peerID = peerId
        envelope.commandID = UUID().uuidString
        envelope.timestamp = Int64(Date().timeIntervalSince1970)
        if let sender = currentHumanActorId, !sender.isEmpty {
            envelope.senderActorID = sender
        }
        envelope.acpCommand = command

        var runtimeCommand = Teamclu_RuntimeCommandRequest()
        runtimeCommand.sessionID = sessionID
        runtimeCommand.envelope = envelope

        var rpcReq = Teamclu_RpcRequest()
        rpcReq.requestID = String(UUID().uuidString.prefix(8)).lowercased()
        rpcReq.requesterActorID = requesterActorID
        rpcReq.method = .runtimeCommand(runtimeCommand)

        // Response arrives on our own actor's rpc/res (persistently subscribed);
        // ensure that standing sub without a harmful per-call unsubscribe.
        await ensureOwnRpcResSubscribed()

        guard let response = await rpcClient.invoke(request: rpcReq, teamID: teamId, targetActorID: targetActorID) else {
            return (false, "timeout")
        }
        guard response.success else {
            return (false, response.error.isEmpty ? "runtime_command rejected" : response.error)
        }
        if case .runtimeCommandResult(let result)? = response.result {
            return (result.dispatched, nil)
        }
        return (false, "no result")
    }

    /// Removes a workspace via daemon RPC. Returns `(success, error)`;
    /// `(false, "timeout")` when no response arrives in time.
    public func removeWorkspaceRpc(targetActorID: String, workspaceId: String) async -> (Bool, String) {
        guard let rpcClient else { return (false, "mqtt not configured") }
        guard !targetActorID.isEmpty else { return (false, "no target actor id") }

        var remove = Teamclu_RemoveWorkspaceRequest()
        remove.workspaceID = workspaceId

        var rpcReq = Teamclu_RpcRequest()
        rpcReq.requestID = String(UUID().uuidString.prefix(8)).lowercased()
        rpcReq.requesterActorID = requesterActorID
        rpcReq.method = .removeWorkspace(remove)

        guard let response = await rpcClient.invoke(request: rpcReq, teamID: teamId, targetActorID: targetActorID) else {
            return (false, "timeout")
        }
        return (response.success, response.error)
    }

    /// Spawns a runtime via daemon RPC. The daemon returns synchronously after
    /// the Claude Code subprocess spawns (not after full ACP-ready) — full
    /// lifecycle progress arrives via the retained `{actor}/state` snapshot
    /// that callers should already be subscribed to via SessionListViewModel.
    ///
    /// Per spec invariant, the new-session UI must not block on full daemon
    /// startup; this RPC is the synchronous accept gate, lifecycle telemetry is
    /// observed asynchronously.
    ///
    /// Returns `.accepted(runtimeID, sessionID)` or `.rejected(reason)`.
    /// Times out at 15s with `.rejected("timeout")`.
    public func runtimeStartRpc(
        targetActorID: String,
        agentType: Amux_AgentType,
        workspaceId: String,
        worktree: String,
        sessionId: String,
        initialPrompt: String,
        resetBackendBinding: Bool = false
    ) async -> RuntimeStartOutcome {
        guard let rpcClient else { return .rejected(reason: "mqtt not configured") }
        guard !targetActorID.isEmpty else { return .rejected(reason: "no target actor id") }

        var start = Teamclu_RuntimeStartRequest()
        start.agentType = agentType
        start.workspaceID = workspaceId
        start.worktree = worktree
        start.sessionID = sessionId
        start.initialPrompt = initialPrompt
        start.resetBackendBinding = resetBackendBinding

        var rpcReq = Teamclu_RpcRequest()
        rpcReq.requestID = String(UUID().uuidString.prefix(8)).lowercased()
        rpcReq.requesterActorID = requesterActorID
        rpcReq.method = .runtimeStart(start)

        // The response arrives on our own actor's rpc/res topic, which is
        // persistently subscribed by `resyncDaemonSubscriptions()`. Ensure that
        // standing subscription is up (no-op after the first call) rather than a
        // per-call subscribe/unsubscribe of the response topic — unsubscribing it
        // would tear down the shared sub used by every other RPC.
        await ensureOwnRpcResSubscribed()

        let requestId = rpcReq.requestID
        print("[runtimeStartRpc] publishing requestID=\(requestId) → actor=\(targetActorID)")
        guard let response = await rpcClient.invoke(request: rpcReq, teamID: teamId, targetActorID: targetActorID, timeout: 15) else {
            print("[runtimeStartRpc] TIMEOUT waiting for response to requestID=\(requestId)")
            return .rejected(reason: "timeout")
        }

        print("[runtimeStartRpc] matched response success=\(response.success) error=\(response.error)")
        if case .runtimeStartResult(let result)? = response.result {
            if result.accepted {
                return .accepted(runtimeID: result.runtimeID, sessionID: result.sessionID)
            } else {
                let reason = result.rejectedReason.isEmpty
                    ? (response.error.isEmpty ? "rejected" : response.error)
                    : result.rejectedReason
                return .rejected(reason: reason, errorCode: result.errorCode)
            }
        }
        return .rejected(reason: response.error.isEmpty ? "no result" : response.error)
    }

    public enum RuntimeStartOutcome: Sendable {
        case accepted(runtimeID: String, sessionID: String)
        case rejected(reason: String, errorCode: String = "")
    }

    private func configureRuntime(
        mqtt: MQTTService,
        hub: MQTTMessageHub,
        teamId: String,
        peerId: String,
        modelContainer: ModelContainer,
        connectedAgentsStore: ConnectedAgentsStore?,
        messagesRepository: (any MessagesRepository)? = nil
    ) {
        self.mqtt = mqtt
        self.hub = hub
        self.rpcClient = TeamcluRPCClient(mqtt: mqtt, hub: hub)
        self.teamId = teamId
        self.peerId = peerId
        self.modelContainer = modelContainer
        self.connectedAgentsStore = connectedAgentsStore
        self.messagesRepository = messagesRepository
    }

    /// Resolves the routing actor id for `primaryAgentId` against the in-memory
    /// `ConnectedAgentsStore`. An agent's routing actor IS its actor id
    /// (== `ConnectedAgent.id`), so this just confirms the agent is known.
    private func resolveActorID(forPrimaryAgentID primaryAgentId: String?) -> String? {
        guard let primaryAgentId, !primaryAgentId.isEmpty,
              let store = connectedAgentsStore,
              let agent = store.agents.first(where: { $0.id == primaryAgentId }) else {
            return nil
        }
        return agent.id
    }

    /// Returns the routing actor id when `topic` matches
    /// `amux/{team}/{actorID}/notify` (4 segments). Nil otherwise.
    private func parseActorNotifyTopic(_ topic: String) -> String? {
        let parts = topic.split(separator: "/")
        guard parts.count == 4,
              parts[0] == "amux",
              parts[3] == "notify" else { return nil }
        let normalizedTeam = MQTTTopics.normalizedTeamID(teamId)
        guard parts[1] == Substring(normalizedTeam) else { return nil }
        return String(parts[2])
    }

    private func rpcTargetActorID(for primaryAgentId: String?) async -> String? {
        guard let primaryAgentId, !primaryAgentId.isEmpty else { return nil }
        // An agent's routing actor IS its actor id (== ConnectedAgent.id).
        guard let agent = connectedAgentsStore?.agents
            .first(where: { $0.id == primaryAgentId }),
              !agent.id.isEmpty else { return nil }
        return agent.id
    }

    private func rehydrateForegroundSessionSubscriptions(on mqtt: MQTTService) async {
        for sessionId in foregroundSessionIDsSet.sorted() {
            try? await mqtt.subscribe(MQTTTopics.sessionLive(teamID: teamId, sessionID: sessionId))
        }
    }

    internal func configureRuntimeForTesting(
        mqtt: MQTTService,
        teamId: String,
        peerId: String,
        modelContainer: ModelContainer,
        connectedAgentsStore: ConnectedAgentsStore? = nil
    ) {
        configureRuntime(
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamId: teamId,
            peerId: peerId,
            modelContainer: modelContainer,
            connectedAgentsStore: connectedAgentsStore
        )
        isTestingForegroundLifecycle = true
    }

    internal func handleIncomingForTesting(_ incoming: MQTTIncoming) async {
        guard let modelContainer else { return }
        await handleIncoming(incoming, modelContext: ModelContext(modelContainer))
    }

    /// Sets `localMemberId` directly for unit tests that need `sendMessage`
    /// to pass its actor-id guard without going through the FetchPeers RPC.
    internal func setLocalMemberIdForTesting(_ memberId: String) {
        localMemberId = memberId
    }

    private func fetchRecentMessagesForForegroundSession(_ sessionId: String) async {
        if isTestingForegroundLifecycle {
            fetchRecentMessagesCalls.append(sessionId)
            return
        }
        await fetchRecentMessages(sessionId: sessionId)
    }

}
