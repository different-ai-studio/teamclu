import SwiftUI
import QuickLook
import WebKit
import AMUXCore
import AMUXSharedUI

// MARK: - Where a previewed file comes from

/// The two ways a message can point at a file.
enum AttachmentSource {
    /// Carried by the message, addressed by bucket path and fetched with the
    /// user's bearer through the Cloud API.
    case managed(MessageAttachment)
    /// A bare link in the message body — all the pre-structured path gives
    /// us, and whatever URL a human pasted.
    case link(URL, name: String)

    var displayName: String {
        switch self {
        case .managed(let item): return item.filename
        case .link(_, let name): return name
        }
    }

    /// Something to hand to Share or "open in another app". Nil for a managed
    /// attachment: its address is a private API route needing a bearer, which
    /// is useless outside this app.
    var externalURL: URL? {
        switch self {
        case .managed: return nil
        case .link(let url, _): return url
        }
    }
}

enum AttachmentPreview {
    /// Files WebKit renders and QuickLook doesn't.
    ///
    /// QuickLook either dumps an HTML file as source or refuses it, and an
    /// agent that writes a report writes HTML.
    static let webExtensions: Set<String> = ["html", "htm", "xhtml", "shtml"]

    static func rendersInWebView(name: String, mime: String) -> Bool {
        if mime == "text/html" || mime == "application/xhtml+xml" { return true }
        return webExtensions.contains((name as NSString).pathExtension.lowercased())
    }

    static func rendersInWebView(_ source: AttachmentSource) -> Bool {
        switch source {
        case .managed(let item):
            return rendersInWebView(name: item.filename, mime: item.mime)
        case .link(let url, let name):
            return rendersInWebView(name: name.isEmpty ? url.lastPathComponent : name, mime: "")
        }
    }

    /// Past this, previewing means pulling the whole file onto a phone.
    static let maxDownloadBytes = 50 * 1024 * 1024
}

// MARK: - AttachmentPreviewSheet

/// In-app preview for a message attachment, so tapping a file the agent
/// produced doesn't bounce the reader out to Safari.
///
/// WebKit for HTML, QuickLook for everything else — PDF, images, RTF, CSV,
/// Office documents, audio and video.
///
/// One limitation worth knowing: a managed HTML file renders from bytes, so
/// a stylesheet or image it references by relative path won't load — those
/// subresource requests carry no bearer, and the file has no origin to
/// resolve against. Self-contained HTML renders fine. A bare link keeps the
/// better path: it loads as a URL, so its relative assets do resolve.
struct AttachmentPreviewSheet: View {
    let source: AttachmentSource

    @Environment(\.dismiss) private var dismiss
    @State private var localURL: URL?
    @State private var htmlData: Data?
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(source.displayName)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Done") { dismiss() }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        if let shareURL = localURL ?? source.externalURL {
                            ShareLink(item: shareURL) {
                                Image(systemName: "square.and.arrow.up")
                            }
                        }
                    }
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let failure {
            failureView(message: failure)
        } else if case .link(let url, _) = source, AttachmentPreview.rendersInWebView(source) {
            AttachmentWebView(request: .remote(url))
                .ignoresSafeArea(edges: .bottom)
        } else if let htmlData {
            AttachmentWebView(request: .data(htmlData))
                .ignoresSafeArea(edges: .bottom)
        } else if let localURL {
            QuickLookPreview(url: localURL)
                .ignoresSafeArea(edges: .bottom)
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .task { await prepare() }
        }
    }

    @ViewBuilder
    private func failureView(message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "doc.badge.ellipsis")
                .font(.system(size: 40))
                .foregroundStyle(Color.amux.slate)
            Text(message)
                .font(.callout)
                .foregroundStyle(Color.amux.basalt)
                .multilineTextAlignment(.center)
            if let url = source.externalURL {
                Button("Open in another app") { UIApplication.shared.open(url) }
                    .buttonStyle(.bordered)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func prepare() async {
        switch source {
        case .managed(let item):
            guard item.size <= AttachmentPreview.maxDownloadBytes else {
                failure = String(localized: "This file is too large to preview here.")
                return
            }
            guard let path = item.bucketPath, !path.isEmpty else {
                failure = String(localized: "This attachment has no usable link.")
                return
            }
            do {
                let url = try await AttachmentContentLoader.shared.localURL(
                    bucketPath: path, fileName: item.filename
                )
                if AttachmentPreview.rendersInWebView(source) {
                    htmlData = try Data(contentsOf: url)
                }
                // Set either way: it is also what Share hands out.
                localURL = url
            } catch {
                failure = String(localized: "Couldn't load this attachment.")
            }

        case .link(let url, let name):
            do {
                let (tempURL, response) = try await URLSession.shared.download(from: url)
                if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                    // A 404 body would otherwise be saved and previewed as if
                    // it were the file.
                    failure = String(localized: "Couldn't load this attachment.")
                    return
                }
                // QuickLook picks its renderer from the path extension, and
                // URLSession's temp file has none.
                let directory = FileManager.default.temporaryDirectory
                    .appendingPathComponent("attachment-preview", isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let destination = directory.appendingPathComponent(Self.safeComponent(name))
                if FileManager.default.fileExists(atPath: destination.path) {
                    try FileManager.default.removeItem(at: destination)
                }
                try FileManager.default.moveItem(at: tempURL, to: destination)
                localURL = destination
            } catch {
                failure = String(localized: "Couldn't load this attachment.")
            }
        }
    }

    /// A single path component, whatever the producer called the file. A name
    /// carrying `/` or `..` would otherwise write outside its directory.
    private static func safeComponent(_ raw: String) -> String {
        let cleaned = raw
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
            .replacingOccurrences(of: "..", with: "_")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "attachment" : cleaned
    }
}

// MARK: - FullScreenAttachmentViewer

/// Fullscreen view of one message-carried image.
///
/// Deliberately not `FullScreenSessionImageViewer`: that one pages through
/// the local outbox by URL, and a managed attachment is addressed by bucket
/// path and never appears there.
struct FullScreenAttachmentViewer: View {
    let attachment: MessageAttachment
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            AttachmentImageView(attachment: attachment, maxHeight: .infinity)
                .padding()
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title2)
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, Color.black.opacity(0.5))
            }
            .buttonStyle(.plain)
            .padding(.top, 56)
            .padding(.trailing, 20)
        }
    }
}

// MARK: - QuickLookPreview

struct QuickLookPreview: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        guard context.coordinator.url != url else { return }
        context.coordinator.url = url
        controller.reloadData()
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(_ controller: QLPreviewController,
                               previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }
    }
}

// MARK: - AttachmentWebView

/// Plain web view for a file preview. Deliberately separate from
/// `ShortcutWebView`, which carries the shortcut chrome's navigation
/// bindings and action bus — a preview has no back/forward chrome to drive.
struct AttachmentWebView: UIViewRepresentable {
    enum Request: Equatable {
        case remote(URL)
        case data(Data)
    }

    let request: Request

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        load(into: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard webView.url == nil, !webView.isLoading else { return }
        load(into: webView)
    }

    private func load(into webView: WKWebView) {
        switch request {
        case .remote(let url):
            webView.load(URLRequest(url: url))
        case .data(let data):
            // `about:blank` as the base: these bytes have no origin the web
            // view could resolve subresources against.
            webView.load(data, mimeType: "text/html", characterEncodingName: "utf-8",
                         baseURL: URL(string: "about:blank")!)
        }
    }
}
