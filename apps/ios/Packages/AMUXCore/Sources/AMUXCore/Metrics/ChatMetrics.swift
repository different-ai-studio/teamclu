import Foundation
import os

let chatMetricsLogger = Logger(subsystem: "com.teamclu.mobile", category: "ChatMetrics")
let chatSignposter = OSSignposter(logger: chatMetricsLogger)

/// The session-experience metrics of the IM-parity plan (phase 1). Each is a
/// timed interval: an os_signpost interval for Instruments locally, and — once
/// the app installs a sink — one report per finished interval for Sentry.
public enum ChatMetric: String, Sendable, CaseIterable {
    /// M1: session pushed → cached feed on screen → Cloud API history in.
    case openSession = "chat.open_session"
    /// M2: one agent turn as the screen experiences it — main-thread time
    /// spent handling its envelopes, frame hitches, body re-evaluations.
    case turnRender = "chat.turn_render"
    /// M3: send tapped → outbox delivered (persist, then publish).
    case send = "chat.send"
    /// M4: process start → session list showing rows.
    case coldStart = "app.cold_start"
    /// M5: app active again → MQTT confirmed usable.
    case foregroundResume = "app.foreground_resume"
    /// M6: one Cloud API history seed into the timeline.
    case historySeed = "chat.history_seed"
}

public enum ChatMetricOutcome: String, Sendable {
    case ok, failed, cancelled
}

public struct ChatMetricPhase: Sendable, Equatable {
    public let name: String
    public let at: Date
}

/// A finished interval, handed to the sink once.
public struct ChatMetricReport: Sendable {
    public let metric: ChatMetric
    public let start: Date
    public let end: Date
    /// Named points inside the interval, in the order they were marked.
    public let phases: [ChatMetricPhase]
    public let measurements: [String: Double]
    public let tags: [String: String]
    public let outcome: ChatMetricOutcome

    public var durationMs: Double { end.timeIntervalSince(start) * 1000 }

    /// One log line: `chat.send ok 412ms | enqueued=3 attempt_started=980 | attempts=1`.
    /// Phases are ms from the start; key/values sorted so lines diff cleanly.
    public var summary: String {
        var line = "\(metric.rawValue) \(outcome.rawValue) \(Int(durationMs))ms"
        if !phases.isEmpty {
            line += " | " + phases.map { "\($0.name)=\(Int($0.at.timeIntervalSince(start) * 1000))" }.joined(separator: " ")
        }
        if !measurements.isEmpty {
            line += " | " + measurements.sorted { $0.key < $1.key }
                .map { "\($0.key)=\(($0.value * 10).rounded() / 10)" }.joined(separator: " ")
        }
        if !tags.isEmpty {
            line += " | " + tags.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
        }
        return line
    }

    /// Milliseconds from the interval's start to `phase`, if it was marked.
    public func msUntil(_ phase: String) -> Double? {
        phases.first { $0.name == phase }.map { $0.at.timeIntervalSince(start) * 1000 }
    }
}

/// Where finished intervals go beyond os_signpost. The app installs one that
/// forwards to Sentry; AMUXCore itself does not link Sentry.
public protocol ChatMetricsSink: Sendable {
    func record(_ report: ChatMetricReport)
}

/// Keyed interval tracker. Callable from any thread: an interval begun on the
/// main actor (send tapped) is often ended elsewhere (outbox delivered).
///
/// `key` tells concurrent intervals of one metric apart — the session id for
/// M1/M2/M6, the message id for M3, "" for app-wide ones.
public final class ChatMetrics: @unchecked Sendable {
    public static let shared = ChatMetrics()

    private struct Interval {
        let start: Date
        let signpostState: OSSignpostIntervalState
        let signpostID: OSSignpostID
        var phases: [ChatMetricPhase] = []
        var measurements: [String: Double] = [:]
        var tags: [String: String] = [:]
    }

    private struct Key: Hashable {
        let metric: ChatMetric
        let key: String
    }

    /// An interval nobody ends (a send that never delivers, a screen torn
    /// down mid-turn) would otherwise live forever.
    private static let staleAfter: TimeInterval = 10 * 60

    private let lock = NSLock()
    private var open: [Key: Interval] = [:]
    private var sink: (any ChatMetricsSink)?

    public init() {}

    public func setSink(_ sink: (any ChatMetricsSink)?) {
        lock.withLock { self.sink = sink }
    }

    /// Starts an interval. A second `begin` for an interval that is already
    /// open is ignored — so an early, more precise start (a tap) survives a
    /// later fallback one (the view appearing) — unless `restart` is set.
    public func begin(_ metric: ChatMetric, key: String = "", at start: Date = Date(), restart: Bool = false) {
        let k = Key(metric: metric, key: key)
        lock.withLock {
            pruneStale(now: start)
            if let existing = open[k] {
                guard restart else { return }
                Self.endSignpost(metric, existing.signpostState)
            }
            let id = chatSignposter.makeSignpostID()
            let state = Self.beginSignpost(metric, id: id, key: key)
            open[k] = Interval(start: start, signpostState: state, signpostID: id)
        }
    }

    public func isOpen(_ metric: ChatMetric, key: String = "") -> Bool {
        lock.withLock { open[Key(metric: metric, key: key)] != nil }
    }

