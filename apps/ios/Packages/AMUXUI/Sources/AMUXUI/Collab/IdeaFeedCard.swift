import SwiftUI
import AMUXCore
import AMUXSharedUI

/// One post in the team feed: who wrote it, when, what it says, its pictures,
/// and what the team has done with it.
///
/// Laid out the way a timeline post is — the avatar sits in a gutter and
/// everything else runs down one column beside it, so the name, the text, the
/// pictures and the actions all share a left edge. Full-width rows on the mist
/// ground separated by hairlines rather than floating cards; a list of posts
/// does not need a box around each one.
///
/// The row is not a `Button`. The heart inside it is, and a button inside a
/// button's label does not receive taps; the rest carries its own tap gesture
/// instead so the two targets stay separate.
struct IdeaFeedCard: View {
    let item: IdeaRecord
    let authorName: String
    let onOpen: () -> Void
    let onToggleLike: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            avatar
            VStack(alignment: .leading, spacing: 8) {
                byline
                if !bodyText.isEmpty {
                    Text(bodyText)
                        .font(.system(size: 15))
                        .foregroundStyle(Color.amux.onyx)
                        .lineSpacing(2)
                        .lineLimit(8)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                        .onTapGesture(perform: onOpen)
                }
                if !item.attachmentURLs.isEmpty {
                    IdeaFeedMedia(urls: item.attachmentURLs)
                        .contentShape(Rectangle())
                        .onTapGesture(perform: onOpen)
                }
                actions
            }
        }
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var avatar: some View {
        Circle()
            .fill(Color.amux.pebble)
            .frame(width: 38, height: 38)
            .overlay(
                Text(authorInitial)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.amux.basalt)
            )
            .contentShape(Circle())
            .onTapGesture(perform: onOpen)
    }

    private var byline: some View {
        HStack(spacing: 6) {
            Text(authorName)
                .font(.system(size: 14.5, weight: .semibold))
                .foregroundStyle(Color.amux.onyx)
                .lineLimit(1)
            Text("·")
                .font(.system(size: 12))
                .foregroundStyle(Color.amux.slate)
            Text(item.createdAt.feedRelative)
                .font(.system(size: 12.5))
                .foregroundStyle(Color.amux.slate)
            Spacer(minLength: 8)
            // Only once it has moved off 'open'. Every post carrying an
            // "Open" tag is a tag that says nothing.
            if !item.isOpen {
                Text(item.statusLabel.uppercased())
                    .font(.system(size: 9.5, weight: .semibold))
                    .tracking(0.18 * 9.5)
                    .foregroundStyle(Color.amux.basalt)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Color.amux.pebble, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
    }

    private var actions: some View {
        HStack(spacing: 28) {
            Button(action: onOpen) {
                actionLabel(icon: "bubble.right", count: item.commentCount, tint: Color.amux.slate)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Comments")

            Button(action: onToggleLike) {
                actionLabel(
                    icon: item.likedByMe ? "heart.fill" : "heart",
                    count: item.likeCount,
                    // The one place coral earns its keep on this row, and only
                    // on the glyph — a coral number beside a coral heart spends
                    // the accent twice for one fact.
                    tint: item.likedByMe ? Color.amux.cinnabar : Color.amux.slate
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(item.likedByMe ? "Unlike" : "Like")
            .accessibilityIdentifier("idea.likeButton.\(item.id)")

            Spacer(minLength: 0)
        }
        .padding(.top, 2)
    }

    private func actionLabel(icon: String, count: Int, tint: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 13.5))
                .foregroundStyle(tint)
            // A zero is not worth printing — the glyph alone already says
            // "nobody yet", and the column reads quieter without a row of 0s.
            if count > 0 {
                Text(count, format: .number)
                    .font(.system(size: 13))
                    .monospacedDigit()
                    .foregroundStyle(Color.amux.slate)
            }
        }
        .contentShape(Rectangle())
    }

    /// The post's words. Title and description are one body here — the board
    /// treated them as a heading and its detail, a post just says something.
    private var bodyText: String {
        let title = item.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let description = item.description.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty { return description }
        if description.isEmpty || description == title { return title }
        return "\(title)\n\(description)"
    }

    private var authorInitial: String {
        guard let first = authorName.first else { return "·" }
        return String(first).uppercased()
    }
}

/// A post's pictures, sized as media rather than as the thumbnail strip a
/// comment's attachments get: one fills the column, several share it.
/// Shared with the post detail so a picture is the same size in both places.
struct IdeaFeedMedia: View {
    let urls: [URL]

    private var shown: [URL] { Array(urls.prefix(4)) }

    var body: some View {
        if shown.count == 1 {
            tile(shown[0], height: 200)
        } else {
            let columns = [GridItem(.flexible(), spacing: 4), GridItem(.flexible(), spacing: 4)]
            LazyVGrid(columns: columns, spacing: 4) {
                ForEach(Array(shown.enumerated()), id: \.element) { index, url in
                    tile(url, height: 112)
                        // An odd last picture takes the whole row rather than
                        // leaving a hole next to it.
                        .gridCellColumns(shown.count % 2 == 1 && index == shown.count - 1 ? 2 : 1)
                }
            }
        }
    }

    private func tile(_ url: URL, height: CGFloat) -> some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image.resizable().scaledToFill()
            case .failure:
                ZStack {
                    Color.amux.pebble
                    Image(systemName: "photo.badge.exclamationmark")
                        .foregroundStyle(Color.amux.slate)
                }
            case .empty:
                ZStack {
                    Color.amux.pebble
                    ProgressView().controlSize(.small)
                }
            @unknown default:
                Color.amux.pebble
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.amux.hairline, lineWidth: 0.5)
        )
    }
}

private extension Date {
    /// Short relative stamp ("2h", "3d"), matching the session rows.
    var feedRelative: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: self, relativeTo: .now)
    }
}
