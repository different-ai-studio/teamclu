import Foundation

/// A centred time label shown above a feed row, IM style: the day when the
/// conversation crosses midnight, otherwise just the time after a pause.
public enum FeedTimeMarker: Equatable, Sendable {
    /// First row of a calendar day (or of the feed): day and time.
    case day(Date)
    /// Same day as the row before, but after a gap: time only.
    case time(Date)
}

extension FeedItem {
    /// When the row happened, for time markers. A live turn has none — it is
    /// happening now and sits at the bottom.
    public var markerDate: Date? {
        switch self {
        case .userMessage(let e), .permission(let e), .todo(let e), .error(let e):
            return e.timestamp
        case .completedTurn(_, _, let finalEvent, _):
            return finalEvent.timestamp
        case .activeStream:
            return nil
        }
    }
}

/// Feed row id → the marker to draw above it. Rows without an entry get
/// none. A new day always gets a `.day`; within a day a pause longer than
/// `gap` (5 minutes, as in WeChat) gets a `.time`.
public func feedTimeMarkers(
    for items: [FeedItem],
    gap: TimeInterval = 5 * 60,
    calendar: Calendar = .current
) -> [String: FeedTimeMarker] {
    var markers: [String: FeedTimeMarker] = [:]
    var previous: Date?
    for item in items {
        guard let date = item.markerDate else { continue }
        if let previous, calendar.isDate(previous, inSameDayAs: date) {
            if date.timeIntervalSince(previous) > gap {
                markers[item.id] = .time(date)
            }
        } else {
            markers[item.id] = .day(date)
        }
        previous = date
    }
    return markers
}
