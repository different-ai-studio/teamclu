import XCTest
@testable import AMUXCore

private final class RecordingSink: ChatMetricsSink, @unchecked Sendable {
    private let lock = NSLock()
    private var reports: [ChatMetricReport] = []
    func record(_ report: ChatMetricReport) { lock.withLock { reports.append(report) } }
    var all: [ChatMetricReport] { lock.withLock { reports } }
}

final class ChatMetricsTests: XCTestCase {
    private var metrics: ChatMetrics!
    private var sink: RecordingSink!

    override func setUp() {
        metrics = ChatMetrics()
        sink = RecordingSink()
        metrics.setSink(sink)
    }

    func testIntervalCarriesPhasesMeasurementsAndTags() throws {
        let t0 = Date(timeIntervalSince1970: 1_000)
        metrics.begin(.openSession, key: "s1", at: t0)
        metrics.mark(.openSession, key: "s1", "cache_ready", at: t0.addingTimeInterval(0.12))
        metrics.mark(.openSession, key: "s1", "first_frame", at: t0.addingTimeInterval(0.2))
        metrics.set(.openSession, key: "s1", "cached_events", 40)
        metrics.tag(.openSession, key: "s1", "source", "push")
        metrics.end(.openSession, key: "s1", at: t0.addingTimeInterval(0.9))

        let report = try XCTUnwrap(sink.all.first)
        XCTAssertEqual(report.metric, .openSession)
        XCTAssertEqual(report.durationMs, 900, accuracy: 0.001)
        XCTAssertEqual(report.phases.map(\.name), ["cache_ready", "first_frame"])
        XCTAssertEqual(try XCTUnwrap(report.msUntil("first_frame")), 200, accuracy: 0.001)
        XCTAssertEqual(report.measurements["cached_events"], 40)
        XCTAssertEqual(report.tags["source"], "push")
        XCTAssertEqual(report.outcome, .ok)
        XCTAssertFalse(metrics.isOpen(.openSession, key: "s1"))
    }

    func testSecondBeginKeepsTheEarlierStartUnlessRestarted() throws {
        let t0 = Date(timeIntervalSince1970: 1_000)
        metrics.begin(.openSession, key: "s1", at: t0)
        metrics.begin(.openSession, key: "s1", at: t0.addingTimeInterval(5))
        let kept = try XCTUnwrap(metrics.end(.openSession, key: "s1", at: t0.addingTimeInterval(6)))
        XCTAssertEqual(kept.start, t0)

        metrics.begin(.openSession, key: "s1", at: t0)
        metrics.begin(.openSession, key: "s1", at: t0.addingTimeInterval(5), restart: true)
        let restarted = try XCTUnwrap(metrics.end(.openSession, key: "s1", at: t0.addingTimeInterval(6)))
        XCTAssertEqual(restarted.start, t0.addingTimeInterval(5))
    }

    func testKeysKeepConcurrentIntervalsApart() {
        metrics.begin(.send, key: "m1")
        metrics.begin(.send, key: "m2")
        metrics.add(.send, key: "m1", "attempts", 1)
        metrics.add(.send, key: "m1", "attempts", 1)
        metrics.end(.send, key: "m2")

        XCTAssertTrue(metrics.isOpen(.send, key: "m1"))
        XCTAssertEqual(sink.all.count, 1)
        XCTAssertNil(sink.all.first?.measurements["attempts"])
        XCTAssertEqual(metrics.end(.send, key: "m1")?.measurements["attempts"], 2)
    }

    func testMaxKeepsTheLargestAndFirstMarkWins() throws {
        let t0 = Date(timeIntervalSince1970: 1_000)
        metrics.begin(.turnRender, key: "s1", at: t0)
        metrics.max(.turnRender, key: "s1", "main_ms_max", 3)
        metrics.max(.turnRender, key: "s1", "main_ms_max", 9)
        metrics.max(.turnRender, key: "s1", "main_ms_max", 4)
        metrics.mark(.turnRender, key: "s1", "first_delta", at: t0.addingTimeInterval(1))
        metrics.mark(.turnRender, key: "s1", "first_delta", at: t0.addingTimeInterval(2))
        let report = try XCTUnwrap(metrics.end(.turnRender, key: "s1"))
        XCTAssertEqual(report.measurements["main_ms_max"], 9)
        XCTAssertEqual(report.phases.count, 1)
        XCTAssertEqual(try XCTUnwrap(report.msUntil("first_delta")), 1000, accuracy: 0.001)
    }

    func testWritesToAnIntervalThatIsNotOpenAreIgnored() {
        metrics.mark(.send, key: "nope", "enqueued")
        metrics.add(.send, key: "nope", "attempts", 1)
        XCTAssertNil(metrics.end(.send, key: "nope"))
        XCTAssertTrue(sink.all.isEmpty)
    }

    func testCancelledAndFailedOutcomesReachTheSink() {
        metrics.begin(.openSession, key: "a")
        metrics.end(.openSession, key: "a", outcome: .cancelled)
        metrics.begin(.send, key: "b")
        metrics.end(.send, key: "b", outcome: .failed)
        XCTAssertEqual(sink.all.map(\.outcome), [.cancelled, .failed])
    }

    func testStaleIntervalsArePrunedOnTheNextBegin() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        metrics.begin(.send, key: "never-delivered", at: t0)
        metrics.begin(.send, key: "fresh", at: t0.addingTimeInterval(11 * 60))
        XCTAssertFalse(metrics.isOpen(.send, key: "never-delivered"))
        XCTAssertTrue(metrics.isOpen(.send, key: "fresh"))
        XCTAssertTrue(sink.all.isEmpty, "a pruned interval is dropped, not reported")
    }
}

extension ChatMetricsTests {
    func testEndWhenMarkedWaitsForEveryRequiredPhaseInAnyOrder() throws {
        metrics.begin(.openSession, key: "s1")
        metrics.mark(.openSession, key: "s1", "seeded")
        XCTAssertNil(metrics.endWhenMarked(.openSession, key: "s1", ["first_frame", "seeded"]))
        XCTAssertTrue(metrics.isOpen(.openSession, key: "s1"))
        metrics.mark(.openSession, key: "s1", "first_frame")
        let report = try XCTUnwrap(metrics.endWhenMarked(.openSession, key: "s1", ["first_frame", "seeded"]))
        XCTAssertEqual(report.phases.map(\.name), ["seeded", "first_frame"])
        XCTAssertFalse(metrics.isOpen(.openSession, key: "s1"))
    }
}
