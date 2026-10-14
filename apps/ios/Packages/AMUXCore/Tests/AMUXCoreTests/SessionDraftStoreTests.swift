import XCTest
@testable import AMUXCore

@MainActor
final class SessionDraftStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "SessionDraftStoreTests"

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    func testDraftSurvivesANewStoreOnTheSameDefaults() {
        SessionDraftStore(defaults: defaults).setDraft("half a thought", for: "s1")
        XCTAssertEqual(SessionDraftStore(defaults: defaults).draft(for: "s1"), "half a thought")
    }

    func testDraftsAreKeptPerSession() {
        let store = SessionDraftStore(defaults: defaults)
        store.setDraft("for one", for: "s1")
        store.setDraft("for two", for: "s2")
        XCTAssertEqual(store.draft(for: "s1"), "for one")
        XCTAssertEqual(store.draft(for: "s2"), "for two")
        XCTAssertEqual(store.draft(for: "s3"), "")
    }

    func testBlankTextClearsTheDraft() {
        let store = SessionDraftStore(defaults: defaults)
        store.setDraft("something", for: "s1")
        store.setDraft("  \n ", for: "s1")
        XCTAssertNil(store.drafts["s1"])
        XCTAssertEqual(SessionDraftStore(defaults: defaults).draft(for: "s1"), "")
    }

    func testDraftKeepsItsWhitespaceAsTyped() {
        let store = SessionDraftStore(defaults: defaults)
        store.setDraft("line one\n", for: "s1")
        XCTAssertEqual(store.draft(for: "s1"), "line one\n")
    }

    func testRemoveAllForgetsEveryDraft() {
        let store = SessionDraftStore(defaults: defaults)
        store.setDraft("a", for: "s1")
        store.setDraft("b", for: "s2")
        store.removeAll()
        XCTAssertTrue(store.drafts.isEmpty)
        XCTAssertTrue(SessionDraftStore(defaults: defaults).drafts.isEmpty)
    }
}
