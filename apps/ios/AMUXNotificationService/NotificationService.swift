// apps/ios/AMUXNotificationService/NotificationService.swift
import UIKit
import UserNotifications

/// Rewrites a message push before it is shown (FC sets `mutable-content`):
///
/// - the body becomes readable text — FC sends the raw message, with
///   Markdown marks and `[Mentioned agents: …]` scaffolding in it;
/// - the sender gets a face: their avatar when they have one, otherwise a
///   lettered circle (agents sage, people slate), so a glance at the lock
///   screen says who wrote without reading the title.
///
/// Kept to Foundation + UIKit: an extension has a small memory ceiling, so
/// the two text helpers it needs are compiled in directly rather than
/// linking AMUXCore.
///
/// `@unchecked Sendable`: the system calls `didReceive` and
/// `serviceExtensionTimeWillExpire` on different threads; the lock makes
/// sure exactly one of them delivers.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    private let lock = NSLock()
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        bestAttempt = content
        let info = content.userInfo

        let raw = (info["preview"] as? String) ?? content.body
        let body = NotificationPreview.plain(raw, limit: 240)
        if !body.isEmpty { content.body = body }

        let name = content.title
        let isAgent = (info["sender_kind"] as? String) == "agent"
        let avatarURL = (info["sender_avatar_url"] as? String).flatMap(URL.init(string:))

        Task { [self] in
            let attachment = await Self.avatarAttachment(url: avatarURL, name: name, isAgent: isAgent)
            deliver(adding: attachment)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        deliver(adding: nil)
    }

    private func deliver(adding attachment: UNNotificationAttachment?) {
        lock.lock()
        let handler = contentHandler
        let content = bestAttempt
        contentHandler = nil
        lock.unlock()
        guard let handler, let content else { return }
        if let attachment { content.attachments = [attachment] }
        handler(content)
    }

    // MARK: - Avatar

    private static func avatarAttachment(url: URL?, name: String, isAgent: Bool) async -> UNNotificationAttachment? {
        var data: Data?
        if let url {
            var request = URLRequest(url: url)
            request.timeoutInterval = 5
            if let (bytes, response) = try? await URLSession.shared.data(for: request),
               (response as? HTTPURLResponse)?.statusCode == 200,
               UIImage(data: bytes) != nil {
                data = bytes
            }
        }
        if data == nil { data = lettered(name: name, isAgent: isAgent) }
        guard let data else { return nil }
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("png")
        do {
            try data.write(to: file)
            return try UNNotificationAttachment(identifier: "avatar", url: file, options: nil)
        } catch {
            return nil
        }
    }

    /// A circle with the name's first letter, in the app's palette.
    private static func lettered(name: String, isAgent: Bool) -> Data? {
        let letter = name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?"
        let size = CGSize(width: 120, height: 120)
        let fill = isAgent
            ? UIColor(red: 0x6B / 255, green: 0x8E / 255, blue: 0x5A / 255, alpha: 1)   // sage
            : UIColor(red: 0x5E / 255, green: 0x5B / 255, blue: 0x55 / 255, alpha: 1)   // basalt
        let image = UIGraphicsImageRenderer(size: size).image { _ in
            fill.setFill()
            UIBezierPath(ovalIn: CGRect(origin: .zero, size: size)).fill()
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 56, weight: .semibold),
                .foregroundColor: UIColor.white,
            ]
            let text = letter as NSString
            let bounds = text.size(withAttributes: attributes)
            text.draw(at: CGPoint(x: (size.width - bounds.width) / 2, y: (size.height - bounds.height) / 2),
                      withAttributes: attributes)
        }
        return image.pngData()
    }
}
