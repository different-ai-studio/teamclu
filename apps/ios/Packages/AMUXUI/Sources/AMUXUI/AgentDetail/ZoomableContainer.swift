import SwiftUI

/// Pinch to zoom (1–5×), double-tap to toggle 2.5×, drag to pan while
/// zoomed — what a full-screen image viewer is expected to do.
///
/// Inside a paging `TabView`, the pan takes priority only while zoomed, so a
/// swipe at 1× still turns the page and a drag at 3× moves the image.
struct ZoomableContainer<Content: View>: View {
    @ViewBuilder let content: () -> Content

    @State private var scale: CGFloat = 1
    @State private var settledScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var settledOffset: CGSize = .zero

    private static var maxScale: CGFloat { 5 }
    private static var doubleTapScale: CGFloat { 2.5 }

    private var isZoomed: Bool { scale > 1.01 }

    var body: some View {
        content()
            .scaleEffect(scale)
            .offset(offset)
            .contentShape(Rectangle())
            .gesture(magnify)
            .highPriorityGesture(pan, including: isZoomed ? .all : .none)
            .onTapGesture(count: 2) { toggleZoom() }
            .accessibilityAction(named: Text("Zoom")) { toggleZoom() }
    }

    private var magnify: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                scale = min(max(settledScale * value.magnification, 1), Self.maxScale)
            }
            .onEnded { _ in
                settledScale = scale
                if !isZoomed { reset() }
            }
    }

    private var pan: some Gesture {
        DragGesture()
            .onChanged { value in
                offset = CGSize(
                    width: settledOffset.width + value.translation.width,
                    height: settledOffset.height + value.translation.height
                )
            }
            .onEnded { _ in settledOffset = offset }
    }

    private func toggleZoom() {
        withAnimation(.spring(duration: 0.3)) {
            if isZoomed {
                reset()
            } else {
                scale = Self.doubleTapScale
                settledScale = Self.doubleTapScale
            }
        }
    }

    private func reset() {
        scale = 1
        settledScale = 1
        offset = .zero
        settledOffset = .zero
    }
}
