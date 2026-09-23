import SwiftUI
import AMUXCore
import AMUXSharedUI

/// 8px status dot, the palette's one status primitive. `live` breathes the way
/// a running session's dot does; everything else is still, because only a live
/// app is a thing currently happening.
struct TeamAppStatusDot: View {
    let kind: TeamAppStatusKind
    @State private var dimmed = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .opacity(kind == .live && dimmed ? 0.45 : 1)
            .animation(
                kind == .live
                    ? .easeInOut(duration: 1.4).repeatForever(autoreverses: true)
                    : nil,
                value: dimmed
            )
            .onAppear { if kind == .live { dimmed = true } }
    }

    private var color: Color {
        switch kind {
        case .live:    return Color.amux.sage
        case .failed:  return Color.amux.cinnabarDeep
        case .working: return Color.amux.basalt
        case .pending: return Color.amux.slate
        case .idle:    return Color.amux.slate
        }
    }
}
