import SwiftUI
import PhotosUI
import UIKit
import AMUXCore

struct AttachmentDrawerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Binding var attachments: [URL]
    let uploadManager: AttachmentUploadManager?
    let sessionID: String
    let teamID: String
    let onUploadStarted: (String, AttachmentUpload) -> Void

    @State private var showFilePicker = false
    @State private var showCamera = false
    @State private var photoItems: [PhotosPickerItem] = []

    var body: some View {
        NavigationStack {
            List {
                Section("Attach") {
                    Button { showFilePicker = true } label: {
                        Label("Files", systemImage: "doc")
                    }
                    Button { showCamera = true } label: {
                        Label("Camera", systemImage: "camera")
                    }
                    PhotosPicker(selection: $photoItems, maxSelectionCount: 5, matching: .images) {
                        Label("Photos", systemImage: "photo.on.rectangle")
                    }
                }

            }
            .navigationTitle("Attachments")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .fileImporter(
                isPresented: $showFilePicker,
                allowedContentTypes: [.item],
                allowsMultipleSelection: true
            ) { result in
                if case .success(let urls) = result {
                    Task {
                        for url in urls where !attachments.contains(url) {
                            attachments.append(url)

                            // Trigger upload if manager available
                            if let uploadManager = uploadManager {
                                do {
                                    let upload = try await uploadManager.startUpload(
                                        filePath: url,
                                        messageID: UUID().uuidString.lowercased(),
                                        sessionID: sessionID,
                                        teamID: teamID
                                    )
                                    onUploadStarted(url.absoluteString, upload)
                                } catch {
                                    print("Upload failed: \(error)")
                                }
                            }
                        }
                        dismiss()
                    }
                }
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraImagePicker(
                    onCapture: { url in
                        Task {
                            attachments.append(url)

                            // Trigger upload if manager available
                            if let uploadManager = uploadManager {
                                do {
                                    let upload = try await uploadManager.startUpload(
                                        filePath: url,
                                        messageID: UUID().uuidString.lowercased(),
                                        sessionID: sessionID,
                                        teamID: teamID
                                    )
                                    onUploadStarted(url.absoluteString, upload)
                                } catch {
                                    print("Upload failed: \(error)")
                                }
                            }
                            showCamera = false
                            dismiss()
                        }
                    },
                    onCancel: { showCamera = false }
                )
                .ignoresSafeArea()
            }
            .onChange(of: photoItems) { _, items in
                guard !items.isEmpty else { return }
                Task {
                    for item in items {
                        if let data = try? await item.loadTransferable(type: Data.self) {
                            // Downscale + re-encode library photos before upload;
                            // originals waste bandwidth and get base64-inlined
                            // into the LLM prompt downstream (issue #710).
                            let compressed = Self.compressedJPEGData(from: data)
                            let url = FileManager.default.temporaryDirectory
                                .appendingPathComponent("photo-\(UUID().uuidString).jpg")
                            try? compressed.write(to: url)
                            await MainActor.run { attachments.append(url) }

                            // Trigger upload
                            if let uploadManager = uploadManager {
                                Task {
                                    do {
                                        let upload = try await uploadManager.startUpload(
                                            filePath: url,
                                            messageID: UUID().uuidString.lowercased(),
                                            sessionID: sessionID,
                                            teamID: teamID
                                        )
                                        onUploadStarted(url.absoluteString, upload)
                                    } catch {
                                        print("Upload failed: \(error)")
                                    }
                                }
                            }
                        }
                    }
                    await MainActor.run {
                        photoItems = []
                        dismiss()
                    }
                }
            }
        }
    }

    private static let maxImageDimension: CGFloat = 2048

    /// Cap the longest edge at `maxImageDimension` and re-encode as JPEG.
    /// Returns the original data when it cannot be decoded or when the
    /// re-encoded result would be larger.
    static func compressedJPEGData(from data: Data) -> Data {
        guard let image = UIImage(data: data) else { return data }
        let pixelWidth = image.size.width * image.scale
        let pixelHeight = image.size.height * image.scale
        let scale = min(1, maxImageDimension / max(pixelWidth, pixelHeight, 1))
        let target = CGSize(width: pixelWidth * scale, height: pixelHeight * scale)

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        guard let jpeg = resized.jpegData(compressionQuality: 0.85),
              jpeg.count < data.count else { return data }
        return jpeg
    }
}
