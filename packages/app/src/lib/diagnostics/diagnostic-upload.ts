import { getBackend } from '@/lib/backend'
import type { DiagnosticReceipt } from '@/lib/backend/types'
import { isTauri } from '@/lib/utils'
import { buildDiagnosticZipBytes, type DiagnosticReport } from './diagnostic-report'

export type { DiagnosticReceipt } from '@/lib/backend/types'
const MAX_BYTES = 10 * 1024 * 1024

export async function uploadDiagnosticZip(report: DiagnosticReport): Promise<DiagnosticReceipt> {
  if (!isTauri()) throw new Error('Diagnostic ZIP upload requires the Desktop client.')
  const backend = getBackend()
  // Exactly the same native builder as saveDiagnosticZip: no second bundle or
  // redaction implementation that could drift from local export.
  const bytes = await buildDiagnosticZipBytes(report)
  if (bytes.length === 0 || bytes.length > MAX_BYTES) {
    throw new Error('Diagnostic ZIP must be between 1 byte and 10 MiB. Please export it locally.')
  }
  return backend.diagnostics.uploadZip(new Blob([new Uint8Array(bytes)], { type: 'application/zip' }))
}
