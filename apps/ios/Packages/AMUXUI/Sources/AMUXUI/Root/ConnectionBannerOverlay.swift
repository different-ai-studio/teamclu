import SwiftUI
import AMUXCore
import AMUXSharedUI

public struct ConnectionBannerOverlay: View {
    let mqtt: MQTTService
    var onReconnect: (() -> Void)?

    /// What the banner actually shows. Lags `mqtt.connectionState` on the way
    /// out of `.hidden` only: a drop that heals within `gracePeriod` — the
    /// foreground rebuild, an auto-reconnect redial after the broker expires
    /// the JWT — never surfaces. Once shown, it follows the state at once.
    @State private var shown: ConnectionBanner.State = .hidden

    static let gracePeriod: Duration = .seconds(2)

    public init(mqtt: MQTTService, onReconnect: (() -> Void)? = nil) {
        self.mqtt = mqtt
        self.onReconnect = onReconnect
    }

    public var body: some View {
        let target = ConnectionBanner.State.from(connectionState: mqtt.connectionState)
        VStack(spacing: 0) {
            ConnectionBanner(state: shown, onReconnect: onReconnect)
            Spacer(minLength: 0)
        }
        .allowsHitTesting(shown == .disconnected)
        .task(id: target) {
            // A new target cancels the previous wait, so a disconnected →
            // connecting hop inside the grace period stays hidden too.
            if target == .hidden || shown != .hidden {
                shown = target
                return
            }
            try? await Task.sleep(for: Self.gracePeriod)
            guard !Task.isCancelled else { return }
            shown = target
        }
    }
}
