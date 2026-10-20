// apps/ios/AMUXLiveActivity/AMUXLiveActivityBundle.swift
import SwiftUI
import WidgetKit

/// Live Activities only — the app ships no home-screen widgets.
@main
struct AMUXLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        AgentTurnLiveActivity()
    }
}
