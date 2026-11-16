import type { DiagnosticReceipt, DiagnosticsBackend } from '@/lib/backend/types'
import type { CloudApiClient } from './http'

export function createDiagnosticsModule(client: CloudApiClient): DiagnosticsBackend {
  return {
    uploadZip: (body) => client.postRaw<DiagnosticReceipt>('/v1/diagnostics', body, {
      contentType: 'application/zip',
    }),
  }
}
