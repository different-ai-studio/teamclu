import Foundation
import Observation
import CocoaMQTT

public enum ConnectionState: String, Sendable {
    case disconnected, connecting, connected, reconnecting
}

public struct MQTTIncoming: Sendable {
    public let topic: String
    public let payload: Data
    public let retained: Bool
}

/// Identifies who holds a topic subscription, so one consumer leaving does not
/// unsubscribe another's feed. See `MQTTService.topicOwners`.
public enum MQTTSubscriptionOwner {
    /// Consumers that own their topics outright and never share them.
    public static let `default` = "default"
    /// The open session detail screen (`TeamcluService` foreground session).
    public static let foregroundSession = "foreground-session"
    /// The session list's live-activity store.
    public static let sessionListActivity = "session-list-activity"
}

@Observable
public final class MQTTService: NSObject, @unchecked Sendable {
    typealias TopicHook = @Sendable (String) async throws -> Void

    public private(set) var connectionState: ConnectionState = .disconnected
    private var mqtt: CocoaMQTT?
    private let subscribeHook: TopicHook?
    private let unsubscribeHook: TopicHook?
    private let publishHook: (@Sendable (String, Data, Bool) async throws -> Void)?
    private let recordTopicOperations: Bool
    internal private(set) var subscribedTopics: [String] = []
    internal private(set) var unsubscribedTopics: [String] = []

    /// Serialises access to `continuations` and `connectContinuation`.
    /// Previously an `NSLock`, which deadlocked the main thread on back-button
    /// dismiss: `disconnect()` held the lock while finishing each continuation,
    /// `finish()` synchronously invoked the per-continuation `onTermination`
    /// closure, which then tried to re-acquire the non-reentrant `NSLock` on
    /// the same thread → hang (see Sentry TEAMCLU-IOS-2). A serial dispatch
    /// queue sidesteps the reentrance problem entirely: even if the closure
    /// is invoked on a thread currently waiting on the queue, the cleanup is
    /// dispatched (`async`) and runs after the current task completes.
    private let stateQueue = DispatchQueue(label: "com.teamclu.mqtt-service.state")
    private var continuations: [UUID: AsyncStream<MQTTIncoming>.Continuation] = [:]
    private var connectContinuation: CheckedContinuation<Void, Error>?
    private var subscribeContinuations: [String: [CheckedContinuation<Void, Error>]] = [:]
    /// Who asked for each topic. `session/{id}/live` now has two independent
    /// owners — the open session detail and the list's activity store — and
    /// without this the first one to leave UNSUBSCRIBEd the other's feed too.
    ///
    /// Owners, not a counter: every consumer re-subscribes after a reconnect
    /// without a matching unsubscribe, so a counter would climb forever and
    /// the topic could never be released.
    private var topicOwners: [String: Set<String>] = [:]

    public override init() {
        subscribeHook = nil
        unsubscribeHook = nil
        publishHook = nil
        recordTopicOperations = false
        super.init()
    }

    internal init(
        subscribeHook: TopicHook? = nil,
        unsubscribeHook: TopicHook? = nil,
        publishHook: (@Sendable (String, Data, Bool) async throws -> Void)? = nil
    ) {
        self.subscribeHook = subscribeHook
        self.unsubscribeHook = unsubscribeHook
        self.publishHook = publishHook
        self.recordTopicOperations = true
        super.init()
        if subscribeHook != nil || unsubscribeHook != nil || publishHook != nil {
            connectionState = .connected
        }
    }

