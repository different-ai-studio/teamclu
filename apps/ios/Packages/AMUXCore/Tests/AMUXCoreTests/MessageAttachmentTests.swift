import XCTest
@testable import AMUXCore

final class MessageAttachmentTests: XCTestCase {

    private let item = MessageAttachment(
        filename: "diagram.png",
        mime: "image/png",
        size: 2048,
        bucketPath: "team-1/sess-1/att-1/diagram.png"
    )

    func test_decodesTheStoredSpelling() throws {
        // snake_case `bucket_path`, and `filename`/`mime` — not the
        // fileName/mimeType the unused column's type declares.
        let json = """
        [{"filename":"diagram.png","mime":"image/png","size":2048,
          "bucket_path":"team-1/sess-1/att-1/diagram.png"}]
        """
        XCTAssertEqual(try JSONDecoder().decode([MessageAttachment].self, from: Data(json.utf8)), [item])
    }

    func test_aPartialRowStillRenders() throws {
        // Producers we don't control write these; a row missing size or
        // bucket_path must not fail the whole message page.
        let json = #"[{"filename":"notes.txt"}]"#
        let decoded = try JSONDecoder().decode([MessageAttachment].self, from: Data(json.utf8))
        XCTAssertEqual(decoded.first?.filename, "notes.txt")
        XCTAssertEqual(decoded.first?.size, 0)
        XCTAssertNil(decoded.first?.bucketPath)
    }

    func test_roundTripsThroughTheStoredJSONString() {
        XCTAssertEqual([MessageAttachment].fromJSONString([item].jsonString), [item])
    }

    func test_unparseableStoredValueReadsAsNoAttachments() {
        XCTAssertEqual([MessageAttachment].fromJSONString("not json"), [])
        XCTAssertEqual([MessageAttachment].fromJSONString(nil), [])
        XCTAssertEqual([MessageAttachment].fromJSONString(""), [])
        XCTAssertEqual([MessageAttachment]().jsonString, "[]")
    }

    func test_imageDetectionFallsBackToTheExtension() {
        let octet = MessageAttachment(filename: "shot.PNG", mime: "application/octet-stream",
                                      size: 1, bucketPath: "t/s/a/shot.PNG")
        XCTAssertTrue(octet.isImage)
        let pdf = MessageAttachment(filename: "report.pdf", mime: "application/pdf",
                                    size: 1, bucketPath: "t/s/a/report.pdf")
        XCTAssertFalse(pdf.isImage)
    }

    func test_identityPrefersBucketPathSoSameNamedFilesStaySeparate() {
        let a = MessageAttachment(filename: "out.txt", mime: "text/plain", size: 1, bucketPath: "t/s/a/out.txt")
        let b = MessageAttachment(filename: "out.txt", mime: "text/plain", size: 1, bucketPath: "t/s/b/out.txt")
        XCTAssertNotEqual(a.identity, b.identity)
    }

    func test_agentEventStoresAndReadsBackAttachments() {
        let event = AgentEvent(agentId: "session-1", sequence: 1, eventType: "output")
        XCTAssertEqual(event.attachments, [], "a fresh row carries none")
        event.attachments = [item]
        XCTAssertEqual(event.attachments, [item])
        // Cleared writes nil rather than "[]" so the column stays empty for
        // the overwhelming majority of rows.
        event.attachments = []
        XCTAssertNil(event.attachmentsJSON)
    }

    func test_bucketPathIsRecoveredFromAPublicStorageURL() {
        // The outbox has no team id, so the upload URL is the only place the
        // stored path survives.
        let url = URL(string: "https://x.supabase.co/storage/v1/object/public/attachments/team-1/sess-1/att-1/a%20b.png")!
        XCTAssertEqual(OutboxSender.bucketPath(fromStorageURL: url), "team-1/sess-1/att-1/a b.png")
        XCTAssertNil(OutboxSender.bucketPath(fromStorageURL: URL(string: "https://x/y/z.png")!))
    }
}
