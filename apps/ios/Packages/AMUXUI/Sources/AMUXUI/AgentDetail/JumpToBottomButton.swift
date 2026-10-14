import SwiftUI
import AMUXSharedUI

/// Floats over the transcript while the reader is scrolled up: one tap back
/// to the newest message, with a count of what arrived meanwhile.
struct JumpToBottomButton: View {
    let unseenCount: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if unseenCount > 0 {
                    Text(unseenCount > 99 ? "99+" : "\(unseenCount)")
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(Color.amux.cinnabar)
                }
                Image(systemName: "chevron.down")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.amux.onyx)
            }
            .padding(.horizontal, unseenCount > 0 ? 12 : 10)
            .frame(minWidth: 38, minHeight: 38)
            .background(Color.amux.paper, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.amux.slate.opacity(0.2)))
            .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("session.jumpToBottom")
        .accessibilityLabel(unseenCount > 0
            ? String(localized: "\(unseenCount) new messages")
            : String(localized: "Jump to latest"))
    }
}