    public func connect(
        host: String, port: Int,
        username: String, password: String,
        clientId: String, useTLS: Bool
    ) async throws {
        connectionState = .connecting

        let mqtt = CocoaMQTT(clientID: clientId, host: host, port: UInt16(port))
        mqtt.username = username
        mqtt.password = password
        mqtt.keepAlive = 90
        mqtt.enableSSL = useTLS
        mqtt.allowUntrustCACertificate = true
        mqtt.delegate = self
        self.mqtt = mqtt

        // Race the CONNACK against a 15 s timeout — without this, a dead
        // socket that never yields a delegate callback would leave the
        // continuation unresumed forever, and the caller-side isConnecting
        // flag with it. Reported symptom: "Not Connected" sticks, tap
        // reconnect does nothing, only kill+relaunch recovers.
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                // Read `self.mqtt` (set above) inside the task rather than
                // capturing the non-Sendable `CocoaMQTT` local — capturing it
                // would make this `sending` closure share a non-Sendable value
                // with the enclosing scope (Swift 6 data-race diagnostic).
                try await self.waitForConnectAck()
            }
            group.addTask {
                try await Task.sleep(for: .seconds(15))
                // Timeout fires: drain the pending continuation so the
                // CONNACK arm (if it ever returns) doesn't try to resume
                // a stale one.
                if let pending = self.takeConnectContinuation() {
                    pending.resume(throwing: MQTTConnectionError.timeout)
                }
                throw MQTTConnectionError.timeout
            }
            try await group.next()
            group.cancelAll()
        }
    }

    private func waitForConnectAck() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            // Publish the continuation to state BEFORE calling connect() so
            // a fast CONNACK on the delegate thread finds it installed.
            stateQueue.sync {
                self.connectContinuation = continuation
            }
            // `self.mqtt` was assigned the freshly-built client in connect()
            // before this task was spawned. If a concurrent disconnect() has
            // since cleared it, fail the connect rather than hang.
            guard let mqtt = self.mqtt else {
                if let pending = takeConnectContinuation() {
                    pending.resume(throwing: MQTTConnectionError.connectFailed)
                }
                return
            }
            let ok = mqtt.connect()
            if !ok {
                if let pending = takeConnectContinuation() {
                    pending.resume(throwing: MQTTConnectionError.connectFailed)
                }
            }
        }
    }

    public func disconnect() async {
        mqtt?.disconnect()
        mqtt = nil
        connectionState = .disconnected
        // Snapshot + drain OUTSIDE the critical section; each `finish()`
        // triggers `onTermination`, which itself dispatches back to the
        // queue — we must not be in the queue when that happens.
        let conts: [AsyncStream<MQTTIncoming>.Continuation] = stateQueue.sync {
            let snapshot = Array(continuations.values)
            continuations.removeAll()
            return snapshot
        }
        for c in conts { c.finish() }
    }

    public func subscribe(_ topic: String, owner: String = MQTTSubscriptionOwner.default) async throws {
        // Claim ownership before the SUBSCRIBE, not after: a failure still
        // leaves the claim, and the next reconnect's re-subscribe repairs it.
        // Dropping the claim on failure would let a sibling owner's
        // unsubscribe silently kill a topic we are about to retry.
        stateQueue.sync { _ = topicOwners[topic, default: []].insert(owner) }

        if let subscribeHook {
            try await subscribeHook(topic)
            if recordTopicOperations {
                subscribedTopics.append(topic)
            }
            return
        }
        guard self.mqtt != nil, connectionState == .connected else {
            throw MQTTConnectionError.notConnected
        }
        // Always re-issue the SUBSCRIBE even when another owner already holds
        // the topic: a reconnect wipes the broker's subscription table, and
        // callers repair theirs by calling this again. SUBSCRIBE is idempotent.
        try await waitForSubscribeAck(topic: topic)
        if recordTopicOperations {
            subscribedTopics.append(topic)
        }
    }

    public func unsubscribe(_ topic: String, owner: String = MQTTSubscriptionOwner.default) async throws {
        guard releaseOwner(owner, of: topic) else { return }

        if let unsubscribeHook {
            try await unsubscribeHook(topic)
            if recordTopicOperations {
                unsubscribedTopics.append(topic)
            }
            return
        }
        guard let mqtt, connectionState == .connected else {
            throw MQTTConnectionError.notConnected
        }
        mqtt.unsubscribe(topic)
        if recordTopicOperations {
            unsubscribedTopics.append(topic)
        }
    }

    /// Drops `owner`'s claim on `topic`. Returns true when nobody is left and
    /// the real UNSUBSCRIBE should go out.
    private func releaseOwner(_ owner: String, of topic: String) -> Bool {
        stateQueue.sync {
            guard var owners = topicOwners[topic] else {
                // Never claimed (or already released by a lifecycle stop) —
                // let the UNSUBSCRIBE through rather than stranding a topic
                // nothing is tracking.
                return true
            }
            owners.remove(owner)
            if owners.isEmpty {
                topicOwners.removeValue(forKey: topic)
                return true
            }
            topicOwners[topic] = owners
            return false
        }
    }

    internal func unsubscribeForLifecycleStop(
        _ topic: String,
        owner: String = MQTTSubscriptionOwner.default
    ) {
        guard releaseOwner(owner, of: topic) else { return }
        if let unsubscribeHook {
            Task {
                try? await unsubscribeHook(topic)
                if self.recordTopicOperations {
                    self.unsubscribedTopics.append(topic)
                }
            }
            return
        }
        guard let mqtt, connectionState == .connected else {
            return
        }
        mqtt.unsubscribe(topic)
        if recordTopicOperations {
            unsubscribedTopics.append(topic)
        }
    }

    public func publish(topic: String, payload: Data, retain: Bool = false) async throws {
        if let publishHook {
            try await publishHook(topic, payload, retain)
            return
        }
        guard let mqtt, connectionState == .connected else {
            throw MQTTConnectionError.notConnected
        }
        let message = CocoaMQTTMessage(topic: topic, payload: [UInt8](payload), qos: .qos1, retained: retain)
        mqtt.publish(message)
    }

    /// Inbound message stream. Internal access: only `MQTTMessageHub`
    /// should call this in production code. Other consumers must route
    /// through the hub so we have a single point of fan-out, dedupe, and
    /// reconnect handling.
    internal func messages() -> AsyncStream<MQTTIncoming> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<MQTTIncoming>.makeStream()
        stateQueue.async {
            self.continuations[id] = continuation
        }
        continuation.onTermination = { [weak self] _ in
            self?.dropContinuation(id: id)
        }
        return stream
    }

    /// Remove a finished `messages()` continuation. Dispatched **async** (never
    /// `sync`) onto `stateQueue` so the cancelling thread — often the main actor
    /// during a view-dismiss Task cancellation — never blocks on the queue (the
    /// reentrancy deadlock guarded against in `stateQueue`'s declaration).
    private func dropContinuation(id: UUID) {
        stateQueue.async { [weak self] in
            self?.continuations.removeValue(forKey: id)
        }
    }

    private func broadcast(_ msg: MQTTIncoming) {
        let conts: [AsyncStream<MQTTIncoming>.Continuation] = stateQueue.sync {
            Array(continuations.values)
        }
        for c in conts {
            c.yield(msg)
        }
    }

    /// Test-only helper: pushes an incoming MQTT message into all active
    /// `messages()` AsyncStream continuations. Use from XCTest with
    /// `@testable import AMUXCore`. Not safe for production code paths.
    internal func deliverForTesting(_ msg: MQTTIncoming) {
        broadcast(msg)
    }

    /// Atomically consumes `connectContinuation` — ensures only the first
    /// caller (whether the CONNACK delegate, the immediate-false return in
    /// `connect()`, or an unexpected mid-handshake `mqttDidDisconnect`) gets
    /// to resume the stored continuation.
    fileprivate func takeConnectContinuation() -> CheckedContinuation<Void, Error>? {
        stateQueue.sync {
            let c = connectContinuation
            connectContinuation = nil
            return c
        }
    }

    private func waitForSubscribeAck(topic: String) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    self.stateQueue.sync {
                        self.subscribeContinuations[topic, default: []].append(continuation)
                    }
                    // Read `self.mqtt` inside the task instead of capturing the
                    // non-Sendable CocoaMQTT param (Swift 6 `sending` closure).
                    // A nil here (concurrent disconnect) simply lets the 5s
                    // timeout arm below fail the subscribe.
                    self.mqtt?.subscribe(topic, qos: .qos1)
                }
            }
            group.addTask {
                try await Task.sleep(for: .seconds(5))
                if let pending = self.takeSubscribeContinuation(for: topic) {
                    pending.resume(throwing: MQTTConnectionError.subscribeTimeout(topic))
                }
                throw MQTTConnectionError.subscribeTimeout(topic)
            }

            // Await whichever arm finishes first (subscribe ack or timeout),
            // then cancel the other.
            _ = try await group.next()
            group.cancelAll()
        }
    }

    fileprivate func takeSubscribeContinuation(for topic: String) -> CheckedContinuation<Void, Error>? {
        stateQueue.sync {
            guard var pending = subscribeContinuations[topic], !pending.isEmpty else {
                return nil
            }
            let continuation = pending.removeFirst()
            if pending.isEmpty {
                subscribeContinuations.removeValue(forKey: topic)
            } else {
                subscribeContinuations[topic] = pending
            }
            return continuation
        }
    }

    fileprivate func takeAllSubscribeContinuations() -> [CheckedContinuation<Void, Error>] {
        stateQueue.sync {
            let pending = subscribeContinuations.values.flatMap { $0 }
            subscribeContinuations.removeAll()
            return pending
        }
    }

    enum MQTTConnectionError: Error, LocalizedError {
        case connectFailed
        case timeout
        case notConnected
        case subscribeTimeout(String)
        var errorDescription: String? {
            switch self {
            case .connectFailed: "MQTT connection initiation failed"
            case .timeout: "MQTT connection timed out"
            case .notConnected: "MQTT is not connected"
            case .subscribeTimeout(let topic): "MQTT subscribe timed out for \(topic)"
            }
        }
    }
}

