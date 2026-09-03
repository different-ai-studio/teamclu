/** Decide whether the first-run telemetry consent dialog should show.
 *
 * STR-11: split out of `hooks/useAppInit.ts`, which exported ten unrelated
 * hooks and one event-name constant from one 647-line file.
 */
import { useEffect, useState } from "react";
import { useUIStore } from "@/stores/ui";
import { useTelemetryStore } from "@/stores/telemetry";

export function useTelemetryConsent() {
  const [showConsentDialog, setShowConsentDialog] = useState(false);
  const embedMode = useUIStore((s) => s.embedMode);
  const telemetryConsent = useTelemetryStore((s) => s.consent);
  const telemetryInit = useTelemetryStore((s) => s.init);
  const telemetryInitialized = useTelemetryStore((s) => s.isInitialized);

  useEffect(() => {
    void telemetryInit();
  }, [telemetryInit]);

  // Extension embed skips the consent dialog; desktop keeps the first-run prompt.
  // No setup-guide gate any more: first-run onboarding now finishes in AuthGate
  // before this component mounts (#881), so nothing is left covering the screen.
  useEffect(() => {
    if (embedMode) return;
    if (telemetryInitialized && telemetryConsent === "undecided") {
      setShowConsentDialog(true);
    }
  }, [embedMode, telemetryInitialized, telemetryConsent]);

  return { showConsentDialog, setShowConsentDialog };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout mode keyboard shortcut + panel auto-open
// ─────────────────────────────────────────────────────────────────────────────
