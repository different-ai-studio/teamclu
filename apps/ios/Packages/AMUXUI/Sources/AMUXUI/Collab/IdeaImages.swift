import SwiftUI
import ImageIO
import UniformTypeIdentifiers
import AMUXSharedUI

// Pictures on ideas, end to end: what gets uploaded, what a feed row draws,
// and what a tap opens.
//
// The server has no image transformation. Supabase Storage can do it through
// imgproxy, and the self-host stack even runs that container, but the storage
// service is not configured for it and there is no route to it — asking for
// `/render/image/...` answers 401. Belayo is a separate deployment with its
// own answer. So the sizes have to come from this side.

/// Shrinks a picked photo before it is uploaded.
///
/// A phone photo straight out of the library is around 4MB and twelve
/// megapixels; both funnels used to write those bytes through untouched, which
/// is what made a feed row take seconds to paint. Nothing in this product
/// needs the full sensor — a post is read on a phone and, at most, opened
/// full screen on it.
enum IdeaImagePreparation {
    /// Long edge of what we upload, and the quality it is written at. Both
    /// chosen by measuring the photo that prompted this, a 4032x3024 frame of
    /// 4.1MB:
    ///
    ///     2048px q0.80   1314 KB
    ///     1600px q0.80    841 KB
    ///     1280px q0.80    584 KB
    ///
    /// The widest iPhone screen is about 1206px, so 1600 still has headroom
    /// over a full-screen view — "open the original" is worth doing and a
    /// pinch stays sharp — while costing a fifth of what was being sent.
    static let maxUploadPixel = 1600
    static let uploadQuality = 0.8

    /// Rewrites `url` in place, smaller. Returns false and leaves the file
    /// alone if the image cannot be read — an upload of the original beats
    /// losing the picture.
    @discardableResult
    static func downscaleInPlace(_ url: URL) -> Bool {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let scaled = thumbnail(from: source, maxPixel: maxUploadPixel)
        else { return false }

        let temporary = url.deletingLastPathComponent()
            .appendingPathComponent("scaled-\(UUID().uuidString).jpg")
        guard let destination = CGImageDestinationCreateWithURL(
            temporary as CFURL, UTType.jpeg.identifier as CFString, 1, nil
        ) else { return false }

        CGImageDestinationAddImage(destination, scaled, [
            kCGImageDestinationLossyCompressionQuality: uploadQuality,
        ] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            try? FileManager.default.removeItem(at: temporary)
            return false
        }
        do {
            _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
            return true
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            return false
        }
    }

    /// Decode straight to the size asked for. `CGImageSourceCreateThumbnail…`
    /// never materialises the full bitmap, which is the point: a 2048px JPEG
    /// drawn into a 112pt tile would otherwise cost about 16MB of pixels per
    /// picture, several times over on a scrolling feed.
    static func thumbnail(from source: CGImageSource, maxPixel: Int) -> CGImage? {
        CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ] as CFDictionary)
    }
}

/// Fetches and downsamples, once per (url, size).
///
/// `AsyncImage` decodes at full size and keeps nothing, so scrolling back up a
/// feed re-downloads and re-decodes every picture.
actor IdeaThumbnailLoader {
    static let shared = IdeaThumbnailLoader()

    private let cache = NSCache<NSString, UIImage>()
    private var inFlight: [NSString: Task<UIImage?, Never>] = [:]

    private init() {
        // Roughly a few dozen tiles. They are small once downsampled, and the
        // cost of being wrong is one more decode.
        cache.countLimit = 60
    }

    func image(for url: URL, maxPixel: Int) async -> UIImage? {
        let key = "\(url.absoluteString)|\(maxPixel)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        if let running = inFlight[key] { return await running.value }

        let task = Task<UIImage?, Never> { [maxPixel] in
            // URLSession's own cache covers the bytes, so a second size of the
            // same picture does not fetch it again.
            guard let (data, _) = try? await URLSession.shared.data(from: url),
                  let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let cgImage = IdeaImagePreparation.thumbnail(from: source, maxPixel: maxPixel)
            else { return nil }
            return UIImage(cgImage: cgImage)
        }
        inFlight[key] = task
        let image = await task.value
        inFlight[key] = nil
        if let image { cache.setObject(image, forKey: key) }
        return image
    }
}

/// One picture in a feed row or on a post, at tile size rather than full size.
struct IdeaThumbnail: View {
    let url: URL
    /// Longest edge of the tile in points; the decode asks for that in pixels.
    let maxPointSize: CGFloat

    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else if failed {
                ZStack {
                    Color.amux.pebble
                    Image(systemName: "photo.badge.exclamationmark")
                        .foregroundStyle(Color.amux.slate)
                }
            } else {
                ZStack {
                    Color.amux.pebble
                    ProgressView().controlSize(.small)
                }
            }
        }
        .task(id: url) {
            let pixels = Int(maxPointSize * max(displayScale, 1))
            let loaded = await IdeaThumbnailLoader.shared.image(for: url, maxPixel: pixels)
            image = loaded
            failed = loaded == nil
        }
    }
}

/// Full screen, full size, swipe between the post's pictures, pinch to zoom.
struct IdeaImageViewer: View {
    let urls: [URL]
    @State var index: Int

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            TabView(selection: $index) {
                ForEach(Array(urls.enumerated()), id: \.offset) { offset, url in
                    ZoomableImage(url: url).tag(offset)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: urls.count > 1 ? .automatic : .never))
            .ignoresSafeArea()

            VStack {
                HStack {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(12)
                            .background(.black.opacity(0.35), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Close")
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                Spacer()
            }
        }
        .statusBarHidden()
    }
}

private struct ZoomableImage: View {
    let url: URL

    @State private var zoom: CGFloat = 1
    @State private var committedZoom: CGFloat = 1

    var body: some View {
        // Full size here, unlike the tiles: this is what "see the original"
        // means, and it is one picture rather than a scrolling column of them.
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(zoom)
                    .gesture(
                        MagnifyGesture()
                            .onChanged { value in
                                zoom = min(max(committedZoom * value.magnification, 1), 6)
                            }
                            .onEnded { _ in committedZoom = zoom }
                    )
                    .onTapGesture(count: 2) {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            zoom = zoom > 1 ? 1 : 2.5
                            committedZoom = zoom
                        }
                    }
            case .failure:
                Image(systemName: "photo.badge.exclamationmark")
                    .font(.largeTitle)
                    .foregroundStyle(.white.opacity(0.6))
            case .empty:
                ProgressView().tint(.white)
            @unknown default:
                Color.clear
            }
        }
    }
}
