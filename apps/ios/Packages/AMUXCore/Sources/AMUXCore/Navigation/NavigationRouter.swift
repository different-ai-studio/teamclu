import Foundation
import Observation

/// App-wide navigation intent bus.
///
/// Push notifications and `teamclu://session/<id>` deep links are received in
/// `AMUXApp` (`ContentView`), but the session `NavigationStack` path is owned by
/// `RootView` in the AMUXUI package. This `@Observable` router bridges the two:
/// the receiver records a *pending* session intent here, and `RootView`
/// observes it and pushes the session onto its
/// path — then clears the intent so the next deep link to the same session fires
/// again.
///
/// It mirrors the existing `AppOnboardingCoordinator` pattern (an `@Observable`
/// `@MainActor` class injected via `.environment(...)`), so call sites stay
/// consistent with the rest of the app.
@MainActor
@Observable
public final class NavigationRouter {
    /// Session id the app wants to navigate to, or `nil` when there is nothing
    /// pending. `RootView` consumes this and resets it to `nil`.
    public var pendingSessionID: String?

    /// Session id → the message a push pointed at, waiting for that session's
    /// screen to scroll to it. One-shot: `takeFocusMessage` removes it.
    @ObservationIgnored private var focusMessageBySession: [String: String] = [:]

    public init() {}

    /// The message to bring into view when `sessionID` opens, if a push
    /// asked for one. Consumed on read, so reopening later starts normally.
    public func takeFocusMessage(for sessionID: String) -> String? {
        focusMessageBySession.removeValue(forKey: sessionID)
    }

    /// Record an intent to open the given session. Setting it to `nil` first
    /// guarantees the observer fires even when the same session id arrives
    /// twice in a row (e.g. two taps on the same notification).
    public func openSession(_ id: String, focusMessageID: String? = nil) {
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if let focusMessageID, !focusMessageID.isEmpty {
            focusMessageBySession[trimmed] = focusMessageID
        }
        pendingSessionID = trimmed
    }
}
