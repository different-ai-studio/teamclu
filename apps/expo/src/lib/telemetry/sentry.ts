import Constants from "expo-constants";
import { Platform } from "react-native";

import { setChatMetricsSink, type ChatMetricReport } from "./chat-metrics";

/**
 * Sentry bootstrap for the Expo app.
 *
 * This surface ran unmonitored while every other client reported: the Ideas
 * list crashed on render, OAuth sign-in dropped users back on the welcome
 * screen, and `/v1/auth/refresh` broke startup for anyone with a team — none
 * of it visible until someone drove the app by hand.
 *
 * Grouping rule, same as `packages/app/src/lib/telemetry/capture.ts`: never
 * interpolate ids, durations, or raw reasons into a message. Sentry
 * fingerprints on message text, so an embedded UUID shatters one problem into
 * dozens of issues. Ids belong in tags/extra.
 */

/**
 * Public by design — the DSN ships inside every client bundle and only grants
 * the ability to submit events. It is read from the environment anyway so the
 * value is not duplicated across `.env`, `eas.json`, and the source tree.
 */
const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN ?? "";

/**
 * Report from a dev build too. Off by default: hot reload turns half-finished
 * code into real events (a missing import throws at module scope on every
 * save), and that noise lands in the same project as production traffic.
 *
 * Set it to verify the pipeline end-to-end without waiting on an EAS build.
 */
const DEBUG_REPORTING = process.env.EXPO_PUBLIC_SENTRY_DEBUG === "1";

let started = false;

export function initSentry(): void {
  // Without a DSN the SDK still installs global handlers and queues events it
  // can never send, so skip entirely. Contributors without the var configured
  // get an app that behaves identically, minus reporting.
  if (started || !DSN) return;
  started = true;

  const Sentry = require("@sentry/react-native") as typeof import("@sentry/react-native");

  Sentry.init({
    dsn: DSN,
    enabled: !__DEV__ || DEBUG_REPORTING,
    environment: __DEV__ ? "development" : "production",
    // Matches the desktop `teamclu-web@<version>` convention so releases line
    // up across projects.
    release: `teamclu-expo@${Constants.expoConfig?.version ?? "0.0.0"}`,
    // Sampled like the native app (0.2). Only the chat metrics below create
    // transactions — no automatic navigation or fetch tracing — so this is
    // the latency of opening a session, sending, cold start and resume.
    tracesSampleRate: 0.2,
    enableAutoPerformanceTracing: false,
    sendDefaultPii: false,
  });

  Sentry.setTag("platform.os", Platform.OS);
  setChatMetricsSink((report) => recordChatMetric(Sentry, report));

  if (DEBUG_REPORTING) {
    // Proves the pipeline without waiting for a real crash: DSN reachable,
    // transport working, events landing in the right project. Only ever fires
    // when someone opts in, so it cannot pollute production.
    //
    // Message text is fixed — per the grouping rule, a version or timestamp
    // in here would fingerprint every launch as a separate issue.
    Sentry.captureMessage("expo sentry pipeline check", "info");
  }
}

/**
 * Wraps the root component for native crash + navigation instrumentation.
 * A no-op when Sentry never started, so the tree is unchanged in dev.
 */
export function wrapRoot<T>(component: T): T {
  if (!started) return component;
  const Sentry = require("@sentry/react-native") as typeof import("@sentry/react-native");
  return Sentry.wrap(component as never) as T;
}

/**
 * One transaction per finished chat metric, one child span per phase, and
 * each phase's offset as a measurement — Sentry charts measurements, not span
 * positions (same shape as the native app's `SentryChatMetricsSink`).
 */
function recordChatMetric(
  Sentry: typeof import("@sentry/react-native"),
  report: ChatMetricReport,
): void {
  try {
    const transaction = Sentry.startInactiveSpan({
      name: report.name,
      op: report.name,
      startTime: report.start,
      forceTransaction: true,
      attributes: report.tags,
    });
    let phaseStart = report.start;
    for (const phase of report.phases) {
      Sentry.startInactiveSpan({
        name: phase.name,
        op: `${report.name}.phase`,
        parentSpan: transaction,
        startTime: phaseStart,
      }).end(phase.at);
      phaseStart = phase.at;
      Sentry.setMeasurement(`${phase.name}_ms`, phase.at - report.start, "millisecond", transaction);
    }
    for (const [key, value] of Object.entries(report.measurements)) {
      Sentry.setMeasurement(key, value, key.endsWith("_ms") ? "millisecond" : "none", transaction);
    }
    transaction.setStatus({ code: report.outcome === "ok" ? 1 : 2 });
    transaction.end(report.end);
  } catch {
    // Telemetry must never break the app.
  }
}
