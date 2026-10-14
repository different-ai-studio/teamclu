import Foundation
import Observation

/// Unsent composer text per session, kept across leaving the screen and app
/// relaunches — what IM apps call a draft. Device-local by design (a draft is
/// half-typed text, not team data), so UserDefaults rather than the Cloud API.
///
/// Observable: the session list reads it to mark rows with a draft.
@MainActor
@Observable
public final class SessionDraftStore {
    public static let shared = SessionDraftStore()

    private static let storageKey = "sessionDrafts.v1"
    @ObservationIgnored private let defaults: UserDefaults

    /// Session id → draft text. Never holds an empty or blank draft.
    public private(set) var drafts: [String: String]

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        drafts = defaults.dictionary(forKey: Self.storageKey) as? [String: String] ?? [:]
    }

    public func draft(for sessionID: String) -> String {
        drafts[sessionID] ?? ""
    }

    /// Stores `text` as the session's draft; blank text clears it, which is
    /// also what sending does (the composer empties itself).
    public func setDraft(_ text: String, for sessionID: String) {
        guard !sessionID.isEmpty else { return }
        let isBlank = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let next: String? = isBlank ? nil : text
        guard drafts[sessionID] != next else { return }
        drafts[sessionID] = next
        persist()
    }

    /// Sign-out and account switches: another account's drafts must not show.
    public func removeAll() {
        guard !drafts.isEmpty else { return }
        drafts = [:]
        persist()
    }

    private func persist() {
        defaults.set(drafts, forKey: Self.storageKey)
    }
}