// MARK: - CocoaMQTTDelegate

extension MQTTService: CocoaMQTTDelegate {
    public func mqtt(_ mqtt: CocoaMQTT, didConnectAck ack: CocoaMQTTConnAck) {
        let pending = takeConnectContinuation()
        if ack == .accept {
            connectionState = .connected
            pending?.resume()
        } else {
            connectionState = .disconnected
            pending?.resume(throwing: MQTTConnectionError.connectFailed)
        }
    }

    public func mqtt(_ mqtt: CocoaMQTT, didPublishMessage message: CocoaMQTTMessage, id: UInt16) {}
    public func mqtt(_ mqtt: CocoaMQTT, didPublishAck id: UInt16) {}

    public func mqtt(_ mqtt: CocoaMQTT, didReceiveMessage message: CocoaMQTTMessage, id: UInt16) {
        let incoming = MQTTIncoming(
            topic: message.topic,
            payload: Data(message.payload),
            retained: message.retained
        )
        broadcast(incoming)
    }

    public func mqtt(_ mqtt: CocoaMQTT, didSubscribeTopics success: NSDictionary, failed: [String]) {
        for key in success.allKeys {
            guard let topic = key as? String,
                  let pending = takeSubscribeContinuation(for: topic) else {
                continue
            }
            pending.resume()
        }
        for topic in failed {
            takeSubscribeContinuation(for: topic)?
                .resume(throwing: MQTTConnectionError.subscribeTimeout(topic))
        }
    }
    public func mqtt(_ mqtt: CocoaMQTT, didUnsubscribeTopics topics: [String]) {}

    public func mqttDidPing(_ mqtt: CocoaMQTT) {}
    public func mqttDidReceivePong(_ mqtt: CocoaMQTT) {}

    public func mqttDidDisconnect(_ mqtt: CocoaMQTT, withError err: (any Error)?) {
        connectionState = .disconnected
        if let pending = takeConnectContinuation() {
            pending.resume(throwing: err ?? MQTTConnectionError.connectFailed)
        }
        let subscribeError = err ?? MQTTConnectionError.connectFailed
        for pending in takeAllSubscribeContinuations() {
            pending.resume(throwing: subscribeError)
        }
    }

    public func mqtt(_ mqtt: CocoaMQTT, didStateChangeTo state: CocoaMQTTConnState) {}
    public func mqtt(_ mqtt: CocoaMQTT, didReceive trust: SecTrust, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(true)
    }
}
