import QuartzCore
import AMUXCore

/// Counts frame hitches on the session screen while an agent turn is being
/// rendered (M2). Each display-link tick that arrives later than the frame
/// the previous tick asked for adds the overshoot to `hitch_ms`; every tick
/// adds its length to `observed_ms`, so hitch_ms / observed seconds is the
/// hitch rate Apple grades (< 5 ms/s good, > 10 ms/s bad). `frames` against
/// the observed time gives the frame rate actually achieved.
///
/// Writes into the `turnRender` interval the view model opens and closes, so
/// it only counts while a turn is live and costs nothing between turns
/// beyond the display link itself.
@MainActor
final class FrameHitchMonitor {
    private var link: CADisplayLink?
    private var key = ""
    private var lastTimestamp: CFTimeInterval = 0
    private var expectedFrame: CFTimeInterval = 0

    func start(key: String) {
        stop()
        self.key = key
        let link = CADisplayLink(target: Ticker(self), selector: #selector(Ticker.tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    func stop() {
        link?.invalidate()
        link = nil
        lastTimestamp = 0
    }

    fileprivate func tick(_ link: CADisplayLink) {
        let previousExpected = expectedFrame
        defer {
            lastTimestamp = link.timestamp
            expectedFrame = link.targetTimestamp - link.timestamp
        }
        guard lastTimestamp > 0 else { return }
        let metrics = ChatMetrics.shared
        guard metrics.isOpen(.turnRender, key: key) else { return }
        let actual = link.timestamp - lastTimestamp
        metrics.add(.turnRender, key: key, "observed_ms", actual * 1000)
        // ~12 fps here once traced back to the lazy feed building every row
        // (fixed by giving each ForEach element exactly one view), not to
        // the simulator — a low count is worth investigating.
        metrics.add(.turnRender, key: key, "frames", 1)
        // ProMotion changes the refresh rate on its own; the first tick at a
        // new rate is a rate change, not a late frame.
        let expected = link.targetTimestamp - link.timestamp
        guard abs(expected - previousExpected) < 0.001 else { return }
        // Half a frame of slack: one late frame is a hitch, jitter is not.
        let hitch = actual - previousExpected
        if hitch > previousExpected * 0.5 {
            metrics.add(.turnRender, key: key, "hitch_ms", hitch * 1000)
        }
    }

    /// CADisplayLink retains its target; this keeps the monitor itself free.
    /// Main-actor like the monitor: the link is added to the main run loop.
    @MainActor
    private final class Ticker: NSObject {
        weak var monitor: FrameHitchMonitor?
        init(_ monitor: FrameHitchMonitor) { self.monitor = monitor }
        @objc func tick(_ link: CADisplayLink) {
            monitor?.tick(link)
        }
    }
}
