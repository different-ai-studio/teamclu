import SwiftUI
import AMUXCore
import AMUXSharedUI

#if os(iOS)

/// Inline search field for the Sessions list. Mirrors the iOS UIKit search
/// bar metrics from the handoff (`sessions-list.jsx`) so it reads at the
/// same density as a native search bar without the `.searchable` pull-down
/// gesture.
struct SessionListSearchField: View {
    @Binding var text: String
    /// Owned by the list so it can dismiss the keyboard on scroll / outside tap.
    @FocusState.Binding var isFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(Color.amux.basalt.opacity(0.6))
            TextField("Search sessions", text: $text)
                .focused($isFocused)
                .font(.system(size: 17))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Color.amux.slate)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.amux.basalt.opacity(0.10))
        )
    }
}

#endif
