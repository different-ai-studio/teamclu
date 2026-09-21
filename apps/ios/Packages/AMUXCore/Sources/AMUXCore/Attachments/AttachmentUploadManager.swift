import Foundation
import SwiftData

/// Manages file uploads to the Cloud API attachments store.
/// Handles progress tracking, state transitions, and error recovery.
///
/// Thread safety: This class is marked `@unchecked Sendable` because:
/// - All `@Model` mutations happen on the main thread via `MainActor.run`
/// - Network I/O happens on background threads
/// - `modelContext` is thread-confined to the main thread
public class AttachmentUploadManager: NSObject, @unchecked Sendable {
    private let modelContext: ModelContext
    private let client: CloudAPIClient

    public init(modelContext: ModelContext, client: CloudAPIClient) {
        self.modelContext = modelContext
        self.client = client
    }

    /// Convenience factory used by AMUXUI to build a manager wired to the
    /// Cloud API. The access-token closure reads the current token from the
    /// Keychain-backed session each call (refresh is owned by the onboarding
    /// SessionStore), so uploads carry the user's bearer for storage RLS.
    public static func fromMainBundle(modelContext: ModelContext) throws -> AttachmentUploadManager {
        guard let config = CloudAPIConfigurationStore.configuration() else {
            throw UploadError.uploadFailed("Cloud API is not configured")
        }
        let storage = KeychainSessionStorage()
        let client = CloudAPIClient(configuration: config, accessToken: {
            guard let session = try storage.load(), session.expiresAt.timeIntervalSinceNow > 0 else {
                throw CloudAPIError.missingAccessToken
            }
            return session.accessToken
        })
        return AttachmentUploadManager(modelContext: modelContext, client: client)
    }

    /// Begin uploading a file to Storage.
    /// Returns the AttachmentUpload record created (state=pending initially).
    /// Upload happens in background; caller should observe `uploadState` via SwiftData.
    public func startUpload(
        filePath: URL,
        messageID: String,
        sessionID: String,
        teamID: String
    ) async throws -> AttachmentUpload {
        // Validate file exists and is readable
        let fileData = try Data(contentsOf: filePath)
        let fileSize = fileData.count

        // Validate size ≤ 50MB
        let maxSize: Int64 = 52_428_800
        guard fileSize <= maxSize else {
            throw UploadError.fileTooLarge(size: Int64(fileSize), limit: maxSize)
        }

        // Create record
        let attachmentID = UUID().uuidString.prefix(12).lowercased()
        let fileName = filePath.lastPathComponent
        let upload = AttachmentUpload(
            attachmentID: String(attachmentID),
            messageID: messageID,
            sessionID: sessionID,
            fileName: fileName,
            fileSize: Int64(fileSize)
        )

        // Insert into SwiftData
        modelContext.insert(upload)
        do {
            try modelContext.save()
        } catch {
            print("ERROR: Failed to save AttachmentUpload record: \(error.localizedDescription)")
            throw UploadError.uploadFailed("Failed to create upload record: \(error.localizedDescription)")
        }

        // Start async upload (fire-and-forget with state updates). Capture the
        // Sendable id string, not the `upload` @Model — a PersistentModel isn't
        // Sendable and would make the Task closure non-Sendable.
        let uploadID = upload.attachmentID
        Task {
            await self.performUpload(fileData: fileData, teamID: teamID, uploadID: uploadID)
        }

        return upload
    }

