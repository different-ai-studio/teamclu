import XCTest
import UIKit

/// SwiftUI's TextField only pastes text; the composer offers a Paste button
/// for an image on the pasteboard and puts it in the attachment tray.
final class AMUXComposerPasteImageTests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func solidImage() -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64)).image { context in
            UIColor.systemRed.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        }
    }

    @MainActor
    func testPastingAnImageAddsItToTheTray() throws {
        let app = XCUIApplication()
        // A fixture session: always present, local only.
        app.launchArguments += ["-AMUXPerfFixtures", "YES"]
        app.launch()
        XCTAssertTrue(app.signInIfNeeded(), "Not signed in and no E2E account configured")

        let field = app.textFields["composer.textField"]
        XCTAssertTrue(app.tap(app.staticTexts["Perf · small (20)"], until: field), "Session did not open")

        // Image on the shared pasteboard before focusing: the composer checks
        // when the field gains focus.
        UIPasteboard.general.image = solidImage()
        field.tap()

        let paste = app.buttons["composer.pasteImageButton"]
        XCTAssertTrue(paste.waitForExistence(timeout: 5),
                      "No Paste button with an image on the pasteboard\n\(app.debugDescription)")
        // The simulator syncs the host's pasteboard in and can replace the
        // image between focus and tap; put it back right before pasting.
        UIPasteboard.general.image = solidImage()
        paste.tap()

        XCTAssertTrue(app.descendants(matching: .any)["composer.attachmentTile"].waitForExistence(timeout: 10),
                      "Pasted image never reached the tray\n\(app.debugDescription)")
    }
}
