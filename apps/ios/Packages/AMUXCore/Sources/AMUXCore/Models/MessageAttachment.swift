import Foundation

/// One file carried by a message, as it is actually stored: an entry of
/// `messages.metadata.attachments`.
///
/// Not the `messages.attachments` column. That column exists, and
/// `AttachmentRef` in `packages/app/src/lib/backend/types.ts` declares a
/// shape for it, but nothing has ever written it: FC doesn't even select it.
/// Every producer puts its files in `metadata` instead — the channel gateway
/// (`insert_gateway_message_with_attachments`) and pi's `session_attach_file`
/// turn-final replies. Three reasons that won out, and they are worth knowing
/// before anyone proposes moving:
///
///  1. `metadata` is already carried end to end; using the column means
///     changing FC and shipping it.
///  2. `Backend::insert_message` already takes `metadata_json`; the column
///     would need a new parameter on the trait and all its implementations.
///  3. `amux.messages` has no UPDATE policy, so a row's column cannot be
///     amended after the fact — the turn trace pointer needed a SECURITY
///     DEFINER function to merge one key of `metadata`. Turn-final
///     attachments have the same "reply first, files after" shape.
///
/// The cost is that `filename`/`mime` here are not the `fileName`/`mimeType`
/// the column's declared type uses. This struct speaks the stored spelling.
public struct MessageAttachment: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let filename: String
    public let mime: String
    /// Size in bytes. 0 when the producer didn't record one.
    public let size: Int
    /// Path inside the attachments bucket, e.g.
    /// `team-id/session-id/attachment-id/name.png`. Fetched through
    /// `GET /v1/attachments/:path` rather than as a public bucket URL —
    /// the bucket has no CORS headers, which is what forced the web client
    /// onto that route, and going through the same one keeps a single
    /// answer to "where does this file come from".
    public let bucketPath: String?

    private enum CodingKeys: String, CodingKey {
        case filename
        case mime
        case size
        case bucketPath = "bucket_path"
    }

    public init(filename: String, mime: String, size: Int, bucketPath: String?) {
        self.filename = filename
        self.mime = mime
        self.size = size
        self.bucketPath = bucketPath
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Every field is written by a producer we don't control, so none of
        // them are required: a row missing `size` must still render its name.
        filename = (try? container.decode(String.self, forKey: .filename)) ?? ""
        mime = (try? container.decode(String.self, forKey: .mime)) ?? ""
        size = (try? container.decode(Int.self, forKey: .size)) ?? 0
        bucketPath = try? container.decodeIfPresent(String.self, forKey: .bucketPath)
    }

    /// Image by declared type, falling back to the extension. Producers that
    /// couldn't determine a type send `application/octet-stream`, and a name
    /// ending in `.png` is better evidence than that.
    public var isImage: Bool {
        if mime.hasPrefix("image/") { return true }
        return Self.imageExtensions.contains(
            (filename as NSString).pathExtension.lowercased()
        )
    }

    static let imageExtensions: Set<String> = [
        "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tiff",
    ]

    /// Stable identity for a list. `bucketPath` is unique per upload; the
    /// name alone is not, and two files of the same name in one message
    /// would otherwise collapse into one row.
    public var identity: String { bucketPath ?? filename }

    /// `Identifiable` for `fullScreenCover(item:)` and `ForEach`.
    public var id: String { identity }
}

public extension Array where Element == MessageAttachment {
    /// JSON for the SwiftData mirror of this list.
    var jsonString: String {
        guard !isEmpty,
              let data = try? JSONEncoder().encode(self),
              let text = String(data: data, encoding: .utf8)
        else { return "[]" }
        return text
    }

    /// Decodes what `jsonString` wrote. Anything unparseable reads as no
    /// attachments rather than failing the row it belongs to.
    static func fromJSONString(_ text: String?) -> [MessageAttachment] {
        guard let text, !text.isEmpty, text != "[]",
              let data = text.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([MessageAttachment].self, from: data)
        else { return [] }
        return decoded
    }
}
