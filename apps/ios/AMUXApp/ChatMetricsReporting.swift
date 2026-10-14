import Foundation
import MetricKit
import os
import AMUXCore
import Sentry

/// Forwards finished `ChatMetrics` intervals to Sentry as transactions, one
/// child span per phase, so each metric gets p50/p95 by release in Sentry
/// Performance. Sampled by the SDK's `tracesSampleRate` like any transaction.
final class SentryChatMetricsSink: ChatMetricsSink, Sendable {
    func record(_ report: ChatMetricReport) {
        // A screen left mid-load or mid-turn is not a sample of either.
        guard report.outcome != .cancelled else { return }
        let name = report.metric.rawValue
        let transaction = SentrySDK.startTransaction(name: name, operation: name)
        transaction.startTimestamp = report.start

        var phaseStart = report.start
        for phase in report.phases {
            let span = transaction.startChild(operation: "\(name).phase", description: phase.name)
            span.startTimestamp = phaseStart
            span.timestamp = phase.at
            span.finish()
            phaseStart = phase.at
        }

        for (key, value) in report.measurements {
            let unit: MeasurementUnit = key.hasSuffix("_ms") ? MeasurementUnitDuration.millisecond : MeasurementUnit.none
            transaction.setMeasurement(name: key, value: NSNumber(value: value), unit: unit)
        }
        // Phase offsets as measurements too: Sentry charts measurements,
        // not span positions.
        for phase in report.phases {
            if let ms = report.msUntil(phase.name) {
                transaction.setMeasurement(name: "\(phase.name)_ms", value: NSNumber(value: ms), unit: MeasurementUnitDuration.millisecond)
            }
        }
        if let hitch = report.measurements["hitch_ms"],
           let observed = report.measurements["observed_ms"], observed > 0 {
            transaction.setMeasurement(name: "hitch_ms_per_s", value: NSNumber(value: hitch / (observed / 1000)))
        }
        for (key, value) in report.tags {
            transaction.setTag(value: value, key: key)
        }

        transaction.timestamp = report.end
        transaction.finish(status: report.outcome == .ok ? .ok : .internalError)
    }
}

/// MetricKit's daily payloads: launch time, scroll hitches, memory, hangs as
/// the OS measured them on real devices — the field numbers behind M2/M4/M7.
/// Diagnostics (crashes, hangs) already reach Sentry via `enableMetricKit`;
/// this forwards the metric payloads, which Sentry does not.
/// `@unchecked Sendable`: its only state is an immutable `Logger`.
final class MetricKitReporter: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    static let shared = MetricKitReporter()
    private let logger = Logger(subsystem: "com.teamclu.mobile", category: "MetricKit")

    func start() {
        MXMetricManager.shared.add(self)
    }

    func didReceive(_ payloads: [MXMetricPayload]) {
        for payload in payloads {
            logger.info("metric payload \(payload.timeStampBegin) – \(payload.timeStampEnd)")
            let attachment = Attachment(
                data: payload.jsonRepresentation(),
                filename: "metrickit.json",
                contentType: "application/json"
            )
            SentrySDK.capture(message: "metrickit.daily") { scope in
                scope.setLevel(.info)
                scope.addAttachment(attachment)
                for (key, value) in Self.summary(of: payload) {
                    scope.setExtra(value: value, key: key)
                }
            }
        }
    }

    /// The handful of numbers worth reading without opening the JSON.
    private static func summary(of payload: MXMetricPayload) -> [String: Double] {
        var out: [String: Double] = [:]
        if let ratio = payload.animationMetrics?.scrollHitchTimeRatio {
            // Reported in ms of hitch per s of scrolling.
            out["scroll_hitch_ms_per_s"] = ratio.value
        }
        if let memory = payload.memoryMetrics?.peakMemoryUsage {
            out["peak_memory_mb"] = memory.converted(to: .megabytes).value
        }
        if let launch = payload.applicationLaunchMetrics?.histogrammedTimeToFirstDraw {
            out["launch_first_draw_avg_ms"] = averageMilliseconds(launch)
        }
        if let hangs = payload.applicationResponsivenessMetrics?.histogrammedApplicationHangTime {
            out["hang_avg_ms"] = averageMilliseconds(hangs)
        }
        return out
    }

    private static func averageMilliseconds(_ histogram: MXHistogram<UnitDuration>) -> Double {
        var total = 0.0
        var count = 0
        let buckets = histogram.bucketEnumerator
        while let bucket = buckets.nextObject() as? MXHistogramBucket<UnitDuration> {
            let mid = (bucket.bucketStart.converted(to: .milliseconds).value
                + bucket.bucketEnd.converted(to: .milliseconds).value) / 2
            total += mid * Double(bucket.bucketCount)
            count += bucket.bucketCount
        }
        return count > 0 ? total / Double(count) : 0
    }
}

enum ProcessLaunch {
    /// When the kernel started this process — M4's true start, earlier than
    /// anything `AMUXApp.init` can observe (dyld, static initializers).
    static func startDate() -> Date {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.size
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0 else { return Date() }
        let start = info.kp_proc.p_un.__p_starttime
        return Date(timeIntervalSince1970: TimeInterval(start.tv_sec) + TimeInterval(start.tv_usec) / 1_000_000)
    }

    /// iOS may launch the process ahead of the user ("prewarming"); such a
    /// launch's clock starts long before anyone tapped the icon.
    static var isPrewarmed: Bool {
        ProcessInfo.processInfo.environment["ActivePrewarm"] == "1"
    }
}
