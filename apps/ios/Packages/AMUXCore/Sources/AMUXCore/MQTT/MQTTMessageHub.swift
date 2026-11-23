import Foundation

/// Actor-isolated fan-out for inbound MQTT messages.
///
/// `MQTTService` exposes a `messages()` AsyncStream API that yields every
/// incoming MQTT packet to every caller. That worked when there were two
/// consumers, but the app now has TeamcluService, SessionListViewModel,
/// SessionDetailViewModel, and a dozen RPC awaiters
/// each calling `messages()` and filtering the same stream of payloads.
/// Each consumer pays an extra decode and continuation copy per message.
///
/// The hub consolidates that fan-out: it is the *only* consumer of
/// `MQTTService.messages()` and provides topic-filtered AsyncStreams to
/// every downstream caller. Callers go from "subscribe to all messages,
/// filter by topic in a `guard`" to "subscribe to a topic; receive only
/// matching messages."
///
/// ## Lifecycle
///
/// - `start()` (idempotent) launches the listener task. Call from the
///   composition root on app launch and after every MQTT reconnect.
/// - `stop()` cancels the listener and finishes every downstream filter
///   stream; consumers see their `for await` loop exit cleanly.
///
/// ## Reconnect semantics
///
/// `MQTTService.messages()` finishes its stream on disconnect. The hub's
/// listener loop exits when that happens, and the hub then waits for the
/// MQTTService to report `.connected` again before attaching a fresh
/// upstream stream. Downstream filter streams stay alive across reconnect
/// gaps — consumers do not need to re-subscribe.
public actor MQTTMessageHub {
    private let mqtt: MQTTService
    private var listenerTask: Task<Void, Never>?
    private var recorder: MQTTTraceRecorder?

    private struct Filter {
        let predicate: @Sendable (MQTTIncoming) -> Bool
        let continuation: AsyncStream<MQTTIncoming>.Continuation
    }
    private var filters: [UUID: Filter] = [:]

    public init(mqtt: MQTTService) {
        self.mqtt = mqtt
    }

    /// Attach an optional trace recorder. When set, every message that
    /// passes through fan-out is also forwarded to the recorder for
    /// JSONL capture. nil disables capture; default state.
    public func attachRecorder(_ recorder: MQTTTraceRecorder?) {
        self.recorder = recorder
    }

    /// Start (or restart) the upstream listener. Cancels any prior task
    /// and attaches a fresh `MQTTService.messages()` stream.
    public func start() {
        listenerTask?.cancel()
        listenerTask = Task { [weak self] in
            await self?.runListener()
        }
    }

    /// Stop the listener and finish every downstream filter stream.
    public func stop() {
        listenerTask?.cancel()
        listenerTask = nil
        let continuations = filters.values.map(\.continuation)
        filters.removeAll()
        for c in continuations { c.finish() }
    }

    /// Stream of messages matching `predicate`. The returned stream stays
    /// open across MQTT reconnects until either the consuming Task is
    /// cancelled or `stop()` is called.
    public func messages(
        matching predicate: @escaping @Sendable (MQTTIncoming) -> Bool
    ) -> AsyncStream<MQTTIncoming> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<MQTTIncoming>.makeStream()
        filters[id] = Filter(predicate: predicate, continuation: continuation)
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeFilter(id: id) }
        }
        return stream
    }

    /// Stream of messages on a specific topic.
    public func messages(topic: String) -> AsyncStream<MQTTIncoming> {
        messages(matching: { $0.topic == topic })
    }

    /// Stream of messages whose topic starts with `topicPrefix`. Use for
    /// MQTT wildcard subscriptions (`session/+/live`, etc) where the
    /// daemon publishes one topic per child.
    public func messages(topicPrefix: String) -> AsyncStream<MQTTIncoming> {
        messages(matching: { $0.topic.hasPrefix(topicPrefix) })
    }

    /// Stream of every message. Prefer the typed convenience methods —
    /// this exists for the few rare consumers that genuinely need to see
    /// everything (e.g. cross-topic listener loops mid-refactor).
    public func messages() -> AsyncStream<MQTTIncoming> {
        messages(matching: { _ in true })
    }

    private func runListener() async {
        // Wait for MQTT to be connected (up to 15s). Mirrors the pre-Hub
        // pattern in TeamcluService.start where callers spun on
        // `connectionState != .connected` before opening a stream.
        var waited = 0
        while mqtt.connectionState != .connected {
            try? await Task.sleep(for: .milliseconds(200))
            if Task.isCancelled { return }
            waited += 200
            if waited >= 15_000 { return }
        }

        let stream = mqtt.messages()
        for await msg in stream {
            if Task.isCancelled { break }
            fanout(msg)
        }
    }

    private func fanout(_ msg: MQTTIncoming) {
        if let recorder {
            Task { await recorder.record(msg) }
        }
        for filter in filters.values where filter.predicate(msg) {
            filter.continuation.yield(msg)
        }
    }

    private func removeFilter(id: UUID) {
        filters.removeValue(forKey: id)
    }
}
