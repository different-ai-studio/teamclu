import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

/// Replaces the composer while messages are being selected: how many, and
/// what can be done with them.
struct SelectionActionBar: View {
    let count: Int
    /// False when any selected message is not the user's own to delete.
    let canDelete: Bool
    let onCopy: () -> Void
    let onForward: () -> Void
    let onDelete: () -> Void
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Button("Cancel", action: onCancel)
                .accessibilityIdentifier("selection.cancel")
            Spacer()
            Text("\(count) selected")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.amux.onyx)
                .accessibilityIdentifier("selection.count")
            Spacer()
            HStack(spacing: 20) {
                Button(action: onCopy) { Image(systemName: "doc.on.doc") }
                    .accessibilityLabel("Copy")
                    .accessibilityIdentifier("selection.copy")
                Button(action: onForward) { Image(systemName: "arrowshape.turn.up.right") }
                    .accessibilityLabel("Forward")
                    .accessibilityIdentifier("selection.forward")
                Button(role: .destructive, action: onDelete) { Image(systemName: "trash") }
                    .disabled(!canDelete)
                    .accessibilityLabel("Delete")
                    .accessibilityIdentifier("selection.delete")
            }
            .disabled(count == 0)
        }
        .font(.body)
        .tint(Color.amux.cinnabar)
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .liquidGlass(in: RoundedRectangle(cornerRadius: 22), interactive: false)
        .padding(.horizontal, 12)
    }
}

/// The leading check circle a row gets in selection mode.
struct SelectionCheck: View {
    let isSelected: Bool

    var body: some View {
        Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
            .font(.title3)
            .foregroundStyle(isSelected ? Color.amux.cinnabar : Color.amux.slate)
            .padding(.leading, 12)
            .accessibilityLabel(isSelected ? "Selected" : "Not selected")
    }
}

/// Picks the session to forward into: this team's other open sessions,
/// most recently active first.
struct ForwardSessionPicker: View {
    let teamID: String
    let excludingSessionID: String
    let onPick: (Session) -> Void

    @Environment(\.dismiss) private var dismiss
    @Query private var sessions: [Session]
    @State private var query = ""

    init(teamID: String, excludingSessionID: String, onPick: @escaping (Session) -> Void) {
        self.teamID = teamID
        self.excludingSessionID = excludingSessionID
        self.onPick = onPick
        _sessions = Query(filter: #Predicate<Session> { $0.teamId == teamID && !$0.isArchived })
    }

    private var candidates: [Session] {
        sessions
            .filter { $0.sessionId != excludingSessionID }
            .filter { query.isEmpty || $0.title.localizedStandardContains(query) }
            .sorted { $0.listDate > $1.listDate }
    }

    var body: some View {
        NavigationStack {
            List(candidates, id: \.sessionId) { session in
                Button {
                    onPick(session)
                    dismiss()
                } label: {
                    Text(session.title.isEmpty ? String(localized: "Untitled") : session.title)
                        .foregroundStyle(Color.amux.onyx)
                        .lineLimit(1)
                }
            }
            .searchable(text: $query)
            .navigationTitle("Forward to")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
