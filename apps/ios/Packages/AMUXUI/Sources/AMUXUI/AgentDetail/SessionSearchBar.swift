import SwiftUI
import AMUXSharedUI

/// Find-in-conversation bar: a query, "n of m", previous / next, done.
/// Matching and scrolling live in the parent; this only collects intent.
struct SessionSearchBar: View {
    @Binding var query: String
    /// 1-based position of the current match, 0 when there are none.
    let position: Int
    let total: Int
    let onPrevious: () -> Void
    let onNext: () -> Void
    let onDone: () -> Void

    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Color.amux.slate)
                TextField("Search loaded messages", text: $query)
                    .focused($focused)
                    .submitLabel(.search)
                    .onSubmit(onPrevious)
                    .accessibilityIdentifier("sessionSearch.field")
                if !query.isEmpty {
                    Text(total == 0 ? String(localized: "No results") : "\(position)/\(total)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Color.amux.slate)
                        .accessibilityIdentifier("sessionSearch.count")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Color.amux.paper, in: Capsule())

            // Older is up the transcript, newer is down.
            Button(action: onPrevious) { Image(systemName: "chevron.up") }
                .disabled(total == 0)
                .accessibilityLabel("Previous match")
            Button(action: onNext) { Image(systemName: "chevron.down") }
                .disabled(total == 0)
                .accessibilityLabel("Next match")
            Button("Done", action: onDone)
                .accessibilityIdentifier("sessionSearch.done")
        }
        .font(.body)
        .tint(Color.amux.onyx)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.amux.mist.opacity(0.95))
        .onAppear { focused = true }
    }
}
