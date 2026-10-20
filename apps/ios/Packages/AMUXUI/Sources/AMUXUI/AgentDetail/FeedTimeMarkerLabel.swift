import SwiftUI
import AMUXCore

/// The centred time label above a feed row (see `feedTimeMarkers`).
struct FeedTimeMarkerLabel: View {
    let marker: FeedTimeMarker

    var body: some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(Color.amux.slate)
            .frame(maxWidth: .infinity)
            .padding(.top, 10)
            .padding(.bottom, 2)
            .accessibilityAddTraits(.isHeader)
    }

    private var text: String {
        switch marker {
        case .day(let date):
            return "\(Self.dayLabel(date)) \(date.formatted(date: .omitted, time: .shortened))"
        case .time(let date):
            return date.formatted(date: .omitted, time: .shortened)
        }
    }

    /// Today / Yesterday / weekday within the last week / month and day this
    /// year / full date — the scale IM apps use, nearest first.
    static func dayLabel(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        if calendar.isDateInToday(date) { return String(localized: "Today") }
        if calendar.isDateInYesterday(date) { return String(localized: "Yesterday") }
        let days = calendar.dateComponents(
            [.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)
        ).day ?? 0
        if days < 7 { return date.formatted(.dateTime.weekday(.wide)) }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            return date.formatted(.dateTime.month(.abbreviated).day())
        }
        return date.formatted(.dateTime.year().month(.abbreviated).day())
    }
}
