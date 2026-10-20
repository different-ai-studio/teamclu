import SwiftUI
import ImageIO
import AMUXCore
import AMUXSharedUI

/// Message pictures at bubble size, decoded off the main thread, kept in
/// memory once decoded.
///
/// `UIImage(data:)` only parses the header and leaves the full-size decode
/// for the first draw — on the main thread, mid-scroll: a 12 MP photo is
/// ~48 MB and tens of milliseconds. The bytes themselves are already on
/// disk (`AttachmentContentLoader`); this adds the downsample and the cache.
actor ChatImageLoader {
    static let shared = ChatImageLoader()

    private let cache = NSCache<NSString, UIImage>()
    private var inFlight: [NSString: Task<UIImage?, Never>] = [:]

    private init() {
        // Bubble-sized decodes are a few MB each; enough for a screenful
        // and the one before it.
        cache.countLimit = 40
    }

    func attachment(bucketPath: String, fileName: String, maxPixel: Int) async throws -> UIImage {
        let key = "\(bucketPath)|\(maxPixel)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        if let running = inFlight[key], let image = await running.value { return image }

        let data = try await AttachmentContentLoader.shared.data(bucketPath: bucketPath, fileName: fileName)
        let task = Task<UIImage?, Never> {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let cgImage = IdeaImagePreparation.thumbnail(from: source, maxPixel: maxPixel)
            else { return nil }
            return UIImage(cgImage: cgImage)
        }
        inFlight[key] = task
        let image = await task.value
        inFlight[key] = nil
        guard let image else { throw CocoaError(.fileReadCorruptFile) }
        cache.setObject(image, forKey: key)
        return image
    }
}

/// A picture linked by URL in a message, at bubble size and in its own
/// proportions. Same loader as idea tiles (server-side resize when the
/// picture is in our storage, downsample + cache either way).
struct ChatURLImage: View {
    let url: URL
    /// Longest edge the bubble can show, in points.
    var maxPointSize: CGFloat = 500

    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else {
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.amux.pebble)
                    .overlay(ProgressView())
                    .frame(height: 150)
            }
        }
        .task(id: url) {
            image = await IdeaThumbnailLoader.shared.image(
                for: url, maxPixel: Int(maxPointSize * displayScale)
            )
        }
    }
}
