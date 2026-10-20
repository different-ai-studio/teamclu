import XCTest
@testable import AMUXCore

final class SessionDetailWorkSignalTests: XCTestCase {
    private func event(_ build: (inout Amux_AcpEvent) -> Void) -> Amux_AcpEvent {
        var e = Amux_AcpEvent()
        build(&e)
        return e
    }

    @MainActor
    func test_replyEvents_indicateWork() {
        let events = [
            event { $0.thinking = Amux_AcpThinking() },
            event { $0.output = Amux_AcpOutput() },
            event { $0.toolUse = Amux_AcpToolUse() },
            event { $0.toolResult = Amux_AcpToolResult() },
            event { $0.permissionRequest = Amux_AcpPermissionRequest() },
            event { $0.planUpdate = Amux_AcpPlanUpdate() },
        ]
        for e in events {
            XCTAssertTrue(SessionDetailViewModel.acpEventIndicatesWork(e), "\(String(describing: e.event))")
        }
    }

    /// A spawn with no prompt (the message mentioned no agent) emits these;
    /// none may raise the "Agent loading…" card.
    @MainActor
    func test_spawnAndAmbientEvents_doNotIndicateWork() {
        let events = [
            event { $0.statusChange = Amux_AcpStatusChange() },
            event { $0.availableCommands = Amux_AcpAvailableCommands() },
            event { $0.error = Amux_AcpError() },
            event { $0.raw = Amux_AcpRawJson() },
            Amux_AcpEvent(),
        ]
        for e in events {
            XCTAssertFalse(SessionDetailViewModel.acpEventIndicatesWork(e), "\(String(describing: e.event))")
        }
    }
}
