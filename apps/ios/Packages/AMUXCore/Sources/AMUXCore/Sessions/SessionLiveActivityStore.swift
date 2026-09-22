import Foundation
import Observation
import SwiftData

/// Drives the session list's leading dot: *an agent is working here* / *an
/// agent is waiting on you here*.
///
/// ## Why this doesn't read the actor retain
///
/// `amux/{team}/{actor}/state` is retained and survives a cold start, but the
/// daemon only republishes it when an attachment is created or torn down
/// (`RuntimeManager.mark_actor_state_dirty`). The Active↔Idle flips *inside*
/// an attached session never reach it, so `AgentAttachment.status` cannot
/// answer "is it running right now", and it carries no notion of a pending
/// permission at all. `session/{id}/live` carries both.
///
/// ## What that costs
///
/// `session/live` is published with `retain: false`
/// (`apps/daemon/src/teamclu/live.rs`), so this store only ever knows what
/// arrived while it was subscribed. Two consequences worth keeping in mind
/// when the dot looks wrong:
///
///   - **A running agent is found within a second** of subscribing, because a
///     live turn is a continuous stream of output/tool deltas.
///   - **A turn already blocked on a permission is invisible.** The request
///     went out before we subscribed and nothing repeats it. The dot lights up
///     on the *next* request, or when the user opens the session (the detail
///     view replays turn history over RPC).
///
/// ## Subscription policy
///
/// Subscribing to every session would put every agent's full output stream on
/// the phone for the sake of a 6pt dot, so the set is kept small and hot:
///
///   - `inbox/<user>` ping → that session (FC fan-out after a message INSERT).
///   - This device sending a prompt → that session. The inbox ping excludes
///     the sender's own actor (`list_session_push_targets`), so nothing else
///     would cover a turn the user started here.
///   - Cold start → the most recently active sessions, capped.
///
/// A session is released once it has been quiet for `quietGrace` with no turn
/// open and nothing pending.
@Observable @MainActor
public final class SessionLiveActivityStore {
    /// The observable surface, and deliberately the *narrow* one: only
    /// sessions whose dot is lit appear here, and an entry is written only
    /// when the dot actually changes colour.
    ///
    /// The full reduced state below is `@ObservationIgnored` for exactly this
    /// reason. A streaming turn pushes dozens of deltas a second, and the
    /// session list's body rebuilds a 500-row message query on every
    /// evaluation — publishing each delta would re-render the whole list at
    /// the agent's typing speed.
    public private(set) var litSessions: [String: SessionLiveActivity] = [:]

    /// Reduced state per session id, including the bookkeeping (timestamps,
    /// pending-request ids) that must not drive SwiftUI.
    @ObservationIgnored private var states: [String: SessionActivityState] = [:]
    /// Sessions whose `session/live` topic this store currently holds.
    @ObservationIgnored private var subscribed: Set<String> = []

    @ObservationIgnored private var mqtt: MQTTService?
    @ObservationIgnored private var teamID: String = ""
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var sweepTask: Task<Void, Never>?

    // MARK: Tuning

    /// How long a silent, idle session keeps its subscription. Long enough to
    /// cover the gap between a user's prompt and the agent's first token on a
    /// cold host, short enough that a day of chatter doesn't accumulate
    /// subscriptions.
    @ObservationIgnored private let quietGrace: TimeInterval = 120
    /// A `running` flag with no traffic behind it for this long is a lie —
    /// the attachment died, or we were backgrounded through the turn's end.
    @ObservationIgnored private let runWatchdog: TimeInterval = 90
    /// How often the sweeper re-checks both of the above.
    @ObservationIgnored private let sweepInterval: Duration = .seconds(20)
    /// Sessions seeded at cold start, most-recently-active first.
    @ObservationIgnored private let coldStartLimit = 20
    /// Ceiling on concurrent subscriptions, cold-start seeds included.
    @ObservationIgnored private let maxSubscriptions = 32
    /// Cold start ignores sessions older than this — a week-old session is
    /// not running.
    @ObservationIgnored private let coldStartWindow: TimeInterval = 24 * 60 * 60

    public init() {}

    // MARK: - Reads

    public func activity(for sessionID: String) -> SessionLiveActivity {
        litSessions[sessionID] ?? .quiet
    }

