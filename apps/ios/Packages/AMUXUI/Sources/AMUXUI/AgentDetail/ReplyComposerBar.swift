import SwiftUI
import AMUXCore
import AMUXSharedUI

/// Above the composer while a reply is being written: who is being quoted
/// and the start of what they said, with a way to drop the quote.
struct ReplyComposerBar: View {
    let senderName: String
    let text: String
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Rectangle()
                .fill(Color.amux.cinnabar)
                .frame(width: 3)
                .clipShape(Capsule())
            VStack(alignment: .leading, spacing: 2) {
                Text("Replying to \(senderName)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.amux.cinnabar)
                Text(MentionDisplayText.plainText(text))
                    .font(.caption)
                    .foregroundStyle(Color.amux.basalt)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Button(action: onCancel) {
                Image(systemName: "xmark.circle.fill")
                    .font(.body)
                    .foregroundStyle(Color.amux.slate)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel reply")
            .accessibilityIdentifier("composer.cancelReply")
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 16)
        .accessibilityIdentifier("composer.replyBar")
    }
}
