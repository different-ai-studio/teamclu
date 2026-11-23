import SwiftUI
import AMUXCore
import AMUXSharedUI

#if os(iOS)

/// Row-right avatar stack for the Sessions list. Source-of-truth:
/// `sessions-list.jsx → ParticipantStack` in the AMUX iOS handoff.
///
/// We render up to three 22pt circles with a 6pt left overlap and a
/// 1.5pt Mist ring (the list itself sits on Mist, not white). Solid color
/// fills for humans (you = Cinnabar, others rotate Basalt/Slate/Onyx by
/// stable hash), Pebble bg with an agent-kind glyph for agents.
struct ParticipantPreview: Hashable, Identifiable {
    let actorID: String
    let displayName: String
    let isAgent: Bool
    let isCurrentUser: Bool
    /// Stored backend name (pi; legacy rows may hold old names) or nil.
    let defaultAgentType: String?

    var id: String { actorID }

    var glyph: String {
        if isAgent {
            return Self.initials(from: displayName, fallback: "AG")
        }
        return Self.initials(from: displayName, fallback: "·")
    }

    private static func initials(from name: String, fallback: String) -> String {
        let parts = name
            .split(whereSeparator: { $0.isWhitespace || $0 == "·" || $0 == "-" || $0 == "_" })
            .prefix(2)
        let joined = parts.compactMap { $0.first }.map(String.init).joined().uppercased()
        if !joined.isEmpty { return joined }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty { return String(trimmed.prefix(2)).uppercased() }
        return fallback
    }
}

struct ParticipantCluster: View {
    let participants: [ParticipantPreview]
    /// Spec caps at 3 visible chips. Anything beyond gets dropped silently —
    /// the avatar cluster is a recognition affordance, not a participant
    /// count. Real count lives in `session.participantCount`.
    static let maxVisible = 3

    var body: some View {
        let shown = Array(participants.prefix(Self.maxVisible))
        HStack(spacing: -6) {
            ForEach(shown) { p in
                avatarTile(for: p)
            }
        }
    }

    @ViewBuilder
    private func avatarTile(for p: ParticipantPreview) -> some View {
        let style = avatarStyle(for: p)
        ZStack {
            Circle().fill(style.background)
            Text(p.glyph)
                .font(.system(size: 10, weight: .semibold))
                .tracking(-0.2)
                .foregroundStyle(style.foreground)
        }
        .frame(width: 22, height: 22)
        .overlay(
            Circle().stroke(Color.amux.mist, lineWidth: 1.5)
        )
    }

    private struct Style {
        let background: Color
        let foreground: Color
    }

    private func avatarStyle(for p: ParticipantPreview) -> Style {
        if p.isCurrentUser {
            return Style(background: Color.amux.cinnabar, foreground: .white)
        }
        if p.isAgent {
            return Style(background: Color.amux.pebble, foreground: Color.amux.basalt)
        }
        // Deterministic palette rotation for "other humans" — same hash
        // input we use elsewhere (Members list) so the chip color is
        // stable per actor across screens.
        let palette: [Color] = [Color.amux.basalt, Color.amux.slate, Color.amux.onyx]
        let hash = abs(p.actorID.unicodeScalars.reduce(0) { $0 &+ Int($1.value) })
        return Style(background: palette[hash % palette.count], foreground: .white)
    }
}

#endif
