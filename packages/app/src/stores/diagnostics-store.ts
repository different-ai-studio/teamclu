import { create } from 'zustand'
import type { DiagnosticReport } from '@/lib/diagnostics/diagnostic-report'

interface DiagnosticsState {
  /** Last completed report for this settings session. Survives tab switches. */
  report: DiagnosticReport | null
  setReport: (report: DiagnosticReport | null) => void
  clearReport: () => void
}

export const useDiagnosticsStore = create<DiagnosticsState>((set) => ({
  report: null,
  setReport: (report) => set({ report }),
  clearReport: () => set({ report: null }),
}))
