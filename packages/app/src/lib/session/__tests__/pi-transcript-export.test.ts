import { beforeEach, describe, expect, it, vi } from 'vitest'

const { daemonRequest } = vi.hoisted(() => ({
  daemonRequest: vi.fn(),
}))

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  daemonRequest,
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => false }))

import {
  exportTranscriptErrorMessage,
  fetchPiTranscript,
  piTranscriptPath,
  savePiTranscript,
  transcriptFilename,
} from '../pi-transcript-export'

const SESSION = 'a1ca8f06-94ee-4fb5-bdfb-194a5606062f'

const bundle = {
  teamclu_session_id: SESSION,
  exported_at: '2026-09-08T00:00:00.000Z',
  source: 'pi_jsonl',
  transcripts: [{ workspace_id: 'ws', acp_session_id: 'pi:/tmp/a.jsonl', session_file: '/tmp/a.jsonl', entry_count: 2, skipped_lines: 0, entries: [] }],
}

beforeEach(() => {
  daemonRequest.mockReset()
  daemonRequest.mockResolvedValue(bundle)
})

describe('piTranscriptPath', () => {
  it('sanitizes by default', () => {
    expect(piTranscriptPath(SESSION)).toBe(
      `/v1/pi/transcripts/${SESSION}?sanitize=true`,
    )
  })

  it('passes sanitize=false and workspaceId', () => {
    expect(piTranscriptPath(SESSION, { sanitize: false, workspaceId: 'ws-1' })).toBe(
      `/v1/pi/transcripts/${SESSION}?sanitize=false&workspaceId=ws-1`,
    )
  })
})

describe('fetchPiTranscript', () => {
  it('GETs the daemon transcript route', async () => {
    await fetchPiTranscript(SESSION)
    expect(daemonRequest).toHaveBeenCalledWith(`/v1/pi/transcripts/${SESSION}?sanitize=true`)
  })
})

describe('savePiTranscript', () => {
  it('downloads JSON in the browser when not Tauri', async () => {
    const createObjectURL = vi.fn(() => 'blob:transcript')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const dest = await savePiTranscript(SESSION)
    expect(dest).toBe(transcriptFilename(SESSION))
    expect(createObjectURL).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:transcript')
    vi.unstubAllGlobals()
  })
})

describe('exportTranscriptErrorMessage', () => {
  it('maps missing-file daemon errors', () => {
    expect(exportTranscriptErrorMessage(new Error('no local pi session file for x'))).toContain(
      '此会话没有本机完整记录',
    )
  })
})
