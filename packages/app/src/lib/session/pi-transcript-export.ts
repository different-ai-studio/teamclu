import i18n from '@/lib/i18n'
import { daemonRequest } from '@/lib/daemon/daemon-local-client'
import { isTauri } from '@/lib/utils'

export type PiTranscript = {
  workspace_id: string
  acp_session_id: string
  session_file: string
  entry_count: number
  skipped_lines: number
  entries: unknown[]
}

export type PiTranscriptBundle = {
  teamclu_session_id: string
  exported_at: string
  source: string
  transcripts: PiTranscript[]
}

export function transcriptFilename(sessionId: string): string {
  return `pi-transcript-${sessionId}.json`
}

export function piTranscriptPath(
  sessionId: string,
  opts?: { sanitize?: boolean; workspaceId?: string },
): string {
  const q = new URLSearchParams()
  q.set('sanitize', opts?.sanitize === false ? 'false' : 'true')
  if (opts?.workspaceId) q.set('workspaceId', opts.workspaceId)
  return `/v1/pi/transcripts/${encodeURIComponent(sessionId)}?${q.toString()}`
}

export async function fetchPiTranscript(
  sessionId: string,
  opts?: { sanitize?: boolean; workspaceId?: string },
): Promise<PiTranscriptBundle> {
  return daemonRequest<PiTranscriptBundle>(piTranscriptPath(sessionId, opts))
}

export function exportTranscriptErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/no local pi session/i.test(raw) || /not found/i.test(raw)) {
    return i18n.t(
      'chat.exportTranscriptNotFound',
      'No local pi transcript for this session. It must have run on this machine.',
    )
  }
  if (/not a pi backend/i.test(raw)) {
    return i18n.t('chat.exportTranscriptNotPi', 'This session is not a pi backend session.')
  }
  if (/not connected|daemon/i.test(raw)) {
    return i18n.t(
      'chat.exportTranscriptNoDaemon',
      'amuxd is not connected. Restart TeamClu and try again.',
    )
  }
  return raw.trim() || i18n.t('chat.exportTranscriptFailed', 'Could not export the transcript')
}

export async function savePiTranscript(sessionId: string): Promise<string | null> {
  const bundle = await fetchPiTranscript(sessionId)
  const json = `${JSON.stringify(bundle, null, 2)}\n`
  const filename = transcriptFilename(sessionId)

  if (!isTauri()) {
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    try {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    } finally {
      URL.revokeObjectURL(url)
    }
    return filename
  }

  const { save } = await import('@tauri-apps/plugin-dialog')
  const { writeFile } = await import('@tauri-apps/plugin-fs')
  const { downloadDir } = await import('@tauri-apps/api/path')
  const downloads = await downloadDir()
  const dest = await save({
    title: i18n.t('chat.exportTranscript', 'Export session transcript'),
    defaultPath: `${downloads}/${filename}`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (!dest) return null
  await writeFile(dest, new TextEncoder().encode(json))
  return dest
}