    /// Records a named point inside an open interval. The first mark of a
    /// name wins, so a phase reached twice keeps its earliest time.
    public func mark(_ metric: ChatMetric, key: String = "", _ phase: String, at: Date = Date()) {
        lock.withLock {
            let k = Key(metric: metric, key: key)
            guard var interval = open[k], !interval.phases.contains(where: { $0.name == phase }) else { return }
            interval.phases.append(ChatMetricPhase(name: phase, at: at))
            open[k] = interval
            chatSignposter.emitEvent("phase", id: interval.signpostID, "\(metric.rawValue, privacy: .public) \(phase, privacy: .public)")
        }
    }

    /// Sets a measurement, replacing any earlier value.
    public func set(_ metric: ChatMetric, key: String = "", _ name: String, _ value: Double) {
        update(metric, key: key) { $0.measurements[name] = value }
    }

    /// Adds to a measurement (counts, summed milliseconds).
    public func add(_ metric: ChatMetric, key: String = "", _ name: String, _ value: Double) {
        update(metric, key: key) { $0.measurements[name, default: 0] += value }
    }

    /// Keeps the largest value seen for a measurement.
    public func max(_ metric: ChatMetric, key: String = "", _ name: String, _ value: Double) {
        update(metric, key: key) { interval in
            interval.measurements[name] = Swift.max(interval.measurements[name] ?? value, value)
        }
    }

    public func tag(_ metric: ChatMetric, key: String = "", _ name: String, _ value: String) {
        update(metric, key: key) { $0.tags[name] = value }
    }

    /// Finishes an open interval and hands it to the sink. No-op when the
    /// interval is not open. Returns the report (handy for tests and logs).
    @discardableResult
    public func end(_ metric: ChatMetric, key: String = "", outcome: ChatMetricOutcome = .ok, at end: Date = Date()) -> ChatMetricReport? {
        let finished: (ChatMetricReport, (any ChatMetricsSink)?)? = lock.withLock {
            guard let interval = open.removeValue(forKey: Key(metric: metric, key: key)) else { return nil }
            Self.endSignpost(metric, interval.signpostState)
            let report = ChatMetricReport(
                metric: metric,
                start: interval.start,
                end: end,
                phases: interval.phases,
                measurements: interval.measurements,
                tags: interval.tags,
                outcome: outcome
            )
            return (report, sink)
        }
        guard let (report, sink) = finished else { return nil }
        chatMetricsLogger.info("\(report.summary, privacy: .public)")
        sink?.record(report)
        return report
    }

    /// A point event with no interval, for Instruments only — e.g. counting
    /// how often a view body runs.
    public static func event(_ name: StaticString) {
        chatSignposter.emitEvent(name)
    }

    /// A bare os_signpost interval, Instruments only — for work too frequent
    /// to report per occurrence (one per image, one per row).
    public static func beginSignpost(_ name: StaticString, _ detail: String = "") -> OSSignpostIntervalState {
        chatSignposter.beginInterval(name, id: chatSignposter.makeSignpostID(), "\(detail, privacy: .public)")
    }

    public static func endSignpost(_ name: StaticString, _ state: OSSignpostIntervalState, _ detail: String = "") {
        chatSignposter.endInterval(name, state, "\(detail, privacy: .public)")
    }

    private func update(_ metric: ChatMetric, key: String, _ change: (inout Interval) -> Void) {
        lock.withLock {
            let k = Key(metric: metric, key: key)
            guard var interval = open[k] else { return }
            change(&interval)
            open[k] = interval
        }
    }

    /// Caller holds `lock`.
    private func pruneStale(now: Date) {
        let stale = open.filter { now.timeIntervalSince($0.value.start) > Self.staleAfter }
        for (k, interval) in stale {
            Self.endSignpost(k.metric, interval.signpostState)
            open.removeValue(forKey: k)
        }
    }

    // os_signpost names must be static strings, hence one arm per metric.
    private static func beginSignpost(_ metric: ChatMetric, id: OSSignpostID, key: String) -> OSSignpostIntervalState {
        switch metric {
        case .openSession: chatSignposter.beginInterval("open_session", id: id, "\(key, privacy: .public)")
        case .turnRender: chatSignposter.beginInterval("turn_render", id: id, "\(key, privacy: .public)")
        case .send: chatSignposter.beginInterval("send", id: id, "\(key, privacy: .public)")
        case .coldStart: chatSignposter.beginInterval("cold_start", id: id)
        case .foregroundResume: chatSignposter.beginInterval("foreground_resume", id: id)
        case .historySeed: chatSignposter.beginInterval("history_seed", id: id, "\(key, privacy: .public)")
        }
    }

    private static func endSignpost(_ metric: ChatMetric, _ state: OSSignpostIntervalState) {
        switch metric {
        case .openSession: chatSignposter.endInterval("open_session", state)
        case .turnRender: chatSignposter.endInterval("turn_render", state)
        case .send: chatSignposter.endInterval("send", state)
        case .coldStart: chatSignposter.endInterval("cold_start", state)
        case .foregroundResume: chatSignposter.endInterval("foreground_resume", state)
        case .historySeed: chatSignposter.endInterval("history_seed", state)
        }
    }
}