    // MARK: - Lifecycle

    /// Starts the live feed. Safe to call again on team switch — the previous
    /// feed and every subscription it held are dropped first, against the old
    /// team id, before this one is installed.
    public func start(
        mqtt: MQTTService,
        hub: MQTTMessageHub,
        teamID: String,
        modelContext: ModelContext
    ) {
        stop()
        self.mqtt = mqtt
        self.teamID = teamID

        let container = modelContext.container
        streamTask = Task { [weak self] in
            guard let self else { return }
            // One filter for every session-live topic on this team rather than
            // one per session: the broker only delivers what we SUBSCRIBEd, so
            // the predicate is a shape check, and a session added mid-flight
            // needs no new stream. It also means the open session detail's own
            // subscription feeds the dot for free.
            let stream = await hub.messages(matching: { [teamID] msg in
                SessionLiveActivityStore.parseSessionLiveTopic(msg.topic, teamID: teamID) != nil
            })

            await self.seedColdStart(modelContext: ModelContext(container))

            for await msg in stream {
                if Task.isCancelled { return }
                guard let sessionID = Self.parseSessionLiveTopic(msg.topic, teamID: teamID)
                else { continue }
                self.ingest(payload: msg.payload, sessionID: sessionID)
            }
        }

        sweepTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: self?.sweepInterval ?? .seconds(20))
                if Task.isCancelled { return }
                await self?.sweep()
            }
        }
    }

    public func stop() {
        streamTask?.cancel(); streamTask = nil
        sweepTask?.cancel(); sweepTask = nil
        for sessionID in subscribed.sorted() {
            release(sessionID)
        }
        subscribed.removeAll()
        states.removeAll()
        litSessions.removeAll()
    }

    // MARK: - Triggers

    /// "Something happened in this session" — from an `inbox/<user>` ping.
    /// Subscribes if we aren't already, and resets the quiet timer either way.
    public func noteActivity(sessionID: String) {
        apply(.idleChatter, to: sessionID)
    }

    /// This device just sent a prompt into this session: treat the turn as
    /// open immediately rather than waiting for the daemon's first delta, so
    /// the dot is already green when the user swipes back to the list.
    public func noteLocalPrompt(sessionID: String) {
        apply(.turnStarted, to: sessionID)
    }

    // MARK: - Ingest

    private func ingest(payload: Data, sessionID: String) {
        guard let envelope = try? Teamclu_LiveEventEnvelope(serializedBytes: payload),
              let signal = SessionLiveSignalDecoder.signal(from: envelope)
        else { return }
        // `apply` subscribes as a side effect, which is what adopts a session
        // we never asked for: the open session detail holds its own
        // subscription on this same topic, and adopting it is how the dot
        // outlives leaving that screen.
        apply(signal, to: sessionID)
    }

    private func apply(_ signal: SessionLiveSignal, to sessionID: String) {
        guard !sessionID.isEmpty else { return }
        var state = states[sessionID] ?? SessionActivityState()
        state.apply(signal, at: .now)
        states[sessionID] = state
        publishActivity(for: sessionID)
        ensureSubscribed(sessionID)
    }

    /// Mirrors one session's reduced state onto the observable map, writing
    /// only on a real change. Every write here re-renders the session list.
    private func publishActivity(for sessionID: String) {
        let next = states[sessionID]?.activity ?? .quiet
        if next == .quiet {
            // `removeValue` mutates the property even when the key is absent,
            // which @Observable reports as a change — check first.
            if litSessions[sessionID] != nil {
                litSessions.removeValue(forKey: sessionID)
            }
        } else if litSessions[sessionID] != next {
            litSessions[sessionID] = next
        }
    }

    // MARK: - Subscription management

    private func ensureSubscribed(_ sessionID: String) {
        guard let mqtt, !subscribed.contains(sessionID) else { return }
        if subscribed.count >= maxSubscriptions {
            // At the ceiling: drop the coldest tracked session to make room
            // rather than silently ignoring the newest, which is the one the
            // user most likely cares about. Nothing droppable → stay put.
            guard let coldest = coldestReleasableSession() else { return }
            release(coldest)
        }
        subscribed.insert(sessionID)
        // Stamp the quiet timer. Without this a cold-start seed would carry
        // `lastSignalAt == .distantPast` and the first sweep, 20s later, would
        // release every session it just subscribed.
        if states[sessionID] == nil {
            states[sessionID] = SessionActivityState(lastSignalAt: .now)
        }
        let topic = MQTTTopics.sessionLive(teamID: teamID, sessionID: sessionID)
        Task {
            do {
                try await mqtt.subscribe(topic, owner: MQTTSubscriptionOwner.sessionListActivity)
            } catch {
                // Usually: not connected yet. Give the slot back so the next
                // ping retries, instead of believing a subscription we don't
                // have. The sweeper collects the orphaned state.
                self.subscribed.remove(sessionID)
            }
        }
    }

    /// Drops a session's subscription and everything we knew about it.
    /// `.quiet` is the honest answer for a session nobody is listening to.
    private func release(_ sessionID: String) {
        subscribed.remove(sessionID)
        states.removeValue(forKey: sessionID)
        publishActivity(for: sessionID)
        guard let mqtt else { return }
        let topic = MQTTTopics.sessionLive(teamID: teamID, sessionID: sessionID)
        Task {
            try? await mqtt.unsubscribe(topic, owner: MQTTSubscriptionOwner.sessionListActivity)
        }
    }

    private func coldestReleasableSession() -> String? {
        subscribed
            .filter { litSessions[$0] == nil }
            .min(by: {
                (states[$0]?.lastSignalAt ?? .distantPast)
                    < (states[$1]?.lastSignalAt ?? .distantPast)
            })
    }

    /// Expires stuck `running` flags, releases sessions that have gone quiet,
    /// and collects state for sessions we are no longer subscribed to.
    ///
    /// Pending requests pin a session open — a blocked turn is silent by
    /// definition, and dropping it would clear the one dot that matters.
    private func sweep() {
        let now = Date.now
        // Snapshot the keys: every branch below mutates `states`.
        for sessionID in Array(states.keys) {
            guard var state = states[sessionID] else { continue }
            if state.expireStaleRun(now: now, timeout: runWatchdog) {
                states[sessionID] = state
                publishActivity(for: sessionID)
            }
            // A subscribe that failed leaves state behind with no
            // subscription for the loop below to sweep.
            if !subscribed.contains(sessionID) {
                states.removeValue(forKey: sessionID)
                publishActivity(for: sessionID)
            }
        }
        for sessionID in subscribed.sorted() {
            let state = states[sessionID] ?? SessionActivityState()
            guard !state.isHot(now: now, quietGrace: quietGrace) else { continue }
            release(sessionID)
        }
    }

    // MARK: - Cold start

    /// Subscribes the most recently active sessions so a relaunch mid-turn
    /// finds the running agents instead of showing a list of grey dots.
    ///
    /// Only finds *running* turns — see the type doc: a turn already parked on
    /// a permission request emits nothing for us to hear.
    private func seedColdStart(modelContext: ModelContext) async {
        var descriptor = FetchDescriptor<Session>(
            sortBy: [SortDescriptor(\.lastMessageAt, order: .reverse)]
        )
        descriptor.fetchLimit = coldStartLimit * 2
        guard let rows = try? modelContext.fetch(descriptor) else { return }

        let cutoff = Date.now.addingTimeInterval(-coldStartWindow)
        let candidates = rows
            .filter { !$0.isArchived }
            .filter { ($0.lastMessageAt ?? $0.createdAt) > cutoff }
            .prefix(coldStartLimit)

        for session in candidates {
            ensureSubscribed(session.sessionId)
        }
    }

    // MARK: - Topic parsing

    /// Returns the session id when `topic` is `amux/{team}/session/{id}/live`.
    /// `nonisolated` so the hub's `@Sendable` predicate can run it without
    /// hopping to the main actor — it is pure string splitting.
    nonisolated static func parseSessionLiveTopic(_ topic: String, teamID: String) -> String? {
        let parts = topic.split(separator: "/")
        guard parts.count == 5,
              parts[0] == "amux",
              parts[2] == "session",
              parts[4] == "live" else { return nil }
        guard parts[1] == Substring(MQTTTopics.normalizedTeamID(teamID)) else { return nil }
        let sessionID = String(parts[3])
        return sessionID.isEmpty ? nil : sessionID
    }
}
