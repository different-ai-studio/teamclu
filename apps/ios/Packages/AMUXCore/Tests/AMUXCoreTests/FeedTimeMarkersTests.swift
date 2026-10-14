import XCTest
@testable import AMUXCore

final class FeedTimeMarkersTests: XCTestCase {
    private var calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        return c
    }()

    private func at(_ day: Int, _ hour: Int, _ minute: Int) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
    }

    private func message(_ date: Date) -> FeedItem {
        let event = AgentEvent(agentId: "s", sequence: 0, eventType: "user_prompt")
        event.timestamp = date
        return .userMessage(event)
    }

    func testFirstRowAlwaysGetsTheDay() {
        let first = message(at(14, 9, 0))
        XCTAssertEqual(feedTimeMarkers(for: [first], calendar: calendar)[first.id], .day(at(14, 9, 0)))
    }

    func testRowsWithinFiveMinutesShareOneMarker() {
        let a = message(at(14, 9, 0))
        let b = message(at(14, 9, 4))
        let markers = feedTimeMarkers(for: [a, b], calendar: calendar)
        XCTAssertNil(markers[b.id])
    }

    func testAPauseOverFiveMinutesGetsATime() {
        let a = message(at(14, 9, 0))
        let b = message(at(14, 9, 6))
        XCTAssertEqual(feedTimeMarkers(for: [a, b], calendar: calendar)[b.id], .time(at(14, 9, 6)))
    }

    func testCrossingMidnightGetsTheDayEvenAfterAShortGap() {
        let a = message(at(13, 23, 58))
        let b = message(at(14, 0, 1))
        XCTAssertEqual(feedTimeMarkers(for: [a, b], calendar: calendar)[b.id], .day(at(14, 0, 1)))
    }

    func testGapIsMeasuredFromThePreviousRowNotTheLastMarker() {
        // A steady conversation (a row every 4 minutes) never earns a marker.
        let rows = (0..<5).map { message(at(14, 9, $0 * 4)) }
        let markers = feedTimeMarkers(for: rows, calendar: calendar)
        XCTAssertEqual(markers.count, 1, "only the first row's day marker")
    }

    func testLiveTurnsAreSkipped() {
        let a = message(at(14, 9, 0))
        let live = FeedItem.activeStream(id: "live", agentID: "agent", runtimeEvents: [])
        let b = message(at(14, 9, 10))
        let markers = feedTimeMarkers(for: [a, live, b], calendar: calendar)
        XCTAssertNil(markers["live"])
        XCTAssertEqual(markers[b.id], .time(at(14, 9, 10)))
    }
}