    /// Perform the actual upload, updating state/storageURL/error as it progresses.
    private func performUpload(fileData: Data, teamID: String, uploadID: String) async {
        // Update to uploading state on main thread
        await MainActor.run {
            if let upload = self.fetchUpload(byID: uploadID) {
                upload.uploadState = .uploading
                upload.uploadedBytes = 0
                do {
                    try self.modelContext.save()
                } catch {
                    print("ERROR: Failed to save uploading state: \(error.localizedDescription)")
                }
            }
        }

        do {
            // Fetch upload details for path construction (must happen on the
            // main thread). `AttachmentUpload` is a SwiftData @Model and is
            // main-actor-confined / not Sendable, so extract the Sendable
            // string fields inside the hop instead of returning the model
            // across the actor boundary.
            let pathInfo: (sessionID: String, attachmentID: String, fileName: String)? =
                await MainActor.run {
                    guard let upload = self.fetchUpload(byID: uploadID) else { return nil }
                    return (upload.sessionID, upload.attachmentID, upload.fileName)
                }
            guard let pathInfo else {
                return
            }

            let uploadPath = "\(teamID)/\(pathInfo.sessionID)/\(pathInfo.attachmentID)/\(pathInfo.fileName)"

            // Upload raw bytes to the Cloud API attachments store (off main
            // thread). The bucket is public, so the returned URL renders
            // tokenlessly cross-client (no signed URL needed).
            let encodedPath = uploadPath.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? uploadPath
            let result: AttachmentUploadResult = try await client.postRaw(
                "/v1/attachments?path=\(encodedPath)&bucket=attachments",
                bytes: fileData,
                contentType: attachmentMimeType(for: pathInfo.fileName)
            )

            // Mark complete on main thread
            await MainActor.run {
                if let upload = self.fetchUpload(byID: uploadID) {
                    upload.uploadState = .completed
                    upload.uploadedBytes = upload.fileSize
                    upload.storageURL = result.url
                    do {
                        try self.modelContext.save()
                    } catch {
                        print("ERROR: Failed to save completed state: \(error.localizedDescription)")
                    }
                }
            }

        } catch {
            // Mark failed on main thread with error message
            await MainActor.run {
                if let upload = self.fetchUpload(byID: uploadID) {
                    upload.uploadState = .failed
                    upload.uploadError = error.localizedDescription
                    do {
                        try self.modelContext.save()
                    } catch {
                        print("ERROR: Failed to save failed state: \(error.localizedDescription)")
                    }
                }
            }
        }
    }

    /// Re-fetch an upload record by ID in the current context.
    private func fetchUpload(byID uploadID: String) -> AttachmentUpload? {
        let descriptor = FetchDescriptor<AttachmentUpload>(
            predicate: #Predicate<AttachmentUpload> { $0.attachmentID == uploadID }
        )
        do {
            let uploads = try modelContext.fetch(descriptor)
            return uploads.first
        } catch {
            print("ERROR: Failed to fetch AttachmentUpload: \(error)")
            return nil
        }
    }

    /// Retry a failed upload.
    public func retryUpload(attachmentID: String, filePath: URL, teamID: String) async throws {
        // Re-fetch AttachmentUpload from SwiftData
        let descriptor = FetchDescriptor<AttachmentUpload>(
            predicate: #Predicate<AttachmentUpload> { $0.attachmentID == attachmentID }
        )
        let uploads = try modelContext.fetch(descriptor)
        guard uploads.first != nil else {
            throw UploadError.attachmentNotFound
        }

        let fileData = try Data(contentsOf: filePath)
        await performUpload(fileData: fileData, teamID: teamID, uploadID: attachmentID)
    }
}

private struct AttachmentUploadResult: Decodable, Sendable {
    let path: String
    let url: String
}

public enum UploadError: LocalizedError {
    case fileTooLarge(size: Int64, limit: Int64)
    case attachmentNotFound
    case uploadFailed(String)

    public var errorDescription: String? {
        switch self {
        case .fileTooLarge(let size, let limit):
            return "File size \(size) bytes exceeds limit \(limit) bytes"
        case .attachmentNotFound:
            return "Attachment not found"
        case .uploadFailed(let msg):
            return "Upload failed: \(msg)"
        }
    }
}

public extension AttachmentUploadManager {
    /// The MIME type this uploader sends for a file, exposed so the outbox
    /// can stamp the same value onto the `MessageAttachment` it persists — the
    /// upload record itself doesn't keep one, and two independent guesses
    /// would eventually disagree.
    static func mimeType(forFileName fileName: String) -> String {
        attachmentMimeType(for: fileName)
    }
}

// Helper to determine MIME type. Free function rather than a static on the
// manager: a static named `mimeType` would shadow it inside the type's own
// scope, where `performUpload` calls it.
func attachmentMimeType(for fileName: String) -> String {
    let ext = (fileName as NSString).pathExtension.lowercased()
    switch ext {
    case "jpg", "jpeg": return "image/jpeg"
    case "png": return "image/png"
    case "gif": return "image/gif"
    case "pdf": return "application/pdf"
    case "txt": return "text/plain"
    case "md": return "text/markdown"
    case "json": return "application/json"
    case "swift": return "text/x-swift"
    case "py": return "text/x-python"
    default: return "application/octet-stream"
    }
}
