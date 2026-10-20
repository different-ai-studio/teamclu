import XCTest
@testable import AMUXCore

final class ActorPickerOrderingTests: XCTestCase {
    private struct Row { let id: String; let name: String }

    private func order(_ rows: [Row], pinned: String?, contact: [String: Date]) -> [String] {
        ActorPickerOrdering.order(rows, id: \.id, name: \.name,
                                  pinnedID: pinned, lastContact: contact).map(\.id)
    }

    private let rows = [Row(id: "a", name: "Alice"), Row(id: "b", name: "Bob"),
                        Row(id: "c", name: "Carol"), Row(id: "d", name: "Dave")]

    func test_pinnedFirst_thenRecentContact_thenByName() {
        let now = Date()
        let contact = ["b": now.addingTimeInterval(-60), "d": now, "c": now.addingTimeInterval(-3600)]
        XCTAssertEqual(order(rows, pinned: "c", contact: contact), ["c", "d", "b", "a"])
    }

    func test_pinnedWithoutContact_stillFirst() {
        XCTAssertEqual(order(rows, pinned: "d", contact: ["a": Date()]), ["d", "a", "b", "c"])
    }

    func test_noPinNoContact_isAlphabetical() {
        let shuffled = [rows[2], rows[0], rows[3], rows[1]]
        XCTAssertEqual(order(shuffled, pinned: nil, contact: [:]), ["a", "b", "c", "d"])
    }

    func test_lastContact_keepsNewestPerActor() {
        let old = Date(timeIntervalSince1970: 100), new = Date(timeIntervalSince1970: 200)
        let map = ActorPickerOrdering.lastContact(senders: [("a", old), ("a", new), ("b", old)])
        XCTAssertEqual(map["a"], new)
        XCTAssertEqual(map["b"], old)
    }
}
