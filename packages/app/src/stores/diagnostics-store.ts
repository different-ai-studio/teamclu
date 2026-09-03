import { create } from 'zustand'
import type { DiagnosticReport } from '@/lib/diagnostics/diagnostic-report'
import type { SymptomTab } from '@/lib/diagnostics/view'

interface DiagnosticsState {
  /** Last completed report for this settings session. Survives tab switches. */
  report: DiagnosticReport | null
  setReport: (report: DiagnosticReport | null) => void
  clearReport: () => void
  /** When set, send-tab traces filter to this session and the send tab is preferred. */
  focusSessionId: string | null
  preferredTab: SymptomTab | null
  requestSessionFocus: (sessionId: string) => void
  clearFocus: () => void
}

export const useDiagnosticsStore = create<DiagnosticsState>((set) => ({
  report: null,
  setReport: (report) => set({ report }),
  clearReport: () => set({ report: null }),
  focusSessionId: null,
  preferredTab: null,
  requestSessionFocus: (sessionId) =>
    set({ focusSessionId: sessionId, preferredTab: 'send' }),
  clearFocus: () => set({ focusSessionId: null, preferredTab: null }),
}))
