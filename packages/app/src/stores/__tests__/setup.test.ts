import { describe, it, expect, beforeEach } from 'vitest'
import { useSetupStore, applyProgress, parseProgressLine } from '../setup'

describe('setup store progress reducer', () => {
  beforeEach(() => {
    useSetupStore.setState({
      requirements: [
        { id: 'amuxd', title: 'amuxd', optional: false, present: false, version: null },
        { id: 'opencode', title: 'opencode', optional: false, present: false, version: null },
        { id: 'git', title: 'git', optional: true, present: false, version: null },
      ],
      installing: null,
      output: {},
      progress: {},
      errors: {},
    })
  })

  it('records running output lines', () => {
    applyProgress({ id: 'opencode', status: 'running', line: 'downloading', error: null })
    expect(useSetupStore.getState().output['opencode']).toContain('downloading')
  })

  it('marks present on done', () => {
    applyProgress({ id: 'amuxd', status: 'done', line: null, error: null })
    const req = useSetupStore.getState().requirements.find((r) => r.id === 'amuxd')!
    expect(req.present).toBe(true)
  })

  it('records error on failed', () => {
    applyProgress({ id: 'opencode', status: 'failed', line: null, error: 'boom' })
    expect(useSetupStore.getState().errors['opencode']).toBe('boom')
  })

  it('requiredSatisfied is true only when all non-optional are present', () => {
    expect(useSetupStore.getState().requiredSatisfied()).toBe(false)
    applyProgress({ id: 'amuxd', status: 'done', line: null, error: null })
    applyProgress({ id: 'opencode', status: 'done', line: null, error: null })
    expect(useSetupStore.getState().requiredSatisfied()).toBe(true)
  })
})

// amuxd narrates every install as one JSON object per line. Those lines were
// collected and never shown, so a multi-minute download read as a hang.
describe('progress line parsing', () => {
  it('reads a sized download as a percentage', () => {
    const step = parseProgressLine(
      JSON.stringify({
        event: 'download',
        message: 'downloading https://example.test/opencode.zip',
        url: 'https://example.test/opencode.zip',
        downloaded: 500,
        total: 1000,
        percent: 50,
      }),
    )
    expect(step).toEqual({
      event: 'download',
      message: 'downloading https://example.test/opencode.zip',
      percent: 50,
    })
  })

  // Older amuxd builds emit the counts without a precomputed percentage, and a
  // desktop can be paired with either.
  it('derives the percentage from byte counts when the line omits it', () => {
    const step = parseProgressLine(
      JSON.stringify({ event: 'download', message: 'downloading x', downloaded: 1, total: 4 }),
    )
    expect(step?.percent).toBe(25)
  })

  it('has no percentage for a step with no measurable size', () => {
    const step = parseProgressLine(JSON.stringify({ event: 'unpack', message: 'unpacking asset' }))
    expect(step).toEqual({ event: 'unpack', message: 'unpacking asset', percent: null })
  })

  // npm and the sidecar's own stderr are not JSON; during a slow install a raw
  // line still beats a blank row.
  it('keeps a non-JSON line as plain text', () => {
    expect(parseProgressLine('added 42 packages in 3s')).toEqual({
      event: 'output',
      message: 'added 42 packages in 3s',
      percent: null,
    })
  })

  it('shows the last line of a multi-line blob', () => {
    expect(parseProgressLine('resolving…\nfetching…\nadded 42 packages')?.message).toBe(
      'added 42 packages',
    )
  })

  it('ignores blank lines', () => {
    expect(parseProgressLine('   ')).toBeNull()
  })
})

describe('install progress state', () => {
  // Its own reset: the reducer writes to the singleton store, and these cases
  // each build up a sequence of steps from empty.
  beforeEach(() => {
    useSetupStore.setState({
      requirements: [
        { id: 'opencode', title: 'opencode', optional: false, present: false, version: null },
      ],
      installing: 'opencode',
      output: {},
      progress: {},
      errors: {},
    })
  })

  it('tracks the current step of an install', () => {
    applyProgress({
      id: 'opencode',
      status: 'running',
      line: JSON.stringify({ event: 'download', message: 'downloading x', percent: 40 }),
      error: null,
    })
    expect(useSetupStore.getState().progress['opencode']).toEqual({
      event: 'download',
      message: 'downloading x',
      percent: 40,
    })
  })

  // A step that reports no size must not blank the bar the download just filled
  // — the install is further along than before, not back at the start.
  it('does not reset the bar when the next step has no size', () => {
    applyProgress({
      id: 'opencode',
      status: 'running',
      line: JSON.stringify({ event: 'download', message: 'downloading x', percent: 100 }),
      error: null,
    })
    applyProgress({
      id: 'opencode',
      status: 'running',
      line: JSON.stringify({ event: 'unpack', message: 'unpacking x' }),
      error: null,
    })
    const step = useSetupStore.getState().progress['opencode']
    expect(step.event).toBe('unpack')
    expect(step.percent).toBeNull()
  })

  it('carries the percentage across chunks of the same download', () => {
    applyProgress({
      id: 'opencode',
      status: 'running',
      line: JSON.stringify({ event: 'download', message: 'downloading x', percent: 60 }),
      error: null,
    })
    applyProgress({
      id: 'opencode',
      status: 'running',
      line: JSON.stringify({ event: 'download', message: 'downloading x' }),
      error: null,
    })
    expect(useSetupStore.getState().progress['opencode'].percent).toBe(60)
  })

  it('drops the step once the install finishes', () => {
    applyProgress({
      id: 'opencode',
      status: 'running',
      line: JSON.stringify({ event: 'download', message: 'downloading x', percent: 40 }),
      error: null,
    })
    applyProgress({ id: 'opencode', status: 'done', line: null, error: null })
    expect(useSetupStore.getState().progress['opencode']).toBeUndefined()
  })
})
